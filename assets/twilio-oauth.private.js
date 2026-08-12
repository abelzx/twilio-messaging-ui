/**
 * Shared OAuth credential handling for this app's Functions.
 *
 * This is a *private* asset: the `.private.js` suffix makes Twilio Serverless
 * mark it `access: private`, so it is never served over HTTP. Require it as:
 *
 *   const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
 *
 * Note the key drops the `.private` segment.
 */

const twilio = require('twilio');
const { ClientCredentialProviderBuilder } = twilio;

const SYNC_SERVICE_FRIENDLY_NAME = 'Messaging UI Sync Service';

/** An Error carrying the HTTP status a handler should respond with. */
function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Pulls the two credential fields out of a Function's event, trimmed.
 * Throws a 400-flagged Error naming whichever fields are missing.
 */
function credsFrom(event) {
  const clientId = String(event.clientId || '').trim();
  const clientSecret = String(event.clientSecret || '').trim();

  const missing = [];
  if (!clientId) missing.push('OAuth Client ID');
  if (!clientSecret) missing.push('OAuth Client Secret');
  if (missing.length) {
    throw httpError(400, `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
  }

  // No accountSid: it is derived from the access token in `authenticate`.
  return { clientId, clientSecret };
}

/**
 * Pulls the Account SID out of an access token's `act.sub` claim.
 *
 * `getAuthString()` returns "Bearer <jwt>". The JWT payload carries the acting
 * account as a Twilio Resource Name:
 *
 *   act.sub = "trn:us1:iam:account:AC0123…"
 *
 * `act` is the RFC 8693 actor claim, preferred over Twilio's private
 * `urn:tw:iam_ctx` (which holds the same value) because it is a standard claim.
 * `urn:tw:iam_ctx` is read only as a fallback.
 *
 * Returns null if no SID can be found — callers must treat that as fatal rather
 * than proceeding with an empty SID, which would build /Accounts//Messages.json.
 */
function accountSidFromAuthString(authString) {
  try {
    const jwt = String(authString || '').split(' ').pop();
    const segment = jwt.split('.')[1];
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    const candidates = [payload && payload.act && payload.act.sub, payload && payload['urn:tw:iam_ctx']];
    for (const candidate of candidates) {
      const match = String(candidate || '').match(/AC[0-9a-f]{32}/i);
      if (match) return match[0];
    }
  } catch {
    // Malformed token: fall through to null and let the caller fail loudly.
  }
  return null;
}

/** Token failures surface as a wrapped, multi-line Error with no code or status. */
function tokenErrorMessage(err) {
  const raw = (err.message || String(err)).replace(/\s+/g, ' ').trim();
  if (/\b401\b|invalid credentials|invalid_client/i.test(raw)) {
    return 'Invalid OAuth credentials. Check the Client ID and Client Secret, then sign in again.';
  }
  return `Could not obtain a Twilio access token — ${raw}`;
}

/**
 * Builds a Twilio client authenticated with an OAuth app (Client Credentials).
 * Returns the auth strategy too, so the caller can fetch the token once up front.
 */
function createOAuthClient(creds) {
  const provider = new ClientCredentialProviderBuilder()
    .setClientId(creds.clientId)
    .setClientSecret(creds.clientSecret)
    .build();

  // Load-bearing. The SDK calls toAuthStrategy() on EVERY API request, and each
  // call returns a strategy with an empty token cache — so one 100-message chunk
  // would fetch 100 access tokens inside a 9-second budget. Pinning one strategy
  // makes that a single fetch; the strategy's own 30-second expiry buffer still
  // re-fetches when an invocation outlives its token.
  const authStrategy = provider.toAuthStrategy();
  provider.toAuthStrategy = () => authStrategy;

  // Credentials come from the provider, so the constructor gets no SID/secret.
  const client = new twilio.Twilio(undefined, undefined, {
    autoRetry: true,
    maxRetries: 3,
  });
  client.setCredentialProvider(provider);

  // accountSid is deliberately NOT set here: it comes from the access token, which
  // does not exist until `authenticate` fetches one. Anything using this client
  // directly must set it, or v2010 URIs come out as /Accounts//Messages.json.

  return { client, authStrategy };
}

/** Default ceiling on a token exchange. See `authenticate`. */
const TOKEN_DEADLINE_MS = 4000;

/**
 * Rejects if `promise` outlives `ms`, with an Error named `DeadlineError`.
 *
 * `clearTimeout` runs in `.finally()` so a fast success does not leave a dangling
 * timer holding the Function invocation open for the full duration.
 */
function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(message), { name: 'DeadlineError' })),
      ms
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Builds a client and proves the credentials work before returning it, so bad
 * credentials cost one clear failure instead of the same error repeated once per
 * message in a chunk. Throws a 401-flagged Error with a readable message.
 *
 * The token exchange is deadline-bounded, and that is load-bearing rather than
 * defensive. `createOAuthClient` builds a fresh provider with an empty token
 * cache, so this is a real network round trip on every call, and the SDK's
 * `RequestClient` applies no deadline of its own — it defaults to 30s and retries
 * a 429 up to three times. Left unbounded inside a 10s Function budget, a slow
 * token endpoint strands the whole invocation: the platform kills it and the
 * caller gets no response at all rather than a readable error.
 *
 * That matters most in `send-messages.js` and `resume-execution.js`, which call
 * this once per 100-message chunk — roughly 50 times for a 5,000-message
 * campaign, each one a fresh chance to lose an invocation. Worse, a kill
 * mid-chunk can leave messages sent but not yet recorded in Sync, so the
 * browser's retry re-sends them and a recipient gets the message twice.
 *
 * Bounding it here rather than in each Function is deliberate: all six callers
 * inherit the protection, including any added later.
 */
async function authenticate(creds, timeoutMs = TOKEN_DEADLINE_MS) {
  const { client, authStrategy } = createOAuthClient(creds);
  let authString;
  try {
    authString = await withDeadline(
      authStrategy.getAuthString(),
      timeoutMs,
      "Twilio's token endpoint did not respond in time. Try again."
    );
  } catch (err) {
    // A deadline is not a credential problem, so it must not be reported as a
    // 401 — that would tell the user to check a Client Secret that is fine.
    if (err.name === 'DeadlineError') {
      throw httpError(504, err.message);
    }
    throw httpError(401, tokenErrorMessage(err));
  }

  const accountSid = accountSidFromAuthString(authString);
  if (!accountSid) {
    // Fail loudly. An unset accountSid silently produces /Accounts//Messages.json,
    // which fails later with a far less obvious message.
    throw httpError(
      502,
      'Signed in, but could not read the Account SID from the access token. This is unexpected — the token may have changed shape.'
    );
  }
  client.setAccountSid(accountSid);

  return client;
}

/**
 * The tenancy key stamped onto campaign documents.
 *
 * The Account SID cannot serve this purpose: it arrives in the request body, so
 * treating it as an authorization key would let any caller list another
 * account's campaigns by claiming their SID. A Client ID is only usable
 * together with its secret, and a successful token exchange proves the caller
 * holds both.
 */
function ownerKeyFor(creds) {
  return `oauth:${creds.clientId}`;
}

/**
 * Finds this app's Sync service, creating it if absent. Called with the
 * *runtime* client (context.ACCOUNT_SID / context.AUTH_TOKEN), never the user's.
 */
async function getOrCreateSyncService(client) {
  try {
    const services = await client.sync.v1.services.list({ limit: 20 });
    const existingService = services.find(
      (s) => s.friendlyName === SYNC_SERVICE_FRIENDLY_NAME
    );
    if (existingService) {
      return existingService.sid;
    }

    const service = await client.sync.v1.services.create({
      friendlyName: SYNC_SERVICE_FRIENDLY_NAME,
    });
    return service.sid;
  } catch (error) {
    console.error('Error getting/creating Sync service:', error);
    // Fall back to the first available service rather than failing the request.
    try {
      const services = await client.sync.v1.services.list({ limit: 1 });
      if (services.length > 0) {
        return services[0].sid;
      }
    } catch (e) {
      console.error('Error getting any Sync service:', e);
    }
    throw error;
  }
}

// `httpError` and `tokenErrorMessage` are deliberately not exported. The spec's
// module-interface sketch listed `tokenErrorMessage`, but no Function calls either
// one: callers read `error.statusCode` off the thrown Error (see Task 3 onward) and
// never need to construct one. Exporting them would advertise surface nobody uses.
//
// `withDeadline` IS exported, because verify.js needs it for its phone-number probe
// — a second unbounded SDK call that `authenticate` does not cover.
module.exports = {
  credsFrom,
  createOAuthClient,
  authenticate,
  accountSidFromAuthString,
  ownerKeyFor,
  getOrCreateSyncService,
  withDeadline,
};
