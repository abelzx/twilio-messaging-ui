'use strict';

const test = require('node:test');
const assert = require('node:assert');

const payload = require('../assets/bulk-payload.private.js');

test('the module exports buildPayloads', () => {
  assert.strictEqual(typeof payload.buildPayloads, 'function');
});
