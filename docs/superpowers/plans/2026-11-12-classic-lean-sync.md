# Classic Campaigns on Lean Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Programmable Messaging ("classic") campaigns of 2,000+ recipients send reliably within Twilio Sync's measured write rate, by storing in Sync only what Twilio cannot tell us, and show a progress indicator while a campaign goes out.

**Architecture:** Builds on branch `feat/classic-sync-buckets` (plan `2026-11-04-classic-sync-buckets.md`). The recipient list is no longer uploaded to Sync. The browser keeps it and sends it slice by slice to `send-messages.js`, each call sending what fits its time budget. Each fixed chunk of 128 recipients has one Sync record, written twice: created (the claim, holding the numbers) before the chunk is sent, so no chunk is ever sent twice, then updated with one compact row per recipient. Statuses come live from Twilio; a poll rewrites at most 3 chunk records. Resuming means sending the same list again: its SHA-256 fingerprint, stored on the campaign, lets the app recognise it and continue past the chunks already claimed. `resume-execution.js` is deleted.

**Tech Stack:** Twilio Functions (runtime `node24`), Twilio Sync (Documents and Maps), `twilio` npm 5.x, vanilla browser JS in `assets/app.js` (Web Crypto `crypto.subtle`), `node:test`.

**Why:** On 2026-11-12 a 2,000-recipient campaign with per-recipient bodies failed with `Rate limit exceeded for write-map-campaign_…_recipients`. Measured against the deployment's Sync service with a temporary Map: 9 KB items, 8 in flight → 22 of 48 written; paced 2/s → 20 of 20; 4/s → 27 of 30; 8/s → 22 of 40; 0.7 KB items, 8 in flight → 64 of 64. A Map takes about 20 writes of several KB per 10-second window, about 2 a second. The previous design wrote about 97 recipient items, 5 status writes per chunk, and up to 24 per poll.

## Global Constraints

- No new dependencies. Tests run with `npm test` (`node --test test/*.js`); every test on the branch keeps passing except those this plan replaces.
- Private assets are required as `require(Runtime.getAssets()['/classic-campaign.js'].path)`. Tests require `../assets/classic-campaign.private.js`. An asset never requires another asset: deployed assets are not siblings on disk.
- Twilio Functions: 10 s per invocation, 1 MB request, 4 MB response.
- Sync, measured: about 2 writes/s per Map for items over 1 KiB (burst of about 20), each object with its own budget. Items ≤ 16 KiB.
- `CHUNK_SIZE = 128` in both `assets/classic-campaign.private.js` and `assets/app.js`. Chunk k covers recipients `128k … 128k+127`; keys are the first index zero-padded to 7 digits (`0000128`).
- One Map per campaign: `<campaignId>_chunks`. No TTL. Record shape: `{ claimedAt, to: [...], sentAt?, rows?: [[sid|null, status, errorCode|null, updatedEpochSeconds|null], ...], checkedAt?, settled? }`.
- Document marker `storage: 'lean'`, with `fingerprint` (64 hex characters, SHA-256 of `JSON.stringify(messages)`). Any other classic Document is older: it renders (inline `statuses`, if any) and cannot be continued.
- Pacing: `CHUNK_INTERVAL_MS = 1100` between chunk starts. Send budget: no chunk starts after 7 s (`SEND_DEADLINE_MS = 7000`); no send or 429 retry starts after 9 s (`RETRY_DEADLINE_MS = 9000`).
- Polls refresh at most `MAX_REFRESH_CHUNKS = 3` chunks (≤ 384 fetches, ≤ 3 writes), and write nothing when called with `refresh: false`.
- Browser slices: whole chunks only (the last may be short), at most 8 chunks (`SLICE_MAX_CHUNKS`) and 700 KB of JSON (`SLICE_MAX_BYTES`).
- `CLASSIC_SUGGESTED_MAX = 1000` notice stays non-blocking.
- Functions use 2-space indent; `assets/app.js` uses 4-space. Match the comment density of the surrounding code.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Decisions (user, 2026-11-12)

- Lean Sync over a rate-paced version of the current design.
- Resuming needs the same list (CSV or typed) loaded again; the app recognises it by fingerprint and asks to continue.
- A loading indicator shows while a campaign is being sent: spinner, stage text and progress bar.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `assets/classic-campaign.private.js` | rewrite | Chunk records: keys, rows, claims, Sync I/O, the send loop, refresh planning, expansion for the delivery table, counters, older-campaign helpers |
| `assets/classic-messages.private.js` | modify | Messages API only: params, sending a chunk, fetching statuses |
| `test/classic-campaign.test.js` | rewrite | Tests for the above, against a fake Sync |
| `test/classic-messages.test.js` | modify | Drop tests of removed helpers; add `fetchStatuses` tests |
| `functions/send-messages.js` | rewrite | Validate a slice; create or match the campaign; send the slice |
| `functions/resume-execution.js` | delete | Nothing server-side to resume from |
| `functions/check-status.js` | modify | Read chunk records; refresh ≤ 3; expand; count |
| `functions/list-campaigns.js` | modify | `resumable` and `fingerprint` for lean campaigns |
| `assets/app.js`, `assets/index.html`, `assets/styles.css` | modify | Progress indicator, sliced send loop, continue-by-fingerprint, Resume instructions, read-only polls while sending |
| `README.md`, spec | modify | Describe the lean design and the measured limit |

---

### Task 1: Chunk records (pure)

**Files:**
- Rewrite: `assets/classic-campaign.private.js` (replace the whole file with the code below; Task 2 appends to it)
- Rewrite: `test/classic-campaign.test.js` (replace the whole file with the code below; Task 2 appends to it)

**Interfaces:**
- Produces (exported): constants `STORAGE = 'lean'`, `CHUNK_SIZE = 128`, `CHUNK_INTERVAL_MS = 1100`, `SHARED_MAX_BYTES`, `CLAIM_SENDING_MS = 15000`; `chunkKey(start)`, `chunksMapName(campaignId)`, `isLean(campaignData)`, `sharedFields(messages)`, `newCampaignData({ ownerKey, accountSid, totalMessages, fingerprint, shared, channel, from, campaignName, details, now })`, `rowsFor(results)`, `isFinal(status, channel)`, `pendingRows(chunk, channel) → number[]`, `selectChunks(chunks, channel, limit) → { selected, takingTurns }`, `applyFetched(chunk, fetched, channel) → { chunk, changed, complete }`, `refreshPlan(selected, fetched, { channel, takingTurns, checkedAt }) → [{ chunk, write }]`, `chunkStatuses(chunk, now) → { [key]: entry }`, `legacyPending(statuses, channel) → sid[]`, `applyLegacy(statuses, fetched)`, `tally(statuses) → { sent, delivered, read, failed, pending, unconfirmed }`.
- A chunk object (as read from Sync, Task 2) is `{ key, start, revision, claimedAt, to, sentAt?, rows?, checkedAt?, settled? }`.
- `fetched` is a `Map` from SID to `{ status, errorCode, errorMessage, dateSent, dateUpdated }` or `{ error }` (Task 3's `fetchStatuses`).

- [ ] **Step 1: Write the failing tests** — replace `test/classic-campaign.test.js` with:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const storage = require('../assets/classic-campaign.private.js');

const FROM = '+15017122661';
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sid = (n) => `SM${String(n).padStart(32, '0')}`;

/** `count` messages to distinct numbers, each extended by `extra(i)`. */
function messages(count, extra = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    to: `+1555${String(i).padStart(7, '0')}`,
    from: FROM,
    ...extra(i),
  }));
}

/** A recorded chunk of `count` recipients starting at `start`, every row `status`. */
function recorded(start, count, status = 'sent', extra = {}) {
  return {
    key: storage.chunkKey(start),
    start,
    claimedAt: '2026-11-12T00:00:00.000Z',
    sentAt: '2026-11-12T00:00:01.000Z',
    to: Array.from({ length: count }, (_, i) => `+1555${String(start + i).padStart(7, '0')}`),
    rows: Array.from({ length: count }, (_, i) => [sid(start + i), status, null, null]),
    ...extra,
  };
}

test('chunkKey zero-pads so that key order is send order', () => {
  assert.strictEqual(storage.chunkKey(0), '0000000');
  assert.strictEqual(storage.chunkKey(128), '0000128');
  assert.deepStrictEqual([9984, 128, 0, 1024].map(storage.chunkKey).sort(), [
    '0000000', '0000128', '0001024', '0009984',
  ]);
  assert.strictEqual(storage.chunksMapName('campaign_1'), 'campaign_1_chunks');
});

test('sharedFields keeps only what every message has the same, within budget', () => {
  assert.deepStrictEqual(storage.sharedFields(messages(3, () => ({ body: 'Sale' }))), { from: FROM, body: 'Sale' });
  assert.deepStrictEqual(storage.sharedFields(messages(2, (i) => ({ body: `Hi ${i}` }))), { from: FROM });
  const long = 'x'.repeat(storage.SHARED_MAX_BYTES + 1);
  assert.deepStrictEqual(storage.sharedFields(messages(2, () => ({ body: long }))), { from: FROM });
});

test('newCampaignData marks a lean Document; others are older', () => {
  const data = storage.newCampaignData({
    ownerKey: 'o', accountSid: 'AC1', totalMessages: 300, fingerprint: 'f'.repeat(64), shared: {},
    channel: 'sms', from: FROM, campaignName: null, details: null, now: '2026-11-12T00:00:00.000Z',
  });
  assert.strictEqual(data.storage, 'lean');
  assert.strictEqual(data.fingerprint, 'f'.repeat(64));
  assert.strictEqual(data.startIndex, 0);
  assert.strictEqual(data.pending, 300);
  assert.strictEqual(storage.isLean(data), true);
  assert.strictEqual(storage.isLean({ storage: 'buckets' }), false);
  assert.strictEqual(storage.isLean({ statuses: {} }), false);
  assert.strictEqual(storage.isLean(null), false);
});

test('rowsFor records an accepted send by SID and a refusal by its code', () => {
  assert.deepStrictEqual(storage.rowsFor([
    { index: 0, success: true, sid: sid(0), status: 'queued', to: '+1' },
    { index: 1, success: false, error: 'Invalid To', errorCode: 21211, to: '+2' },
    { index: 2, success: false, to: '+3' },
  ]), [
    [sid(0), 'queued', null, null],
    [null, 'failed', 21211, null],
    [null, 'failed', null, null],
  ]);
});

test('isFinal treats delivered as final only where there is no read receipt', () => {
  assert.strictEqual(storage.isFinal('delivered', 'sms'), true);
  assert.strictEqual(storage.isFinal('delivered', 'whatsapp'), false);
  assert.strictEqual(storage.isFinal('read', 'whatsapp'), true);
  assert.strictEqual(storage.isFinal('undelivered', 'sms'), true);
  assert.strictEqual(storage.isFinal('queued', 'sms'), false);
});

test('pendingRows and selectChunks pick unsettled chunks, least recently checked first', () => {
  const settled = recorded(0, 2, 'delivered');
  const claimOnly = { key: storage.chunkKey(128), start: 128, claimedAt: 'x', to: ['+1'] };
  const old = recorded(256, 2, 'sent', { checkedAt: '2026-11-12T00:01:00.000Z' });
  const never = recorded(384, 2, 'queued');
  const recent = recorded(512, 2, 'sent', { checkedAt: '2026-11-12T00:02:00.000Z' });
  assert.deepStrictEqual(storage.pendingRows(settled, 'sms'), []);
  assert.deepStrictEqual(storage.pendingRows(never, 'sms'), [0, 1]);
  assert.deepStrictEqual(storage.pendingRows(claimOnly, 'sms'), []);

  const { selected, takingTurns } = storage.selectChunks([settled, claimOnly, old, never, recent], 'sms', 2);
  assert.deepStrictEqual(selected.map((c) => c.start), [384, 256]);
  assert.strictEqual(takingTurns, true);
  assert.strictEqual(storage.selectChunks([old, never], 'sms', 2).takingTurns, false);
});

test('applyFetched updates pending rows and says whether the chunk changed, was reached and settled', () => {
  const chunk = recorded(0, 3, 'sent');
  chunk.rows[2] = [null, 'failed', 21211, null];
  const fetched = new Map([
    [sid(0), { status: 'delivered', errorCode: null, dateUpdated: new Date('2026-11-12T00:00:05.000Z') }],
    [sid(1), { error: 'boom' }],
  ]);
  const out = storage.applyFetched(chunk, fetched, 'sms');
  assert.deepStrictEqual(out.chunk.rows, [
    [sid(0), 'delivered', null, 1794441605],
    [sid(1), 'sent', null, null],
    [null, 'failed', 21211, null],
  ]);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.complete, true);
  assert.strictEqual(out.chunk.settled, false);

  const partial = storage.applyFetched(recorded(0, 2, 'sent'), new Map([[sid(0), { status: 'sent' }]]), 'sms');
  assert.strictEqual(partial.complete, false);
  assert.strictEqual(partial.changed, false);

  const done = storage.applyFetched(recorded(0, 1, 'sent'), new Map([[sid(0), { status: 'delivered' }]]), 'sms');
  assert.strictEqual(done.chunk.settled, true);
});

test('refreshPlan stamps only chunks it reached, and writes what changed or took its turn', () => {
  const a = recorded(0, 1, 'sent', { checkedAt: 'old-a' });
  const b = recorded(128, 1, 'sent', { checkedAt: 'old-b' });
  const fetched = new Map([[sid(0), { status: 'sent' }]]);
  const plan = storage.refreshPlan([a, b], fetched, { channel: 'sms', takingTurns: false, checkedAt: 'now' });
  // b was not reached, so the chunks take turns: a, reached and unchanged, is still written to record its turn.
  assert.deepStrictEqual(plan.map((p) => [p.chunk.start, p.chunk.checkedAt, p.write]), [[0, 'now', true], [128, 'old-b', false]]);

  const quiet = storage.refreshPlan([a], fetched, { channel: 'sms', takingTurns: false, checkedAt: 'now' });
  assert.deepStrictEqual(quiet.map((p) => p.write), [false]);

  const moved = storage.refreshPlan([a], new Map([[sid(0), { status: 'delivered' }]]), { channel: 'sms', takingTurns: false, checkedAt: 'now' });
  assert.deepStrictEqual(moved.map((p) => p.write), [true]);
});

test('chunkStatuses expands rows for the delivery table', () => {
  const chunk = recorded(128, 2, 'delivered');
  chunk.rows[1] = [null, 'failed', 21211, 1794441605];
  assert.deepStrictEqual(storage.chunkStatuses(chunk), {
    [sid(128)]: {
      to: '+15550000128', status: 'delivered', errorCode: null, sentAt: '2026-11-12T00:00:01.000Z',
      dateUpdated: null, delivered: true, read: false,
    },
    'failed-129': {
      to: '+15550000129', status: 'failed', errorCode: 21211, sentAt: '2026-11-12T00:00:01.000Z',
      dateUpdated: '2026-11-12T00:00:05.000Z', delivered: false, read: false,
    },
  });
});

test('a claim with no result reads as sending while young, then not confirmed', () => {
  const claim = { key: storage.chunkKey(0), start: 0, claimedAt: '2026-11-12T00:00:00.000Z', to: ['+1', '+2'] };
  const at = Date.parse(claim.claimedAt);
  assert.deepStrictEqual(storage.chunkStatuses(claim, at + 1000), {
    'unconfirmed-0': { to: '+1', status: 'sending' },
    'unconfirmed-1': { to: '+2', status: 'sending' },
  });
  assert.strictEqual(storage.chunkStatuses(claim, at + storage.CLAIM_SENDING_MS + 1)['unconfirmed-0'].status, 'unconfirmed');
});

test('legacyPending and applyLegacy refresh an older campaign\'s inline statuses', () => {
  const statuses = {
    [sid(1)]: { status: 'sent', to: '+1', sentAt: 'a' },
    [sid(2)]: { status: 'delivered', to: '+2', sentAt: 'a' },
    'failed-3': { status: 'failed', to: '+3' },
  };
  assert.deepStrictEqual(storage.legacyPending(statuses, 'sms'), [sid(1)]);
  const next = storage.applyLegacy(statuses, new Map([[sid(1), { status: 'read', errorCode: null, errorMessage: null, dateSent: null, dateUpdated: null }]]));
  assert.strictEqual(next[sid(1)].status, 'read');
  assert.strictEqual(next[sid(1)].delivered, true);
  assert.strictEqual(next[sid(1)].read, true);
  assert.strictEqual(next[sid(2)], statuses[sid(2)]);
});

test('tally counts from the expanded statuses', () => {
  assert.deepStrictEqual(storage.tally({
    [sid(1)]: { status: 'delivered' },
    [sid(2)]: { status: 'read' },
    [sid(3)]: { status: 'undelivered' },
    [sid(4)]: { status: 'sent' },
    'failed-5': { status: 'failed' },
    'unconfirmed-6': { status: 'unconfirmed' },
    'unconfirmed-7': { status: 'sending' },
  }), { sent: 4, delivered: 2, read: 1, failed: 2, pending: 2, unconfirmed: 1 });
});

test('a full chunk record stays under 16 KiB, and a claim under 10 KiB, on the longest addresses', () => {
  const to = Array.from({ length: storage.CHUNK_SIZE }, (_, i) => `messenger:${String(1000000000000000 + i)}`);
  const claim = { claimedAt: '2026-11-12T00:00:00.000Z', to };
  assert.ok(size(claim) < 10 * 1024, `claim is ${size(claim)} bytes`);
  const full = {
    ...claim,
    sentAt: '2026-11-12T00:00:01.000Z',
    checkedAt: '2026-11-12T00:00:09.000Z',
    settled: false,
    rows: to.map((_, i) => [sid(i), 'undelivered', 63049, 1794441605]),
  };
  assert.ok(size(full) < 16 * 1024, `record is ${size(full)} bytes`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/classic-campaign.test.js`
Expected: FAIL — the old module has no `chunkKey`, `rowsFor`, etc.

- [ ] **Step 3: Write the implementation** — replace `assets/classic-campaign.private.js` with:

```js
/**
 * Sync records for a classic (Programmable Messaging) campaign, and the chunk
 * loop that sends it.
 *
 * Sync is written as little as possible. Measured on 2026-11-12, a Map took 22
 * of 48 writes of 9 KB sent 8 at a time and refused the rest, and took 20 of 20
 * at 2 a second: about 20 writes of a few KB per 10-second window. So only what
 * Twilio cannot tell us is stored:
 *
 *   campaign_<id>         Document  owner, list fingerprint, counters, startIndex, display fields
 *   campaign_<id>_chunks  Map       chunk start -> { claimedAt, to, sentAt, rows, checkedAt, settled }
 *
 * The recipient list is not stored. The browser holds it and sends it slice by
 * slice; resuming means sending the same list again, which its fingerprint, a
 * SHA-256 of the messages stored on the Document, must match. Statuses come
 * from Twilio; a chunk's record is rewritten only when a poll refreshes it.
 *
 * Chunks are fixed: chunk k is recipients 128k to 128k + 127, keyed by its
 * first index, zero-padded so that Sync's key order is send order. Before a
 * chunk is sent its record is created holding the recipients' numbers. Sync
 * refuses a key that exists, so a chunk is sent at most once, by whichever
 * sender created its record. After the send the record is updated with one row
 * per recipient, in the order of `to`:
 *
 *   [sid or null, status, errorCode or null, updated (epoch seconds) or null]
 *
 * A record with no rows is a chunk whose result was never saved: it is being
 * sent, or its send was cut off. Its recipients show as "sending", then as
 * "not confirmed".
 *
 * This is a *private* asset. Require it as:
 *
 *   const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
 */

'use strict';

/** Marks a Document laid out as above. Earlier layouts cannot be continued. */
const STORAGE = 'lean';

/** Recipients per chunk. Mirrors CHUNK_SIZE in app.js. */
const CHUNK_SIZE = 128;

/**
 * Least time between chunk starts. A chunk writes its record twice, and a Map
 * takes about 2 writes a second once its burst allowance is spent.
 */
const CHUNK_INTERVAL_MS = 1100;

/** Budget for the display fields stored once on the Document. */
const SHARED_MAX_BYTES = 4 * 1024;

/**
 * How long a claim with no result reads as still sending. A Function runs for
 * at most 10 seconds, so after this no sender is left to record it.
 */
const CLAIM_SENDING_MS = 15000;

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

/** A real Twilio message SID. Mirrors MESSAGE_SID in app.js. */
const MESSAGE_SID = /^[A-Z]{2}[0-9a-f]{32}$/i;

const KEY_DIGITS = 7;

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function chunkKey(start) {
  return String(start).padStart(KEY_DIGITS, '0');
}

function chunksMapName(campaignId) {
  return `${campaignId}_chunks`;
}

function isLean(campaignData) {
  return Boolean(campaignData) && campaignData.storage === STORAGE;
}

/**
 * Fields every message carries with the same value, for the campaign card and
 * delivery panel (campaign-details.private.js reads them as `shared`).
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
 * A new campaign's Document data. `accountSid` is for display only, never an
 * authorization key: ownership is `ownerKey` alone.
 */
function newCampaignData({ ownerKey, accountSid, totalMessages, fingerprint, shared, channel, from, campaignName, details, now }) {
  return {
    storage: STORAGE,
    ownerKey,
    accountSid,
    totalMessages,
    fingerprint,
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

/** A sent chunk's results as rows, in recipient order. */
function rowsFor(results) {
  return results.map((result) => (result.success
    ? [result.sid, result.status, null, null]
    : [null, 'failed', result.errorCode || null, null]));
}

function epochSeconds(date) {
  if (!date) return null;
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function isFinal(status, channel) {
  const value = String(status || '').toLowerCase();
  if (FINAL.has(value)) return true;
  return value === 'delivered' && !READ_RECEIPT_CHANNELS.has(String(channel || '').toLowerCase());
}

/** Positions, within the chunk, of messages whose status can still change. */
function pendingRows(chunk, channel) {
  return (chunk.rows || []).flatMap((row, i) => (row[0] && !isFinal(row[1], channel) ? [i] : []));
}

/**
 * The chunks to refresh this poll: those with a status that can still change,
 * least recently checked first (never checked before any), at most `limit`.
 * `takingTurns` is true when some were left for a later poll.
 */
function selectChunks(chunks, channel, limit) {
  const candidates = chunks
    .filter((chunk) => pendingRows(chunk, channel).length)
    .sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || '')));
  return { selected: candidates.slice(0, limit), takingTurns: candidates.length > limit };
}

/**
 * A chunk with fetched statuses applied. `changed` is whether any row moved;
 * `complete` whether every pending row was reached (a fetch that failed counts
 * as reached: it is retried on the chunk's next turn); `settled` on the new
 * chunk whether no row can change any more.
 */
function applyFetched(chunk, fetched, channel) {
  let changed = false;
  let complete = true;
  const rows = (chunk.rows || []).map((row) => {
    const [messageSid, status] = row;
    if (!messageSid || isFinal(status, channel)) return row;
    const result = fetched.get(messageSid);
    if (!result) {
      complete = false;
      return row;
    }
    if (result.error) return row;
    const next = [messageSid, result.status, result.errorCode == null ? null : result.errorCode, epochSeconds(result.dateUpdated)];
    if (JSON.stringify(next) !== JSON.stringify(row)) changed = true;
    return next;
  });
  const settled = rows.every(([messageSid, status]) => !messageSid || isFinal(status, channel));
  return { chunk: { ...chunk, rows, settled }, changed, complete };
}

/**
 * What to write back for each chunk selectChunks chose. A chunk is stamped
 * `checkedAt` only when complete, so one cut off by the fetch deadline stays at
 * the front of the queue. It is written when a row changed or, while chunks are
 * taking turns, when complete, to record its turn. Chunks take turns too when
 * any was cut off, or the same ones would be fetched first on every poll.
 */
function refreshPlan(selected, fetched, { channel, takingTurns, checkedAt }) {
  const applied = selected.map((chunk) => applyFetched(chunk, fetched, channel));
  const rotating = takingTurns || !applied.every((entry) => entry.complete);
  return applied.map(({ chunk, changed, complete }) => ({
    chunk: { ...chunk, checkedAt: complete ? checkedAt : chunk.checkedAt },
    write: changed || (rotating && complete),
  }));
}

/**
 * One chunk as the delivery table reads it: entries keyed by message SID, by
 * `failed-<index>` for a send Twilio refused, or by `unconfirmed-<index>` for a
 * recipient whose result was never saved.
 */
function chunkStatuses(chunk, now = Date.now()) {
  const statuses = {};
  const to = chunk.to || [];
  if (!chunk.rows) {
    const sending = Boolean(chunk.claimedAt) && now - Date.parse(chunk.claimedAt) < CLAIM_SENDING_MS;
    to.forEach((number, i) => {
      statuses[`unconfirmed-${chunk.start + i}`] = { to: number, status: sending ? 'sending' : 'unconfirmed' };
    });
    return statuses;
  }
  chunk.rows.forEach(([messageSid, status, errorCode, updated], i) => {
    statuses[messageSid || `failed-${chunk.start + i}`] = {
      to: to[i] || null,
      status,
      errorCode,
      sentAt: chunk.sentAt || null,
      dateUpdated: updated ? new Date(updated * 1000).toISOString() : null,
      delivered: status === 'delivered' || status === 'read',
      read: status === 'read',
    };
  });
  return statuses;
}

/** SIDs in an older campaign's inline statuses whose status can still change. */
function legacyPending(statuses, channel) {
  return Object.keys(statuses).filter((key) =>
    MESSAGE_SID.test(key) && !isFinal((statuses[key] || {}).status, channel));
}

/** An older campaign's inline statuses with fetched results applied. */
function applyLegacy(statuses, fetched) {
  const next = { ...statuses };
  for (const [messageSid, result] of fetched) {
    const before = next[messageSid];
    if (!before || result.error) continue;
    next[messageSid] = {
      ...before,
      status: result.status,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      dateSent: result.dateSent,
      dateUpdated: result.dateUpdated,
      // Kept once set: older campaigns had these flags from the webhook.
      delivered: Boolean(before.delivered) || result.status === 'delivered' || result.status === 'read',
      read: Boolean(before.read) || result.status === 'read',
    };
  }
  return next;
}

/**
 * The derived counters, from the statuses as the delivery table reads them.
 * This is the only place that counts per-message status, so a badge and a
 * counter cannot disagree. `sent` is every send Twilio accepted; `failed`
 * includes the sends it refused; `pending` is accepted and not yet delivered or
 * failed, or still being sent; `unconfirmed` is recipients whose result was
 * never saved.
 */
function tally(statuses) {
  const counts = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, unconfirmed: 0 };
  for (const [key, entry] of Object.entries(statuses)) {
    const status = String((entry && entry.status) || '').toLowerCase();
    const isDelivered = Boolean(entry.delivered) || status === 'delivered' || status === 'read';
    const isFailed = TERMINAL_FAILURE.has(status);
    if (isDelivered) counts.delivered++;
    if (entry.read || status === 'read') counts.read++;
    if (isFailed) counts.failed++;
    if (status === 'unconfirmed') counts.unconfirmed++;
    if (status === 'sending') counts.pending++;
    if (MESSAGE_SID.test(key)) {
      counts.sent++;
      if (!isDelivered && !isFailed) counts.pending++;
    }
  }
  return counts;
}

module.exports = {
  STORAGE,
  CHUNK_SIZE,
  CHUNK_INTERVAL_MS,
  SHARED_MAX_BYTES,
  CLAIM_SENDING_MS,
  chunkKey,
  chunksMapName,
  isLean,
  sharedFields,
  newCampaignData,
  rowsFor,
  isFinal,
  pendingRows,
  selectChunks,
  applyFetched,
  refreshPlan,
  chunkStatuses,
  legacyPending,
  applyLegacy,
  tally,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/classic-campaign.test.js`
Expected: PASS, 13 tests. Then `npm test`: PASS (the Functions are not unit-tested, and nothing in `test/` uses the removed exports).

- [ ] **Step 5: Commit**

```bash
git add assets/classic-campaign.private.js test/classic-campaign.test.js
git commit -m "feat: lean classic chunk records — one Sync record per 128 recipients"
```

---

### Task 2: Chunk records in Sync, and the send loop

**Files:**
- Modify: `assets/classic-campaign.private.js` (append above `module.exports`; extend exports)
- Modify: `test/classic-campaign.test.js` (append)

**Interfaces:**
- Consumes: Task 1.
- Produces (exported): `createChunksMap(syncClient, campaignId)`, `claimChunk(syncClient, campaignId, start, messages, claimedAt) → boolean`, `recordChunk(syncClient, campaignId, start, { claimedAt, to }, rows, sentAt)`, `readChunks(syncClient, campaignId) → chunk[]`, `updateChunk(syncClient, campaignId, chunk)` (conditional on `chunk.revision`), `runChunks({ syncClient, campaignId, campaignData, messages, offset, deadline, send, now, sleep, interval }) → { resumeFrom, checkpointFailed, throttled }`, `progressBody(campaignId, campaignData, outcome)`.
- `send(messages, startIndex)` resolves to one result per message in order and never rejects (Task 3's `sendChunk`).

- [ ] **Step 1: Write the failing tests** — append to `test/classic-campaign.test.js`:

```js
function syncError(status, code) {
  return Object.assign(new Error(`Sync ${status}`), { status, code });
}

/**
 * Just enough of twilio-node's Sync surface: `syncMaps` and `syncMapItems` are
 * callable and carry methods, as in the SDK. Items carry a revision; update
 * honours `ifMatch`. `fail` holds the next errors per operation.
 */
function fakeSync() {
  const state = { maps: {}, documents: {}, calls: [], fail: { create: [], update: [], document: [] } };
  const take = (op) => state.fail[op].shift();
  const itemsOf = (name) => {
    if (!state.maps[name]) throw syncError(404, 20404);
    return state.maps[name];
  };
  const syncMaps = (name) => {
    const syncMapItems = (key) => ({
      update: async ({ data, ifMatch }) => {
        state.calls.push(['update', key]);
        const error = take('update');
        if (error) throw error;
        const items = itemsOf(name);
        if (!(key in items)) throw syncError(404, 20404);
        if (ifMatch && ifMatch !== items[key].revision) throw syncError(412, 54103);
        items[key] = { data, revision: String(Number(items[key].revision) + 1) };
      },
    });
    syncMapItems.create = async ({ key, data }) => {
      state.calls.push(['create', key]);
      const error = take('create');
      if (error) throw error;
      const items = itemsOf(name);
      if (key in items) throw syncError(409, 54208);
      items[key] = { data, revision: '0' };
    };
    syncMapItems.list = async () => {
      const items = itemsOf(name);
      return Object.keys(items).sort().map((key) => ({ key, data: items[key].data, revision: items[key].revision }));
    };
    return { syncMapItems };
  };
  syncMaps.create = async ({ uniqueName }) => {
    if (state.maps[uniqueName]) throw syncError(409, 54301);
    state.maps[uniqueName] = {};
  };
  const documents = (name) => ({
    update: async ({ data }) => {
      state.calls.push(['document', name]);
      const error = take('document');
      if (error) throw error;
      state.documents[name] = JSON.parse(JSON.stringify(data));
    },
  });
  return { client: { syncMaps, documents }, state };
}

/** A `send` that accepts every message except those `refuse(index)` picks. */
function fakeSend(refuse = () => false) {
  const chunks = [];
  const send = async (batch, startIndex) => {
    chunks.push([startIndex, batch.length]);
    return batch.map((message, offset) => {
      const index = startIndex + offset;
      return refuse(index)
        ? { index, success: false, error: 'Invalid To', errorCode: 21211, to: message.to }
        : { index, success: true, sid: sid(index), status: 'queued', to: message.to };
    });
  };
  return { send, chunks };
}

async function campaign(total) {
  const sync = fakeSync();
  await storage.createChunksMap(sync.client, 'campaign_1');
  const list = messages(total);
  const campaignData = storage.newCampaignData({
    ownerKey: 'o', accountSid: 'AC1', totalMessages: total, fingerprint: 'f'.repeat(64),
    shared: { from: FROM }, channel: 'sms', from: FROM, campaignName: null, details: null,
    now: '2026-11-12T00:00:00.000Z',
  });
  return { ...sync, list, campaignData };
}

/** runChunks with no real waiting: `sleep` only records. */
function run(ctx, overrides) {
  const sleeps = [];
  const promise = storage.runChunks({
    syncClient: ctx.client, campaignId: 'campaign_1', campaignData: ctx.campaignData,
    messages: ctx.list, offset: 0, deadline: Infinity, sleep: async (ms) => { sleeps.push(ms); },
    ...overrides,
  });
  return { promise, sleeps };
}

test('createChunksMap tolerates a Map left by an earlier attempt', async () => {
  const { client, state } = fakeSync();
  await storage.createChunksMap(client, 'campaign_1');
  await storage.createChunksMap(client, 'campaign_1');
  assert.deepStrictEqual(Object.keys(state.maps), ['campaign_1_chunks']);
});

test('runChunks claims, sends and records each chunk, and writes the Document once', async () => {
  const ctx = await campaign(300);
  const { send, chunks } = fakeSend((i) => i === 5);
  const { promise } = run(ctx, { send });
  const outcome = await promise;
  assert.deepStrictEqual(chunks, [[0, 128], [128, 128], [256, 44]]);
  assert.deepStrictEqual(outcome, { resumeFrom: 300, checkpointFailed: false, throttled: false });
  const map = ctx.state.maps.campaign_1_chunks;
  assert.deepStrictEqual(Object.keys(map), ['0000000', '0000128', '0000256']);
  assert.strictEqual(map['0000000'].data.to.length, 128);
  assert.deepStrictEqual(map['0000000'].data.rows[5], [null, 'failed', 21211, null]);
  assert.deepStrictEqual(map['0000256'].data.rows[0], [sid(256), 'queued', null, null]);
  assert.strictEqual(ctx.state.calls.filter(([op]) => op === 'document').length, 1);
  assert.strictEqual(ctx.state.documents.campaign_1.startIndex, 300);
  assert.strictEqual(ctx.state.documents.campaign_1.sent, 299);
  assert.strictEqual(ctx.state.documents.campaign_1.failed, 1);
});

test('runChunks sends a later slice under its own keys', async () => {
  const ctx = await campaign(400);
  const { send, chunks } = fakeSend();
  const { promise } = run(ctx, { send, messages: ctx.list.slice(256), offset: 256 });
  const outcome = await promise;
  assert.deepStrictEqual(chunks, [[256, 128], [384, 16]]);
  assert.strictEqual(outcome.resumeFrom, 400);
  assert.deepStrictEqual(Object.keys(ctx.state.maps.campaign_1_chunks), ['0000256', '0000384']);
});

test('a chunk already claimed is skipped, not sent again', async () => {
  const ctx = await campaign(300);
  ctx.state.maps.campaign_1_chunks['0000000'] = { data: { claimedAt: 'x', to: [] }, revision: '0' };
  const { send, chunks } = fakeSend();
  const { promise } = run(ctx, { send });
  const outcome = await promise;
  assert.deepStrictEqual(chunks, [[128, 128], [256, 44]]);
  assert.strictEqual(outcome.resumeFrom, 300);
  assert.strictEqual(ctx.state.documents.campaign_1.sent, 172);
});

test('chunks are paced, and none starts after the deadline', async () => {
  const ctx = await campaign(400);
  let clock = 0;
  const { send, chunks } = fakeSend();
  // The fake clock moves only while sending, 300 ms a chunk; sleeps are recorded, not waited.
  const timedSend = async (batch, start) => { clock += 300; return send(batch, start); };
  const { promise, sleeps } = run(ctx, { send: timedSend, now: () => clock, interval: 1000, deadline: 700 });
  const outcome = await promise;
  // Chunks start at 0, 300 and 600; at 900 the deadline has passed.
  assert.deepStrictEqual(chunks, [[0, 128], [128, 128], [256, 128]]);
  assert.deepStrictEqual(sleeps, [700, 700, 700]);
  assert.strictEqual(outcome.resumeFrom, 384);

  const late = await campaign(400);
  const { promise: stopped } = run(late, { send: fakeSend().send, now: () => 2000, deadline: 1500 });
  assert.strictEqual((await stopped).resumeFrom, 0);
});

test('no pause follows the last chunk of a slice', async () => {
  const ctx = await campaign(200);
  let clock = 0;
  const { send } = fakeSend();
  const { promise, sleeps } = run(ctx, {
    send: async (batch, start) => { clock += 100; return send(batch, start); },
    now: () => clock,
    interval: 1000,
  });
  await promise;
  assert.deepStrictEqual(sleeps, [900]);
});

test('a claim refused for Sync\'s rate stops the call without failing it', async () => {
  const ctx = await campaign(300);
  ctx.state.fail.create.push(undefined, syncError(429, 20429));
  const { send, chunks } = fakeSend();
  const { promise } = run(ctx, { send });
  const outcome = await promise;
  assert.deepStrictEqual(chunks, [[0, 128]]);
  assert.deepStrictEqual(outcome, { resumeFrom: 128, checkpointFailed: false, throttled: true });
  assert.strictEqual(ctx.state.documents.campaign_1.startIndex, 128);
});

test('a claim error before anything was sent fails the call; after, it ends it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const before = await campaign(300);
  before.state.fail.create.push(syncError(500, 20500));
  await assert.rejects(run(before, { send: fakeSend().send }).promise, /Sync 500/);

  const after = await campaign(300);
  after.state.fail.create.push(undefined, syncError(500, 20500));
  const outcome = await run(after, { send: fakeSend().send }).promise;
  assert.strictEqual(outcome.resumeFrom, 128);
});

test('a result that cannot be recorded leaves the claim, and says so', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await campaign(300);
  ctx.state.fail.update.push(syncError(429, 20429));
  const { send, chunks } = fakeSend();
  const outcome = await run(ctx, { send }).promise;
  assert.deepStrictEqual(chunks, [[0, 128]]);
  assert.deepStrictEqual(outcome, { resumeFrom: 128, checkpointFailed: true, throttled: true });
  assert.strictEqual(ctx.state.maps.campaign_1_chunks['0000000'].data.rows, undefined);
  assert.strictEqual(ctx.state.maps.campaign_1_chunks['0000000'].data.to.length, 128);
});

test('a failed Document write is reported, and the progress still returned', async (t) => {
  t.mock.method(console, 'error', () => {});
  const ctx = await campaign(200);
  ctx.state.fail.document.push(syncError(500, 20500));
  const outcome = await run(ctx, { send: fakeSend().send }).promise;
  assert.deepStrictEqual(outcome, { resumeFrom: 200, checkpointFailed: true, throttled: false });
});

test('readChunks and updateChunk round-trip a record, conditional on its revision', async () => {
  const ctx = await campaign(200);
  await run(ctx, { send: fakeSend().send }).promise;
  const chunks = await storage.readChunks(ctx.client, 'campaign_1');
  assert.deepStrictEqual(chunks.map((c) => [c.key, c.start, c.revision]), [['0000000', 0, '1'], ['0000128', 128, '1']]);
  await storage.updateChunk(ctx.client, 'campaign_1', { ...chunks[0], checkedAt: 'now' });
  assert.strictEqual(ctx.state.maps.campaign_1_chunks['0000000'].data.checkedAt, 'now');
  await assert.rejects(storage.updateChunk(ctx.client, 'campaign_1', chunks[0]), /Sync 412/);
  assert.deepStrictEqual(await storage.readChunks(fakeSync().client, 'campaign_9'), []);
});

test('progressBody reports progress the way the browser reads it', () => {
  assert.deepStrictEqual(
    storage.progressBody('campaign_1', { totalMessages: 300, sent: 128, failed: 0 }, { resumeFrom: 128, checkpointFailed: false, throttled: true }),
    {
      success: true, campaignId: 'campaign_1', totalMessages: 300, resumeFrom: 128, isComplete: false,
      checkpointFailed: false, throttled: true, stats: { sent: 128, failed: 0 },
    }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/classic-campaign.test.js`
Expected: FAIL — `storage.createChunksMap is not a function`, and so on.

- [ ] **Step 3: Write the implementation** — in `assets/classic-campaign.private.js`, add below `const KEY_DIGITS = 7;`:

```js
const NOT_FOUND = 20404;
const ITEM_EXISTS = 54208;
const NAME_TAKEN = 54301;
```

below `byteSize`:

```js
function isNotFound(error) {
  return Boolean(error) && (error.status === 404 || error.code === NOT_FOUND);
}

/** Sync refused a write for its rate, even after the client's own retries. */
function isRateLimited(error) {
  return Boolean(error) && (error.status === 429 || error.code === 20429);
}
```

and above `module.exports`:

```js
/** Creates the campaign's chunk Map. One left by an earlier attempt is reused. */
async function createChunksMap(syncClient, campaignId) {
  try {
    await syncClient.syncMaps.create({ uniqueName: chunksMapName(campaignId) });
  } catch (error) {
    if (error.code !== NAME_TAKEN) throw error;
  }
}

/**
 * Claims the chunk starting at `start` before any of it is sent, by creating
 * its record holding the recipients' numbers. Sync refuses a key that exists,
 * so resolves to false when the chunk is already claimed, by another sender or
 * by an earlier attempt that may have sent it.
 */
async function claimChunk(syncClient, campaignId, start, messages, claimedAt) {
  try {
    await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems.create({
      key: chunkKey(start),
      data: { claimedAt, to: messages.map((message) => message.to) },
    });
    return true;
  } catch (error) {
    if (error.code === ITEM_EXISTS) return false;
    throw error;
  }
}

/** Records a sent chunk's rows over its claim. */
async function recordChunk(syncClient, campaignId, start, { claimedAt, to }, rows, sentAt) {
  await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems(chunkKey(start)).update({
    data: { claimedAt, to, sentAt, rows },
  });
}

/** Every chunk record in send order, or [] when the Map is missing. */
async function readChunks(syncClient, campaignId) {
  let items;
  try {
    items = await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems.list({ pageSize: 100 });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return items.map((item) => ({ ...(item.data || {}), key: item.key, start: Number(item.key), revision: item.revision }));
}

/**
 * Writes a refreshed chunk record back, conditional on the revision it was
 * read at: a 412 means something wrote it since.
 */
async function updateChunk(syncClient, campaignId, chunk) {
  const { claimedAt, to, sentAt, rows, checkedAt, settled } = chunk;
  await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems(chunk.key).update({
    data: { claimedAt, to, sentAt, rows, checkedAt, settled },
    ...(chunk.revision ? { ifMatch: chunk.revision } : {}),
  });
}

/**
 * Sends `messages`, the slice of the campaign starting at `offset`, chunk by
 * chunk until the slice is done or `deadline` passes: claiming each chunk,
 * sending it, recording its rows. A chunk already claimed is skipped, uncounted,
 * because it may have been sent. Chunk starts are at least `interval` apart,
 * to stay under the Map's write rate.
 *
 * `send(messages, startIndex)` is classic-messages.js sendChunk, passed in
 * because deployed assets cannot require each other. `campaignData` is the
 * Document's data, updated in place and written once, at the end.
 *
 * Resolves to { resumeFrom, checkpointFailed, throttled }: where the next call
 * starts; whether a result or the Document could not be saved; and whether Sync
 * refused a write for its rate, so the caller should wait before the next call.
 * A sent chunk whose rows cannot be recorded keeps its claim, so its recipients
 * show as not confirmed rather than disappearing. Throws only when the first
 * claim fails for a reason other than the rate.
 */
async function runChunks({
  syncClient, campaignId, campaignData, messages, offset, deadline, send,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), interval = CHUNK_INTERVAL_MS,
}) {
  const end = offset + messages.length;
  let currentIndex = offset;
  let checkpointFailed = false;
  let throttled = false;

  while (currentIndex < end && now() < deadline) {
    const chunkStart = currentIndex;
    const started = now();
    const batch = messages.slice(chunkStart - offset, chunkStart - offset + CHUNK_SIZE);
    const claimedAt = new Date(started).toISOString();

    let claimed;
    try {
      claimed = await claimChunk(syncClient, campaignId, chunkStart, batch, claimedAt);
    } catch (error) {
      if (isRateLimited(error)) {
        throttled = true;
        break;
      }
      if (currentIndex === offset) throw error;
      console.error(`Could not claim ${campaignId} at index ${chunkStart}:`, error);
      break;
    }
    currentIndex += batch.length;

    if (claimed) {
      const results = await send(batch, chunkStart);
      const accepted = results.filter((result) => result.success).length;
      campaignData.sent = (campaignData.sent || 0) + accepted;
      campaignData.failed = (campaignData.failed || 0) + (results.length - accepted);
      try {
        await recordChunk(syncClient, campaignId, chunkStart,
          { claimedAt, to: batch.map((message) => message.to) }, rowsFor(results), new Date(now()).toISOString());
      } catch (error) {
        console.error(`Could not record ${campaignId} at index ${chunkStart}:`, error);
        checkpointFailed = true;
        throttled = throttled || isRateLimited(error);
        break;
      }
    }

    const elapsed = now() - started;
    if (currentIndex < end && elapsed < interval) await sleep(interval - elapsed);
  }

  // Once per call. With claims guarding every chunk, a stale stored index can
  // only make a later call skip chunks already claimed, never re-send them.
  campaignData.startIndex = Math.max(campaignData.startIndex || 0, currentIndex);
  campaignData.pending = Math.max(0, campaignData.totalMessages - (campaignData.sent || 0) - (campaignData.failed || 0));
  campaignData.lastUpdated = new Date(now()).toISOString();
  try {
    await syncClient.documents(campaignId).update({ data: campaignData });
  } catch (error) {
    console.error(`Could not save progress for ${campaignId} at index ${currentIndex}:`, error);
    checkpointFailed = true;
  }

  return { resumeFrom: currentIndex, checkpointFailed, throttled };
}

/** The 200 body of send-messages.js. */
function progressBody(campaignId, campaignData, outcome) {
  return {
    success: true,
    campaignId,
    totalMessages: campaignData.totalMessages,
    resumeFrom: outcome.resumeFrom,
    isComplete: outcome.resumeFrom >= campaignData.totalMessages,
    checkpointFailed: outcome.checkpointFailed,
    throttled: outcome.throttled,
    stats: { sent: campaignData.sent, failed: campaignData.failed },
  };
}
```

Add to `module.exports`: `createChunksMap, claimChunk, recordChunk, readChunks, updateChunk, runChunks, progressBody,`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/classic-campaign.test.js`
Expected: PASS, 25 tests, pristine output.

- [ ] **Step 5: Commit**

```bash
git add assets/classic-campaign.private.js test/classic-campaign.test.js
git commit -m "feat: claim, send and record classic chunks from the request, paced to Sync's rate"
```

---

### Task 3: Messages API helpers — fetch statuses, drop record semantics

**Files:**
- Modify: `assets/classic-messages.private.js`
- Modify: `test/classic-messages.test.js`

**Interfaces:**
- Keeps: `messageParams`, `retryWithExponentialBackoff`, `sendChunk` (unchanged).
- Removes: `pendingKeys`, `selectRefreshBuckets`, `refreshStatuses`, `bucketUpdates`, `placeholderStatuses`, `tally`, `FETCH_ERROR_MAX_CHARS` export, and the constants only they used (`PLACEHOLDER_PREFIX`, `CLAIM_SENDING_MS`, `FINAL`, `READ_RECEIPT_CHANNELS`, `TERMINAL_FAILURE`, `MESSAGE_SID`) and functions (`statusOf`, `isFinal`). Status semantics now live in `classic-campaign.private.js`.
- Produces: `fetchStatuses(client, sids, { deadline = Infinity, now = Date.now, concurrency = 20 }) → Promise<Map<sid, { status, errorCode, errorMessage, dateSent, dateUpdated } | { error }>>`.

- [ ] **Step 1: Update the tests**

In `test/classic-messages.test.js`, delete every test that calls `pendingKeys`, `selectRefreshBuckets`, `refreshStatuses`, `bucketUpdates`, `placeholderStatuses` or `tally`. Keep the `messageParams`, `sendChunk` and `retryWithExponentialBackoff` tests. Append:

```js
test('fetchStatuses fetches each SID once, in order, at most `concurrency` at a time', async () => {
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
      return { status: 'delivered', errorCode: null, errorMessage: null, dateSent: null, dateUpdated: new Date(0) };
    },
  });
  const sids = Array.from({ length: 7 }, (_, i) => sid(i));
  const fetched = await classicMessages.fetchStatuses(client, sids, { concurrency: 3 });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(order, sids);
  assert.deepStrictEqual(fetched.get(sid(0)), {
    status: 'delivered', errorCode: null, errorMessage: null, dateSent: null, dateUpdated: new Date(0),
  });
});

test('fetchStatuses records a failed fetch, truncated, and starts none after the deadline', async () => {
  const failing = fakeClient({ fetch: async () => { throw new Error('x'.repeat(500)); } });
  const fetched = await classicMessages.fetchStatuses(failing, [sid(1)]);
  assert.strictEqual(fetched.get(sid(1)).error.length, 64);

  const never = fakeClient({ fetch: async () => assert.fail('fetched after the deadline') });
  const none = await classicMessages.fetchStatuses(never, [sid(1)], { deadline: 0, now: () => 1 });
  assert.strictEqual(none.size, 0);
});
```

(`fakeClient`, `tick` and `sid` already exist in that file.)

- [ ] **Step 2: Run them to verify the new ones fail**

Run: `node --test test/classic-messages.test.js`
Expected: FAIL — `classicMessages.fetchStatuses is not a function`.

- [ ] **Step 3: Implement**

In `assets/classic-messages.private.js`:
- Replace the header comment's second paragraph with: "Messages are sent with no statusCallback: check-status.js fetches the statuses that can still change (see classic-campaign.private.js for which)."
- Delete the removed constants and functions listed under Interfaces.
- Keep `FETCH_CONCURRENCY = 20` and `FETCH_ERROR_MAX_CHARS = 64` (unexported), and reword the latter's comment: "Characters kept of why a status fetch failed: enough to debug with, short enough to keep a response small."
- Remove the sentence about packRecipient from `messageParams`' comment, keeping "A null field is treated as absent."
- Add:

```js
/**
 * Fetches each message's current status from Twilio, in the order given,
 * `concurrency` at a time, starting none once `deadline` has passed. Resolves
 * to a Map from SID to its status fields, or to `{ error }` when the fetch
 * failed. A SID missing from the Map was not reached; a later poll gets it.
 */
async function fetchStatuses(client, sids, { deadline = Infinity, now = Date.now, concurrency = FETCH_CONCURRENCY } = {}) {
  const fetched = new Map();
  const queue = [...sids];

  const worker = async () => {
    while (queue.length && now() < deadline) {
      const messageSid = queue.shift();
      try {
        const message = await client.messages(messageSid).fetch();
        fetched.set(messageSid, {
          status: message.status,
          errorCode: message.errorCode == null ? null : message.errorCode,
          errorMessage: message.errorMessage || null,
          dateSent: message.dateSent || null,
          dateUpdated: message.dateUpdated || null,
        });
      } catch (error) {
        fetched.set(messageSid, { error: String(error.message).slice(0, FETCH_ERROR_MAX_CHARS) });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return fetched;
}
```

- `module.exports = { messageParams, retryWithExponentialBackoff, sendChunk, fetchStatuses };`

- [ ] **Step 4: Run**

Run: `node --test test/classic-messages.test.js test/classic-campaign.test.js`
Expected: PASS, pristine. (The Functions still reference removed helpers until Task 4; `npm test` covers only `test/`, so it passes too.)

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/classic-messages.private.js test/classic-messages.test.js
git commit -m "refactor: classic-messages talks to the Messages API only; add fetchStatuses"
```

---

### Task 4: Functions — send a slice, poll lean records, retire resume-execution

**Files:**
- Rewrite: `functions/send-messages.js`
- Delete: `functions/resume-execution.js`
- Modify: `functions/check-status.js`
- Modify: `functions/list-campaigns.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces, for Task 5:
  - `POST /send-messages` `{ messages, offset, totalMessages, fingerprint, campaignId, channel, from, campaignName, details? }` → 200 `progressBody` (`resumeFrom`, `isComplete`, `checkpointFailed`, `throttled`, `stats`). 400 bad slice or fingerprint; 404 not found/owned (or `offset > 0` for a campaign that does not exist); 409 bulk, older format, or a different list.
  - `POST /check-status` `{ campaignId, refresh? }` — `refresh: false` reads only and writes nothing. Response shape unchanged.
  - `POST /list-campaigns` — classic lean campaigns carry `resumable` (unfinished) and `fingerprint`; others `resumable: false`, `fingerprint: null`.

- [ ] **Step 1: Replace `functions/send-messages.js` with:**

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * POST /send-messages — sends one slice of a classic campaign's recipient list.
 *
 * The browser holds the list and sends it slice by slice, each call starting
 * where the last one reached; the first call creates the campaign. A call for a
 * campaign that exists must carry the same list, by fingerprint, so resuming
 * means sending the same list again. Chunks already claimed are skipped, so
 * nothing is sent twice. See classic-campaign.private.js.
 */

/**
 * No chunk starts after this. A chunk is up to 128 sends plus two writes of its
 * record, and must finish inside the 10-second ceiling.
 */
const SEND_DEADLINE_MS = 7000;

/** No send or 429 retry starts after this. */
const RETRY_DEADLINE_MS = 9000;

const FINGERPRINT = /^[0-9a-f]{64}$/;

const OLDER_FORMAT = 'This campaign was saved in an older format and cannot be continued. ' +
  'Check the Messaging logs in the Twilio Console for what was sent before sending the rest as a new campaign.';

const DIFFERENT_LIST = 'These recipients and messages do not match the campaign being continued. ' +
  'Load the same list with the same settings, or send it as a new campaign.';

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

    // Slices hold whole chunks, so a chunk is always sent from one call.
    const offset = event.offset === undefined ? 0 : Number(event.offset);
    const totalMessages = event.totalMessages === undefined ? messages.length : Number(event.totalMessages);
    const end = offset + messages.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % storage.CHUNK_SIZE !== 0 ||
        !Number.isSafeInteger(totalMessages) || end > totalMessages ||
        (messages.length % storage.CHUNK_SIZE !== 0 && end !== totalMessages)) {
      response.setStatusCode(400);
      response.setBody({ error: 'offset, totalMessages and the slice must cover whole chunks of the campaign' });
      return callback(null, response);
    }

    const fingerprint = String(event.fingerprint || '');
    if (!FINGERPRINT.test(fingerprint)) {
      response.setStatusCode(400);
      response.setBody({ error: 'fingerprint is required' });
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
    // confirmed to exist. Same `!data` guard as list-campaigns.js.
    if (existing && !(existing.data && existing.data.ownerKey === ownerKey)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    let campaignData;
    if (!existing) {
      if (offset !== 0) {
        response.setStatusCode(404);
        response.setBody({ error: 'Campaign not found' });
        return callback(null, response);
      }
      await storage.createChunksMap(syncClient, campaignDocName);
      campaignData = storage.newCampaignData({
        ownerKey,
        accountSid: client.accountSid,
        totalMessages,
        fingerprint,
        // For the card and the delivery panel: what every message had in common.
        shared: storage.sharedFields(messages),
        channel,
        from,
        campaignName,
        details: campaignDetails.buildDetails(event.details, {
          mode: 'classic',
          contentSid: messages[0] && messages[0].contentSid,
          recipientCount: totalMessages,
        }),
        now: new Date().toISOString(),
      });
      await syncClient.documents.create({ uniqueName: campaignDocName, data: campaignData });
    } else {
      campaignData = existing.data;
      const refusal = campaignData.mode === 'bulk'
        ? 'Bulk Messaging campaigns run on Twilio and are never continued here.'
        : !storage.isLean(campaignData) ? OLDER_FORMAT
        : (campaignData.fingerprint !== fingerprint || campaignData.totalMessages !== totalMessages) ? DIFFERENT_LIST
        : null;
      if (refusal) {
        response.setStatusCode(409);
        response.setBody({ error: refusal });
        return callback(null, response);
      }
    }

    const outcome = await storage.runChunks({
      syncClient,
      campaignId: campaignDocName,
      campaignData,
      messages,
      offset,
      deadline: startTime + SEND_DEADLINE_MS,
      send: (batch, index) => classicMessages.sendChunk(client, batch, {
        startIndex: index,
        channel: campaignData.channel,
        from: campaignData.from,
        messagingServiceSid: context.MESSAGING_SERVICE_SID,
        deadline: startTime + RETRY_DEADLINE_MS,
      }),
    });

    response.setStatusCode(200);
    response.setBody(storage.progressBody(campaignDocName, campaignData, outcome));
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

- [ ] **Step 2: Delete the resume Function**

```bash
git rm functions/resume-execution.js
```

- [ ] **Step 3: Modify `functions/check-status.js`**

- Replace the `MAX_REFRESH_BUCKETS` constant and its comment with:

```js
/**
 * Chunks refreshed per poll: up to 384 fetches and 3 writes, leaving most of the
 * chunk Map's write rate (about 2 a second) to sending. A larger campaign's
 * chunks take turns, least recently checked first, over several polls.
 */
const MAX_REFRESH_CHUNKS = 3;
```

- Replace everything from the comment `// A bucketed campaign keeps its statuses in a Map.` down to and including the closing `}` of the `try { await syncClient.documents(campaignId).update({ data: campaignData, ifMatch: revision }); } catch …` block with:

```js
    // `refresh: false` reads only: the page sends it while this tab is sending,
    // so polls take nothing from the chunk Map's write rate.
    const refresh = event.refresh !== false && event.refresh !== 'false';
    const channel = campaignData.channel;
    const checkedAt = new Date().toISOString();
    let statuses;

    if (storage.isLean(campaignData)) {
      const chunks = await storage.readChunks(syncClient, campaignId);
      if (refresh) {
        const { selected, takingTurns } = storage.selectChunks(chunks, channel, MAX_REFRESH_CHUNKS);
        const sids = selected.flatMap((chunk) => storage.pendingRows(chunk, channel).map((i) => chunk.rows[i][0]));
        const fetched = await classicMessages.fetchStatuses(client, sids, { deadline: startTime + FETCH_DEADLINE_MS });
        const plan = storage.refreshPlan(selected, fetched, { channel, takingTurns, checkedAt });
        const refreshed = new Map(plan.map((entry) => [entry.chunk.key, entry.chunk]));
        chunks.forEach((chunk, i) => {
          if (refreshed.has(chunk.key)) chunks[i] = refreshed.get(chunk.key);
        });
        // One at a time: at most three, and each conditional on the revision
        // read. A 412 means a send wrote the record since; a later poll retries.
        for (const entry of plan.filter((item) => item.write)) {
          try {
            await storage.updateChunk(syncClient, campaignId, entry.chunk);
          } catch (error) {
            if (error.status !== 412) console.error(`Could not save chunk ${entry.chunk.key} of ${campaignId}:`, error);
          }
        }
      }
      const now = Date.now();
      statuses = Object.assign({}, ...chunks.map((chunk) => storage.chunkStatuses(chunk, now)));
    } else {
      // An older campaign keeps its statuses inline, on the Document.
      statuses = campaignData.statuses || {};
      if (refresh) {
        const fetched = await classicMessages.fetchStatuses(client, storage.legacyPending(statuses, channel),
          { deadline: startTime + FETCH_DEADLINE_MS });
        statuses = storage.applyLegacy(statuses, fetched);
        campaignData.statuses = statuses;
      }
    }

    const counts = storage.tally(statuses);
    campaignData.sent = counts.sent;
    campaignData.delivered = counts.delivered;
    campaignData.read = counts.read;
    campaignData.failed = counts.failed;
    campaignData.pending = counts.pending;
    campaignData.unconfirmed = counts.unconfirmed;

    if (refresh) {
      campaignData.lastUpdated = checkedAt;
      // Conditional on the revision read above. A send that saved progress
      // since then owns startIndex; losing this write costs a stale counter
      // until the next poll.
      try {
        await syncClient.documents(campaignId).update({ data: campaignData, ifMatch: revision });
      } catch (error) {
        if (error.status !== 412) throw error;
      }
    }
```

- Everything after (the `statusesFit` check, details, and the response) stays as is.

- [ ] **Step 4: Modify `functions/list-campaigns.js`**

Replace:

```js
        // False for older campaigns and for ones whose upload was cut off;
        // see resume-execution.js.
        resumable: storage.isFullyStored(campaignData),
```

with:

```js
        // Continued by sending the same list again, recognised by fingerprint.
        // Older campaigns cannot be continued.
        resumable: storage.isLean(campaignData) && (campaignData.startIndex || 0) < (campaignData.totalMessages || 0),
        fingerprint: storage.isLean(campaignData) ? campaignData.fingerprint || null : null,
```

- [ ] **Step 5: Check**

Run: `node --check functions/send-messages.js && node --check functions/check-status.js && node --check functions/list-campaigns.js && npm test`
Expected: no syntax error; all tests pass.

Run: `grep -rn "isBucketed\|isFullyStored\|readStatusBuckets\|updateStatusBucket\|storeRecipients\|resume-execution\|selectRefreshBuckets\|refreshStatuses\|bucketUpdates\|placeholderStatuses" functions/ assets/*.private.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add functions/send-messages.js functions/check-status.js functions/list-campaigns.js
git commit -m "feat: send classic slices from the browser and poll lean chunk records; retire resume-execution"
```

---

### Task 5: Browser — progress indicator, sliced send, continue by fingerprint

**Files:**
- Modify: `assets/app.js`
- Modify: `assets/index.html` (after the Send button)
- Modify: `assets/styles.css`

**Interfaces:**
- Consumes: Task 4's Function contracts.

- [ ] **Step 1: The progress indicator markup and style**

In `assets/index.html`, directly after:

```html
                                    <button type="submit" class="btn btn-primary" id="send-btn">Send Messages</button>
```

add:

```html
                                    <div id="send-progress" class="send-progress" role="status" aria-live="polite" hidden>
                                        <span class="spinner" aria-hidden="true"></span>
                                        <span id="send-progress-text" class="send-progress__text">Preparing…</span>
                                        <progress id="send-progress-bar" class="send-progress__bar" max="1"></progress>
                                    </div>
```

In `assets/styles.css`, after the `.limit-notice { … }` rule, add:

```css
/* Beside Send while a campaign goes out: what is happening, and how far it is.
   The bar is indeterminate (no value) until there is a count to show. */
.send-progress {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    font-size: 13px;
    color: var(--text);
}

.send-progress[hidden] { display: none; }

.send-progress__text { white-space: nowrap; }

.send-progress__bar {
    flex: 1;
    min-width: 80px;
    height: 8px;
    accent-color: var(--accent);
}

.spinner {
    flex: none;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
}
```

- [ ] **Step 2: Constants and helpers**

In `assets/app.js`, replace:

```js
/**
 * Most JSON per send-messages request. A Function request is capped at 1 MB,
 * credentials and headers included, so the recipient list goes up in slices.
 */
const UPLOAD_MAX_BYTES = 700 * 1024;

/** Shown when a send or resume finished but a checkpoint could not be saved. */
const CHECKPOINT_WARNING = 'Sending finished, but progress could not be saved for some messages. '
    + 'They were sent, but may show as "not confirmed" in the delivery table. '
    + 'The Messaging logs in the Twilio Console have the full record.';
```

with:

```js
/**
 * Recipients per chunk. Mirrors CHUNK_SIZE in assets/classic-campaign.private.js:
 * each slice sent holds whole chunks, so a chunk is never split across calls.
 */
const CHUNK_SIZE = 128;

/**
 * Most chunks per send-messages call: a little more than one call sends in its
 * 7-second budget, so a slice is rarely sent twice. The rest is sent again by
 * the next call, from where this one reached.
 */
const SLICE_MAX_CHUNKS = 8;

/** Most JSON per send-messages call. A Function request is capped at 1 MB. */
const SLICE_MAX_BYTES = 700 * 1024;

/** Times in a row to wait and retry when Sync refuses writes for its rate. */
const THROTTLE_RETRIES = 5;

/** Shown when a send finished but some results could not be saved. */
const CHECKPOINT_WARNING = 'Sending finished, but some results could not be saved. '
    + 'Those recipients show as "not confirmed": the Messaging logs in the Twilio Console say whether they were sent.';

/** How a stopped classic campaign is continued. */
const SEND_STOPPED = 'Sending stopped. To continue, load the same recipients with the same settings and click '
    + 'Send Messages: the app recognizes the campaign and skips everyone already sent.';

/** What the Resume button explains: the server keeps no copy of the list. */
const RESUME_HOW = 'To resume, load the same recipients (the same CSV, or the same typed list) with the same '
    + 'sender and message settings, then click Send Messages. The app recognizes this campaign, asks to '
    + 'continue it, and skips everyone already sent.';

/** Campaigns as list-campaigns last returned them, for recognising a list sent before. */
let loadedCampaigns = [];
```

Replace the whole `uploadSliceEnd` function (with its comment) with:

```js
/**
 * Where the slice starting at `start` ends: whole chunks only (the last may be
 * short), at most SLICE_MAX_CHUNKS, under SLICE_MAX_BYTES of JSON, and at least
 * one chunk.
 */
function sliceEnd(messages, start) {
    const encoder = new TextEncoder();
    let end = start;
    let bytes = 0;
    while (end < messages.length && end - start < SLICE_MAX_CHUNKS * CHUNK_SIZE) {
        const chunkEnd = Math.min(end + CHUNK_SIZE, messages.length);
        let chunkBytes = 0;
        for (let i = end; i < chunkEnd; i++) chunkBytes += encoder.encode(JSON.stringify(messages[i])).length + 1;
        if (end > start && bytes + chunkBytes > SLICE_MAX_BYTES) break;
        bytes += chunkBytes;
        end = chunkEnd;
    }
    return end;
}

/** SHA-256 of the messages as sent, in hex: how a list sent before is recognised. */
async function listFingerprint(messages) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(messages)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An unfinished classic campaign sent with exactly these messages, if any. */
function findUnfinishedCampaign(fingerprint, total) {
    return loadedCampaigns.find((campaign) => campaign.mode === 'classic' && campaign.resumable
        && campaign.fingerprint === fingerprint && campaign.totalMessages === total) || null;
}

/** Shows the progress indicator; with no `total`, its bar is indeterminate. */
function updateSendProgress(text, done = 0, total = 0) {
    const panel = document.getElementById('send-progress');
    if (!panel) return;
    panel.hidden = false;
    document.getElementById('send-progress-text').textContent = text;
    const bar = document.getElementById('send-progress-bar');
    if (total) {
        bar.max = total;
        bar.value = done;
    } else {
        bar.removeAttribute('value');
    }
}

function hideSendProgress() {
    const panel = document.getElementById('send-progress');
    if (panel) panel.hidden = true;
}

/** A Function's JSON reply, or null when there is none (a gateway timeout, a dropped connection). */
async function readJson(response) {
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
```

(If `sleep` already exists in `app.js`, keep the existing one and do not add a second.)

- [ ] **Step 3: Keep the campaign list for recognition**

In `loadCampaigns()`, replace:

```js
        if (response.ok && data.campaigns) {
            displayCampaigns(data.campaigns);
```

with:

```js
        if (response.ok && data.campaigns) {
            loadedCampaigns = data.campaigns;
            displayCampaigns(data.campaigns);
```

- [ ] **Step 4: Replace the send loop**

Delete `UPLOAD_MAY_HAVE_SENT`, `saveReachedIndex` and `continueCampaign` (with their comments). Keep `functionError`. Replace the whole `sendMessagesBatch` function, with its comment, with:

```js
/**
 * Sends a classic campaign slice by slice: each call sends what fits its time
 * budget and says where it reached, and the next starts there. The list stays
 * in this tab. A list matching an unfinished campaign, by fingerprint, can be
 * continued instead of sent again; its claimed chunks are skipped either way.
 */
async function sendMessagesBatch(messages, channel, from, campaignName, details) {
    const total = messages.length;
    const count = (n) => n.toLocaleString('en-US');

    updateSendProgress('Preparing the recipient list…');
    const fingerprint = await listFingerprint(messages);
    await loadCampaigns();

    // Captured once: opening another campaign mid-send moves currentCampaignId.
    let campaignId = currentCampaignId;
    let offset = 0;
    const match = findUnfinishedCampaign(fingerprint, total);
    if (match && confirm(`This list matches "${match.campaignName || match.campaignId}", which stopped after `
        + `${count(match.startIndex || 0)} of ${count(total)} recipients. Continue that campaign? `
        + 'Everyone already sent is skipped. Cancel starts a new campaign, which sends to everyone again.')) {
        campaignId = match.campaignId;
        offset = Math.floor((match.startIndex || 0) / CHUNK_SIZE) * CHUNK_SIZE;
        currentCampaignId = campaignId;
    }

    activeSendCampaignId = campaignId;
    let checkpointFailed = false;
    let waits = 0;
    try {
        while (offset < total) {
            updateSendProgress(waits
                ? 'Twilio Sync is busy — waiting before sending more…'
                : `Sending… ${count(offset)} of ${count(total)}`, offset, total);

            const end = sliceEnd(messages, offset);
            let response = null;
            try {
                response = await postToFunction('send-messages', {
                    messages: messages.slice(offset, end),
                    offset,
                    totalMessages: total,
                    fingerprint,
                    campaignId,
                    channel,
                    from,
                    campaignName: campaignName || null,
                    // Stored only when the first call creates the campaign.
                    ...(offset === 0 ? { details } : {})
                });
            } catch (error) {
                console.error('send-messages call failed:', error);
            }
            const data = response ? await readJson(response) : null;

            if (!data || !response.ok) {
                const status = response ? `HTTP ${response.status}` : 'no response';
                activeSendCampaignId = null;
                await loadCampaigns();
                throw new Error(`${functionError(data, `Failed to send messages (${status})`)}. ${SEND_STOPPED}`);
            }

            checkpointFailed = checkpointFailed || Boolean(data.checkpointFailed);
            if (data.resumeFrom > offset) {
                offset = data.resumeFrom;
                waits = 0;
            } else if (data.throttled && waits < THROTTLE_RETRIES) {
                waits++;
            } else {
                activeSendCampaignId = null;
                await loadCampaigns();
                throw new Error(`Failed to send messages (no progress). ${SEND_STOPPED}`);
            }

            await refreshCurrentCampaign({ refresh: false });
            if (offset < total) await sleep(data.throttled ? 2000 * Math.max(1, waits) : 500);
        }

        updateSendProgress('Finishing…', total, total);
        if (checkpointFailed) alert(CHECKPOINT_WARNING);

        // Final status check
        await refreshCurrentCampaign();

        // Reload campaigns list
        await loadCampaigns();

        // Start auto-refresh
        startStatusAutoRefresh();

        setSendingState(false);
    } finally {
        activeSendCampaignId = null;
    }
}
```

- [ ] **Step 5: Show the indicator for every send, and hide it after**

In `handleSendMessages()`, replace:

```js
    try {
        if (isBulkMode()) {
            await sendBulkCampaign(messages, channel, from, campaignName, details);
        } else {
            await sendMessagesBatch(messages, channel, from, campaignName, details);
        }
    } catch (error) {
        alert('Error: ' + error.message);
        setSendingState(false);
    }
```

with:

```js
    try {
        if (isBulkMode()) {
            updateSendProgress('Submitting to Bulk Messaging…');
            await sendBulkCampaign(messages, channel, from, campaignName, details);
        } else {
            await sendMessagesBatch(messages, channel, from, campaignName, details);
        }
    } catch (error) {
        alert('Error: ' + error.message);
        setSendingState(false);
    } finally {
        hideSendProgress();
    }
```

- [ ] **Step 6: Resume explains; polls while sending only read**

Replace the whole `resumeCampaignById` function with:

```js
/**
 * Classic campaigns are continued by sending the same list again (the server
 * keeps no copy of it), so the Resume button says how rather than doing it.
 */
function resumeCampaignById(campaignId, event) {
    alert(RESUME_HOW);
}
```

Delete `showResumeOption` if nothing references it any more (`grep -n showResumeOption assets/app.js`).

Replace:

```js
async function refreshCurrentCampaign() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
        if (currentCampaignMode === 'bulk') return await checkBulkCampaignStatus();
        return await checkCampaignStatus();
```

with:

```js
async function refreshCurrentCampaign(options = {}) {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
        if (currentCampaignMode === 'bulk') return await checkBulkCampaignStatus();
        return await checkCampaignStatus(options);
```

In `checkCampaignStatus`, change the signature to `async function checkCampaignStatus(options = {})` and the call to:

```js
        const response = await postToFunction('check-status', {
            campaignId: currentCampaignId,
            // While this tab sends, polls only read, leaving Sync's write rate to sending.
            ...(options.refresh === false ? { refresh: false } : {})
        });
```

In `startStatusAutoRefresh`, replace:

```js
            await refreshCurrentCampaign();
            await loadCampaigns(); // Also refresh the campaigns list
```

with:

```js
            await refreshCurrentCampaign({ refresh: activeSendCampaignId !== currentCampaignId });
            await loadCampaigns(); // Also refresh the campaigns list
```

- [ ] **Step 7: Check**

Run: `node --check assets/app.js && grep -n "resume-execution\|continueCampaign\|saveReachedIndex\|uploadSliceEnd\|UPLOAD_MAX_BYTES\|UPLOAD_MAY_HAVE_SENT\|storedCount" assets/app.js`
Expected: no syntax error, no grep output.

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add assets/app.js assets/index.html assets/styles.css
git commit -m "feat: progress indicator and sliced classic sends that continue the same list by fingerprint"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md` (append)

- [ ] **Step 1: README replacements** (each `Replace` block matches the current text exactly)

Line 9, replace `tested to 10,000 recipients` with `tested to 2,000 recipients`.

Line 21, replace:

```
| Resumable | yes, checkpointed to Sync | not needed; there is no browser-driven loop to interrupt |
```

with:

```
| Resumable | yes: send the same list again and the app continues it | not needed; there is no browser-driven loop to interrupt |
```

Line 107, replace the paragraph starting `> Nothing is lost if sending is interrupted.` with:

```
> Nothing is sent twice if sending is interrupted. Progress is saved in Sync, so the campaign shows as **In Progress**. To continue, load the same recipients with the same settings and click **Send Messages**: the app recognizes the list, asks to continue the campaign, and skips everyone already sent. The **Resume** button explains this, since the deployment keeps no copy of your list. Closing the tab also clears your credentials, so you will need to sign in again first.
```

Replace the three paragraphs of "How resumable execution works" that begin `The page uploads the recipient list`, `Each chunk is claimed in Sync`, `A campaign's Sync Document holds only`, and `` `check-status.js` refreshes the 24 status buckets`` with:

```
The page keeps the recipient list and sends it to `send-messages.js` in slices of whole 128-recipient chunks, at most eight chunks and 700 KB at a time, since a Function request is capped at 1 MB. Each call sends what fits its budget, starting no chunk after 7 seconds so the last finishes inside the platform's 10-second ceiling, and says where it reached; the next call starts there. A progress indicator beside **Send Messages** shows each stage.

Sync records as little as possible, because it accepts only about 2 writes a second per Map for items of a few KB (measured: 22 of 48 9 KB writes sent eight at a time, 20 of 20 at two a second). Each chunk has one record in the `campaign_<id>_chunks` Map. It is created, holding the recipients' numbers, before the chunk is sent — Sync allows that only once, so no chunk is ever sent twice — and updated afterwards with one compact row per recipient: message SID, status, error code, time. Chunks are paced 1.1 seconds apart. The campaign Document holds the owner, counters, progress, display fields, and a SHA-256 fingerprint of the list, which is how a list sent again is recognized. While a chunk is being sent, its recipients show as "sending"; if its result was never saved, they show as "not confirmed" — the Messaging logs in the Twilio Console say whether they were sent.

`check-status.js` fetches statuses from Twilio for at most 3 chunks per poll, least recently checked first, and writes back only those, so a large campaign's statuses catch up over several 5-second polls. While the page is sending, its polls only read. Past roughly 13,000 messages the per-message list no longer fits the 4 MB Function response, so the delivery panel shows the counts only. Campaigns saved in earlier layouts still open, but cannot be continued.
```

In the architecture block, replace:

```
  send-messages.js          Stores the recipient list in Sync, then starts sending
  resume-execution.js       Continues a campaign from Sync, chunk by chunk
```

with:

```
  send-messages.js          Sends one slice of a campaign, chunk by chunk
```

and replace `Sync layout and chunk loop for Programmable Messaging` with `Chunk records and the send loop for Programmable Messaging`, and `Sending and status refresh for Programmable Messaging` with `Sending and status fetches for Programmable Messaging`.

Troubleshooting: replace the **Timeouts** paragraph with:

```
**Timeouts.** Handled automatically by chunking. If a single chunk still overruns, lower `CHUNK_SIZE` in both `assets/classic-campaign.private.js` and `assets/app.js`.

**"Twilio Sync is busy".** Sync refused writes for its rate; the page waits and carries on. If it gives up, send the same list again to continue.
```

and replace the **No Resume button on an unfinished campaign** paragraph with:

```
**Resume says to send the list again.** The deployment keeps no copy of your recipients. Load the same CSV (or typed list) with the same sender, template and message, and click Send Messages; the app recognizes the campaign by its fingerprint and continues it. A list that differs in any way is a new campaign. An unfinished campaign with no Resume button was saved in an earlier layout and cannot be continued: check the Messaging logs before sending the rest.
```

- [ ] **Step 2: Spec note** — append to `docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md`:

```

## Lean records (2026-11-12)

The bucketed layout failed live: uploading 2,000 recipients with their own bodies hit `Rate limit exceeded for write-map-…_recipients`. Measured, a Map accepts about 2 writes a second of items over 1 KiB, after a burst of about 20 — not the 20 a second the docs give for small items. The layout was replaced by lean records (plan `2026-11-12-classic-lean-sync.md`): the list stays in the browser and is sent slice by slice; Sync holds one claimed-then-recorded record per 128-recipient chunk and the campaign's fingerprint; statuses come from Twilio, with at most 3 records rewritten per poll.
```

- [ ] **Step 3: Check and commit**

Run: `grep -n "resume-execution\|RECIPIENT_BUCKET\|_recipients\|uploads the recipient list\|24 status buckets" README.md`
Expected: no output.

```bash
git add README.md docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md
git commit -m "docs: lean Sync records for classic campaigns"
```

---

### Task 7: Live verification on dev-environment (2,000 recipients)

Ask the user before Steps 3–6: they deploy and make API calls on the account. All sends go to `+999…` numbers, which Twilio refuses (error 21211): nothing is delivered.

- [ ] **Step 1:** `npm test` — all pass. Re-run `node /tmp/classic-harness/harness.js` after updating its fakes and scenarios for the lean contract (no upload, `fingerprint`, slices of whole chunks, `refresh: false`, no resume-execution); report pass/fail.
- [ ] **Step 2:** Confirm no environment variables (`npx twilio api:serverless:v1:services:environments:variables:list --service-sid ZSb34b1c5e48d1ba966735c9bdf0ac6ac4 --environment-sid ZE73f6bcab402752df22cbe74cc471db9d -p Abel` → "No results"), then `npm run deploy -- -p Abel`.
- [ ] **Step 3:** Smoke check: `send-messages`, `check-status`, `list-campaigns` → 400 on `{}`; `/classic-campaign.js`, `/classic-messages.js` → 403; `/resume-execution` and `/webhook` → 404.
- [ ] **Step 4 (user, browser):** hard-refresh, sign in. Send `/tmp/classic-task9/classic-2000.csv` with a typed body, then `/tmp/classic-task9/classic-2000-bodies.csv`. Expected: the progress indicator shows "Preparing…", then "Sending… N of 2,000" with a moving bar; both finish with 2,000 failed (21211) and no error.
- [ ] **Step 5 (user, browser):** send `classic-2000.csv` again as a new campaign, close the tab once the count moves, reopen, sign in, load the same CSV with the same settings, click Send. Expected: the "This list matches…" prompt; OK continues; the campaign ends with exactly 2,000 rows, none repeated. Clicking Resume on any unfinished campaign shows the explanation.
- [ ] **Step 6 (controller):** for each campaign, count `<campaignId>_chunks` items (expect 16 for 2,000), check every record has 128 rows (the last 80) and no record exceeds 16 KiB, and pull the Function logs for any 429 or `Could not record`. Record durations of the longest `send-messages` calls.
- [ ] **Step 7:** Report results in the PR description; update the README's "tested to" figure to what passed.
