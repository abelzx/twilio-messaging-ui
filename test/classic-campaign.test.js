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
