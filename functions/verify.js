/**
 * POST /verify — validates a Twilio OAuth app against a typed Account SID.
 *
 * Persists nothing. Two things need proving here rather than one: that the
 * OAuth credentials work, and that they belong to the Account SID the user
 * typed. See https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps
 */

const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

const TOKEN_URL = 'https://oauth.twilio.com/v2/token';

/** Leaves headroom inside the 10s Function timeout for a readable error. */
const TOKEN_TIMEOUT_MS = 8000;

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

/** The credentials are known good by this point, so the fault is the SID or a scope. */
function describeAccountError(err) {
  const code = err.code ?? err.status;
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
    await client.incomingPhoneNumbers.list({ limit: 1 });
  } catch (err) {
    console.error('Verify account probe failed:', err);
    response.setBody({ valid: false, error: describeAccountError(err) });
    return callback(null, response);
  }

  response.setStatusCode(200);
  response.setBody({ valid: true, accountSid: creds.accountSid });
  return callback(null, response);
};
