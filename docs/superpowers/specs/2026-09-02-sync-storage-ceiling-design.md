# Lifting the classic path's Sync storage ceiling

**Date:** 2026-09-02
**Status:** Specified, not scheduled
**Applies to:** the Programmable Messaging path only. Independent of `feat/bulk-messaging-api`.

## Problem

A campaign's entire state lives in one Sync Document, and two of its fields grow with the campaign:

- `messages` — the recipient list, stored so a campaign can be resumed (`send-messages.js:143`)
- `statuses` — one entry per message (`send-messages.js:284`, enriched by `check-status.js:87`)

A Sync Document holds **at most 16 KiB** of data, and writes to an object over 10 KiB are throttled to **2/s sustained** (both from [Sync limits](https://www.twilio.com/docs/sync/limits)).

An enriched `statuses` entry runs about 260 bytes: a 36-byte SID key plus `status`, `to`, `sentAt`, `errorCode`, `errorMessage`, `dateSent`, `dateUpdated`, `delivered` and `read`. A `messages` entry runs 60–190 bytes depending on body length. Sharing one document, that puts the ceiling at roughly **40–60 recipients**, with write throttling from about 25. `CHUNK_SIZE` is 100.

These figures are arithmetic from the documented limits rather than a reproduction against a live account. Confirming them is the first task of any implementation.

### Two failure points, one of them harmful

1. **Creation fails** once `messages` alone exceeds 16 KiB — somewhere around 90–270 recipients. Nothing has been sent, so the campaign is merely broken.

2. **A mid-campaign checkpoint overflows, and messages get sent twice.** `send-messages.js:316` writes to Sync *after* `client.messages.create()` has already run. When that write is rejected for size, the outer `catch` returns a 500 with no body, the browser retries from an unchanged `resumeFrom`, and every message in the chunk goes out again. The size limit turns into duplicate messages to real recipients.

The second is the reason to fix this rather than document it.

## Why one Map item per message does not work

The intuitive fix — a Sync Map keyed by message SID, one item per message — is defeated by how the rate limit is scoped:

> "The limit applies at the top level of each Document, Map, and List, e.g. updating any item in a Map still counts towards the containing Map's *write* rate."

At 20 writes/s per containing Map, a 100-message chunk spends five of its nine seconds writing status.

## Design

### Fixed-size Document, bucketed Maps

Keep the Document to data that does not grow, so it stays under 1 KiB and retains the full 20 writes/s:

| Object | Item key | Item value |
| --- | --- | --- |
| `campaign_<id>` (Document) | — | `ownerKey`, `accountSid`, `channel`, `from`, `campaignName`, counters, `startIndex`, `recipientCount`, `bucketSize`, timestamps |
| `campaign_<id>_recipients` (Map) | bucket index, `"0"`, `"1"`, … | array of up to 32 recipients |
| `campaign_<id>_statuses` (Map) | bucket index | array of up to 32 status entries |

**Bucket size 32.** At ~260 bytes per status entry a full bucket is ~8.3 KiB, under the 10 KiB throttling threshold and well under the 16 KiB item limit. Recipients are smaller, so the same bucket size is safe for both and keeps the index arithmetic identical.

**`CHUNK_SIZE` becomes 128** — a multiple of 32, so a chunk writes exactly four status buckets and no bucket is ever written by two different chunks. Four writes per chunk sits comfortably inside 20/s.

Capacity becomes 1,000,000 items × 32 ≈ 32M recipients per campaign, which stops the ceiling being a design consideration.

`send-messages.js` and `resume-execution.js` read only the recipient buckets they are about to send, rather than the whole list. `check-status.js` reads all status buckets by paging the Map, roughly one page per 3,200 messages.

### Make a failed checkpoint non-fatal

Independently of bucketing, the response must stop hiding work that succeeded. Wrap the checkpoint write in its own `try`, and on failure still return `200` with the chunk's results, the advanced `resumeFrom`, and a `checkpointFailed: true` flag. The browser advances from the response rather than re-sending, and surfaces a warning that progress was not recorded.

This is the part that actually prevents duplicate sends. Bucketing makes the overflow unlikely; this makes the consequence survivable, including for any other reason a Sync write might fail.

### Retire `webhook.protected.js`

Bucketing removes random access by `MessageSid`, which the webhook relies on at `webhook.protected.js:68`. Preserving it would need a SID-to-bucket index or a scan across every bucket.

Deleting it costs nothing real. Its own comment concedes it "only ever made statuses fresher, sooner", because `check-status.js` re-fetches every message on the 5-second poll; and the `delivered` and `read` flags it feeds are already derived from the fetched status at `check-status.js:95-96`. Removing it also deletes a public endpoint, the signature-validation logic guarding it, and the section of the README's security discussion that exists solely to explain why it is `.protected`.

### Migration

Documents created before this change carry inline `messages` and `statuses`, and a campaign may be in flight across the deploy. Both readers branch on shape: when `campaignData.statuses` is present inline, read it as-is; otherwise read the Maps. New campaigns only ever write Maps. No backfill — campaigns are short-lived, and the legacy branch can be deleted a release later.

### TTL

New Maps are created with a TTL of 30 days so status data does not accumulate in the Sync service indefinitely. The Documents have never had a TTL; that is pre-existing and out of scope here.

## Out of scope

**The polling ceiling, which is the larger problem.** `check-status.js:86` issues a sequential `client.messages(sid).fetch()` per message *per poll*. At 1,000 messages that is 1,000 serial API calls inside a 10-second Function, so status polling breaks well before storage does. Bucketing raises the storage ceiling by roughly 500× and leaves this untouched.

Fixing it properly means abandoning per-message re-fetch for `client.messages.list()` with a date-and-sender filter, which cannot cleanly attribute messages to a campaign — or converging the classic path on the model the Bulk path already uses: aggregate counts from the API, per-recipient rows fetched on demand, nothing cached. That is a redesign, not a patch, and belongs in its own spec.

So this spec makes large campaigns *store* correctly and stop double-sending. It does not make their status panel work at scale.

## Testing

- Confirm the arithmetic first: create a campaign of 200 recipients on the current code and record the exact Sync error and at what count it appears. Without this, the fix is unverified.
- Reproduce the duplicate send: force a checkpoint failure mid-campaign and confirm the same chunk is re-sent, then confirm the `checkpointFailed` path prevents it.
- Bucket boundary arithmetic as unit tests on a pure `bucketFor(index, bucketSize)` helper: index 0 → bucket 0, index 31 → bucket 0, index 32 → bucket 1, and a chunk of 128 starting at 0 touching exactly buckets 0–3.
- A full-bucket status payload measured against 10 KiB, so the throttling assumption is asserted rather than assumed.
- A campaign of 500 recipients sent end to end, with per-message statuses read back complete.
- A legacy document with inline `statuses` still renders and still resumes.
