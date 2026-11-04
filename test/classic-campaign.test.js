'use strict';

const test = require('node:test');
const assert = require('node:assert');

const storage = require('../assets/classic-campaign.private.js');

const FROM = '+15017122661';
const HX = `HX${'a'.repeat(32)}`;
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** `count` messages to distinct numbers, each extended by `extra(i)`. */
function messages(count, extra = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    to: `+1555${String(i).padStart(7, '0')}`,
    from: FROM,
    ...extra(i),
  }));
}

test('bucketKey zero-pads so that key order is send order', () => {
  assert.strictEqual(storage.bucketKey(0), '0000000');
  assert.strictEqual(storage.bucketKey(128), '0000128');
  assert.deepStrictEqual([9984, 128, 0, 1024].map(storage.bucketKey).sort(), [
    '0000000', '0000128', '0001024', '0009984',
  ]);
});

test('fields every message shares are stored once, leaving each recipient as `to`', () => {
  const { shared, buckets } = storage.packRecipients(messages(3, () => ({ body: 'Sale today' })));
  assert.deepStrictEqual(shared, { from: FROM, body: 'Sale today' });
  assert.deepStrictEqual(buckets[0].recipients, [
    { to: '+15550000000' }, { to: '+15550000001' }, { to: '+15550000002' },
  ]);
});

test('a field that varies stays on each recipient', () => {
  const { shared, buckets } = storage.packRecipients(messages(2, (i) => ({ body: `Hi ${i}` })));
  assert.deepStrictEqual(shared, { from: FROM });
  assert.deepStrictEqual(buckets[0].recipients, [
    { to: '+15550000000', body: 'Hi 0' },
    { to: '+15550000001', body: 'Hi 1' },
  ]);
});

test('a field only some messages carry is not shared', () => {
  const list = messages(2);
  list[0].body = 'Only the first';
  const { shared, buckets } = storage.packRecipients(list);
  assert.deepStrictEqual(shared, { from: FROM });
  assert.deepStrictEqual(buckets[0].recipients[1], { to: '+15550000001' });
});

test('a shared field over the budget stays on each recipient', () => {
  const body = 'x'.repeat(storage.SHARED_MAX_BYTES + 1);
  const { shared, buckets } = storage.packRecipients(messages(2, () => ({ body })));
  assert.deepStrictEqual(shared, { from: FROM });
  assert.strictEqual(buckets[0].recipients[0].body, body);
});

test('a later slice is packed against the first slice\'s shared fields', () => {
  const first = storage.packRecipients(messages(2, () => ({ body: 'Sale' })));
  const later = messages(3, (i) => (i === 0 ? { body: 'Sale' } : i === 1 ? { body: 'Different' } : {}));
  const { buckets } = storage.packRecipients(later, { shared: first.shared, startIndex: 500 });
  assert.strictEqual(buckets[0].start, 500);
  // A shared field the message lacks is stored as null, which every send path treats as absent.
  assert.deepStrictEqual(buckets[0].recipients, [
    { to: '+15550000000' },
    { to: '+15550000001', body: 'Different' },
    { to: '+15550000002', body: null },
  ]);
});

test('recipient buckets hold at most 128 and are keyed by their first index', () => {
  const { buckets } = storage.packRecipients(messages(300));
  assert.deepStrictEqual(buckets.map((b) => [b.start, b.recipients.length]), [[0, 128], [128, 128], [256, 44]]);
});

test('long per-recipient bodies fill buckets by size before count', () => {
  const { buckets } = storage.packRecipients(messages(40, (i) => ({ body: `${i} ${'x'.repeat(1000)}` })));
  assert.ok(buckets.length > 2);
  for (const bucket of buckets) {
    assert.ok(size({ recipients: bucket.recipients }) <= storage.RECIPIENT_BUCKET_MAX_BYTES);
  }
  // Contiguous: each bucket starts where the previous one ended.
  const end = buckets.reduce((next, bucket) => {
    assert.strictEqual(bucket.start, next);
    return next + bucket.recipients.length;
  }, 0);
  assert.strictEqual(end, 40);
});

test('10,000 recipients sharing a long body pack into 79 buckets', () => {
  const { buckets } = storage.packRecipients(messages(10000, () => ({ body: 'x'.repeat(1600) })));
  assert.strictEqual(buckets.length, 79);
});

test('unpacking every bucket gives back the original messages', () => {
  const original = messages(300, (i) => ({
    body: i % 2 ? `Odd ${i}` : 'Even',
    contentSid: HX,
    contentVariables: { 1: `Name ${i}` },
  }));
  const { shared, buckets } = storage.packRecipients(original);
  const roundTrip = buckets.flatMap((bucket) =>
    bucket.recipients.map((entry) => storage.unpackRecipient(entry, shared)));
  assert.deepStrictEqual(roundTrip, original);
});

test('a full status bucket stays under the 10 KiB write-throttling threshold', () => {
  // An entry as check-status.js leaves it once enriched from Twilio.
  const statuses = {};
  for (let i = 0; i < storage.STATUS_BUCKET_ENTRIES; i++) {
    statuses[`SM${String(i).padStart(32, '0')}`] = {
      status: 'delivered', to: '+15558675310', sentAt: '2026-11-04T00:00:00.000Z',
      errorCode: null, errorMessage: null,
      dateSent: '2026-11-04T00:00:01.000Z', dateUpdated: '2026-11-04T00:00:05.000Z',
      delivered: true, read: false,
    };
  }
  const bytes = size({ statuses, checkedAt: '2026-11-04T00:00:05.000Z' });
  assert.ok(bytes < 10 * 1024, `bucket is ${bytes} bytes`);
});

test('statusEntries keys accepted sends by SID and refusals by index', () => {
  const sid = `SM${'1'.repeat(32)}`;
  const at = '2026-11-04T00:00:00.000Z';
  assert.deepStrictEqual(storage.statusEntries([
    { index: 0, success: true, sid, status: 'queued', to: '+1' },
    { index: 1, success: false, error: 'Invalid To', errorCode: 21211, to: '+2' },
    { index: 2, success: false, to: '+3' },
  ], at), {
    [sid]: { status: 'queued', to: '+1', sentAt: at },
    'failed-1': { status: 'failed', to: '+2', errorCode: 21211, errorMessage: 'Invalid To', sentAt: at },
    'failed-2': { status: 'failed', to: '+3', errorCode: null, errorMessage: 'Twilio rejected the message', sentAt: at },
  });
});

test('isBucketed and isFullyStored tell the Document shapes apart', () => {
  const fresh = storage.newCampaignData({ totalMessages: 2, shared: {}, now: '2026-11-04T00:00:00.000Z' });
  assert.strictEqual(storage.isBucketed(fresh), true);
  assert.strictEqual(fresh.storedCount, 0);
  assert.strictEqual(fresh.pending, 2);
  assert.strictEqual(storage.isFullyStored(fresh), false);
  assert.strictEqual(storage.isFullyStored({ ...fresh, storedCount: 2 }), true);
  assert.strictEqual(storage.isBucketed({ statuses: {}, messages: [] }), false);
  assert.strictEqual(storage.isFullyStored({ statuses: {}, messages: [] }), false);
  assert.strictEqual(storage.isBucketed(null), false);
});

function syncError(status, code) {
  return Object.assign(new Error(`Sync ${status}`), { status, code });
}

/**
 * Just enough of twilio-node's Sync surface: `syncMaps` and `syncMapItems` are
 * callable and carry methods, as in the SDK. Map items list in key order.
 */
function fakeSync() {
  const state = { maps: {}, documents: {}, calls: [], failDocumentUpdate: false, failStatusWrite: false };

  const itemsOf = (name) => {
    if (!state.maps[name]) throw syncError(404, 20404);
    return state.maps[name];
  };

  const syncMaps = (name) => {
    const syncMapItems = (key) => ({
      fetch: async () => {
        const items = itemsOf(name);
        if (!(key in items)) throw syncError(404, 20404);
        return { key, data: items[key] };
      },
      update: async ({ data }) => {
        state.calls.push(['updateItem', name, key]);
        const items = itemsOf(name);
        if (!(key in items)) throw syncError(404, 20404);
        items[key] = data;
      },
    });
    syncMapItems.create = async ({ key, data }) => {
      state.calls.push(['createItem', name, key]);
      if (state.failStatusWrite && name.endsWith('_statuses')) throw syncError(500, 20500);
      const items = itemsOf(name);
      if (key in items) throw syncError(409, 54208);
      items[key] = data;
    };
    syncMapItems.list = async () => {
      state.calls.push(['listItems', name]);
      const items = itemsOf(name);
      return Object.keys(items).sort().map((key) => ({ key, data: items[key] }));
    };
    return { syncMapItems };
  };
  syncMaps.create = async ({ uniqueName }) => {
    state.calls.push(['createMap', uniqueName]);
    if (state.maps[uniqueName]) throw syncError(409, 54301);
    state.maps[uniqueName] = {};
  };

  const documents = (name) => ({
    update: async ({ data }) => {
      state.calls.push(['updateDocument', name]);
      if (state.failDocumentUpdate) throw syncError(400, 54006);
      state.documents[name] = JSON.parse(JSON.stringify(data));
    },
  });

  return { client: { syncMaps, documents }, state };
}

test('createMaps creates the recipients and statuses Maps', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  assert.deepStrictEqual(Object.keys(state.maps).sort(), ['campaign_1_recipients', 'campaign_1_statuses']);
});

test('storeRecipients writes a slice under keys counted from its start', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  const stored = await storage.storeRecipients(client, 'campaign_1', messages(300), {
    startIndex: 1024, shared: { from: FROM }, deadline: Infinity,
  });
  assert.strictEqual(stored, 1324);
  assert.deepStrictEqual(Object.keys(state.maps.campaign_1_recipients), ['0001024', '0001152', '0001280']);
  assert.deepStrictEqual(state.maps.campaign_1_recipients['0001280'].recipients[0], { to: '+15550000256' });
});

test('storeRecipients stops at the deadline, after at least one batch', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  const stored = await storage.storeRecipients(client, 'campaign_1', messages(2000), {
    startIndex: 0, shared: { from: FROM }, deadline: 0, now: () => 1,
  });
  assert.strictEqual(stored, storage.WRITE_CONCURRENCY * 128);
  assert.strictEqual(Object.keys(state.maps.campaign_1_recipients).length, storage.WRITE_CONCURRENCY);
});

test('storeRecipients overwrites buckets a retried slice already wrote', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  const slice = messages(200);
  const options = { startIndex: 0, shared: { from: FROM }, deadline: Infinity };
  await storage.storeRecipients(client, 'campaign_1', slice, options);
  assert.strictEqual(await storage.storeRecipients(client, 'campaign_1', slice, options), 200);
  assert.strictEqual(Object.keys(state.maps.campaign_1_recipients).length, 2);
});

test('readRecipientBucket returns the bucket starting at a key, or null', async () => {
  const { client } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  await storage.storeRecipients(client, 'campaign_1', messages(200), {
    startIndex: 0, shared: { from: FROM }, deadline: Infinity,
  });
  const bucket = await storage.readRecipientBucket(client, 'campaign_1', 128);
  assert.strictEqual(bucket.start, 128);
  assert.strictEqual(bucket.recipients.length, 72);
  assert.strictEqual(await storage.readRecipientBucket(client, 'campaign_1', 100), null);
});

test('writeStatusBucket merges into a bucket a re-sent chunk already wrote', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  await storage.writeStatusBucket(client, 'campaign_1', 32, { a: { status: 'queued' } });
  await storage.writeStatusBucket(client, 'campaign_1', 32, { b: { status: 'queued' } });
  assert.deepStrictEqual(state.maps.campaign_1_statuses['0000032'], {
    statuses: { a: { status: 'queued' }, b: { status: 'queued' } },
  });
});

test('readStatusBuckets returns every bucket in send order, or [] with no Map', async () => {
  const { client } = fakeSync();
  assert.deepStrictEqual(await storage.readStatusBuckets(client, 'campaign_1'), []);
  await storage.createMaps(client, 'campaign_1');
  await storage.writeStatusBucket(client, 'campaign_1', 32, { b: { status: 'sent' } });
  await storage.writeStatusBucket(client, 'campaign_1', 0, { a: { status: 'sent' } });
  assert.deepStrictEqual(await storage.readStatusBuckets(client, 'campaign_1'), [
    { key: '0000000', statuses: { a: { status: 'sent' } }, checkedAt: null },
    { key: '0000032', statuses: { b: { status: 'sent' } }, checkedAt: null },
  ]);
});

test('updateStatusBucket replaces one bucket and records when it was checked', async () => {
  const { client, state } = fakeSync();
  await storage.createMaps(client, 'campaign_1');
  await storage.writeStatusBucket(client, 'campaign_1', 0, { a: { status: 'sent' } });
  await storage.updateStatusBucket(client, 'campaign_1', '0000000', { a: { status: 'delivered' } }, 'T1');
  assert.deepStrictEqual(state.maps.campaign_1_statuses['0000000'], {
    statuses: { a: { status: 'delivered' } }, checkedAt: 'T1',
  });
});

test('inBatches never runs more than the limit at once and keeps order', async () => {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, (_, i) => async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    return i;
  });
  assert.deepStrictEqual(await storage.inBatches(tasks, 8), Array.from({ length: 20 }, (_, i) => i));
  assert.strictEqual(peak, 8);
});

/** A fully stored campaign of `count` recipients, as send-messages.js leaves it. */
async function storedCampaign(count, extra) {
  const sync = fakeSync();
  const list = messages(count, extra);
  const shared = storage.sharedFields(list);
  await storage.createMaps(sync.client, 'campaign_1');
  await storage.storeRecipients(sync.client, 'campaign_1', list, { startIndex: 0, shared, deadline: Infinity });
  const campaignData = storage.newCampaignData({
    ownerKey: 'owner', accountSid: 'AC1', totalMessages: count, shared,
    channel: 'sms', from: FROM, campaignName: null, details: null, now: '2026-11-04T00:00:00.000Z',
  });
  campaignData.storedCount = count;
  return { ...sync, campaignData, list };
}

/** A `send` that accepts every message except those `refuse(index)` picks. */
function fakeSend(refuse = () => false) {
  const chunks = [];
  const send = async (batch, startIndex) => {
    chunks.push({ startIndex, batch });
    return batch.map((message, offset) => {
      const index = startIndex + offset;
      return refuse(index)
        ? { index, success: false, error: 'Invalid To', errorCode: 21211, to: message.to }
        : { index, success: true, sid: `SM${String(index).padStart(32, '0')}`, status: 'queued', to: message.to };
    });
  };
  return { send, chunks };
}

test('runChunks sends one recipient bucket per chunk and checkpoints each', async () => {
  const { client, state, campaignData, list } = await storedCampaign(200);
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });

  assert.deepStrictEqual(chunks.map((c) => [c.startIndex, c.batch.length]), [[0, 128], [128, 72]]);
  assert.deepStrictEqual(chunks.flatMap((c) => c.batch), list);
  assert.strictEqual(outcome.resumeFrom, 200);
  assert.strictEqual(outcome.checkpointFailed, false);
  assert.strictEqual(outcome.results.length, 72);
  assert.deepStrictEqual(Object.keys(state.maps.campaign_1_statuses).sort(), [
    '0000000', '0000032', '0000064', '0000096', '0000128', '0000160', '0000192',
  ]);
  assert.strictEqual(Object.keys(state.maps.campaign_1_statuses['0000192'].statuses).length, 8);
  assert.strictEqual(state.calls.filter(([op]) => op === 'updateDocument').length, 2);
  assert.strictEqual(state.documents.campaign_1.startIndex, 200);
  assert.strictEqual(state.documents.campaign_1.sent, 200);
  assert.strictEqual(state.documents.campaign_1.pending, 0);
});

test('runChunks stops at the deadline with resumeFrom on a bucket key', async () => {
  const { client, campaignData } = await storedCampaign(200);
  const { send, chunks } = fakeSend();
  let clock = 0;
  const slowSend = async (batch, startIndex) => {
    clock += 5000;
    return send(batch, startIndex);
  };
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0,
    deadline: 4000, send: slowSend, now: () => clock,
  });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(outcome.resumeFrom, 128);
});

test('runChunks resumes from a bucket key and refuses an index inside a bucket', async () => {
  const { client, campaignData } = await storedCampaign(200);
  const { send, chunks } = fakeSend();
  const run = (startIndex) => storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex, deadline: Infinity, send,
  });
  await run(128);
  assert.deepStrictEqual(chunks.map((c) => [c.startIndex, c.batch.length]), [[128, 72]]);
  await assert.rejects(run(100), /No stored recipients start at index 100/);
  assert.strictEqual(chunks.length, 1);
});

test('refused sends are recorded under their index and counted as failed', async () => {
  const { client, state, campaignData } = await storedCampaign(3);
  const { send } = fakeSend((index) => index === 1);
  await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });
  const statuses = state.maps.campaign_1_statuses['0000000'].statuses;
  assert.strictEqual(Object.keys(statuses).length, 3);
  assert.strictEqual(statuses['failed-1'].errorCode, 21211);
  assert.strictEqual(state.documents.campaign_1.sent, 2);
  assert.strictEqual(state.documents.campaign_1.failed, 1);
  assert.strictEqual(state.documents.campaign_1.pending, 0);
});

test('a failed checkpoint stops the loop but still moves resumeFrom past the sent chunk', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, state, campaignData } = await storedCampaign(200);
  state.failDocumentUpdate = true;
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(outcome.checkpointFailed, true);
  assert.strictEqual(outcome.resumeFrom, 128);
});

test('a bucket read failing after a sent chunk ends the call with its progress', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, state, campaignData } = await storedCampaign(200);
  delete state.maps.campaign_1_recipients['0000128'];
  const { send, chunks } = fakeSend();
  const run = (startIndex) => storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex, deadline: Infinity, send,
  });
  const outcome = await run(0);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(outcome.resumeFrom, 128);
  assert.strictEqual(outcome.checkpointFailed, false);
  await assert.rejects(run(128), /No stored recipients start at index 128/);
});

test('a failed status write still saves the Document index', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { client, state, campaignData } = await storedCampaign(200);
  state.failStatusWrite = true;
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 0, deadline: Infinity, send,
  });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(outcome.checkpointFailed, true);
  assert.strictEqual(outcome.resumeFrom, 128);
  assert.strictEqual(state.documents.campaign_1.startIndex, 128);
});

test('a resume past the stored index with nothing left to send still saves the index', async () => {
  const { client, state, campaignData } = await storedCampaign(3);
  // As a failed checkpoint on the last chunk leaves it: all sent, index not saved.
  const { send, chunks } = fakeSend();
  const outcome = await storage.runChunks({
    syncClient: client, campaignId: 'campaign_1', campaignData, startIndex: 3, deadline: Infinity, send,
  });
  assert.strictEqual(chunks.length, 0);
  assert.strictEqual(outcome.resumeFrom, 3);
  assert.strictEqual(outcome.checkpointFailed, false);
  assert.strictEqual(state.documents.campaign_1.startIndex, 3);
});

test('progressBody reports progress the way the browser reads it', () => {
  const outcome = { resumeFrom: 128, results: [], checkpointFailed: true };
  assert.deepStrictEqual(
    storage.progressBody('campaign_1', { totalMessages: 200, storedCount: 200, sent: 128, failed: 0, pending: 72 }, 0, outcome),
    {
      success: true,
      campaignId: 'campaign_1',
      storedCount: 200,
      processed: 128,
      totalProcessed: 128,
      totalMessages: 200,
      isComplete: false,
      hasMore: true,
      resumeFrom: 128,
      results: [],
      checkpointFailed: true,
      stats: { sent: 128, failed: 0, pending: 72 },
    }
  );
});
