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
async function createMessages(authString, payload) {
  const response = await request(authString, 'POST', '/Messages', { body: payload });
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
async function fetchOperation(authString, operationId) {
  const response = await request(
    authString,
    'GET',
    `/Messages/Operations/${encodeURIComponent(operationId)}`
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
async function listMessages(authString, { operationId, pageToken, pageSize = 1000 } = {}) {
  const response = await request(authString, 'GET', '/Messages', {
    query: { operation_id: operationId, pageSize, pageToken },
  });
  const body = await response.json();
  return {
    messages: Array.isArray(body.messages) ? body.messages : [],
    nextPageToken: (body.pagination && body.pagination.next) || null,
  };
}

module.exports = { createMessages, fetchOperation, listMessages, BASE_URL };
