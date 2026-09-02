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

test('wraps a literal body so Liquid cannot interpret it', () => {
  const [out] = payload.buildPayloads({ ...BASE, body: 'Hi {{name}}, 50% off' });
  assert.deepStrictEqual(out.content, {
    text: '{% raw %}Hi {{name}}, 50% off{% endraw %}',
  });
});

test('wraps a body with no Liquid syntax too, so behaviour does not vary', () => {
  const [out] = payload.buildPayloads({ ...BASE, body: 'Hello' });
  assert.strictEqual(out.content.text, '{% raw %}Hello{% endraw %}');
});

test('rejects a body that would break out of the raw wrapper', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, body: 'a {% endraw %} b' }),
    (err) => err.statusCode === 400 && /endraw/i.test(err.message)
  );
});

test('sends a content template by id with no text', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
  });
  assert.deepStrictEqual(out.content, { contentId: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b' });
});

test('a content template wins over a typed body', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: 'ignored',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
  });
  assert.deepStrictEqual(out.content, { contentId: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b' });
});

test('carries positional template variables per recipient', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [
      { to: '+15558675310', variables: { 1: 'Sarah', 2: '10am' } },
      { to: '+15558675311', variables: { 1: 'Ravi', 2: '2pm' } },
    ],
  });
  assert.deepStrictEqual(out.to, [
    { address: '+15558675310', channel: 'PHONE', variables: { 1: 'Sarah', 2: '10am' } },
    { address: '+15558675311', channel: 'PHONE', variables: { 1: 'Ravi', 2: '2pm' } },
  ]);
});

test('carries named template variables unchanged', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [{ to: '+15558675310', variables: { name: 'Sarah' } }],
  });
  assert.deepStrictEqual(out.to[0].variables, { name: 'Sarah' });
});

test('omits variables entirely when a recipient has none', () => {
  const [out] = payload.buildPayloads(BASE);
  assert.strictEqual('variables' in out.to[0], false);
});

test('sends an empty variable as empty text, not a fallback', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    contentSid: 'HXb0bb2f2f0f4d4a1e8f2b1c3d4e5f6a7b',
    recipients: [{ to: '+15558675310', variables: { 1: '' } }],
  });
  assert.deepStrictEqual(out.to[0].variables, { 1: '' });
});

test('rejects a request with neither body nor content template', () => {
  assert.throws(
    () => payload.buildPayloads({ ...BASE, body: '' }),
    (err) => err.statusCode === 400 && /message body|content template/i.test(err.message)
  );
});

test('routes per-recipient bodies through a single Liquid variable', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    recipients: [
      { to: '+15558675310', body: 'Your table is at 7pm' },
      { to: '+15558675311', body: 'Your table is at 8pm' },
    ],
  });

  // One content object for the whole request; the text differs per recipient
  // only because each supplies its own `body` variable.
  assert.deepStrictEqual(out.content, { text: '{{body}}' });
  assert.strictEqual(out.to[0].variables.body, 'Your table is at 7pm');
  assert.strictEqual(out.to[1].variables.body, 'Your table is at 8pm');
});

test('a blank per-recipient body falls back to the typed body', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: 'Default message',
    recipients: [
      { to: '+15558675310', body: 'Custom' },
      { to: '+15558675311', body: '   ' },
      { to: '+15558675312' },
    ],
  });
  assert.strictEqual(out.to[0].variables.body, 'Custom');
  assert.strictEqual(out.to[1].variables.body, 'Default message');
  assert.strictEqual(out.to[2].variables.body, 'Default message');
});

test('a per-recipient body is not itself Liquid-escaped', () => {
  // The body arrives as a variable value, and Liquid substitutes in one pass,
  // so `{{` inside it is inert. Wrapping it would send the wrapper as text.
  const [out] = payload.buildPayloads({
    ...BASE,
    body: '',
    recipients: [{ to: '+15558675310', body: 'Literal {{name}} stays' }],
  });
  assert.strictEqual(out.to[0].variables.body, 'Literal {{name}} stays');
});

test('rejects a recipient with no message text and no campaign body to fall back on', () => {
  assert.throws(
    () =>
      payload.buildPayloads({
        ...BASE,
        body: '',
        recipients: [
          { to: '+15558675310', body: 'Has one' },
          { to: '+15558675311' },
        ],
      }),
    (err) =>
      err.statusCode === 400 &&
      /1 recipient\(s\) have no message text/i.test(err.message) &&
      /blank/i.test(err.message)
  );
});

test('counts every recipient missing message text in the rejection', () => {
  assert.throws(
    () =>
      payload.buildPayloads({
        ...BASE,
        body: '',
        recipients: [
          { to: '+15558675310', body: 'Has one' },
          { to: '+15558675311' },
          { to: '+15558675312', body: '   ' },
        ],
      }),
    (err) => err.statusCode === 400 && /2 recipient\(s\) have no message text/i.test(err.message)
  );
});

test('a partially-filled body column still works when a campaign body is present', () => {
  const [out] = payload.buildPayloads({
    ...BASE,
    body: 'Fallback body',
    recipients: [
      { to: '+15558675310', body: 'Own text' },
      { to: '+15558675311' },
    ],
  });
  assert.deepStrictEqual(out.content, { text: '{{body}}' });
  assert.strictEqual(out.to[0].variables.body, 'Own text');
  assert.strictEqual(out.to[1].variables.body, 'Fallback body');
});
