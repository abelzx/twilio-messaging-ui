# Bulk Messaging API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Twilio's Bulk Messaging API as a selectable send mode beside the existing Programmable Messaging path, at functional parity plus scheduling, WhatsApp-to-SMS fallback and tags.

**Architecture:** All request-shaping logic lives in one pure module with no I/O (`bulk-payload.private.js`) so it is unit-testable without a Twilio account; all HTTP knowledge lives in one thin client (`twilio-comms.private.js`) because `comms` is absent from the Twilio Node SDK. Two new Functions wire them to the existing OAuth and Sync plumbing. The classic path is not modified behaviourally.

**Tech Stack:** Twilio Serverless Functions and Assets on Node.js 24, `twilio@5.10.6` (OAuth client-credentials only — the Bulk API is called with raw `fetch`), Twilio Sync for campaign state, `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-09-02-bulk-messaging-design.md`

---

## Background you need before starting

Read the spec first. Beyond it, four facts about this codebase that the tasks assume:

1. **Private assets.** A file named `*.private.js` in `assets/` is marked `access: private` by Twilio Serverless and never served over HTTP. Functions require it as `require(Runtime.getAssets()['/name.js'].path)` — note the key **drops** the `.private` segment. Tests require it directly by path, e.g. `require('../assets/bulk-payload.private.js')`.

2. **Every Function takes credentials in its POST body.** `clientId` and `clientSecret` arrive per request and are never stored. `assets/twilio-oauth.private.js` turns them into a client. The runtime credentials (`context.ACCOUNT_SID` / `context.AUTH_TOKEN`) are used for Sync only, never for the user's account.

3. **Errors carry their status.** Helpers throw `Error` objects with a `.statusCode` property, and handlers respond with `error.statusCode || 500`. Follow that convention rather than inventing another.

4. **The Bulk API is Public Beta.** Two request shapes could not be settled from the docs and are verified against a live call in Task 22, deliberately placed before the README task and after everything it could invalidate.

### Vocabulary

| Term | Meaning |
| --- | --- |
| operation | One `POST /v1/Messages`. Returns `202` with an `operationId` header. Covers up to 10,000 recipients. |
| campaign | This app's unit of work. One Sync Document. In bulk mode it holds one *or more* operation IDs. |
| classic mode | The existing Programmable Messaging path. Unchanged by this plan. |

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `assets/bulk-payload.private.js` | Pure mapping from a campaign request to Bulk request JSON. Channel mapping, Liquid escaping, variable shaping, recipient splitting, validation. No I/O, no Twilio SDK. |
| `assets/twilio-comms.private.js` | The only module that knows `comms.twilio.com`: base URL, bearer header, `operationId` extraction, error normalisation, `pagination.next` following. |
| `functions/send-bulk.js` | Builds payloads, POSTs each, records the campaign in Sync. |
| `functions/check-bulk-status.js` | Sums operation stats; pages the per-recipient list on demand. |
| `test/bulk-payload.test.js` | Unit tests for the mapping module. |
| `test/twilio-comms.test.js` | Unit tests for the HTTP client against a stubbed `fetch`. |

**Modify:**

| Path | Change |
| --- | --- |
| `assets/twilio-oauth.private.js` | Add `authenticateWithToken()` exposing the bearer string it already computes; `authenticate()` becomes a wrapper. |
| `functions/get-phone-numbers.js` | Accept `mode: 'bulk'` — drop Messaging Services, add sender pools. |
| `functions/check-status.js` | Branch on `campaignData.mode`, delegating bulk campaigns. |
| `functions/list-campaigns.js` | Report `mode` so history can badge it. |
| `assets/app.js` | Mode toggle, bulk send path, bulk polling, scheduling and fallback controls. |
| `assets/index.html` | Mode toggle, `sendAt` field, fallback checkbox. |
| `assets/styles.css` | Styles for the above. |
| `package.json` | `test` script. |
| `README.md` | Bulk Messaging section and a mode comparison. |

**Delete:** nothing. `functions/webhook.protected.js` stays, serving the classic path.

### Why the logic is split this way

`functions/send-messages.js` is 359 lines mixing auth, Sync access, chunking, channel prefixing and error shaping, and it is hard to hold in your head. Every fiddly rule in this feature — which channel maps to which, when to escape Liquid, how a CSV body becomes a variable, where to split at 10,000 — goes in `bulk-payload.private.js` as a pure function instead. That keeps `send-bulk.js` short enough to read in one sitting and makes the rules testable with no credentials.

The Functions themselves stay thin wiring and are verified manually (Task 22) rather than unit-tested. Testing a handler means stubbing the `Twilio` and `Runtime` globals and intercepting `require('twilio')`, which buys very little when the handler's only job is to call two tested modules in order.

---

## Task 1: Test scaffolding

The repo has no test framework. `node:test` ships with Node 24, so this adds zero dependencies.

**Files:**
- Modify: `package.json`
- Modify: `.twilioignore`
- Create: `test/bulk-payload.test.js`

- [ ] **Step 1: Add the test script**

In `package.json`, add `"test"` to `scripts` so it reads:

```json
  "scripts": {
    "deploy": "twilio serverless:deploy",
    "start": "twilio serverless:start",
    "test": "node --test test/*.js"
  },
```

The glob is load-bearing. `node --test test/` tries to `require()` the directory itself and dies with `MODULE_NOT_FOUND` before loading a single test — verified on Node 22.17.0 and Node 24.20.0. Passing the pattern lets the shell expand it to real files.

- [ ] **Step 2: Keep tests out of the deployment**

Append to `.twilioignore` so the test directory is not uploaded:

```
test/
docs/
```

- [ ] **Step 3: Write a test that fails because the module does not exist**

Create `test/bulk-payload.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const payload = require('../assets/bulk-payload.private.js');

test('the module exports buildPayloads', () => {
  assert.strictEqual(typeof payload.buildPayloads, 'function');
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../assets/bulk-payload.private.js'`

- [ ] **Step 5: Create the module with just enough to pass**

Create `assets/bulk-payload.private.js`:

```js
/**
 * Pure mapping from this app's campaign request to Bulk Messaging API JSON.
 *
 * This is a *private* asset: the `.private.js` suffix makes Twilio Serverless
 * mark it `access: private`, so it is never served over HTTP. Require it as:
 *
 *   const bulk = require(Runtime.getAssets()['/bulk-payload.js'].path);
 *
 * Note the key drops the `.private` segment.
 *
 * Nothing here does I/O, and nothing here requires the Twilio SDK. Every rule
 * that decides what Twilio receives lives in this file so it can be tested
 * without an account.
 */

'use strict';

function buildPayloads() {
  throw new Error('not implemented');
}

module.exports = { buildPayloads };
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test`
Expected: PASS — 1 test, 1 pass

- [ ] **Step 7: Commit**

```bash
git add package.json .twilioignore test/bulk-payload.test.js assets/bulk-payload.private.js
git commit -m "test: add node:test scaffolding for the bulk payload module"
```

---

## Task 2: Channel and sender mapping

**Files:**
- Modify: `assets/bulk-payload.private.js`
- Modify: `test/bulk-payload.test.js`

The four supported channels map a *sender* channel and a *recipient* channel independently. Only WhatsApp differs between the two.

- [ ] **Step 1: Write the failing tests**

Append to `test/bulk-payload.test.js`:

```js
const BASE = {
  channel: 'sms',
  from: '+15017122661',
  body: 'Hello',
  recipients: [{ to: '+15558675310' }],
};

test('maps SMS to a PHONE recipient', () => {
  const [out] = payload.buildPayloads(BASE);
  assert.deepStrictEqual(out.from, { address: '+15017122661', channel: 'SMS' });
  assert.deepStrictEqual(out.to, [{ address: '+15558675310', channel: 'PHONE' }]);
});

test('maps MMS and RCS senders to their own channel, recipients to PHONE', () => {
  const mms = payload.buildPayloads({ ...BASE, channel: 'mms' })[0];
  assert.strictEqual(mms.from.channel, 'MMS');
  assert.strictEqual(mms.to[0].channel, 'PHONE');

  const rcs = payload.buildPayloads({ ...BASE, channel: 'rcs' })[0];
  assert.strictEqual(rcs.from.channel, 'RCS');
  assert.strictEqual(rcs.to[0].channel, 'PHONE');
});

test('maps WhatsApp on both sides and strips the whatsapp: prefix', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    channel: 'whatsapp',
    from: 'whatsapp:+15017122661',
    recipients: [{ to: 'whatsapp:+15558675310' }],
  });
  assert.deepStrictEqual(out.from, { address: '+15017122661', channel: 'WHATSAPP' });
  assert.deepStrictEqual(out.to, [{ address: '+15558675310', channel: 'WHATSAPP' }]);
});

test('rejects a Messaging Service SID as a sender', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, from: 'MG7f6b1c4e9a2d8f0b3c5e7a9d1f2b4c6e' }),
    (err) => err.statusCode === 400 && /Messaging Service/i.test(err.message)
  );
});

test('accepts a sender pool SID as senderPoolId', () => {
  const [out] = payload.buildPayloads({ ...BASE, from: 'SP7f6b1c4e9a2d8f0b3c5e7a9d1f2b4c6e' });
  assert.deepStrictEqual(out.from, { senderPoolId: 'SP7f6b1c4e9a2d8f0b3c5e7a9d1f2b4c6e' });
});

test('rejects an unsupported channel', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, channel: 'messenger' }),
    (err) => err.statusCode === 400 && /messenger/i.test(err.message)
  );
});

test('rejects an empty recipient list', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, recipients: [] }),
    (err) => err.statusCode === 400
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — every new test throws `not implemented`

- [ ] **Step 3: Implement mapping and sender resolution**

Replace the body of `assets/bulk-payload.private.js` below the header comment:

```js
'use strict';

/** Sender channel and recipient channel per app channel. Only WhatsApp differs. */
const CHANNEL_MAP = {
  sms: { from: 'SMS', to: 'PHONE' },
  mms: { from: 'MMS', to: 'PHONE' },
  rcs: { from: 'RCS', to: 'PHONE' },
  whatsapp: { from: 'WHATSAPP', to: 'WHATSAPP' },
};

const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;
const SENDER_POOL_SID = /^SP[0-9a-f]{32}$/i;

/** An Error carrying the HTTP status a handler should respond with. */
function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Strips a channel prefix. `whatsapp:+65…` is a Programmable Messaging
 * convention; here the channel is a field of its own, so the prefix would be
 * read as part of the address.
 */
function bareAddress(value) {
  return String(value == null ? '' : value).trim().replace(/^[a-z]+:/i, '');
}

/**
 * Resolves the `from` object.
 *
 * A Messaging Service is rejected rather than passed through. The Bulk API's
 * `from` accepts an address/channel pair, a `senderId` or a `senderPoolId`, and
 * an MG SID is none of the three — sending it produces a validation error that
 * does not name the real problem.
 */
function resolveSender(from, channelNames) {
  const raw = String(from == null ? '' : from).trim();
  if (!raw) {
    throw httpError(400, 'A sender is required.');
  }
  if (MESSAGING_SERVICE_SID.test(raw)) {
    throw httpError(
      400,
      'A Messaging Service cannot be used as a sender in bulk mode. Choose a phone number or a sender pool, or switch to Programmable Messaging.'
    );
  }
  if (SENDER_POOL_SID.test(raw)) {
    return { senderPoolId: raw };
  }
  return { address: bareAddress(raw), channel: channelNames.from };
}

function buildPayloads(request) {
  const channel = String((request && request.channel) || '').toLowerCase();
  const channelNames = CHANNEL_MAP[channel];
  if (!channelNames) {
    throw httpError(
      400,
      `Bulk Messaging does not support the ${channel || 'selected'} channel. Supported channels: SMS, MMS, RCS, WhatsApp.`
    );
  }

  const recipients = Array.isArray(request.recipients) ? request.recipients : [];
  if (recipients.length === 0) {
    throw httpError(400, 'At least one recipient is required.');
  }

  const from = resolveSender(request.from, channelNames);

  const to = recipients.map((recipient) => ({
    address: bareAddress(recipient.to),
    channel: channelNames.to,
  }));

  return [{ from, to }];
}

module.exports = { buildPayloads, CHANNEL_MAP, bareAddress };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 8 tests. `content` is not asserted yet; Task 3 adds it.

- [ ] **Step 5: Commit**

```bash
git add assets/bulk-payload.private.js test/bulk-payload.test.js
git commit -m "feat: map app channels and senders onto the Bulk API's shape"
```

---

## Task 3: Literal message bodies and Liquid escaping

**Files:**
- Modify: `assets/bulk-payload.private.js`
- Modify: `test/bulk-payload.test.js`

`content.text` is Liquid-templated, so a body containing `{{name}}` would be interpreted and most likely render empty. The classic path sends bodies verbatim, and bulk mode must match — so a literal body is wrapped in `{% raw %}…{% endraw %}`.

One hazard has no Liquid-level fix: a body containing the literal text `{% endraw %}` would close the wrapper early and let the remainder be interpreted. That is rejected rather than mangled.

- [ ] **Step 1: Write the failing tests**

Append to `test/bulk-payload.test.js`:

```js
test('wraps a literal body so Liquid cannot interpret it', () => {
  const [out] = payload.buildPayloads({ ...BASE, body: 'Hi {{name}}, 50% off' });
  assert.deepStrictEqual(out.content, {
    text: '{% raw %}Hi {{name}}, 50% off{% endraw %}',
  });
});

test('wraps a body with no Liquid syntax too, so behaviour does not vary', () => {
  const [out] = payload.buildPayloads({ ...BASE, body: 'Hello' });
  assert.strictEqual(out.content.text, '{% raw %}Hello{% endraw %}');
});

test('rejects a body that would break out of the raw wrapper', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, body: 'a {% endraw %} b' }),
    (err) => err.statusCode === 400 && /endraw/i.test(err.message)
  );
});

test('sends a content template by id with no text', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
  });
  assert.deepStrictEqual(out.content, { contentId: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b' });
});

test('a content template wins over a typed body', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: 'ignored',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
  });
  assert.deepStrictEqual(out.content, { contentId: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b' });
});

test('carries positional template variables per recipient', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [
      { to: '+15558675310', variables: { 1: 'Sarah', 2: '10am' } },
      { to: '+15558675311', variables: { 1: 'Ravi', 2: '2pm' } },
    ],
  });
  assert.deepStrictEqual(out.to, [
    { address: '+15558675310', channel: 'PHONE', variables: { 1: 'Sarah', 2: '10am' } },
    { address: '+15558675311', channel: 'PHONE', variables: { 1: 'Ravi', 2: '2pm' } },
  ]);
});

test('carries named template variables unchanged', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [{ to: '+15558675310', variables: { name: 'Sarah' } }],
  });
  assert.deepStrictEqual(out.to[0].variables, { name: 'Sarah' });
});

test('omits variables entirely when a recipient has none', () => {
  const [out] = payload.buildPayloads(BASE);
  assert.strictEqual('variables' in out.to[0], false);
});

test('sends an empty variable as empty text, not a fallback', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [{ to: '+15558675310', variables: { 1: '' } }],
  });
  assert.deepStrictEqual(out.to[0].variables, { 1: '' });
});

test('rejects a request with neither body nor content template', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, body: '' }),
    (err) => err.statusCode === 400 && /message body|content template/i.test(err.message)
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `out.content` is `undefined`

- [ ] **Step 3: Implement content resolution**

In `assets/bulk-payload.private.js`, add above `buildPayloads`:

```js
const CONTENT_SID = /^HX[0-9a-f]{32}$/i;

/**
 * Wraps text so Liquid renders it verbatim.
 *
 * `content.text` is Liquid-templated, so an unwrapped `{{name}}` in a body typed
 * by a user would be interpreted and almost certainly render empty. The classic
 * path sends bodies literally, and the two modes must not differ on this.
 *
 * `{% endraw %}` in the text would close the wrapper early and expose the rest
 * to interpretation. Liquid offers no way to escape it, so it is refused.
 */
function escapeLiquid(text) {
  const raw = String(text);
  if (/\{%-?\s*endraw\s*-?%\}/.test(raw)) {
    throw httpError(
      400,
      'The message body contains the literal text "{% endraw %}", which cannot be sent safely on this mode. Remove it, or switch to Programmable Messaging.'
    );
  }
  return `{% raw %}${raw}{% endraw %}`;
}

/**
 * Resolves the single `content` object shared by every recipient in the request.
 *
 * Precedence is template, then per-recipient text, then literal body. The middle
 * case is the CSV `Body` column: the Bulk API carries one content object per
 * request, so per-recipient text has no direct equivalent and is routed through
 * a single Liquid variable instead. Liquid substitutes in one pass, so a
 * recipient's own text is not itself re-rendered.
 */
function resolveContent(request, recipients) {
  const contentSid = String(request.contentSid || '').trim();
  if (contentSid) {
    if (!CONTENT_SID.test(contentSid)) {
      throw httpError(400, `"${contentSid}" is not a content template SID.`);
    }
    return { content: { contentId: contentSid }, perRecipientBody: false };
  }

  const body = String(request.body == null ? '' : request.body);
  const anyOwnBody = recipients.some(
    (recipient) => String(recipient.body == null ? '' : recipient.body).trim() !== ''
  );

  if (anyOwnBody) {
    return { content: { text: '{{body}}' }, perRecipientBody: true };
  }

  if (!body.trim()) {
    throw httpError(400, 'A message body or a content template is required.');
  }

  return { content: { text: escapeLiquid(body) }, perRecipientBody: false };
}
```

Then replace `buildPayloads`'s body construction. The recipient loop gains variables, and `content` is attached:

```js
function buildPayloads(request) {
  const channel = String((request && request.channel) || '').toLowerCase();
  const channelNames = CHANNEL_MAP[channel];
  if (!channelNames) {
    throw httpError(
      400,
      `Bulk Messaging does not support the ${channel || 'selected'} channel. Supported channels: SMS, MMS, RCS, WhatsApp.`
    );
  }

  const recipients = Array.isArray(request.recipients) ? request.recipients : [];
  if (recipients.length === 0) {
    throw httpError(400, 'At least one recipient is required.');
  }

  const from = resolveSender(request.from, channelNames);
  const { content, perRecipientBody } = resolveContent(request, recipients);
  const campaignBody = String(request.body == null ? '' : request.body);

  const to = recipients.map((recipient) => {
    const entry = {
      address: bareAddress(recipient.to),
      channel: channelNames.to,
    };

    const variables = { ...(recipient.variables || {}) };

    if (perRecipientBody) {
      // A blank cell falls back to the body typed above, matching the classic
      // path. A blank *variable* does not fall back — see resolveContent.
      const own = String(recipient.body == null ? '' : recipient.body);
      variables.body = own.trim() === '' ? campaignBody : own;
    }

    if (Object.keys(variables).length > 0) {
      entry.variables = variables;
    }

    return entry;
  });

  return [{ from, to, content }];
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 18 tests

- [ ] **Step 5: Commit**

```bash
git add assets/bulk-payload.private.js test/bulk-payload.test.js
git commit -m "feat: resolve bulk content, escaping literal bodies against Liquid"
```

---

## Task 4: Per-recipient bodies from a CSV

**Files:**
- Modify: `test/bulk-payload.test.js`

Task 3's implementation already covers this, but the behaviour is the least obvious thing in the feature and deserves tests that name it directly. This task is tests only — if any fail, the bug is in Task 3's `resolveContent` or recipient loop.

- [ ] **Step 1: Write the tests**

Append to `test/bulk-payload.test.js`:

```js
test('routes per-recipient bodies through a single Liquid variable', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    recipients: [
      { to: '+15558675310', body: 'Your table is at 7pm' },
      { to: '+15558675311', body: 'Your table is at 8pm' },
    ],
  });

  // One content object for the whole request; the text differs per recipient
  // only because each supplies its own `body` variable.
  assert.deepStrictEqual(out.content, { text: '{{body}}' });
  assert.strictEqual(out.to[0].variables.body, 'Your table is at 7pm');
  assert.strictEqual(out.to[1].variables.body, 'Your table is at 8pm');
});

test('a blank per-recipient body falls back to the typed body', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: 'Default message',
    recipients: [
      { to: '+15558675310', body: 'Custom' },
      { to: '+15558675311', body: '   ' },
      { to: '+15558675312' },
    ],
  });
  assert.strictEqual(out.to[0].variables.body, 'Custom');
  assert.strictEqual(out.to[1].variables.body, 'Default message');
  assert.strictEqual(out.to[2].variables.body, 'Default message');
});

test('a per-recipient body is not itself Liquid-escaped', () => {
  // The body arrives as a variable value, and Liquid substitutes in one pass,
  // so `{{` inside it is inert. Wrapping it would send the wrapper as text.
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    recipients: [{ to: '+15558675310', body: 'Literal {{name}} stays' }],
  });
  assert.strictEqual(out.to[0].variables.body, 'Literal {{name}} stays');
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `npm test`
Expected: PASS — 21 tests. These are regression tests for behaviour Task 3 built.

- [ ] **Step 3: Commit**

```bash
git add test/bulk-payload.test.js
git commit -m "test: pin the CSV per-recipient body mapping"
```

> **Every expected test count from here on is 3 lower than reality.** Code review of Tasks 3-4 found that a recipient with neither its own body nor a campaign body to fall back on was sent a *blank message*, where the classic path's `interpretCsv` skips the row (`assets/app.js:1725-1728`). The fix — reject with a 400, since the front end already filters those rows and `send-bulk.js` is a public endpoint — added three tests, taking the total to 24 rather than 21. Add 3 to each count below: Task 5 ends at 34, Task 6 at 38, Task 7 at 44, Task 8 at 50, Task 9 at 56, Task 11 at 58.

---

## Task 5: Media, tags and scheduling

**Files:**
- Modify: `assets/bulk-payload.private.js`
- Modify: `test/bulk-payload.test.js`

Tags cap at 10 pairs, 128-character keys and 256-character values. `sendAt` is passed through as given; Task 22 confirms whether the API wants a string or an array, and this is the one place that would change.

- [ ] **Step 1: Write the failing tests**

Append to `test/bulk-payload.test.js`:

```js
test('attaches media on MMS', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    channel: 'mms',
    mediaUrl: 'https://example.com/a.jpg',
  });
  assert.deepStrictEqual(out.content, {
    text: '{% raw %}Hello{% endraw %}',
    media: ['https://example.com/a.jpg'],
  });
});

test('accepts an array of media URLs', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    channel: 'mms',
    mediaUrl: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
  });
  assert.deepStrictEqual(out.content.media, [
    'https://example.com/a.jpg',
    'https://example.com/b.jpg',
  ]);
});

test('ignores media on SMS, which cannot carry it', () => {
  const [out] = payload.buildPayloads({ ...BASE, mediaUrl: 'https://example.com/a.jpg' });
  assert.strictEqual('media' in out.content, false);
});

test('does not attach media to a content template', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    channel: 'mms',
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    mediaUrl: 'https://example.com/a.jpg',
  });
  assert.deepStrictEqual(out.content, { contentId: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b' });
});

test('tags the operation with campaign name, channel and mode', () => {
  const [out] = payload.buildPayloads({ ...BASE, campaignName: 'Spring sale' });
  assert.deepStrictEqual(out.tags, {
    campaign: 'Spring sale',
    channel: 'sms',
    mode: 'bulk',
  });
});

test('omits the campaign tag when there is no name', () => {
  const [out] = payload.buildPayloads(BASE);
  assert.deepStrictEqual(out.tags, { channel: 'sms', mode: 'bulk' });
});

test('truncates an over-long tag value to 256 characters', () => {
  const [out] = payload.buildPayloads({ ...BASE, campaignName: 'x'.repeat(300) });
  assert.strictEqual(out.tags.campaign.length, 256);
});

test('omits schedule when no sendAt is given', () => {
  const [out] = payload.buildPayloads(BASE);
  assert.strictEqual('schedule' in out, false);
});

test('passes sendAt through as a schedule', () => {
  const [out] = payload.buildPayloads({ ...BASE, sendAt: '2026-09-10T09:30:00Z' });
  assert.deepStrictEqual(out.schedule, { sendAt: '2026-09-10T09:30:00Z' });
});

test('rejects a sendAt that is not RFC 3339', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, sendAt: 'next tuesday' }),
    (err) => err.statusCode === 400 && /date/i.test(err.message)
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `out.tags` is `undefined`

- [ ] **Step 3: Implement media, tags and schedule**

Add to `assets/bulk-payload.private.js` above `buildPayloads`:

```js
const MEDIA_CHANNELS = new Set(['mms', 'rcs']);
const MAX_TAGS = 10;
const MAX_TAG_KEY = 128;
const MAX_TAG_VALUE = 256;

/** Tags carry at most 10 pairs, with bounded key and value lengths. */
function buildTags(request, channel) {
  const candidates = {
    ...(request.campaignName ? { campaign: String(request.campaignName) } : {}),
    channel,
    mode: 'bulk',
  };

  const tags = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (Object.keys(tags).length >= MAX_TAGS) break;
    tags[String(key).slice(0, MAX_TAG_KEY)] = String(value).slice(0, MAX_TAG_VALUE);
  }
  return tags;
}

/**
 * Validates `sendAt` without normalising it.
 *
 * Passed through exactly as received: the API reference renders the field as
 * `{sendAt: [RFC 3339 date-time]}` while the scheduling guide shows a literal
 * array, so the shape is confirmed against a live call rather than guessed. If
 * it turns out to want an array, this function is the only thing that changes.
 */
function resolveSchedule(sendAt) {
  if (sendAt == null || String(sendAt).trim() === '') return null;
  const value = String(sendAt).trim();
  if (Number.isNaN(Date.parse(value))) {
    throw httpError(400, `"${value}" is not a valid RFC 3339 date and time.`);
  }
  return { sendAt: value };
}
```

In `resolveContent`, attach media to the text branches only. Replace the `anyOwnBody` and literal-body returns with:

```js
  const media = MEDIA_CHANNELS.has(String(request.channel).toLowerCase())
    ? [].concat(request.mediaUrl || []).filter(Boolean)
    : [];

  if (anyOwnBody) {
    const content = { text: '{{body}}' };
    if (media.length) content.media = media;
    return { content, perRecipientBody: true };
  }

  if (!body.trim()) {
    throw httpError(400, 'A message body or a content template is required.');
  }

  const content = { text: escapeLiquid(body) };
  if (media.length) content.media = media;
  return { content, perRecipientBody: false };
```

Then in `buildPayloads`, replace the return statement:

```js
  const payload = { from, to, content, tags: buildTags(request, channel) };

  const schedule = resolveSchedule(request.sendAt);
  if (schedule) payload.schedule = schedule;

  return [payload];
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 31 tests

- [ ] **Step 5: Commit**

```bash
git add assets/bulk-payload.private.js test/bulk-payload.test.js
git commit -m "feat: add media, tags and scheduling to the bulk payload"
```

---

## Task 6: WhatsApp-to-SMS channel fallback

**Files:**
- Modify: `assets/bulk-payload.private.js`
- Modify: `test/bulk-payload.test.js`

Fallback uses the per-recipient `addresses[]` form, which needs no sender pool. **It is WhatsApp-only.** An RCS recipient's `to[].channel` is already `PHONE`, so an RCS-then-SMS `addresses[]` array would list the same channel twice; RCS fallback needs sender-pool `channels.priority`, which is out of scope. Requesting fallback on any other channel is an error rather than a silent no-op, so the UI cannot quietly promise something that does not happen.

- [ ] **Step 1: Write the failing tests**

Append to `test/bulk-payload.test.js`:

```js
test('expresses WhatsApp fallback as an ordered addresses array', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    channel: 'whatsapp',
    from: '+15017122661',
    fallbackToSms: true,
    recipients: [{ to: '+15558675310' }],
  });
  assert.deepStrictEqual(out.to, [
    {
      addresses: [
        { address: '+15558675310', channel: 'WHATSAPP' },
        { address: '+15558675310', channel: 'PHONE' },
      ],
    },
  ]);
});

test('keeps variables alongside a fallback addresses array', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    channel: 'whatsapp',
    from: '+15017122661',
    fallbackToSms: true,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [{ to: '+15558675310', variables: { 1: 'Sarah' } }],
  });
  assert.deepStrictEqual(out.to[0].variables, { 1: 'Sarah' });
  assert.strictEqual(out.to[0].addresses.length, 2);
  assert.strictEqual('address' in out.to[0], false);
});

test('rejects fallback on RCS, where addresses[] cannot express it', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, channel: 'rcs', fallbackToSms: true }),
    (err) => err.statusCode === 400 && /WhatsApp/i.test(err.message)
  );
});

test('rejects fallback on SMS, which is already the fallback', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, fallbackToSms: true }),
    (err) => err.statusCode === 400 && /WhatsApp/i.test(err.message)
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `out.to[0].addresses` is `undefined`

- [ ] **Step 3: Implement fallback**

In `assets/bulk-payload.private.js`, add above `buildPayloads`:

```js
/**
 * Fallback is expressed per recipient as an ordered `addresses` array, which
 * needs no sender pool.
 *
 * WhatsApp only, and not for want of trying: an RCS recipient's channel is
 * already PHONE (see CHANNEL_MAP), so an RCS-then-SMS array would name the same
 * channel twice and mean nothing. RCS fallback requires sender-pool
 * `channels.priority`, which this app does not create.
 */
function assertFallbackSupported(channel) {
  if (channel !== 'whatsapp') {
    throw httpError(
      400,
      'Channel fallback is only available on WhatsApp. On RCS it requires a sender pool, which this app does not manage.'
    );
  }
}
```

In `buildPayloads`, after resolving `channelNames`, add:

```js
  const fallbackToSms = Boolean(request.fallbackToSms);
  if (fallbackToSms) assertFallbackSupported(channel);
```

Then in the recipient loop, replace the `entry` construction:

```js
  const to = recipients.map((recipient) => {
    const address = bareAddress(recipient.to);

    const entry = fallbackToSms
      ? {
          addresses: [
            { address, channel: channelNames.to },
            { address, channel: 'PHONE' },
          ],
        }
      : { address, channel: channelNames.to };

    const variables = { ...(recipient.variables || {}) };

    if (perRecipientBody) {
      const own = String(recipient.body == null ? '' : recipient.body);
      variables.body = own.trim() === '' ? campaignBody : own;
    }

    if (Object.keys(variables).length > 0) {
      entry.variables = variables;
    }

    return entry;
  });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 35 tests

- [ ] **Step 5: Commit**

```bash
git add assets/bulk-payload.private.js test/bulk-payload.test.js
git commit -m "feat: add WhatsApp-to-SMS fallback via ordered recipient addresses"
```

---

## Task 7: Splitting above 10,000 recipients and the payload size guard

**Files:**
- Modify: `assets/bulk-payload.private.js`
- Modify: `test/bulk-payload.test.js`

The API caps a request at 10,000 recipients and 10MB. Splitting keeps bulk mode from capping where the classic path is unbounded; the size guard catches variable-heavy campaigns that stay under 10,000 but exceed 10MB.

- [ ] **Step 1: Write the failing tests**

Append to `test/bulk-payload.test.js`:

```js
function manyRecipients(count) {
  return Array.from({ length: count }, (_, i) => ({
    to: `+1555${String(1000000 + i).slice(-7)}`,
  }));
}

test('returns one payload at exactly the 10,000 limit', () => {
  const out = payload.buildPayloads({ ...BASE, recipients: manyRecipients(10000) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].to.length, 10000);
});

test('splits into consecutive operations above the limit', () => {
  const out = payload.buildPayloads({ ...BASE, recipients: manyRecipients(25000) });
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((p) => p.to.length), [10000, 10000, 5000]);
});

test('every split payload carries identical sender, content and tags', () => {
  const out = payload.buildPayloads({
    ...BASE,
    campaignName: 'Big',
    recipients: manyRecipients(15000),
  });
  assert.deepStrictEqual(out[0].from, out[1].from);
  assert.deepStrictEqual(out[0].content, out[1].content);
  assert.deepStrictEqual(out[0].tags, out[1].tags);
});

test('splits preserve recipient order across the boundary', () => {
  const recipients = manyRecipients(10002);
  const out = payload.buildPayloads({ ...BASE, recipients });
  assert.strictEqual(out[0].to[0].address, recipients[0].to);
  assert.strictEqual(out[0].to[9999].address, recipients[9999].to);
  assert.strictEqual(out[1].to[0].address, recipients[10000].to);
  assert.strictEqual(out[1].to[1].address, recipients[10001].to);
});

test('rejects a single payload over 10MB', () => {
  const fat = Array.from({ length: 2000 }, (_, i) => ({
    to: `+1555${String(1000000 + i).slice(-7)}`,
    variables: { 1: 'y'.repeat(6000) },
  }));
  assert.throws(
    () => payload.buildPayloads({
      ...BASE,
      body: '',
      contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
      recipients: fat,
    }),
    (err) => err.statusCode === 400 && /10MB/i.test(err.message)
  );
});

test('exposes the recipient limit so callers need not hard-code it', () => {
  assert.strictEqual(payload.MAX_RECIPIENTS_PER_OPERATION, 10000);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — the 25,000 case returns 1 payload, not 3

- [ ] **Step 3: Implement splitting and the size guard**

In `assets/bulk-payload.private.js`, add near the other constants:

```js
const MAX_RECIPIENTS_PER_OPERATION = 10000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
```

Replace the return block of `buildPayloads`:

```js
  const schedule = resolveSchedule(request.sendAt);
  const tags = buildTags(request, channel);

  const payloads = [];
  for (let i = 0; i < to.length; i += MAX_RECIPIENTS_PER_OPERATION) {
    const slice = to.slice(i, i + MAX_RECIPIENTS_PER_OPERATION);
    const one = { from, to: slice, content, tags };
    if (schedule) one.schedule = schedule;

    // Recipient count is bounded above; payload *size* is not, because variable
    // values are arbitrary. Measured per operation, since that is what is sent.
    const bytes = Buffer.byteLength(JSON.stringify(one), 'utf8');
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw httpError(
        400,
        `One request would be ${(bytes / 1024 / 1024).toFixed(1)}MB, over the Bulk Messaging limit of 10MB. Shorten the personalisation values or split the campaign.`
      );
    }

    payloads.push(one);
  }

  return payloads;
```

Update the exports line:

```js
module.exports = {
  buildPayloads,
  CHANNEL_MAP,
  bareAddress,
  escapeLiquid,
  MAX_RECIPIENTS_PER_OPERATION,
};
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 41 tests

- [ ] **Step 5: Commit**

```bash
git add assets/bulk-payload.private.js test/bulk-payload.test.js
git commit -m "feat: split bulk payloads at 10,000 recipients and guard 10MB"
```

---

## Task 8: The comms client — creating messages

**Files:**
- Create: `assets/twilio-comms.private.js`
- Create: `test/twilio-comms.test.js`

`comms` is absent from `twilio@5.10.6`, so this is raw `fetch`. Node 24 has `fetch` globally; tests replace `globalThis.fetch` with a stub.

The `202` response body is empty — the `operationId` arrives as a **header**.

- [ ] **Step 1: Write the failing tests**

Create `test/twilio-comms.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const comms = require('../assets/twilio-comms.private.js');

const AUTH = 'Bearer test.jwt.value';

/**
 * Replaces global fetch for one test and records what it was called with.
 * Returns the call log; restore happens via t.after so a failure cannot leak
 * the stub into another test.
 */
function stubFetch(t, responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('posts to the Messages endpoint with a bearer token and JSON body', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(202, undefined, { operationId: 'comms_operation_01h9k' })
  );

  const result = await comms.createMessages(AUTH, { to: [], content: { text: 'hi' } });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://comms.twilio.com/v1/Messages');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.headers.Authorization, AUTH);
  assert.strictEqual(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    to: [],
    content: { text: 'hi' },
  });
  assert.deepStrictEqual(result, { operationId: 'comms_operation_01h9k' });
});

test('reads the operationId header case-insensitively', async (t) => {
  stubFetch(t, () => jsonResponse(202, undefined, { OperationId: 'comms_operation_x' }));
  const result = await comms.createMessages(AUTH, {});
  assert.strictEqual(result.operationId, 'comms_operation_x');
});

test('fails loudly when a 202 carries no operationId', async (t) => {
  stubFetch(t, () => jsonResponse(202, undefined));
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 502 && /operationId/i.test(err.message)
  );
});

test('surfaces a 400 message verbatim', async (t) => {
  stubFetch(t, () =>
    jsonResponse(400, { code: 21211, message: "Invalid 'To' address" })
  );
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 400 && err.code === 21211 && /Invalid 'To' address/.test(err.message)
  );
});

test('adds a scope hint to a 401', async (t) => {
  stubFetch(t, () => jsonResponse(401, { code: 20003, message: 'Authentication Error' }));
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 401 && /Comms/i.test(err.message)
  );
});

test('reports a non-JSON error body without throwing on the parse', async (t) => {
  const calls = stubFetch(t, () => new Response('<html>gateway</html>', { status: 502 }));
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 502
  );
  assert.strictEqual(calls.length, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../assets/twilio-comms.private.js'`

- [ ] **Step 3: Implement the client and `createMessages`**

Create `assets/twilio-comms.private.js`:

```js
/**
 * The only module that knows about comms.twilio.com.
 *
 * This is a *private* asset: the `.private.js` suffix makes Twilio Serverless
 * mark it `access: private`, so it is never served over HTTP. Require it as:
 *
 *   const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);
 *
 * Note the key drops the `.private` segment.
 *
 * Raw fetch rather than the SDK, because `comms` is absent from twilio@5.10.6 —
 * there is no `client.comms` namespace to call. Node 24 provides fetch globally.
 * Keeping every URL, header and error shape here means the Functions above it
 * do not know this is HTTP.
 */

'use strict';

const BASE_URL = 'https://comms.twilio.com/v1';

/** An Error carrying the HTTP status a handler should respond with. */
function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code != null) err.code = code;
  return err;
}

/**
 * Turns a non-2xx response into a thrown Error.
 *
 * The body is read as text first and parsed defensively: a gateway error can
 * return HTML, and letting `response.json()` throw would replace Twilio's real
 * status with a JSON syntax error.
 */
async function raiseFor(response) {
  const text = await response.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  const detail = (body && body.message) || response.statusText || 'Unknown error';

  if (response.status === 401 || response.status === 403) {
    throw httpError(
      response.status,
      `${detail} — check that the OAuth app has the Comms scopes granted for Bulk Messaging.`,
      body && body.code
    );
  }

  throw httpError(response.status, detail, body && body.code);
}

async function request(authString, method, path, { body, query } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: authString,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) await raiseFor(response);
  return response;
}

/**
 * Submits one operation of up to 10,000 recipients.
 *
 * Returns only the operation ID: the 202 body is empty by design, and the ID
 * arrives as a response header. A 202 without one leaves nothing to track, so
 * it is treated as a protocol failure rather than a success.
 */
async function createMessages(authString, payload) {
  const response = await request(authString, 'POST', '/Messages', { body: payload });
  const operationId = response.headers.get('operationid');
  if (!operationId) {
    throw httpError(
      502,
      'Twilio accepted the request but returned no operationId, so its progress cannot be tracked.'
    );
  }
  return { operationId };
}

module.exports = { createMessages, BASE_URL };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 47 tests total

- [ ] **Step 5: Commit**

```bash
git add assets/twilio-comms.private.js test/twilio-comms.test.js
git commit -m "feat: add a comms.twilio.com client for creating bulk operations"
```

---

## Task 9: The comms client — reads, and rate-limit retry

**Files:**
- Modify: `assets/twilio-comms.private.js`
- Modify: `test/twilio-comms.test.js`

Two reads: one operation's stats, and the messages an operation created. The list endpoint pages with an opaque token at `pagination.next`.

- [ ] **Step 1: Write the failing tests**

Append to `test/twilio-comms.test.js`:

```js
const OPERATION = {
  id: 'comms_operation_01h2x',
  status: 'COMPLETED',
  stats: { total: 2, recipients: 2, delivered: 1, failed: 1 },
  createdAt: '2026-09-02T06:20:00Z',
  updatedAt: '2026-09-02T06:21:00Z',
};

test('fetches one operation by id', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, OPERATION));

  const operation = await comms.fetchOperation(AUTH, 'comms_operation_01h2x');

  assert.strictEqual(
    calls[0].url,
    'https://comms.twilio.com/v1/Messages/Operations/comms_operation_01h2x'
  );
  assert.strictEqual(calls[0].options.method, 'GET');
  assert.deepStrictEqual(operation, OPERATION);
});

test('URL-encodes an operation id', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, OPERATION));
  await comms.fetchOperation(AUTH, 'a/b c');
  assert.strictEqual(
    calls[0].url,
    'https://comms.twilio.com/v1/Messages/Operations/a%2Fb%20c'
  );
});

test('lists messages for an operation at the maximum page size', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(200, { messages: [{ id: 'm1' }], pagination: { next: null } })
  );

  const page = await comms.listMessages(AUTH, { operationId: 'comms_operation_01h2x' });

  const url = new URL(calls[0].url);
  assert.strictEqual(url.pathname, '/v1/Messages');
  assert.strictEqual(url.searchParams.get('operation_id'), 'comms_operation_01h2x');
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.deepStrictEqual(page, { messages: [{ id: 'm1' }], nextPageToken: null });
});

test('returns the next page token when there is another page', async (t) => {
  stubFetch(t, () =>
    jsonResponse(200, { messages: [], pagination: { next: 'tok2', self: 'tok1' } })
  );
  const page = await comms.listMessages(AUTH, { operationId: 'op' });
  assert.strictEqual(page.nextPageToken, 'tok2');
});

test('sends a page token when given one', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { messages: [] }));
  await comms.listMessages(AUTH, { operationId: 'op', pageToken: 'tok2' });
  assert.strictEqual(new URL(calls[0].url).searchParams.get('pageToken'), 'tok2');
});

test('tolerates a response with no messages array', async (t) => {
  stubFetch(t, () => jsonResponse(200, {}));
  const page = await comms.listMessages(AUTH, { operationId: 'op' });
  assert.deepStrictEqual(page, { messages: [], nextPageToken: null });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `comms.fetchOperation is not a function`

- [ ] **Step 3: Implement both reads**

Add to `assets/twilio-comms.private.js` above `module.exports`:

```js
/** Aggregate status and stats for one operation. */
async function fetchOperation(authString, operationId) {
  const response = await request(
    authString,
    'GET',
    `/Messages/Operations/${encodeURIComponent(operationId)}`
  );
  return response.json();
}

/**
 * One page of the Messages an operation created.
 *
 * Page size is pinned to the documented maximum of 1000 to keep the number of
 * round trips down: a 10,000-recipient operation is ten pages rather than a
 * hundred. `pagination.next` is opaque and is returned as-is for the caller to
 * pass back.
 */
async function listMessages(authString, { operationId, pageToken, pageSize = 1000 } = {}) {
  const response = await request(authString, 'GET', '/Messages', {
    query: { operation_id: operationId, pageSize, pageToken },
  });
  const body = await response.json();
  return {
    messages: Array.isArray(body.messages) ? body.messages : [],
    nextPageToken: (body.pagination && body.pagination.next) || null,
  };
}
```

Update the exports:

```js
module.exports = { createMessages, fetchOperation, listMessages, BASE_URL };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS — 53 tests total

- [ ] **Step 5: Commit**

```bash
git add assets/twilio-comms.private.js test/twilio-comms.test.js
git commit -m "feat: read bulk operation stats and page its per-message list"
```

- [ ] **Step 6: Write the failing rate-limit tests**

Existing MPS limits still apply to bulk sends, so a `429` is expected under load and must be retried rather than surfaced.

Append to `test/twilio-comms.test.js`:

```js
test('retries a 429 and succeeds', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(429, { code: 20429, message: 'Too Many Requests' })
      : jsonResponse(202, undefined, { operationId: 'comms_operation_ok' });
  });

  const result = await comms.createMessages(AUTH, {}, { baseDelay: 1 });

  assert.strictEqual(attempts, 2);
  assert.strictEqual(result.operationId, 'comms_operation_ok');
});

test('gives up after the retry budget and surfaces the 429', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return jsonResponse(429, { code: 20429, message: 'Too Many Requests' });
  });

  await assert.rejects(
    () => comms.createMessages(AUTH, {}, { maxRetries: 2, baseDelay: 1 }),
    (err) => err.statusCode === 429
  );
  assert.strictEqual(attempts, 3);
});

test('does not retry a 400', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return jsonResponse(400, { code: 21211, message: 'Invalid' });
  });

  await assert.rejects(() => comms.createMessages(AUTH, {}, { baseDelay: 1 }));
  assert.strictEqual(attempts, 1);
});
```

Run: `npm test`
Expected: FAIL — the first test sees 1 attempt, not 2

- [ ] **Step 7: Add retry to the request path**

In `assets/twilio-comms.private.js`, add above `request`:

```js
/**
 * Retries a 429 with exponential backoff and jitter.
 *
 * Deliberately not shared with the copy in send-messages.js. Extracting that one
 * would mean editing the classic send path, which this branch leaves alone, and
 * the two have different jobs: that retries up to 100 concurrent creates, this
 * retries a single request. Jitter still matters — several browsers submitting
 * campaigns at once would otherwise retry in lockstep.
 */
async function withRateLimitRetry(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 8000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error.statusCode !== 429 || attempt === maxRetries) throw error;

      const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      const jitter = Math.random() * 0.3 * delay;
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
  throw lastError;
}
```

Then thread retry options through the three callers. Change each signature and wrap the `request` call:

```js
async function createMessages(authString, payload, retryOptions) {
  const response = await withRateLimitRetry(
    () => request(authString, 'POST', '/Messages', { body: payload }),
    retryOptions
  );
  const operationId = response.headers.get('operationid');
  if (!operationId) {
    throw httpError(
      502,
      'Twilio accepted the request but returned no operationId, so its progress cannot be tracked.'
    );
  }
  return { operationId };
}
```

Apply the same wrapping inside `fetchOperation`, `listMessages` and `listSenderPools`, each taking an optional final `retryOptions` argument.

Run: `npm test`
Expected: PASS — 56 tests total

- [ ] **Step 8: Commit**

```bash
git add assets/twilio-comms.private.js test/twilio-comms.test.js
git commit -m "feat: retry rate-limited bulk requests with backoff and jitter"
```

---

## Task 10: Expose the bearer token from the OAuth helper

**Files:**
- Modify: `assets/twilio-oauth.private.js:158-188`

`authenticate()` already fetches the auth string and throws it away, keeping only the client. The Bulk client needs that string. Adding a second export rather than changing `authenticate()`'s return shape leaves its six existing callers untouched.

- [ ] **Step 1: Rename the existing function and add a wrapper**

In `assets/twilio-oauth.private.js`, change the declaration at line 158 from:

```js
async function authenticate(creds, timeoutMs = TOKEN_DEADLINE_MS) {
```

to:

```js
async function authenticateWithToken(creds, timeoutMs = TOKEN_DEADLINE_MS) {
```

- [ ] **Step 2: Change its return statement**

At the end of that function, replace:

```js
  client.setAccountSid(accountSid);

  return client;
}
```

with:

```js
  client.setAccountSid(accountSid);

  return { client, authString, accountSid };
}

/**
 * The client alone, for the six callers that only ever needed that.
 *
 * `authString` is deliberately not attached to the client: the Bulk path asks
 * for it explicitly through `authenticateWithToken`, so a bearer token cannot
 * travel somewhere by accident just because a client was passed along.
 */
async function authenticate(creds, timeoutMs = TOKEN_DEADLINE_MS) {
  const { client } = await authenticateWithToken(creds, timeoutMs);
  return client;
}
```

- [ ] **Step 3: Export the new function**

In the `module.exports` block at line 243, add `authenticateWithToken` after `createOAuthClient`:

```js
module.exports = {
  credsFrom,
  createOAuthClient,
  authenticate,
  authenticateWithToken,
  accountSidFromAuthString,
  ownerKeyFor,
  getOrCreateSyncService,
  withDeadline,
};
```

- [ ] **Step 4: Verify no existing caller broke**

Run: `grep -rn "oauth.authenticate(" functions/`
Expected: six call sites, all still calling `authenticate(` and using the returned value as a client — `verify.js`, `send-messages.js`, `resume-execution.js`, `check-status.js`, `get-phone-numbers.js`, `get-content-templates.js`, `list-campaigns.js`. None need editing.

Run: `node -e "require('./assets/twilio-oauth.private.js')"`
Expected: no output, exit 0 — the module still parses.

- [ ] **Step 5: Commit**

```bash
git add assets/twilio-oauth.private.js
git commit -m "refactor: expose the OAuth bearer token for non-SDK API calls"
```

---

## Task 11: Offer sender pools instead of Messaging Services in bulk mode

**Files:**
- Modify: `functions/get-phone-numbers.js:27-107`

Bulk mode cannot use a Messaging Service (Task 2), so offering one in the dropdown invites a guaranteed failure. In bulk mode the list drops services and adds sender pools.

- [ ] **Step 1: Require the comms client**

At the top of `functions/get-phone-numbers.js`, after the existing `oauth` require on line 5:

```js
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);
```

- [ ] **Step 2: Capture the bearer token**

Replace lines 18-25:

```js
  let client;
  try {
    client = await oauth.authenticate(oauth.credsFrom(event));
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }
```

with:

```js
  let client;
  let authString;
  try {
    const authed = await oauth.authenticateWithToken(oauth.credsFrom(event));
    client = authed.client;
    authString = authed.authString;
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }
```

- [ ] **Step 3: Branch the second list on mode**

Replace line 33:

```js
    const servicesPromise = client.messaging.v1.services.list({ limit: 50 });
```

with:

```js
    const mode = String(event.mode || 'classic').toLowerCase();

    // In bulk mode a Messaging Service is not a valid sender — the Bulk API's
    // `from` takes an address/channel pair, a senderId or a senderPoolId, and an
    // MG SID is none of them. Sender pools take its place in the dropdown.
    //
    // A pool listing that fails must not fail the whole request: phone numbers
    // are the common case and are still perfectly usable without pools.
    const secondaryPromise = mode === 'bulk'
      ? comms
          .listSenderPools(authString)
          .then((pools) => pools.map((pool) => ({
            value: pool.id,
            label: `${pool.friendlyName || pool.id} · pool`,
            status: 'ONLINE',
            kind: 'pool',
          })))
          .catch((error) => {
            console.error('Sender pool list failed:', error.message);
            return [];
          })
      : client.messaging.v1.services.list({ limit: 50 }).then((services) =>
          services.map((s) => ({
            value: s.sid,
            label: `${s.friendlyName} · ${s.sid.slice(0, 10)}…`,
            status: 'ONLINE',
            kind: 'service',
          }))
        );
```

- [ ] **Step 4: Use the branched list**

Replace lines 85-92:

```js
    const [direct, services] = await Promise.all([directPromise, servicesPromise]);

    const serviceSenders = services.map((s) => ({
      value: s.sid,
      label: `${s.friendlyName} · ${s.sid.slice(0, 10)}…`,
      status: 'ONLINE',
      kind: 'service',
    }));
```

with:

```js
    const [direct, serviceSenders] = await Promise.all([directPromise, secondaryPromise]);
```

Then in the response body at line 97, add `mode` beside `channel`:

```js
      success: true,
      channel,
      mode,
```

- [ ] **Step 5: Add `listSenderPools` to the comms client**

Append the test to `test/twilio-comms.test.js`:

```js
test('lists sender pools', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(200, { senderPools: [{ id: 'SP1', friendlyName: 'Marketing' }] })
  );

  const pools = await comms.listSenderPools(AUTH);

  assert.strictEqual(new URL(calls[0].url).pathname, '/v1/SenderPools');
  assert.deepStrictEqual(pools, [{ id: 'SP1', friendlyName: 'Marketing' }]);
});

test('returns an empty array when no sender pools exist', async (t) => {
  stubFetch(t, () => jsonResponse(200, {}));
  assert.deepStrictEqual(await comms.listSenderPools(AUTH), []);
});
```

Run: `npm test`
Expected: FAIL — `comms.listSenderPools is not a function`

Add to `assets/twilio-comms.private.js` above `module.exports`:

```js
/**
 * Sender pools available for bulk sends.
 *
 * The response key is unconfirmed against a live account — Task 22 verifies it.
 * Both `senderPools` and `sender_pools` are accepted so a naming difference
 * degrades to an empty list rather than a crash.
 */
async function listSenderPools(authString) {
  const response = await request(authString, 'GET', '/SenderPools', {
    query: { pageSize: 100 },
  });
  const body = await response.json();
  const pools = body.senderPools || body.sender_pools || body.pools;
  return Array.isArray(pools) ? pools : [];
}
```

Update the exports:

```js
module.exports = {
  createMessages,
  fetchOperation,
  listMessages,
  listSenderPools,
  BASE_URL,
};
```

Run: `npm test`
Expected: PASS — 55 tests total

- [ ] **Step 6: Commit**

```bash
git add functions/get-phone-numbers.js assets/twilio-comms.private.js test/twilio-comms.test.js
git commit -m "feat: list sender pools instead of Messaging Services in bulk mode"
```

---

## Task 12: `send-bulk.js`

**Files:**
- Create: `functions/send-bulk.js`

Thin wiring: build payloads, POST each, record the campaign. No chunk loop, no timeout budget, no checkpointing — a 10,000-recipient operation is one request.

Note the ordering: **Sync is written after the POSTs**, and partial success is recorded rather than discarded. If operation 2 of 3 fails, operations 1 and 2 have already been accepted by Twilio and their messages will send; losing their IDs would leave traffic nobody can track.

- [ ] **Step 1: Write the Function**

Create `functions/send-bulk.js`:

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);
const bulk = require(Runtime.getAssets()['/bulk-payload.js'].path);

/**
 * POST /send-bulk — submits a campaign through the Bulk Messaging API.
 *
 * Unlike send-messages.js there is no chunk loop and no checkpoint: one request
 * carries up to 10,000 recipients, so the browser does not have to drive
 * anything and the tab need not stay open. Campaigns above 10,000 become
 * several operations, submitted here in one invocation.
 */
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  let creds;
  let authString;
  let accountSid;
  try {
    creds = oauth.credsFrom(event);
    const authed = await oauth.authenticateWithToken(creds);
    authString = authed.authString;
    accountSid = authed.accountSid;
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  // Payloads are built before anything is sent, so a mapping or validation
  // error costs nothing: nothing has left the building yet.
  let payloads;
  try {
    payloads = bulk.buildPayloads({
      channel: event.channel,
      from: event.from,
      body: event.body,
      contentSid: event.contentSid,
      mediaUrl: event.mediaUrl,
      recipients: event.recipients,
      campaignName: event.campaignName,
      sendAt: event.sendAt,
      fallbackToSms: event.fallbackToSms,
    });
  } catch (error) {
    response.setStatusCode(error.statusCode || 400);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  const recipientCount = payloads.reduce((total, p) => total + p.to.length, 0);

  const operationIds = [];
  let submitError = null;
  try {
    for (const payload of payloads) {
      const { operationId } = await comms.createMessages(authString, payload);
      operationIds.push(operationId);
    }
  } catch (error) {
    // Any operation already accepted will send regardless of this failure, so
    // the campaign is still recorded below with the IDs that succeeded.
    // Dropping them would leave traffic in flight that nothing can track.
    submitError = error;
  }

  if (operationIds.length === 0) {
    response.setStatusCode((submitError && submitError.statusCode) || 502);
    response.setBody({
      error: (submitError && submitError.message) || 'Twilio accepted no operations.',
    });
    return callback(null, response);
  }

  const campaignDocName = event.campaignId || `campaign_${Date.now()}`;

  try {
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid =
      context.SYNC_SERVICE_SID || (await oauth.getOrCreateSyncService(runtimeClient));

    await runtimeClient.sync.v1.services(syncServiceSid).documents.create({
      uniqueName: campaignDocName,
      data: {
        mode: 'bulk',
        ownerKey: oauth.ownerKeyFor(creds),
        accountSid, // display only; never an authorization key
        operationIds,
        recipientCount,
        // No recipient list and no per-message statuses: there is nothing to
        // resume, so there is nothing to checkpoint — and a Sync Document holds
        // only 16KiB, which a 10,000-recipient list would blow past many times.
        channel: String(event.channel || '').toLowerCase(),
        from: event.from || null,
        campaignName: event.campaignName || null,
        scheduledFor: event.sendAt || null,
        stats: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Bulk campaign record failed:', error.message);
    // The messages are already accepted. Report that plainly rather than
    // returning an error that reads as though nothing was sent.
    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaignId: null,
      operationIds,
      accepted: recipientCount,
      recordFailed: true,
      warning:
        'Twilio accepted the messages, but this campaign could not be recorded, so it will not appear in history. Track it in the Twilio Console using the operation ID.',
    });
    return callback(null, response);
  }

  response.setStatusCode(submitError ? 207 : 200);
  response.setBody({
    success: true,
    campaignId: campaignDocName,
    operationIds,
    // "accepted", not "sent": a 202 means Twilio took the request. Delivery is
    // what the stats block reports later.
    accepted: recipientCount,
    ...(submitError
      ? {
          partial: true,
          error: `Accepted ${operationIds.length} of ${payloads.length} batches. The rest failed: ${submitError.message}`,
        }
      : {}),
  });
  return callback(null, response);
};
```

- [ ] **Step 2: Verify it parses**

Run: `node --check functions/send-bulk.js`
Expected: no output, exit 0

- [ ] **Step 3: Commit**

```bash
git add functions/send-bulk.js
git commit -m "feat: submit campaigns through the Bulk Messaging API"
```

---

## Task 13: `check-bulk-status.js`

**Files:**
- Create: `functions/check-bulk-status.js`

Sums stats across the campaign's operations, and pages the per-recipient list only when asked. The paging loop is bounded by the same 9-second budget the classic path uses, returning a token so the browser can continue.

> **Two corrections found in code review of this task**, both folded into the code below — if you are reading the original version elsewhere, these are missing from it:
>
> 1. **A `mode !== 'bulk'` guard is required immediately after the ownership check.** Without it, an owner passing a *classic* campaign's ID gets `operationIds: []`, all-zero stats written onto that classic document as new keys, and a response claiming `mode: 'bulk'`. The size consequence is the sharp edge: a classic document already holds the recipient list *and* the per-message status map, so it can sit near Sync's 16KiB cap, and the extra keys can push it over — turning an ordinary status check into an opaque 500. Task 14 adds the mirror guard to `check-status.js`; this one was originally missed.
> 2. **A poll that reaches no operations must not overwrite stored stats.** Lines writing `stats`/`operationStatuses`/`isComplete` have to be skipped when `reachable.length === 0 && operationIds.length > 0`, or one transient `comms.twilio.com` failure persists a campaign that had delivered 8,000 messages as having delivered none. `check-status.js:98-103` sets the precedent, merging fetch errors into existing state rather than replacing it.

- [ ] **Step 1: Write the Function**

Create `functions/check-bulk-status.js`:

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);

/**
 * POST /check-bulk-status — aggregate progress for a bulk campaign, and
 * optionally its per-recipient rows.
 *
 * Operation stats are cheap and polled on a timer. The per-message list is not,
 * so it is fetched only when `includeMessages` is set — when the delivery panel
 * is opened or a CSV export is requested.
 */

const STAT_KEYS = [
  'total', 'recipients', 'attempts', 'unaddressable', 'queued', 'sent',
  'scheduled', 'delivered', 'read', 'undelivered', 'failed', 'canceled',
];

/** An operation is finished when it is COMPLETED or CANCELED. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELED']);

function sumStats(operations) {
  const totals = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
  for (const operation of operations) {
    const stats = (operation && operation.stats) || {};
    for (const key of STAT_KEYS) {
      totals[key] += Number(stats[key] || 0);
    }
  }
  return totals;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000;

  let creds;
  let authString;
  try {
    creds = oauth.credsFrom(event);
    authString = (await oauth.authenticateWithToken(creds)).authString;
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  const campaignId = String(event.campaignId || '').trim();
  if (!campaignId) {
    response.setStatusCode(400);
    response.setBody({ error: 'campaignId is required' });
    return callback(null, response);
  }

  try {
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid =
      context.SYNC_SERVICE_SID || (await oauth.getOrCreateSyncService(runtimeClient));
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    let campaignData = null;
    try {
      const doc = await syncClient.documents(campaignId).fetch();
      campaignData = doc.data;
    } catch (error) {
      if (error.status !== 404 && error.code !== 20404) throw error;
    }

    // 404 rather than 403 for someone else's campaign, so a guessed ID is never
    // confirmed to exist. Same `!campaignData` guard as check-status.js.
    if (!campaignData || campaignData.ownerKey !== oauth.ownerKeyFor(creds)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    const operationIds = Array.isArray(campaignData.operationIds)
      ? campaignData.operationIds
      : [];

    const operations = await Promise.all(
      operationIds.map((id) =>
        comms.fetchOperation(authString, id).catch((error) => {
          console.error(`Operation ${id} fetch failed:`, error.message);
          return null;
        })
      )
    );

    const reachable = operations.filter(Boolean);
    const stats = sumStats(reachable);
    const isComplete =
      reachable.length === operationIds.length &&
      reachable.length > 0 &&
      reachable.every((operation) => TERMINAL_STATUSES.has(String(operation.status)));

    campaignData.stats = stats;
    campaignData.operationStatuses = reachable.map((o) => o.status);
    campaignData.isComplete = isComplete;
    campaignData.lastUpdated = new Date().toISOString();

    // Fixed-size write: stats and a handful of statuses, never per-message rows.
    await syncClient.documents(campaignId).update({ data: campaignData });

    let messages;
    let nextCursor = null;
    if (event.includeMessages) {
      messages = [];
      let token = event.pageToken || null;
      let operationIndex = Number(event.operationIndex || 0);

      // Pages until the budget runs low, then hands the caller a token. A
      // 10,000-recipient operation is ten pages, which will not always fit.
      while (operationIndex < operationIds.length) {
        const page = await comms.listMessages(authString, {
          operationId: operationIds[operationIndex],
          pageToken: token,
        });
        messages.push(...page.messages);

        if (page.nextPageToken) {
          token = page.nextPageToken;
        } else {
          operationIndex += 1;
          token = null;
        }

        if (Date.now() - startTime > MAX_EXECUTION_TIME) break;
      }

      const exhausted = operationIndex >= operationIds.length;
      // Named a cursor, not a token: it carries both the opaque page token and
      // which operation that token belongs to, which a bare token cannot.
      nextCursor = exhausted ? null : { pageToken: token, operationIndex };
    }

    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaign: {
        campaignId,
        mode: 'bulk',
        channel: campaignData.channel,
        from: campaignData.from,
        campaignName: campaignData.campaignName,
        scheduledFor: campaignData.scheduledFor || null,
        recipientCount: campaignData.recipientCount || 0,
        operationIds,
        operationStatuses: campaignData.operationStatuses,
        stats,
        isComplete,
        unreachableOperations: operationIds.length - reachable.length,
        createdAt: campaignData.createdAt,
        lastUpdated: campaignData.lastUpdated,
      },
      ...(messages ? { messages, nextCursor } : {}),
    });
    return callback(null, response);
  } catch (error) {
    console.error('Check bulk status error:', error);
    response.setStatusCode(error.statusCode || 500);
    response.setBody({
      error: 'Failed to check bulk campaign status',
      message: error.message,
    });
    return callback(null, response);
  }
};
```

- [ ] **Step 2: Verify it parses**

Run: `node --check functions/check-bulk-status.js`
Expected: no output, exit 0

- [ ] **Step 3: Commit**

```bash
git add functions/check-bulk-status.js
git commit -m "feat: aggregate bulk operation stats and page recipients on demand"
```

---

## Task 14: Route existing Functions by mode

**Files:**
- Modify: `functions/check-status.js:66-70`
- Modify: `functions/list-campaigns.js:60-70`

`check-status.js` would try to re-fetch per-message SIDs for a bulk campaign and find none. It must refuse rather than report an empty campaign. Campaign history needs `mode` so the UI can badge rows and poll the right endpoint.

Defaulting an absent `mode` to `'classic'` is what keeps campaigns created before this branch working.

- [ ] **Step 1: Reject bulk campaigns in `check-status.js`**

In `functions/check-status.js`, immediately after the ownership check that ends at line 70, insert:

```js
    // A bulk campaign has no per-message SID map to re-fetch — its progress
    // lives in the operation, not in Sync. Pointing the caller at the right
    // endpoint beats returning a campaign with every counter at zero.
    if (campaignData.mode === 'bulk') {
      response.setStatusCode(409);
      response.setBody({
        error: 'This is a Bulk Messaging campaign. Use check-bulk-status instead.',
        mode: 'bulk',
      });
      return callback(null, response);
    }
```

- [ ] **Step 2: Report mode from `list-campaigns.js`**

The file uses a `for` loop that `continue`s past documents it skips and `campaigns.push({…})` for the rest. The bulk branch follows that shape.

In `functions/list-campaigns.js`, immediately after the ownership `continue` guard (which ends at line 60) and **before** the `let delivered = 0;` line, insert:

```js
      // Bulk campaigns keep aggregate stats rather than a per-message map, so
      // the counter arithmetic below would report zeroes for all of them.
      // `unaddressable` counts as a failure: Twilio could not reach the
      // recipient at all, which is not a pending state and never will be.
      if (campaignData.mode === 'bulk') {
        const stats = campaignData.stats || {};
        campaigns.push({
          campaignId: doc.uniqueName,
          mode: 'bulk',
          campaignName: campaignData.campaignName || null,
          channel: campaignData.channel || null,
          recipientCount: campaignData.recipientCount || 0,
          totalMessages: campaignData.recipientCount || 0,
          sent:
            Number(stats.sent || 0) +
            Number(stats.delivered || 0) +
            Number(stats.read || 0),
          delivered: Number(stats.delivered || 0) + Number(stats.read || 0),
          read: Number(stats.read || 0),
          failed:
            Number(stats.failed || 0) +
            Number(stats.undelivered || 0) +
            Number(stats.unaddressable || 0),
          pending: Number(stats.queued || 0) + Number(stats.scheduled || 0),
          isComplete: Boolean(campaignData.isComplete),
          scheduledFor: campaignData.scheduledFor || null,
          createdAt: campaignData.createdAt,
          lastUpdated: campaignData.lastUpdated,
        });
        continue;
      }
```

Then add `mode` to the existing classic `campaigns.push({…})` so the UI can tell them apart:

```js
        mode: 'classic',
```

Apply the same `unaddressable`-counts-as-failed rule in `check-bulk-status.js` if you surface a failed total there.

- [ ] **Step 3: Verify both parse**

Run: `node --check functions/check-status.js && node --check functions/list-campaigns.js`
Expected: no output, exit 0

- [ ] **Step 4: Commit**

```bash
git add functions/check-status.js functions/list-campaigns.js
git commit -m "feat: route campaign reads by mode, defaulting to classic"
```

---

## Task 15: The mode toggle

**Files:**
- Modify: `assets/index.html:84-175`
- Modify: `assets/app.js`
- Modify: `assets/styles.css`

- [ ] **Step 1: Add the toggle and the two new controls to the form**

In `assets/index.html`, immediately inside `<form id="message-form">` (before the channel `form-group` at line 87), insert:

```html
                                    <div class="form-group">
                                        <label for="send-mode">API</label>
                                        <select id="send-mode">
                                            <option value="classic" selected>Programmable Messaging</option>
                                            <option value="bulk">Bulk Messaging (beta)</option>
                                        </select>
                                        <small id="send-mode-help" class="field-help">One message per recipient, driven from this tab.</small>
                                    </div>
```

After the `recipients-group` div closes (line 168, before the submit button), insert:

```html
                                    <div class="form-group bulk-only" id="schedule-group" hidden>
                                        <label for="send-at">Schedule (optional)</label>
                                        <input type="datetime-local" id="send-at">
                                        <small class="field-help">Leave empty to send now. Up to 7 days ahead.</small>
                                    </div>

                                    <div class="form-group bulk-only" id="fallback-group" hidden>
                                        <label class="checkbox-label">
                                            <input type="checkbox" id="fallback-to-sms">
                                            Fall back to SMS if WhatsApp fails
                                        </label>
                                        <small class="field-help">WhatsApp only. RCS fallback needs a sender pool.</small>
                                    </div>
```

- [ ] **Step 2: Add the styles**

Append to `assets/styles.css`:

```css
.checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 400;
    cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
    width: auto;
    margin: 0;
}

.mode-badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    vertical-align: middle;
}

.mode-badge--bulk {
    background: #e8f0fe;
    color: #1a56b8;
}

.mode-badge--classic {
    background: #eef0f2;
    color: #55606b;
}
```

- [ ] **Step 3: Persist and apply the mode**

In `assets/app.js`, near the `CREDS_KEY` declaration around line 110, add:

```js
// The chosen API mode, kept beside the credentials in sessionStorage so a
// reload does not silently switch which API a campaign is sent through.
const MODE_KEY = 'twilio_messaging_ui_mode';

function getSendMode() {
    const select = document.getElementById('send-mode');
    if (select && select.value) return select.value;
    return sessionStorage.getItem(MODE_KEY) || 'classic';
}

function isBulkMode() {
    return getSendMode() === 'bulk';
}
```

Then add the mode-change handler and call it during initialisation:

```js
/**
 * Applies everything that differs between the two modes.
 *
 * Messenger is hidden rather than disabled because the Bulk API has no
 * Messenger channel at all, and the send note is inverted: in bulk mode the
 * campaign runs on Twilio, so the tab does not have to stay open. That note is
 * the most visible difference between the modes and must not go stale.
 */
function applySendMode() {
    const bulk = isBulkMode();
    sessionStorage.setItem(MODE_KEY, getSendMode());

    document.querySelectorAll('.bulk-only').forEach((el) => {
        el.hidden = !bulk;
    });

    const channelSelect = document.getElementById('channel');
    const messengerOption = channelSelect
        ? channelSelect.querySelector('option[value="messenger"]')
        : null;
    if (messengerOption) {
        messengerOption.hidden = bulk;
        messengerOption.disabled = bulk;
        if (bulk && channelSelect.value === 'messenger') {
            channelSelect.value = 'sms';
            channelSelect.dispatchEvent(new Event('change'));
        }
    }

    const modeHelp = document.getElementById('send-mode-help');
    if (modeHelp) {
        modeHelp.textContent = bulk
            ? 'One request for up to 10,000 recipients, processed on Twilio.'
            : 'One message per recipient, driven from this tab.';
    }

    const sendNote = document.getElementById('send-note');
    if (sendNote) {
        sendNote.textContent = bulk
            ? 'Sending continues on Twilio once submitted — you can close this tab.'
            : 'Keep this tab open while sending — the campaign is driven from your browser, not from Twilio.';
    }

    updateFallbackAvailability();

    // Senders differ by mode: bulk cannot use a Messaging Service, so the list
    // must be refetched rather than filtered client-side. loadPhoneNumbers takes
    // the channel explicitly (assets/app.js:473).
    if (channelSelect && channelSelect.value) {
        loadPhoneNumbers(channelSelect.value);
    }
}

/** Fallback is WhatsApp-only; see the payload module for why RCS cannot use it. */
function updateFallbackAvailability() {
    const group = document.getElementById('fallback-group');
    const checkbox = document.getElementById('fallback-to-sms');
    if (!group || !checkbox) return;

    const channel = document.getElementById('channel');
    const available = isBulkMode() && channel && channel.value === 'whatsapp';

    group.hidden = !available;
    if (!available) checkbox.checked = false;
}
```

- [ ] **Step 4: Wire the listeners**

Find where `assets/app.js` attaches the `change` listener to `#channel` and add alongside it:

```js
    const sendModeSelect = document.getElementById('send-mode');
    if (sendModeSelect) {
        sendModeSelect.value = sessionStorage.getItem(MODE_KEY) || 'classic';
        sendModeSelect.addEventListener('change', applySendMode);
    }
```

In the existing `#channel` change handler, add a call to `updateFallbackAvailability()`.

Then call `applySendMode()` once after the app screen is shown, so a restored mode takes effect on load.

- [ ] **Step 5: Pass the mode when loading senders**

At `assets/app.js:482`, change:

```js
        const response = await postToFunction('get-phone-numbers', { channel: ch });
```

to:

```js
        const response = await postToFunction('get-phone-numbers', {
            channel: ch,
            mode: getSendMode(),
        });
```

- [ ] **Step 6: Verify in the browser**

Run: `npm test && twilio serverless:start`
Then open `http://localhost:3000/index.html`, sign in, and check:
- Switching to **Bulk Messaging (beta)** hides Messenger, reveals the Schedule field, and changes the send note to say the tab can be closed.
- The sender dropdown reloads and contains no Messaging Service entries.
- Selecting WhatsApp reveals the fallback checkbox; selecting SMS hides it.
- Reloading the page keeps the selected mode.

- [ ] **Step 7: Commit**

```bash
git add assets/index.html assets/app.js assets/styles.css
git commit -m "feat: add a send-mode toggle with mode-specific controls"
```

---

## Task 16: Send through the bulk path

**Files:**
- Modify: `assets/app.js:1101-1151`

The classic path loops until `isComplete`. The bulk path is one request. Rather than reshaping `sendMessagesBatch`, add a sibling so neither path carries the other's conditionals.

- [ ] **Step 1: Add the bulk send function**

Insert into `assets/app.js` immediately after `sendMessagesBatch` ends at line 1151:

```js
/**
 * Submits a bulk campaign in a single request.
 *
 * No loop, and deliberately so: one operation covers 10,000 recipients and
 * Twilio processes it server-side, which is the whole reason this mode exists.
 * The `messages` array the classic path builds is reused as-is — each entry
 * already carries `to`, and optionally `body` and `variables`.
 */
async function sendBulkCampaign(messages, channel, from, campaignName) {
    const sendAtInput = document.getElementById('send-at');
    const fallbackInput = document.getElementById('fallback-to-sms');

    // datetime-local yields a value with no timezone ("2026-09-10T09:30"), which
    // the API would read as UTC. Converting through Date attaches the browser's
    // offset, so the user gets the time they actually picked.
    const sendAt = sendAtInput && sendAtInput.value
        ? new Date(sendAtInput.value).toISOString()
        : null;

    const first = messages[0] || {};

    const response = await postToFunction('send-bulk', {
        channel,
        from,
        body: document.getElementById('message-body').value || '',
        contentSid: first.contentSid || null,
        mediaUrl: first.mediaUrl || null,
        recipients: messages.map((message) => ({
            to: message.to,
            ...(message.body ? { body: message.body } : {}),
            ...(message.contentVariables
                ? { variables: typeof message.contentVariables === 'string'
                    ? JSON.parse(message.contentVariables)
                    : message.contentVariables }
                : {}),
        })),
        campaignName: campaignName || null,
        sendAt,
        fallbackToSms: Boolean(fallbackInput && fallbackInput.checked),
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Failed to submit the bulk campaign');
    }

    currentCampaignId = data.campaignId;

    if (data.warning) alert(data.warning);
    if (data.partial) alert(data.error);

    if (currentCampaignId) {
        await checkBulkCampaignStatus();
        await loadCampaigns();
        startStatusAutoRefresh();
    }

    setSendingState(false);
    return data;
}
```

- [ ] **Step 2: Branch the submit handler**

Find the call to `sendMessagesBatch(` in the form submit handler (around line 1090) and replace it with:

```js
        if (isBulkMode()) {
            await sendBulkCampaign(messages, channel, from, campaignName);
        } else {
            await sendMessagesBatch(messages, channel, from, campaignName);
        }
```

- [ ] **Step 3: Verify a real send**

Run: `twilio serverless:start`, sign in, switch to bulk mode, send to one number you control.
Expected: the message arrives; the campaign card appears; no "keep this tab open" note.

- [ ] **Step 4: Commit**

```bash
git add assets/app.js
git commit -m "feat: submit bulk campaigns in a single request"
```

---

## Task 17: Poll bulk progress and fetch rows on demand

**Files:**
- Modify: `assets/app.js:1153`, `1409-1428`, `1829-1844`

**No new renderer.** The campaign card is drawn by `displayCampaigns` (`assets/app.js:1283`) from the fields `list-campaigns.js` returns, which Task 14 already populates from bulk stats — so refreshing the card is just `loadCampaigns()`. Likewise the delivery table and CSV export both read `campaign.statuses`, an object keyed by message identifier (`displayMessageDetails` at `assets/app.js:1430`, `exportMessageStatusCsv` at `1788`). Building a synthetic `statuses` map from the bulk rows reuses both unchanged.

- [ ] **Step 1: Add the bulk status poller and the row loader**

Insert after `checkCampaignStatus` ends at `assets/app.js:1175`:

```js
/**
 * Polls a bulk campaign's aggregate stats.
 *
 * Only the cheap endpoint runs on the timer. Per-recipient rows come from
 * loadBulkMessages, called when the delivery panel is opened, because a
 * 10,000-recipient operation is ten pages of API reads.
 *
 * The campaign card itself is redrawn by loadCampaigns() — check-bulk-status
 * writes the stats into the campaign document, and list-campaigns.js turns them
 * into the same counters the classic path renders.
 */
async function checkBulkCampaignStatus() {
    if (!currentCampaignId || !creds) return;

    try {
        const response = await postToFunction('check-bulk-status', {
            campaignId: currentCampaignId,
        });
        const data = await response.json();
        if (!response.ok || !data.campaign) return;

        // Once every operation is terminal nothing will change again, so stop
        // polling rather than re-reading the same numbers every 5 seconds.
        if (data.campaign.isComplete) stopStatusAutoRefresh();
    } catch (error) {
        console.error('Bulk status check failed:', error);
    }
}

/**
 * Fetches every per-recipient row, following the cursor the Function returns
 * when one 9-second invocation cannot finish paging.
 */
async function loadBulkMessages(campaignId) {
    const rows = [];
    let cursor = null;

    do {
        const response = await postToFunction('check-bulk-status', {
            campaignId,
            includeMessages: true,
            ...(cursor
                ? { pageToken: cursor.pageToken, operationIndex: cursor.operationIndex }
                : {}),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load recipients');

        rows.push(...(data.messages || []));
        cursor = data.nextCursor;
    } while (cursor);

    return rows;
}

/**
 * Bulk statuses are SCREAMING_CASE; the delivery table and CSV export were
 * written against Programmable Messaging's lowercase vocabulary.
 */
function normaliseBulkStatus(status) {
    return String(status || 'unknown').toLowerCase();
}

/**
 * Reshapes bulk rows into the `statuses` map the existing table and CSV export
 * already read, so neither needs a bulk-specific branch.
 */
function bulkRowsToStatuses(rows) {
    const statuses = {};

    rows.forEach((row, index) => {
        const status = normaliseBulkStatus(row.status);
        // Fall back to the index so two rows can never collide and silently
        // drop one from the table.
        const key = row.id || row.messageId || `bulk-${index}`;

        statuses[key] = {
            status,
            to: (row.to && (row.to.address || row.to)) || '',
            sentAt: row.createdAt || row.updatedAt || null,
            dateSent: row.createdAt || null,
            errorCode: row.errorCode == null ? null : row.errorCode,
            errorMessage: row.errorMessage == null ? null : row.errorMessage,
            delivered: status === 'delivered' || status === 'read',
            read: status === 'read',
        };
    });

    return statuses;
}
```

- [ ] **Step 2: Route the pollers by mode**

`checkCampaignStatus` calls `check-status`, which now returns 409 for a bulk campaign. Add a router beside the two functions:

```js
async function refreshCurrentCampaign() {
    if (isBulkMode()) return checkBulkCampaignStatus();
    return checkCampaignStatus();
}
```

Replace the `await checkCampaignStatus();` calls at `assets/app.js:1126` and `1142` with `await refreshCurrentCampaign();`, and inside `startStatusAutoRefresh` at line 1840 replace `await checkCampaignStatus();` with `await refreshCurrentCampaign();`.

- [ ] **Step 3: Add the missing stop function**

`startStatusAutoRefresh` clears the interval but nothing else does, and Step 1 needs to stop polling on completion. Add after `startStatusAutoRefresh` ends at line 1844:

```js
function stopStatusAutoRefresh() {
    if (statusRefreshInterval) {
        clearInterval(statusRefreshInterval);
        statusRefreshInterval = null;
    }
}
```

- [ ] **Step 4: Branch the details fetch**

In `fetchAndDisplayCampaignDetails` at `assets/app.js:1409`, insert before the existing `check-status` call:

```js
    if (isBulkMode()) {
        try {
            const rows = await loadBulkMessages(campaignId);
            // displayMessageDetails reads campaign.statuses and stores the whole
            // object in displayedCampaign, which is what CSV export exports.
            displayMessageDetails({
                campaignId,
                mode: 'bulk',
                statuses: bulkRowsToStatuses(rows),
            });
        } catch (error) {
            console.error('Error loading bulk recipients:', error);
            document.getElementById('message-details-content').innerHTML =
                '<p style="color: #d32f2f; text-align: center; padding: 20px;">Error loading message details</p>';
        }
        return;
    }
```

- [ ] **Step 5: Verify**

Send a bulk campaign to two numbers you control, then check:
- The campaign card counters advance from pending to delivered as the operation progresses.
- Polling stops once the operation reports `COMPLETED` — confirm in the Network tab that `check-bulk-status` calls cease.
- Opening the delivery panel lists both recipients with lowercase statuses.
- **Export CSV produces both rows** — this is the check that proves the synthetic `statuses` map matches what the exporter reads.

- [ ] **Step 6: Commit**

```bash
git add assets/app.js
git commit -m "feat: poll bulk stats and load recipient rows on demand"
```

---

## Task 18: Badge campaign history by mode

**Files:**
- Modify: `assets/app.js:1269-1300`

A bulk campaign has no Resume button — there is nothing to resume — and offering one would call `resume-execution` against a campaign with no stored recipients.

- [ ] **Step 1: Add the badge and suppress Resume**

In the campaign-list renderer around `assets/app.js:1269`, where each row's markup is built, prepend the badge to the row title:

```js
        const modeBadge = campaign.mode === 'bulk'
            ? '<span class="mode-badge mode-badge--bulk">Bulk</span> '
            : '<span class="mode-badge mode-badge--classic">Classic</span> ';
```

Insert `${modeBadge}` immediately before the campaign name in that row's template.

- [ ] **Step 2: Gate the Resume button**

Find where the row conditionally renders a Resume button for incomplete campaigns and add the mode condition:

```js
        // Bulk campaigns cannot be resumed: Twilio owns the processing, and no
        // recipient list is stored to resume from. An operation continues on its
        // own or has already finished.
        const canResume = campaign.mode !== 'bulk' && !campaign.isComplete;
```

Use `canResume` in place of whatever completeness check currently guards the button.

- [ ] **Step 3: Make the details branch depend on the row, not the toggle**

Task 17 Step 4 branches `fetchAndDisplayCampaignDetails` on `isBulkMode()` — the *toggle*. History mixes both kinds, so clicking a bulk row while the toggle says classic would call `check-status` and get a 409.

Change that branch to consult the campaign being opened. In `displayCampaigns` (`assets/app.js:1283`), the row's `onclick` calls `viewCampaign(campaignId)`; pass the mode through as a second argument:

```js
        onclick="viewCampaign('${campaign.campaignId}', '${campaign.mode || 'classic'}')"
```

Then in `viewCampaign` at line 1393, accept and forward it:

```js
async function viewCampaign(campaignId, mode) {
```

and pass it to `fetchAndDisplayCampaignDetails(campaignId, mode)`. In that function, change the Task 17 condition from:

```js
    if (isBulkMode()) {
```

to:

```js
    // The row's own mode, not the toggle: history shows both kinds at once.
    if ((mode || (isBulkMode() ? 'bulk' : 'classic')) === 'bulk') {
```

Update the `window.viewCampaign = viewCampaign;` export at line 1847 if its signature is asserted anywhere.

- [ ] **Step 4: Verify**

Send one campaign in each mode, then refresh history.
Expected: two rows, badged Bulk and Classic. Only the classic one offers Resume while incomplete. Clicking either opens its details without a 409.

- [ ] **Step 5: Commit**

```bash
git add assets/app.js
git commit -m "feat: badge campaign history by mode and hide Resume on bulk"
```

---

## Task 19: Verify the two unconfirmed request shapes

**Files:**
- Modify: `assets/bulk-payload.private.js` (only if a shape differs)
- Modify: `assets/twilio-comms.private.js` (only if a shape differs)

Deliberately placed after the implementation and before the README. Two shapes could not be settled from the documentation, and both are cheap to confirm now that a working send exists. **Do not skip this** — the plan's code encodes a guess in each case.

- [ ] **Step 1: Confirm the `schedule.sendAt` shape**

Send a scheduled bulk campaign to one number you control, five minutes ahead.

Expected: `202` and an operation whose status is `SCHEDULED`.

If it returns `400`, the field wants an array. Change `resolveSchedule` in `assets/bulk-payload.private.js` to `return { sendAt: [value] }`, and update the two `schedule` assertions in `test/bulk-payload.test.js` to match. That function is the only place the shape appears.

- [ ] **Step 2: Confirm the sender pool `from` shape**

Only if the account has a sender pool. Check with:

```bash
curl -s "https://comms.twilio.com/v1/SenderPools" \
  -H "Authorization: Bearer $TOKEN" | head -40
```

Note the actual response key (`senderPools`, `sender_pools`, or `pools`) and whether each pool's identifier field is `id` or `sid`.

If the identifier is `sid`, change the mapping in `functions/get-phone-numbers.js` from `value: pool.id` to `value: pool.sid`. If `from` needs a channel alongside `senderPoolId`, add it in `resolveSender` in `assets/bulk-payload.private.js` and update the `senderPoolId` test in `test/bulk-payload.test.js`.

If the account has no sender pool, record that in the commit message rather than guessing — the `.catch` in Task 11 already degrades to an empty list, so an unverified key cannot break the dropdown.

- [ ] **Step 3: Confirm the per-message list shape**

Open the delivery panel on a completed bulk campaign. If rows are missing or show blank recipients, the field names in `bulkRowsToStatuses` (Task 17 Step 1) do not match the API. Log one row and correct `row.id`, `row.to.address`, `row.status`, `row.createdAt`, `row.errorCode` and `row.errorMessage` to whatever the response actually uses.

That function is the only place these names appear, and the `bulk-${index}` key fallback means a wrong identifier field degrades to still-listed rows rather than a table that silently drops duplicates.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all tests, with any assertions updated above.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: correct bulk request shapes against a live API call"
```

If nothing needed changing, commit the confirmation as documentation instead:

```bash
git commit --allow-empty -m "test: confirm sendAt and sender pool shapes against the live API"
```

---

## Task 20: README

**Files:**
- Modify: `README.md`

The README currently states the tab-open constraint unconditionally at line 82 and describes five channels. Both become mode-specific.

- [ ] **Step 1: Add a mode comparison after the Features list**

Insert after line 10 in `README.md`:

```markdown
## Two sending APIs

The app can send through either of Twilio's messaging APIs, chosen per campaign.

| | Programmable Messaging | Bulk Messaging (beta) |
| --- | --- | --- |
| Request shape | one per recipient | one for up to 10,000 recipients |
| Channels | SMS, MMS, RCS, WhatsApp, Messenger | SMS, MMS, RCS, WhatsApp |
| Tab must stay open | yes — the chunk loop runs in your browser | no — Twilio processes the request |
| Resumable | yes, checkpointed to Sync | not needed; there is no loop to interrupt |
| Sender | phone number, sender, or Messaging Service | phone number or sender pool |
| Delivery detail | per message, polled every 5s | aggregate stats, with per-recipient rows on demand |
| Scheduling | not exposed | up to 7 days ahead |
| Channel fallback | no | WhatsApp to SMS |

Bulk Messaging is a [Public Beta](https://www.twilio.com/docs/bulk-messaging) product with no SLA, which is why it is a mode rather than a replacement.
```

- [ ] **Step 2: Scope the tab-open warning to classic mode**

At line 82, change the opening of that block quote from:

```markdown
> **Keep the tab open while sending.** The chunk loop runs in your browser, not on Twilio.
```

to:

```markdown
> **On Programmable Messaging, keep the tab open while sending.** The chunk loop runs in your browser, not on Twilio. (In Bulk Messaging mode this does not apply: one request covers the whole campaign, so you can close the tab as soon as it is accepted.)
```

- [ ] **Step 3: Note what "accepted" means**

Append to the **Monitor progress** section at line 90:

```markdown
In Bulk Messaging mode the campaign card reports recipients **accepted** rather than sent, because the API answers `202` before any message leaves. Delivery is reported by the stats block — `delivered`, `read`, `undelivered`, `failed` and `unaddressable` — which is more detail than the classic path's three counters. Per-recipient rows are fetched when the delivery panel is opened rather than on every poll.
```

- [ ] **Step 4: Update the architecture listing**

In the `functions/` and `assets/` block at line 121, add the four new files:

```
functions/
  send-bulk.js              One-request sending via the Bulk Messaging API
  check-bulk-status.js      Bulk operation stats, and recipients on demand
assets/
  bulk-payload.private.js   Pure request mapping for the Bulk API
  twilio-comms.private.js   comms.twilio.com client (no SDK support exists)
```

- [ ] **Step 5: Note the Comms scope in Usage**

At line 55, where the OAuth app's scopes are listed, change the scope sentence to:

```markdown
Grant it Messaging (read and write), Phone Numbers (read), and Content (read) — plus the **Comms** scopes if you intend to use Bulk Messaging mode, which authenticates against `comms.twilio.com`. Then copy the **Client ID** and **Client Secret** — the secret is shown only once.
```

- [ ] **Step 6: Add a troubleshooting entry**

Append to the Troubleshooting section:

```markdown
**Bulk mode rejects the sender.** A Messaging Service cannot be used as a bulk sender — the Bulk API's `from` accepts a phone number, a sender, or a sender pool. Pick a phone number, or switch to Programmable Messaging.

**Bulk mode returns 401 but sign-in worked.** Sign-in only proves the Messaging and Phone Numbers scopes. Bulk Messaging authenticates against `comms.twilio.com`, which needs the Comms scopes granted separately on the OAuth app.
```

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: describe both sending modes and what accepted means"
```

---

## Task 21: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — all tests, no skips

- [ ] **Step 2: Every Function parses**

Run: `for f in functions/*.js assets/*.private.js; do node --check "$f" || echo "FAILED $f"; done`
Expected: no `FAILED` lines

- [ ] **Step 3: Classic mode is genuinely unregressed**

This is the most important check in the plan. Run a classic campaign of at least 3 recipients on a channel with a content template, and confirm: messages arrive, the per-message delivery table populates, statuses reach `delivered`, CSV export works, and the campaign appears in history badged **Classic**.

- [ ] **Step 4: Deploy and re-verify**

Run: `twilio serverless:deploy`

Then against the deployed URL, send one campaign per mode and confirm both arrive. Local `fetch` to `comms.twilio.com` and deployed `fetch` can differ — egress from the Functions runtime is the case that matters.

- [ ] **Step 5: Commit any fixes, then review the branch**

```bash
git log --oneline main..HEAD
```

Expected: one commit per task, each independently meaningful.

---

## Notes for the implementer

**If the Bulk API rejects OAuth entirely.** The plan assumes the Comms scopes on the OAuth app authenticate `comms.twilio.com`, which the repo owner confirmed from the Console but which no documentation states. If Task 12 returns `401` with a valid token, stop and raise it — the fallback is collecting an API Key SID and Secret for this mode alone, which changes the sign-in form and is a design decision, not an implementation detail.

**Do not "fix" the classic path here.** It has a known Sync storage ceiling of roughly 40–60 recipients and a duplicate-send risk, specced separately in `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md`. Bulk mode sidesteps both by storing no recipient list. Leave the classic path alone.

**`accepted` is not `sent`.** If you find yourself renaming that field or that label to match the classic path's wording, don't. A `202` means Twilio took the request; nothing has been delivered yet, and the two modes genuinely differ here.

**Line numbers are from `main` at commit `c53e3ab`.** They were checked against the files, but `assets/app.js` is 1,848 lines and every task after Task 15 shifts the ones below it. Treat them as starting points and confirm by the surrounding code, not the number.

**Reuse, don't re-render.** Three places already do work the bulk path needs: `displayCampaigns` draws the campaign card from `list-campaigns.js`'s fields, `displayMessageDetails` draws the delivery table from a `statuses` map, and `exportMessageStatusCsv` exports whatever `displayMessageDetails` was last given. The plan feeds all three rather than adding bulk equivalents. If you find yourself writing a second renderer, re-read Task 17.
