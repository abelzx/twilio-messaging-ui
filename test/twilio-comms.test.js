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

test('returns a null operationId rather than throwing when none is present', async (t) => {
  // Observed against the live API: a 202 with no operation-ID header, whose
  // messages all sent anyway. Throwing here reported a fully successful send as
  // a 502, so a missing ID costs tracking only — never delivery.
  stubFetch(t, () => jsonResponse(202, undefined));
  const result = await comms.createMessages(AUTH, {});
  assert.deepStrictEqual(result, { operationId: null });
});

test('accepts the operation ID under alternative header spellings', async (t) => {
  for (const header of ['operation-id', 'x-operation-id', 'x-twilio-operation-id']) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse(202, undefined, { [header]: 'comms_operation_alt' });
    const result = await comms.createMessages(AUTH, {});
    globalThis.fetch = original;
    assert.strictEqual(result.operationId, 'comms_operation_alt', `header ${header}`);
  }
});

test('falls back to the last segment of a Location header', async (t) => {
  stubFetch(t, () =>
    jsonResponse(202, undefined, {
      location: 'https://comms.twilio.com/v1/Messages/Operations/comms_operation_loc',
    })
  );
  const result = await comms.createMessages(AUTH, {});
  assert.strictEqual(result.operationId, 'comms_operation_loc');
});

test('falls back to the response body when the ID is not a header', async (t) => {
  stubFetch(t, () => jsonResponse(202, { operationId: 'comms_operation_body' }));
  const result = await comms.createMessages(AUTH, {});
  assert.strictEqual(result.operationId, 'comms_operation_body');
});

test('reads a body id nested under operation', async (t) => {
  stubFetch(t, () => jsonResponse(200, { operation: { id: 'comms_operation_nested' } }));
  const result = await comms.createMessages(AUTH, {});
  assert.strictEqual(result.operationId, 'comms_operation_nested');
});

test('prefers the documented header over every fallback', async (t) => {
  stubFetch(t, () =>
    jsonResponse(
      202,
      { operationId: 'from_body' },
      { operationId: 'from_header', location: '/v1/Messages/Operations/from_location' }
    )
  );
  const result = await comms.createMessages(AUTH, {});
  assert.strictEqual(result.operationId, 'from_header');
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

const OPERATION = {
  id: 'comms_operation_01h2x',
  status: 'COMPLETED',
  stats: { total: 2, recipients: 2, delivered: 1, failed: 1 },
  createdAt: '2026-09-02T06:20:00Z',
  updatedAt: '2026-09-02T06:21:00Z',
};

test('fetches one operation by id', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, OPERATION));

  const operation = await comms.fetchOperation(AUTH, 'comms_operation_01h2x');

  assert.strictEqual(
    calls[0].url,
    'https://comms.twilio.com/v1/Messages/Operations/comms_operation_01h2x'
  );
  assert.strictEqual(calls[0].options.method, 'GET');
  assert.deepStrictEqual(operation, OPERATION);
});

test('URL-encodes an operation id', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, OPERATION));
  await comms.fetchOperation(AUTH, 'a/b c');
  assert.strictEqual(
    calls[0].url,
    'https://comms.twilio.com/v1/Messages/Operations/a%2Fb%20c'
  );
});

test('lists messages for an operation at the maximum page size', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(200, { messages: [{ id: 'm1' }], pagination: { next: null } })
  );

  const page = await comms.listMessages(AUTH, { operationId: 'comms_operation_01h2x' });

  const url = new URL(calls[0].url);
  assert.strictEqual(url.pathname, '/v1/Messages');
  assert.strictEqual(url.searchParams.get('operation_id'), 'comms_operation_01h2x');
  assert.strictEqual(url.searchParams.get('pageSize'), '1000');
  assert.deepStrictEqual(page, { messages: [{ id: 'm1' }], nextPageToken: null });
});

test('returns the next page token when there is another page', async (t) => {
  stubFetch(t, () =>
    jsonResponse(200, { messages: [], pagination: { next: 'tok2', self: 'tok1' } })
  );
  const page = await comms.listMessages(AUTH, { operationId: 'op' });
  assert.strictEqual(page.nextPageToken, 'tok2');
});

test('sends a page token when given one', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { messages: [] }));
  await comms.listMessages(AUTH, { operationId: 'op', pageToken: 'tok2' });
  assert.strictEqual(new URL(calls[0].url).searchParams.get('pageToken'), 'tok2');
});

test('tolerates a response with no messages array', async (t) => {
  stubFetch(t, () => jsonResponse(200, {}));
  const page = await comms.listMessages(AUTH, { operationId: 'op' });
  assert.deepStrictEqual(page, { messages: [], nextPageToken: null });
});

test('retries a 429 and succeeds', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(429, { code: 20429, message: 'Too Many Requests' })
      : jsonResponse(202, undefined, { operationId: 'comms_operation_ok' });
  });

  const result = await comms.createMessages(AUTH, {}, { baseDelay: 1 });

  assert.strictEqual(attempts, 2);
  assert.strictEqual(result.operationId, 'comms_operation_ok');
});

test('gives up after the retry budget and surfaces the 429', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return jsonResponse(429, { code: 20429, message: 'Too Many Requests' });
  });

  await assert.rejects(
    () => comms.createMessages(AUTH, {}, { maxRetries: 2, baseDelay: 1 }),
    (err) => err.statusCode === 429
  );
  assert.strictEqual(attempts, 3);
});

test('does not retry a 400', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return jsonResponse(400, { code: 21211, message: 'Invalid' });
  });

  await assert.rejects(() => comms.createMessages(AUTH, {}, { baseDelay: 1 }));
  assert.strictEqual(attempts, 1);
});

test('lists sender pools', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(200, { senderPools: [{ id: 'SP1', friendlyName: 'Marketing' }] })
  );

  const pools = await comms.listSenderPools(AUTH);

  assert.strictEqual(new URL(calls[0].url).pathname, '/v1/SenderPools');
  assert.deepStrictEqual(pools, [{ id: 'SP1', friendlyName: 'Marketing' }]);
});

test('returns an empty array when no sender pools exist', async (t) => {
  stubFetch(t, () => jsonResponse(200, {}));
  assert.deepStrictEqual(await comms.listSenderPools(AUTH), []);
});

test('retries a 429 when listing sender pools', async (t) => {
  let attempts = 0;
  stubFetch(t, () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(429, { code: 20429, message: 'Too Many Requests' })
      : jsonResponse(200, { senderPools: [{ id: 'SP1', friendlyName: 'Marketing' }] });
  });

  const pools = await comms.listSenderPools(AUTH, { baseDelay: 1 });

  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(pools, [{ id: 'SP1', friendlyName: 'Marketing' }]);
});
