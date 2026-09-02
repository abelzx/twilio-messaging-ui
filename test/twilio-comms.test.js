'use strict';

const test = require('node:test');
const assert = require('node:assert');

const comms = require('../assets/twilio-comms.private.js');

const AUTH = 'Bearer test.jwt.value';

/**
 * Replaces global fetch for one test and records what it was called with.
 * Returns the call log; restore happens via t.after so a failure cannot leak
 * the stub into another test.
 */
function stubFetch(t, responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('posts to the Messages endpoint with a bearer token and JSON body', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(202, undefined, { operationId: 'comms_operation_01h9k' })
  );

  const result = await comms.createMessages(AUTH, { to: [], content: { text: 'hi' } });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://comms.twilio.com/v1/Messages');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.headers.Authorization, AUTH);
  assert.strictEqual(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    to: [],
    content: { text: 'hi' },
  });
  assert.deepStrictEqual(result, { operationId: 'comms_operation_01h9k' });
});

test('reads the operationId header case-insensitively', async (t) => {
  stubFetch(t, () => jsonResponse(202, undefined, { OperationId: 'comms_operation_x' }));
  const result = await comms.createMessages(AUTH, {});
  assert.strictEqual(result.operationId, 'comms_operation_x');
});

test('fails loudly when a 202 carries no operationId', async (t) => {
  stubFetch(t, () => jsonResponse(202, undefined));
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 502 && /operationId/i.test(err.message)
  );
});

test('surfaces a 400 message verbatim', async (t) => {
  stubFetch(t, () =>
    jsonResponse(400, { code: 21211, message: "Invalid 'To' address" })
  );
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 400 && err.code === 21211 && /Invalid 'To' address/.test(err.message)
  );
});

test('adds a scope hint to a 401', async (t) => {
  stubFetch(t, () => jsonResponse(401, { code: 20003, message: 'Authentication Error' }));
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 401 && /Comms/i.test(err.message)
  );
});

test('reports a non-JSON error body without throwing on the parse', async (t) => {
  const calls = stubFetch(t, () => new Response('<html>gateway</html>', { status: 502 }));
  await assert.rejects(
    () => comms.createMessages(AUTH, {}),
    (err) => err.statusCode === 502
  );
  assert.strictEqual(calls.length, 1);
});
