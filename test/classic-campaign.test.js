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
