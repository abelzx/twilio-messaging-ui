# OAuth Client Credentials Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace this app's Account SID + Auth Token / API Key + Secret login with an account-level Twilio OAuth app (Client Credentials grant), and stop storing any user credential server-side.

**Architecture:** Credentials live in the browser's `sessionStorage` and travel in the JSON body of every Function request. Each Function builds a per-request Twilio client from a `ClientCredentialProviderBuilder`, via a shared private asset that also memoises the auth strategy. The Twilio Sync credential store is deleted; Sync keeps only campaign documents, which gain an `ownerKey` derived from the caller's proven Client ID.

**Tech Stack:** Twilio Serverless (Functions + Assets), `twilio@5.10.6` Node SDK, Twilio Sync, vanilla browser JavaScript. No build step, no test framework.

---

## Read This First

**The spec is `docs/superpowers/specs/2026-08-07-oauth-login-design.md`.** Read it before Task 1. It explains *why* three things that look wrong are correct:

1. `setAccountSid()` must be called **after** `setCredentialProvider()`, because the latter sets `accountSid` to `""` and v2010 URIs are built from that field.
2. `provider.toAuthStrategy` must be **memoised**, or a 100-message chunk performs 100 token fetches inside a 9-second budget.
3. `list-campaigns` must call `authenticate()` even though it makes no call against the user's account, or its `ownerKey` filter is bypassable.

**There is no test suite and none is being added.** Every task therefore ends with a *verification step* — a `node -e` check, a syntax check, or an exact click-path — instead of a unit test. Task 12 is the live end-to-end deploy.

**Do not run `twilio serverless:deploy` until Task 12.** A half-migrated deployment has functions expecting credentials in the body and a frontend still sending `sessionId`.

Expect a specific broken window between Tasks 6 and 8: `check-status` starts requiring `ownerKey` in Task 6, but nothing *writes* `ownerKey` until Task 7 (`send-messages`) and Task 8 (`resume-execution`). In between, `check-status` correctly 404s even for a campaign's rightful owner, because no document carries the field yet. That is the task ordering working as intended, not a regression — and another reason not to deploy mid-sequence.

## File Structure

| File | Action | Responsibility after this change |
|---|---|---|
| `assets/twilio-oauth.private.js` | **Create** | All OAuth credential handling: parse, build client, prove token, tenancy key, Sync service lookup. Private asset — never served over HTTP. |
| `functions/verify.js` | **Create** | `POST /verify` — validate credentials at login. Persists nothing. |
| `functions/auth.js` | **Delete** | (was: validate + write raw secrets into a Sync document) |
| `functions/get-phone-numbers.js` | Modify | `POST` — list SMS-capable numbers |
| `functions/get-content-templates.js` | Modify | `POST` — list WhatsApp/RCS content templates |
| `functions/list-campaigns.js` | Modify | `POST` — list campaigns filtered by `ownerKey` |
| `functions/check-status.js` | Modify | `POST` — campaign status, 404 for non-owners |
| `functions/send-messages.js` | Modify | `POST` — send a chunk, write `ownerKey` on create |
| `functions/resume-execution.js` | Modify | `POST` — resume a chunk, 404 for non-owners, `isComplete` bug fixed |
| `functions/webhook.js` | **Untouched** | Uses runtime credentials only. Do not edit it. |
| `assets/index.html` | Modify | Three-field login form |
| `assets/app.js` | Modify | `sessionStorage` credentials, one `postToFunction()` helper for all 8 data calls |
| `twilio.json` | **Delete** | Nothing reads it (see spec § Configuration) |
| `README.md` | Modify | Document OAuth login and the new security posture |

`package.json` is not touched — `twilio@5.10.6` is already installed and already exports `ClientCredentialProviderBuilder`.

---

### Task 1: The shared OAuth helper (private asset)

Everything else depends on this file, so it comes first.

**Files:**
- Create: `assets/twilio-oauth.private.js`

- [ ] **Step 1: Create the helper module**

Create `assets/twilio-oauth.private.js` with exactly this content:

```js
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
```

- [ ] **Step 2: Verify the module loads and builds correct request URIs**

This is the check that the `setAccountSid()`-after-`setCredentialProvider()` ordering actually works. It uses fake credentials and makes no network call — it stubs the request layer and inspects the URI the SDK *would* have requested. This exact snippet has been run against `twilio@5.10.6` and produces the output below.

Write it to a scratch file **in the project root** (so `require('twilio')` resolves), run it, then delete it:

```bash
cat > ./probe-tmp.js <<'EOF'
const oauth = require('./assets/twilio-oauth.private.js');
const creds = {
  accountSid: 'AC' + '0'.repeat(30) + '01',
  clientId: 'fake-id',
  clientSecret: 'fake-secret',
};
const { client, authStrategy } = oauth.createOAuthClient(creds);

// Stub the request layer so nothing leaves the machine.
client.request = async (opts) => { console.log(opts.uri); return { statusCode: 200, body: {} }; };

// The stub body cannot be deserialised into real resources; only the URI matters.
const show = async (fn) => { try { await fn(); } catch (e) { /* expected */ } };

(async () => {
  await show(() => client.messages.create({ to: '+15005550006', from: '+15005550006', body: 'x' }));
  await show(() => client.incomingPhoneNumbers.list({ limit: 1 }));
  await show(() => client.messages('SM' + '0'.repeat(32)).fetch());
  await show(() => client.content.v1.contents.list({ limit: 1 }));
  console.log('memoised:', client.credentialProvider.toAuthStrategy() === authStrategy);
})();
EOF
node ./probe-tmp.js; rm -f ./probe-tmp.js
```

Expected — four URIs, the first three carrying the Account SID, and `memoised: true`:

```
https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000001/Messages.json
https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000001/IncomingPhoneNumbers.json
https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000001/Messages/SM00000000000000000000000000000000.json
https://content.twilio.com/v1/Content
memoised: true
```

If any URI contains `Accounts//`, the `setAccountSid()` call is missing or is in the wrong order — fix it before continuing.

- [ ] **Step 3: Verify `credsFrom` rejects missing fields with status 400**

Run:

```bash
node -e "
const oauth = require('./assets/twilio-oauth.private.js');
try { oauth.credsFrom({ clientId: 'a' }); } catch (e) { console.log(e.statusCode, '|', e.message); }
try { oauth.credsFrom({ accountSid: 'AC1', clientId: 'a', clientSecret: 'b' }); console.log('ok: all three accepted'); } catch (e) { console.log('UNEXPECTED', e.message); }
console.log(oauth.ownerKeyFor({ clientId: 'CL123' }));
"
```

Expected:

```
400 | Account SID, OAuth Client Secret are required.
ok: all three accepted
oauth:CL123
```

- [ ] **Step 4: Commit**

```bash
git add assets/twilio-oauth.private.js
git commit -m "feat: add shared OAuth credential helper as a private asset"
```

---

### Task 2: `POST /verify`, and delete `/auth`

**Files:**
- Create: `functions/verify.js`
- Delete: `functions/auth.js`

- [ ] **Step 1: Create `functions/verify.js`**

```js
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

/**
 * Rejects if `promise` outlives `ms`. The SDK client has no request deadline of
 * its own (30s default, plus up to three retries on a 429), so without this the
 * platform can kill the invocation mid-probe and the user sees an opaque
 * timeout instead of the message below.
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
    await withDeadline(
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
```

- [ ] **Step 2: Delete `functions/auth.js`**

This removes the Sync credential store and the 1-hour TTL session model. Sessions now last as long as the browser tab.

```bash
git rm functions/auth.js
```

- [ ] **Step 3: Verify syntax and that no credential store remains in `verify.js`**

Run:

```bash
node --check functions/verify.js && echo "syntax OK"
grep -n "credentials_\|documents.create\|authToken\|apiSecret" functions/verify.js || echo "no credential store: OK"
test ! -f functions/auth.js && echo "auth.js deleted: OK"
```

Expected:

```
syntax OK
no credential store: OK
auth.js deleted: OK
```

Any printed line from the `grep` means `verify.js` still persists something. Remove it — the whole point of this task is that nothing is written down.

- [ ] **Step 4: Commit**

```bash
git add functions/verify.js
git commit -m "feat: replace /auth with /verify, removing the Sync credential store"
```

---

### Task 3: `get-phone-numbers` → OAuth + POST

The simplest of the six data functions. Do it next to establish the pattern the following four tasks repeat.

**Files:**
- Modify: `functions/get-phone-numbers.js` (replace the whole file)

- [ ] **Step 1: Replace the whole of `functions/get-phone-numbers.js`**

The `getOrCreateSyncService` function at the bottom goes away with the rest — this function only ever touched Sync to read credentials.

```js
/**
 * POST /get-phone-numbers — SMS-enabled numbers on the caller's own account.
 */

const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  let client;
  try {
    client = await oauth.authenticate(oauth.credsFrom(event));
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
    const phoneNumbers = await client.incomingPhoneNumbers.list({ limit: 100 });

    const smsNumbers = phoneNumbers
      .filter(number => {
        const capabilities = number.capabilities || {};
        return capabilities.sms === true || capabilities.sms === 'true';
      })
      .map(number => ({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName || number.phoneNumber,
        sid: number.sid,
        capabilities: number.capabilities
      }));

    response.setStatusCode(200);
    response.setBody({
      success: true,
      phoneNumbers: smsNumbers
    });

    return callback(null, response);
  } catch (error) {
    console.error('Get phone numbers error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to fetch phone numbers',
      message: error.message
    });
    return callback(null, response);
  }
};
```

- [ ] **Step 2: Verify**

Run:

```bash
node --check functions/get-phone-numbers.js && echo "syntax OK"
grep -n "sessionId\|credentials_\|getOrCreateSyncService" functions/get-phone-numbers.js || echo "clean: OK"
```

Expected:

```
syntax OK
clean: OK
```

- [ ] **Step 3: Commit**

```bash
git add functions/get-phone-numbers.js
git commit -m "refactor: authenticate get-phone-numbers with OAuth over POST"
```

---

### Task 4: `get-content-templates` → OAuth + POST

Only the credential block and the CORS method change. **Every line of template-filtering logic below it is preserved as-is** — the `contentAndApprovals` choice, the `RCS_CAPABLE_TYPES` list, and the `verify_auto_created` exclusion are all deliberate.

**Files:**
- Modify: `functions/get-content-templates.js:1-58` (header + credential block)
- Modify: `functions/get-content-templates.js:198-225` (remove `getOrCreateSyncService`)

- [ ] **Step 1: Replace lines 1 through 58 — everything from `const twilio` down to the end of the credential block**

Replace this:

```js
const twilio = require('twilio');

/**
 * Get content templates for WhatsApp, RCS, and other supported channels
 */
exports.handler = async function(context, event, callback) {
```

…through the `} else { throw new Error('Invalid credentials'); }` block that ends at line 58, with:

```js
/**
 * POST /get-content-templates — content templates for WhatsApp and RCS.
 */

const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const channel = event.channel;

  if (!channel) {
    console.warn('No channel parameter provided');
    response.setStatusCode(200);
    response.setBody({
      success: true,
      templates: [],
      message: 'No channel specified. Content templates require a channel parameter.'
    });
    return callback(null, response);
  }

  let client;
  try {
    client = await oauth.authenticate(oauth.credsFrom(event));
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
```

The channel check now runs **before** authentication, because it needs no credentials.

Note that `try {` on the last line replaces the original `try {` from line 17 — the resulting file must still have exactly one `try` opening the block whose `catch (error)` sits at the old line 177 (`console.error('Get content templates error:', error)`). Verify the brace balance in Step 3.

- [ ] **Step 2: Delete the now-unused `getOrCreateSyncService` function**

Delete the whole function at the bottom of the file — from `async function getOrCreateSyncService(client) {` to its closing `}`. Keep `isNotVerifyAutoCreated`, which is still used.

- [ ] **Step 3: Verify syntax, brace balance, and that the template logic survived**

Run:

```bash
node --check functions/get-content-templates.js && echo "syntax OK"
grep -c "contentAndApprovals\|RCS_CAPABLE_TYPES\|verify_auto_created" functions/get-content-templates.js
grep -n "sessionId\|credentials_\|getOrCreateSyncService\|require('twilio')" functions/get-content-templates.js || echo "clean: OK"
```

Expected — `syntax OK` proves the braces balance, and `5` proves the three preserved decisions are still present (`grep -c` counts *lines*: `contentAndApprovals` on 1, `RCS_CAPABLE_TYPES` on 2, `verify_auto_created` on 2):

```
syntax OK
5
clean: OK
```

- [ ] **Step 4: Confirm the missing-scope path stays soft**

If the OAuth app lacks Content read scope, `oauth.authenticate()` still *succeeds* — a token fetch does not depend on scopes. The failure surfaces from `contentAndApprovals.list`.

Trace it precisely, because there are two catches and the outer one is **not** the one that fires:

- Each channel branch has its own **inner** `catch` (lines ~80-84 for WhatsApp, ~132-136 for RCS). These answer **HTTP 200** with `{ success: false, templates: [], error: 'Failed to fetch WhatsApp templates: …' }`.
- The outer `catch` at the bottom answers HTTP 500, but only for a failure the inner catches do not cover — a bug in the mapping code, say.

So a scope gap produces a **200, not a 500**. `assets/app.js:269` gates on `response.ok && data.success !== false`, and `success: false` fails that test, so it takes the **else** branch (lines ~287-298): the dropdown falls back to `"None (Use custom message)"`, a disabled option shows the error text, and `#content-template-help` turns red. The channel stays usable with a literal message body.

That is the fail-soft behaviour the spec requires — **do not add error handling here, and do not "fix" the inner catches to return 500**. It already works, and it works because these branches exist. Note that a `curl` against this endpoint with a scope gap returns 200; do not read that as success.

Read that branch before Task 10 so you do not accidentally simplify it away when converting the fetch to a POST.

- [ ] **Step 5: Commit**

```bash
git add functions/get-content-templates.js
git commit -m "refactor: authenticate get-content-templates with OAuth over POST"
```

---

### Task 5: `list-campaigns` → OAuth + POST + `ownerKey` filter

**Files:**
- Modify: `functions/list-campaigns.js` (replace the whole file)

- [ ] **Step 1: Replace the whole of `functions/list-campaigns.js`**

```js
/**
 * POST /list-campaigns — campaigns belonging to the calling OAuth app.
 */

const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

exports.handler = async function(context, event, callback) {
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
    // This function makes no call against the user's own account — it only
    // reads Sync through the runtime client. It authenticates anyway, because
    // the ownerKey filter below rests on the caller actually holding the Client
    // ID they sent, and only a successful token exchange establishes that.
    // Skipping this would let anyone list another app's campaigns by sending
    // its Client ID with any secret.
    await oauth.authenticate(creds);
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  const ownerKey = oauth.ownerKeyFor(creds);

  try {
    // The runtime client is used for Sync only, never for the user's account.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    const documents = await syncClient.documents.list({ limit: 1000 });

    const campaigns = [];
    for (const doc of documents) {
      if (!doc.uniqueName || !doc.uniqueName.startsWith('campaign_')) {
        continue;
      }

      const campaignData = doc.data;

      // Campaigns are owned by the OAuth app that created them. Documents
      // written before this migration carry no ownerKey and are never listed.
      // `!campaignData` guard so one malformed document skips itself rather than
      // throwing and turning the caller's whole campaign list into a 500. Same
      // shape as the checks in check-status.js and resume-execution.js.
      if (!campaignData || campaignData.ownerKey !== ownerKey) {
        continue;
      }

      let delivered = 0;
      let read = 0;
      const statuses = campaignData.statuses || {};

      for (const statusInfo of Object.values(statuses)) {
        if (statusInfo.delivered || statusInfo.status === 'delivered') {
          delivered++;
        }
        if (statusInfo.read || statusInfo.status === 'read') {
          read++;
        }
      }

      campaigns.push({
        campaignId: doc.uniqueName,
        accountSid: campaignData.accountSid,
        totalMessages: campaignData.totalMessages || 0,
        sent: campaignData.sent || 0,
        failed: campaignData.failed || 0,
        pending: campaignData.pending || 0,
        delivered: campaignData.delivered || delivered,
        read: campaignData.read || read,
        startIndex: campaignData.startIndex || 0,
        isComplete: (campaignData.startIndex || 0) >= (campaignData.totalMessages || 0),
        createdAt: campaignData.createdAt,
        lastUpdated: campaignData.lastUpdated,
        campaignName: campaignData.campaignName || null
      });
    }

    // Sort by creation date (newest first)
    campaigns.sort((a, b) => {
      const dateA = new Date(a.createdAt || 0);
      const dateB = new Date(b.createdAt || 0);
      return dateB - dateA;
    });

    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaigns,
      count: campaigns.length
    });

    return callback(null, response);
  } catch (error) {
    console.error('List campaigns error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to list campaigns',
      message: error.message
    });
    return callback(null, response);
  }
};
```

- [ ] **Step 2: Verify**

Run:

```bash
node --check functions/list-campaigns.js && echo "syntax OK"
grep -c "oauth.authenticate" functions/list-campaigns.js
grep -n "campaignData.accountSid === accountSid\|sessionId\|credentials_" functions/list-campaigns.js || echo "clean: OK"
```

Expected — the `1` matters: it proves the token fetch was not optimised away.

```
syntax OK
1
clean: OK
```

- [ ] **Step 3: Commit**

```bash
git add functions/list-campaigns.js
git commit -m "refactor: filter campaigns by proven OAuth ownerKey over POST"
```

---

### Task 6: `check-status` → OAuth + POST + ownership check

**Files:**
- Modify: `functions/check-status.js:1-48` (header, credential block, campaign fetch)
- Modify: `functions/check-status.js:132-159` (remove `getOrCreateSyncService`)

- [ ] **Step 1: Replace lines 1 through 48 — from `const twilio` down to and including `const campaignData = campaignDoc.data;`**

```js
/**
 * POST /check-status — campaign status, with per-message status refreshed
 * from Twilio.
 */

const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const campaignId = event.campaignId;

  if (!campaignId) {
    response.setStatusCode(400);
    response.setBody({ error: 'campaignId is required' });
    return callback(null, response);
  }

  let creds;
  let client;
  try {
    creds = oauth.credsFrom(event);
    client = await oauth.authenticate(creds);
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
    // The runtime client is used for Sync only, never for the user's account.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    // Campaign IDs are `campaign_<timestamp>`, so they are guessable rather
    // than secret. Answer 404 both when the document is absent and when it
    // belongs to someone else — a 403 would confirm that a guessed ID exists.
    let campaignData = null;
    try {
      const campaignDoc = await syncClient.documents(campaignId).fetch();
      campaignData = campaignDoc.data;
    } catch (error) {
      // 20404 is "document not found"; anything else is a real failure.
      if (error.status !== 404 && error.code !== 20404) {
        throw error;
      }
    }

    if (!campaignData || campaignData.ownerKey !== oauth.ownerKeyFor(creds)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }
```

Everything from the original line 50 onward (`// Update message statuses from Twilio`) stays exactly as it is.

- [ ] **Step 2: Delete the now-unused `getOrCreateSyncService` function**

Delete the whole function at the bottom of the file, from `async function getOrCreateSyncService(client) {` to its closing `}`.

- [ ] **Step 3: Verify**

Run:

```bash
node --check functions/check-status.js && echo "syntax OK"
grep -c "404" functions/check-status.js
grep -n "sessionId\|credentials_\|function getOrCreateSyncService" functions/check-status.js || echo "clean: OK"
```

Expected — `syntax OK`, `4` lines mentioning `404`, and a clean grep. `grep -c` counts *lines*: the `error.status !== 404 && error.code !== 20404` guard, the `setStatusCode(404)`, and the two explanatory comments that also happen to contain "404":

```
syntax OK
4
clean: OK
```

- [ ] **Step 4: Commit**

```bash
git add functions/check-status.js
git commit -m "refactor: authenticate check-status with OAuth and 404 non-owners"
```

---

### Task 7: `send-messages` → OAuth + write `ownerKey`

The send loop itself — chunking, the 9-second budget, `retryWithExponentialBackoff`, the per-channel `messageParams` handling — is **not** touched. Only the credential block and the campaign-document handling change.

**Files:**
- Modify: `functions/send-messages.js:1` (add the helper require)
- Modify: `functions/send-messages.js:71-106` (destructure, validation, credentials)
- Modify: `functions/send-messages.js:108-155` (campaign document create/fetch)
- Modify: `functions/send-messages.js:327-354` (remove `getOrCreateSyncService`)

- [ ] **Step 1: Add the helper require at the top of the file**

Replace line 1:

```js
const twilio = require('twilio');
```

with:

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
```

`twilio` is still needed here — it builds the runtime client for Sync.

- [ ] **Step 2: Replace the destructure, validation and credential block (lines 71-106)**

Replace everything from `  try {` (line 71) through the closing `}` of the `else { throw new Error('Invalid credentials'); }` block (line 106) with:

```js
  try {
    const {
      messages,
      campaignId,
      channel = 'sms',
      from,
      resumeFrom = 0,
      campaignName
    } = event;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      response.setStatusCode(400);
      response.setBody({ error: 'messages array is required' });
      return callback(null, response);
    }

    let creds;
    let client;
    try {
      creds = oauth.credsFrom(event);
      client = await oauth.authenticate(creds);
    } catch (error) {
      response.setStatusCode(error.statusCode || 401);
      response.setBody({ error: error.message });
      return callback(null, response);
    }

    const ownerKey = oauth.ownerKeyFor(creds);

    // The runtime client is used for Sync only, never for the user's account.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);
```

Authenticating up front means bad credentials cost one clear 401 rather than the same error once per message in a 100-message chunk.

- [ ] **Step 3: Replace the campaign document block (lines 108-155)**

Replace everything from `    // Get or create campaign document in Sync` through the end of the `if (campaignName && !campaignDoc.data.campaignName) { ... }` block with:

```js
    // Get or create the campaign document in Sync.
    const campaignDocName = campaignId || `campaign_${Date.now()}`;
    let campaignDoc = null;
    try {
      campaignDoc = await syncClient.documents(campaignDocName).fetch();
    } catch (error) {
      // 20404 is "document not found"; anything else is a real failure.
      if (error.status !== 404 && error.code !== 20404) {
        throw error;
      }
    }

    if (campaignDoc) {
      // An existing campaign may only be added to by the OAuth app that created
      // it. 404 rather than 403, so a guessed campaign ID is not confirmed to
      // exist. Documents predating this migration have no ownerKey and so fail
      // this check, consistent with their absence from the campaign list.
      // Same `!data` guard as list-campaigns.js and check-status.js — a document
      // with no data must fail the ownership check, not throw.
      if (!campaignDoc.data || campaignDoc.data.ownerKey !== ownerKey) {
        response.setStatusCode(404);
        response.setBody({ error: 'Campaign not found' });
        return callback(null, response);
      }
    } else {
      campaignDoc = await syncClient.documents.create({
        uniqueName: campaignDocName,
        data: {
          ownerKey,
          accountSid: creds.accountSid, // display only; never an authorization key
          totalMessages: messages.length,
          sent: 0,
          failed: 0,
          pending: messages.length,
          statuses: {},
          startIndex: resumeFrom,
          messages: messages, // stored so the campaign can be resumed
          channel: channel,
          from: from,
          campaignName: campaignName || null,
          createdAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        }
      });
    }

    // Backfill resume metadata on campaigns created before it was stored.
    if (!campaignDoc.data.messages && resumeFrom === 0) {
      campaignDoc.data.messages = messages;
      campaignDoc.data.channel = channel;
      campaignDoc.data.from = from;
    }

    // Update campaign name if provided and not already set
    if (campaignName && !campaignDoc.data.campaignName) {
      campaignDoc.data.campaignName = campaignName;
      await syncClient.documents(campaignDocName).update({
        data: campaignDoc.data
      });
    }
```

Two things went away deliberately: the `if (!campaignDoc.data.accountSid)` backfill, because `ownerKey` is now the authoritative field and `accountSid` is display-only; and the pattern of creating the document from inside a bare `catch`, which swallowed real Sync failures as "not found".

- [ ] **Step 4: Delete the now-unused `getOrCreateSyncService` function**

Delete the whole function at the bottom of the file, from `async function getOrCreateSyncService(client) {` to its closing `}`. Keep `retryWithExponentialBackoff`.

- [ ] **Step 5: Verify**

Run:

```bash
node --check functions/send-messages.js && echo "syntax OK"
grep -c "ownerKey" functions/send-messages.js
grep -c "retryWithExponentialBackoff" functions/send-messages.js
grep -n "sessionId\|credentials_\|function getOrCreateSyncService" functions/send-messages.js || echo "clean: OK"
```

Expected — `4` lines mentioning `ownerKey` (the `const`, the explanatory comment, the `!==` comparison, and the field in `documents.create`), and `2` mentioning `retryWithExponentialBackoff` (its declaration and its call site) proving the send loop is intact. Task 7 adds no new uses of the latter; if it reads anything but `2`, the send loop was touched:

```
syntax OK
4
2
clean: OK
```

If the `ownerKey` count differs, check you have all of: the `const ownerKey =` assignment, the `!==` comparison, and the `ownerKey,` field in the create payload.

- [ ] **Step 6: Commit**

```bash
git add functions/send-messages.js
git commit -m "refactor: authenticate send-messages with OAuth and stamp campaign ownerKey"
```

---

### Task 8: `resume-execution` → OAuth, ownership check, and the `isComplete` bug fix

This file gets replaced wholesale rather than patched. Both the handler and `sendMessagesChunk` change shape: authentication and the Sync client move up into the handler and are passed down, instead of each re-fetching credentials.

**The bug being fixed:** the old line 272 returns `hasMore: !isComplete`, but `isComplete` is never declared in `sendMessagesChunk`'s scope — a `ReferenceError` on **every** resume. The fix hoists it into a `const` computed the same way as the line above it.

**Files:**
- Modify: `functions/resume-execution.js` (replace the whole file)

- [ ] **Step 1: Confirm the bug exists before fixing it**

Run:

```bash
grep -n "isComplete" functions/resume-execution.js
```

Expected — `isComplete` is *read* on line 272 but never declared anywhere in the file:

```
271:    isComplete: currentIndex >= messages.length,
272:    hasMore: !isComplete,
```

- [ ] **Step 2: Replace the whole of `functions/resume-execution.js`**

```js
const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

/**
 * POST /resume-execution — sends the next chunk of an existing campaign.
 *
 * The caller re-supplies the messages array; the server never resumes a
 * campaign on its own. That is what makes it safe for credentials to live in
 * the browser rather than server-side. See
 * docs/superpowers/specs/2026-08-07-oauth-login-design.md
 */

/**
 * Retry function with exponential backoff for 429 rate limit errors
 * @param {Function} fn - The async function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries (default: 5)
 * @param {number} options.baseDelay - Base delay in milliseconds (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in milliseconds (default: 30000)
 * @returns {Promise} - The result of the function
 */
async function retryWithExponentialBackoff(fn, options = {}) {
  const {
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 30000
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Only retry on 429 (rate limit) errors
      const isRateLimit = error.status === 429 ||
                         error.code === 20429 ||
                         (error.message && error.message.toLowerCase().includes('rate limit'));

      if (!isRateLimit || attempt === maxRetries) {
        throw error;
      }

      // Calculate exponential backoff delay
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

      // Add jitter to prevent thundering herd
      const jitter = Math.random() * 0.3 * delay; // Up to 30% jitter
      const totalDelay = delay + jitter;

      console.log(`Rate limit (429) encountered. Retrying in ${Math.round(totalDelay)}ms (attempt ${attempt + 1}/${maxRetries})`);

      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }

  throw lastError;
}

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const { campaignId, messages, channel, from } = event;

  if (!campaignId || !messages || !Array.isArray(messages)) {
    response.setStatusCode(400);
    response.setBody({ error: 'campaignId and a messages array are required' });
    return callback(null, response);
  }

  let creds;
  let client;
  try {
    creds = oauth.credsFrom(event);
    client = await oauth.authenticate(creds);
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
    // The runtime client is used for Sync only, never for the user's account.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    // Campaign IDs are `campaign_<timestamp>`, so they are guessable rather
    // than secret. Answer 404 both when the document is absent and when it
    // belongs to someone else — a 403 would confirm that a guessed ID exists.
    let campaignData = null;
    try {
      const campaignDoc = await syncClient.documents(campaignId).fetch();
      campaignData = campaignDoc.data;
    } catch (error) {
      // 20404 is "document not found"; anything else is a real failure.
      if (error.status !== 404 && error.code !== 20404) {
        throw error;
      }
    }

    if (!campaignData || campaignData.ownerKey !== oauth.ownerKeyFor(creds)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    const result = await sendMessagesChunk({
      context,
      client,
      syncClient,
      campaignId,
      campaignData,
      messages,
      channel,
      from,
      resumeFrom: campaignData.startIndex || 0
    });

    response.setStatusCode(200);
    response.setBody(result);

    return callback(null, response);
  } catch (error) {
    console.error('Resume execution error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to resume execution',
      message: error.message
    });
    return callback(null, response);
  }
};

async function sendMessagesChunk(params) {
  const {
    context,
    client,
    syncClient,
    campaignId,
    campaignData,
    messages,
    channel,
    from,
    resumeFrom
  } = params;

  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000;
  const CHUNK_SIZE = 100; // Process 100 messages at a time for full-speed sending

  let currentIndex = resumeFrom;
  const results = [];
  let hasMore = true;

  // Use DOMAIN_NAME environment variable for webhook URL (default Twilio env var)
  const webhookUrl = `https://${context.DOMAIN_NAME}/webhook`;

  while (hasMore && (Date.now() - startTime) < MAX_EXECUTION_TIME) {
    const chunk = messages.slice(currentIndex, currentIndex + CHUNK_SIZE);

    if (chunk.length === 0) {
      hasMore = false;
      break;
    }

    const chunkPromises = chunk.map(async (message, idx) => {
      const actualIndex = currentIndex + idx;
      try {
        const messageParams = {
          to: message.to,
          from: message.from || from,
          statusCallback: webhookUrl
        };

        // Add body if provided (not required when using content template)
        if (message.body) {
          messageParams.body = message.body;
        }

        // Add content template if provided (for WhatsApp/RCS)
        if (message.contentSid) {
          messageParams.contentSid = message.contentSid;
        }

        if (channel === 'whatsapp') {
          messageParams.from = `whatsapp:${messageParams.from}`;
          messageParams.to = `whatsapp:${messageParams.to}`;
        } else if (channel === 'messenger') {
          messageParams.messagingServiceSid = message.messagingServiceSid || context.MESSAGING_SERVICE_SID;
        } else if (channel === 'mms') {
          // MMS uses the same API as SMS but can include media
          // Media URLs can be added via message.mediaUrl if provided
          if (message.mediaUrl) {
            messageParams.mediaUrl = Array.isArray(message.mediaUrl) ? message.mediaUrl : [message.mediaUrl];
          }
        } else if (channel === 'rcs') {
          // RCS uses the same API as SMS/MMS
          // RCS-specific features can be added here if needed
          if (message.mediaUrl) {
            messageParams.mediaUrl = Array.isArray(message.mediaUrl) ? message.mediaUrl : [message.mediaUrl];
          }
          // RCS can also use content templates
          if (message.contentSid) {
            messageParams.contentSid = message.contentSid;
          }
        }

        // Use retry with exponential backoff for rate limit errors
        const twilioMessage = await retryWithExponentialBackoff(
          () => client.messages.create(messageParams),
          {
            maxRetries: 5,
            baseDelay: 1000,
            maxDelay: 30000
          }
        );

        return {
          index: actualIndex,
          success: true,
          sid: twilioMessage.sid,
          status: twilioMessage.status,
          to: message.to
        };
      } catch (error) {
        return {
          index: actualIndex,
          success: false,
          error: error.message,
          errorCode: error.code || error.status,
          to: message.to
        };
      }
    });

    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);

    let sent = campaignData.sent || 0;
    let failed = campaignData.failed || 0;

    chunkResults.forEach(result => {
      if (result.success) {
        sent++;
        campaignData.statuses[result.sid] = {
          status: result.status,
          to: result.to,
          sentAt: new Date().toISOString()
        };
      } else {
        failed++;
      }
    });

    currentIndex += chunk.length;
    campaignData.sent = sent;
    campaignData.failed = failed;
    campaignData.pending = campaignData.totalMessages - sent - failed;
    campaignData.startIndex = currentIndex;
    campaignData.lastUpdated = new Date().toISOString();

    await syncClient.documents(campaignId).update({
      data: campaignData
    });

    if (currentIndex >= messages.length) {
      hasMore = false;
    }
  }

  // Declared once and used twice. Previously `hasMore: !isComplete` referenced
  // an undeclared binding, throwing a ReferenceError on every resume.
  const isComplete = currentIndex >= messages.length;

  return {
    success: true,
    campaignId,
    processed: currentIndex - resumeFrom,
    totalProcessed: currentIndex,
    totalMessages: messages.length,
    isComplete,
    hasMore: !isComplete,
    resumeFrom: currentIndex,
    results: results.slice(-CHUNK_SIZE),
    stats: {
      sent: campaignData.sent,
      failed: campaignData.failed,
      pending: campaignData.pending
    }
  };
}
```

- [ ] **Step 3: Verify the bug is fixed and nothing references an undeclared binding**

Run:

```bash
node --check functions/resume-execution.js && echo "syntax OK"
grep -n "const isComplete" functions/resume-execution.js
grep -n "sessionId\|credentials_\|function getOrCreateSyncService" functions/resume-execution.js || echo "clean: OK"
```

Expected — the `const isComplete` declaration now exists:

```
syntax OK
<line>:  const isComplete = currentIndex >= messages.length;
clean: OK
```

- [ ] **Step 4: Verify the module loads with its private-asset require resolved**

`sendMessagesChunk` is module-private, so the return path cannot be called directly from outside. What *can* be checked locally is that the module and its `Runtime.getAssets()` require resolve — the failure mode that would otherwise only appear after a deploy.

```bash
cat > ./probe-tmp.js <<'EOF'
// Stub the two globals Twilio Functions inject before requiring a Function.
global.Runtime = {
  getAssets: () => ({ '/twilio-oauth.js': { path: './assets/twilio-oauth.private.js' } }),
};
global.Twilio = { Response: class {} };

const mod = require('./functions/resume-execution.js');
console.log('handler exported:', typeof mod.handler === 'function');
EOF
node ./probe-tmp.js; rm -f ./probe-tmp.js
```

Expected:

```
handler exported: true
```

Run the same probe against each of the other five modified Functions by swapping the filename — a typo in the asset key (`'/twilio-oauth.js'` vs `'/twilio-oauth.private.js'`) throws here rather than in production.

The `ReferenceError` itself is proven gone by **Task 12 Step 10**, which resumes a real multi-invocation campaign. A stub cannot substitute for that.

- [ ] **Step 5: Commit**

```bash
git add functions/resume-execution.js
git commit -m "fix: declare isComplete in resume-execution and authenticate with OAuth"
```

---

### Task 9: The three-field login form

**Files:**
- Modify: `assets/index.html:19-56` (the `.login-form` block)

- [ ] **Step 1: Replace the login form**

Replace lines 19 through 56 — from `<div class="login-form">` through its closing `</div>` after `#login-error` — with:

```html
                <div class="login-form">
                    <h2>Sign In</h2>
                    <p class="login-help">
                        Sign in with an account-level
                        <a href="https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps"
                           target="_blank" rel="noopener">OAuth app</a>.
                        It needs the Messaging and Phone Numbers scopes.
                    </p>

                    <form id="login-form">
                        <div class="form-group">
                            <label for="account-sid">Account SID</label>
                            <input type="text" id="account-sid" required
                                   placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
                            <small>Public identifier, shown on your Console dashboard.</small>
                        </div>
                        <div class="form-group">
                            <label for="client-id">OAuth Client ID</label>
                            <input type="text" id="client-id" required
                                   placeholder="Your OAuth app's Client ID">
                        </div>
                        <div class="form-group">
                            <label for="client-secret">OAuth Client Secret</label>
                            <input type="password" id="client-secret" required
                                   placeholder="Your OAuth app's Client Secret">
                        </div>

                        <button type="submit" class="btn btn-primary" id="login-btn">Sign In</button>
                    </form>
                    <div id="login-error" class="error-message"></div>
                </div>
```

The `.auth-method-tabs` element and both `.auth-section` blocks are gone, along with the `#auth-token`, `#api-account-sid`, `#api-key` and `#api-secret` inputs.

- [ ] **Step 2: Add a style rule for the new help paragraph**

Append to `assets/styles.css`:

Both custom properties are already defined in the `:root` block at the top of the file (lines 10 and 18).

```css
.login-help {
    margin: 0 0 20px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--twilio-gray-600);
}

.login-help a {
    color: var(--twilio-blue);
}
```

- [ ] **Step 3: Verify no stale field IDs remain**

Run:

```bash
grep -n "auth-method-tabs\|auth-section\|auth-token\|api-account-sid\|api-key\|api-secret" assets/index.html || echo "old auth fields gone: OK"
grep -c "id=\"account-sid\"\|id=\"client-id\"\|id=\"client-secret\"" assets/index.html
```

Expected:

```
old auth fields gone: OK
3
```

- [ ] **Step 4: Commit**

```bash
git add assets/index.html assets/styles.css
git commit -m "feat: replace the login form with three OAuth fields"
```

---

### Task 10: `app.js` — `sessionStorage` credentials and one POST helper

Sixteen edits, given as exact replace-pairs. Work through them in order; the line numbers are from the pre-edit file and will drift as you go, so match on the code, not the number.

The new `postToFunction()` helper collapses all eight data-call sites. Apply Edit 3 (which adds it) before Edits 9-16 (which use it).

**Files:**
- Modify: `assets/app.js`

- [ ] **Step 1: Edit 1 — replace the state block (lines 4-6)**

Find:

```js
// State
let sessionId = null;
let currentCampaignId = null;
```

Replace with:

```js
// State
const CREDS_KEY = 'twilio_messaging_oauth';

/** { accountSid, clientId, clientSecret }, or null when signed out. */
let creds = null;
let currentCampaignId = null;
```

- [ ] **Step 2: Edit 2 — restore the session from `sessionStorage` (lines 17-24)**

Find:

```js
function initializeApp() {
    // Check if already logged in
    sessionId = localStorage.getItem('twilio_session_id');
    if (sessionId) {
        showAppScreen();
    } else {
        showLoginScreen();
    }
```

Replace with:

```js
function initializeApp() {
    // Restore the session if this tab already holds credentials. They are not
    // re-verified here, so a rotated secret surfaces on the first action rather
    // than at page load.
    creds = loadCreds();
    if (creds) {
        showAppScreen();
    } else {
        showLoginScreen();
    }
```

- [ ] **Step 3: Edit 3 — add the credential helpers and the POST helper**

Insert this block immediately **before** `function setupEventListeners() {`:

```js
// --- Credentials -----------------------------------------------------------
// sessionStorage rather than localStorage: an OAuth Client Secret should not
// outlive the tab or persist to disk. It is still readable by JavaScript on
// this origin — see docs/superpowers/specs/2026-08-07-oauth-login-design.md
// § Security properties.

function loadCreds() {
    try {
        const raw = sessionStorage.getItem(CREDS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.accountSid && parsed.clientId && parsed.clientSecret) {
            return parsed;
        }
    } catch (error) {
        console.warn('Discarding unreadable stored credentials:', error);
    }
    sessionStorage.removeItem(CREDS_KEY);
    return null;
}

function saveCreds(next) {
    creds = next;
    sessionStorage.setItem(CREDS_KEY, JSON.stringify(next));
}

function clearCreds() {
    creds = null;
    sessionStorage.removeItem(CREDS_KEY);
}

/**
 * Calls a Function with the credentials in the JSON body. Never a query string:
 * a Client Secret there would be recorded in request logs and browser history.
 */
async function postToFunction(path, body = {}) {
    return fetch(`${FUNCTIONS_BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...creds, ...body })
    });
}

```

- [ ] **Step 4: Edit 4 — drop the auth-method tab listeners (lines 52-62)**

Find:

```js
function setupEventListeners() {
    // Auth method tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const method = e.target.dataset.method;
            switchAuthMethod(method);
        });
    });

    // Login form
```

Replace with:

```js
function setupEventListeners() {
    // Login form
```

- [ ] **Step 5: Edit 5 — delete `switchAuthMethod` entirely (lines 94-125)**

Delete the whole function, from `function switchAuthMethod(method) {` through its closing `}`. There is now only one auth method, so there is nothing to switch between.

- [ ] **Step 6: Edit 6 — replace `handleLogin` (lines 127-171)**

Find the whole of `async function handleLogin(e) { ... }` and replace with:

```js
async function handleLogin(e) {
    e.preventDefault();
    const errorDiv = document.getElementById('login-error');
    const loginBtn = document.getElementById('login-btn');
    errorDiv.classList.remove('show');
    errorDiv.textContent = '';

    const candidate = {
        accountSid: document.getElementById('account-sid').value.trim(),
        clientId: document.getElementById('client-id').value.trim(),
        clientSecret: document.getElementById('client-secret').value.trim()
    };

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';

    try {
        const response = await fetch(`${FUNCTIONS_BASE_URL}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(candidate)
        });

        const data = await response.json();

        // /verify answers HTTP 200 with valid:false for a credential rejection,
        // so "rejected" is told apart from "transport failed" by `valid`, not by
        // status.
        if (!data.valid) {
            throw new Error(data.error || 'Verification failed.');
        }

        saveCreds(candidate);
        showAppScreen();
    } catch (error) {
        errorDiv.textContent = error.message;
        errorDiv.classList.add('show');
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Sign In';
    }
}
```

- [ ] **Step 7: Edit 7 — replace `handleLogout` (lines 173-186)**

Find:

```js
function handleLogout() {
    sessionId = null;
    currentCampaignId = null;
    localStorage.removeItem('twilio_session_id');
```

Replace with:

```js
function handleLogout() {
    clearCreds();
    currentCampaignId = null;
```

Leave the two `clearInterval` blocks and the `showLoginScreen()` call below it untouched.

- [ ] **Step 8: Edit 8 — replace `showLoginScreen` (lines 188-195)**

Find:

```js
function showLoginScreen() {
    document.getElementById('app-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
    // Clear form
    document.getElementById('login-form').reset();
    // Reset to account auth method and update required attributes
    switchAuthMethod('account');
}
```

Replace with:

```js
function showLoginScreen() {
    document.getElementById('app-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
    // Clear the form so the Client Secret is not left sitting in a DOM node.
    document.getElementById('login-form').reset();
}
```

- [ ] **Step 9: Edit 9 — `loadPhoneNumbers` (lines 210-215)**

Find:

```js
async function loadPhoneNumbers() {
    if (!sessionId) return;

    try {
        const params = new URLSearchParams({ sessionId });
        const response = await fetch(`${FUNCTIONS_BASE_URL}/get-phone-numbers?${params.toString()}`);
        const data = await response.json();
```

Replace with:

```js
async function loadPhoneNumbers() {
    if (!creds) return;

    try {
        const response = await postToFunction('get-phone-numbers');
        const data = await response.json();
```

- [ ] **Step 10: Edit 10 — `handleChannelChange` guard (line 236)**

Find:

```js
async function handleChannelChange() {
    if (!sessionId) return;
```

Replace with:

```js
async function handleChannelChange() {
    if (!creds) return;
```

- [ ] **Step 11: Edit 11 — `handleChannelChange` fetch (lines 266-267)**

Find:

```js
        const params = new URLSearchParams({ sessionId, channel });
        const response = await fetch(`${FUNCTIONS_BASE_URL}/get-content-templates?${params.toString()}`);
```

Replace with:

```js
        const response = await postToFunction('get-content-templates', { channel });
```

- [ ] **Step 12: Edit 12 — `sendMessagesBatch` (lines 689-703)**

Find:

```js
            const response = await fetch(`${FUNCTIONS_BASE_URL}/send-messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sessionId,
                    messages,
                    campaignId: currentCampaignId,
                    channel,
                    from,
                    resumeFrom,
                    campaignName: campaignName || null
                })
            });
```

Replace with:

```js
            const response = await postToFunction('send-messages', {
                messages,
                campaignId: currentCampaignId,
                channel,
                from,
                resumeFrom,
                campaignName: campaignName || null
            });
```

This is the loop that re-sends credentials once per chunk iteration. That is a known and accepted property of the design, not an oversight — the server cannot continue a campaign on its own.

- [ ] **Step 13: Edit 13 — `checkCampaignStatus` (lines 743-753)**

Find:

```js
async function checkCampaignStatus() {
    if (!currentCampaignId || !sessionId) return;

    try {
        const params = new URLSearchParams({
            campaignId: currentCampaignId,
            sessionId: sessionId
        });
        const response = await fetch(
            `${FUNCTIONS_BASE_URL}/check-status?${params.toString()}`
        );
```

Replace with:

```js
async function checkCampaignStatus() {
    if (!currentCampaignId || !creds) return;

    try {
        const response = await postToFunction('check-status', {
            campaignId: currentCampaignId
        });
```

- [ ] **Step 14: Edit 14 — `resumeCampaignById`, three spots (lines 819, 833-837, 857-869)**

Find:

```js
async function resumeCampaignById(campaignId, event) {
    if (!sessionId) {
        alert('Please log in to resume campaigns');
        return;
    }
```

Replace with:

```js
async function resumeCampaignById(campaignId, event) {
    if (!creds) {
        alert('Please sign in to resume campaigns');
        return;
    }
```

Then find:

```js
        // Fetch campaign details including messages
        const params = new URLSearchParams({
            campaignId: campaignId,
            sessionId: sessionId
        });
        const response = await fetch(`${FUNCTIONS_BASE_URL}/check-status?${params.toString()}`);
        const data = await response.json();
```

Replace with:

```js
        // Fetch campaign details including messages
        const response = await postToFunction('check-status', { campaignId });
        const data = await response.json();
```

Then find:

```js
            const resumeResponse = await fetch(`${FUNCTIONS_BASE_URL}/resume-execution`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sessionId: sessionId,
                    campaignId: campaignId,
                    messages: campaign.messages,
                    channel: campaign.channel,
                    from: campaign.from
                })
            });
```

Replace with:

```js
            const resumeResponse = await postToFunction('resume-execution', {
                campaignId: campaignId,
                messages: campaign.messages,
                channel: campaign.channel,
                from: campaign.from
            });
```

- [ ] **Step 15: Edit 15 — `loadCampaigns` (lines 916-924)**

Find:

```js
async function loadCampaigns() {
    if (!sessionId) return;

    const campaignsContent = document.getElementById('campaigns-content');
    if (!campaignsContent) return;

    try {
        const params = new URLSearchParams({ sessionId });
        const response = await fetch(`${FUNCTIONS_BASE_URL}/list-campaigns?${params.toString()}`);
        const data = await response.json();
```

Replace with:

```js
async function loadCampaigns() {
    if (!creds) return;

    const campaignsContent = document.getElementById('campaigns-content');
    if (!campaignsContent) return;

    try {
        const response = await postToFunction('list-campaigns');
        const data = await response.json();
```

- [ ] **Step 16: Edit 16 — `fetchAndDisplayCampaignDetails` (lines 1039-1049) and `startStatusAutoRefresh` (line 1175)**

Find:

```js
async function fetchAndDisplayCampaignDetails(campaignId) {
    if (!sessionId) return;

    try {
        const params = new URLSearchParams({
            campaignId: campaignId,
            sessionId: sessionId
        });
        const response = await fetch(
            `${FUNCTIONS_BASE_URL}/check-status?${params.toString()}`
        );
```

Replace with:

```js
async function fetchAndDisplayCampaignDetails(campaignId) {
    if (!creds) return;

    try {
        const response = await postToFunction('check-status', { campaignId });
```

Then find:

```js
    if (currentCampaignId && sessionId) {
```

Replace with:

```js
    if (currentCampaignId && creds) {
```

- [ ] **Step 17: Verify every reference is migrated**

Run:

```bash
node --check assets/app.js && echo "syntax OK"
grep -n "sessionId\|localStorage\|switchAuthMethod\|URLSearchParams" assets/app.js || echo "fully migrated: OK"
grep -c "postToFunction(" assets/app.js
grep -c "sessionStorage" assets/app.js
```

Expected — `9` lines using `postToFunction` (one declaration plus eight call sites) and `4` using `sessionStorage` (`getItem` and `removeItem` in `loadCreds`, `setItem` in `saveCreds`, `removeItem` in `clearCreds`):

```
syntax OK
fully migrated: OK
9
4
```

If `grep` prints any `sessionId` or `URLSearchParams` line, an edit was missed. Every remaining `fetch(` in the file should be inside `postToFunction` or `handleLogin`:

```bash
grep -n "fetch(\`" assets/app.js
```

Expected exactly two lines — the `/verify` call and the one inside `postToFunction`.

- [ ] **Step 18: Commit**

```bash
git add assets/app.js
git commit -m "feat: hold OAuth credentials in sessionStorage and POST them per request"
```

---

### Task 11: Delete `twilio.json` and update the README

`twilio.json` is removed rather than edited. Nothing reads it: `twilio-run` discovers configuration through cosmiconfig under the module name `twilioserverless` (`~/.twilio-cli/node_modules/twilio-run/dist/config/utils/configLoader.js:9`), whose search paths are `package.json`, `.twilioserverlessrc[.json|.yaml|.yml|.js|.cjs]` and `twilioserverless.config.js` — `twilio.json` is not among them. Visibility comes from the filename instead (`.private.js` → `access = 'private'`, `@twilio-labs/serverless-api/dist/utils/fs.js:113`). The file is also already stale: it never listed `list-campaigns.js`, which deploys and works regardless.

**Files:**
- Delete: `twilio.json`
- Modify: `README.md` (lines 8, 12, 18, 96-100, 147-152, 154-171, 183-188, 205-210)

- [ ] **Step 1: Confirm nothing references the file, then delete it**

```bash
grep -rn "twilio\.json" --include="*.js" --include="*.json" --include="*.md" . --exclude-dir=node_modules
```

Expected: matches only in `README.md:168` and in the plan and spec under `docs/`. If any file under `functions/` or `assets/` appears, stop and investigate before deleting.

```bash
git rm twilio.json
```

- [ ] **Step 2: Fix the two feature bullets (lines 8 and 12)**

Find:

```markdown
- **Flexible Authentication**: Login with Account SID + Auth Token OR API Key + API Secret
```

Replace with:

```markdown
- **OAuth Authentication**: Sign in with an account-level [OAuth app](https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps) using the Client Credentials grant — scoped, independently revocable, and never stored server-side
```

Find:

```markdown
- **State Management**: Uses Twilio Sync to store campaign progress and credentials securely
```

Replace with:

```markdown
- **State Management**: Uses Twilio Sync to store campaign progress. No user credential is stored server-side.
```

- [ ] **Step 3: Rewrite the Functions list (lines 16-21)**

Find:

```markdown
1. **auth.js**: Handles user authentication with Account SID/Auth Token or API Key/Secret
2. **send-messages.js**: Sends messages in chunks, tracking progress in Twilio Sync
3. **check-status.js**: Retrieves campaign status and updates message statuses from Twilio
4. **resume-execution.js**: Resumes interrupted campaigns from the last checkpoint
```

Replace with:

```markdown
1. **verify.js**: Validates OAuth credentials at sign-in — a token fetch plus a phone-number read, persisting nothing
2. **send-messages.js**: Sends messages in chunks, tracking progress in Twilio Sync
3. **check-status.js**: Retrieves campaign status and updates message statuses from Twilio
4. **resume-execution.js**: Resumes interrupted campaigns from the last checkpoint
5. **get-phone-numbers.js** / **get-content-templates.js** / **list-campaigns.js**: Populate the From dropdown, the template picker, and the campaign list

Every Function receives `accountSid`, `clientId` and `clientSecret` in its POST body and builds a per-request Twilio client through `assets/twilio-oauth.private.js`. The injected runtime credentials (`context.ACCOUNT_SID` / `context.AUTH_TOKEN`) are used for Twilio Sync only.
```

- [ ] **Step 4: Correct the chunk size (lines 31 and 140)**

Both sections claim messages are processed 10 at a time. `send-messages.js:69` sets `CHUNK_SIZE = 100`. This is pre-existing and unrelated to OAuth, but both lines sit in sections being edited and a wrong number is worse than no number.

Find:

```markdown
The application processes messages in chunks of 10 messages at a time. If execution approaches the 10-second limit, it:
```

Replace with:

```markdown
The application processes messages in chunks of 100 at a time. If execution approaches the 10-second limit, it:
```

Find:

```markdown
1. **Chunking**: Messages are processed in batches of 10
```

Replace with:

```markdown
1. **Chunking**: Messages are processed in batches of 100
```

- [ ] **Step 5: Rewrite the Login instructions (lines 94-100)**

Find:

```markdown
### 1. Login

1. Open the application URL
2. Choose authentication method:
   - **Account SID + Auth Token**: Use your main Twilio credentials
   - **API Key + Secret**: Use a Twilio API Key (recommended for production)
3. Enter your credentials and click "Login"
```

Replace with:

```markdown
### 1. Sign In

First, create an account-level OAuth app: **Twilio Console → Account → API keys & tokens → OAuth apps → Create**. Grant it Messaging (read and write), Phone Numbers (read), and Content (read). Copy the **Client ID** and **Client Secret** — the secret is shown only once.

1. Open the application URL
2. Enter three values:
   - **Account SID** (`AC…`) — an identifier, not a credential. It is required because Twilio's Messaging and Phone Numbers endpoints embed it in the request path.
   - **OAuth Client ID**
   - **OAuth Client Secret**
3. Click "Sign In"

Credentials are held in the browser's `sessionStorage` for the life of the tab and sent with each request. Nothing is written to disk and nothing is stored server-side.
```

- [ ] **Step 6: Rewrite Security Considerations (lines 147-152)**

Find:

```markdown
- Credentials are stored in Twilio Sync with 1-hour TTL
- Use API Keys instead of Auth Tokens for better security
- Sync documents are scoped to the session
- Consider implementing additional security measures for production
```

Replace with:

```markdown
- **No user credential is stored server-side** — not in Twilio Sync, not in environment variables, not in logs. Earlier versions of this app wrote the user's Auth Token into a Sync Document; that store is gone.
- Credentials travel over HTTPS in POST request bodies only, never in query strings. Twilio Functions do not log request bodies and Twilio Serverless does not serve plaintext HTTP.
- A fresh Twilio client is built per request, so nothing leaks between callers.
- Campaigns are owned by the OAuth Client ID that created them. Requesting another app's campaign returns 404 rather than 403, so a guessed campaign ID is not confirmed to exist.
- The deployment holds no credentials of its own beyond the runtime credentials used for Sync, so the public Function URLs cannot be used to spend the owner's balance.

Two limits are worth stating plainly:

- **`sessionStorage` is readable by JavaScript on the page.** Any XSS on the deployed origin can exfiltrate it. OAuth does not remove that exposure — the Client Secret sits where the Auth Token used to. What changes is blast radius and revocability: the app is scoped to Messaging and Phone Numbers, and its secret rotates independently of the account's master credential. Access tokens are never stored.
- **The Function URLs are public.** Anyone with the URL can use the tool, but only with OAuth credentials they already hold.
```

- [ ] **Step 7: Update the Project Structure tree (lines 156-171)**

Find the whole fenced block and replace with:

```markdown
messaging-ui/
├── functions/
│   ├── verify.js                # Validates OAuth credentials at sign-in
│   ├── send-messages.js         # Message sending with chunking
│   ├── check-status.js          # Campaign status checker
│   ├── resume-execution.js      # Resume interrupted campaigns
│   ├── get-phone-numbers.js     # From dropdown
│   ├── get-content-templates.js # WhatsApp/RCS template picker
│   ├── list-campaigns.js        # Campaign history
│   └── webhook.js               # Delivery status callbacks
├── assets/
│   ├── index.html               # Main HTML file
│   ├── app.js                   # Frontend JavaScript
│   ├── styles.css               # Styling
│   └── twilio-oauth.private.js  # Shared OAuth client helper (private asset)
├── package.json
├── .env.example
└── README.md
```

- [ ] **Step 8: Rewrite the Authentication Fails troubleshooting section (lines 185-188)**

Find:

```markdown
### Authentication Fails
- Verify your Account SID and Auth Token/API Key are correct
- Ensure your Twilio account is active
- Check that API Keys have proper permissions
```

Replace with:

```markdown
### Sign-In Fails

- *"Invalid OAuth credentials"* — check the Client ID and Client Secret, and that the secret has not been rotated. The secret is shown only once at creation; if it was lost, create a new one.
- *"These OAuth credentials do not belong to that Account SID"* (Twilio error 70051) — either the Account SID is mistyped, or the OAuth app was created under a different account or subaccount.
- Sign-in deliberately reads one phone number to prove the credentials match the Account SID. If the app lacks the Phone Numbers read scope, sign-in fails even with a valid Client ID and Secret.

### Template Picker Is Empty

If the OAuth app lacks Content read scope, the picker falls back to "None (Use custom message)" and shows the error in red. Both channels still send with a literal message body; only the template picker is lost.
```

- [ ] **Step 9: Fix the Limitations list (lines 207-210)**

Find:

```markdown
- Sync document TTL: 1 hour for credentials
```

Replace with:

```markdown
- A session lasts as long as the browser tab. Closing it requires signing in again.
```

- [ ] **Step 10: Verify no stale references survive**

```bash
grep -n "Auth Token\|API Key\|auth\.js\|sessionId\|twilio\.json\|1-hour TTL" README.md
```

Expected output — three surviving mentions, all legitimate:

- the `.env` local-development block (lines 61-68), which uses `AUTH_TOKEN` for the *deployment's* runtime credentials, not the user's
- the Environment Variables section's `AUTH_TOKEN` entry, same reason
- the Security Considerations sentence that names the Auth Token historically

Any other match is a missed edit. `auth.js`, `sessionId`, `twilio.json` and `1-hour TTL` must return nothing.

```bash
test ! -f twilio.json && echo "twilio.json removed: OK"
```

- [ ] **Step 11: Commit**

```bash
git add README.md
git commit -m "docs: describe the OAuth sign-in flow and drop the unread twilio.json"
```

---

### Task 12: Live verification

This is the only real test of the change. No test infrastructure exists in this project and none is added (spec § Verification), so correctness is established by a deploy against a real OAuth app.

**Required from the deployer before starting:**

- An account-level OAuth app's **Client ID** and **Client Secret**
- The **Account SID** that app belongs to
- The list of **scopes** granted. Minimum for full function: Messaging read + write, Phone Numbers read, and whatever scope governs Content read.
- A **second** OAuth app on the same account, for step 7's ownership check. It needs no scopes beyond what makes a token fetch succeed.
- At least one SMS-capable Twilio phone number on the account

If any of these is missing, stop here and ask for it rather than guessing. Steps 1-10 cannot be faked.

**Files:** none modified.

- [ ] **Step 1: Deploy to a dedicated environment**

Deploy to a separate environment rather than over the live one, so a broken build does not take the existing app down:

```bash
twilio serverless:deploy --environment=oauthtest
```

The domain suffix must be alphanumeric. If the CLI rejects it, pick another alphanumeric suffix — do not fall back to the default environment, which would overwrite the deployment currently in use.

Note the returned URL; it looks like `https://<service>-<n>-oauthtest.twil.io/index.html`. Every step below uses that URL.

A deploy failure that mentions an asset path means Task 1's file is misnamed. `assets/twilio-oauth.private.js` must contain `.private` in the filename — that is what makes it a private asset.

- [ ] **Step 2: Bad Client Secret is rejected readably**

Sign in with the correct Account SID and Client ID, and a Client Secret with one character changed.

Expected: the login screen stays put and `#login-error` reads *"Invalid OAuth credentials…"*. Not a raw stack trace, not a hang, not a blank error box.

- [ ] **Step 3: Mismatched Account SID is rejected**

Sign in with valid OAuth credentials and an Account SID belonging to a different account (any other `AC…` on hand, or the same SID with two digits transposed).

Expected: rejected at sign-in with a message naming the mismatch. This is the phone-number probe in `verify.js` doing its job — without it, the mistake would surface much later as a confusing send failure.

- [ ] **Step 4: Correct credentials succeed**

Expected: the app screen appears. In DevTools → Application → Session Storage, the key `twilio_messaging_oauth` holds all three values. Confirm **Local Storage is empty** — a value under `twilio_session_id` means Task 10 Edit 2 or Edit 6 was missed.

- [ ] **Step 5: The From dropdown populates**

Expected: the dropdown lists the account's SMS-capable numbers. In DevTools → Network, the `get-phone-numbers` request is a **POST** with a JSON body — not a GET with a query string. A Client Secret visible in a URL here is a security regression and blocks the change.

- [ ] **Step 6: Template lists load or warn cleanly**

Switch the channel to WhatsApp, then to RCS.

Expected one of two outcomes:

- **Scope present** — the dropdown lists templates and `#content-template-help` reads "Select a content template".
- **Scope absent** — the dropdown falls back to "None (Use custom message)" with a disabled option reading `Error: Failed to fetch WhatsApp templates: …` (or `RCS`), and `#content-template-help` shows that text in red. Typing a literal message body and sending must still work. Note the endpoint answers **HTTP 200** here, not 500 — the per-channel inner `catch` handles it and sets `success: false`. Do not treat a 200 in the Network tab as proof the scope is present; read the response body.

Either is a pass. A failure is a channel that cannot send at all, an unhandled exception in the console, or a silently empty picker with no explanation.

This is the step that settles the open question in the spec's § Known risk: Content API scope. Record which outcome occurred — it is the answer to a question no documentation could answer.

- [ ] **Step 7: A 3-message SMS send completes**

Send to three numbers. Twilio's magic test numbers are not usable here (they require test credentials, which OAuth is not), so use real numbers you control.

Expected: all three report as sent, and the progress card reaches 100%.

- [ ] **Step 8: Campaign ownership holds**

1. The campaign from step 7 appears in the campaign list.
2. Sign out, then sign in with the **second** OAuth app and the same Account SID. The campaign list must **not** contain step 7's campaign. Pre-existing campaigns from before this change must not appear either, under either app — they have no `ownerKey`.
3. Copy the first campaign's ID. While signed in as the second app, call the endpoints directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<service>-<n>-oauthtest.twil.io/check-status \
  -H 'Content-Type: application/json' \
  -d '{"accountSid":"AC…","clientId":"<second app id>","clientSecret":"<second app secret>","campaignId":"campaign_…"}'
```

Expected: `404`. Repeat against `/resume-execution` with the same body plus `"messages":[]` — also `404`.

A `200` here means the ownership check is missing or is comparing the wrong field, and the change must not ship. A `403` means the check exists but leaks the campaign's existence; fix it to 404.

- [ ] **Step 9: Status refresh reflects delivery**

Wait for the delivery receipts on step 7's campaign.

Expected: statuses advance from `queued`/`sent` to `delivered`. The `check-status` POST is what drives this; if the card freezes at `queued` forever, check the Function logs (`twilio serverless:logs --environment=oauthtest --tail`).

- [ ] **Step 10: A multi-invocation campaign resumes to completion**

Send roughly 250 messages, which exceeds one `CHUNK_SIZE = 100` invocation and forces the browser's `while (!isComplete)` loop through at least three round trips.

Expected: the campaign runs to completion without manual intervention, and the count matches what was submitted.

This step is what proves Task 8's `ReferenceError` fix. `resume-execution.js` returned `hasMore: !isComplete` with `isComplete` never declared, so **every** resume threw before this change. No local check substitutes for this one.

If a resume stalls, click "Resume Campaign" and confirm it continues from the checkpoint rather than restarting from message 1.

- [ ] **Step 11: Sign-out clears everything**

Sign out.

Expected: the login screen appears with empty fields, `sessionStorage` no longer contains `twilio_messaging_oauth`, and a page reload lands on the login screen rather than the app.

- [ ] **Step 12: Record the outcome and clean up**

Append the result of step 6 to the spec's § Known risk section — that question is now answered and the next reader should not have to redeploy to learn it.

```bash
twilio serverless:list environments
```

Remove the throwaway environment once the results are recorded. Deleting an environment is irreversible; confirm the domain suffix before running it, and confirm with the user first if the environment might be in use:

```bash
twilio api:serverless:v1:services:environments:remove \
  --service-sid=<ZSxxx> --sid=<ZExxx>
```

- [ ] **Step 13: Final commit**

```bash
git add docs/superpowers/specs/2026-08-07-oauth-login-design.md
git commit -m "docs: record Content API scope outcome from live verification"
```

---

## Done When

- [ ] Sign-in takes Account SID + OAuth Client ID + Client Secret, and nothing else
- [ ] `functions/auth.js` is deleted; no code path writes a user credential to Twilio Sync
- [ ] `grep -rn "authToken\|apiSecret\|credentials_" functions/` returns nothing
- [ ] All eight frontend data calls are POSTs carrying credentials in the body
- [ ] `list-campaigns`, `check-status` and `resume-execution` enforce `ownerKey`, with 404 on a mismatch
- [ ] A ~250-message campaign completes across multiple invocations
- [ ] The Content API scope question in the spec is answered from observation, not assumption
