/**
 * POST /verify — validates a Twilio OAuth app against a typed Account SID.
 *
 * Persists nothing. Two things need proving here rather than one: that the
 * OAuth credentials work, and that they belong to the Account SID the user
 * typed. See https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps
 */

const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

const TOKEN_URL = 'https://oauth.twilio.com/v2/token';

// This handler makes TWO token exchanges, not one: the raw fetch below, and a
// second one inside the SDK when `createOAuthClient` builds a fresh provider for
// step 2. The raw fetch is still worth its cost — it is the only way to get a
// precise HTTP status to map to a message — but it means the 10s Function budget
// has to cover two round trips, so each step gets roughly half and its own
// deadline. Neither step may be left unbounded.
const TOKEN_TIMEOUT_MS = 4000;
const PROBE_TIMEOUT_MS = 4000;

// `withDeadline` comes from the shared helper rather than being redefined here.
// The SDK client has no request deadline of its own (30s default, plus up to three
// retries on a 429), so without it the platform can kill the invocation mid-probe
// and the user sees an opaque timeout instead of the message below.

function describeTokenError(status, rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const detail = parsed?.error_description || parsed?.message || parsed?.error;

  if (status === 400 || status === 401) {
    return detail
      ? `Invalid OAuth credentials — ${detail}`
      : 'Invalid OAuth credentials. Check the Client ID and Client Secret, and that the secret has not been rotated.';
  }
  return detail || `Token request failed (HTTP ${status}).`;
}

/**
 * Maps a step-2 failure to a message. Step 1 proved the credentials, but that
 * does NOT make every failure here the SID's fault: the client built in step 2
 * runs its own token exchange, so a transient token failure can surface at this
 * step too. Those arrive as a plain Error carrying neither `status` nor `code`,
 * and must not be blamed on the Account SID.
 */
function describeAccountError(err) {
  const code = err.code ?? err.status;

  if (err.name === 'DeadlineError') {
    return err.message;
  }
  if (code === undefined && /access token/i.test(err.message || '')) {
    return 'Could not obtain a Twilio access token while checking the Account SID. This is usually transient — try again.';
  }
  if (code === 70051 || err.status === 403) {
    return 'Those OAuth credentials are valid, but they do not grant access to that Account SID. Check the Account SID, and that the OAuth app has the Phone Numbers read scope. (Twilio error 70051)';
  }
  if (err.status === 401) {
    return 'Those OAuth credentials do not belong to that Account SID.';
  }
  if (code === 20404) {
    return 'That Account SID was not found. Check it against the Twilio Console dashboard.';
  }
  return `Could not read phone numbers for that Account SID — ${err.message || String(err)}`;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  let creds;
  try {
    creds = oauth.credsFrom(event);
  } catch (err) {
    response.setStatusCode(400);
    response.setBody({ valid: false, error: err.message });
    return callback(null, response);
  }

  // 1. Prove the OAuth credentials themselves. A direct token request is used
  //    rather than the SDK, because it yields a precise HTTP status to map;
  //    the SDK wraps token failures in a multi-line Error with no status.
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const text = await res.text();

    if (!res.ok) {
      // HTTP 200 with valid:false — the frontend distinguishes "rejected" from
      // "transport failed" by `valid`, not by status.
      response.setBody({ valid: false, error: describeTokenError(res.status, text) });
      return callback(null, response);
    }
  } catch (err) {
    const msg =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? "Twilio's token endpoint did not respond in time. Try again."
        : err.message || 'Verification failed.';
    response.setBody({ valid: false, error: msg });
    return callback(null, response);
  }

  // 2. Prove the credentials belong to the Account SID that was typed, and that
  //    the Phone Numbers read scope the From dropdown depends on is granted.
  //    Not billable. Without this, a mistyped SID passes login and then fails
  //    confusingly on first send.
  try {
    const { client } = oauth.createOAuthClient(creds);
    await oauth.withDeadline(
      client.incomingPhoneNumbers.list({ limit: 1 }),
      PROBE_TIMEOUT_MS,
      'Timed out reading phone numbers for that Account SID. Try again.'
    );
  } catch (err) {
    console.error('Verify account probe failed:', err);
    response.setBody({ valid: false, error: describeAccountError(err) });
    return callback(null, response);
  }

  response.setStatusCode(200);
  // Just `valid` — deliberately not echoing accountSid back. The caller typed it,
  // so returning it tells them nothing, and nothing in app.js reads it. (The
  // sibling project returns accountSid because it *derives* it from the access
  // token's JWT payload, which this app does not do; see spec § The Account SID
  // is still required.)
  response.setBody({ valid: true });
  return callback(null, response);
};
