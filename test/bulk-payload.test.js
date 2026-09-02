'use strict';

const test = require('node:test');
const assert = require('node:assert');

const payload = require('../assets/bulk-payload.private.js');

test('the module exports buildPayloads', () => {
  assert.strictEqual(typeof payload.buildPayloads, 'function');
});

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
