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
