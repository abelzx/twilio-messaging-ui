# RCS DRAFT Senders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer `DRAFT` RCS agents (labelled `test devices only`) in both modes, and check bulk RCS against `ACTIVATED` Bulk API Senders.

**Architecture:** `get-phone-numbers.js` widens its RCS status filter and labels `DRAFT` agents. Its Bulk Sender check, added for SMS and MMS, now also covers `rcs` and takes its channel from `CHANNEL_MAP`. `filterToBulkSenders` ignores channel prefixes, so `rcs:<agent>` matches `<agent>`.

**Tech Stack:** Twilio Serverless (Node 24), `node:test`, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-11-19-rcs-draft-senders-design.md`

## Global Constraints

- RCS statuses offered: `ONLINE` and `DRAFT`. WhatsApp: `ONLINE` only.
- `DRAFT` label suffix, verbatim: ` · test devices only`.
- Bulk Sender check channels: `sms`, `mms`, `rcs`. The Sender channel is `CHANNEL_MAP[channel].from`.
- Warning text, verbatim: ` Bulk API sender list could not be loaded — some senders above may be rejected at send time.`
- The A2P hint is shown for `sms` and `mms` only.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Prefix-insensitive matching

**Files:**
- Modify: `assets/bulk-senders.private.js`
- Test: `test/bulk-senders.test.js`

**Interfaces:**
- Produces: `filterToBulkSenders(options, senders)`, with the same signature and return value as before. A leading `[a-z]+:` is now ignored on `option.value` and on `sender.address`.

- [ ] **Step 1: Write the failing test.** Append to `test/bulk-senders.test.js`:

```js
test('matches an RCS agent whether or not its rcs: prefix is present', () => {
  const agent = { value: 'rcs:tmo_qsvqcst9_agent', label: 'tmo_qsvqcst9_agent', status: 'DRAFT', kind: 'direct' };

  const result = filterToBulkSenders(
    [agent, option('rcs:other_agent')],
    [{ address: 'tmo_qsvqcst9_agent' }]
  );

  assert.deepStrictEqual(result, { kept: [agent], notBulkSenders: 1 });
});
```

- [ ] **Step 2: Run the tests and check that only the new one fails.** Run: `node --test test/bulk-senders.test.js`. Expected: 1 FAIL, with `kept: []` instead of the agent.

- [ ] **Step 3: Implement.** In `assets/bulk-senders.private.js`, replace the "Both lists hold E.164 strings" paragraph with:

```js
 * A channel prefix is ignored on both sides: `/v2/Channels/Senders` gives an
 * RCS agent as `rcs:<agent>`, the Bulk API as bare `<agent>`. Phone numbers
 * carry no prefix in either, so they compare as-is.
```

Then replace the function with:

```js
/** Drops a `rcs:`-style channel prefix; an E.164 number is returned unchanged. */
const bare = (value) => String(value).replace(/^[a-z]+:/, '');

/**
 * Returns the options whose sender has a Bulk API Sender, in their original
 * order, and how many were dropped, so the dropdown can say why they are missing.
 */
function filterToBulkSenders(options, senders) {
  const addresses = new Set(
    senders.map((sender) => sender && sender.address).filter(Boolean).map(bare)
  );
  const kept = options.filter((option) => addresses.has(bare(option.value)));
  return { kept, notBulkSenders: options.length - kept.length };
}
```

- [ ] **Step 4: Run the tests.** Run: `node --test test/bulk-senders.test.js`. Expected: 5 PASS.

- [ ] **Step 5: Commit.** `git add assets/bulk-senders.private.js test/bulk-senders.test.js && git commit -m "feat: match RCS agents to Bulk API Senders across the rcs: prefix"`

---

### Task 2: Offer DRAFT agents, and check bulk RCS

**Files:**
- Modify: `functions/get-phone-numbers.js`, `assets/app.js`, `README.md`

**Interfaces:**
- Consumes: `filterToBulkSenders` (Task 1), `comms.listSenders`, and `CHANNEL_MAP` from `/bulk-payload.js`.
- Produces: `notBulkSenders` and `senderListFailed`, now also present for bulk `rcs`.

- [ ] **Step 1: In `functions/get-phone-numbers.js`, require `CHANNEL_MAP` and name the checked channels.** After the `filterToBulkSenders` require line, add:

```js
const { CHANNEL_MAP } = require(Runtime.getAssets()['/bulk-payload.js'].path);

/**
 * Channels whose bulk senders are checked against ACTIVATED Bulk API Senders.
 * WhatsApp is not: its ONLINE senders already match the Bulk API's list.
 */
const BULK_CHECKED_CHANNELS = new Set(['sms', 'mms', 'rcs']);
```

- [ ] **Step 2: Extend the Bulk Sender check.** Replace the existing comment and the `checksBulkSenders` / `bulkSendersPromise` block with:

```js
    // The Bulk API sends only from an address with an ACTIVATED Sender and
    // rejects any other at send time, however capable it is. CHANNEL_MAP names
    // the Sender channel: MMS sends from an SMS Sender, since the API has no
    // MMS sender channel. Run alongside the other lookups for the same 10s
    // budget reason. A failed lookup leaves the list unfiltered rather than
    // empty, and `senderListFailed` says so.
    const checksBulkSenders = mode === 'bulk' && BULK_CHECKED_CHANNELS.has(channel);
    let senderListFailed = false;
    const bulkSendersPromise = checksBulkSenders
      ? comms.listSenders(authString, CHANNEL_MAP[channel].from).catch((error) => {
          console.error('Bulk sender list failed:', error.message);
          senderListFailed = true;
          return null;
        })
      : Promise.resolve(null);
```

- [ ] **Step 3: Widen the RCS status filter and label DRAFT agents.** In the `channel === 'whatsapp' || channel === 'rcs'` branch, replace the `directPromise = ...` statement with:

```js
      // An RCS agent awaiting carrier approval is DRAFT, and can already send to
      // test devices that accepted the tester invite; any other recipient fails
      // with 63035. So it is offered, labelled to say so. A WhatsApp sender must
      // be ONLINE.
      const offered = (status) => status === 'ONLINE' || (channel === 'rcs' && status === 'DRAFT');
      directPromise = client.messaging.v2.channelsSenders
        .list({ channel, limit: 100 })
        .then((registered) => ({
          total: registered.length,
          senders: registered
            .filter((s) => offered(String(s.status || '').toUpperCase()))
            .map((s) => {
              // senderId already carries the channel prefix (whatsapp:+65…), which
              // is exactly what `from` needs. Do not strip it — the send path's
              // prefixing is idempotent.
              const bare = s.senderId.replace(/^[a-z]+:/, '');
              const name = s.profile && s.profile.name ? `${bare} · ${s.profile.name}` : bare;
              const draft = String(s.status || '').toUpperCase() === 'DRAFT';
              return {
                value: s.senderId,
                label: draft ? `${name} · test devices only` : name,
                status: s.status,
                kind: 'direct',
              };
            }),
        }));
```

- [ ] **Step 4: Update the response-field comment.** Replace `// Bulk SMS and MMS only: how many capable numbers were left out for` and the line after it with:

```js
      // Bulk SMS, MMS and RCS only: how many senders were left out for having
      // no Bulk API Sender, and whether that lookup failed.
```

- [ ] **Step 5: In `assets/app.js`, update the warning and limit the hint to SMS and MMS.** Replace the `senderListWarning` comment and text with:

```js
    // Set only in bulk mode for SMS, MMS and RCS, when the Bulk API's Sender
    // list could not be read and the senders above are therefore unfiltered.
    const senderListWarning = data.senderListFailed
        ? ' Bulk API sender list could not be loaded — some senders above may be rejected at send time.'
        : '';
```

Replace `// Capable numbers with no Bulk API Sender, which the Bulk API would reject.` with `// Senders with no Bulk API Sender, which the Bulk API would reject.`

Replace:

```js
                : `None of this account's ${notBulk} ${noun}s is a Bulk API sender.`)
                + ' US local numbers may need A2P 10DLC registration, and toll-free numbers verification.';
```

with:

```js
                : `None of this account's ${notBulk} ${noun}s is a Bulk API sender.`)
                + (data.channel === 'sms' || data.channel === 'mms'
                    ? ' US local numbers may need A2P 10DLC registration, and toll-free numbers verification.'
                    : '');
```

- [ ] **Step 6: Update `README.md`.** Replace the RCS row `| RCS | RCS agent | text, media, card, carousel, quick-reply |` with:

```markdown
| RCS | RCS agent; one awaiting carrier approval is offered as *test devices only* | text, media, card, carousel, quick-reply |
```

In the bulk note, replace `For SMS and MMS, bulk mode offers only numbers with an active Bulk API Sender` with `For SMS, MMS and RCS, bulk mode offers only senders with an active Bulk API Sender`.

- [ ] **Step 7: Run the suite and syntax checks.** Run: `npm test && node --check functions/get-phone-numbers.js && node --check assets/app.js`. Expected: 0 fail, and no output from `--check`.

- [ ] **Step 8: Drive the Function with fakes.** Run a one-off script outside the repo. It sets fake `Runtime`, `Twilio.Response` and OAuth modules, plus a fake `channelsSenders.list` returning ONLINE, DRAFT and OFFLINE agents, and a fake `fetch` for `/v1/Senders`. Expected:
  - classic rcs offers ONLINE and DRAFT, with DRAFT labelled, and hides OFFLINE
  - bulk rcs offers only agents among the Senders
  - a failed lookup gives the unfiltered list and `senderListFailed: true`
  - whatsapp offers ONLINE only

- [ ] **Step 9: Commit.** `git add functions/get-phone-numbers.js assets/app.js README.md && git commit -m "feat: offer DRAFT RCS agents as test-devices-only, and check bulk RCS against Bulk API Senders"`

---

### Task 3: Deploy and check

- [ ] **Step 1:** Run the environment variables check. Expected: `No results`.
- [ ] **Step 2:** Run `npm run deploy -- -p Abel`.
- [ ] **Step 3:** Smoke check: every Function returns 400 to `{}`, except `get-content-templates`, which returns 200. Private assets return 403.
- [ ] **Step 4:** Ask the user to open the dev UI on RCS in both modes. They should see 3 agents, each labelled `test devices only`.
