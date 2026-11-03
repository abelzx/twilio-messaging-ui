# Campaign Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what each campaign was sent with (sender, Content Template, message, media, recipients, bulk settings) and show it on the campaign card and in the delivery panel.

**Architecture:** A new private asset, `assets/campaign-details.private.js`, holds three pure functions. `buildDetails` runs in the two send Functions and stores one `details` object on the campaign's Sync Document at creation. `resolveDetails` and `summaryLine` run in the read Functions and turn any campaign doc, new or old, into a display shape. The browser collects the labels only it knows at send time and renders the display shape.

**Tech Stack:** Twilio Functions (runtime `node24`), Twilio Sync, vanilla browser JS in `assets/app.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-03-campaign-details-design.md`

## Global Constraints

- No new dependencies. Tests run with `npm test` (`node --test test/*.js`).
- Private assets are required as `require(Runtime.getAssets()['/campaign-details.js'].path)`; tests require `../assets/campaign-details.private.js`.
- `details` is written on create only, never updated.
- Serialised `details` fits in 2 KiB (`MAX_DETAILS_BYTES = 2 * 1024`). Over budget, drop media, then variable values, then body.
- Caps: sender label, template name, file name 120 chars; language 16; body 500; variables 10 keys, key 40, value 100; media 3 URLs of at most 300 chars (longer URLs dropped, not truncated).
- Classic `details` never stores body or variable values; `messages[0]` already holds them.
- A template overrides any body on both APIs, so a body sent with a template is not recorded or shown.
- Every value rendered in the browser goes through `escapeHtml`. A media URL is a link only when it starts with `http://` or `https://`, with `target="_blank" rel="noopener noreferrer"`.
- CSV export is unchanged.
- Functions use 2-space indent; `assets/app.js` uses 4-space. Match the comment density of the surrounding code.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `assets/campaign-details.private.js` | create | `buildDetails`, `resolveDetails`, `summaryLine` |
| `test/campaign-details.test.js` | create | unit tests for the module |
| `functions/send-bulk.js` | modify | store `details` on create |
| `functions/send-messages.js` | modify | store `details` on create |
| `functions/check-status.js` | modify | return `mode` and `details` |
| `functions/check-bulk-status.js` | modify | return `details` (both response bodies) |
| `functions/list-campaigns.js` | modify | return `summary` per campaign |
| `assets/app.js` | modify | collect labels at send; render card line and details block |
| `assets/styles.css` | modify | `.campaign-summary`, `.campaign-details` |

---

### Task 0: Commit the pending bulk-snapshot work

The working tree holds finished, uncommitted work that saves bulk delivery rows to Sync (`assets/bulk-snapshot.private.js`, its test, and edits to `functions/check-bulk-status.js`, `assets/app.js`, `assets/styles.css`). Tasks 2 and 4 edit three of those files. Commit it first so this feature's commits contain only this feature.

- [ ] **Step 1: Confirm the tests pass**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`

- [ ] **Step 2: Commit**

```bash
git add assets/bulk-snapshot.private.js test/bulk-snapshot.test.js functions/check-bulk-status.js assets/app.js assets/styles.css
git commit -m "feat: keep bulk delivery rows in Sync once Twilio expires them

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Confirm a clean tree**

Run: `git status --short`
Expected: no output.

---

### Task 1: The campaign-details module

**Files:**
- Create: `assets/campaign-details.private.js`
- Test: `test/campaign-details.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildDetails(input: any, facts: { mode: 'bulk'|'classic', contentSid?: string|null, recipientCount: number, body?: string, perRecipientBody?: boolean, fallbackToSms?: boolean|null }) => StoredDetails`
  - `StoredDetails = { sender: { label, kind }, template: { sid, name, language }|null, message: { body, perRecipient }, variables: { values, perRecipient }|null, media: { urls, perRecipient }|null, recipients: { source: 'typed'|'csv', fileName, count }, fallbackToSms: boolean|null }`
  - `resolveDetails(campaignData: object) => { mode, channel, sender: { label, kind, address }, template: {sid,name,language}|{notRecorded:true}|null, message: {body,perRecipient}|{notRecorded:true}|null, variables: {values,perRecipient}|null, media: {urls,perRecipient}|null, recipients: { source, fileName, count }, scheduledFor, fallbackToSms, operationIds: string[]|null }`
  - `summaryLine(campaignData: object) => { channel: string|null, sender: string|null, template: string|null }`
  - `MAX_DETAILS_BYTES` (2048)

- [ ] **Step 1: Write the failing tests**

Create `test/campaign-details.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const details = require('../assets/campaign-details.private.js');

const HX = `HX${'a'.repeat(32)}`;
const MG = `MG${'b'.repeat(32)}`;

const BULK_INPUT = {
  sender: { label: 'Acme Service · MGbbbbbbbb…', kind: 'service' },
  template: { name: 'promo_v2', language: 'en' },
  message: { perRecipient: false },
  variables: { values: { 1: 'Sarah' }, perRecipient: false },
  media: { urls: ['https://example.com/a.jpg'], perRecipient: false },
  recipients: { source: 'csv', fileName: 'spring.csv' },
};

const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('buildDetails keeps the browser labels alongside the server facts', () => {
  const out = details.buildDetails(BULK_INPUT, {
    mode: 'bulk', contentSid: HX, body: '', recipientCount: 120, fallbackToSms: true,
  });
  assert.deepStrictEqual(out, {
    sender: { label: 'Acme Service · MGbbbbbbbb…', kind: 'service' },
    template: { sid: HX, name: 'promo_v2', language: 'en' },
    message: { body: null, perRecipient: false },
    variables: { values: { 1: 'Sarah' }, perRecipient: false },
    media: { urls: ['https://example.com/a.jpg'], perRecipient: false },
    recipients: { source: 'csv', fileName: 'spring.csv', count: 120 },
    fallbackToSms: true,
  });
});

test('a template name with no template SID behind it is dropped', () => {
  const out = details.buildDetails(BULK_INPUT, { mode: 'bulk', contentSid: null, body: 'Hi', recipientCount: 1 });
  assert.strictEqual(out.template, null);
  assert.strictEqual(out.variables, null);
  assert.strictEqual(out.media, null);
  assert.deepStrictEqual(out.message, { body: 'Hi', perRecipient: false });
});

test('a body sent alongside a template is not recorded as the message', () => {
  const out = details.buildDetails({}, { mode: 'bulk', contentSid: HX, body: 'Hi', recipientCount: 1 });
  assert.deepStrictEqual(out.message, { body: null, perRecipient: false });
});

test('the server\'s per-recipient body fact wins over the browser\'s flag', () => {
  const out = details.buildDetails(
    { message: { perRecipient: false } },
    { mode: 'bulk', body: 'fallback text', perRecipientBody: true, recipientCount: 2 }
  );
  assert.deepStrictEqual(out.message, { body: null, perRecipient: true });
});

test('classic leaves out the body and variable values, keeping the flags', () => {
  const out = details.buildDetails(
    { message: { perRecipient: true }, variables: { values: { 1: 'Sarah' }, perRecipient: false } },
    { mode: 'classic', contentSid: HX, body: 'ignored', recipientCount: 3 }
  );
  assert.deepStrictEqual(out.variables, { values: null, perRecipient: false });
  assert.deepStrictEqual(out.message, { body: null, perRecipient: false });

  const typed = details.buildDetails({}, { mode: 'classic', body: 'Hi', recipientCount: 1 });
  assert.strictEqual(typed.message.body, null);
});

test('strings are trimmed and capped; anything else is dropped', () => {
  const out = details.buildDetails(
    {
      sender: { label: `  ${'x'.repeat(200)}  `, kind: 'admin' },
      template: { name: 42, language: 'en-US-x-twilio-very-long' },
      recipients: { source: 'csv', fileName: ['a.csv'] },
    },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.strictEqual(out.sender.label.length, 120);
  assert.ok(out.sender.label.endsWith('…'));
  assert.strictEqual(out.sender.kind, null);
  assert.strictEqual(out.template.name, null);
  assert.strictEqual(out.template.language.length, 16);
  assert.strictEqual(out.recipients.fileName, null);
});

test('variables are capped at 10 keys and blank values are dropped', () => {
  const values = {};
  for (let i = 1; i <= 15; i++) values[i] = `v${i}`;
  values[3] = '   ';
  const out = details.buildDetails(
    { variables: { values } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.strictEqual(Object.keys(out.variables.values).length, 10);
  assert.strictEqual(out.variables.values[3], undefined);
});

test('media URLs over 300 chars are dropped, not truncated, and duplicates collapse', () => {
  const long = `https://example.com/${'p'.repeat(300)}`;
  const out = details.buildDetails(
    { media: { urls: [long, 'https://a.example/1.jpg', 'https://a.example/1.jpg', 7] } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.deepStrictEqual(out.media, { urls: ['https://a.example/1.jpg'], perRecipient: false });
});

test('an invalid content SID records no template', () => {
  const out = details.buildDetails(BULK_INPUT, { mode: 'bulk', contentSid: 'HXnope', body: 'Hi', recipientCount: 1 });
  assert.strictEqual(out.template, null);
});

test('malformed input costs the labels, never the facts', () => {
  for (const input of [undefined, null, 'details', ['x'], 5]) {
    const out = details.buildDetails(input, { mode: 'bulk', body: 'Hi', recipientCount: 4, fallbackToSms: false });
    assert.deepStrictEqual(out.sender, { label: null, kind: null });
    assert.deepStrictEqual(out.message, { body: 'Hi', perRecipient: false });
    assert.deepStrictEqual(out.recipients, { source: 'typed', fileName: null, count: 4 });
    assert.strictEqual(out.fallbackToSms, false);
  }
});

test('over budget, media is dropped first', () => {
  const values = {};
  for (let i = 1; i <= 10; i++) values[i] = 'v'.repeat(100);
  const urls = [1, 2, 3].map((n) => `https://example.com/${String(n).repeat(280)}`);
  const out = details.buildDetails(
    { variables: { values }, media: { urls } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.strictEqual(out.media, null);
  assert.strictEqual(Object.keys(out.variables.values).length, 10);
  assert.ok(size(out) <= details.MAX_DETAILS_BYTES);
});

test('over budget after media, variable values go next', () => {
  const values = {};
  for (let i = 1; i <= 10; i++) values[i] = '漢'.repeat(100);
  const out = details.buildDetails(
    { variables: { values } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.deepStrictEqual(out.variables, { values: null, perRecipient: false });
  assert.ok(size(out) <= details.MAX_DETAILS_BYTES);
});

test('over budget with no template, the body goes last', () => {
  const label = '漢'.repeat(120);
  const out = details.buildDetails(
    { sender: { label }, recipients: { source: 'csv', fileName: label } },
    { mode: 'bulk', body: '漢'.repeat(500), recipientCount: 1 }
  );
  assert.strictEqual(out.message.body, null);
  assert.strictEqual(out.sender.label, label);
  assert.ok(size(out) <= details.MAX_DETAILS_BYTES);
});

const NEW_BULK_DOC = {
  mode: 'bulk',
  channel: 'whatsapp',
  from: MG,
  scheduledFor: '2026-11-04T01:30:00.000Z',
  recipientCount: 120,
  operationIds: ['01JBOP', '01JCOP'],
  details: details.buildDetails(BULK_INPUT, {
    mode: 'bulk', contentSid: HX, recipientCount: 120, fallbackToSms: true,
  }),
};

test('resolveDetails shows a new bulk campaign in full', () => {
  assert.deepStrictEqual(details.resolveDetails(NEW_BULK_DOC), {
    mode: 'bulk',
    channel: 'whatsapp',
    sender: { label: 'Acme Service · MGbbbbbbbb…', kind: 'service', address: MG },
    template: { sid: HX, name: 'promo_v2', language: 'en' },
    message: null,
    variables: { values: { 1: 'Sarah' }, perRecipient: false },
    media: { urls: ['https://example.com/a.jpg'], perRecipient: false },
    recipients: { source: 'csv', fileName: 'spring.csv', count: 120 },
    scheduledFor: '2026-11-04T01:30:00.000Z',
    fallbackToSms: true,
    operationIds: ['01JBOP', '01JCOP'],
  });
});

test('resolveDetails marks what an old bulk campaign never recorded', () => {
  const out = details.resolveDetails({
    mode: 'bulk', channel: 'sms', from: '+15017122661', recipientCount: 3, operationIds: ['01JBOP'],
  });
  assert.deepStrictEqual(out.sender, { label: null, kind: 'direct', address: '+15017122661' });
  assert.deepStrictEqual(out.template, { notRecorded: true });
  assert.deepStrictEqual(out.message, { notRecorded: true });
  assert.strictEqual(out.variables, null);
  assert.deepStrictEqual(out.recipients, { source: null, fileName: null, count: 3 });
  assert.strictEqual(out.fallbackToSms, null);
});

test('resolveDetails derives an old classic campaign from messages[0]', () => {
  const out = details.resolveDetails({
    channel: 'sms',
    from: MG,
    totalMessages: 2,
    messages: [{ to: '+15558675310', from: MG, body: 'Hi there' }],
  });
  assert.deepStrictEqual(out.sender, { label: null, kind: 'service', address: MG });
  assert.strictEqual(out.template, null);
  assert.deepStrictEqual(out.message, { body: 'Hi there', perRecipient: false });
  assert.strictEqual(out.variables, null);
  assert.deepStrictEqual(out.recipients, { source: null, fileName: null, count: 2 });
  assert.strictEqual(out.operationIds, null);
});

test('resolveDetails reads an old classic template and its JSON-string variables', () => {
  const out = details.resolveDetails({
    channel: 'whatsapp',
    from: '+15017122661',
    totalMessages: 1,
    messages: [{ contentSid: HX, contentVariables: '{"1":"Sarah"}', body: 'typed too' }],
  });
  assert.deepStrictEqual(out.template, { sid: HX, name: null, language: null });
  assert.strictEqual(out.message, null);
  assert.deepStrictEqual(out.variables, { values: { 1: 'Sarah' }, perRecipient: false });
});

test('resolveDetails trusts a classic per-recipient flag over messages[0]', () => {
  const withVariables = details.resolveDetails({
    channel: 'sms',
    from: '+15017122661',
    totalMessages: 2,
    messages: [{ contentSid: HX, contentVariables: { 1: 'Row one' } }],
    details: details.buildDetails(
      { template: { name: 'promo_v2', language: 'en' }, variables: { perRecipient: true } },
      { mode: 'classic', contentSid: HX, recipientCount: 2 }
    ),
  });
  assert.deepStrictEqual(withVariables.template, { sid: HX, name: 'promo_v2', language: 'en' });
  assert.deepStrictEqual(withVariables.variables, { values: null, perRecipient: true });

  const withBodies = details.resolveDetails({
    channel: 'sms',
    from: '+15017122661',
    totalMessages: 2,
    messages: [{ body: 'Row one text' }],
    details: details.buildDetails({ message: { perRecipient: true } }, { mode: 'classic', recipientCount: 2 }),
  });
  assert.deepStrictEqual(withBodies.message, { body: null, perRecipient: true });
});

test('resolveDetails survives a document with nothing in it', () => {
  const out = details.resolveDetails(null);
  assert.strictEqual(out.mode, 'classic');
  assert.deepStrictEqual(out.sender, { label: null, kind: null, address: null });
  assert.strictEqual(out.template, null);
  assert.strictEqual(out.message, null);
});

test('summaryLine prefers labels and falls back to raw values', () => {
  assert.deepStrictEqual(details.summaryLine(NEW_BULK_DOC), {
    channel: 'whatsapp', sender: 'Acme Service · MGbbbbbbbb…', template: 'promo_v2',
  });
  assert.deepStrictEqual(
    details.summaryLine({ mode: 'bulk', channel: 'sms', from: '+15017122661' }),
    { channel: 'sms', sender: '+15017122661', template: null }
  );
  assert.deepStrictEqual(
    details.summaryLine({ channel: 'sms', from: '+15017122661', messages: [{ contentSid: HX }] }),
    { channel: 'sms', sender: '+15017122661', template: HX }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/campaign-details.test.js 2>&1 | grep -E "Cannot find module|ℹ fail"`
Expected: `Cannot find module '../assets/campaign-details.private.js'` and `ℹ fail 1`

- [ ] **Step 3: Write the module**

Create `assets/campaign-details.private.js`:

```js
/**
 * What a campaign was sent with — sender, template, message, recipients — for
 * the campaign card and the delivery panel.
 *
 * Recorded once, when the campaign is created. The browser supplies the labels
 * only it knows (dropdown text, template name, CSV file name, the template's
 * media with shared variables filled in). The send Function supplies the facts
 * it actually sent, and those win over anything the browser claims for the
 * same field: a template name with no template SID behind it is dropped.
 *
 * A classic campaign document already holds the recipient list and every
 * message status, and sits close to Sync's 16 KiB item limit (see
 * docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md). So a
 * classic `details` leaves out the body and variable values, which
 * `messages[0]` already holds, and every `details` is held to 2 KiB.
 *
 * This is a *private* asset. Require it as:
 *
 *   const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
 */

'use strict';

/**
 * Serialised size ceiling. Every classic checkpoint rewrites the whole
 * document, and a write over 16 KiB fails after the chunk has already been
 * sent, so this field must not eat into that headroom.
 */
const MAX_DETAILS_BYTES = 2 * 1024;

const LIMITS = {
  label: 120,
  language: 16,
  body: 500,
  variableCount: 10,
  variableKey: 40,
  variableValue: 100,
  mediaCount: 3,
  mediaUrl: 300,
};

const SENDER_KINDS = new Set(['direct', 'service', 'pool', 'typed']);
const CONTENT_SID = /^HX[0-9a-f]{32}$/i;
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Trimmed and capped, or null for anything that is not a non-empty string. */
function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function contentSidOf(value) {
  const sid = typeof value === 'string' ? value.trim() : '';
  return CONTENT_SID.test(sid) ? sid : null;
}

/** Accepts an object or the JSON string send-messages.js may have stored. */
function cleanVariables(values) {
  let source = values;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (error) {
      return null;
    }
  }
  source = asObject(source);
  if (!source) return null;

  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(out).length >= LIMITS.variableCount) break;
    const cleanKey = text(key, LIMITS.variableKey);
    const cleanValue = text(typeof value === 'number' ? String(value) : value, LIMITS.variableValue);
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
  }
  return Object.keys(out).length ? out : null;
}

function cleanMedia(media) {
  const source = asObject(media) || {};
  const urls = [...new Set(
    (Array.isArray(source.urls) ? source.urls : [])
      .filter((url) => typeof url === 'string')
      .map((url) => url.trim())
      // Dropped rather than truncated: a cut-off URL is a broken link.
      .filter((url) => url && url.length <= LIMITS.mediaUrl)
  )].slice(0, LIMITS.mediaCount);
  const perRecipient = source.perRecipient === true;
  return urls.length || perRecipient ? { urls, perRecipient } : null;
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Drops media, then variable values, then body, until the budget is met. */
function fitBudget(details) {
  const drops = [
    () => { details.media = null; },
    () => { if (details.variables) details.variables.values = null; },
    () => { details.message.body = null; },
  ];
  for (const drop of drops) {
    if (byteSize(details) <= MAX_DETAILS_BYTES) break;
    drop();
  }
  return details;
}

/**
 * The `details` object stored on a new campaign document.
 *
 * `input` is the browser's `event.details` and may be anything, including
 * absent; a malformed one costs the labels, never the send. `facts` comes from
 * the send Function:
 *
 *   { mode: 'bulk' | 'classic', contentSid, recipientCount,
 *     body?, perRecipientBody?, fallbackToSms? }
 */
function buildDetails(input, facts) {
  const given = asObject(input) || {};
  const known = asObject(facts) || {};
  const classic = known.mode === 'classic';

  const sender = asObject(given.sender) || {};
  const template = asObject(given.template) || {};
  const message = asObject(given.message) || {};
  const variables = asObject(given.variables) || {};
  const recipients = asObject(given.recipients) || {};

  const contentSid = contentSidOf(known.contentSid);

  // A template overrides any body on both APIs, so text sent alongside one
  // never reached anybody and is not recorded as the message.
  const bodyPerRecipient = !contentSid &&
    (typeof known.perRecipientBody === 'boolean' ? known.perRecipientBody : message.perRecipient === true);
  const variablesPerRecipient = Boolean(contentSid) && variables.perRecipient === true;
  const csv = recipients.source === 'csv';

  return fitBudget({
    sender: {
      label: text(sender.label, LIMITS.label),
      kind: SENDER_KINDS.has(sender.kind) ? sender.kind : null,
    },
    template: contentSid
      ? {
          sid: contentSid,
          name: text(template.name, LIMITS.label),
          language: text(template.language, LIMITS.language),
        }
      : null,
    message: {
      body: classic || contentSid || bodyPerRecipient ? null : text(known.body, LIMITS.body),
      perRecipient: bodyPerRecipient,
    },
    variables: contentSid
      ? {
          values: classic || variablesPerRecipient ? null : cleanVariables(variables.values),
          perRecipient: variablesPerRecipient,
        }
      : null,
    media: contentSid ? cleanMedia(given.media) : null,
    recipients: {
      source: csv ? 'csv' : 'typed',
      fileName: csv ? text(recipients.fileName, LIMITS.label) : null,
      count: Number.isFinite(known.recipientCount) ? known.recipientCount : 0,
    },
    fallbackToSms: typeof known.fallbackToSms === 'boolean' ? known.fallbackToSms : null,
  });
}

/** null when there is nothing to show, so the row can be hidden. */
function presentMessage(value) {
  const message = asObject(value);
  return message && (message.body || message.perRecipient)
    ? { body: message.body || null, perRecipient: message.perRecipient === true }
    : null;
}

function presentVariables(value) {
  const variables = asObject(value);
  return variables && (variables.values || variables.perRecipient)
    ? { values: variables.values || null, perRecipient: variables.perRecipient === true }
    : null;
}

/**
 * The display shape for one campaign document, new or old.
 *
 * A document from before `details` existed gets what can be derived: a classic
 * one from `messages[0]`, a bulk one only its channel and sender. Bulk never
 * stored its template or body, so those are marked `{ notRecorded: true }`
 * rather than shown as absent.
 */
function resolveDetails(campaignData) {
  const data = asObject(campaignData) || {};
  const bulk = data.mode === 'bulk';
  const stored = asObject(data.details);
  const first = (!bulk && Array.isArray(data.messages) && asObject(data.messages[0])) || {};
  const from = typeof data.from === 'string' && data.from.trim() ? data.from.trim() : null;

  const storedSender = (stored && asObject(stored.sender)) || {};
  const sender = {
    label: storedSender.label || null,
    kind: storedSender.kind ||
      (from ? (MESSAGING_SERVICE_SID.test(from) ? 'service' : 'direct') : null),
    address: from,
  };

  let template;
  let message;
  let variables;
  if (bulk) {
    template = stored ? asObject(stored.template) : { notRecorded: true };
    message = stored ? presentMessage(stored.message) : { notRecorded: true };
    variables = stored ? presentVariables(stored.variables) : null;
  } else {
    // messages[0] holds only the first recipient's values. When the stored
    // flags say a CSV varied them per recipient, they are not the campaign's.
    const contentSid = contentSidOf(first.contentSid);
    const storedTemplate = (stored && asObject(stored.template)) || {};
    const storedMessage = (stored && asObject(stored.message)) || {};
    const storedVariables = (stored && asObject(stored.variables)) || {};

    template = contentSid
      ? { sid: contentSid, name: storedTemplate.name || null, language: storedTemplate.language || null }
      : null;
    message = contentSid ? null : presentMessage({
      body: storedMessage.perRecipient ? null : text(first.body, LIMITS.body),
      perRecipient: storedMessage.perRecipient === true,
    });
    variables = contentSid ? presentVariables({
      values: storedVariables.perRecipient ? null : cleanVariables(first.contentVariables),
      perRecipient: storedVariables.perRecipient === true,
    }) : null;
  }

  const storedRecipients = (stored && asObject(stored.recipients)) || {};

  return {
    mode: bulk ? 'bulk' : 'classic',
    channel: typeof data.channel === 'string' && data.channel ? data.channel : null,
    sender,
    template,
    message,
    variables,
    media: (stored && asObject(stored.media)) || null,
    recipients: {
      source: storedRecipients.source || null,
      fileName: storedRecipients.fileName || null,
      count: Number((bulk ? data.recipientCount : data.totalMessages) || 0),
    },
    scheduledFor: bulk ? data.scheduledFor || null : null,
    fallbackToSms: bulk && stored && typeof stored.fallbackToSms === 'boolean' ? stored.fallbackToSms : null,
    operationIds: bulk && Array.isArray(data.operationIds) ? data.operationIds : null,
  };
}

/** The three strings on a campaign card's summary line, any of them null. */
function summaryLine(campaignData) {
  const details = resolveDetails(campaignData);
  const template = details.template && !details.template.notRecorded ? details.template : null;
  return {
    channel: details.channel,
    sender: details.sender.label || details.sender.address,
    template: template ? template.name || template.sid : null,
  };
}

module.exports = {
  buildDetails,
  resolveDetails,
  summaryLine,
  MAX_DETAILS_BYTES,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`, with 20 more passing tests than before this task.

- [ ] **Step 5: Commit**

```bash
git add assets/campaign-details.private.js test/campaign-details.test.js
git commit -m "feat: record and resolve what a campaign was sent with

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Store and return details in the Functions

**Files:**
- Modify: `functions/send-bulk.js` (require block; `documents.create` data)
- Modify: `functions/send-messages.js` (require block; `documents.create` data)
- Modify: `functions/check-status.js` (require block; response `campaign`)
- Modify: `functions/check-bulk-status.js` (require block; both response `campaign` objects)
- Modify: `functions/list-campaigns.js` (require block; both `campaigns.push` calls)

**Interfaces:**
- Consumes: `buildDetails`, `resolveDetails`, `summaryLine` from Task 1.
- Produces:
  - `send-bulk` and `send-messages` accept an optional `event.details` (browser shape, Task 3).
  - `check-status` response `campaign.mode === 'classic'` and `campaign.details` (resolveDetails output).
  - `check-bulk-status` response `campaign.details` (resolveDetails output).
  - `list-campaigns` response: each campaign has `summary` (summaryLine output).

These Functions read the `Runtime` global and have no unit harness in this repo. Verification is a syntax check plus the module tests, then the manual check in Task 5.

- [ ] **Step 1: `send-bulk.js` — require the module**

After the line `const bulk = require(Runtime.getAssets()['/bulk-payload.js'].path);` add:

```js
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
```

- [ ] **Step 2: `send-bulk.js` — store `details`**

In the `documents.create` data, replace:

```js
        scheduledFor: event.sendAt || null,
        stats: null,
```

with:

```js
        scheduledFor: event.sendAt || null,
        // What the campaign was sent with, for the card and the delivery
        // panel. The browser supplies labels; these facts are what was sent.
        details: campaignDetails.buildDetails(event.details, {
          mode: 'bulk',
          contentSid: event.contentSid,
          body: event.body,
          perRecipientBody:
            Array.isArray(event.recipients) &&
            event.recipients.some(
              (recipient) => recipient && String(recipient.body == null ? '' : recipient.body).trim() !== ''
            ),
          recipientCount,
          fallbackToSms:
            String(event.channel || '').toLowerCase() === 'whatsapp' ? Boolean(event.fallbackToSms) : null,
        }),
        stats: null,
```

- [ ] **Step 3: `send-messages.js` — require the module**

After the line `const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);` add:

```js
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
```

- [ ] **Step 4: `send-messages.js` — store `details` on create**

In the `documents.create` data, replace:

```js
          campaignName: campaignName || null,
          createdAt: new Date().toISOString(),
```

with:

```js
          campaignName: campaignName || null,
          // What the campaign was sent with, for the card and the delivery
          // panel. Body and variables are not repeated here: messages[0]
          // already holds them, and this document is near Sync's size limit.
          details: campaignDetails.buildDetails(event.details, {
            mode: 'classic',
            contentSid: messages[0] && messages[0].contentSid,
            recipientCount: messages.length,
          }),
          createdAt: new Date().toISOString(),
```

- [ ] **Step 5: `check-status.js` — require the module and return `details`**

After the line `const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);` add:

```js
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
```

In the success response, replace:

```js
      campaign: {
        campaignId,
        totalMessages: campaignData.totalMessages,
```

with:

```js
      campaign: {
        campaignId,
        mode: 'classic',
        totalMessages: campaignData.totalMessages,
```

and replace:

```js
        channel: campaignData.channel || null,
        from: campaignData.from || null
      }
```

with:

```js
        channel: campaignData.channel || null,
        from: campaignData.from || null,
        details: campaignDetails.resolveDetails(campaignData)
      }
```

- [ ] **Step 6: `check-bulk-status.js` — require the module and return `details`**

After the line `const snapshot = require(Runtime.getAssets()['/bulk-snapshot.js'].path);` add:

```js
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
```

In the `trackingUnavailable` response, replace:

```js
          operationIds: [],
          operationStatuses: [],
```

with:

```js
          operationIds: [],
          details: campaignDetails.resolveDetails(campaignData),
          operationStatuses: [],
```

In the main success response, replace:

```js
        operationIds,
        operationStatuses,
```

with:

```js
        operationIds,
        details: campaignDetails.resolveDetails(campaignData),
        operationStatuses,
```

- [ ] **Step 7: `list-campaigns.js` — require the module and return `summary`**

After the line `const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);` add:

```js
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
```

In the bulk `campaigns.push`, replace:

```js
          channel: campaignData.channel || null,
          recipientCount: campaignData.recipientCount || 0,
```

with:

```js
          channel: campaignData.channel || null,
          summary: campaignDetails.summaryLine(campaignData),
          recipientCount: campaignData.recipientCount || 0,
```

In the classic `campaigns.push`, replace:

```js
        lastUpdated: campaignData.lastUpdated,
        campaignName: campaignData.campaignName || null
      });
```

with:

```js
        lastUpdated: campaignData.lastUpdated,
        campaignName: campaignData.campaignName || null,
        summary: campaignDetails.summaryLine(campaignData)
      });
```

- [ ] **Step 8: Syntax-check every changed Function and run the tests**

Run: `for f in send-bulk send-messages check-status check-bulk-status list-campaigns; do node --check functions/$f.js || echo "FAIL $f"; done; npm test 2>&1 | tail -8`
Expected: no `FAIL` lines; `ℹ fail 0`.

- [ ] **Step 9: Confirm each Function requires the module exactly once**

Run: `grep -c "campaign-details.js" functions/send-bulk.js functions/send-messages.js functions/check-status.js functions/check-bulk-status.js functions/list-campaigns.js`
Expected: every file reports `1`.

- [ ] **Step 10: Commit**

```bash
git add functions/send-bulk.js functions/send-messages.js functions/check-status.js functions/check-bulk-status.js functions/list-campaigns.js
git commit -m "feat: store campaign details on send and return them on read

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Collect the labels in the browser at send time

**Files:**
- Modify: `assets/app.js` — `renderSenderOptions` (`addGroup`), `handleSendMessages`, `sendMessagesBatch`, `sendBulkCampaign`; new functions `templateMediaDetails`, `collectCampaignDetails` placed directly after `buildMessage`.

**Interfaces:**
- Consumes: existing `selectedTemplate()`, `csvIsActive()`, `csvUpload` (`mode` is `'body'` or `'variables'`, `fileName`), `getSelectedContentVariables()`, `collectMediaStrings(obj, acc)`.
- Produces: `collectCampaignDetails() => { sender: { label, kind }, template: { name, language }|null, message: { perRecipient }, variables: { values, perRecipient }|null, media: { urls, perRecipient }|null, recipients: { source: 'csv', fileName }|{ source: 'typed' } }`, sent as `details` to `send-bulk` and to the first `send-messages` call.

- [ ] **Step 1: Tag each sender option with its kind**

In `renderSenderOptions`, inside `addGroup`, replace:

```js
            opt.value = sender.value;
            opt.textContent = sender.label;
```

with:

```js
            opt.value = sender.value;
            opt.textContent = sender.label;
            // Recorded with the campaign, so its details can name the kind.
            opt.dataset.kind = sender.kind;
```

- [ ] **Step 2: Add `templateMediaDetails` and `collectCampaignDetails`**

Directly after the closing `}` of `function buildMessage(...)`, add:

```js
/**
 * The selected template's media as recipients receive it: each `media` entry
 * with the shared variable values filled in. An entry whose placeholder a CSV
 * fills row by row has no single URL, so it is reported as per-recipient.
 */
function templateMediaDetails(template, sharedVariables, usingCsv) {
    const entries = [];
    collectMediaStrings(template.types || {}, entries);

    const placeholder = /\{\{\s*([\w.-]+)\s*\}\}/g;
    const urls = [];
    let perRecipient = false;
    for (const entry of entries) {
        if (!entry.match(placeholder)) {
            urls.push(entry);
        } else if (usingCsv) {
            perRecipient = true;
        } else {
            urls.push(entry.replace(placeholder, (match, key) =>
                (sharedVariables && sharedVariables[key]) || match));
        }
    }
    return urls.length || perRecipient ? { urls, perRecipient } : null;
}

/**
 * What only this page knows about the campaign being sent: what the sender and
 * template are called, where the recipients came from, and the template's
 * media. The send Function stores it beside the facts it actually sent (see
 * campaign-details.private.js), so a campaign still says what it was sent with
 * after these dropdowns have moved on to another channel.
 */
function collectCampaignDetails() {
    const fromSelect = document.getElementById('from-number-select');
    const option = fromSelect.value ? fromSelect.selectedOptions[0] : null;
    const template = selectedTemplate();
    const usingCsv = csvIsActive();
    const sharedVariables = template && !usingCsv ? getSelectedContentVariables() : null;

    return {
        sender: option
            ? { label: option.textContent, kind: option.dataset.kind || null }
            : { label: null, kind: 'typed' },
        template: template ? { name: template.friendlyName, language: template.language } : null,
        message: { perRecipient: usingCsv && csvUpload.mode === 'body' },
        variables: template
            ? { values: sharedVariables, perRecipient: usingCsv && csvUpload.mode === 'variables' }
            : null,
        media: template ? templateMediaDetails(template, sharedVariables, usingCsv) : null,
        recipients: usingCsv
            ? { source: 'csv', fileName: csvUpload.fileName }
            : { source: 'typed' },
    };
}
```

- [ ] **Step 3: Collect the details in `handleSendMessages` and pass them on**

In `handleSendMessages`, replace:

```js
    try {
        if (isBulkMode()) {
            await sendBulkCampaign(messages, channel, from, campaignName);
        } else {
            await sendMessagesBatch(messages, channel, from, campaignName);
        }
```

with:

```js
    const details = collectCampaignDetails();

    try {
        if (isBulkMode()) {
            await sendBulkCampaign(messages, channel, from, campaignName, details);
        } else {
            await sendMessagesBatch(messages, channel, from, campaignName, details);
        }
```

- [ ] **Step 4: Send `details` from `sendMessagesBatch` on the first call only**

Replace:

```js
async function sendMessagesBatch(messages, channel, from, campaignName) {
```

with:

```js
async function sendMessagesBatch(messages, channel, from, campaignName, details) {
```

and replace:

```js
                resumeFrom,
                campaignName: campaignName || null
            });
```

with:

```js
                resumeFrom,
                campaignName: campaignName || null,
                // Stored only when the first call creates the campaign.
                ...(resumeFrom === 0 ? { details } : {})
            });
```

- [ ] **Step 5: Send `details` from `sendBulkCampaign`**

Replace:

```js
async function sendBulkCampaign(messages, channel, from, campaignName) {
```

with:

```js
async function sendBulkCampaign(messages, channel, from, campaignName, details) {
```

and replace:

```js
        campaignName: campaignName || null,
        sendAt,
        fallbackToSms: Boolean(fallbackInput && fallbackInput.checked),
    });
```

with:

```js
        campaignName: campaignName || null,
        sendAt,
        fallbackToSms: Boolean(fallbackInput && fallbackInput.checked),
        details,
    });
```

- [ ] **Step 6: Syntax-check and confirm every call site passes `details`**

Run: `node --check assets/app.js && grep -n "sendBulkCampaign(\|sendMessagesBatch(" assets/app.js`
Expected: no syntax error; the two definitions and the two calls in `handleSendMessages` all end in `details)` or `details) {`.

- [ ] **Step 7: Commit**

```bash
git add assets/app.js
git commit -m "feat: send the sender, template and recipient labels with each campaign

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Show the details on the card and in the delivery panel

**Files:**
- Modify: `assets/app.js` — new `channelLabel`, `campaignSummaryText`, `SENDER_KIND_LABEL`, `renderCampaignDetails` placed directly before `function displayCampaigns`; edits in `displayCampaigns`, `fetchAndDisplayCampaignDetails`, `displayMessageDetails`.
- Modify: `assets/styles.css` — new rules after the `.details-note` rule.

**Interfaces:**
- Consumes: `campaign.summary` from `list-campaigns` (Task 2); `campaign.details` from `check-status` and `check-bulk-status` (Task 2); existing `escapeHtml`, `loadedTemplates`, `renderUnchanged`.
- Produces: `renderCampaignDetails(details) => string` (HTML), `campaignSummaryText(summary) => string` (escaped text).

- [ ] **Step 1: Add the rendering helpers**

Directly before `function displayCampaigns(campaigns) {`, add:

```js
/** The channel's name as the Messaging Channel dropdown shows it. */
function channelLabel(channel) {
    if (!channel) return '';
    const option = document.querySelector(`#channel option[value="${CSS.escape(channel)}"]`);
    return option ? option.textContent : channel;
}

/** The card's "WhatsApp · Acme Service · promo_v2" line, escaped; '' when nothing is known. */
function campaignSummaryText(summary) {
    if (!summary) return '';
    return [channelLabel(summary.channel), summary.sender, summary.template]
        .filter(Boolean)
        .map(escapeHtml)
        .join(' · ');
}

const SENDER_KIND_LABEL = {
    service: 'Messaging Service',
    pool: 'Sender pool',
    typed: 'Typed sender',
};

/**
 * The "Campaign details" block above the delivery totals. `details` is
 * resolveDetails() output from campaign-details.private.js. A row with nothing
 * to say is left out. Every value is escaped: all of it was typed by someone.
 */
function renderCampaignDetails(details) {
    if (!details) return '';

    const rows = [];
    const add = (label, html) => {
        if (html) rows.push(`<dt>${label}</dt><dd>${html}</dd>`);
    };
    const muted = (text) => `<span class="campaign-details__muted">${text}</span>`;
    const code = (text) => `<code>${escapeHtml(text)}</code>`;

    add('API', details.mode === 'bulk' ? 'Bulk Messaging' : 'Programmable Messaging');
    add('Channel', escapeHtml(channelLabel(details.channel)));

    const sender = details.sender || {};
    if (sender.label || sender.address) {
        const kind = SENDER_KIND_LABEL[sender.kind];
        add('Sender', escapeHtml(sender.label || sender.address) + (kind ? ` ${muted(kind)}` : ''));
    }

    const template = details.template;
    if (template && template.notRecorded) {
        add('Template', muted('Not recorded'));
    } else if (template) {
        // Campaigns sent before names were recorded carry only the SID. The
        // name is filled in when the loaded template list still has it.
        const known = template.name ? null : loadedTemplates.find((t) => t.sid === template.sid);
        const name = template.name || (known && known.friendlyName);
        const language = template.language || (known && known.language);
        const title = name ? `${escapeHtml(name)}${language ? ` (${escapeHtml(language)})` : ''} ` : '';
        add('Template', title + code(template.sid));
    }

    const message = details.message;
    if (message && message.notRecorded) {
        add('Message', muted('Not recorded'));
    } else if (message && message.perRecipient) {
        add('Message', 'Per-recipient text from CSV');
    } else if (message && message.body) {
        add('Message', `<span class="campaign-details__body" title="${escapeHtml(message.body)}">${escapeHtml(message.body)}</span>`);
    }

    const variables = details.variables;
    if (variables && variables.perRecipient) {
        add('Variables', 'Per-recipient from CSV');
    } else if (variables && variables.values) {
        add('Variables', Object.entries(variables.values)
            .map(([key, value]) => `${code(`{{${key}}}`)} ${escapeHtml(value)}`)
            .join(' · '));
    }

    const media = details.media;
    if (media) {
        const items = (media.urls || []).map((url) => (/^https?:\/\//i.test(url)
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
            : escapeHtml(url)));
        if (media.perRecipient) items.push('Per-recipient from CSV');
        add('Media', items.join('<br>'));
    }

    const recipients = details.recipients || {};
    const count = Number(recipients.count || 0);
    if (recipients.source === 'csv') {
        add('Recipients', ['CSV', recipients.fileName && escapeHtml(recipients.fileName), `· ${count}`]
            .filter(Boolean).join(' '));
    } else if (recipients.source === 'typed') {
        add('Recipients', `Typed · ${count}`);
    } else if (count) {
        add('Recipients', String(count));
    }

    if (details.scheduledFor) {
        add('Scheduled', escapeHtml(new Date(details.scheduledFor).toLocaleString()));
    }
    if (details.channel === 'whatsapp' && typeof details.fallbackToSms === 'boolean') {
        add('SMS fallback', details.fallbackToSms ? 'On' : 'Off');
    }
    if (details.operationIds && details.operationIds.length) {
        add('Operations', details.operationIds.map((id) => code(id)).join('<br>'));
    }

    return `
        <div class="campaign-details">
            <h3 class="campaign-details__title">Campaign details</h3>
            <dl>${rows.join('')}</dl>
        </div>
    `;
}
```

- [ ] **Step 2: Add the summary line to each campaign card**

In `displayCampaigns`, in the render signature, replace:

```js
            c.delivered, c.read, c.startIndex, c.isComplete, c.lastUpdated,
        ]),
```

with:

```js
            c.delivered, c.read, c.startIndex, c.isComplete, c.lastUpdated,
            c.summary,
        ]),
```

Then replace:

```js
        const modeBadge = campaign.mode === 'bulk'
```

with:

```js
        const summaryText = campaignSummaryText(campaign.summary);

        const modeBadge = campaign.mode === 'bulk'
```

Then, in the card markup, replace:

```js
                    </div>
                </div>
                <div class="campaign-stats">
```

with:

```js
                    </div>
                </div>
                ${summaryText ? `<div class="campaign-summary" title="${summaryText}">${summaryText}</div>` : ''}
                <div class="campaign-stats">
```

- [ ] **Step 3: Pass bulk `details` into the panel**

In `fetchAndDisplayCampaignDetails`, in the bulk `displayMessageDetails({ ... })` call, replace:

```js
                detailsNote: bulkDetailsNote(source, savedAt),
            });
```

with:

```js
                detailsNote: bulkDetailsNote(source, savedAt),
                details: campaign ? campaign.details : null,
            });
```

The classic path needs no change: `check-status` already returns `details` on `data.campaign`.

- [ ] **Step 4: Render the block in `displayMessageDetails`**

Replace:

```js
    const note = campaign.detailsNote ? `<p class="details-note">${campaign.detailsNote}</p>` : '';
```

with:

```js
    const note = campaign.detailsNote ? `<p class="details-note">${campaign.detailsNote}</p>` : '';
    const detailsBlock = renderCampaignDetails(campaign.details);
```

Replace:

```js
        messageDetailsContent.innerHTML = (campaign.mode === 'bulk' ? summary : '') +
```

with:

```js
        messageDetailsContent.innerHTML = detailsBlock + (campaign.mode === 'bulk' ? summary : '') +
```

Replace:

```js
        campaign.read, campaign.totalMessages, campaign.detailsNote,
```

with:

```js
        campaign.read, campaign.totalMessages, campaign.detailsNote, campaign.details,
```

Replace:

```js
    let html = summary + note + `
```

with:

```js
    let html = detailsBlock + summary + note + `
```

- [ ] **Step 5: Add the styles**

In `assets/styles.css`, directly after the closing `}` of the `.details-note` rule, add:

```css
/* The card's channel · sender · template line. One line, cut with an
   ellipsis; the full text is in its title. */
.campaign-summary {
    margin: -6px 0 10px;
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* What a campaign was sent with, above the delivery totals. Labels use
   --text-secondary, not --text-muted, which is short of AA at 12px. */
.campaign-details {
    margin-bottom: 15px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.campaign-details__title {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
}

.campaign-details dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 0;
    font-size: 12px;
}

.campaign-details dt,
.campaign-details__muted {
    color: var(--text-secondary);
}

.campaign-details dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
}

.campaign-details code {
    font-family: var(--mono);
    font-size: 11px;
}

/* Long bodies stop at three lines; the full text is in the title. */
.campaign-details__body {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
}
```

- [ ] **Step 6: Syntax-check and run the tests**

Run: `node --check assets/app.js && npm test 2>&1 | tail -8`
Expected: no syntax error; `ℹ fail 0`.

- [ ] **Step 7: Confirm no unescaped details value reaches the markup**

Run: `grep -n "details\.\|summary\." assets/app.js | grep -v escapeHtml | grep "\${"`
Expected: only lines whose interpolated value is already escaped (`summaryText`, `title`, `code(...)`, `muted(...)`) or is a fixed string. Fix any other hit before committing.

- [ ] **Step 8: Commit**

```bash
git add assets/app.js assets/styles.css
git commit -m "feat: show sender, template and message on campaign cards and details

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Verify in the running app

This needs a deployed or locally served app and sends real messages, so the user runs it or explicitly approves each step. There is no `.env` in the repo, so `npm start` needs one first; otherwise deploy to `dev-environment` with the `Abel` CLI profile (only with the user's approval).

- [ ] **Step 1: Classic campaign with a template and shared variables**

Send to one test number on SMS or WhatsApp with a Messaging Service as sender and a template with one variable. Open the campaign.
Expected card line: `<Channel> · <service label> · <template name>`.
Expected panel rows: API "Programmable Messaging", Channel, Sender with "Messaging Service", Template with name, language and `HX…`, Variables `{{1}} <value>`, Recipients "Typed · 1".

- [ ] **Step 2: Bulk campaign from a CSV**

Send in Bulk mode from a two-row CSV with a typed sender. Open the campaign.
Expected panel rows: API "Bulk Messaging", Sender with "Typed sender", Message "Per-recipient text from CSV" (Body CSV) or Variables "Per-recipient from CSV" (template CSV), Recipients "CSV <file> · 2", Operations with one ID. For WhatsApp, SMS fallback On or Off.

- [ ] **Step 3: An old campaign**

Open a campaign sent before this change.
Expected: classic shows Sender, and Template or Message from its first message. Bulk shows Sender, and "Not recorded" for Template and Message. Neither throws in the browser console.
