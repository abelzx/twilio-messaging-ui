# Classic Campaign Sync Buckets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Programmable Messaging ("classic") campaigns send to 10,000 recipients and more, instead of failing at about 50, without sending any recipient the same message twice. Above 1,000 recipients the page warns, without blocking, that Bulk Messaging suits large sends better.

**Architecture:** A classic campaign's Sync Document shrinks to data that does not grow with the campaign. The recipient list and message statuses move into two Sync Maps, split into buckets keyed by the index of each bucket's first recipient. The browser uploads the list in slices that fit the 1 MB Function request cap; `send-messages.js` stores each slice, and starts sending once the whole list is stored. The browser then continues through `resume-execution.js`, which reads recipients from Sync rather than from the caller. A failed checkpoint no longer fails the call. `check-status.js` refreshes the least recently checked status buckets each poll, in parallel and within a time budget, so large campaigns cycle through over several polls.

**Tech Stack:** Twilio Functions (runtime `node24`), Twilio Sync (Documents and Maps), `twilio` npm 5.x, vanilla browser JS in `assets/app.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md`, with the deviations listed below.

**Branch:** `feat/classic-sync-buckets`, from `main`.

## Global Constraints

- No new dependencies. Tests run with `npm test` (`node --test test/*.js`). All 121 existing tests keep passing.
- Private assets are required as `require(Runtime.getAssets()['/classic-campaign.js'].path)`. Tests require `../assets/classic-campaign.private.js`. An asset never requires another asset: deployed assets are not siblings on disk.
- Twilio Functions limits that shape the design ([Function Request Flow](https://www.twilio.com/docs/runtime/functions/request-flow)): 10 s per invocation, 1 MB request, 4 MB response, 30 concurrent Functions per account.
- Twilio Sync limits ([Sync limits](https://www.twilio.com/docs/sync/limits)): 16 KiB per item, 20 writes/s per object (Map items count toward their Map), 2 writes/s for items of 10 KiB and up.
- Recipient buckets: at most 128 recipients (`RECIPIENT_BUCKET_MAX_ENTRIES`) and 9 KiB serialized (`RECIPIENT_BUCKET_MAX_BYTES = 9 * 1024`). One recipient bucket is one chunk sent.
- Status buckets: at most 32 entries (`STATUS_BUCKET_ENTRIES`), keyed at the chunk's start, start + 32, start + 64, start + 96.
- Keys are zero-padded to 7 digits (`0000128`). Map names are `<campaignId>_recipients` and `<campaignId>_statuses`. No TTL on either Map.
- At most 4 KiB of shared fields on the Document (`SHARED_MAX_BYTES`).
- Upload slices are at most 700 KB of JSON (`UPLOAD_MAX_BYTES` in `app.js`).
- A new Document carries `storage: 'buckets'` and `storedCount`. A Document without `storage` is legacy: it renders and refreshes, but cannot be resumed. A bucketed Document with `storedCount < totalMessages` has sent nothing and cannot be resumed.
- No hard recipient limit anywhere. `CLASSIC_SUGGESTED_MAX = 1000` drives a non-blocking notice only.
- The runtime Sync client is built with `{ autoRetry: true, maxRetries: 3 }` in every Function that writes to Sync.
- Functions use 2-space indent; `assets/app.js` uses 4-space. Match the comment density of the surrounding code.

## Deviations From the Spec

| Spec says | Plan does | Why |
| --- | --- | --- |
| Recipient buckets of exactly 32, aligned with status buckets | Recipient buckets of up to 128 and 9 KiB; status buckets of 32 within each | 32 recipients with ~500-character bodies exceed 16 KiB; and at 32 per bucket, 10,000 typed-body recipients cost 313 writes before anything is sent, against 79 |
| — | Fields every message shares are stored once, on the Document | Keeps typed-body recipients at ~25 bytes each, whatever the body length |
| — | The browser uploads the list in slices; sending starts once it is all stored | A Function request is capped at 1 MB, about 4,000 recipients with ~250-byte bodies |
| Polling ceiling out of scope | Each poll refreshes the 24 least recently checked buckets with an unsettled status, 20 fetches at a time, starting none after 6.5 s | Polling broke at ~60–100 messages, before storage would |
| — | When every status would push the response past 4 MB (~13,000 messages), `check-status` returns counts only | Function responses are capped at 4 MB |
| Maps get a 30-day TTL | No TTL | The Documents never expire. An expired Map under a live Document would empty the delivery panel, the same failure `bulk-snapshot.js` was written to fix |
| Legacy documents still resume | Legacy documents render, but resume returns 409 | A legacy campaign that hit the size limit mid-send has `startIndex` behind what was really sent. Resuming it re-sends those messages |
| — | `check-status` writes the Document conditionally (`ifMatch`) | A concurrent poll could otherwise write an older `startIndex` back over a fresh checkpoint |
| — | Notice above 1,000 recipients, never blocking | Requested by the user |

## Reference Comparison

`evanTheTerribleWarrior/Twilio-Outbound-Messaging` keeps all campaign state in the browser (Redux, persisted to `localStorage`) and nothing in Sync. It sends 50-row slices, five Function calls at a time, and checks statuses on demand the same way. Borrowed here: slicing in the browser so no request nears the 1 MB cap. Not borrowed: browser-only state, which would lose campaign history and resuming from another session; and its re-send, which skips only `delivered` rows and so messages `sent` and `queued` rows twice. Parallel Function calls would not speed this design up, because Sync's per-Map write rate, not the Function count, is the bottleneck.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `assets/classic-campaign.private.js` | create | Sync layout: packing, bucket I/O, the chunk loop, the response body |
| `assets/classic-messages.private.js` | create | Messages API: building params, sending a chunk, refreshing statuses, counting them |
| `test/classic-campaign.test.js` | create | Tests for the above, against a fake Sync |
| `test/classic-messages.test.js` | create | Tests for the above, against a fake client |
| `functions/send-messages.js` | rewrite | Store one upload slice; create the Document with the first; send once all is stored |
| `functions/resume-execution.js` | rewrite | Continue a fully stored campaign from Sync |
| `functions/check-status.js` | modify | Read buckets, refresh a rotating window, write what changed, cap the response |
| `functions/list-campaigns.js` | modify | Report `resumable` |
| `functions/webhook.protected.js` | delete | Cannot locate a SID in buckets, and was never needed |
| `assets/campaign-details.private.js` | modify | `resolveDetails` reads `shared` |
| `test/campaign-details.test.js` | modify | One test for `shared` |
| `assets/app.js` | modify | Notice, sliced upload, resume loop, checkpoint warning, omitted-statuses note, webhook column removal |
| `assets/index.html`, `assets/styles.css` | modify | The notice element and its style |
| `README.md` | modify | Limits, storage, webhook removal |
| `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md` | modify | Status line and implementation notes |

---

### Task 1: Recipient packing

**Files:**
- Create: `assets/classic-campaign.private.js`
- Test: `test/classic-campaign.test.js`

**Interfaces:**
- Produces (exported from `assets/classic-campaign.private.js`):
  - Constants `STORAGE = 'buckets'`, `RECIPIENT_BUCKET_MAX_ENTRIES = 128`, `RECIPIENT_BUCKET_MAX_BYTES = 9216`, `STATUS_BUCKET_ENTRIES = 32`, `SHARED_MAX_BYTES = 4096`, `WRITE_CONCURRENCY = 8`
  - `bucketKey(start: number): string`
  - `recipientsMapName(campaignId)`, `statusesMapName(campaignId)`: `string`
  - `isBucketed(campaignData): boolean`, `isFullyStored(campaignData): boolean`
  - `sharedFields(messages: object[]): object`
  - `packRecipients(messages, { shared = sharedFields(messages), startIndex = 0 } = {}): { shared, buckets: { start: number, recipients: object[] }[] }`
  - `unpackRecipient(entry, shared): object`
  - `statusEntries(results: Result[], sentAt: string): { [key: string]: object }`, where `Result` is `{ index, success: true, sid, status, to }` or `{ index, success: false, error, errorCode, to }`
  - `newCampaignData({ ownerKey, accountSid, totalMessages, shared, channel, from, campaignName, details, now }): object`, with `storedCount: 0`

- [ ] **Step 1: Write the failing tests**

Create `test/classic-campaign.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const storage = require('../assets/classic-campaign.private.js');

const FROM = '+15017122661';
const HX = `HX${'a'.repeat(32)}`;
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** `count` messages to distinct numbers, each extended by `extra(i)`. */
function messages(count, extra = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    to: `+1555${String(i).padStart(7, '0')}`,
    from: FROM,
    ...extra(i),
  }));
}

test('bucketKey zero-pads so that key order is send order', () => {
  assert.strictEqual(storage.bucketKey(0), '0000000');
  assert.strictEqual(storage.bucketKey(128), '0000128');
  assert.deepStrictEqual([9984, 128, 0, 1024].map(storage.bucketKey).sort(), [
    '0000000', '0000128', '0001024', '0009984',
  ]);
});

test('fields every message shares are stored once, leaving each recipient as `to`', () => {
  const { shared, buckets } = storage.packRecipients(messages(3, () => ({ body: 'Sale today' })));
  assert.deepStrictEqual(shared, { from: FROM, body: 'Sale today' });
  assert.deepStrictEqual(buckets[0].recipients, [
    { to: '+15550000000' }, { to: '+15550000001' }, { to: '+15550000002' },
  ]);
});

test('a field that varies stays on each recipient', () => {
  const { shared, buckets } = storage.packRecipients(messages(2, (i) => ({ body: `Hi ${i}` })));
  assert.deepStrictEqual(shared, { from: FROM });
  assert.deepStrictEqual(buckets[0].recipients, [
    { to: '+15550000000', body: 'Hi 0' },
    { to: '+15550000001', body: 'Hi 1' },
  ]);
});

test('a field only some messages carry is not shared', () => {
  const list = messages(2);
  list[0].body = 'Only the first';
  const { shared, buckets } = storage.packRecipients(list);
  assert.deepStrictEqual(shared, { from: FROM });
  assert.deepStrictEqual(buckets[0].recipients[1], { to: '+15550000001' });
});

test('a shared field over the budget stays on each recipient', () => {
  const body = 'x'.repeat(storage.SHARED_MAX_BYTES + 1);
  const { shared, buckets } = storage.packRecipients(messages(2, () => ({ body })));
  assert.deepStrictEqual(shared, { from: FROM });
  assert.strictEqual(buckets[0].recipients[0].body, body);
});

test('a later slice is packed against the first slice\'s shared fields', () => {
  const first = storage.packRecipients(messages(2, () => ({ body: 'Sale' })));
  const later = messages(3, (i) => (i === 0 ? { body: 'Sale' } : i === 1 ? { body: 'Different' } : {}));
  const { buckets } = storage.packRecipients(later, { shared: first.shared, startIndex: 500 });
  assert.strictEqual(buckets[0].start, 500);
  // A shared field the message lacks is stored as null, which every send path treats as absent.
  assert.deepStrictEqual(buckets[0].recipients, [
    { to: '+15550000000' },
    { to: '+15550000001', body: 'Different' },
    { to: '+15550000002', body: null },
  ]);
});

test('recipient buckets hold at most 128 and are keyed by their first index', () => {
  const { buckets } = storage.packRecipients(messages(300));
  assert.deepStrictEqual(buckets.map((b) => [b.start, b.recipients.length]), [[0, 128], [128, 128], [256, 44]]);
});

test('long per-recipient bodies fill buckets by size before count', () => {
  const { buckets } = storage.packRecipients(messages(40, (i) => ({ body: `${i} ${'x'.repeat(1000)}` })));
  assert.ok(buckets.length > 2);
  for (const bucket of buckets) {
    assert.ok(size({ recipients: bucket.recipients }) <= storage.RECIPIENT_BUCKET_MAX_BYTES);
  }
  // Contiguous: each bucket starts where the previous one ended.
  const end = buckets.reduce((next, bucket) => {
    assert.strictEqual(bucket.start, next);
    return next + bucket.recipients.length;
  }, 0);
  assert.strictEqual(end, 40);
});

test('10,000 recipients sharing a long body pack into 79 buckets', () => {
  const { buckets } = storage.packRecipients(messages(10000, () => ({ body: 'x'.repeat(1600) })));
  assert.strictEqual(buckets.length, 79);
});

test('unpacking every bucket gives back the original messages', () => {
  const original = messages(300, (i) => ({
    body: i % 2 ? `Odd ${i}` : 'Even',
    contentSid: HX,
    contentVariables: { 1: `Name ${i}` },
  }));
  const { shared, buckets } = storage.packRecipients(original);
  const roundTrip = buckets.flatMap((bucket) =>
    bucket.recipients.map((entry) => storage.unpackRecipient(entry, shared)));
  assert.deepStrictEqual(roundTrip, original);
});

test('a full status bucket stays under the 10 KiB write-throttling threshold', () => {
  // An entry as check-status.js leaves it once enriched from Twilio.
  const statuses = {};
  for (let i = 0; i < storage.STATUS_BUCKET_ENTRIES; i++) {
    statuses[`SM${String(i).padStart(32, '0')}`] = {
      status: 'delivered', to: '+15558675310', sentAt: '2026-11-04T00:00:00.000Z',
      errorCode: null, errorMessage: null,
      dateSent: '2026-11-04T00:00:01.000Z', dateUpdated: '2026-11-04T00:00:05.000Z',
      delivered: true, read: false,
    };
  }
  const bytes = size({ statuses, checkedAt: '2026-11-04T00:00:05.000Z' });
  assert.ok(bytes < 10 * 1024, `bucket is ${bytes} bytes`);
});

test('statusEntries keys accepted sends by SID and refusals by index', () => {
  const sid = `SM${'1'.repeat(32)}`;
  const at = '2026-11-04T00:00:00.000Z';
  assert.deepStrictEqual(storage.statusEntries([
    { index: 0, success: true, sid, status: 'queued', to: '+1' },
    { index: 1, success: false, error: 'Invalid To', errorCode: 21211, to: '+2' },
    { index: 2, success: false, to: '+3' },
  ], at), {
    [sid]: { status: 'queued', to: '+1', sentAt: at },
    'failed-1': { status: 'failed', to: '+2', errorCode: 21211, errorMessage: 'Invalid To', sentAt: at },
    'failed-2': { status: 'failed', to: '+3', errorCode: null, errorMessage: 'Twilio rejected the message', sentAt: at },
  });
});

test('isBucketed and isFullyStored tell the Document shapes apart', () => {
  const fresh = storage.newCampaignData({ totalMessages: 2, shared: {}, now: '2026-11-04T00:00:00.000Z' });
  assert.strictEqual(storage.isBucketed(fresh), true);
  assert.strictEqual(fresh.storedCount, 0);
  assert.strictEqual(fresh.pending, 2);
  assert.strictEqual(storage.isFullyStored(fresh), false);
  assert.strictEqual(storage.isFullyStored({ ...fresh, storedCount: 2 }), true);
  assert.strictEqual(storage.isBucketed({ statuses: {}, messages: [] }), false);
  assert.strictEqual(storage.isFullyStored({ statuses: {}, messages: [] }), false);
  assert.strictEqual(storage.isBucketed(null), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/classic-campaign.test.js`
Expected: FAIL with `Cannot find module '../assets/classic-campaign.private.js'`

- [ ] **Step 3: Write the implementation**

Create `assets/classic-campaign.private.js`:

```js
/**
 * Sync storage for a classic (Programmable Messaging) campaign, and the chunk
 * loop that sends from it.
 *
 * A classic campaign used to live in one Sync Document holding its whole
 * recipient list and every message status. A Document holds at most 16 KiB, so
 * campaigns of about 50 recipients and up failed: creation failed outright, or
 * a checkpoint failed after its chunk had already been sent, and the retry sent
 * that chunk again. See docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md.
 *
 * The Document now holds only what does not grow with the campaign. The two
 * lists live in Sync Maps, split into buckets:
 *
 *   campaign_<id>             Document  owner, counters, storedCount, startIndex, shared fields
 *   campaign_<id>_recipients  Map       key -> { recipients: [...] }      up to 128 recipients
 *   campaign_<id>_statuses    Map       key -> { statuses, checkedAt }    up to 32 statuses
 *
 * A key is the index of the first recipient its item covers, zero-padded so
 * that Sync's ascending key order is send order. A chunk is one recipient
 * bucket, so startIndex is always a recipient bucket key. The chunk's statuses
 * go in status buckets keyed at its start, start + 32, start + 64 and
 * start + 96, so no status bucket is written by two chunks.
 *
 * The recipient list arrives in slices, one per send-messages call, because a
 * Function request is capped at 1 MB. storedCount says how much has arrived.
 * Nothing is sent until all of it has, so a campaign whose upload was cut off
 * has sent nothing.
 *
 * Maps are created without a TTL, as Documents always have been: an expired Map
 * under a surviving Document would empty the delivery panel of a campaign that
 * still shows in the list.
 *
 * This is a *private* asset. Require it as:
 *
 *   const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
 */

'use strict';

/** Marks a Document laid out as above. One without it is the old, inline shape. */
const STORAGE = 'buckets';

/** Recipients per recipient bucket, and so per chunk sent. */
const RECIPIENT_BUCKET_MAX_ENTRIES = 128;

/**
 * Bytes per recipient bucket. The same margin bulk-snapshot.js keeps under the
 * 16 KiB item limit, since the stored size can differ slightly from the size
 * sent. Long per-recipient bodies fill a bucket by size before count.
 */
const RECIPIENT_BUCKET_MAX_BYTES = 9 * 1024;

/**
 * Entries per status bucket. An enriched status entry runs about 260 bytes, so
 * 32 of them is about 8.4 KiB, under the 10 KiB at which Sync throttles writes
 * to 2/s.
 */
const STATUS_BUCKET_ENTRIES = 32;

/** Budget for the fields stored once on the Document instead of per recipient. */
const SHARED_MAX_BYTES = 4 * 1024;

/** Sync writes in flight at once. Retries on 429 come from the client's autoRetry. */
const WRITE_CONCURRENCY = 8;

const KEY_DIGITS = 7;

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const EMPTY_BUCKET_BYTES = byteSize({ recipients: [] });

function bucketKey(start) {
  return String(start).padStart(KEY_DIGITS, '0');
}

function recipientsMapName(campaignId) {
  return `${campaignId}_recipients`;
}

function statusesMapName(campaignId) {
  return `${campaignId}_statuses`;
}

function isBucketed(campaignData) {
  return Boolean(campaignData) && campaignData.storage === STORAGE;
}

/** True once the whole recipient list is in Sync, so the campaign can be sent and resumed. */
function isFullyStored(campaignData) {
  return isBucketed(campaignData) && (campaignData.storedCount || 0) >= campaignData.totalMessages;
}

/**
 * Fields every message carries with the same value. They are stored once, on
 * the Document. A typed body or one template for the whole campaign is the
 * common case, and leaves each stored recipient as little more than `to`.
 */
function sharedFields(messages) {
  const shared = {};
  const first = messages[0] || {};
  for (const field of Object.keys(first)) {
    if (field === 'to') continue;
    const json = JSON.stringify(first[field]);
    if (json === undefined) continue;
    if (!messages.every((message) => JSON.stringify(message[field]) === json)) continue;
    if (byteSize({ ...shared, [field]: first[field] }) > SHARED_MAX_BYTES) continue;
    shared[field] = first[field];
  }
  return shared;
}

/**
 * One recipient as stored: `to`, plus every field that differs from `shared`.
 * A shared field this message lacks is stored as null, which every send path
 * treats as absent. That only happens in a later slice, packed against the
 * fields the first slice shared.
 */
function packRecipient(message, shared) {
  const entry = { to: message.to };
  for (const [field, value] of Object.entries(message)) {
    if (field === 'to') continue;
    if (field in shared && JSON.stringify(value) === JSON.stringify(shared[field])) continue;
    entry[field] = value;
  }
  for (const field of Object.keys(shared)) {
    if (!(field in message)) entry[field] = null;
  }
  return entry;
}

function unpackRecipient(entry, shared) {
  return { ...shared, ...entry };
}

/**
 * Splits messages into recipient buckets of at most
 * RECIPIENT_BUCKET_MAX_ENTRIES recipients and RECIPIENT_BUCKET_MAX_BYTES bytes,
 * keyed from `startIndex`. A recipient bigger than that gets a bucket to
 * itself; Twilio's own body limits keep it under 16 KiB.
 */
function packRecipients(messages, { shared = sharedFields(messages), startIndex = 0 } = {}) {
  const buckets = [];
  let current = null;
  // Serialized size of { recipients: [...] } so far: the wrapper, each entry,
  // and a comma between entries. Kept as a running total rather than
  // re-serializing the bucket on every add.
  let bytes = 0;

  messages.forEach((message, offset) => {
    const entry = packRecipient(message, shared);
    const entryBytes = byteSize(entry);
    if (current && current.recipients.length < RECIPIENT_BUCKET_MAX_ENTRIES &&
        bytes + 1 + entryBytes <= RECIPIENT_BUCKET_MAX_BYTES) {
      current.recipients.push(entry);
      bytes += 1 + entryBytes;
      return;
    }
    current = { start: startIndex + offset, recipients: [entry] };
    buckets.push(current);
    bytes = EMPTY_BUCKET_BYTES + entryBytes;
  });

  return { shared, buckets };
}

/**
 * One chunk's results as status entries. An accepted send is keyed by its SID.
 * A refused one has no SID, so it is keyed by its position, which is stable:
 * re-sending a chunk overwrites the entry rather than duplicating it. Without an
 * entry a refusal would be invisible, both in check-status.js's counters and in
 * the delivery table.
 */
function statusEntries(results, sentAt) {
  const entries = {};
  for (const result of results) {
    if (result.success) {
      entries[result.sid] = { status: result.status, to: result.to, sentAt };
    } else {
      entries[`failed-${result.index}`] = {
        status: 'failed',
        to: result.to,
        errorCode: result.errorCode || null,
        errorMessage: result.error || 'Twilio rejected the message',
        sentAt,
      };
    }
  }
  return entries;
}

/**
 * A new campaign's Document data. `accountSid` is for display only, never an
 * authorization key: ownership is `ownerKey` alone.
 */
function newCampaignData({ ownerKey, accountSid, totalMessages, shared, channel, from, campaignName, details, now }) {
  return {
    storage: STORAGE,
    ownerKey,
    accountSid,
    totalMessages,
    storedCount: 0,
    sent: 0,
    failed: 0,
    pending: totalMessages,
    startIndex: 0,
    shared,
    channel,
    from,
    campaignName: campaignName || null,
    details,
    createdAt: now,
    lastUpdated: now,
  };
}

module.exports = {
  STORAGE,
  RECIPIENT_BUCKET_MAX_ENTRIES,
  RECIPIENT_BUCKET_MAX_BYTES,
  STATUS_BUCKET_ENTRIES,
  SHARED_MAX_BYTES,
  WRITE_CONCURRENCY,
  bucketKey,
  recipientsMapName,
  statusesMapName,
  isBucketed,
  isFullyStored,
  sharedFields,
  packRecipients,
  unpackRecipient,
  statusEntries,
  newCampaignData,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/classic-campaign.test.js`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add assets/classic-campaign.private.js test/classic-campaign.test.js
git commit -m "feat: pack classic campaign recipients into Sync-sized buckets"
```

---

### Task 2: Bucket storage in Sync

**Files:**
- Modify: `assets/classic-campaign.private.js`
- Test: `test/classic-campaign.test.js`

**Interfaces:**
- Consumes: `bucketKey`, `recipientsMapName`, `statusesMapName`, `packRecipients`, `WRITE_CONCURRENCY` from Task 1.
- Produces (exported):
  - `inBatches(tasks: (() => Promise)[], limit = WRITE_CONCURRENCY): Promise<any[]>`
  - `createMaps(syncClient, campaignId): Promise<void>`
  - `storeRecipients(syncClient, campaignId, messages, { startIndex, shared, deadline, now = Date.now }): Promise<number>` — resolves to the new stored count. Always writes at least one batch.
  - `readRecipientBucket(syncClient, campaignId, start): Promise<{ start, recipients } | null>`
  - `writeStatusBucket(syncClient, campaignId, start, statuses): Promise<void>`
  - `readStatusBuckets(syncClient, campaignId): Promise<{ key, statuses, checkedAt }[]>`
  - `updateStatusBucket(syncClient, campaignId, key, statuses, checkedAt): Promise<void>`
- `syncClient` is `runtimeClient.sync.v1.services(sid)`. The surface used: `syncMaps.create({ uniqueName })`, `syncMaps(name).syncMapItems.create({ key, data })`, `.syncMapItems.list({ pageSize })`, `.syncMapItems(key).fetch()`, `.syncMapItems(key).update({ data })`.

- [ ] **Step 1: Write the failing tests**

Append to `test/classic-campaign.test.js`:

```js
function syncError(status, code) {
  return Object.assign(new Error(`Sync ${status}`), { status, code });
}

/**
 * Just enough of twilio-node's Sync surface: `syncMaps` and `syncMapItems` are
 * callable and carry methods, as in the SDK. Map items list in key order.
 */
function fakeSync() {
  const state = { maps: {}, documents: {}, calls: [], failDocumentUpdate: false };

  const itemsOf = (name) => {
    if (!state.maps[name]) throw syncError(404, 20404);
    return state.maps[name];
  };

  const syncMaps = (name) => {
    const syncMapItems = (key) => ({
      fetch: async () => {
        const items = itemsOf(name);
        if (!(key in items)) throw syncError(404, 20404);
        return { key, data: items[key] };
      },
      update: async ({ data }) => {
        state.calls.push(['updateItem', name, key]);
        const items = itemsOf(name);
        if (!(key in items)) throw syncError(404, 20404);
        items[key] = data;
      },
    });
    syncMapItems.create = async ({ key, data }) => {
      state.calls.push(['createItem', name, key]);
      const items = itemsOf(name);
      if (key in items) throw syncError(409, 54208);
      items[key] = data;
    };
    syncMapItems.list = async () => {
      state.calls.push(['listItems', name]);
      const items = itemsOf(name);
      return Object.keys(items).sort().map((key) => ({ key, data: items[key] }));
    };
    return { syncMapItems };
  };
  syncMaps.create = async ({ uniqueName }) => {
    state.calls.push(['createMap', uniqueName]);
    if (state.maps[uniqueName]) throw syncError(409, 54301);
    state.maps[uniqueName] = {};
  };

  const documents = (name) => ({
    update: async ({ data }) => {
      state.calls.push(['updateDocument', name]);
      if (state.failDocumentUpdate) throw syncError(400, 54006);
      state.documents[name] = JSON.parse(JSON.stringify(data));
    },
  });

  return { client: { syncMaps, documents }, state };
}

test('createMaps creates the recipients and statuses Maps', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  assert.deepStrictEqual(Object.keys(state.maps).sort(), ['campaign_1_recipients', 'campaign_1_statuses']);
});

test('storeRecipients writes a slice under keys counted from its start', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  const stored = await storage.storeRecipients(client, 'campaign_1', messages(300), {
    startIndex: 1024, shared: { from: FROM }, deadline: Infinity,
  });
  assert.strictEqual(stored, 1324);
  assert.deepStrictEqual(Object.keys(state.maps.campaign_1_recipients), ['0001024', '0001152', '0001280']);
  assert.deepStrictEqual(state.maps.campaign_1_recipients['0001280'].recipients[0], { to: '+15550000256' });
});

test('storeRecipients stops at the deadline, after at least one batch', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  const stored = await storage.storeRecipients(client, 'campaign_1', messages(2000), {
    startIndex: 0, shared: { from: FROM }, deadline: 0, now: () => 1,
  });
  assert.strictEqual(stored, storage.WRITE_CONCURRENCY * 128);
  assert.strictEqual(Object.keys(state.maps.campaign_1_recipients).length, storage.WRITE_CONCURRENCY);
});

test('storeRecipients overwrites buckets a retried slice already wrote', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  const slice = messages(200);
  const options = { startIndex: 0, shared: { from: FROM }, deadline: Infinity };
  await storage.storeRecipients(client, 'campaign_1', slice, options);
  assert.strictEqual(await storage.storeRecipients(client, 'campaign_1', slice, options), 200);
  assert.strictEqual(Object.keys(state.maps.campaign_1_recipients).length, 2);
});

test('readRecipientBucket returns the bucket starting at a key, or null', async () => {
  const { client } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  await storage.storeRecipients(client, 'campaign_1', messages(200), {
    startIndex: 0, shared: { from: FROM }, deadline: Infinity,
  });
  const bucket = await storage.readRecipientBucket(client, 'campaign_1', 128);
  assert.strictEqual(bucket.start, 128);
  assert.strictEqual(bucket.recipients.length, 72);
  assert.strictEqual(await storage.readRecipientBucket(client, 'campaign_1', 100), null);
});

test('writeStatusBucket merges into a bucket a re-sent chunk already wrote', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  await storage.writeStatusBucket(client, 'campaign_1', 32, { a: { status: 'queued' } });
  await storage.writeStatusBucket(client, 'campaign_1', 32, { b: { status: 'queued' } });
  assert.deepStrictEqual(state.maps.campaign_1_statuses['0000032'], {
    statuses: { a: { status: 'queued' }, b: { status: 'queued' } },
  });
});

test('readStatusBuckets returns every bucket in send order, or [] with no Map', async () => {
  const { client } = fakeSync();
  assert.deepStrictEqual(await storage.readStatusBuckets(client, 'campaign_1'), []);
  await storage.createMaps(client, 'campaign_1');
  await storage.writeStatusBucket(client, 'campaign_1', 32, { b: { status: 'sent' } });
  await storage.writeStatusBucket(client, 'campaign_1', 0, { a: { status: 'sent' } });
  assert.deepStrictEqual(await storage.readStatusBuckets(client, 'campaign_1'), [
    { key: '0000000', statuses: { a: { status: 'sent' } }, checkedAt: null },
    { key: '0000032', statuses: { b: { status: 'sent' } }, checkedAt: null },
  ]);
});

test('updateStatusBucket replaces one bucket and records when it was checked', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  await storage.writeStatusBucket(client, 'campaign_1', 0, { a: { status: 'sent' } });
  await storage.updateStatusBucket(client, 'campaign_1', '0000000', { a: { status: 'delivered' } }, 'T1');
  assert.deepStrictEqual(state.maps.campaign_1_statuses['0000000'], {
    statuses: { a: { status: 'delivered' } }, checkedAt: 'T1',
  });
});

test('inBatches never runs more than the limit at once and keeps order', async () => {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, (_, i) => async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    return i;
  });
  assert.deepStrictEqual(await storage.inBatches(tasks, 8), Array.from({ length: 20 }, (_, i) => i));
  assert.strictEqual(peak, 8);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/classic-campaign.test.js`
Expected: FAIL with `storage.createMaps is not a function` (and the same for the other new functions)

- [ ] **Step 3: Write the implementation**

In `assets/classic-campaign.private.js`, add below `const KEY_DIGITS = 7;`:

```js
const NOT_FOUND = 20404;
const ITEM_EXISTS = 54208;
```

Add below `byteSize`:

```js
function isNotFound(error) {
  return Boolean(error) && (error.status === 404 || error.code === NOT_FOUND);
}
```

Add above `module.exports`:

```js
/** Runs `tasks` (functions returning promises) at most `limit` at a time. */
async function inBatches(tasks, limit = WRITE_CONCURRENCY) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    results.push(...(await Promise.all(tasks.slice(i, i + limit).map((task) => task()))));
  }
  return results;
}

/** Creates an item, or overwrites it when the key is already taken. */
async function putItem(items, key, data) {
  try {
    await items.create({ key, data });
  } catch (error) {
    if (error.code !== ITEM_EXISTS) throw error;
    await items(key).update({ data });
  }
}

async function createMaps(syncClient, campaignId) {
  await syncClient.syncMaps.create({ uniqueName: recipientsMapName(campaignId) });
  await syncClient.syncMaps.create({ uniqueName: statusesMapName(campaignId) });
}

/**
 * Stores one upload slice, starting at `startIndex`, packed against the
 * campaign's `shared` fields. Buckets are written in order, WRITE_CONCURRENCY
 * at a time. Once `deadline` passes no further batch starts, but the first
 * always does, so every call makes progress. Resolves to how many recipients
 * are now stored; the caller sends the next slice from there.
 */
async function storeRecipients(syncClient, campaignId, messages, { startIndex, shared, deadline, now = Date.now }) {
  const { buckets } = packRecipients(messages, { shared, startIndex });
  const items = syncClient.syncMaps(recipientsMapName(campaignId)).syncMapItems;
  let stored = startIndex;

  for (let i = 0; i < buckets.length; i += WRITE_CONCURRENCY) {
    if (i > 0 && now() >= deadline) break;
    const batch = buckets.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(batch.map((bucket) =>
      putItem(items, bucketKey(bucket.start), { recipients: bucket.recipients })));
    const last = batch[batch.length - 1];
    stored = last.start + last.recipients.length;
  }

  return stored;
}

/** The recipient bucket keyed `start`, or null when no bucket starts there. */
async function readRecipientBucket(syncClient, campaignId, start) {
  try {
    const item = await syncClient.syncMaps(recipientsMapName(campaignId)).syncMapItems(bucketKey(start)).fetch();
    return { start, recipients: (item.data && item.data.recipients) || [] };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Records one status bucket's send results. The key normally does not exist
 * yet. It does when a chunk is sent a second time, and then the new entries are
 * merged in, so the first send's SIDs stay on record beside the second's.
 */
async function writeStatusBucket(syncClient, campaignId, start, statuses) {
  const items = syncClient.syncMaps(statusesMapName(campaignId)).syncMapItems;
  const key = bucketKey(start);
  try {
    await items.create({ key, data: { statuses } });
  } catch (error) {
    if (error.code !== ITEM_EXISTS) throw error;
    const existing = await items(key).fetch();
    const before = (existing.data && existing.data.statuses) || {};
    await items(key).update({ data: { statuses: { ...before, ...statuses } } });
  }
}

/**
 * Every status bucket in send order, or [] when the Map is missing. A bucket
 * not yet refreshed by check-status.js has a null `checkedAt`.
 */
async function readStatusBuckets(syncClient, campaignId) {
  let items;
  try {
    items = await syncClient.syncMaps(statusesMapName(campaignId)).syncMapItems.list({ pageSize: 100 });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return items.map((item) => ({
    key: item.key,
    statuses: (item.data && item.data.statuses) || {},
    checkedAt: (item.data && item.data.checkedAt) || null,
  }));
}

async function updateStatusBucket(syncClient, campaignId, key, statuses, checkedAt) {
  await syncClient.syncMaps(statusesMapName(campaignId)).syncMapItems(key).update({
    data: { statuses, checkedAt },
  });
}
```

Add to `module.exports`: `inBatches, createMaps, storeRecipients, readRecipientBucket, writeStatusBucket, readStatusBuckets, updateStatusBucket,`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/classic-campaign.test.js`
Expected: PASS, 22 tests

- [ ] **Step 5: Commit**

```bash
git add assets/classic-campaign.private.js test/classic-campaign.test.js
git commit -m "feat: store classic recipients and statuses in bucketed Sync Maps"
```

---

### Task 3: The chunk loop, with a non-fatal checkpoint

**Files:**
- Modify: `assets/classic-campaign.private.js`
- Test: `test/classic-campaign.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces (exported):
  - `runChunks({ syncClient, campaignId, campaignData, startIndex, deadline, send, now = Date.now }): Promise<{ resumeFrom: number, results: Result[], checkpointFailed: boolean }>`
    - `send(messages: object[], startIndex: number): Promise<Result[]>` — one result per message, in order, never rejects. Task 4's `sendChunk` fits this shape.
    - `campaignData` is updated in place: `sent`, `failed`, `pending`, `startIndex`, `lastUpdated`.
    - The caller only calls it once `isFullyStored(campaignData)`. Throws only before a chunk is sent: when no recipient bucket starts at the index to send from.
  - `progressBody(campaignId, campaignData, startIndex, outcome): object` — the 200 body of both send Functions: `{ success, campaignId, storedCount, processed, totalProcessed, totalMessages, isComplete, hasMore, resumeFrom, results, checkpointFailed, stats: { sent, failed, pending } }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/classic-campaign.test.js`:

```js
/** A fully stored campaign of `count` recipients, as send-messages.js leaves it. */
async function storedCampaign(count, extra) {
  const sync = fakeSync();
  const list = messages(count, extra);
  const shared = storage.sharedFields(list);
  await storage.createMaps(sync.client, 'campaign_1');
  await storage.storeRecipients(sync.client, 'campaign_1', list, { startIndex: 0, shared, deadline: Infinity });
  const campaignData = storage.newCampaignData({
    ownerKey: 'owner', accountSid: 'AC1', totalMessages: count, shared,
    channel: 'sms', from: FROM, campaignName: null, details: null, now: '2026-11-04T00:00:00.000Z',
  });
  campaignData.storedCount = count;
  return { ...sync, campaignData, list };
}

/** A `send` that accepts every message except those `refuse(index)` picks. */
function fakeSend(refuse = () => false) {
  const chunks = [];
  const send = async (batch, startIndex) => {
    chunks.push({ startIndex, batch });
    return batch.map((message, offset) => {
      const index = startIndex + offset;
      return refuse(index)
        ? { index, success: false, error: 'Invalid To', errorCode: 21211, to: message.to }
        : { index, success: true, sid: `SM${String(index).padStart(32, '0')}`, status: 'queued', to: message.to };
    });
  };
  return { send, chunks };
}

test('runChunks sends one recipient bucket per chunk and checkpoints each', async () => {
  const { client, state, campaignData, list } = await storedCampaign(200);
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });

  assert.deepStrictEqual(chunks.map((c) => [c.startIndex, c.batch.length]), [[0, 128], [128, 72]]);
  assert.deepStrictEqual(chunks.flatMap((c) => c.batch), list);
  assert.strictEqual(outcome.resumeFrom, 200);
  assert.strictEqual(outcome.checkpointFailed, false);
  assert.strictEqual(outcome.results.length, 72);
  assert.deepStrictEqual(Object.keys(state.maps.campaign_1_statuses).sort(), [
    '0000000', '0000032', '0000064', '0000096', '0000128', '0000160', '0000192',
  ]);
  assert.strictEqual(Object.keys(state.maps.campaign_1_statuses['0000192'].statuses).length, 8);
  assert.strictEqual(state.calls.filter(([op]) => op === 'updateDocument').length, 2);
  assert.strictEqual(state.documents.campaign_1.startIndex, 200);
  assert.strictEqual(state.documents.campaign_1.sent, 200);
  assert.strictEqual(state.documents.campaign_1.pending, 0);
});

test('runChunks stops at the deadline with resumeFrom on a bucket key', async () => {
  const { client, campaignData } = await storedCampaign(200);
  const { send, chunks } = fakeSend();
  let clock = 0;
  const slowSend = async (batch, startIndex) => {
    clock += 5000;
    return send(batch, startIndex);
  };
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0,
    deadline: 4000, send: slowSend, now: () => clock,
  });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(outcome.resumeFrom, 128);
});

test('runChunks resumes from a bucket key and refuses an index inside a bucket', async () => {
  const { client, campaignData } = await storedCampaign(200);
  const { send, chunks } = fakeSend();
  const run = (startIndex) => storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex, deadline: Infinity, send,
  });
  await run(128);
  assert.deepStrictEqual(chunks.map((c) => [c.startIndex, c.batch.length]), [[128, 72]]);
  await assert.rejects(run(100), /No stored recipients start at index 100/);
  assert.strictEqual(chunks.length, 1);
});

test('refused sends are recorded under their index and counted as failed', async () => {
  const { client, state, campaignData } = await storedCampaign(3);
  const { send } = fakeSend((index) => index === 1);
  await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });
  const statuses = state.maps.campaign_1_statuses['0000000'].statuses;
  assert.strictEqual(Object.keys(statuses).length, 3);
  assert.strictEqual(statuses['failed-1'].errorCode, 21211);
  assert.strictEqual(state.documents.campaign_1.sent, 2);
  assert.strictEqual(state.documents.campaign_1.failed, 1);
  assert.strictEqual(state.documents.campaign_1.pending, 0);
});

test('a failed checkpoint stops the loop but still moves resumeFrom past the sent chunk', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, state, campaignData } = await storedCampaign(200);
  state.failDocumentUpdate = true;
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(outcome.checkpointFailed, true);
  assert.strictEqual(outcome.resumeFrom, 128);
});

test('a resume past the stored index with nothing left to send still saves the index', async () => {
  const { client, state, campaignData } = await storedCampaign(3);
  // As a failed checkpoint on the last chunk leaves it: all sent, index not saved.
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 3, deadline: Infinity, send,
  });
  assert.strictEqual(chunks.length, 0);
  assert.strictEqual(outcome.resumeFrom, 3);
  assert.strictEqual(outcome.checkpointFailed, false);
  assert.strictEqual(state.documents.campaign_1.startIndex, 3);
});

test('progressBody reports progress the way the browser reads it', () => {
  const outcome = { resumeFrom: 128, results: [], checkpointFailed: true };
  assert.deepStrictEqual(
    storage.progressBody('campaign_1', { totalMessages: 200, storedCount: 200, sent: 128, failed: 0, pending: 72 }, 0, outcome),
    {
      success: true,
      campaignId: 'campaign_1',
      storedCount: 200,
      processed: 128,
      totalProcessed: 128,
      totalMessages: 200,
      isComplete: false,
      hasMore: true,
      resumeFrom: 128,
      results: [],
      checkpointFailed: true,
      stats: { sent: 128, failed: 0, pending: 72 },
    }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/classic-campaign.test.js`
Expected: FAIL with `storage.runChunks is not a function` and `storage.progressBody is not a function`

- [ ] **Step 3: Write the implementation**

Add above `module.exports` in `assets/classic-campaign.private.js`:

```js
/** One chunk's results split into the status buckets they belong in. */
function statusGroups(chunkStart, results) {
  const groups = [];
  for (let i = 0; i < results.length; i += STATUS_BUCKET_ENTRIES) {
    groups.push({ start: chunkStart + i, results: results.slice(i, i + STATUS_BUCKET_ENTRIES) });
  }
  return groups;
}

/**
 * Sends from `startIndex` until the campaign is done or `deadline` passes, one
 * recipient bucket per chunk, recording each chunk's statuses and checkpoint as
 * it goes.
 *
 * `send(messages, startIndex)` sends one chunk and resolves to one result per
 * message (classic-messages.js sendChunk). It is passed in because assets
 * cannot require each other once deployed. `campaignData` is the Document's
 * data and is updated in place.
 *
 * A failed checkpoint does not fail the call. By then the chunk has been sent,
 * and failing would send the browser back to retry it, which is how recipients
 * used to get the same message twice. The loop stops and reports
 * `checkpointFailed`, and `resumeFrom` still moves past the chunk. The cost is
 * that chunk's statuses, and its share of the counters if the Document write
 * was the one that failed.
 */
async function runChunks({ syncClient, campaignId, campaignData, startIndex, deadline, send, now = Date.now }) {
  const storedIndex = campaignData.startIndex || 0;
  const shared = campaignData.shared || {};
  let currentIndex = startIndex;
  let results = [];
  let chunks = 0;
  let checkpointFailed = false;

  while (currentIndex < campaignData.totalMessages && now() < deadline) {
    const bucket = await readRecipientBucket(syncClient, campaignId, currentIndex);
    if (!bucket || !bucket.recipients.length) {
      throw new Error(`No stored recipients start at index ${currentIndex}`);
    }

    const chunkStart = currentIndex;
    results = await send(bucket.recipients.map((entry) => unpackRecipient(entry, shared)), chunkStart);
    chunks++;
    currentIndex += bucket.recipients.length;

    const accepted = results.filter((result) => result.success).length;
    campaignData.sent = (campaignData.sent || 0) + accepted;
    campaignData.failed = (campaignData.failed || 0) + (results.length - accepted);
    campaignData.pending = Math.max(0, campaignData.totalMessages - campaignData.sent - campaignData.failed);
    campaignData.startIndex = currentIndex;
    campaignData.lastUpdated = new Date(now()).toISOString();

    try {
      await Promise.all(statusGroups(chunkStart, results).map((group) =>
        writeStatusBucket(syncClient, campaignId, group.start, statusEntries(group.results, campaignData.lastUpdated))));
      await syncClient.documents(campaignId).update({ data: campaignData });
    } catch (error) {
      console.error(`Checkpoint failed for ${campaignId} at index ${currentIndex}:`, error);
      checkpointFailed = true;
      break;
    }
  }

  // A resume that starts past the stored index, after a failed checkpoint, and
  // finds nothing left to send must still save the index, or the campaign would
  // show as in progress forever.
  if (!chunks && currentIndex !== storedIndex) {
    campaignData.startIndex = currentIndex;
    campaignData.lastUpdated = new Date(now()).toISOString();
    try {
      await syncClient.documents(campaignId).update({ data: campaignData });
    } catch (error) {
      console.error(`Checkpoint failed for ${campaignId} at index ${currentIndex}:`, error);
      checkpointFailed = true;
    }
  }

  return { resumeFrom: currentIndex, results, checkpointFailed };
}

/** The 200 body of send-messages.js and resume-execution.js. */
function progressBody(campaignId, campaignData, startIndex, outcome) {
  const isComplete = outcome.resumeFrom >= campaignData.totalMessages;
  return {
    success: true,
    campaignId,
    storedCount: campaignData.storedCount,
    processed: outcome.resumeFrom - startIndex,
    totalProcessed: outcome.resumeFrom,
    totalMessages: campaignData.totalMessages,
    isComplete,
    hasMore: !isComplete,
    resumeFrom: outcome.resumeFrom,
    results: outcome.results,
    checkpointFailed: outcome.checkpointFailed,
    stats: {
      sent: campaignData.sent,
      failed: campaignData.failed,
      pending: campaignData.pending,
    },
  };
}
```

Add to `module.exports`: `runChunks, progressBody,`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/classic-campaign.test.js`
Expected: PASS, 29 tests

- [ ] **Step 5: Commit**

```bash
git add assets/classic-campaign.private.js test/classic-campaign.test.js
git commit -m "feat: send classic chunks from Sync buckets, surviving a failed checkpoint"
```

---

### Task 4: Messages API helpers

**Files:**
- Create: `assets/classic-messages.private.js`
- Test: `test/classic-messages.test.js`

**Interfaces:**
- Produces (exported from `assets/classic-messages.private.js`):
  - `messageParams(message, { channel, from, messagingServiceSid }): object` — what `client.messages.create` receives. Never includes `statusCallback`.
  - `retryWithExponentialBackoff(fn, { maxRetries = 5, baseDelay = 1000, maxDelay = 30000 } = {})`
  - `sendChunk(client, messages, { startIndex = 0, channel, from, messagingServiceSid, retry, concurrency = 64 } = {}): Promise<Result[]>` — results in message order, never rejects.
  - `pendingKeys(statuses, channel): string[]` — keys whose status can still change.
  - `refreshStatuses(client, statuses, { channel, deadline, now = Date.now, concurrency = 20 }): Promise<{ statuses: object, changed: Set<string> }>`
  - `tally(statuses): { delivered: number, read: number, failed: number }`
- `client` is the OAuth client from `oauth.authenticate()`. The surface used: `client.messages.create(params)` and `client.messages(sid).fetch()`.

- [ ] **Step 1: Write the failing tests**

Create `test/classic-messages.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const classicMessages = require('../assets/classic-messages.private.js');

const MG = `MG${'b'.repeat(32)}`;
const HX = `HX${'a'.repeat(32)}`;
const sid = (n) => `SM${String(n).padStart(32, '0')}`;

/** Just enough of twilio-node: `messages` is callable and carries `create`. */
function fakeClient({ create = async () => ({}), fetch = async () => ({}) } = {}) {
  const messages = (messageSid) => ({ fetch: () => fetch(messageSid) });
  messages.create = (params) => create(params);
  return { messages };
}

/** Resolves on a later turn, so concurrent calls overlap. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('messageParams sends a plain SMS with no status callback', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+15558675310', body: 'Hi' }, { channel: 'sms', from: '+15017122661' }),
    { to: '+15558675310', from: '+15017122661', body: 'Hi' }
  );
});

test('a null field from a later upload slice is treated as absent', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+1', from: null, body: null, contentSid: null }, { channel: 'sms', from: '+2' }),
    { to: '+1', from: '+2' }
  );
});

test('a Messaging Service sender travels as messagingServiceSid, unprefixed', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+15558675310', body: 'Hi' }, { channel: 'whatsapp', from: MG }),
    { to: 'whatsapp:+15558675310', messagingServiceSid: MG, body: 'Hi' }
  );
});

test('WhatsApp prefixes each side once and stringifies template variables', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams(
      { to: 'whatsapp:+15558675310', from: '+15017122661', contentSid: HX, contentVariables: { 1: 'Sarah' } },
      { channel: 'whatsapp' }
    ),
    { to: 'whatsapp:+15558675310', from: 'whatsapp:+15017122661', contentSid: HX, contentVariables: '{"1":"Sarah"}' }
  );
});

test('Messenger falls back to the deployment Messaging Service', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '123', body: 'Hi' }, { channel: 'messenger', from: '456', messagingServiceSid: MG }),
    { to: 'messenger:123', from: 'messenger:456', body: 'Hi', messagingServiceSid: MG }
  );
});

test('MMS media goes out as an array', () => {
  const params = classicMessages.messageParams(
    { to: '+1', from: '+2', mediaUrl: 'https://example.com/a.jpg' }, { channel: 'mms' });
  assert.deepStrictEqual(params.mediaUrl, ['https://example.com/a.jpg']);
});

test('sendChunk numbers results from startIndex and never rejects', async () => {
  let n = 0;
  const client = fakeClient({
    create: async (params) => {
      if (params.to === '+2') throw Object.assign(new Error('Invalid To'), { status: 400, code: 21211 });
      return { sid: sid(n++), status: 'queued' };
    },
  });
  const results = await classicMessages.sendChunk(client, [{ to: '+1' }, { to: '+2' }], {
    startIndex: 64, channel: 'sms', from: '+9',
  });
  assert.deepStrictEqual(results, [
    { index: 64, success: true, sid: sid(0), status: 'queued', to: '+1' },
    { index: 65, success: false, error: 'Invalid To', errorCode: 21211, to: '+2' },
  ]);
});

test('sendChunk keeps at most `concurrency` sends in flight, results in order', async () => {
  let running = 0;
  let peak = 0;
  const client = fakeClient({
    create: async (params) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return { sid: `SM${params.to}`, status: 'queued' };
    },
  });
  const batch = Array.from({ length: 10 }, (_, i) => ({ to: String(i) }));
  const results = await classicMessages.sendChunk(client, batch, { channel: 'sms', from: '+9', concurrency: 3 });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(results.map((r) => r.sid), batch.map((m) => `SM${m.to}`));
});

test('sendChunk retries a 429', async (t) => {
  t.mock.method(console, 'log', () => {});
  let calls = 0;
  const client = fakeClient({
    create: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      return { sid: sid(1), status: 'queued' };
    },
  });
  const [result] = await classicMessages.sendChunk(client, [{ to: '+1' }], {
    channel: 'sms', from: '+9', retry: { baseDelay: 1, maxDelay: 1 },
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(calls, 3);
});

test('pendingKeys skips refusals and settled statuses', () => {
  const statuses = {
    [sid(1)]: { status: 'queued' },
    [sid(2)]: { status: 'delivered' },
    [sid(3)]: { status: 'undelivered' },
    'failed-4': { status: 'failed' },
  };
  assert.deepStrictEqual(classicMessages.pendingKeys(statuses, 'sms'), [sid(1)]);
  assert.deepStrictEqual(classicMessages.pendingKeys(statuses, 'whatsapp'), [sid(1), sid(2)]);
});

test('refreshStatuses fetches only messages whose status can still change', async () => {
  const fetched = [];
  const client = fakeClient({
    fetch: async (messageSid) => {
      fetched.push(messageSid);
      return { status: 'delivered', errorCode: null, errorMessage: null, dateSent: null, dateUpdated: null };
    },
  });
  const statuses = {
    [sid(1)]: { status: 'queued', to: '+1', sentAt: 'a' },
    [sid(2)]: { status: 'delivered', to: '+2', sentAt: 'a' },
    'failed-4': { status: 'failed', to: '+4', sentAt: 'a' },
  };
  const { statuses: next, changed } = await classicMessages.refreshStatuses(client, statuses, {
    channel: 'sms', deadline: Infinity,
  });
  assert.deepStrictEqual(fetched, [sid(1)]);
  assert.deepStrictEqual([...changed], [sid(1)]);
  assert.strictEqual(next[sid(1)].status, 'delivered');
  assert.strictEqual(next[sid(1)].delivered, true);
  assert.strictEqual(next['failed-4'], statuses['failed-4']);
});

test('delivered can still become read on WhatsApp', async () => {
  const client = fakeClient({ fetch: async () => ({ status: 'read' }) });
  const { statuses: next } = await classicMessages.refreshStatuses(client, {
    [sid(1)]: { status: 'delivered', sentAt: 'a' },
  }, { channel: 'whatsapp', deadline: Infinity });
  assert.strictEqual(next[sid(1)].read, true);
});

test('an unchanged status is not reported as changed', async () => {
  const entry = {
    status: 'sent', to: '+1', sentAt: 'a', errorCode: null, errorMessage: null,
    dateSent: '2026-11-04T00:00:00.000Z', dateUpdated: '2026-11-04T00:00:01.000Z', delivered: false, read: false,
  };
  const client = fakeClient({
    fetch: async () => ({
      status: 'sent', errorCode: null, errorMessage: null,
      dateSent: new Date(entry.dateSent), dateUpdated: new Date(entry.dateUpdated),
    }),
  });
  const { changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: entry }, {
    channel: 'sms', deadline: Infinity,
  });
  assert.strictEqual(changed.size, 0);
});

test('refreshStatuses starts no fetch after the deadline', async () => {
  const client = fakeClient({ fetch: async () => assert.fail('fetched after the deadline') });
  const { changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: { status: 'queued' } }, {
    channel: 'sms', deadline: 0, now: () => 1,
  });
  assert.strictEqual(changed.size, 0);
});

test('refreshStatuses fetches at most `concurrency` at once, oldest first', async () => {
  let running = 0;
  let peak = 0;
  const order = [];
  const client = fakeClient({
    fetch: async (messageSid) => {
      order.push(messageSid);
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return { status: 'delivered' };
    },
  });
  const statuses = {};
  for (let i = 9; i >= 0; i--) statuses[sid(i)] = { status: 'queued', sentAt: `2026-11-04T00:00:0${i}.000Z` };
  await classicMessages.refreshStatuses(client, statuses, { channel: 'sms', deadline: Infinity, concurrency: 3 });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(order, Array.from({ length: 10 }, (_, i) => sid(i)));
});

test('a failed fetch keeps the entry and records why', async () => {
  const client = fakeClient({ fetch: async () => { throw new Error('boom'); } });
  const { statuses, changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: { status: 'queued' } }, {
    channel: 'sms', deadline: Infinity,
  });
  assert.deepStrictEqual(statuses[sid(1)], { status: 'queued', error: 'boom' });
  assert.ok(changed.has(sid(1)));
});

test('tally counts delivered, read and terminal failures', () => {
  assert.deepStrictEqual(classicMessages.tally({
    a: { status: 'delivered' },
    b: { status: 'read' },
    c: { status: 'undelivered' },
    d: { status: 'failed' },
    e: { status: 'sent', delivered: true },
  }), { delivered: 3, read: 1, failed: 2 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/classic-messages.test.js`
Expected: FAIL with `Cannot find module '../assets/classic-messages.private.js'`

- [ ] **Step 3: Write the implementation**

Create `assets/classic-messages.private.js`. `retryWithExponentialBackoff` and the body of `messageParams` move from `functions/send-messages.js`, minus `statusCallback`:

```js
/**
 * Programmable Messaging calls for a classic campaign: sending a chunk, and
 * refreshing the statuses of messages already sent.
 *
 * Messages are sent with no statusCallback. check-status.js re-fetches every
 * message whose status can still change, and the webhook that used to take
 * callbacks could not find a message once statuses moved into Sync buckets.
 *
 * This is a *private* asset. Require it as:
 *
 *   const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);
 */

'use strict';

/**
 * A real Twilio message SID, as opposed to the "failed-<n>" key of a send
 * Twilio refused. Mirrors MESSAGE_SID in app.js.
 */
const MESSAGE_SID = /^[A-Z]{2}[0-9a-f]{32}$/i;
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

/** Statuses that never change again. */
const FINAL = new Set(['failed', 'undelivered', 'canceled', 'read']);

/** Channels that report `read`, so `delivered` is not final on them. */
const READ_RECEIPT_CHANNELS = new Set(['whatsapp', 'rcs', 'messenger']);

/**
 * Terminal failure. `undelivered` matters: Meta rejecting a WhatsApp template
 * (error 63049) lands there, and reporting that as a success is worse than
 * reporting nothing.
 */
const TERMINAL_FAILURE = new Set(['failed', 'undelivered']);

/** Sends in flight at once, within one chunk. */
const SEND_CONCURRENCY = 64;

/** Status fetches in flight at once. */
const FETCH_CONCURRENCY = 20;

/** Retries `fn` with exponential backoff and jitter, on 429 rate limits only. */
async function retryWithExponentialBackoff(fn, options = {}) {
  const { maxRetries = 5, baseDelay = 1000, maxDelay = 30000 } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isRateLimit = error.status === 429 ||
        error.code === 20429 ||
        (error.message && error.message.toLowerCase().includes('rate limit'));

      if (!isRateLimit || attempt === maxRetries) {
        throw error;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      // Up to 30% jitter, so parallel sends do not retry in lockstep.
      const totalDelay = delay + Math.random() * 0.3 * delay;

      console.log(`Rate limit (429) encountered. Retrying in ${Math.round(totalDelay)}ms (attempt ${attempt + 1}/${maxRetries})`);

      await new Promise((resolve) => setTimeout(resolve, totalDelay));
    }
  }

  throw lastError;
}

/**
 * What client.messages.create() receives for one message. `from` is the
 * campaign's sender, used when the message carries none of its own;
 * `messagingServiceSid` is the deployment's MESSAGING_SERVICE_SID, Messenger's
 * fallback. A null field (see packRecipient in classic-campaign.private.js) is
 * treated as absent.
 */
function messageParams(message, { channel, from, messagingServiceSid } = {}) {
  const params = {
    to: message.to,
    from: message.from || from,
  };

  // Not required when a content template is used.
  if (message.body) {
    params.body = message.body;
  }

  if (message.contentSid) {
    params.contentSid = message.contentSid;

    // Template variable values, e.g. {"1": "Sarah", "2": "10am"}. They must
    // travel with contentSid, or the template goes out with its placeholders.
    if (message.contentVariables) {
      params.contentVariables = typeof message.contentVariables === 'string'
        ? message.contentVariables
        : JSON.stringify(message.contentVariables);
    }
  }

  // Resolve the sender BEFORE any channel prefixing. A Messaging Service is
  // chosen by SID and must travel as messagingServiceSid — never as From, and
  // never with a channel prefix glued to it, which once produced
  // from: "whatsapp:MG7f6b…".
  const usingService = MESSAGING_SERVICE_SID.test(String(params.from || ''));
  if (usingService) {
    params.messagingServiceSid = String(params.from);
    delete params.from;
  }

  // The recipient always takes the channel prefix. From only takes it when a
  // concrete sender was chosen — a service SID must stay bare.
  if (channel === 'whatsapp') {
    const wa = (v) => (String(v).startsWith('whatsapp:') ? String(v) : `whatsapp:${v}`);
    params.to = wa(params.to);
    if (params.from) params.from = wa(params.from);
  } else if (channel === 'messenger') {
    const ms = (v) => (String(v).startsWith('messenger:') ? String(v) : `messenger:${v}`);
    params.to = ms(params.to);
    if (params.from) params.from = ms(params.from);
    if (!usingService) {
      const service = message.messagingServiceSid || messagingServiceSid;
      if (service) params.messagingServiceSid = service;
    }
  } else if (channel === 'mms' || channel === 'rcs') {
    if (message.mediaUrl) {
      params.mediaUrl = Array.isArray(message.mediaUrl) ? message.mediaUrl : [message.mediaUrl];
    }
  }

  return params;
}

/**
 * Sends one chunk, `concurrency` at a time. Resolves to one result per message,
 * in message order, and never rejects: a send Twilio refuses is a result,
 * recorded as a failure.
 */
async function sendChunk(client, messages, {
  startIndex = 0, channel, from, messagingServiceSid, retry, concurrency = SEND_CONCURRENCY,
} = {}) {
  const results = new Array(messages.length);
  let next = 0;

  const sendOne = async (message, index) => {
    try {
      const sent = await retryWithExponentialBackoff(
        () => client.messages.create(messageParams(message, { channel, from, messagingServiceSid })),
        retry
      );
      return { index, success: true, sid: sent.sid, status: sent.status, to: message.to };
    } catch (error) {
      return {
        index,
        success: false,
        error: error.message,
        errorCode: error.code || error.status,
        to: message.to,
      };
    }
  };

  const worker = async () => {
    while (next < messages.length) {
      const offset = next++;
      results[offset] = await sendOne(messages[offset], startIndex + offset);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, worker));
  return results;
}

function isFinal(entry, channel) {
  const status = String((entry && entry.status) || '').toLowerCase();
  if (FINAL.has(status)) return true;
  return status === 'delivered' && !READ_RECEIPT_CHANNELS.has(String(channel || '').toLowerCase());
}

/** Keys of messages whose status can still change: real SIDs, not yet final. */
function pendingKeys(statuses, channel) {
  return Object.keys(statuses).filter((key) => MESSAGE_SID.test(key) && !isFinal(statuses[key], channel));
}

/**
 * Re-fetches from Twilio every message whose status can still change, oldest
 * first, `concurrency` at a time. No fetch starts once `deadline` has passed;
 * the rest wait for a later poll.
 *
 * Resolves to a new statuses map and the keys whose entry changed, so the
 * caller writes back only what moved.
 */
async function refreshStatuses(client, statuses, {
  channel, deadline, now = Date.now, concurrency = FETCH_CONCURRENCY,
} = {}) {
  const next = { ...statuses };
  const changed = new Set();
  const queue = pendingKeys(statuses, channel)
    .sort((a, b) => String(statuses[a].sentAt || '').localeCompare(String(statuses[b].sentAt || '')));

  const worker = async () => {
    while (queue.length && now() < deadline) {
      const messageSid = queue.shift();
      const before = statuses[messageSid];
      let after;
      try {
        const message = await client.messages(messageSid).fetch();
        after = {
          ...before,
          status: message.status,
          errorCode: message.errorCode,
          errorMessage: message.errorMessage,
          dateSent: message.dateSent,
          dateUpdated: message.dateUpdated,
          // Kept once set: older campaigns had these flags from the webhook.
          delivered: Boolean(before.delivered) || message.status === 'delivered' || message.status === 'read',
          read: Boolean(before.read) || message.status === 'read',
        };
        delete after.error;
      } catch (error) {
        after = { ...before, error: error.message };
      }
      // Compared as JSON, which is also how Sync stores the Dates the SDK returns.
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        next[messageSid] = after;
        changed.add(messageSid);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { statuses: next, changed };
}

/**
 * The derived counters. This is the only place that counts per-message
 * status, so a badge and a counter cannot disagree.
 */
function tally(statuses) {
  let delivered = 0;
  let read = 0;
  let failed = 0;
  for (const entry of Object.values(statuses)) {
    const status = String(entry.status || '').toLowerCase();
    if (entry.delivered || status === 'delivered' || status === 'read') delivered++;
    if (entry.read || status === 'read') read++;
    if (TERMINAL_FAILURE.has(status)) failed++;
  }
  return { delivered, read, failed };
}

module.exports = {
  messageParams,
  retryWithExponentialBackoff,
  sendChunk,
  pendingKeys,
  refreshStatuses,
  tally,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/classic-messages.test.js`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add assets/classic-messages.private.js test/classic-messages.test.js
git commit -m "feat: share classic send and status-refresh logic in one asset"
```

---

### Task 5: Rewire the send Functions and retire the webhook

**Files:**
- Rewrite: `functions/send-messages.js`
- Rewrite: `functions/resume-execution.js`
- Delete: `functions/webhook.protected.js`

**Interfaces:**
- Consumes: `storage.sharedFields`, `storage.createMaps`, `storage.storeRecipients`, `storage.newCampaignData`, `storage.isBucketed`, `storage.isFullyStored`, `storage.runChunks`, `storage.progressBody` (Tasks 1–3); `classicMessages.sendChunk` (Task 4).
- Produces, for Task 7:
  - `POST /send-messages` with `{ messages, offset, totalMessages, campaignId, channel, from, campaignName, details }` stores one slice. Returns 200 `progressBody`: `storedCount` says where the next slice starts; once it reaches `totalMessages`, the same call starts sending. `offset` defaults to 0 and `totalMessages` to `messages.length`, so a single-slice campaign needs neither. 400 when `messages` is empty or the numbers do not fit; 404 when the campaign belongs to another app (or a later slice names none); 409 when `offset` is 0 and the caller already created the campaign, or a later slice does not start at `storedCount` (the 409 body carries `storedCount`).
  - `POST /resume-execution` with `{ campaignId, resumeFrom? }` → 200 `progressBody`; 400 without `campaignId`; 404 not found or not owned; 409 for bulk, legacy, or not fully stored campaigns. The browser no longer sends `messages`, `channel` or `from`.
  - Both 500s keep `{ error, message }`.

- [ ] **Step 1: Replace `functions/send-messages.js` with:**

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * POST /send-messages — stores a classic campaign's recipient list, one slice
 * per call, and starts sending once all of it is stored.
 *
 * A Function request is capped at 1 MB, so the browser sends the list in
 * slices, each starting at the storedCount the previous call returned. The
 * first slice creates the campaign. Sending then carries on through
 * resume-execution. See classic-campaign.private.js for the storage layout.
 */

/**
 * No recipient write starts after this. A slice that completes the list then
 * has the rest of the 9-second budget to start sending.
 */
const STORE_DEADLINE_MS = 6000;

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000; // 9 seconds to leave buffer

  try {
    const {
      messages,
      campaignId,
      channel = 'sms',
      from,
      campaignName
    } = event;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      response.setStatusCode(400);
      response.setBody({ error: 'messages array is required' });
      return callback(null, response);
    }

    const offset = event.offset === undefined ? 0 : Number(event.offset);
    const totalMessages = event.totalMessages === undefined ? messages.length : Number(event.totalMessages);
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(totalMessages) || offset + messages.length > totalMessages) {
      response.setStatusCode(400);
      response.setBody({ error: 'offset and totalMessages must place this slice inside the campaign' });
      return callback(null, response);
    }

    let creds;
    let client;
    try {
      creds = oauth.credsFrom(event);
      client = await oauth.authenticate(creds);
    } catch (error) {
      response.setStatusCode(error.statusCode || 401);
      response.setBody({ error: error.message });
      return callback(null, response);
    }

    const ownerKey = oauth.ownerKeyFor(creds);

    // The runtime client is used for Sync only, never for the user's account.
    // autoRetry absorbs 429s from Sync's per-Map write rate.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN, { autoRetry: true, maxRetries: 3 });
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    const campaignDocName = campaignId || `campaign_${Date.now()}`;
    let existing = null;
    try {
      existing = await syncClient.documents(campaignDocName).fetch();
    } catch (error) {
      // 20404 is "document not found"; anything else is a real failure.
      if (error.status !== 404 && error.code !== 20404) {
        throw error;
      }
    }

    // 404 rather than 403 for another app's campaign, so a guessed ID is not
    // confirmed to exist. Same `!data` guard as list-campaigns.js and
    // check-status.js.
    const owned = Boolean(existing && existing.data) && existing.data.ownerKey === ownerKey;
    if (existing && !owned) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    const storeDeadline = startTime + STORE_DEADLINE_MS;
    let campaignData;

    if (offset === 0) {
      if (existing) {
        response.setStatusCode(409);
        response.setBody({ error: 'This campaign already exists. Resume it from the campaigns list.' });
        return callback(null, response);
      }

      // The first slice decides which fields are stored once, on the Document;
      // later slices are packed against the same set. The Document is created
      // after the first slice is stored, so a failure here leaves nothing that
      // points at a half-written list.
      const shared = storage.sharedFields(messages);
      await storage.createMaps(syncClient, campaignDocName);
      const storedCount = await storage.storeRecipients(syncClient, campaignDocName, messages, {
        startIndex: 0, shared, deadline: storeDeadline,
      });

      campaignData = storage.newCampaignData({
        ownerKey,
        accountSid: client.accountSid,
        totalMessages,
        shared,
        channel,
        from,
        campaignName,
        // What the campaign was sent with, for the card and the delivery panel.
        // Body and variables are not repeated here: `shared` holds them when
        // every recipient had the same ones.
        details: campaignDetails.buildDetails(event.details, {
          mode: 'classic',
          contentSid: messages[0] && messages[0].contentSid,
          recipientCount: totalMessages,
        }),
        now: new Date().toISOString(),
      });
      campaignData.storedCount = storedCount;
      await syncClient.documents.create({ uniqueName: campaignDocName, data: campaignData });
    } else {
      if (!existing) {
        response.setStatusCode(404);
        response.setBody({ error: 'Campaign not found' });
        return callback(null, response);
      }
      campaignData = existing.data;
      if (!storage.isBucketed(campaignData) || campaignData.storedCount !== offset) {
        response.setStatusCode(409);
        response.setBody({
          error: 'This slice does not continue the campaign\'s recipient list.',
          storedCount: campaignData.storedCount
        });
        return callback(null, response);
      }

      campaignData.storedCount = await storage.storeRecipients(syncClient, campaignDocName, messages, {
        startIndex: offset, shared: campaignData.shared || {}, deadline: storeDeadline,
      });
      campaignData.lastUpdated = new Date().toISOString();
      await syncClient.documents(campaignDocName).update({ data: campaignData });
    }

    // Nothing is sent until the whole list is stored, so a campaign whose
    // upload is cut off has sent nothing and can simply be sent again.
    const startIndex = campaignData.startIndex || 0;
    let outcome = { resumeFrom: startIndex, results: [], checkpointFailed: false };
    if (storage.isFullyStored(campaignData)) {
      outcome = await storage.runChunks({
        syncClient,
        campaignId: campaignDocName,
        campaignData,
        startIndex,
        deadline: startTime + MAX_EXECUTION_TIME,
        send: (batch, index) => classicMessages.sendChunk(client, batch, {
          startIndex: index,
          channel: campaignData.channel,
          from: campaignData.from,
          messagingServiceSid: context.MESSAGING_SERVICE_SID,
        }),
      });
    }

    response.setStatusCode(200);
    response.setBody(storage.progressBody(campaignDocName, campaignData, startIndex, outcome));
    return callback(null, response);
  } catch (error) {
    console.error('Send messages error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to send messages',
      message: error.message
    });
    return callback(null, response);
  }
};
```

- [ ] **Step 2: Replace `functions/resume-execution.js` with:**

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * POST /resume-execution — sends the next chunks of an existing classic campaign.
 *
 * Recipients come from the campaign's Sync storage, not from the caller. The
 * server still never resumes a campaign on its own: the browser calls this
 * until the campaign completes. That is what keeps credentials in the browser
 * rather than server-side. See docs/superpowers/specs/2026-08-07-oauth-login-design.md
 */

/**
 * A campaign stored before classic-campaign.private.js keeps its list inline.
 * One that outgrew its Document mid-send recorded a startIndex behind what was
 * actually sent, so resuming it could message recipients twice.
 */
const LEGACY_CAMPAIGN = 'This campaign was saved in an older format and cannot be resumed. ' +
  'Its saved progress may be behind what was actually sent, so check the Messaging logs in the ' +
  'Twilio Console before sending the rest as a new campaign.';

const INCOMPLETE_UPLOAD = 'This campaign\'s recipient list was not fully saved, so it cannot be resumed. ' +
  'Nothing was sent; send it again as a new campaign.';

exports.handler = async function(context, event, callback) {
  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000;
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const { campaignId } = event;

  if (!campaignId) {
    response.setStatusCode(400);
    response.setBody({ error: 'campaignId is required' });
    return callback(null, response);
  }

  let creds;
  let client;
  try {
    creds = oauth.credsFrom(event);
    client = await oauth.authenticate(creds);
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
    // The runtime client is used for Sync only, never for the user's account.
    // autoRetry absorbs 429s from Sync's per-Map write rate.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN, { autoRetry: true, maxRetries: 3 });
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    // Campaign IDs are `campaign_<timestamp>`, so they are guessable rather
    // than secret. Answer 404 both when the document is absent and when it
    // belongs to someone else — a 403 would confirm that a guessed ID exists.
    let campaignData = null;
    try {
      const campaignDoc = await syncClient.documents(campaignId).fetch();
      campaignData = campaignDoc.data;
    } catch (error) {
      // 20404 is "document not found"; anything else is a real failure.
      if (error.status !== 404 && error.code !== 20404) {
        throw error;
      }
    }

    if (!campaignData || campaignData.ownerKey !== oauth.ownerKeyFor(creds)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    const refusal = campaignData.mode === 'bulk'
      ? 'Bulk Messaging campaigns run on Twilio and are never resumed.'
      : !storage.isBucketed(campaignData) ? LEGACY_CAMPAIGN
      : !storage.isFullyStored(campaignData) ? INCOMPLETE_UPLOAD
      : null;
    if (refusal) {
      response.setStatusCode(409);
      response.setBody({ error: refusal });
      return callback(null, response);
    }

    // The browser passes back the resumeFrom it was last given. That can be
    // ahead of the stored index when a checkpoint failed after its chunk was
    // sent, and resuming from the stored index would send the chunk again. It
    // is never allowed behind the stored index: going back only ever re-sends.
    const hint = Number(event.resumeFrom);
    const startIndex = Math.max(
      campaignData.startIndex || 0,
      Number.isSafeInteger(hint) && hint <= campaignData.totalMessages ? hint : 0
    );

    const outcome = await storage.runChunks({
      syncClient,
      campaignId,
      campaignData,
      startIndex,
      // The handler's own start time, so the 9s ceiling bounds total elapsed
      // time including the token exchange and the fetch above.
      deadline: startTime + MAX_EXECUTION_TIME,
      send: (batch, index) => classicMessages.sendChunk(client, batch, {
        startIndex: index,
        channel: campaignData.channel,
        from: campaignData.from,
        messagingServiceSid: context.MESSAGING_SERVICE_SID,
      }),
    });

    response.setStatusCode(200);
    response.setBody(storage.progressBody(campaignId, campaignData, startIndex, outcome));
    return callback(null, response);
  } catch (error) {
    console.error('Resume execution error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to resume execution',
      message: error.message
    });
    return callback(null, response);
  }
};
```

- [ ] **Step 3: Delete the webhook**

```bash
git rm functions/webhook.protected.js
```

- [ ] **Step 4: Check that nothing still references it**

Run: `grep -n "statusCallback\|DOMAIN_NAME" functions/*.js`
Expected: no output

- [ ] **Step 5: Syntax-check the Functions and run the suite**

Run: `node --check functions/send-messages.js && node --check functions/resume-execution.js && npm test`
Expected: no syntax errors; all tests PASS. The Functions have no unit tests (they need the `Runtime` global), so Task 9 checks them live.

- [ ] **Step 6: Commit**

```bash
git add functions/send-messages.js functions/resume-execution.js
git commit -m "feat: upload, send and resume classic campaigns through Sync buckets; retire the status webhook"
```

---

### Task 6: Status reads — check-status, list-campaigns, campaign details

**Files:**
- Modify: `functions/check-status.js`
- Modify: `functions/list-campaigns.js`
- Modify: `assets/campaign-details.private.js` (header comment, `resolveDetails`)
- Test: `test/campaign-details.test.js`

**Interfaces:**
- Consumes: `storage.isBucketed`, `storage.isFullyStored`, `storage.readStatusBuckets`, `storage.updateStatusBucket`, `storage.inBatches` (Tasks 1–2); `classicMessages.pendingKeys`, `classicMessages.refreshStatuses`, `classicMessages.tally` (Task 4).
- Produces, for Task 7:
  - `POST /check-status` → `campaign` no longer carries `messages`. It gains `statusesOmitted: boolean`; when true, `statuses` is `{}` and the counts are still complete. Everything else is unchanged.
  - `POST /list-campaigns` → each classic campaign carries `resumable: boolean`.

- [ ] **Step 1: Write the failing details test**

Append to `test/campaign-details.test.js`:

```js
test('resolveDetails reads a bucketed classic campaign from its shared fields', () => {
  const out = details.resolveDetails({
    storage: 'buckets',
    channel: 'whatsapp',
    from: '+15017122661',
    totalMessages: 300,
    shared: { from: '+15017122661', contentSid: HX, contentVariables: { 1: 'Sarah' } },
    details: details.buildDetails(BULK_INPUT, { mode: 'classic', contentSid: HX, recipientCount: 300 }),
  });
  assert.deepStrictEqual(out.template, { sid: HX, name: 'promo_v2', language: 'en' });
  assert.deepStrictEqual(out.variables, { values: { 1: 'Sarah' }, perRecipient: false });
  assert.strictEqual(out.recipients.count, 300);
  assert.strictEqual(details.summaryLine({ channel: 'whatsapp', from: '+1', shared: { contentSid: HX } }).template, HX);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/campaign-details.test.js`
Expected: FAIL. `out.template` is `null`, because `resolveDetails` reads only `messages[0]`.

- [ ] **Step 3: Read `shared` in `resolveDetails`**

In `assets/campaign-details.private.js`, replace:

```js
  const first = (!bulk && Array.isArray(data.messages) && asObject(data.messages[0])) || {};
```

with:

```js
  // A bucketed classic campaign stores what every message had in common as
  // `shared`. An older one held its whole list, so messages[0] stands in.
  const first = (!bulk && (asObject(data.shared) ||
    (Array.isArray(data.messages) && asObject(data.messages[0])))) || {};
```

In the same file's header comment, replace:

```js
 * A classic campaign document already holds the recipient list and every
 * message status, and sits close to Sync's 16 KiB item limit (see
 * docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md). So a
 * classic `details` leaves out the body and variable values, which
 * `messages[0]` already holds, and every `details` is held to 2 KiB.
```

with:

```js
 * A classic campaign document already holds the fields its messages share
 * (`shared`, or `messages[0]` on documents from before
 * classic-campaign.private.js), and every checkpoint rewrites the whole
 * document. So a classic `details` leaves out the body and variable values,
 * and every `details` is held to 2 KiB.
```

Run: `node --test test/campaign-details.test.js`
Expected: PASS

- [ ] **Step 4: Rewrite the status refresh in `functions/check-status.js`**

Add below the existing `require` lines:

```js
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);
```

Replace the `MESSAGE_SID` constant and its comment with:

```js
/**
 * How far into the invocation a status fetch may still start. The token
 * exchange can take up to 4s of the 10s ceiling, and the writes after the
 * fetches need the rest. Messages not reached are fetched on a later poll.
 */
const FETCH_DEADLINE_MS = 6500;

/**
 * Status buckets refreshed per poll: up to 768 fetches, and no more writes
 * than Sync's 20/s per Map comfortably allows. A larger campaign's buckets take
 * turns, least recently checked first, over several polls.
 */
const MAX_REFRESH_BUCKETS = 24;

/**
 * A Function response is capped at 4 MB. Past this, roughly 13,000 messages,
 * the counts are sent without the per-message list.
 */
const MAX_STATUSES_BYTES = 3.5 * 1024 * 1024;
```

Add `const startTime = Date.now();` as the first line of the handler.

Build the runtime client with retries:

```js
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN, { autoRetry: true, maxRetries: 3 });
```

Keep the document's revision when fetching it:

```js
    let campaignData = null;
    let revision = null;
    try {
      const campaignDoc = await syncClient.documents(campaignId).fetch();
      campaignData = campaignDoc.data;
      revision = campaignDoc.revision;
    } catch (error) {
```

Replace everything from `// Update message statuses from Twilio` down to and including the multi-line `await syncClient.documents(campaignId).update({ data: campaignData });` under `// Update Sync document`, which follows the counters, with:

```js
    // A bucketed campaign keeps its statuses in a Map. One stored before that
    // keeps them inline, on the Document, and is treated as a single bucket.
    const bucketed = storage.isBucketed(campaignData);
    const buckets = bucketed
      ? await storage.readStatusBuckets(syncClient, campaignId)
      : [{ key: null, statuses: campaignData.statuses || {}, checkedAt: null }];

    const candidates = buckets
      .filter((bucket) => classicMessages.pendingKeys(bucket.statuses, campaignData.channel).length)
      .sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || '')));
    const selected = candidates.slice(0, MAX_REFRESH_BUCKETS);
    const takingTurns = candidates.length > selected.length;

    const { statuses: refreshed, changed } = await classicMessages.refreshStatuses(
      client,
      Object.assign({}, ...selected.map((bucket) => bucket.statuses)),
      { channel: campaignData.channel, deadline: startTime + FETCH_DEADLINE_MS }
    );

    // A selected bucket is written when an entry in it changed, or, while
    // buckets are taking turns, to record that it has had its turn.
    const checkedAt = new Date().toISOString();
    const toWrite = [];
    for (const bucket of selected) {
      const keys = Object.keys(bucket.statuses);
      if (takingTurns || keys.some((key) => changed.has(key))) toWrite.push(bucket);
      bucket.statuses = Object.fromEntries(keys.map((key) => [key, refreshed[key]]));
    }

    if (bucketed) {
      await storage.inBatches(toWrite.map((bucket) => () =>
        storage.updateStatusBucket(syncClient, campaignId, bucket.key, bucket.statuses, checkedAt)));
    } else {
      campaignData.statuses = buckets[0].statuses;
    }

    const statuses = Object.assign({}, ...buckets.map((bucket) => bucket.statuses));
    campaignData.lastUpdated = checkedAt;

    const counts = classicMessages.tally(statuses);
    campaignData.delivered = counts.delivered;
    campaignData.read = counts.read;
    campaignData.failed = counts.failed;
    // Anything accepted by Twilio that has not yet reached a terminal state.
    // Clamped at zero: a chunk sent twice inflates `sent` past the recipient
    // count, and a negative "pending" is noise rather than information.
    campaignData.pending = Math.max(0, (campaignData.sent || 0) - counts.delivered - counts.failed);

    // Conditional on the revision read above. A send that checkpointed since
    // then owns startIndex, and writing this older copy over it would move the
    // index back, so the next resume would send a chunk again. Losing this write
    // costs a stale counter until the next poll.
    try {
      await syncClient.documents(campaignId).update({ data: campaignData, ifMatch: revision });
    } catch (error) {
      if (error.status !== 412) throw error;
    }

    const statusesFit = Buffer.byteLength(JSON.stringify(statuses), 'utf8') <= MAX_STATUSES_BYTES;
```

In the response body, replace `statuses: statusUpdates,` with:

```js
        statuses: statusesFit ? statuses : {},
        statusesOmitted: !statusesFit,
```

and delete these two lines:

```js
        // Include resume data if available
        messages: campaignData.messages || null,
```

- [ ] **Step 5: Report `resumable` from `functions/list-campaigns.js`**

Add below the existing `require` lines:

```js
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
```

In the classic `campaigns.push({ ... })`, after `isComplete: ...,` add:

```js
        // False for older campaigns and for ones whose upload was cut off;
        // see resume-execution.js.
        resumable: storage.isFullyStored(campaignData),
```

- [ ] **Step 6: Syntax-check and run the suite**

Run: `node --check functions/check-status.js && node --check functions/list-campaigns.js && npm test`
Expected: no syntax errors; all tests PASS

Run: `grep -n "statusUpdates\|MESSAGE_SID\|TERMINAL_FAILURE" functions/check-status.js`
Expected: no output

- [ ] **Step 7: Commit**

```bash
git add functions/check-status.js functions/list-campaigns.js assets/campaign-details.private.js test/campaign-details.test.js
git commit -m "feat: refresh classic statuses in rotating buckets within a time budget"
```

---

### Task 7: Browser — size notice, sliced upload, resume loop, warnings

**Files:**
- Modify: `assets/app.js`
- Modify: `assets/index.html:175`
- Modify: `assets/styles.css` (after `.send-note--active`)

**Interfaces:**
- Consumes: the Function contracts listed in Tasks 5 and 6.
- Produces (internal to `app.js`): `CLASSIC_SUGGESTED_MAX`, `UPLOAD_MAX_BYTES`, `CHECKPOINT_WARNING`, `classicLimitMessage(count)`, `currentRecipientCount()`, `updateClassicLimitNotice()`, `uploadSliceEnd(messages, start, maxBytes)`, `functionError(data, fallback)`, `continueCampaign(campaignId, resumeFrom)`.

- [ ] **Step 1: Add the notice element and its style**

In `assets/index.html`, directly below:

```html
                                        <small id="recipients-help">Enter numbers in E.164 format (+6512345678), one per line or comma-separated</small>
```

add:

```html
                                        <p id="classic-limit-notice" class="limit-notice" role="status" hidden></p>
```

In `assets/styles.css`, after the `.send-note--active { … }` rule, add:

```css
/* Under Recipients when a Programmable Messaging campaign is over the
   suggested size. Advice, not an error: the same tinted box as
   .send-note--active, with the text kept --text for the same contrast reason. */
.limit-notice {
    margin: 8px 0 0;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid rgba(228, 98, 22, 0.35);
    background: rgba(228, 98, 22, 0.08);
    color: var(--text);
    font-size: 12px;
    line-height: 1.5;
}
```

- [ ] **Step 2: Add the constants and helpers**

Below the `MESSAGE_SID` constant near the top of `assets/app.js`, add:

```js
/**
 * The size above which a Programmable Messaging campaign gets a notice
 * suggesting Bulk Messaging. Advice only: nothing refuses a larger campaign.
 * Bulk takes up to 10,000 recipients in one request and needs no open tab.
 */
const CLASSIC_SUGGESTED_MAX = 1000;

/**
 * Most JSON per send-messages request. A Function request is capped at 1 MB,
 * credentials and headers included, so the recipient list goes up in slices.
 */
const UPLOAD_MAX_BYTES = 700 * 1024;

/** Shown when a send or resume finished but a checkpoint could not be saved. */
const CHECKPOINT_WARNING = 'Sending finished, but progress could not be saved for some messages. '
    + 'They were sent, but may be missing from the delivery table and its counts. '
    + 'The Messaging logs in the Twilio Console have the full record.';

function classicLimitMessage(count) {
    return `This campaign has ${count.toLocaleString('en-US')} recipients. Programmable Messaging is suggested `
        + `for up to ${CLASSIC_SUGGESTED_MAX.toLocaleString('en-US')} per campaign; for larger campaigns, `
        + 'switch the API to Bulk Messaging.';
}

/** Recipients the form would send right now: the CSV's rows, or the typed list. */
function currentRecipientCount() {
    if (csvIsActive()) return csvUpload.rows.length;
    const text = document.getElementById('recipients').value.trim();
    return text ? text.split(/[\n,]+/).map(r => r.trim()).filter(r => r.length > 0).length : 0;
}

/** Shows the size notice only for a Programmable Messaging campaign over the suggested size. */
function updateClassicLimitNotice() {
    const notice = document.getElementById('classic-limit-notice');
    if (!notice) return;
    const count = isBulkMode() ? 0 : currentRecipientCount();
    notice.hidden = count <= CLASSIC_SUGGESTED_MAX;
    notice.textContent = notice.hidden ? '' : classicLimitMessage(count);
}

/** Where the upload slice starting at `start` ends, so it stays under `maxBytes` of JSON. */
function uploadSliceEnd(messages, start, maxBytes) {
    const encoder = new TextEncoder();
    let bytes = 0;
    let end = start;
    while (end < messages.length) {
        const size = encoder.encode(JSON.stringify(messages[end])).length + 1;
        if (end > start && bytes + size > maxBytes) break;
        bytes += size;
        end++;
    }
    return end;
}
```

- [ ] **Step 3: Keep the notice current**

In `renderCsvState()`, add as its first line:

```js
    updateClassicLimitNotice();
```

In `applySendMode()`, directly after the `if (modeHelp) { … }` block, add:

```js
    updateClassicLimitNotice();
```

In `setupEventListeners()`, directly after the `message-form` submit listener, add:

```js
    // Typed recipients drive the size notice as they are entered.
    document.getElementById('recipients').addEventListener('input', updateClassicLimitNotice);
```

- [ ] **Step 4: Replace the send loop**

Replace the whole `sendMessagesBatch` function, from `async function sendMessagesBatch(` through its closing brace just before the `/**` comment of `sendBulkCampaign`, with:

```js
/** A Function's error, with the underlying cause when it sent one. */
function functionError(data, fallback) {
    const error = (data && data.error) || fallback;
    return data && data.message ? `${error} (${data.message})` : error;
}

/**
 * Carries a classic campaign on to completion through resume-execution, one
 * time-boxed call after another. Returns true if any checkpoint failed.
 *
 * `resumeFrom` is the server's own value from the previous call, passed back
 * because a checkpoint can fail after its chunk was sent. The stored index is
 * then behind, and resuming from it would send that chunk again. Omitted, the
 * server resumes from the stored index.
 */
async function continueCampaign(campaignId, resumeFrom) {
    let checkpointFailed = false;
    let isComplete = false;

    while (!isComplete) {
        const response = await postToFunction('resume-execution', { campaignId, resumeFrom });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(functionError(data, 'Failed to resume campaign'));
        }

        resumeFrom = data.resumeFrom;
        isComplete = data.isComplete;
        checkpointFailed = checkpointFailed || Boolean(data.checkpointFailed);

        // Update UI - fetch full campaign status to get delivery/read info
        await refreshCurrentCampaign();

        if (!isComplete) {
            // Wait a bit before resuming (to avoid hitting rate limits)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    return checkpointFailed;
}

/**
 * Uploads the recipient list to send-messages in slices that fit a Function
 * request, each starting where the server says the last one ended. The call
 * that completes the list also starts sending; continueCampaign does the rest.
 * Nothing is sent until the whole list is stored.
 */
async function sendMessagesBatch(messages, channel, from, campaignName, details) {
    let storedCount = 0;
    let data = null;

    while (storedCount < messages.length) {
        const end = uploadSliceEnd(messages, storedCount, UPLOAD_MAX_BYTES);
        const response = await postToFunction('send-messages', {
            messages: messages.slice(storedCount, end),
            offset: storedCount,
            totalMessages: messages.length,
            campaignId: currentCampaignId,
            channel,
            from,
            campaignName: campaignName || null,
            // Stored only when the first slice creates the campaign.
            ...(storedCount === 0 ? { details } : {})
        });
        data = await response.json();

        if (!response.ok) {
            // Nothing has been sent yet unless the list was complete, in which
            // case the refreshed list offers to resume it.
            loadCampaigns();
            throw new Error(functionError(data, 'Failed to send messages'));
        }
        if (!(data.storedCount > storedCount)) {
            throw new Error('Failed to send messages (the recipient list stopped uploading)');
        }

        storedCount = data.storedCount;
        await refreshCurrentCampaign();
    }

    let checkpointFailed = Boolean(data.checkpointFailed);

    if (!data.isComplete) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
            checkpointFailed = (await continueCampaign(currentCampaignId, data.resumeFrom)) || checkpointFailed;
        } catch (error) {
            console.error('Error sending messages:', error);

            // Show error but allow manual resume
            showResumeOption();
            throw error;
        }
    }

    if (checkpointFailed) alert(CHECKPOINT_WARNING);

    // Final status check
    await refreshCurrentCampaign();

    // Reload campaigns list
    await loadCampaigns();

    // Start auto-refresh
    startStatusAutoRefresh();

    setSendingState(false);
}
```

- [ ] **Step 5: Replace the resume loop**

Replace the whole `resumeCampaignById` function with:

```js
async function resumeCampaignById(campaignId, event) {
    if (!creds) {
        alert('Please sign in to resume campaigns');
        return;
    }

    // Show loading state
    const resumeBtn = event?.target;
    if (resumeBtn) {
        resumeBtn.disabled = true;
        resumeBtn.textContent = 'Resuming...';
    }

    try {
        // Resume only ever reaches a fully stored classic campaign — the
        // Resume button is offered for nothing else (see displayCampaigns). The
        // server reads the recipients from Sync, so nothing is fetched first.
        currentCampaignId = campaignId;
        currentCampaignMode = 'classic';

        const checkpointFailed = await continueCampaign(campaignId);
        if (checkpointFailed) alert(CHECKPOINT_WARNING);

        // Campaign completed
        await checkCampaignStatus();
        await loadCampaigns();
        startStatusAutoRefresh();

    } catch (error) {
        console.error('Error resuming campaign:', error);
        alert('Error resuming campaign: ' + error.message);
    } finally {
        // Restore button state
        if (resumeBtn) {
            resumeBtn.disabled = false;
            resumeBtn.textContent = 'Resume';
        }
    }
}
```

- [ ] **Step 6: Offer Resume only where it can work**

In `displayCampaigns()`, replace:

```js
        // Bulk campaigns cannot be resumed: Twilio owns the processing, and no
        // recipient list is stored to resume from. An operation continues on its
        // own or has already finished.
        const canResume = campaign.mode !== 'bulk' && !campaign.isComplete && campaign.startIndex < campaign.totalMessages;
```

with:

```js
        // Bulk campaigns cannot be resumed: Twilio owns the processing, and no
        // recipient list is stored to resume from. An operation continues on its
        // own or has already finished. Nor can classic campaigns saved in the
        // older format, or whose upload was cut off; see resume-execution.js.
        const canResume = campaign.mode !== 'bulk' && campaign.resumable !== false
            && !campaign.isComplete && campaign.startIndex < campaign.totalMessages;
```

- [ ] **Step 7: Explain an omitted list**

In `displayMessageDetails()`, replace:

```js
    if (statusEntries.length === 0) {
        // A bulk campaign's totals are kept in Sync and outlast Twilio's
        // per-recipient rows, so they are shown even when there are no rows.
        messageDetailsContent.innerHTML = detailsBlock + (campaign.mode === 'bulk' ? summary : '') +
            (note || '<p style="color: #666; text-align: center; padding: 20px;">No messages sent yet. Messages will appear here once they are successfully sent.</p>');
        return;
    }
```

with:

```js
    if (campaign.statusesOmitted) {
        // check-status leaves the per-message list out when it would not fit a
        // Function response; the counts it sends are still complete.
        messageDetailsContent.innerHTML = detailsBlock + summary +
            '<p class="details-note">This campaign is too large to list message by message here. The counts above are complete.</p>';
        return;
    }

    if (statusEntries.length === 0) {
        // A bulk campaign's totals are kept in Sync and outlast Twilio's
        // per-recipient rows, so they are shown even when there are no rows.
        messageDetailsContent.innerHTML = detailsBlock + (campaign.mode === 'bulk' ? summary : '') +
            (note || '<p style="color: #666; text-align: center; padding: 20px;">No messages sent yet. Messages will appear here once they are successfully sent.</p>');
        return;
    }
```

- [ ] **Step 8: Remove the Webhook Received column**

In `displayMessageDetails()`, delete these lines:

```js
                        <th>Webhook Received</th>
```

```js
        const webhookReceived = statusInfo.webhookReceivedAt || null;
```

```js
                <td>${formatDate(webhookReceived)}</td>
```

In `exportMessageStatusCsv()`, delete:

```js
        'Webhook Received': s.webhookReceivedAt || '',
```

Leave `statusInfo.dateUpdated || statusInfo.webhookReceivedAt` in place: older campaigns still carry that field.

- [ ] **Step 9: Check the result**

Run: `node --check assets/app.js && grep -n "campaign.messages\|Webhook Received\|webhookReceived\b" assets/app.js`
Expected: no syntax error, no grep output

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add assets/app.js assets/index.html assets/styles.css
git commit -m "feat: sliced upload and Bulk suggestion for large classic campaigns; resume from Sync"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md`

- [ ] **Step 1: Update `README.md`**

Make these replacements.

Features, line 9. Replace:

```
- **Resumable campaigns** on Programmable Messaging, surviving the 10-second Function timeout by chunking and checkpointing to Twilio Sync
```

with:

```
- **Resumable campaigns** on Programmable Messaging, tested to 10,000 recipients, surviving the 10-second Function timeout by chunking and checkpointing to Twilio Sync
```

API comparison table. Replace:

```
| Request shape | one per recipient | one request for up to 10,000 recipients |
```

with:

```
| Request shape | one per recipient; suggested for up to 1,000 per campaign | one request for up to 10,000 recipients |
```

Send note. Replace:

```
> Nothing is lost if sending is interrupted. Progress is checkpointed to Sync, so the campaign shows as **In Progress** with a **Resume** button that picks up from the last index, and no recipient is messaged twice. Closing the tab also clears your credentials, so you will need to sign in again before resuming.
```

with:

```
> Nothing is lost if sending is interrupted. Progress is checkpointed to Sync, so the campaign shows as **In Progress** with a **Resume** button that picks up after the last chunk sent. If a checkpoint cannot be saved, the page carries on from where sending really reached and warns you that some statuses may be missing, rather than sending that chunk again. Closing the tab also clears your credentials, so you will need to sign in again before resuming.
>
> Above 1,000 recipients the page suggests Bulk Messaging, which sends up to 10,000 in one request and does not need the tab kept open. Programmable Messaging still sends larger campaigns.
```

"How resumable execution works". Replace the paragraph starting `Messages are processed in chunks of 100.` with:

```
The page uploads the recipient list to `send-messages.js` in slices of up to 700 KB, since a Function request is capped at 1 MB. Once the whole list is in Sync, sending starts: up to 128 messages per chunk, chunk after chunk, until the Function approaches a 9-second budget (inside the platform's 10-second ceiling), saving the position after each chunk. The page then calls `resume-execution.js`, which reads the next recipients back from Sync, until the campaign completes.

A campaign's Sync Document holds only what does not grow with it: owner, counters, position, and the fields every message shares. Recipients live in the `campaign_<id>_recipients` Map, in buckets of up to 128 recipients and 9 KiB; statuses live in `campaign_<id>_statuses`, in buckets of 32. Every key is the index of the first recipient its bucket covers. That keeps every item under Sync's 16 KiB limit. Campaigns saved before this layout still open, but cannot be resumed.

`check-status.js` refreshes the 24 status buckets checked least recently that still have a status to change, 20 messages at a time, and starts no fetch after 6.5 seconds. A large campaign's buckets take turns over several 5-second polls. Past roughly 13,000 messages, the per-message list no longer fits the 4 MB Function response, so the delivery panel shows the counts only.
```

Architecture block. Replace:

```
  send-messages.js          Chunked sending, checkpointed to Sync
  resume-execution.js       Continues a campaign from its last checkpoint
  check-status.js           Campaign status, re-fetching each message from Twilio
```

with:

```
  send-messages.js          Stores the recipient list in Sync, then starts sending
  resume-execution.js       Continues a campaign from Sync, chunk by chunk
  check-status.js           Campaign status, re-fetching unsettled messages from Twilio
```

delete:

```
  webhook.protected.js      Delivery-status callbacks (signature-validated)
```

and after the `bulk-payload.private.js` line add:

```
  classic-campaign.private.js  Sync layout and chunk loop for Programmable Messaging
  classic-messages.private.js  Sending and status refresh for Programmable Messaging
```

Replace:

```
Every Function except the webhook receives `clientId` and `clientSecret` in its POST body and builds a per-request Twilio client through `assets/twilio-oauth.private.js`. The webhook is the exception: Twilio calls it, not the browser, so it carries no user credentials. The runtime credentials (`context.ACCOUNT_SID` / `context.AUTH_TOKEN`) are used for Sync access throughout, never for the user's own account.
```

with:

```
Every Function receives `clientId` and `clientSecret` in its POST body and builds a per-request Twilio client through `assets/twilio-oauth.private.js`. The runtime credentials (`context.ACCOUNT_SID` / `context.AUTH_TOKEN`) are used for Sync access throughout, never for the user's own account. Messages are sent with no status callback, so no endpoint takes calls from Twilio.
```

Security list. Delete the bullet starting `- The status-callback endpoint is a **protected** Function`.

Troubleshooting. Replace:

```
**Timeouts.** Handled automatically by chunking. If a single chunk still overruns, lower `CHUNK_SIZE` in `send-messages.js`.
```

with:

```
**Timeouts.** Handled automatically by chunking. If a single chunk still overruns, lower `RECIPIENT_BUCKET_MAX_ENTRIES` in `assets/classic-campaign.private.js`.

**No Resume button on an unfinished campaign.** Either its recipient list was not fully uploaded, in which case nothing was sent and it can be sent again as a new campaign, or it was saved before the current storage layout. An older campaign's saved position can be behind what was actually sent, so check the Messaging logs in the Twilio Console before sending the remainder.
```

- [ ] **Step 2: Update the spec's status**

In `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md`, replace:

```
**Status:** Specified, not scheduled
```

with:

```
**Status:** Implemented 2026-11-04 with deviations; see `docs/superpowers/plans/2026-11-04-classic-sync-buckets.md`
```

and append at the end of the file:

```

## Implementation notes (2026-11-04)

Implemented with these deviations, each argued in the plan:

- Recipient buckets hold up to 128 recipients and 9 KiB; status buckets hold 32, keyed within each recipient bucket. Fields shared by every message are stored once on the Document.
- The browser uploads the list in slices under the 1 MB Function request cap, and nothing is sent until all of it is stored.
- The polling ceiling was brought into scope: a rotating window of 24 status buckets per poll, parallel and time-boxed fetches, final statuses skipped. Past ~13,000 messages the poll returns counts without the per-message list, to fit the 4 MB response cap.
- No TTL on the Maps, matching the Documents.
- Legacy documents render but cannot be resumed, because their stored index can be behind what was sent.
- `check-status` writes the Document conditionally on its revision.
- No hard recipient limit. Above 1,000 the page suggests Bulk Messaging.
```

- [ ] **Step 3: Check for leftover references**

Run: `grep -n -i "webhook\|status-callback endpoint\|CHUNK_SIZE\|chunks of 100" README.md`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md
git commit -m "docs: classic campaign scale, Sync bucket storage, sliced upload"
```

---

### Task 9: Live verification in dev-environment, at 10,000 recipients

Unit tests cover the logic against fakes. This task confirms the Sync and Functions limits the design assumes, against the real services. **Ask the user before Steps 5–9:** they make API calls on the account, and Step 8 sends real messages.

**Files:** none changed. Test CSVs go to `/tmp`.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all tests PASS (121 existing + 47 new)

- [ ] **Step 2: Confirm the environment has no variables a deploy would remove**

Run: `npx twilio api:serverless:v1:services:environments:variables:list --service-sid ZSb34b1c5e48d1ba966735c9bdf0ac6ac4 --environment-sid ZE73f6bcab402752df22cbe74cc471db9d -p Abel`
Expected: empty list

- [ ] **Step 3: Deploy**

Run: `npm run deploy -- -p Abel`
Expected: the deploy succeeds; the asset list includes `/classic-campaign.js` and `/classic-messages.js` as private; `/webhook` is gone

- [ ] **Step 4: Smoke-check every changed endpoint**

```bash
BASE=https://twilio-messaging-ui-2855-dev.twil.io
for f in send-messages resume-execution check-status list-campaigns; do
  printf '%s ' "$f"; curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/$f"
done
for a in classic-campaign.js classic-messages.js; do
  printf '%s ' "$a"; curl -s -o /dev/null -w '%{http_code}\n' "$BASE/$a"
done
printf 'webhook '; curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/webhook"
```

Expected: `400` for each Function (a `500` means a module failed to load), `403` for both assets, `404` for the webhook

- [ ] **Step 5: The notice (no API calls)**

Sign in at the deployed URL with API = Programmable Messaging. Type 1,000 numbers into Recipients: no notice. Add one more: the notice appears and reads "This campaign has 1,001 recipients…". Switch API to Bulk Messaging: the notice disappears. Upload `/tmp/classic-10000.csv` from Step 6 in classic mode: the notice shows 10,000.

- [ ] **Step 6: 10,000 recipients, typed body, every send refused (no messages sent)**

`+999` is not an assigned country code, so Twilio refuses each create (error 21211) and sends nothing.

```bash
node -e "const r=['Number'];for(let i=0;i<10000;i++)r.push('+999'+String(i).padStart(8,'0'));require('fs').writeFileSync('/tmp/classic-10000.csv',r.join('\n')+'\n')"
```

Upload it with a typed body and send.
Expected: the notice shows but does not block; no error alerts; the campaign completes over several calls; the card shows 10,000 failed; the delivery panel lists 10,000 rows, "not accepted", error 21211. In DevTools → Network, every request is under 1 MB and every `check-status` response under 4 MB.

Then count the Sync items:

```bash
npx twilio api:sync:v1:services:list -p Abel   # note the SID of "Messaging UI Sync Service"
for m in recipients statuses; do
  npx twilio api:sync:v1:services:maps:items:list --service-sid <IS…> --map-sid <campaignId>_$m --limit 1000 -p Abel -o json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('$m',JSON.parse(s).length))"
done
```

Expected: about 79–80 recipient items and 313–314 status items (one more of each per upload-slice boundary)

- [ ] **Step 7: 10,000 recipients with their own bodies (no messages sent)**

```bash
node -e "const r=['Number,Body'];for(let i=0;i<10000;i++)r.push('+999'+String(i).padStart(8,'0')+',Row '+i+' — Exclusive deal on coffee at select stores. Limited quantity: https://example.com/'+i.toString(36)+' . Reply STOP to opt out, HELP for info. '+'x'.repeat(120));require('fs').writeFileSync('/tmp/classic-10000-bodies.csv',r.join('\n')+'\n')"
```

Upload and send.
Expected: several `send-messages` calls before sending starts, each request under 1 MB; no 500; the campaign completes. The recipients Map holds about 300 items. With claims, each chunk writes the statuses Map twice: once to claim its status items before sending, and once to replace their placeholders with the results. If a call fails with a Sync 429 after retries, or overruns 10 s, lower `WRITE_CONCURRENCY` or `STORE_DEADLINE_MS` and repeat.

- [ ] **Step 8: Real delivery (sends real messages — use numbers the user provides)**

Send a typed-body SMS campaign to the user's numbers.
Expected: statuses move to `delivered` within a few polls. Once every row is delivered, further polls make no Sync writes: the status items' `date_updated` stops changing.

- [ ] **Step 9: Resume after an interruption**

Re-send `/tmp/classic-10000.csv`. Once sending has started (the Sent count moves), close the tab. Sign in again and click **Resume** on the campaign.
Expected: it completes with exactly 10,000 rows, with no row repeated. Then repeat, closing the tab during the upload instead (before the Sent count moves).
Expected: the campaign shows no Resume button, and its card shows nothing sent.

- [ ] **Step 10: An older campaign**

Open a classic campaign created before this deploy.
Expected: its delivery panel renders. If it is unfinished, it shows no Resume button.

- [ ] **Step 11: Report**

Record the results of Steps 4–10 in the PR description, including any constant that had to change.
