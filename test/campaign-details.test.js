'use strict';

const test = require('node:test');
const assert = require('node:assert');

const details = require('../assets/campaign-details.private.js');

const HX = `HX${'a'.repeat(32)}`;
const MG = `MG${'b'.repeat(32)}`;

const BULK_INPUT = {
  sender: { label: 'Acme Service · MGbbbbbbbb…', kind: 'service' },
  template: { name: 'promo_v2', language: 'en' },
  message: { perRecipient: false },
  variables: { values: { 1: 'Sarah' }, perRecipient: false },
  media: { urls: ['https://example.com/a.jpg'], perRecipient: false },
  recipients: { source: 'csv', fileName: 'spring.csv' },
};

const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('buildDetails keeps the browser labels alongside the server facts', () => {
  const out = details.buildDetails(BULK_INPUT, {
    mode: 'bulk', contentSid: HX, body: '', recipientCount: 120, fallbackToSms: true,
  });
  assert.deepStrictEqual(out, {
    sender: { label: 'Acme Service · MGbbbbbbbb…', kind: 'service' },
    template: { sid: HX, name: 'promo_v2', language: 'en' },
    message: { body: null, perRecipient: false },
    variables: { values: { 1: 'Sarah' }, perRecipient: false },
    media: { urls: ['https://example.com/a.jpg'], perRecipient: false },
    recipients: { source: 'csv', fileName: 'spring.csv', count: 120 },
    fallbackToSms: true,
  });
});

test('a template name with no template SID behind it is dropped', () => {
  const out = details.buildDetails(BULK_INPUT, { mode: 'bulk', contentSid: null, body: 'Hi', recipientCount: 1 });
  assert.strictEqual(out.template, null);
  assert.strictEqual(out.variables, null);
  assert.strictEqual(out.media, null);
  assert.deepStrictEqual(out.message, { body: 'Hi', perRecipient: false });
});

test('a body sent alongside a template is not recorded as the message', () => {
  const out = details.buildDetails({}, { mode: 'bulk', contentSid: HX, body: 'Hi', recipientCount: 1 });
  assert.deepStrictEqual(out.message, { body: null, perRecipient: false });
});

test('the server\'s per-recipient body fact wins over the browser\'s flag', () => {
  const out = details.buildDetails(
    { message: { perRecipient: false } },
    { mode: 'bulk', body: 'fallback text', perRecipientBody: true, recipientCount: 2 }
  );
  assert.deepStrictEqual(out.message, { body: null, perRecipient: true });
});

test('classic leaves out the body and variable values, keeping the flags', () => {
  const out = details.buildDetails(
    { message: { perRecipient: true }, variables: { values: { 1: 'Sarah' }, perRecipient: false } },
    { mode: 'classic', contentSid: HX, body: 'ignored', recipientCount: 3 }
  );
  assert.deepStrictEqual(out.variables, { values: null, perRecipient: false });
  assert.deepStrictEqual(out.message, { body: null, perRecipient: false });

  const typed = details.buildDetails({}, { mode: 'classic', body: 'Hi', recipientCount: 1 });
  assert.strictEqual(typed.message.body, null);
});

test('strings are trimmed and capped; anything else is dropped', () => {
  const out = details.buildDetails(
    {
      sender: { label: `  ${'x'.repeat(200)}  `, kind: 'admin' },
      template: { name: 42, language: 'en-US-x-twilio-very-long' },
      recipients: { source: 'csv', fileName: ['a.csv'] },
    },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.strictEqual(out.sender.label.length, 120);
  assert.ok(out.sender.label.endsWith('…'));
  assert.strictEqual(out.sender.kind, null);
  assert.strictEqual(out.template.name, null);
  assert.strictEqual(out.template.language.length, 16);
  assert.strictEqual(out.recipients.fileName, null);
});

test('variables are capped at 10 keys and blank values are dropped', () => {
  const values = {};
  for (let i = 1; i <= 15; i++) values[i] = `v${i}`;
  values[3] = '   ';
  const out = details.buildDetails(
    { variables: { values } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.strictEqual(Object.keys(out.variables.values).length, 10);
  assert.strictEqual(out.variables.values[3], undefined);
});

test('media URLs over 300 chars are dropped, not truncated, and duplicates collapse', () => {
  const long = `https://example.com/${'p'.repeat(300)}`;
  const out = details.buildDetails(
    { media: { urls: [long, 'https://a.example/1.jpg', 'https://a.example/1.jpg', 7] } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.deepStrictEqual(out.media, { urls: ['https://a.example/1.jpg'], perRecipient: false });
});

test('an invalid content SID records no template', () => {
  const out = details.buildDetails(BULK_INPUT, { mode: 'bulk', contentSid: 'HXnope', body: 'Hi', recipientCount: 1 });
  assert.strictEqual(out.template, null);
});

test('malformed input costs the labels, never the facts', () => {
  for (const input of [undefined, null, 'details', ['x'], 5]) {
    const out = details.buildDetails(input, { mode: 'bulk', body: 'Hi', recipientCount: 4, fallbackToSms: false });
    assert.deepStrictEqual(out.sender, { label: null, kind: null });
    assert.deepStrictEqual(out.message, { body: 'Hi', perRecipient: false });
    assert.deepStrictEqual(out.recipients, { source: 'typed', fileName: null, count: 4 });
    assert.strictEqual(out.fallbackToSms, false);
  }
});

test('over budget, media is dropped first', () => {
  const values = {};
  for (let i = 1; i <= 10; i++) values[i] = 'v'.repeat(100);
  const urls = [1, 2, 3].map((n) => `https://example.com/${String(n).repeat(280)}`);
  const out = details.buildDetails(
    { variables: { values }, media: { urls } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.strictEqual(out.media, null);
  assert.strictEqual(Object.keys(out.variables.values).length, 10);
  assert.ok(size(out) <= details.MAX_DETAILS_BYTES);
});

test('over budget after media, variable values go next', () => {
  const values = {};
  for (let i = 1; i <= 10; i++) values[i] = '漢'.repeat(100);
  const out = details.buildDetails(
    { variables: { values } },
    { mode: 'bulk', contentSid: HX, recipientCount: 1 }
  );
  assert.deepStrictEqual(out.variables, { values: null, perRecipient: false });
  assert.ok(size(out) <= details.MAX_DETAILS_BYTES);
});

test('over budget with no template, the body goes last', () => {
  const label = '漢'.repeat(120);
  const out = details.buildDetails(
    { sender: { label }, recipients: { source: 'csv', fileName: label } },
    { mode: 'bulk', body: '漢'.repeat(500), recipientCount: 1 }
  );
  assert.strictEqual(out.message.body, null);
  assert.strictEqual(out.sender.label, label);
  assert.ok(size(out) <= details.MAX_DETAILS_BYTES);
});

const NEW_BULK_DOC = {
  mode: 'bulk',
  channel: 'whatsapp',
  from: MG,
  scheduledFor: '2026-11-04T01:30:00.000Z',
  recipientCount: 120,
  operationIds: ['01JBOP', '01JCOP'],
  details: details.buildDetails(BULK_INPUT, {
    mode: 'bulk', contentSid: HX, recipientCount: 120, fallbackToSms: true,
  }),
};

test('resolveDetails shows a new bulk campaign in full', () => {
  assert.deepStrictEqual(details.resolveDetails(NEW_BULK_DOC), {
    mode: 'bulk',
    channel: 'whatsapp',
    sender: { label: 'Acme Service · MGbbbbbbbb…', kind: 'service', address: MG },
    template: { sid: HX, name: 'promo_v2', language: 'en' },
    message: null,
    variables: { values: { 1: 'Sarah' }, perRecipient: false },
    media: { urls: ['https://example.com/a.jpg'], perRecipient: false },
    recipients: { source: 'csv', fileName: 'spring.csv', count: 120 },
    scheduledFor: '2026-11-04T01:30:00.000Z',
    fallbackToSms: true,
    operationIds: ['01JBOP', '01JCOP'],
  });
});

test('resolveDetails marks what an old bulk campaign never recorded', () => {
  const out = details.resolveDetails({
    mode: 'bulk', channel: 'sms', from: '+15017122661', recipientCount: 3, operationIds: ['01JBOP'],
  });
  assert.deepStrictEqual(out.sender, { label: null, kind: 'direct', address: '+15017122661' });
  assert.deepStrictEqual(out.template, { notRecorded: true });
  assert.deepStrictEqual(out.message, { notRecorded: true });
  assert.strictEqual(out.variables, null);
  assert.deepStrictEqual(out.recipients, { source: null, fileName: null, count: 3 });
  assert.strictEqual(out.fallbackToSms, null);
});

test('resolveDetails derives an old classic campaign from messages[0]', () => {
  const out = details.resolveDetails({
    channel: 'sms',
    from: MG,
    totalMessages: 2,
    messages: [{ to: '+15558675310', from: MG, body: 'Hi there' }],
  });
  assert.deepStrictEqual(out.sender, { label: null, kind: 'service', address: MG });
  assert.strictEqual(out.template, null);
  assert.deepStrictEqual(out.message, { body: 'Hi there', perRecipient: false });
  assert.strictEqual(out.variables, null);
  assert.deepStrictEqual(out.recipients, { source: null, fileName: null, count: 2 });
  assert.strictEqual(out.operationIds, null);
});

test('resolveDetails reads an old classic template and its JSON-string variables', () => {
  const out = details.resolveDetails({
    channel: 'whatsapp',
    from: '+15017122661',
    totalMessages: 1,
    messages: [{ contentSid: HX, contentVariables: '{"1":"Sarah"}', body: 'typed too' }],
  });
  assert.deepStrictEqual(out.template, { sid: HX, name: null, language: null });
  assert.strictEqual(out.message, null);
  assert.deepStrictEqual(out.variables, { values: { 1: 'Sarah' }, perRecipient: false });
});

test('resolveDetails trusts a classic per-recipient flag over messages[0]', () => {
  const withVariables = details.resolveDetails({
    channel: 'sms',
    from: '+15017122661',
    totalMessages: 2,
    messages: [{ contentSid: HX, contentVariables: { 1: 'Row one' } }],
    details: details.buildDetails(
      { template: { name: 'promo_v2', language: 'en' }, variables: { perRecipient: true } },
      { mode: 'classic', contentSid: HX, recipientCount: 2 }
    ),
  });
  assert.deepStrictEqual(withVariables.template, { sid: HX, name: 'promo_v2', language: 'en' });
  assert.deepStrictEqual(withVariables.variables, { values: null, perRecipient: true });

  const withBodies = details.resolveDetails({
    channel: 'sms',
    from: '+15017122661',
    totalMessages: 2,
    messages: [{ body: 'Row one text' }],
    details: details.buildDetails({ message: { perRecipient: true } }, { mode: 'classic', recipientCount: 2 }),
  });
  assert.deepStrictEqual(withBodies.message, { body: null, perRecipient: true });
});

test('resolveDetails survives a document with nothing in it', () => {
  const out = details.resolveDetails(null);
  assert.strictEqual(out.mode, 'classic');
  assert.deepStrictEqual(out.sender, { label: null, kind: null, address: null });
  assert.strictEqual(out.template, null);
  assert.strictEqual(out.message, null);
});

test('summaryLine prefers labels and falls back to raw values', () => {
  assert.deepStrictEqual(details.summaryLine(NEW_BULK_DOC), {
    channel: 'whatsapp', sender: 'Acme Service · MGbbbbbbbb…', template: 'promo_v2',
  });
  assert.deepStrictEqual(
    details.summaryLine({ mode: 'bulk', channel: 'sms', from: '+15017122661' }),
    { channel: 'sms', sender: '+15017122661', template: null }
  );
  assert.deepStrictEqual(
    details.summaryLine({ channel: 'sms', from: '+15017122661', messages: [{ contentSid: HX }] }),
    { channel: 'sms', sender: '+15017122661', template: HX }
  );
});
