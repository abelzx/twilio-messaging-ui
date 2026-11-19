# RCS sender dropdown: offer DRAFT agents, and check bulk RCS against Bulk API Senders

**Date:** 2026-11-19
**Status:** Approved, not implemented
**Applies to:** the RCS channel in both send modes. WhatsApp, SMS and MMS are unchanged except where noted.

## Problem

The RCS dropdown offers only agents whose `/v2/Channels/Senders` status is `ONLINE`. On the test account all 3 RCS agents are `DRAFT`, so the dropdown is empty in both modes. However:

- `rcs:tmo_qsvqcst9_agent` (Twilio Singapore, `DRAFT`) delivered 5 messages on 2026-11-16 to +6580998266, all reaching `read`. They went through Messaging Service `MG7451c39487fea26748acb301f526a483`.
- The Bulk API lists all 3 agents as `ACTIVATED` RCS Senders.
- Twilio's docs (errors 63035 and 63106) say an agent without carrier approval can send to test devices that accepted the tester invitation. Every other recipient fails with 63035.

Sending directly from `rcs:<agent>` is documented for Programmable Messaging. No direct send from a `DRAFT` agent has been tried, and neither has a Bulk API send from one.

## Decision

1. **Both modes.** An RCS agent is offered when its status is `ONLINE` or `DRAFT`. A `DRAFT` agent's label ends in ` · test devices only`. Every other status stays hidden and counts toward "N not online". WhatsApp still offers only `ONLINE` senders.
2. **Bulk mode.** RCS agents are also checked against `ACTIVATED` Bulk API Senders, in the same way as SMS and MMS (see `2026-11-19-bulk-sender-filter-design.md`). The Sender channel comes from `CHANNEL_MAP` in `assets/bulk-payload.private.js`: `sms` and `mms` use `SMS`, and `rcs` uses `RCS`. WhatsApp is not checked, because its `ONLINE` senders already match the Bulk API's list.
3. **Matching.** `filterToBulkSenders` ignores a channel prefix on both sides. `/v2/Channels/Senders` gives `rcs:tmo_qsvqcst9_agent`, but the Bulk API gives `tmo_qsvqcst9_agent`. Phone numbers have no prefix, so their matching is unchanged.
4. **Empty-list hint.** The A2P 10DLC and toll-free sentence is shown for SMS and MMS only. RCS shows only `None of this account's N RCS agents is a Bulk API sender.`
5. **Lookup-failure warning.** The text becomes ` Bulk API sender list could not be loaded — some senders above may be rejected at send time.` It says "senders" instead of "numbers" because RCS agents are not numbers.

## Risk

A `DRAFT` agent sending to a recipient that is not a test device fails with 63035. The label is the only warning; the send is not blocked.

## Components

- `functions/get-phone-numbers.js`: the status filter and label for RCS; the Bulk Sender check extended to `rcs`, with its channel taken from `CHANNEL_MAP`.
- `assets/bulk-senders.private.js`: prefix-insensitive matching.
- `assets/app.js`: the hint is shown for SMS and MMS only; the warning wording.
- `README.md`: the RCS row of the channel table, and the bulk note naming RCS.

## Testing

- `test/bulk-senders.test.js`: an `rcs:` option matches a bare Bulk API address, and an unmatched agent is counted.
- A one-off driver with fake APIs covers classic RCS (ONLINE and DRAFT offered with labels, OFFLINE hidden), bulk RCS (gated by Senders), a failed lookup, and WhatsApp (ONLINE only, unchanged).
- After deploy, the dev UI shows all 3 agents in both modes, each labelled `test devices only`.
