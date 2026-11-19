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

test('an RCS agent as From sends to an rcs: recipient, prefixed once', () => {
  const opts = { channel: 'rcs', from: 'rcs:tmo_qsvqcst9_agent' };
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+6580998266', body: 'Hi' }, opts),
    { to: 'rcs:+6580998266', from: 'rcs:tmo_qsvqcst9_agent', body: 'Hi' }
  );
  assert.strictEqual(classicMessages.messageParams({ to: 'rcs:+6580998266', body: 'Hi' }, opts).to, 'rcs:+6580998266');
});

test('RCS through a Messaging Service keeps the recipient bare, so SMS fallback still works', () => {
  assert.deepStrictEqual(
    classicMessages.messageParams({ to: '+6580998266', body: 'Hi' }, { channel: 'rcs', from: MG }),
    { to: '+6580998266', messagingServiceSid: MG, body: 'Hi' }
  );
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
