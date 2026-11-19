# Bulk Sender Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In bulk mode, the SMS and MMS sender dropdown offers only numbers that have an `ACTIVATED` Bulk API Sender.

**Architecture:** `twilio-comms.private.js` gains `listSenders`, which pages through `GET /v1/Senders`. A new pure asset, `bulk-senders.private.js`, intersects the capable numbers with those Senders. `get-phone-numbers.js` runs the lookup alongside its others and reports what was dropped, and `app.js` puts that count in the help text.

**Tech Stack:** Twilio Serverless (Node 24), raw `fetch` to comms.twilio.com, `node:test`, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-11-19-bulk-sender-filter-design.md`

## Global Constraints

- Bulk mode with `sms` or `mms` only. Classic mode, WhatsApp, RCS and Messenger are unchanged, and `listSenders` is not called for them.
- MMS uses SMS Senders: `listSenders(authString, 'SMS')` for both channels.
- Query: `channel=<channel>&status=ACTIVATED&pageSize=1000`. `pagination.next` is a page token sent back as `pageToken`. At most 10 pages.
- A failed Senders lookup offers the unfiltered list and sets `senderListFailed: true`. It never empties the list.
- New response fields `notBulkSenders` and `senderListFailed` are present only in bulk mode for `sms` and `mms`.
- Help text strings, verbatim:
  - ` · N not Bulk API sender(s)`
  - Option: `No <noun>s are Bulk API senders`
  - Help: `None of this account's N <noun>s is a Bulk API sender.` (or `This account's one <noun> is not a Bulk API sender.`) followed by ` US local numbers may need A2P 10DLC registration, and toll-free numbers verification.`
  - Warning: ` Bulk API sender list could not be loaded — some numbers above may be rejected at send time.`
- Tests run with `npm test` (`node --test test/*.js`). There is no test harness for Functions or `app.js`; those are checked after deploy.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Files

- Modify `assets/twilio-comms.private.js`: add `listSenders` and export it.
- Modify `test/twilio-comms.test.js`: `listSenders` tests.
- Create `assets/bulk-senders.private.js`: `filterToBulkSenders`.
- Create `test/bulk-senders.test.js`.
- Modify `functions/get-phone-numbers.js`: the lookup, the filter, two response fields.
- Modify `assets/app.js` (`renderSenderOptions`): help text and empty-list text.
- Modify `README.md`: bulk sender note, troubleshooting entry, file tree.

---

### Task 1: `listSenders` in the comms client

**Files:**
- Modify: `assets/twilio-comms.private.js` (insert after `listSenderPools`, before `module.exports`; update `module.exports`)
- Test: `test/twilio-comms.test.js` (append at end)

**Interfaces:**
- Produces: `comms.listSenders(authString: string, channel: 'SMS'|'RCS'|'WHATSAPP', retryOptions?) => Promise<Array<{ id, address, channel, status, ... }>>`

- [ ] **Step 1: Write the failing tests**

Append to `test/twilio-comms.test.js`:

```js
test('lists ACTIVATED senders on one channel at the maximum page size', async (t) => {
  const sender = { address: '+18665550100', channel: 'SMS', status: 'ACTIVATED' };
  const calls = stubFetch(t, () => jsonResponse(200, { senders: [sender], pagination: { next: null } }));

  const senders = await comms.listSenders(AUTH, 'SMS');

  const url = new URL(calls[0].url);
  assert.strictEqual(url.pathname, '/v1/Senders');
  assert.strictEqual(url.searchParams.get('channel'), 'SMS');
  assert.strictEqual(url.searchParams.get('status'), 'ACTIVATED');
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.strictEqual(url.searchParams.has('pageToken'), false);
  assert.deepStrictEqual(senders, [sender]);
});

test('follows pagination.next as a pageToken until it runs out', async (t) => {
  const pages = {
    '': { senders: [{ address: '+1' }], pagination: { next: 'tok2' } },
    tok2: { senders: [{ address: '+2' }], pagination: { next: 'tok3' } },
    tok3: { senders: [{ address: '+3' }], pagination: { next: null } },
  };
  const calls = stubFetch(t, (url) =>
    jsonResponse(200, pages[new URL(url).searchParams.get('pageToken') || ''])
  );

  const senders = await comms.listSenders(AUTH, 'SMS');

  assert.deepStrictEqual(senders.map((s) => s.address), ['+1', '+2', '+3']);
  assert.strictEqual(calls.length, 3);
});

test('stops after 10 pages of senders', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(200, { senders: [{ address: '+1' }], pagination: { next: 'more' } })
  );

  const senders = await comms.listSenders(AUTH, 'SMS');

  assert.strictEqual(calls.length, 10);
  assert.strictEqual(senders.length, 10);
});

test('returns an empty array when the body has no senders array', async (t) => {
  stubFetch(t, () => jsonResponse(200, {}));

  assert.deepStrictEqual(await comms.listSenders(AUTH, 'SMS'), []);
});

test('retries a 429 while listing senders', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(429, { code: 20429, message: 'Too Many Requests' })
      : jsonResponse(200, { senders: [{ address: '+1' }] });
  });

  const senders = await comms.listSenders(AUTH, 'SMS', { baseDelay: 1 });

  assert.strictEqual(attempts, 2);
  assert.strictEqual(senders.length, 1);
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `node --test test/twilio-comms.test.js`
Expected: the 5 new tests FAIL with `TypeError: comms.listSenders is not a function`.

- [ ] **Step 3: Implement `listSenders`**

Insert in `assets/twilio-comms.private.js` after `listSenderPools`:

```js
/** The API's maximum: 1001 is rejected with "must be less than or equal to 1000". */
const SENDER_PAGE_SIZE = 1000;

/** Bounds the lookup inside the Function budget: 10,000 Senders is far past any real account. */
const MAX_SENDER_PAGES = 10;

/**
 * Senders on one channel that the Bulk API will send from now.
 *
 * Only an address with an ACTIVATED Sender is accepted as `from`; any other
 * number is rejected at send time with "from address must be a valid sender",
 * even when it is SMS- and MMS-capable. `pagination.next` is an opaque page
 * token, not a URL, and goes back as `pageToken`.
 */
async function listSenders(authString, channel, retryOptions) {
  const senders = [];
  let pageToken;
  for (let page = 0; page < MAX_SENDER_PAGES; page += 1) {
    const response = await withRateLimitRetry(
      () =>
        request(authString, 'GET', '/Senders', {
          query: { channel, status: 'ACTIVATED', pageSize: SENDER_PAGE_SIZE, pageToken },
        }),
      retryOptions
    );
    const body = await response.json();
    if (Array.isArray(body.senders)) senders.push(...body.senders);
    pageToken = body.pagination && body.pagination.next;
    if (!pageToken) break;
  }
  return senders;
}
```

Replace the export line with:

```js
module.exports = { createMessages, fetchOperation, listMessages, listSenderPools, listSenders, BASE_URL };
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node --test test/twilio-comms.test.js`
Expected: all tests PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add assets/twilio-comms.private.js test/twilio-comms.test.js
git commit -m "feat: list the Bulk API Senders that can send on a channel" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `filterToBulkSenders`

**Files:**
- Create: `assets/bulk-senders.private.js`
- Test: `test/bulk-senders.test.js`

**Interfaces:**
- Consumes: Sender objects as returned by `comms.listSenders` (only `address` is read).
- Produces: `filterToBulkSenders(options: Array<{ value, label, status, kind }>, senders: Array<{ address }>) => { kept: Array<option>, notBulkSenders: number }`. Required in Functions as `require(Runtime.getAssets()['/bulk-senders.js'].path)`.

- [ ] **Step 1: Write the failing tests**

Create `test/bulk-senders.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { filterToBulkSenders } = require('../assets/bulk-senders.private.js');

/** A dropdown option as get-phone-numbers.js builds it for a phone number. */
const option = (value) => ({ value, label: value, status: 'ONLINE', kind: 'direct' });

test('keeps only numbers that have a Bulk API Sender, in their original order', () => {
  const result = filterToBulkSenders(
    [option('+14452568672'), option('+18666942466'), option('+18336055607')],
    [{ address: '+18336055607' }, { address: '+18666942466' }]
  );

  assert.deepStrictEqual(result, {
    kept: [option('+18666942466'), option('+18336055607')],
    notBulkSenders: 1,
  });
});

test('drops every number when the account has no Bulk API Senders', () => {
  const result = filterToBulkSenders([option('+14452568672'), option('+14706646645')], []);

  assert.deepStrictEqual(result, { kept: [], notBulkSenders: 2 });
});

test('ignores Senders that carry no address', () => {
  const result = filterToBulkSenders([option('+18666942466')], [{ id: 'comms_sender_x' }, null]);

  assert.deepStrictEqual(result, { kept: [], notBulkSenders: 1 });
});

test('returns nothing kept and nothing dropped for an account with no numbers', () => {
  assert.deepStrictEqual(filterToBulkSenders([], [{ address: '+18666942466' }]), {
    kept: [],
    notBulkSenders: 0,
  });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `node --test test/bulk-senders.test.js`
Expected: FAIL with `Cannot find module '../assets/bulk-senders.private.js'`.

- [ ] **Step 3: Implement the module**

Create `assets/bulk-senders.private.js`:

```js
/**
 * Narrows the bulk sender dropdown to numbers the Bulk API will send from.
 *
 * A number can be SMS- and MMS-capable and still have no ACTIVATED Sender, in
 * which case the Bulk API rejects it at send time with "from address must be a
 * valid sender". On the test account on 2026-11-19, none of the 8 US local
 * numbers had one; only the toll-free numbers did.
 *
 * Both lists hold E.164 strings exactly as their APIs return them, so they are
 * compared as-is.
 *
 * This is a *private* asset. Require it as:
 *
 *   const { filterToBulkSenders } = require(Runtime.getAssets()['/bulk-senders.js'].path);
 */

'use strict';

/**
 * Returns the options whose number has a Sender, in their original order, and
 * how many were dropped, so the dropdown can say why they are missing.
 */
function filterToBulkSenders(options, senders) {
  const addresses = new Set(senders.map((sender) => sender && sender.address).filter(Boolean));
  const kept = options.filter((option) => addresses.has(option.value));
  return { kept, notBulkSenders: options.length - kept.length };
}

module.exports = { filterToBulkSenders };
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node --test test/bulk-senders.test.js`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/bulk-senders.private.js test/bulk-senders.test.js
git commit -m "feat: match sender options against Bulk API Senders" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the filter into the sender list, UI and README

**Files:**
- Modify: `functions/get-phone-numbers.js`
- Modify: `assets/app.js` (`renderSenderOptions`, around lines 882-970)
- Modify: `README.md` (line 129, line 160 file tree, after line 209)

**Interfaces:**
- Consumes: `comms.listSenders` (Task 1), `filterToBulkSenders` (Task 2).
- Produces: response fields `notBulkSenders: number` and `senderListFailed: boolean`, present only when `mode === 'bulk'` and `channel` is `sms` or `mms`.

- [ ] **Step 1: Require the new asset in `functions/get-phone-numbers.js`**

After the `comms` require line, add:

```js
const { filterToBulkSenders } = require(Runtime.getAssets()['/bulk-senders.js'].path);
```

- [ ] **Step 2: Start the Senders lookup alongside the others**

Directly after the `secondaryPromise` statement (it ends with the Messaging Services `.then(...)` and `);`), add:

```js
    // The Bulk API sends only from an address with an ACTIVATED Sender and
    // rejects any other number at send time, however capable it is. MMS sends
    // from an SMS Sender: the API has no MMS sender channel. Run alongside the
    // other lookups for the same 10s budget reason. A failed lookup leaves the
    // list unfiltered rather than empty, and `senderListFailed` says so.
    const checksBulkSenders = mode === 'bulk' && (channel === 'sms' || channel === 'mms');
    let senderListFailed = false;
    const bulkSendersPromise = checksBulkSenders
      ? comms.listSenders(authString, 'SMS').catch((error) => {
          console.error('Bulk sender list failed:', error.message);
          senderListFailed = true;
          return null;
        })
      : Promise.resolve(null);
```

- [ ] **Step 3: Apply the filter after the lookups settle**

Replace:

```js
    const [direct, serviceSenders] = await Promise.all([directPromise, secondaryPromise]);
```

with:

```js
    const [listed, serviceSenders, bulkSenders] = await Promise.all([
      directPromise,
      secondaryPromise,
      bulkSendersPromise,
    ]);

    // `total` becomes the filtered count, so the "not online" figure never
    // counts a number dropped for having no Sender; `notBulkSenders` does that.
    let direct = listed;
    let notBulkSenders = 0;
    if (bulkSenders) {
      const filtered = filterToBulkSenders(listed.senders, bulkSenders);
      direct = { total: filtered.kept.length, senders: filtered.kept };
      notBulkSenders = filtered.notBulkSenders;
    }
```

- [ ] **Step 4: Add the two response fields**

In `response.setBody({...})`, directly after the `...(mode === 'bulk' ? { poolListFailed } : {}),` line, add:

```js
      // Bulk SMS and MMS only: how many capable numbers were left out for
      // having no Bulk API Sender, and whether that lookup failed.
      ...(checksBulkSenders ? { notBulkSenders, senderListFailed } : {}),
```

- [ ] **Step 5: Update `renderSenderOptions` in `assets/app.js`**

Replace:

```js
    const poolWarning = data.poolListFailed
        ? ' Sender pool list could not be loaded — any pools on this account are missing from the list above.'
        : '';
```

with:

```js
    const poolWarning = data.poolListFailed
        ? ' Sender pool list could not be loaded — any pools on this account are missing from the list above.'
        : '';
    // Set only in bulk mode for SMS and MMS, when the Bulk API's Sender list
    // could not be read and the numbers above are therefore unfiltered.
    const senderListWarning = data.senderListFailed
        ? ' Bulk API sender list could not be loaded — some numbers above may be rejected at send time.'
        : '';
    const warnings = poolWarning + senderListWarning;
    // Capable numbers with no Bulk API Sender, which the Bulk API would reject.
    const notBulk = data.notBulkSenders || 0;
```

Replace the empty-list block:

```js
    if (!senders.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        // Distinguish "none exist" from "some exist but none usable" — the
        // second is a fixable configuration problem and should say so. Now that
        // Messaging Services are offered on every channel, "none" also means no
        // services exist on the account.
        opt.textContent = data.totalRegistered
            ? `No usable ${noun}s — ${data.totalRegistered} registered but not online`
            : `No ${noun}s or Messaging Services registered on this account`;
        select.appendChild(opt);
        setSenderHelp(opt.textContent + poolWarning, true);
        return;
    }
```

with:

```js
    if (!senders.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        let help;
        if (notBulk > 0) {
            // Every capable number was dropped for having no Bulk API Sender,
            // so "registered but not online" would be wrong here.
            opt.textContent = `No ${noun}s are Bulk API senders`;
            help = (notBulk === 1
                ? `This account's one ${noun} is not a Bulk API sender.`
                : `None of this account's ${notBulk} ${noun}s is a Bulk API sender.`)
                + ' US local numbers may need A2P 10DLC registration, and toll-free numbers verification.';
        } else {
            // Distinguish "none exist" from "some exist but none usable" — the
            // second is a fixable configuration problem and should say so. Now that
            // Messaging Services are offered on every channel, "none" also means no
            // services exist on the account.
            opt.textContent = data.totalRegistered
                ? `No usable ${noun}s — ${data.totalRegistered} registered but not online`
                : `No ${noun}s or Messaging Services registered on this account`;
            help = opt.textContent;
        }
        select.appendChild(opt);
        setSenderHelp(help + warnings, true);
        return;
    }
```

Replace the end of the function:

```js
    if (pools.length) parts.push(`${pools.length} sender pool${pools.length === 1 ? '' : 's'}`);
    const hidden = (data.totalRegistered || 0) - (data.directCount || 0);
    setSenderHelp(
        parts.join(' · ') + (hidden > 0 ? ` · ${hidden} not online` : '') + poolWarning,
        Boolean(data.poolListFailed)
    );
```

with:

```js
    if (pools.length) parts.push(`${pools.length} sender pool${pools.length === 1 ? '' : 's'}`);
    if (notBulk > 0) parts.push(`${notBulk} not Bulk API sender${notBulk === 1 ? '' : 's'}`);
    const hidden = (data.totalRegistered || 0) - (data.directCount || 0);
    setSenderHelp(
        parts.join(' · ') + (hidden > 0 ? ` · ${hidden} not online` : '') + warnings,
        Boolean(data.poolListFailed || data.senderListFailed)
    );
```

- [ ] **Step 6: Update `README.md`**

Replace line 129:

```markdown
This table describes what Programmable Messaging supports. Bulk Messaging mode offers the same four channels except Facebook Messenger, and cannot take a Messaging Service as the sender — see [Two sending APIs](#two-sending-apis).
```

with:

```markdown
This table describes what Programmable Messaging supports. Bulk Messaging mode offers the same four channels except Facebook Messenger, and cannot take a Messaging Service as the sender — see [Two sending APIs](#two-sending-apis). For SMS and MMS, bulk mode offers only numbers with an active Bulk API Sender (`GET /v1/Senders`), and the help text under the dropdown counts the numbers left out.
```

In the file tree, after the `bulk-payload.private.js` line, add:

```
  bulk-senders.private.js   Which numbers the Bulk API will send from
```

After the `**Bulk mode rejects the sender.**` paragraph, add:

```markdown
**Bulk mode says "from address must be a valid sender".** The Bulk API sends only from numbers with an `ACTIVATED` Sender, and a number can be SMS- and MMS-capable without one. US local numbers may need A2P 10DLC registration first, and toll-free numbers need verification. The sender dropdown leaves such numbers out; if it could not check, its help text says so.
```

- [ ] **Step 7: Run the full suite and a syntax check**

Run: `npm test && node --check functions/get-phone-numbers.js && node --check assets/app.js`
Expected: all tests PASS, 0 fail; both `--check` commands print nothing.

- [ ] **Step 8: Commit**

```bash
git add functions/get-phone-numbers.js assets/app.js README.md
git commit -m "feat: offer only Bulk API Senders in the bulk SMS and MMS sender list" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Deploy and check live

**Files:** none.

- [ ] **Step 1: Confirm the environment has no variables a deploy would remove**

Run: `npx twilio api:serverless:v1:services:environments:variables:list --service-sid ZSb34b1c5e48d1ba966735c9bdf0ac6ac4 --environment-sid ZE73f6bcab402752df22cbe74cc471db9d -p Abel`
Expected: `No results`.

- [ ] **Step 2: Deploy**

Run: `npm run deploy -- -p Abel`
Expected: a new `buildSid`, and `private /bulk-senders.js` in the asset list.

- [ ] **Step 3: Smoke check**

POST `{}` to each Function and expect 400 (not 500). `get-content-templates` returns 200 with an empty list when there is no channel. `/bulk-senders.js` and `/bulk-payload.js` return 403.

- [ ] **Step 4: Work out the expected dropdown**

List `/v1/Senders?channel=SMS&status=ACTIVATED` and the account's MMS-capable and SMS-capable numbers with the `Abel` profile. The expected kept list is their intersection, and the expected "not Bulk API senders" count is the rest.

- [ ] **Step 5: Hand the UI check to the user**

The Functions take OAuth credentials that only the browser holds. The user opens the dev UI in bulk mode on SMS and MMS and compares the dropdown and help text with Step 4.
