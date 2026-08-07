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
 * Pulls the three credential fields out of a Function's event, trimmed.
 * Throws a 400-flagged Error naming whichever fields are missing.
 */
function credsFrom(event) {
  const accountSid = String(event.accountSid || '').trim();
  const clientId = String(event.clientId || '').trim();
  const clientSecret = String(event.clientSecret || '').trim();

  const missing = [];
  if (!accountSid) missing.push('Account SID');
  if (!clientId) missing.push('OAuth Client ID');
  if (!clientSecret) missing.push('OAuth Client Secret');

  if (missing.length > 0) {
    throw httpError(
      400,
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`
    );
  }

  return { accountSid, clientId, clientSecret };
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

  // MUST come after setCredentialProvider(), which sets accountSid to "".
  // Without this, v2010 URIs come out as /2010-04-01/Accounts//Messages.json.
  client.setAccountSid(creds.accountSid);

  return { client, authStrategy };
}

/**
 * Builds a client and proves the credentials work before returning it, so bad
 * credentials cost one clear failure instead of the same error repeated once per
 * message in a chunk. Throws a 401-flagged Error with a readable message.
 */
async function authenticate(creds) {
  const { client, authStrategy } = createOAuthClient(creds);
  try {
    await authStrategy.getAuthString();
  } catch (err) {
    throw httpError(401, tokenErrorMessage(err));
  }
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
module.exports = {
  credsFrom,
  createOAuthClient,
  authenticate,
  ownerKeyFor,
  getOrCreateSyncService,
};
