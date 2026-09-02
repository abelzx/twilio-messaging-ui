/**
 * The only module that knows about comms.twilio.com.
 *
 * This is a *private* asset: the `.private.js` suffix makes Twilio Serverless
 * mark it `access: private`, so it is never served over HTTP. Require it as:
 *
 *   const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);
 *
 * Note the key drops the `.private` segment.
 *
 * Raw fetch rather than the SDK, because `comms` is absent from twilio@5.10.6 —
 * there is no `client.comms` namespace to call. Node 24 provides fetch globally.
 * Keeping every URL, header and error shape here means the Functions above it
 * do not know this is HTTP.
 */

'use strict';

const BASE_URL = 'https://comms.twilio.com/v1';

/** An Error carrying the HTTP status a handler should respond with. */
function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code != null) err.code = code;
  return err;
}

/**
 * Turns a non-2xx response into a thrown Error.
 *
 * The body is read as text first and parsed defensively: a gateway error can
 * return HTML, and letting `response.json()` throw would replace Twilio's real
 * status with a JSON syntax error.
 */
async function raiseFor(response) {
  const text = await response.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  const detail = (body && body.message) || response.statusText || 'Unknown error';

  if (response.status === 401 || response.status === 403) {
    throw httpError(
      response.status,
      `${detail} — check that the OAuth app has the Comms scopes granted for Bulk Messaging.`,
      body && body.code
    );
  }

  throw httpError(response.status, detail, body && body.code);
}

/**
 * Retries a 429 with exponential backoff and jitter.
 *
 * Deliberately not shared with the copy in send-messages.js. Extracting that one
 * would mean editing the classic send path, which this branch leaves alone, and
 * the two have different jobs: that retries up to 100 concurrent creates, this
 * retries a single request. Jitter still matters — several browsers submitting
 * campaigns at once would otherwise retry in lockstep.
 */
async function withRateLimitRetry(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 8000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error.statusCode !== 429 || attempt === maxRetries) throw error;

      const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      const jitter = Math.random() * 0.3 * delay;
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
  throw lastError;
}

async function request(authString, method, path, { body, query } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: authString,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) await raiseFor(response);
  return response;
}

/**
 * Submits one operation of up to 10,000 recipients.
 *
 * Returns only the operation ID: the 202 body is empty by design, and the ID
 * arrives as a response header. A 202 without one leaves nothing to track, so
 * it is treated as a protocol failure rather than a success.
 */
async function createMessages(authString, payload, retryOptions) {
  const response = await withRateLimitRetry(
    () => request(authString, 'POST', '/Messages', { body: payload }),
    retryOptions
  );
  const operationId = response.headers.get('operationid');
  if (!operationId) {
    throw httpError(
      502,
      'Twilio accepted the request but returned no operationId, so its progress cannot be tracked.'
    );
  }
  return { operationId };
}

/** Aggregate status and stats for one operation. */
async function fetchOperation(authString, operationId, retryOptions) {
  const response = await withRateLimitRetry(
    () =>
      request(
        authString,
        'GET',
        `/Messages/Operations/${encodeURIComponent(operationId)}`
      ),
    retryOptions
  );
  return response.json();
}

/**
 * One page of the Messages an operation created.
 *
 * Page size is pinned to the documented maximum of 1000 to keep the number of
 * round trips down: a 10,000-recipient operation is ten pages rather than a
 * hundred. `pagination.next` is opaque and is returned as-is for the caller to
 * pass back.
 */
async function listMessages(
  authString,
  { operationId, pageToken, pageSize = 1000 } = {},
  retryOptions
) {
  const response = await withRateLimitRetry(
    () =>
      request(authString, 'GET', '/Messages', {
        query: { operation_id: operationId, pageSize, pageToken },
      }),
    retryOptions
  );
  const body = await response.json();
  return {
    messages: Array.isArray(body.messages) ? body.messages : [],
    nextPageToken: (body.pagination && body.pagination.next) || null,
  };
}

/**
 * Sender pools available for bulk sends.
 *
 * The response key is unconfirmed against a live account — Task 22 verifies it.
 * Both `senderPools` and `sender_pools` are accepted so a naming difference
 * degrades to an empty list rather than a crash.
 */
async function listSenderPools(authString, retryOptions) {
  // Wrapped like its three siblings above: a 429 here is otherwise
  // indistinguishable from "this account has no pools" once it's caught by
  // get-phone-numbers.js's poolListFailed handling, so it deserves the same
  // backoff-and-retry chance before giving up.
  const response = await withRateLimitRetry(
    () => request(authString, 'GET', '/SenderPools', { query: { pageSize: 100 } }),
    retryOptions
  );
  const body = await response.json();
  const pools = body.senderPools || body.sender_pools || body.pools;
  return Array.isArray(pools) ? pools : [];
}

module.exports = { createMessages, fetchOperation, listMessages, listSenderPools, BASE_URL };
