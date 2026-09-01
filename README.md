# Twilio Messaging UI

A web app for sending message campaigns through Twilio's Programmable Messaging API across SMS, MMS, RCS, WhatsApp and Facebook Messenger. Built with Twilio Serverless Functions and Assets.

## Features

- **Five channels**, with per-channel sender lists and content-template pickers
- **OAuth sign-in** with an account-level [OAuth app](https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps) using the Client Credentials grant — scoped, independently revocable, and never stored server-side
- **Resumable campaigns** that survive the 10-second Function timeout by chunking and checkpointing to Twilio Sync
- **Live delivery tracking** per message, with CSV export

## Prerequisites

- A [Twilio account](https://www.twilio.com)
- The [Twilio CLI](https://www.twilio.com/docs/twilio-cli/quickstart)
- Node.js 24 locally, to match the deployed runtime (`twilio-cli` itself needs 20 or higher)

Functions run on the **Node.js 24** runtime, pinned in `.twilioserverlessrc` so every deploy targets it rather than inheriting whatever the last build used.

## Setup

```bash
git clone https://github.com/abelzx/twilio-messaging-ui.git
cd twilio-messaging-ui
npm install
twilio login
twilio serverless:deploy
```

Deployment prints a URL like `https://your-service-1234-dev.twil.io/index.html`.

### Running locally

```bash
twilio serverless:start   # then open http://localhost:3000/index.html
```

Local runs need a `.env` with the *deployment's own* credentials, used for Twilio Sync access only. These are unrelated to the OAuth credentials each user signs in with, and the Functions runtime supplies them automatically once deployed — so `.env` is only ever needed locally.

```env
ACCOUNT_SID=your_account_sid
AUTH_TOKEN=your_auth_token
```

`.env` is gitignored, and there is no `.env.example` to copy.

Two optional variables are read if present: `SYNC_SERVICE_SID` to pin a specific Sync Service (one is auto-created otherwise), and `MESSAGING_SERVICE_SID` as the sender fallback for Messenger.

## Usage

### Sign in

Create an account-level OAuth app first: **Twilio Console → Settings → Account settings → OAuth applications**. Grant it Messaging (read and write), Phone Numbers (read), and Content (read), then copy the **Client ID** and **Client Secret** — the secret is shown only once.

Sign in with those two values. The Account SID is not typed; it is derived from the access token issued for your credentials and shown next to Sign Out. It is still needed internally, because Twilio's Messaging and Phone Numbers endpoints embed it in the request path.

Credentials are held in the tab's `sessionStorage` and sent with each request. Nothing is written to disk and nothing is stored server-side.

### Send messages

Pick a channel, choose a sender, enter a message body or select a content template, paste recipients one per line or comma-separated, and send.

> **Keep the tab open while sending.** The chunk loop runs in your browser, not on Twilio. Each request sends what fits in one 9-second Function invocation and returns; the page then initiates the next. Your credentials live only in this tab, so nothing server-side can carry the campaign on by itself.
>
> Closing the tab, navigating away, or letting the machine sleep stops sending. Switching to another tab or app is fine — background tabs keep running, though browsers throttle timers to about one per second, which matches the delay already in the loop.
>
> Nothing is lost if sending is interrupted. Progress is checkpointed to Sync, so the campaign shows as **In Progress** with a **Resume** button that picks up from the last index, and no recipient is messaged twice. Closing the tab also clears your credentials, so you will need to sign in again before resuming.

### Monitor progress

The campaign card shows sent, failed, and pending counts with a progress percentage. The delivery panel lists per-message status, refreshed every 5 seconds, and exports to CSV.

## Channels

| Channel | Sender | Content templates |
| --- | --- | --- |
| SMS | Twilio phone number | templates defining `twilio/text` |
| MMS | MMS-capable number | templates defining `twilio/media` |
| RCS | RCS agent | text, media, card, carousel, quick-reply |
| WhatsApp | WhatsApp-enabled sender, approved for messaging | any template, subject to Meta approval status |
| Facebook Messenger | Facebook Page ID | not supported |

A Messaging Service can be used as the sender on any channel. WhatsApp senders and recipients are auto-prefixed with `whatsapp:`, so either form works.

### How SMS and MMS templates are filtered

Both channels render exactly one content type — `twilio/text` for SMS, `twilio/media` for MMS — so the picker lists only templates defining it. A template defining both appears under each channel.

Templates carrying richer types (card, carousel, quick-reply) are still listed, because Twilio delivers the most complex translation the destination channel supports; over SMS or MMS that is the text or media translation. The preview and variable inputs are narrowed to that translation, so what you see is what the recipient receives — a card's copy is not previewed on SMS, and a media-URL variable is not prompted for on a channel that drops the media.

A template with no type the channel can render is omitted rather than offered, since sending it fails with [error 216602](https://www.twilio.com/docs/api/errors/216602).

## How resumable execution works

Messages are processed in chunks of 100. `send-messages.js` keeps going until it approaches a 9-second budget (inside the platform's 10-second ceiling), then saves the current index to Sync and returns. The page calls back in to continue from that checkpoint until the Function reports completion.

**The browser drives that loop** — `sendMessagesBatch()` in `assets/app.js`, not a Twilio-side scheduler. This follows from never storing user credentials server-side: the Functions receive a Client ID and Secret per request and keep nothing, so no queue or cron could authenticate a continuation. Hence the tab must stay open. Making sending fire-and-forget would mean granting the deployment standing authorization to send on the user's behalf.

## Architecture

```
functions/
  verify.js                 Validates OAuth credentials at sign-in
  send-messages.js          Chunked sending, checkpointed to Sync
  resume-execution.js       Continues a campaign from its last checkpoint
  check-status.js           Campaign status, re-fetching each message from Twilio
  get-phone-numbers.js      Senders for the selected channel
  get-content-templates.js  Template picker, scoped per channel
  list-campaigns.js         Campaign history
  webhook.protected.js      Delivery-status callbacks (signature-validated)
assets/
  index.html  app.js  styles.css
  twilio-oauth.private.js   Shared OAuth client helper (private, not web-reachable)
```

Every Function except the webhook receives `clientId` and `clientSecret` in its POST body and builds a per-request Twilio client through `assets/twilio-oauth.private.js`. The webhook is the exception: Twilio calls it, not the browser, so it carries no user credentials. The runtime credentials (`context.ACCOUNT_SID` / `context.AUTH_TOKEN`) are used for Sync access throughout, never for the user's own account.

## Security

- **No user credential is stored server-side** — not in Sync, not in environment variables, not in logs. An earlier version wrote the user's Auth Token into a Sync Document; that store is gone.
- Credentials travel in HTTPS POST bodies only, never query strings. Twilio Functions do not log request bodies and Twilio Serverless does not serve plaintext HTTP.
- A fresh Twilio client is built per request, so nothing leaks between callers.
- Campaigns are owned by the OAuth Client ID that created them. Requesting another app's campaign returns 404 rather than 403, so a guessed campaign ID is never confirmed to exist.
- The deployment holds no credentials of its own beyond the runtime ones used for Sync, so the public Function URLs cannot be used to spend the owner's balance.
- The status-callback endpoint is a **protected** Function, so the runtime drops any request lacking a valid `X-Twilio-Signature`. It is the one endpoint that writes to campaign documents without an ownership check — it matches on `MessageSid` alone — so leaving it public would let a forged callback rewrite delivery state for any campaign in the deployment. Signatures validate against the deployment's auth token, so callbacks for a user signed in from another account are dropped; nothing is lost, because `check-status.js` re-fetches each message on the poll and this endpoint only ever made statuses fresher, sooner.

Two limits worth stating plainly:

- **`sessionStorage` is readable by JavaScript on the page.** Any XSS on the deployed origin can exfiltrate it. OAuth does not remove that exposure — the Client Secret sits where the Auth Token used to. What changes is blast radius and revocability: the app is scoped to Messaging, Phone Numbers and Content, and its secret rotates independently of the account's master credential. Access tokens are never stored.
- **The Function URLs are public.** Anyone with the URL can use the tool, but only with OAuth credentials they already hold.

## Troubleshooting

**Sign-in fails.**

- *"Invalid OAuth credentials"* — check the Client ID and Secret, and that the secret has not been rotated. It is shown only once at creation; if lost, create a new one.
- *"…the OAuth app is missing the Phone Numbers read scope"* (Twilio error 70051) — grant that scope. Sign-in deliberately reads one phone number to prove the app's scopes are sufficient, which is why this fails even with a valid Client ID and Secret.
- *"Twilio's token endpoint did not respond in time"* — transient upstream problem, not a credential problem. Retry.

**Template picker is empty.** Usually a missing Content read scope: the picker falls back to "None (Use custom message)" and shows the error in red. Sending with a literal message body still works. An empty MMS list can also mean no template in the account defines `twilio/media`.

**Messages not sending.** Check that the sender is valid for the selected channel — a WhatsApp sender is not a plain phone number, and WhatsApp senders must be approved. Then check the Function logs and the Twilio Console error log.

**Sync errors.** Confirm the Sync API is enabled on the account and that the runtime credentials have Sync access.

**Timeouts.** Handled automatically by chunking. If a single chunk still overruns, lower `CHUNK_SIZE` in `send-messages.js`.

## License

[MIT](LICENSE) © Abel Ng
