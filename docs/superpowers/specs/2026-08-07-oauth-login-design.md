# OAuth client credentials for messaging-ui

Date: 2026-08-07

Replace this app's login mechanism. Users currently sign in with an Account SID +
Auth Token, or an Account SID + API Key + Secret. They will instead sign in with an
account-level [OAuth app](https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps)
using the Client Credentials grant, following the pattern established by the sibling
project `twilio-lookup-api-ui`.

This is a spec for what the app becomes, not a task list.

## Why

Two distinct weaknesses exist today, and they need separating because a naive OAuth
swap only fixes the first.

**The credential type.** An Auth Token grants unrestricted access to the whole
account and cannot be revoked in isolation — rotating it invalidates every other
integration. An OAuth app can be scoped to Messaging and Phone Numbers alone, and its
secret rotated with a grace period, independently of the account's master credential.

**The secret at rest.** `functions/auth.js:57-69` writes the user's raw `authToken`
or `apiSecret` into a Twilio Sync Document (`credentials_<sessionId>`, 1 hour TTL)
inside the *deployment's* account. Five functions read it back out. That secret is
plaintext-readable by anyone holding the deployment account's credentials and is
visible in the Console's Sync browser. Storing an OAuth Client Secret there instead
would preserve this weakness exactly.

Both are removed. After this change the deployment holds no user credential at rest,
anywhere.

## What makes the stateless design safe here

The server never resumes a campaign autonomously. `resume-execution.js:70` requires
the `messages` array in the request body and cannot reconstruct a campaign without
the client re-supplying the recipient list. Campaign continuation is driven entirely
by a `while (!isComplete)` loop in the browser (`assets/app.js:683-740`), which
re-POSTs the full message array with a `resumeFrom` cursor until the server reports
completion. The server only fans out *within* a single 9-second invocation
(`send-messages.js:68-69`, `CHUNK_SIZE = 100`).

Because no server-side process ever needs credentials outside an in-flight browser
request, server-side credential storage buys nothing. Credentials can live in the
browser and travel with each request.

## The Account SID is still required

The reference project's client construction does not transfer unmodified.
`BaseTwilio.setCredentialProvider()` sets `this.accountSid = ""`
(`node_modules/twilio/lib/base/BaseTwilio.js:86-90`), and the v2010 resource tree
builds its request URI from that field (`lib/rest/api/V2010.js:38`). Verified against
`twilio@5.10.6`:

```
accountSid after setCredentialProvider: ""
URI: https://api.twilio.com/2010-04-01/Accounts//Messages.json
```

`twilio-lookup-api-ui` is unaffected because Lookup v2 lives at
`/v2/PhoneNumbers/...`, with no account SID in the path. Three of this app's calls do
embed it: `messages.create` (`send-messages.js:229`), `incomingPhoneNumbers.list`
(`get-phone-numbers.js:47`), and `messages(sid).fetch` (`check-status.js:55`).

The fix is to call `setAccountSid()` *after* `setCredentialProvider()`. Verified to
produce correct URIs for all three, and the Content API needs no SID at all:

```
[messages.create]       .../2010-04-01/Accounts/AC0000…0001/Messages.json
[incomingPhoneNumbers]  .../2010-04-01/Accounts/AC0000…0001/IncomingPhoneNumbers.json
[messages(sid).fetch]   .../2010-04-01/Accounts/AC0000…0001/Messages/SM0.json
[content]               https://content.twilio.com/v1/Content
```

So the login form keeps an Account SID field. The Auth Token and API Key/Secret
fields both go away; the Account SID remains as a plain identifier, not a credential —
it is public, it is displayed on the Console dashboard, and holding it grants nothing.

The rejected alternative was reading an `AC…`-shaped claim out of the access-token
JWT, as `twilio-lookup-api-ui/functions/verify.js:18-30` does. That claim is
undocumented; the reference project's own comment notes that a miss is normal. There
it degrades a display label, so best-effort is fine. Here a miss would break message
sending, which is not an acceptable failure mode to build on an undocumented claim.

Login therefore takes three fields — **Account SID**, **OAuth Client ID**, **OAuth
Client Secret** — of which only the last is secret.

## Campaign ownership

`list-campaigns.js:45` currently filters campaign documents on
`campaignData.accountSid === accountSid`, where `accountSid` came from the trusted
Sync credential document. With that document gone, ownership must be derived from
something the caller has *proven*, not merely asserted.

The typed Account SID cannot serve this purpose: it arrives in the request body, so
accepting it as an authorization key would let any caller list another account's
campaigns by claiming their SID. The Client ID is proven to belong to the caller the
moment the token exchange succeeds.

Campaign documents therefore carry `ownerKey: "oauth:<clientId>"`, and
`list-campaigns` filters on that alone. `accountSid` is still written to the document,
for display only.

### Per-campaign access

Filtering the *list* is not sufficient. `check-status.js` and `resume-execution.js`
both take a `campaignId` and fetch that Sync document directly, today with no
ownership check at all — a valid session could read or resume any campaign. Campaign
IDs are `campaign_${Date.now()}` (`send-messages.js:110`, `app.js:672`), so they are
guessable, not secret.

Both functions therefore compare the fetched document's `ownerKey` against the
caller's before returning or acting on it, responding HTTP 404 on a mismatch — 404
rather than 403, so the endpoint does not confirm that a guessed campaign ID exists.

Documents without an `ownerKey` fail this check, which is consistent with their being
absent from the campaign list.

### Existing documents

Campaign documents already deployed are keyed by `accountSid` and have no `ownerKey`.
They will no longer appear in the campaign list. The Sync documents themselves are
left in place, untouched and unlisted. This is a deliberate accepted loss of send
history in exchange for a single unambiguous ownership rule.

## Architecture

```
                    BEFORE                                       AFTER
   browser localStorage { sessionId }          browser sessionStorage twilio_messaging_oauth
            |                                      { accountSid, clientId, clientSecret }
   POST /auth {accountSid, authToken}                        |
            |  validates via                     POST /verify {accountSid, clientId, clientSecret}
            |  accounts(sid).fetch()                         |  1. token fetch @ oauth.twilio.com/v2/token
            v                                                |  2. incomingPhoneNumbers.list({limit:1})
   Sync doc credentials_<sessionId>                          v
     { authToken, apiSecret }  <-- secret       { valid: true }        (nothing persisted)
     at rest, 1h TTL                                         |
            |                                                |
   GET /fn?sessionId=...                        POST /fn { accountSid, clientId, clientSecret, ... }
            |  runtime client                                |  createOAuthClient() -> memoised strategy
            |  -> Sync fetch creds                           |  -> one upfront token fetch
            v  -> user client                                v  -> user client
                                               runtime client (context.*) for Sync ONLY
```

Twilio Sync retains `campaign_*` documents and nothing else. The runtime client built
from `context.ACCOUNT_SID` / `context.AUTH_TOKEN` is used exclusively for Sync
operations, as it is today. `functions/webhook.js` already works this way and its
behaviour is unchanged.

## Components

### `assets/twilio-oauth.private.js` (new)

A private asset, required from Functions as
`require(Runtime.getAssets()['/twilio-oauth.js'].path)`. It exists because the same
credential handling is needed in six Functions and one part of it is a footgun that
must not be copy-pasted.

```
credsFrom(event)         -> { accountSid, clientId, clientSecret }, trimmed
                            throws a readable Error naming the missing field
createOAuthClient(creds) -> { client, authStrategy }
authenticate(creds)      -> client, after one awaited authStrategy.getAuthString()
ownerKeyFor(creds)       -> `oauth:${clientId}`
tokenErrorMessage(err)   -> readable text from a wrapped token-fetch Error
getOrCreateSyncService(runtimeClient) -> Sync service SID
```

`createOAuthClient` builds a `ClientCredentialProviderBuilder` provider, then
**memoises `provider.toAuthStrategy`**. This is load-bearing: `BaseTwilio.request()`
calls `toAuthStrategy()` on every API request and each call returns a strategy with an
empty token cache, so one 100-message chunk would otherwise perform 100 token fetches
inside a 9-second budget. The strategy's own 30-second expiry buffer still triggers a
refetch when an invocation outlives its token. It then calls
`client.setCredentialProvider(provider)` followed by
`client.setAccountSid(creds.accountSid)`, in that order, for the reason given above.
The client is constructed with `autoRetry: true, maxRetries: 3`.

`authenticate` awaits `getAuthString()` before returning, so invalid credentials cost
one clear failure rather than the same error repeated once per message in a chunk.

`getOrCreateSyncService` moves here from seven verbatim copies (`auth.js:90`,
`send-messages.js:327`, `resume-execution.js:283`, `check-status.js:130`,
`get-phone-numbers.js:79`, `get-content-templates.js:196`, `list-campaigns.js:105`,
`webhook.js:114`). Its behaviour is preserved exactly, including the fallback to the
first available service.

### `functions/verify.js` (new, replaces `functions/auth.js`)

Validates credentials at login and persists nothing.

1. POST `grant_type=client_credentials` to `https://oauth.twilio.com/v2/token` with an
   8-second `AbortSignal.timeout`, leaving headroom inside the 10-second Function
   budget for a readable error.
2. Build a client for the supplied Account SID and call
   `incomingPhoneNumbers.list({ limit: 1 })`.

Step 2 is an addition relative to the reference project's `/verify`, which does only a
token fetch. Two things need proving here rather than one: that the OAuth credentials
work, and that they belong to the Account SID that was typed. This call proves both,
plus the presence of the Phone Numbers read scope the From dropdown depends on. It is
not billable. Without it, a mistyped Account SID would pass login and then fail
confusingly on first send.

Responses:

- Success — `{ valid: true }`, HTTP 200
- Bad Client ID or Secret — `{ valid: false, error: "Invalid OAuth credentials — …" }`, HTTP 200
- SID mismatch or missing scope — `{ valid: false, error: … }`, HTTP 200
- Missing field — `{ valid: false, error: … }`, HTTP 400

HTTP 200 for a credential rejection matches the reference project's contract, so the
frontend distinguishes "rejected" from "transport failed" by `valid`, not by status.

`functions/auth.js` is deleted, and with it the Sync credential store and the 1-hour
TTL session model. Sessions now last as long as the browser tab.

### Data functions

Six functions replace their credential block — a Sync fetch plus an
`authToken`/`apiKey` branch — with `authenticate(credsFrom(event))`.

| Function | Twilio calls | Other changes |
|---|---|---|
| `send-messages.js` | `messages.create` | Campaign doc gains `ownerKey` |
| `resume-execution.js` | `messages.create` | Same, plus ownership check and the bug fix below |
| `check-status.js` | `messages(sid).fetch` | GET → POST; ownership check |
| `get-phone-numbers.js` | `incomingPhoneNumbers.list` | GET → POST |
| `get-content-templates.js` | `content.v1.contentAndApprovals.list`, `content.v1.contents.list` | GET → POST |
| `list-campaigns.js` | none of the user's own | GET → POST; filters on `ownerKey` |

`list-campaigns.js` makes no call against the user's account — it only reads Sync
through the runtime client. It must still call `authenticate()`. Ownership filtering
rests on the caller actually holding the Client ID they sent, and only a successful
token exchange establishes that. Skipping the token fetch here because "there is no
Twilio call to make" would make the `ownerKey` filter bypassable by sending someone
else's Client ID with any secret.

`resume-execution.js:272` returns `hasMore: !isComplete`, but `isComplete` is never
declared in `sendMessagesChunk`'s scope — a `ReferenceError` on every resume. It is
fixed in place to `currentIndex >= messages.length`, consistent with the line above
it. The near-duplicate send loop shared with `send-messages.js` is deliberately left
alone; see Out of scope.

### Frontend

`assets/index.html` — the login form becomes three fields. The `.auth-method-tabs`
element and both `.auth-section` blocks are removed.

`assets/app.js` — the module-level `sessionId` string becomes a credentials object
backed by `sessionStorage` under the single key `twilio_messaging_oauth`, holding
`{ accountSid, clientId, clientSecret }`. `switchAuthMethod()` is deleted. Nine fetch
call sites change: line 150 targets `/verify`; lines 215, 267, 752, 837, 924 and 1048
convert from GET query strings to POST bodies; lines 689 and 857 keep their method and
gain credentials in the body. On load, the app screen is shown if all three values are
present — credentials are not re-verified, so a rotated secret surfaces on first
action rather than at page load. Sign-out clears the key and the form.

`sessionStorage` rather than `localStorage`: a Client Secret should not outlive the
tab or persist to disk.

The four GET → POST conversions are a security requirement, not tidying. A Client
Secret in a query string is recorded in request logs and browser history; an opaque
`sessionId` was not.

What this does and does not guarantee, stated precisely: it guarantees *this
frontend* never places a secret in a URL. It does **not** make the endpoints refuse
credentials supplied as query parameters. Twilio Functions merge query parameters and
body into a single `event` object, and none of these Functions asserts
`event.request.method === 'POST'` — the `Access-Control-Allow-Methods` header is
advisory to browsers, not server-side enforcement. A caller who hand-crafts a GET
with `?clientSecret=…` will still be served, and will have logged their own secret.

That residual case is accepted rather than fixed. It harms only the caller who chooses
it, the pattern predates this change in all six Functions, and adding a method check to
each is outside this spec's scope. It is recorded here so the security property is not
read as stronger than it is.

### Configuration

`twilio.json` is deleted rather than updated, because nothing reads it. `twilio-run`
loads configuration through cosmiconfig under the module name `twilioserverless`
(`twilio-run/dist/config/utils/configLoader.js:9`), which searches `package.json`,
`.twilioserverlessrc[.json|.yaml|.js]` and `twilioserverless.config.js` — never
`twilio.json`. Function and asset visibility is derived from the filename
(`.private.js` → `access = 'private'`, `serverless-api/dist/utils/fs.js:113`), not from
a manifest. The file is also already stale: it omits `list-campaigns.js`, which
deploys and works regardless. Keeping it would only invite the next reader to trust it.

No dependency changes: `twilio@5.10.6` is already installed and already exports
`ClientCredentialProviderBuilder`.

## Error handling

| Condition | Behaviour |
|---|---|
| Bad Client ID or Secret at login | `{valid:false, error}` with HTTP 200; message rendered in `#login-error` |
| Bad Client ID or Secret mid-session | Upfront `getAuthString()` fails; one HTTP 401 per request, not one error per message |
| Account SID mismatch | Caught at login by the phone-number probe; Twilio error 70051 mapped to "these OAuth credentials do not belong to that Account SID" |
| Secret rotated mid-campaign | The client loop's non-OK branch calls `showResumeOption()` (`app.js:726`); the campaign pauses and is resumable after re-login |
| Campaign requested by a non-owner | HTTP 404, so a guessed campaign ID is not confirmed to exist |
| Missing scope | Twilio error 70051. A Content scope miss is caught by the per-channel inner `catch` in `get-content-templates.js`, which answers **HTTP 200** with `{success: false, error}`. `app.js:269` gates on `response.ok && data.success !== false`, so that takes the else branch (`app.js:287-298`): the picker falls back to "None (Use custom message)" and `#content-template-help` shows the error in red, rather than breaking the WhatsApp or RCS channel |
| Token endpoint hangs | 8-second abort inside `/verify`; readable message instead of a platform timeout |
| Rate limiting | `retryWithExponentialBackoff` is untouched |

### Settled: raw upstream text in error responses

`tokenErrorMessage`'s fallback branch returns `Could not obtain a Twilio access token
— <raw>`, forwarding the SDK's own error text into the HTTP response body. Every
migrated Function echoes `error.message` this way. This was raised independently by
two reviewers, so the decision is recorded here rather than re-litigated per Function.

**It stays.** The raw text originates from Twilio's OAuth endpoint or the SDK, never
from this deployment, and it carries no credential — `ApiTokenManager.fetchToken()`
discards the original error and throws a fresh `Error` holding only a status and
message, so the submitted secret cannot ride along. `tokenErrorMessage` already
collapses whitespace to a single line. Suppressing the text would make a genuine
transient outage undiagnosable from the UI, which is a worse failure than an
occasionally ugly message.

Bad credentials — the common case — never reach this branch; they are matched by
`/\b401\b|invalid credentials|invalid_client/i` and get a clean message instead.

## Security properties

- No user credential is stored server-side, in environment variables, or in logs.
- Credentials travel over HTTPS only, in request bodies. Twilio Functions do not log
  request bodies. Twilio Serverless does not serve plaintext HTTP.
- A fresh Twilio client is constructed per request, so nothing leaks between callers.
- The deployment holds no credentials of its own beyond the injected runtime
  credentials used for Sync, so a public Function URL cannot be used to spend the
  owner's balance.

Two properties are consequences of the design rather than oversights, and are stated
plainly:

- **`sessionStorage` is readable by JavaScript on the page.** Any XSS on the deployed
  origin can exfiltrate it. OAuth does not remove that exposure — the Client Secret
  sits where the Auth Token used to. What changes is blast radius and revocability:
  the app is scoped to Messaging and Phone Numbers, and its secret rotates
  independently of the account's master credential. Access tokens are never stored.
- **Credentials are re-transmitted once per chunk iteration.** Because the browser
  drives the campaign loop, a large campaign sends its credentials on each of perhaps
  30–50 requests rather than once. All over HTTPS, but it is more transit surface
  than the reference project has.

## Resolved: the Content API *is* reachable with an OAuth app

This was an open risk at design time. No documentation could be found confirming
whether the Content API (`content.v1.contentAndApprovals.list`,
`get-content-templates.js:68`) was reachable with an account-level OAuth app, so the
content path was built to fail soft rather than guess.

**Settled by live verification on 2026-08-07.** Against a real OAuth app, `POST
/get-content-templates` returned `success: true` with the full template list for both
`whatsapp` and `rcs` — including templates with variables and `approved` status. The
Content API needs no Account SID in its path (`https://content.twilio.com/v1/Content`),
and the OAuth token was accepted.

The fail-soft handling is kept anyway. It is not dead weight: it still covers an OAuth
app that was created *without* Content scope granted, which is a configuration the
deployer controls and can easily get wrong. What is no longer in doubt is that granting
the scope works.

## Verification

Live deploy to a throwaway serverless environment, signed in with a real
account-level OAuth app. No test infrastructure exists in this project and none is
added.

1. Sign-in rejects a bad Client Secret with a readable message.
2. Sign-in rejects a valid OAuth app paired with a mismatched Account SID.
3. Sign-in succeeds with correct values.
4. From dropdown populates.
5. WhatsApp and RCS template lists load, or warn cleanly if the scope is absent.
6. A 3-message SMS send completes.
7. The campaign appears in the campaign list; a second OAuth app's campaigns do not.
   Requesting another app's `campaignId` directly against `/check-status` and
   `/resume-execution` returns 404.
8. Status refresh reflects delivery.
9. A ~250-message send spanning multiple invocations resumes correctly to completion.
10. Sign-out clears `sessionStorage`; reload returns to the login screen.

Required from the deployer: the OAuth app's Client ID and Secret, and the list of
scopes granted. Minimum for full function is Messaging read and write, Phone Numbers
read, and whatever scope governs Content read.

## Known limitation: duplicate sends on a lost Sync write

Not introduced by this change, not fixed by it, and recorded because a code review
surfaced it and the next reader deserves to know.

`send-messages.js` and `resume-execution.js` both fetch the campaign document, send a
chunk with `Promise.all`, then write `startIndex` back. There is no optimistic
concurrency check — no `If-Match` on the document revision — between the read and the
write. Two consequences, both reachable:

- **Concurrent invocations.** Two tabs, or a double-clicked Resume button, both read the
  same `startIndex`, compute the same chunk, and send to the same recipients. Real
  duplicate messages; the losing write's statistics are silently discarded.
- **A write that fails after the sends succeed.** If `Promise.all` resolves but the
  follow-up `documents().update()` throws (rate limit, transient error), the request
  500s with `startIndex` unadvanced. The browser retries, re-reads the stale
  `startIndex`, and sends the same chunk again. No process kill is required — an
  ordinary Sync API error is enough.

It is left alone deliberately. The flaw is symmetric across both Functions, so fixing
only the one under review would create exactly the silent divergence between the two
copies that is the real cost of keeping them separate. A correct fix means a revision
check in both, plus verifying Twilio Sync's `If-Match` semantics, which is its own piece
of work rather than a footnote to an auth migration.

Bounding the token exchange (§ Components) reduces the *odds* of the second case by
keeping the invocation inside its budget. It does not close either case.

**How to detect it in the field.** The `sent` / `failed` / `delivered` counters are
incremented cumulatively rather than derived from the messages array, so a chunk sent
twice inflates `sent` past `totalMessages` and drives `pending` **negative**. A campaign
reporting `pending < 0` has double-sent, which is otherwise invisible. Observed
deliberately during verification on 2026-08-12 by rewinding `startIndex` without
rewinding `sent`: the response returned `{sent: 5, pending: -2}` for a 3-message
campaign. Worth checking before concluding a campaign completed cleanly.

## Out of scope

- Deduplicating the send loop between `send-messages.js` and `resume-execution.js`.
- Unit tests and CI.
- Pinning the serverless runtime (this project has no `.twilioserverlessrc`; the
  reference project pins `node24`).
- The `@twilio/runtime-handler` pin in `package.json`, which the reference project
  deliberately omits because the platform injects and auto-upgrades it.
- Migrating existing campaign documents to carry `ownerKey`.
