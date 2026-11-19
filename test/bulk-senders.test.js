'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { filterToBulkSenders } = require('../assets/bulk-senders.private.js');

/** A dropdown option as get-phone-numbers.js builds it for a phone number. */
const option = (value) => ({ value, label: value, status: 'ONLINE', kind: 'direct' });

test('keeps only numbers that have a Bulk API Sender, in their original order', () => {
  const result = filterToBulkSenders(
    [option('+14452568672'), option('+18666942466'), option('+18336055607')],
    [{ address: '+18336055607' }, { address: '+18666942466' }]
  );

  assert.deepStrictEqual(result, {
    kept: [option('+18666942466'), option('+18336055607')],
    notBulkSenders: 1,
  });
});

test('drops every number when the account has no Bulk API Senders', () => {
  const result = filterToBulkSenders([option('+14452568672'), option('+14706646645')], []);

  assert.deepStrictEqual(result, { kept: [], notBulkSenders: 2 });
});

test('ignores Senders that carry no address', () => {
  const result = filterToBulkSenders([option('+18666942466')], [{ id: 'comms_sender_x' }, null]);

  assert.deepStrictEqual(result, { kept: [], notBulkSenders: 1 });
});

test('returns nothing kept and nothing dropped for an account with no numbers', () => {
  assert.deepStrictEqual(filterToBulkSenders([], [{ address: '+18666942466' }]), {
    kept: [],
    notBulkSenders: 0,
  });
});
