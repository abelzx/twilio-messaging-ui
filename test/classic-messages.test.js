'use strict';

const test = require('node:test');
const assert = require('node:assert');

const classicMessages = require('../assets/classic-messages.private.js');

const MG = `MG${'b'.repeat(32)}`;
const HX = `HX${'a'.repeat(32)}`;
const sid = (n) => `SM${String(n).padStart(32, '0')}`;

/** Just enough of twilio-node: `messages` is callable and carries `create`. */
function fakeClient({ create = async () => ({}), fetch = async () => ({}) } = {}) {
  const messages = (messageSid) => ({ fetch: () => fetch(messageSid) });
  messages.create = (params) => create(params);
  return { messages };
}

/** Resolves on a later turn, so concurrent calls overlap. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('messageParams sends a plain SMS with no status callback', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+15558675310', body: 'Hi' }, { channel: 'sms', from: '+15017122661' }),
    { to: '+15558675310', from: '+15017122661', body: 'Hi' }
  );
});

test('a null field from a later upload slice is treated as absent', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+1', from: null, body: null, contentSid: null }, { channel: 'sms', from: '+2' }),
    { to: '+1', from: '+2' }
  );
});

test('a Messaging Service sender travels as messagingServiceSid, unprefixed', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+15558675310', body: 'Hi' }, { channel: 'whatsapp', from: MG }),
    { to: 'whatsapp:+15558675310', messagingServiceSid: MG, body: 'Hi' }
  );
});

test('WhatsApp prefixes each side once and stringifies template variables', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams(
      { to: 'whatsapp:+15558675310', from: '+15017122661', contentSid: HX, contentVariables: { 1: 'Sarah' } },
      { channel: 'whatsapp' }
    ),
    { to: 'whatsapp:+15558675310', from: 'whatsapp:+15017122661', contentSid: HX, contentVariables: '{"1":"Sarah"}' }
  );
});

test('Messenger falls back to the deployment Messaging Service', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '123', body: 'Hi' }, { channel: 'messenger', from: '456', messagingServiceSid: MG }),
    { to: 'messenger:123', from: 'messenger:456', body: 'Hi', messagingServiceSid: MG }
  );
});

test('MMS media goes out as an array', () => {
  const params = classicMessages.messageParams(
    { to: '+1', from: '+2', mediaUrl: 'https://example.com/a.jpg' }, { channel: 'mms' });
  assert.deepStrictEqual(params.mediaUrl, ['https://example.com/a.jpg']);
});

test('sendChunk numbers results from startIndex and never rejects', async () => {
  let n = 0;
  const client = fakeClient({
    create: async (params) => {
      if (params.to === '+2') throw Object.assign(new Error('Invalid To'), { status: 400, code: 21211 });
      return { sid: sid(n++), status: 'queued' };
    },
  });
  const results = await classicMessages.sendChunk(client, [{ to: '+1' }, { to: '+2' }], {
    startIndex: 64, channel: 'sms', from: '+9',
  });
  assert.deepStrictEqual(results, [
    { index: 64, success: true, sid: sid(0), status: 'queued', to: '+1' },
    { index: 65, success: false, error: 'Invalid To', errorCode: 21211, to: '+2' },
  ]);
});

test('sendChunk keeps at most `concurrency` sends in flight, results in order', async () => {
  let running = 0;
  let peak = 0;
  const client = fakeClient({
    create: async (params) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return { sid: `SM${params.to}`, status: 'queued' };
    },
  });
  const batch = Array.from({ length: 10 }, (_, i) => ({ to: String(i) }));
  const results = await classicMessages.sendChunk(client, batch, { channel: 'sms', from: '+9', concurrency: 3 });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(results.map((r) => r.sid), batch.map((m) => `SM${m.to}`));
});

test('sendChunk retries a 429', async (t) => {
  t.mock.method(console, 'log', () => {});
  let calls = 0;
  const client = fakeClient({
    create: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      return { sid: sid(1), status: 'queued' };
    },
  });
  const [result] = await classicMessages.sendChunk(client, [{ to: '+1' }], {
    channel: 'sms', from: '+9', retry: { baseDelay: 1, maxDelay: 1 },
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(calls, 3);
});

test('sendChunk records a 429 as a failure rather than sleep past the deadline', async () => {
  const client = fakeClient({
    create: async () => { throw Object.assign(new Error('Too Many Requests'), { status: 429 }); },
  });
  const started = Date.now();
  // The first backoff alone would sleep at least a second.
  const [result] = await classicMessages.sendChunk(client, [{ to: '+1' }], {
    channel: 'sms', from: '+9', deadline: Date.now() + 5,
  });
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
  assert.deepStrictEqual(result, { index: 0, success: false, error: 'Too Many Requests', errorCode: 429, to: '+1' });
});

test('sendChunk starts no send once the deadline has passed, and records why', async () => {
  let clock = 0;
  const client = fakeClient({ create: async () => ({ sid: sid(clock++), status: 'queued' }) });
  const batch = [{ to: '+1' }, { to: '+2' }, { to: '+3' }];
  const results = await classicMessages.sendChunk(client, batch, {
    startIndex: 10, channel: 'sms', from: '+9', deadline: 2, now: () => clock, concurrency: 1,
  });
  assert.deepStrictEqual(results.map((r) => [r.index, r.success, r.errorCode || null]),
    [[10, true, null], [11, true, null], [12, false, 20429]]);
  assert.match(results[2].error, /ran out of time/);
  assert.strictEqual(results[2].to, '+3');
  assert.strictEqual(clock, 2);
});

test('a 429 retry still sleeps when it ends before the deadline', async (t) => {
  t.mock.method(console, 'log', () => {});
  let calls = 0;
  const result = await classicMessages.retryWithExponentialBackoff(async () => {
    if (++calls < 2) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
    return 'ok';
  }, { baseDelay: 1, maxDelay: 1, deadline: 1000, now: () => 0 });
  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 2);
});

test('pendingKeys skips refusals and settled statuses', () => {
  const statuses = {
    [sid(1)]: { status: 'queued' },
    [sid(2)]: { status: 'delivered' },
    [sid(3)]: { status: 'undelivered' },
    'failed-4': { status: 'failed' },
  };
  assert.deepStrictEqual(classicMessages.pendingKeys(statuses, 'sms'), [sid(1)]);
  assert.deepStrictEqual(classicMessages.pendingKeys(statuses, 'whatsapp'), [sid(1), sid(2)]);
});

test('refreshStatuses fetches only messages whose status can still change', async () => {
  const fetched = [];
  const client = fakeClient({
    fetch: async (messageSid) => {
      fetched.push(messageSid);
      return { status: 'delivered', errorCode: null, errorMessage: null, dateSent: null, dateUpdated: null };
    },
  });
  const statuses = {
    [sid(1)]: { status: 'queued', to: '+1', sentAt: 'a' },
    [sid(2)]: { status: 'delivered', to: '+2', sentAt: 'a' },
    'failed-4': { status: 'failed', to: '+4', sentAt: 'a' },
  };
  const { statuses: next, changed } = await classicMessages.refreshStatuses(client, statuses, {
    channel: 'sms', deadline: Infinity,
  });
  assert.deepStrictEqual(fetched, [sid(1)]);
  assert.deepStrictEqual([...changed], [sid(1)]);
  assert.strictEqual(next[sid(1)].status, 'delivered');
  assert.strictEqual(next[sid(1)].delivered, true);
  assert.strictEqual(next['failed-4'], statuses['failed-4']);
});

test('delivered can still become read on WhatsApp', async () => {
  const client = fakeClient({ fetch: async () => ({ status: 'read' }) });
  const { statuses: next } = await classicMessages.refreshStatuses(client, {
    [sid(1)]: { status: 'delivered', sentAt: 'a' },
  }, { channel: 'whatsapp', deadline: Infinity });
  assert.strictEqual(next[sid(1)].read, true);
});

test('an unchanged status is not reported as changed', async () => {
  const entry = {
    status: 'sent', to: '+1', sentAt: 'a', errorCode: null, errorMessage: null,
    dateSent: '2026-11-04T00:00:00.000Z', dateUpdated: '2026-11-04T00:00:01.000Z', delivered: false, read: false,
  };
  const client = fakeClient({
    fetch: async () => ({
      status: 'sent', errorCode: null, errorMessage: null,
      dateSent: new Date(entry.dateSent), dateUpdated: new Date(entry.dateUpdated),
    }),
  });
  const { changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: entry }, {
    channel: 'sms', deadline: Infinity,
  });
  assert.strictEqual(changed.size, 0);
});

test('refreshStatuses starts no fetch after the deadline', async () => {
  const client = fakeClient({ fetch: async () => assert.fail('fetched after the deadline') });
  const { changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: { status: 'queued' } }, {
    channel: 'sms', deadline: 0, now: () => 1,
  });
  assert.strictEqual(changed.size, 0);
});

test('refreshStatuses fetches in the given order, at most `concurrency` at once', async () => {
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
      return { status: 'delivered' };
    },
  });
  // Given newest first: the order is the caller's, not sentAt's.
  const statuses = {};
  for (let i = 9; i >= 0; i--) statuses[sid(i)] = { status: 'queued', sentAt: `2026-11-04T00:00:0${i}.000Z` };
  const { fetched } = await classicMessages.refreshStatuses(client, statuses, {
    channel: 'sms', deadline: Infinity, concurrency: 3,
  });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(order, Object.keys(statuses));
  assert.deepStrictEqual([...fetched].sort(), Object.keys(statuses).sort());
});

test('refreshStatuses reports which keys it fetched before the deadline', async () => {
  let clock = 0;
  const client = fakeClient({ fetch: async () => { clock++; return { status: 'delivered' }; } });
  const statuses = {};
  for (let i = 0; i < 6; i++) statuses[sid(i)] = { status: 'queued' };
  statuses['failed-6'] = { status: 'failed' };
  const { fetched } = await classicMessages.refreshStatuses(client, statuses, {
    channel: 'sms', deadline: 3, now: () => clock, concurrency: 1,
  });
  assert.deepStrictEqual([...fetched], [sid(0), sid(1), sid(2)]);
});

test('selectRefreshBuckets takes buckets with a pending status, least recently checked first', () => {
  const bucket = (key, checkedAt, statuses) => ({ key, checkedAt, statuses });
  const queued = (n) => ({ [sid(n)]: { status: 'queued' } });
  const buckets = [
    bucket('0000000', '2026-11-04T00:00:02.000Z', queued(0)),
    bucket('0000032', null, queued(32)),
    bucket('0000064', '2026-11-04T00:00:01.000Z', queued(64)),
    bucket('0000096', null, { [sid(96)]: { status: 'delivered' }, 'failed-97': { status: 'failed' } }),
    bucket('0000128', null, { 'unconfirmed-128': { status: 'unconfirmed', to: '+1' } }),
    bucket('0000160', null, queued(160)),
  ];
  const turns = classicMessages.selectRefreshBuckets(buckets, 'sms', 3);
  assert.deepStrictEqual(turns.selected.map((b) => b.key), ['0000032', '0000160', '0000064']);
  assert.strictEqual(turns.takingTurns, true);
  const all = classicMessages.selectRefreshBuckets(buckets, 'sms', 4);
  assert.deepStrictEqual(all.selected.map((b) => b.key), ['0000032', '0000160', '0000064', '0000000']);
  assert.strictEqual(all.takingTurns, false);
  // On WhatsApp a delivered message can still be read.
  assert.ok(classicMessages.selectRefreshBuckets(buckets, 'whatsapp', 24).selected.some((b) => b.key === '0000096'));
});

test('bucketUpdates writes what changed, and stamps only buckets whose pending keys were all fetched', () => {
  const a = { key: 'A', revision: '3', checkedAt: 'T0', statuses: { [sid(1)]: { status: 'sent' }, [sid(2)]: { status: 'sent' } } };
  const b = { key: 'B', revision: '1', checkedAt: null, statuses: { [sid(3)]: { status: 'sent' } } };
  const c = { key: 'C', revision: '2', checkedAt: 'T0', statuses: { [sid(4)]: { status: 'sent' }, 'failed-5': { status: 'failed' } } };
  const refreshed = {
    statuses: { ...a.statuses, [sid(1)]: { status: 'delivered' }, ...b.statuses, ...c.statuses },
    changed: new Set([sid(1)]),
    fetched: new Set([sid(1), sid(3), sid(4)]),
  };
  const summary = (updates) => updates.map((u) => [u.key, u.complete, u.write, u.checkedAt]);

  // A changed but was cut off before sid(2), so it keeps its place at the front.
  const turns = classicMessages.bucketUpdates([a, b, c], refreshed, { channel: 'sms', takingTurns: true, checkedAt: 'T9' });
  assert.deepStrictEqual(summary(turns), [['A', false, true, 'T0'], ['B', true, true, 'T9'], ['C', true, true, 'T9']]);
  assert.deepStrictEqual(turns[0].statuses, { [sid(1)]: { status: 'delivered' }, [sid(2)]: { status: 'sent' } });
  assert.strictEqual(turns[0].revision, '3');

  // Not taking turns, but A was cut off: B and C still take their turn, or the
  // same buckets would be fetched first, and A cut off, on every poll.
  const cutOff = classicMessages.bucketUpdates([a, b, c], refreshed, { channel: 'sms', takingTurns: false, checkedAt: 'T9' });
  assert.deepStrictEqual(summary(cutOff), [['A', false, true, 'T0'], ['B', true, true, 'T9'], ['C', true, true, 'T9']]);

  // Not taking turns and nothing cut off, an unchanged bucket is not written.
  const all = { ...refreshed, fetched: new Set([sid(1), sid(2), sid(3), sid(4)]) };
  const settled = classicMessages.bucketUpdates([a, b, c], all, { channel: 'sms', takingTurns: false, checkedAt: 'T9' });
  assert.deepStrictEqual(summary(settled), [['A', true, true, 'T9'], ['B', true, false, 'T9'], ['C', true, false, 'T9']]);
});

test('a failed fetch keeps the entry and records why', async () => {
  const client = fakeClient({ fetch: async () => { throw new Error('boom'); } });
  const { statuses, changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: { status: 'queued' } }, {
    channel: 'sms', deadline: Infinity,
  });
  assert.deepStrictEqual(statuses[sid(1)], { status: 'queued', error: 'boom' });
  assert.ok(changed.has(sid(1)));
});

test('a failed fetch records at most FETCH_ERROR_MAX_CHARS of why', async () => {
  const message = `The requested resource /2010-04-01/Accounts/AC${'0'.repeat(32)}/Messages/${sid(1)}.json was not found`;
  const client = fakeClient({ fetch: async () => { throw Object.assign(new Error(message), { status: 404, code: 20404 }); } });
  const { statuses } = await classicMessages.refreshStatuses(client, { [sid(1)]: { status: 'queued' } }, {
    channel: 'sms', deadline: Infinity,
  });
  assert.strictEqual(classicMessages.FETCH_ERROR_MAX_CHARS, 64);
  assert.strictEqual(statuses[sid(1)].error, message.slice(0, 64));
});

test('placeholderStatuses reports a claim under 15 s old as sending, and an older one as unconfirmed', () => {
  const statuses = { [sid(1)]: { status: 'queued' }, 'unconfirmed-1': { to: '+1' } };
  const claimedAt = '2026-11-04T00:00:00.000Z';
  const at = (ms) => classicMessages.placeholderStatuses(statuses, claimedAt, Date.parse(claimedAt) + ms);
  assert.deepStrictEqual(at(14999)['unconfirmed-1'], { to: '+1', status: 'sending' });
  assert.deepStrictEqual(at(15000)['unconfirmed-1'], { to: '+1', status: 'unconfirmed' });
  assert.strictEqual(at(0)[sid(1)], statuses[sid(1)]);
  // A claim replaced after its send, keeping a bucket's placeholders, has no claimedAt.
  assert.deepStrictEqual(classicMessages.placeholderStatuses(statuses, null, 0)['unconfirmed-1'], { to: '+1', status: 'unconfirmed' });
  assert.deepStrictEqual(statuses['unconfirmed-1'], { to: '+1' });
});

test('tally counts from the statuses, including refusals and recipients not confirmed', () => {
  assert.deepStrictEqual(classicMessages.tally({
    [sid(1)]: { status: 'delivered' },
    [sid(2)]: { status: 'read' },
    [sid(3)]: { status: 'undelivered' },
    [sid(4)]: { status: 'failed' },
    [sid(5)]: { status: 'sent', delivered: true },
    [sid(6)]: { status: 'queued' },
    [sid(7)]: { status: 'sent' },
    'failed-8': { status: 'failed' },
    // A placeholder as stored carries only `to`; its key says what it is.
    'unconfirmed-9': { to: '+9' },
    'unconfirmed-10': { status: 'unconfirmed', to: '+10' },
    // Still being sent: pending, not yet unconfirmed.
    'unconfirmed-11': { status: 'sending', to: '+11' },
  }), { sent: 7, delivered: 3, read: 1, failed: 3, pending: 3, unconfirmed: 2 });
});
