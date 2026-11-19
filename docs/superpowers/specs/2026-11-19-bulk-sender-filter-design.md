# Bulk sender dropdown: offer only Bulk API Senders

**Date:** 2026-11-19
**Status:** Approved, not implemented
**Applies to:** Bulk Messaging mode, SMS and MMS channels only. Classic mode is unchanged.

## Problem

In bulk mode the sender dropdown lists every phone number on the account that is SMS-capable (or MMS-capable for MMS). The Bulk API accepts only addresses that have an `ACTIVATED` Sender on the matching channel, and rejects every other number at send time with `from address must be a valid sender: <number>`.

On the test account on 2026-11-19, the API had 21 `ACTIVATED` SMS Senders. Only three of the account's 11 US numbers were among them, all toll-free. The 8 US local numbers were not, most likely because they lack A2P 10DLC registration. That cause is inferred: the docs only say `ACTIVATED` means "approved and compliant". The dropdown offered all 8 anyway.

WhatsApp and RCS are out of scope:

- **WhatsApp:** the list the dropdown uses (`/v2/Channels/Senders`, `ONLINE` only) already matches the Bulk API's WhatsApp Senders.
- **RCS:** the gap runs the other way. The Bulk API lists 3 `ACTIVATED` RCS Senders, but `/v2/Channels/Senders` marks them `DRAFT`, so the dropdown offers none. That needs a separate decision.

## Decision

In bulk mode, for SMS and MMS, a number is offered only if it is capable for the channel **and** has an `ACTIVATED` SMS Sender. MMS uses SMS Senders, because the API has no MMS sender channel (see `CHANNEL_MAP` in `assets/bulk-payload.private.js`).

## Components

### `listSenders(authString, channel, retryOptions)` in `assets/twilio-comms.private.js`

- Calls `GET /v1/Senders?channel=<channel>&status=ACTIVATED&pageSize=100`. The server-side filters were checked against the live API: `channel=SMS&status=ACTIVATED` returned exactly the 21 SMS Senders.
- Follows `pagination.next` until it is null. A `next` that names a host other than `comms.twilio.com` is not followed, so credentials never go anywhere else.
- Wrapped in `withRateLimitRetry`, like the other calls in that module.
- Returns the raw Sender objects, or `[]` when the body has no `senders` array.

### `filterToBulkSenders(numbers, senders)` in a new `assets/bulk-senders.private.js`

A pure function, so it can be unit-tested without a Function runtime.

- `numbers`: sender options already built by `get-phone-numbers.js` (`{ value, label, status, kind }`).
- `senders`: the Sender objects from `listSenders`.
- Returns `{ kept, notBulkSenders }`. `kept` holds the options whose `value` equals some Sender's `address`. `notBulkSenders` is the count dropped.
- Addresses are compared as E.164 strings, exactly as both APIs return them.

### `functions/get-phone-numbers.js`

- Bulk mode with `sms` or `mms`: run `comms.listSenders(authString, 'SMS')` concurrently with the phone number and sender pool lookups, to keep inside the 10-second Function budget.
- Filter the capable numbers through `filterToBulkSenders`. `totalRegistered` becomes the filtered count, so the existing "N not online" text never counts numbers that were dropped for this reason.
- Add `notBulkSenders` (a count) to the response. It is present only in bulk mode for SMS and MMS.
- If `listSenders` throws, log it, offer the unfiltered list, and set `senderListFailed: true`. This mirrors `poolListFailed`: a lookup failure must not hide every phone number, and the Bulk API still rejects a bad sender at send time with a clear message.

### `assets/app.js`, `renderSenderOptions`

- When `notBulkSenders > 0`, append ` · N not Bulk API senders` to the help text.
- When the list is empty and `notBulkSenders > 0`, the option and help text read: `No phone numbers are Bulk API senders — N on this account are not. US local numbers need A2P 10DLC registration; toll-free numbers need verification.` This replaces the "registered but not online" text, which would be wrong here.
- When `senderListFailed` is set, append a warning like the pool one: ` Bulk API sender list could not be loaded — some numbers above may be rejected at send time.`

## Error handling

| Case | Result |
| --- | --- |
| Senders lookup succeeds | Only Bulk API Senders offered; the dropped count is shown |
| Senders lookup fails (after 429 retries) | Unfiltered list, plus a warning |
| No capable number is a Sender | Empty dropdown with the A2P/toll-free hint |
| Classic mode, or WhatsApp/RCS/Messenger | Unchanged; `listSenders` is not called |

## Testing

- `test/twilio-comms.test.js`: `listSenders` sends `channel` and `status=ACTIVATED`, follows `pagination.next`, refuses a `next` on another host, tolerates a body with no `senders` array, and retries a 429.
- `test/bulk-senders.test.js`: `filterToBulkSenders` keeps matches in their original order, counts what it drops, and handles empty inputs.
- After deploy: in the dev UI, bulk mode, SMS, the dropdown offers no US local number, and the help text's "not Bulk API senders" count equals the capable numbers dropped. Expected values are worked out from `/v1/Senders` and the account's numbers just before the check.
