# Bulk Messaging API as a second send mode

**Date:** 2026-09-02
**Branch:** `feat/bulk-messaging-api`
**Status:** Approved

## Goal

Offer Twilio's [Bulk Messaging API](https://www.twilio.com/docs/bulk-messaging) as a selectable alternative to the Programmable Messaging path this app already uses, at functional parity, plus the three Bulk-only features that are cheap to expose: scheduling, channel fallback and tags.

One `POST https://comms.twilio.com/v1/Messages` accepts up to 10,000 recipients and returns `202 Accepted` with an `operationId`. Nothing needs chunking, so the defining constraint of the existing design — the browser must stay open to drive the chunk loop — does not apply in this mode.

## Decisions taken before designing

| Question | Decision |
| --- | --- |
| Authentication | The existing OAuth sign-in, unchanged. Comms scopes exist in the Console and have been granted to the OAuth app. |
| Relationship to the classic path | Coexist as a selectable mode. The classic path keeps all five channels and is not modified behaviourally. |
| Delivery detail | Poll aggregate operation stats; fetch the per-recipient list on demand. |
| Bulk-only features | Scheduling, channel fallback and tags all in scope. |

## Constraints established by research

- **No SDK support.** `comms` is absent from `twilio@5.10.6`, so requests use raw `fetch`.
- **Public Beta.** No SLA, and the surface may change. The classic mode remains the escape hatch.
- **No Facebook Messenger.** Bulk covers SMS, MMS, RCS and WhatsApp only.
- **No per-request `statusCallback`.** The documented request body is `to`, `content`, `from`, `schedule`, `tags`. Tracking is by polling.
- **Limits.** 10,000 recipients and 10MB per request; existing MPS limits still apply.
- Route existence was confirmed empirically: `/v1/Messages`, `/v1/Messages/Operations/{id}`, `/v1/Senders` and `/v1/SenderPools` all answer `401` unauthenticated, while `/v1/Nonsense` answers `404`.

## Architecture

Bulk mode is a third send path beside the existing two. No classic-path behaviour changes.

### New modules

```
assets/bulk-payload.private.js   Pure mapping: campaign request → Bulk request JSON. No I/O.
assets/twilio-comms.private.js   The only module that knows comms.twilio.com.
functions/send-bulk.js           One POST, records the operation in Sync.
functions/check-bulk-status.js   Operation stats; pages the per-message list on demand.
```

`bulk-payload.private.js` is a pure function because every fiddly rule in this design lives there — channel mapping, Liquid escaping, variable shaping, recipient splitting. Keeping it free of I/O makes all of it testable without a Twilio account. It also keeps `send-bulk.js` short: `send-messages.js` is 359 lines mixing auth, Sync access, chunking, channel prefixing and error shaping, and that file is hard to hold in your head.

`twilio-comms.private.js` exists so exactly one module knows the base URL, the bearer header, how a `202` yields its `operationId` header, how errors normalise, and how to follow `pagination.next`. Both new Functions depend on it; neither knows it is HTTP.

Both are `.private.js`, matching `twilio-oauth.private.js`, so Twilio Serverless marks them `access: private` and never serves them over HTTP.

### Modified modules

- **`assets/twilio-oauth.private.js`** gains `authenticateWithToken(creds)` returning `{ client, authString, accountSid }`. `authenticate()` becomes a thin wrapper over it, so its six existing callers are untouched. The function already computes `authString` internally and discards it; the Bulk client needs it as a bearer token.
- **`assets/app.js`** gains the mode toggle, the scheduling and fallback controls, the single-request bulk send, and bulk status polling.
- **`functions/check-status.js`** and **`functions/list-campaigns.js`** branch on `campaignData.mode`, defaulting to the classic path when it is absent so existing campaign documents keep working.
- **`functions/webhook.protected.js`** is unchanged. It serves the classic path only; bulk mode never registers a callback.

## Channel and sender mapping

| App channel | `from.channel` | `to[].channel` |
| --- | --- | --- |
| SMS | `SMS` | `PHONE` |
| MMS | `MMS` | `PHONE` |
| RCS | `RCS` | `PHONE` |
| WhatsApp | `WHATSAPP` | `WHATSAPP` |
| Messenger | — | classic path only; hidden in bulk mode |

WhatsApp addresses are bare E.164. The `whatsapp:` prefix the classic path glues on is a Programmable Messaging convention; here the channel is a field, so any incoming `whatsapp:` prefix is stripped.

**Messaging Services are not valid bulk senders.** The current UI offers a Messaging Service (`MG…`) on every channel, but the Bulk API's `from` accepts an `address`+`channel` pair, a `senderId`, or a `senderPoolId` — an `MG` SID is none of these. In bulk mode the sender list is phone numbers plus any sender pools from `GET /v1/SenderPools`, and a selected Messaging Service is rejected with a message naming the reason, rather than sent and left to fail opaquely.

## Content and personalisation

Bulk carries one `content` object per request with per-recipient `variables`, where the classic path builds an independent message per recipient. That difference drives the whole table.

| Current behaviour | Bulk payload |
| --- | --- |
| Typed message body | `content: { text: "{% raw %}…{% endraw %}" }` |
| Content template | `content: { contentId: "HX…" }` + `to[i].variables = { "1": … }` |
| CSV variable columns | as above, one `variables` object per row |
| CSV `Body` column | `content: { text: "{{body}}" }` + `to[i].variables = { body: row.body }` |
| MMS media | `content: { text, media: [url] }` |

Two rules here are load-bearing.

**`content.text` is Liquid-templated.** A body containing `{{name}}` would be silently interpreted and most likely render empty. Wrapping a typed body in `{% raw %}…{% endraw %}` keeps it literal, matching what the classic path sends. The wrapper is omitted only when the body *is* a variable reference — the CSV case below.

**The CSV `Body` column has no direct Bulk equivalent**, because one request carries one content object. Routing it through a single variable — `content.text` is exactly `{{body}}`, and each recipient supplies its own `body` — preserves the feature. Liquid substitutes in one pass, so a recipient's body text is not itself re-rendered.

A blank variable cell still sends as empty text rather than falling back to the template's sample value, as on the classic path, and for the same reason: a sample value would put someone else's placeholder data in a real message.

## Bulk-only features

- **Tags.** The campaign name, channel and `mode` as key/value pairs, within the limit of 10 pairs, 128-character keys and 256-character values. These correlate this app's traffic in Twilio's logs.
- **Scheduling.** An optional `sendAt` field, RFC 3339, up to seven days ahead. A scheduled operation reports status `SCHEDULED`.
- **Channel fallback, WhatsApp only.** The per-recipient `addresses[]` form — `WHATSAPP` then `PHONE` for the same number — which needs no sender pool.

  RCS-to-SMS fallback cannot be expressed this way, and the design table above shows why: an RCS recipient's `to[].channel` is already `PHONE`, so both attempts would be identical. RCS falls back only through sender-pool `channels.priority` or per-channel `content.modules`, both of which need a pool resource to be created and managed. Out of scope; the fallback control appears on WhatsApp alone.

## Tracking and state

A bulk campaign's Sync document stores `mode: 'bulk'`, `operationIds`, `recipientCount`, and the existing ownership and display fields (`ownerKey`, `accountSid`, `channel`, `from`, `campaignName`, timestamps). It stores **no recipient list and no per-message `statuses` map**: there is no resume to support, so there is nothing to checkpoint. That also avoids a real ceiling, since a Sync document holds at most 16KB of data — a limit the classic path's stored `messages` array must already strain on large campaigns.

`check-bulk-status.js` polls `GET /v1/Messages/Operations/{id}` every 5 seconds and writes the returned `stats` into the campaign document. The block is richer than today's three counters: `total`, `recipients`, `attempts`, `queued`, `sent`, `scheduled`, `delivered`, `read`, `undelivered`, `failed`, `unaddressable`, `canceled`. Polling is terminal on `COMPLETED` or `CANCELED`.

Expanding the delivery panel or exporting CSV calls the same Function with `includeMessages=1`, which pages `GET /v1/Messages?operation_id=` at `pageSize=1000`, follows `pagination.next`, and returns a page token if it approaches the 9-second budget so the browser can ask for the rest. Those rows are returned to the browser and never written to Sync. Bulk's `SCREAMING_CASE` statuses normalise to the lowercase vocabulary the existing delivery table and CSV export already render.

**Above 10,000 recipients** the payload splits into consecutive operations, `operationIds` holds each, and stats sum across them. Without the split, bulk mode would silently cap where the classic path is unbounded.

## Error handling

**`202` means accepted, not sent.** The UI reports recipients *accepted* and lets the stats block report delivery, rather than showing a "sent" count that only means Twilio took the request. This is the clearest semantic difference between the two modes and the copy must not blur it.

A `400` rejects the whole request atomically, so nothing was sent and there is no partial state to reconcile; the message surfaces verbatim. A `401` reuses the existing OAuth error handling, with an added hint naming the Comms scope, since a missing scope is now a plausible cause. A `429` reuses the existing exponential-backoff helper, though one request means at most one retry rather than one per message. Recipients Twilio cannot address at all are counted in `unaddressable` rather than failing the request.

Client-side validation rejects a payload over 10MB before it is sent, since the split above bounds recipient count but not variable size.

## UI

A mode toggle sits above the send form, persisted in `sessionStorage` alongside the credentials. In bulk mode:

- Messenger is hidden from the channel list.
- A `sendAt` field and a fallback checkbox appear.
- The **"keep the tab open" warning is replaced with the opposite advice**: sending continues on Twilio, so the tab can be closed. This is the headline difference for anyone using the tool.
- The campaign card reports *accepted* rather than *sent*, then the stats block.

Campaign history badges which mode created each row, so a resumable classic campaign is not confused with a fire-and-forget bulk one.

## Testing

The repo has no test framework. Add `node:test` — built in, zero dependencies, already available on the Node 24 runtime — wired to `npm test`.

Unit tests against `bulk-payload.private.js`, which needs no credentials:

- channel and recipient-channel mapping for all four channels, and `whatsapp:` prefix stripping
- `{% raw %}` wrapping of a typed body, and its omission in the CSV `Body` case
- CSV `Body` → `content.text` of `{{body}}` plus per-recipient `variables.body`
- content-template variables, positional and named
- blank variable cell sends empty rather than the sample value
- fallback `addresses[]` ordering
- tag, schedule and media shaping
- the >10,000 recipient split
- Messaging Service rejection

Unit tests against `twilio-comms.private.js` with a stubbed `fetch`: `operationId` extraction from the response header, error normalisation for 400/401/429, and `pagination.next` following.

Manual verification, which the unit tests cannot cover: one send per channel, a CSV-personalised send, a scheduled send, a fallback send, and a >10,000 recipient split.

## Assumptions to confirm against a live call

Both are documented ambiguously and will be checked rather than guessed:

1. Whether `schedule.sendAt` takes a string or an array. The API reference renders it as `{sendAt: [RFC 3339 date-time]}`, which reads as a type annotation, but the scheduling guide shows a literal array.
2. The exact `from` shape for a sender pool — whether `senderPoolId` sits at the top level of `from` or beside a channel field.

## Out of scope

- Sender-pool creation or management, and `channels.priority` fallback.
- Rich content via `content.modules` — the existing content-template picker covers rich content through `contentId`.
- Profile and connected-address recipients, which need a Memory Store.
- Event Streams subscriptions as an alternative to polling.
- Cancelling a scheduled operation. The route is undocumented; revisit once it is published.
- Any change to the classic path's behaviour, including its 16KB Sync ceiling.

## Documentation

The README gains a Bulk Messaging section and a table comparing the two modes, since the tab-open constraint it currently states as unconditional becomes mode-specific.
