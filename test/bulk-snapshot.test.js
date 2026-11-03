'use strict';

const test = require('node:test');
const assert = require('node:assert');

const snapshot = require('../assets/bulk-snapshot.private.js');

const ROW = {
  id: 'comms_message_01h2xcejqtf2nbrexx3vqjhp41',
  from: { address: '+15557122661', channel: 'SMS' },
  to: [{ address: '+15558675310', channel: 'PHONE', contactId: 'comms_contact_01h9krwprkeee8fzqspvwy6nq7' }],
  status: 'DELIVERED',
  related: [{ name: 'OPERATION', id: 'comms_operation_01h2xcejqtf2nbrexx3vqjhp41' }],
  tags: {},
  scheduledFor: null,
  createdAt: '2026-09-03T02:47:14Z',
  updatedAt: '2026-09-03T02:47:20Z',
};

function row(n, overrides = {}) {
  return { ...ROW, id: `comms_message_${String(n).padStart(26, '0')}`, ...overrides };
}

/** An error shaped like the ones twilio-node throws. */
function syncError(status, code) {
  return Object.assign(new Error(`Sync ${status}`), { status, code });
}

/**
 * Just enough of twilio-node's Sync Map surface: `syncMaps` and `syncMapItems`
 * are both callable and carry methods, as they are in the SDK.
 */
function fakeSync({ mapExists = false, items = {} } = {}) {
  const state = { mapExists, items: { ...items }, calls: [] };

  const syncMapItems = (key) => ({
    update: async ({ data }) => {
      state.calls.push(['update', key]);
      if (!state.mapExists || !(key in state.items)) throw syncError(404, 20404);
      state.items[key] = data;
    },
  });
  syncMapItems.create = async ({ key, data }) => {
    state.calls.push(['create', key]);
    if (!state.mapExists) throw syncError(404, 20404);
    state.items[key] = data;
  };
  syncMapItems.list = async () => {
    if (!state.mapExists) throw syncError(404, 20404);
    return Object.entries(state.items)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, data]) => ({ key, data }));
  };

  const syncMaps = (name) => {
    state.calls.push(['map', name]);
    return { syncMapItems };
  };
  syncMaps.create = async ({ uniqueName }) => {
    state.calls.push(['createMap', uniqueName]);
    if (state.mapExists) throw syncError(409, 54301);
    state.mapExists = true;
  };

  return { client: { syncMaps }, state };
}

test('names the map after the campaign', () => {
  assert.strictEqual(snapshot.mapNameFor('campaign_1788403634339'), 'campaign_1788403634339_rows');
});

test('a row survives a chunk round trip with its recipient address flattened', () => {
  const chunks = snapshot.chunkRows([ROW], { operationIndex: 0, pageIndex: 0, savedAt: '2026-09-03T03:00:00Z' });
  assert.strictEqual(chunks.length, 1);

  const { rows } = snapshot.expandItems(chunks.map(({ key, data }) => ({ key, data })));
  assert.deepStrictEqual(rows, [
    {
      id: ROW.id,
      to: '+15558675310',
      status: 'DELIVERED',
      createdAt: '2026-09-03T02:47:14Z',
      updatedAt: '2026-09-03T02:47:20Z',
      errorCode: null,
      errorMessage: null,
    },
  ]);
});

test('accepts every recipient shape the delivery table already reads', () => {
  const shapes = ['+15558675310', { address: '+15558675310' }, ['+15558675310']];
  for (const to of shapes) {
    const chunks = snapshot.chunkRows([row(1, { to })], { operationIndex: 0, pageIndex: 0 });
    assert.strictEqual(snapshot.expandItems(chunks).rows[0].to, '+15558675310');
  }
});

test('keeps error fields when a row carries them', () => {
  const chunks = snapshot.chunkRows(
    [row(1, { status: 'FAILED', errorCode: 30008, errorMessage: 'Unknown error' })],
    { operationIndex: 0, pageIndex: 0 }
  );
  const [out] = snapshot.expandItems(chunks).rows;
  assert.strictEqual(out.errorCode, 30008);
  assert.strictEqual(out.errorMessage, 'Unknown error');
});

test('no rows means no chunks, so an empty page never overwrites a saved one', () => {
  assert.deepStrictEqual(snapshot.chunkRows([], { operationIndex: 0, pageIndex: 0 }), []);
});

test('splits a page into chunks that each fit under the byte budget', () => {
  const rows = Array.from({ length: 1000 }, (_, n) => row(n));
  const chunks = snapshot.chunkRows(rows, { operationIndex: 2, pageIndex: 7, maxBytes: 4000 });

  assert.ok(chunks.length > 1);
  for (const { data } of chunks) {
    assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 4000);
  }
  // Keys sort into page order, which is the order Sync lists them back in.
  const keys = chunks.map((c) => c.key);
  assert.deepStrictEqual([...keys].sort(), keys);
  assert.ok(keys.every((key) => key.startsWith('op002-p00007-')));
  assert.strictEqual(snapshot.expandItems(chunks).rows.length, 1000);
});

test('the default byte budget leaves headroom under the 16 KiB item limit', () => {
  const rows = Array.from({ length: 1000 }, (_, n) => row(n));
  for (const { data } of snapshot.chunkRows(rows, { operationIndex: 0, pageIndex: 0 })) {
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 16 * 1024 * 0.9);
  }
});

test('a message saved twice is listed once, with its newest status', () => {
  const older = snapshot.chunkRows([row(1, { status: 'SENT' })], {
    operationIndex: 0, pageIndex: 0, savedAt: '2026-09-03T03:00:00Z',
  });
  const newer = snapshot.chunkRows([row(1, { status: 'DELIVERED' })], {
    operationIndex: 0, pageIndex: 1, savedAt: '2026-09-03T04:00:00Z',
  });

  const { rows, savedAt } = snapshot.expandItems([...newer, ...older]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'DELIVERED');
  assert.strictEqual(savedAt, '2026-09-03T04:00:00Z');
});

test('saveRows creates the map on first use and the item inside it', async () => {
  const { client, state } = fakeSync();
  await snapshot.saveRows(client, 'campaign_1', [ROW], { operationIndex: 0, pageIndex: 0 });

  assert.ok(state.mapExists);
  assert.deepStrictEqual(Object.keys(state.items), ['op000-p00000-c000']);
});

test('saveRows overwrites an existing item rather than failing on it', async () => {
  const first = fakeSync();
  await snapshot.saveRows(first.client, 'campaign_1', [row(1, { status: 'SENT' })], {
    operationIndex: 0, pageIndex: 0,
  });

  const { client, state } = fakeSync({ mapExists: true, items: first.state.items });
  await snapshot.saveRows(client, 'campaign_1', [row(1, { status: 'DELIVERED' })], {
    operationIndex: 0, pageIndex: 0,
  });

  assert.strictEqual(snapshot.expandItems(
    Object.entries(state.items).map(([key, data]) => ({ key, data }))
  ).rows[0].status, 'DELIVERED');
  assert.ok(!state.calls.some(([name]) => name === 'createMap'));
});

test('saveRows writes nothing for an empty page', async () => {
  const { client, state } = fakeSync();
  await snapshot.saveRows(client, 'campaign_1', [], { operationIndex: 0, pageIndex: 0 });
  assert.deepStrictEqual(state.calls, []);
});

test('saveRows rethrows a Sync failure that is not a missing map or item', async () => {
  const client = {
    syncMaps: Object.assign(
      () => ({
        syncMapItems: Object.assign(
          () => ({ update: async () => { throw syncError(429, 20429); } }),
          { create: async () => {} }
        ),
      }),
      { create: async () => {} }
    ),
  };
  await assert.rejects(
    snapshot.saveRows(client, 'campaign_1', [ROW], { operationIndex: 0, pageIndex: 0 }),
    (err) => err.status === 429
  );
});

test('readRows returns null when nothing was ever saved', async () => {
  const { client } = fakeSync();
  assert.strictEqual(await snapshot.readRows(client, 'campaign_1'), null);
});

test('readRows returns what saveRows stored', async () => {
  const { client } = fakeSync();
  await snapshot.saveRows(client, 'campaign_1', [row(1), row(2)], {
    operationIndex: 0, pageIndex: 0, savedAt: '2026-09-03T03:00:00Z',
  });

  const saved = await snapshot.readRows(client, 'campaign_1');
  assert.strictEqual(saved.rows.length, 2);
  assert.strictEqual(saved.savedAt, '2026-09-03T03:00:00Z');
});
