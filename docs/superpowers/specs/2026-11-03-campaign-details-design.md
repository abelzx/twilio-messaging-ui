# Campaign details: sender, template, message and settings

**Date:** 2026-11-03
**Status:** Approved, not implemented
**Applies to:** both send modes (Programmable Messaging and Bulk Messaging).

## Problem

A campaign's history shows counters and nothing else. Once sent, there is no way to tell from the UI which sender it went out from, which Content Template it used, or what it said.

Some of this is already stored and simply not shown; some is not stored at all:

| | Classic doc | Bulk doc |
| --- | --- | --- |
| `channel`, `from` | stored | stored |
| Content Template SID | stored, in `messages[0].contentSid` | **not stored** |
| Message body, template variables | stored, in `messages[0]` | **not stored** |
| Scheduled time | n/a | stored, `scheduledFor` |
| SMS fallback | n/a | **not stored** |
| Sender / template friendly names | **not stored** | **not stored** |
| Recipient source (typed or CSV) | **not stored** | **not stored** |
| Media URL | **not stored** | **not stored** |

Friendly names cannot be looked up later in the browser: the sender dropdown and `loadedTemplates` hold only the currently selected channel's entries. Looking them up server-side on every view would add Content API and Messaging Service calls to a 2-second poll inside a 10-second Function budget.

## Decision

Record the details once, when the campaign is created. The browser supplies the labels only it knows (dropdown text, template name, CSV file name, media URLs resolved from the template); the server supplies the facts it actually sent, which override anything the browser claims for the same field.

## Data

One new field, `details`, on the campaign's Sync Document. Written on create only, never updated.

```js
details: {
  sender:     { label, kind },                 // kind: 'direct' | 'service' | 'pool' | 'typed'
  template:   { sid, name, language } | null,
  message:    { body, perRecipient },          // perRecipient: true when a Body-mode CSV gave some recipient text different from the typed body
  variables:  { values, perRecipient } | null, // values: { "1": "Sarah", ... } shared across recipients
  media:      { urls, perRecipient } | null,   // the template's media entries with shared variables filled in
  recipients: { source, fileName, count },     // source: 'typed' | 'csv' | null (null when the browser did not say)
  fallbackToSms: boolean | null,               // bulk only
}
```

### Facts the server overrides

| Field | Bulk (`send-bulk.js`) | Classic (`send-messages.js`) |
| --- | --- | --- |
| `template.sid` | `event.contentSid` | `messages[0].contentSid` |
| `message.body` | `event.body` unless per-recipient | not stored — read from `messages[0]`; only `perRecipient` is stored |
| `variables.values` | browser value | not stored — read from `messages[0].contentVariables`; only `perRecipient` is stored |
| `recipients.count` | `recipientCount` | `messages.length` |
| `fallbackToSms` | `Boolean(event.fallbackToSms)` | `null` |

Classic omits body and variables because `messages[0]` already holds them, and a classic doc already sits close to Sync's 16 KiB ceiling (see `2026-09-02-sync-storage-ceiling-design.md`). Duplicating them would cost recipients of headroom.

### Size limits

Every string is trimmed and capped; anything that is not a string is dropped.

| Value | Cap |
| --- | --- |
| Sender label, template name, file name | 120 chars |
| Language | 16 chars |
| Body | 500 chars |
| Variables | 10 keys; key 40 chars, value 100 chars |
| Media | 3 URLs, 300 chars each |

After capping, the serialised `details` must fit in **2 KiB**. If it does not, media is dropped, then variables, then body, then the labels (sender, template name, file name), in that order. With the labels gone only facts remain, which always fit. A classic doc's checkpoint write rewrites the whole doc, so an oversized `details` would raise the chance of a checkpoint overflow — which today causes duplicate sends.

## Components

### `assets/campaign-details.private.js` (new)

Pure functions, no Twilio calls. Required as `Runtime.getAssets()['/campaign-details.js'].path`.

- `buildDetails(input, facts)` — sanitises the browser's `input`, applies `facts` over it, enforces the 2 KiB budget. Used by both send functions.
- `resolveDetails(campaignData)` — the display shape for one campaign doc. Merges stored `details` with doc fields (`channel`, `from`, `mode`, `scheduledFor`, `operationIds`, `messages[0]`). Handles docs with no `details`:
  - **Classic, new or old:** a `perRecipient` flag wins over `messages[0]`, which holds only the first row's values.
  - **Old classic:** sender from `from` (kind `service` when it matches `MG` + 32 hex, else `direct`), template SID, body and variables from `messages[0]`.
  - **Old bulk:** sender from `from`; template and message marked `notRecorded: true`.
- `summaryLine(campaignData)` — `{ channel, sender, template }` strings for the campaign card.

Unit tests in `test/campaign-details.test.js`.

### Functions

- `send-bulk.js` — store `details: buildDetails(event.details, facts)` on create.
- `send-messages.js` — same, on create only. An existing doc is never touched.
- `check-status.js` — add `details: resolveDetails(campaignData)` and `mode: 'classic'` to the response.
- `check-bulk-status.js` — add `details: resolveDetails(campaignData)` to the response.
- `list-campaigns.js` — add `summary: summaryLine(campaignData)` to each campaign, both modes.

### Browser (`assets/app.js`)

- `renderSenderOptions` — tag each option with `data-kind` so the sender kind can be recorded.
- `collectCampaignDetails()` (new) — reads the form at send time: selected sender text and kind (or `typed`), selected template's name and language, CSV state and file name, shared variables, the template's media entries with shared variables substituted. A media entry whose variable comes from the CSV is recorded as per-recipient rather than as a URL.
- `sendBulkCampaign`, `sendMessagesBatch` — send `details` with the request.
- `displayCampaigns` — one line under each card header: `WhatsApp · Acme Service · MG1a2b… · promo_v2`. Missing parts are skipped. The render signature includes it.
- `displayMessageDetails` — a "Campaign details" block above the totals, also shown in the empty-state branch. The render signature includes `details`.
- For an old campaign whose template has only a SID, the name is filled from `loadedTemplates` when that template is in the list.

## Display

Rows in the "Campaign details" block. A row with no value is hidden.

| Row | Value |
| --- | --- |
| API | Programmable Messaging / Bulk Messaging |
| Channel | SMS, MMS, RCS, WhatsApp, Facebook Messenger |
| Sender | label, then kind: "Messaging Service", "Sender pool", "Typed sender" |
| Template | name (language) and SID; "Not recorded" for old bulk |
| Message | body, full text on hover; "Per-recipient text from CSV"; "Not recorded" for old bulk |
| Variables | `{{1}} Sarah · {{2}} 10am`; "Per-recipient from CSV" |
| Media | one link per URL |
| Recipients | "CSV spring.csv · 120" or "Typed · 120" |
| Scheduled | local date and time (bulk, only when scheduled) |
| SMS fallback | On / Off (bulk WhatsApp only) |
| Operations | operation IDs, monospace (bulk) |

Every value passes through `escapeHtml`. A media URL becomes a link only when it starts with `http://` or `https://`; otherwise it is shown as text. Links open with `target="_blank" rel="noopener noreferrer"`.

## Error handling

- `details` missing or malformed in the request: `buildDetails` returns facts only. The send is never rejected for bad display data.
- `details` over budget after dropping media, variables and body: stored without them; the send proceeds.
- A doc with no `details` (sent before this change): `resolveDetails` derives what it can, as above.

## Testing

- `test/campaign-details.test.js`: caps, dropping non-strings, facts overriding input, the 2 KiB drop order, `resolveDetails` for new bulk, new classic, old classic and old bulk docs, `summaryLine`.
- `npm test` passes.
- Manual: send one classic and one bulk campaign with a template and a CSV; open each; confirm the card line and the details block. Open a campaign sent before the change; confirm the fallbacks.

## Out of scope

- CSV export columns.
- Editing details after send.
- Backfilling `details` into existing docs.
