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

test('refreshStatuses fetches at most `concurrency` at once, oldest first', async () => {
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
  const statuses = {};
  for (let i = 9; i >= 0; i--) statuses[sid(i)] = { status: 'queued', sentAt: `2026-11-04T00:00:0${i}.000Z` };
  await classicMessages.refreshStatuses(client, statuses, { channel: 'sms', deadline: Infinity, concurrency: 3 });
  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(order, Array.from({ length: 10 }, (_, i) => sid(i)));
});

test('a failed fetch keeps the entry and records why', async () => {
  const client = fakeClient({ fetch: async () => { throw new Error('boom'); } });
  const { statuses, changed } = await classicMessages.refreshStatuses(client, { [sid(1)]: { status: 'queued' } }, {
    channel: 'sms', deadline: Infinity,
  });
  assert.deepStrictEqual(statuses[sid(1)], { status: 'queued', error: 'boom' });
  assert.ok(changed.has(sid(1)));
});

test('tally counts delivered, read and terminal failures', () => {
  assert.deepStrictEqual(classicMessages.tally({
    a: { status: 'delivered' },
    b: { status: 'read' },
    c: { status: 'undelivered' },
    d: { status: 'failed' },
    e: { status: 'sent', delivered: true },
  }), { delivered: 3, read: 1, failed: 2 });
});
