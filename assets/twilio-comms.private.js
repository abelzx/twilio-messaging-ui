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
/** Pulls one human-readable string out of an error entry of unknown shape. */
function describeEntry(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return String(entry);

  const parts = [entry.message, entry.detail, entry.title, entry.description, entry.reason]
    .filter((part) => typeof part === 'string' && part.trim());

  // A field-level validation error is only useful with the field named.
  const field = entry.field || entry.path || entry.property || entry.parameter;
  const text = parts.join(' — ');
  return field && text ? `${field}: ${text}` : text || '';
}

/**
 * Turns a non-2xx response into a thrown Error carrying the API's real complaint.
 *
 * Every plausible error envelope is tried, because a single `body.message` read
 * is not enough: this API has returned a 400 whose body used none of it, and the
 * fallback to `response.statusText` produced a bare "Bad Request" that said
 * nothing about what was actually rejected. An opaque error is nearly as bad as
 * no error, so when no recognised field is found the raw body is included
 * verbatim (truncated) rather than discarded.
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

  let detail = '';

  if (body && typeof body === 'object') {
    detail = describeEntry(body);

    // Some envelopes nest the real message one level down.
    if (!detail) detail = describeEntry(body.error);

    // A list of field-level failures is the most useful shape of all, so it wins
    // over a generic top-level summary when both are present.
    const list = [body.errors, body.details, body.violations].find(Array.isArray);
    if (list && list.length) {
      const described = list.map(describeEntry).filter(Boolean);
      if (described.length) {
        const shown = described.slice(0, 5).join('; ');
        detail = described.length > 5
          ? `${shown} (and ${described.length - 5} more)`
          : shown;
      }
    }
  }

  // Nothing recognised: show what actually came back. Better an ugly raw body
  // than "Bad Request" with the cause thrown away.
  if (!detail) {
    const raw = text.trim().replace(/\s+/g, ' ').slice(0, 400);
    detail = raw
      ? `${response.status} ${response.statusText || ''}`.trim() + ` — Twilio returned: ${raw}`
      : `${response.status} ${response.statusText || 'Unknown error'} with an empty body`;
  }

  // Keys and status only, never values: an error body can echo recipient
  // numbers, and this deployment does not write those to its logs.
  console.error(
    `Bulk API ${response.status} on ${response.url || 'comms request'}. ` +
      `Body keys: ${body && typeof body === 'object' ? Object.keys(body).join(', ') || '(empty object)' : '(non-JSON body)'}.`
  );

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
 * Header names an operation ID has been seen or documented under. `Headers.get`
 * is case-insensitive, so these only need to differ in shape, not in casing.
 */
const OPERATION_ID_HEADERS = [
  'operationid',
  'operation-id',
  'x-operation-id',
  'x-twilio-operation-id',
];

/** Body keys an operation ID may arrive under when it is not a header at all. */
const OPERATION_ID_BODY_KEYS = ['operationId', 'operation_id', 'id', 'sid'];

/**
 * Finds the operation ID wherever this response happens to carry it.
 *
 * The documentation says it is an `operationId` response header. Against the
 * live API that is not always true — a 202 has been observed carrying no such
 * header while still sending every message. So each plausible carrier is tried:
 * the documented header, obvious variants, a `Location` URL's last segment, and
 * finally the body, which may return the operation inline.
 *
 * Returns null when nothing is found, and that is deliberately not an error —
 * see createMessages.
 */
function findOperationId(response, body) {
  for (const name of OPERATION_ID_HEADERS) {
    const value = response.headers.get(name);
    if (value) return String(value).trim();
  }

  // A 202 commonly points at the created resource rather than naming it.
  const location = response.headers.get('location');
  if (location) {
    const tail = String(location).split('?')[0].replace(/\/+$/, '').split('/').pop();
    if (tail) return tail;
  }

  if (body && typeof body === 'object') {
    const nested = body.operation && typeof body.operation === 'object' ? body.operation : null;
    for (const source of [body, body.meta, nested]) {
      if (!source || typeof source !== 'object') continue;
      for (const key of OPERATION_ID_BODY_KEYS) {
        if (source[key]) return String(source[key]).trim();
      }
    }
  }

  return null;
}

/**
 * Submits one operation of up to 10,000 recipients.
 *
 * `operationId` may be null, and callers MUST tolerate that rather than treating
 * it as a failure. By the time this function returns, Twilio has accepted the
 * request and the messages are on their way — an earlier version threw here when
 * the header was missing, which reported a completely successful send as a 502.
 * What a missing ID costs is progress tracking, not delivery, and those are not
 * the same thing.
 *
 * The miss is logged with the header names actually present, so the real carrier
 * can be identified from the Function logs and added above. Names only: a header
 * value could carry something we should not write to a log.
 */
async function createMessages(authString, payload, retryOptions) {
  const response = await withRateLimitRetry(
    () => request(authString, 'POST', '/Messages', { body: payload }),
    retryOptions
  );

  // Read defensively: a 202 is documented to have an empty body, so absence is
  // normal and must not turn a successful send into a parse error.
  let body = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  const operationId = findOperationId(response, body);

  if (!operationId) {
    const present = [];
    response.headers.forEach((_value, name) => present.push(name));
    console.error(
      `Bulk create returned ${response.status} with no recognisable operation ID. ` +
        `Headers present: ${present.sort().join(', ') || '(none)'}. ` +
        `Body keys: ${body && typeof body === 'object' ? Object.keys(body).join(', ') || '(empty object)' : '(no body)'}.`
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
/**
 * Drops messages that demonstrably belong to a different operation.
 *
 * Defence in depth behind the query filter, not a replacement for it. Sending an
 * unrecognised filter name gets the whole account's messages back, and showing a
 * previous campaign's recipients under the current campaign is worse than showing
 * none — so anything that names a different operation is discarded here.
 *
 * A row that carries no recognisable operation field is KEPT: the field name is
 * unconfirmed, and silently dropping every row because we cannot read it would
 * turn a wrong list into an empty one. If the whole page survives untouched, the
 * caller logs it, because that means neither the filter nor this guard is working.
 */
function onlyFromOperation(messages, operationId) {
  const wanted = String(operationId);

  const belongsElsewhere = (message) => {
    const candidates = [
      message.operationId,
      message.operation_id,
      message.operationSid,
      message.operation && message.operation.id,
    ].filter((value) => value != null && value !== '');

    return candidates.length > 0 && !candidates.some((value) => String(value) === wanted);
  };

  const kept = messages.filter((message) => !belongsElsewhere(message));

  if (messages.length && kept.length === messages.length) {
    const sample = messages[0];
    const identifiable = ['operationId', 'operation_id', 'operationSid', 'operation'].some(
      (key) => sample && sample[key] != null
    );
    if (!identifiable) {
      console.error(
        'Bulk message rows carry no recognisable operation field, so they cannot be ' +
          `verified as belonging to ${wanted}. Row keys: ${Object.keys(sample || {}).join(', ') || '(none)'}.`
      );
    }
  }

  return kept;
}

async function listMessages(
  authString,
  { operationId, pageToken, pageSize = 1000 } = {},
  retryOptions
) {
  const response = await withRateLimitRetry(
    () =>
      request(authString, 'GET', '/Messages', {
        // Both spellings, because the wrong one is silently ignored rather than
        // rejected — and an ignored filter returns every message on the account,
        // which showed every past campaign's messages in the delivery panel. The
        // tracking guide documents `operation_id`; every other parameter this API
        // takes is camelCase, so `operationId` is at least as likely.
        query: { operation_id: operationId, operationId, pageSize, pageToken },
      }),
    retryOptions
  );
  const body = await response.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];

  return {
    messages: operationId ? onlyFromOperation(messages, operationId) : messages,
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
