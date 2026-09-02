# Twilio Messaging UI

A web app for sending message campaigns across SMS, MMS, RCS, WhatsApp and Facebook Messenger, through either Twilio's Programmable Messaging API or its Bulk Messaging API. Built with Twilio Serverless Functions and Assets.

## Features

- **Five channels** on Programmable Messaging, four on Bulk Messaging (no Messenger) — with per-channel sender lists and content-template pickers
- **OAuth sign-in** with an account-level [OAuth app](https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps) using the Client Credentials grant — scoped, independently revocable, and never stored server-side
- **Resumable campaigns** on Programmable Messaging, surviving the 10-second Function timeout by chunking and checkpointing to Twilio Sync
- **Live delivery tracking**, with CSV export — per message on Programmable Messaging, aggregate stats plus on-demand recipient rows on Bulk Messaging

## Two sending APIs

The app can send through either of Twilio's messaging APIs, chosen per campaign.

| | Programmable Messaging | Bulk Messaging (beta) |
| --- | --- | --- |
| Request shape | one per recipient | one request for up to 10,000 recipients |
| Channels | SMS, MMS, RCS, WhatsApp, Messenger | SMS, MMS, RCS, WhatsApp |
| Tab must stay open | yes — the chunk loop runs in your browser | no — Twilio processes the request server-side |
| Resumable | yes, checkpointed to Sync | not needed; there is no browser-driven loop to interrupt |
| Sender | phone number, sender, or Messaging Service | phone number, sender, or sender pool — no Messaging Service |
| Delivery detail | per message, polled every 5s | aggregate stats polled every 5s; per-recipient rows fetched only when the delivery panel opens or a CSV export is requested |
| Scheduling | not exposed | up to 7 days ahead |
| Channel fallback | no | WhatsApp to SMS only |

Bulk Messaging is a [Public Beta](https://www.twilio.com/docs/bulk-messaging) product with no SLA, which is why it is a mode here rather than a replacement for Programmable Messaging.

## Prerequisites

- A [Twilio account](https://www.twilio.com)
- The [Twilio CLI](https://www.twilio.com/docs/twilio-cli/quickstart)
- Node.js 24 locally, to match the deployed runtime (`twilio-cli` itself needs 20 or higher)

Functions run on the **Node.js 24** runtime, pinned in `.twilioserverlessrc` so every deploy targets it rather than inheriting whatever the last build used.

> The `@twilio/runtime-handler` pin in `package.json` reads `2.0.3`, which looks stale next to Node 24's requirement of 2.1.2 — it isn't. Twilio [upgrades the handler automatically at build time](https://www.twilio.com/docs/serverless/functions-assets/node-upgrade) for any pin at 1.2.0 or above, and the Build API confirms `2.1.2` resolved. Pinning 2.1.2 directly is not an option: it is not published on npm (the registry stops at 2.1.0), so declaring it makes `npm install` fail with `ETARGET`. Raise the pin once Twilio publishes 2.1.2.

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

Create an account-level OAuth app first: **Twilio Console → Settings → Account settings → OAuth applications**. Grant it Messaging (read and write), Phone Numbers (read), and Content (read) — plus the **Comms** scopes if you intend to use Bulk Messaging mode, since that mode authenticates against `comms.twilio.com` rather than the endpoints the other three scopes cover. Then copy the **Client ID** and **Client Secret** — the secret is shown only once.

Sign in with those two values. The Account SID is not typed; it is derived from the access token issued for your credentials and shown next to Sign Out. It is still needed internally, because Twilio's Messaging and Phone Numbers endpoints embed it in the request path.

Signing in successfully does not prove the Comms scopes were granted — sign-in only exercises the Messaging and Phone Numbers scopes. A missing Comms grant surfaces later, the first time you submit a bulk campaign.

Credentials are held in the tab's `sessionStorage` and sent with each request. Nothing is written to disk and nothing is stored server-side.

### Send messages

Pick a channel, choose a sender, enter a message body or select a content template, paste recipients one per line or comma-separated, and send.

#### Personalising per recipient with a CSV

Typing recipients sends everyone the same thing. **Upload CSV** instead to give each recipient their own template variables or their own message text. **Download sample** generates a correctly-shaped file for whatever is currently selected, so the header never has to be guessed.

| Selected | CSV header | Each row supplies |
| --- | --- | --- |
| A content template | `Number,{{1}},{{2}}` | that recipient's template variables |
| No template | `Number,Body` | that recipient's message text |

Recipient numbers go in **E.164** format — a leading `+`, country code, digits only, no spaces or punctuation, as in `+6512345678`. Anything else is flagged in the summary as likely to be rejected, but still sent: a Messaging Service with a configured geography can accept national formats, so refusing them outright would block numbers that would in fact deliver.

Header matching is deliberately forgiving. The recipient column may be `Number`, `To`, `Phone`, `Phone Number`, `Recipient` or `MSISDN`; message text may be `Body`, `Message` or `Text`; and a variable column may be written `{{1}}`, `{{ 1 }}` or bare `1` — named variables like `{{name}}` work the same way. Case is ignored throughout. Quoted fields are handled, so a message body containing a comma is fine.

While a file is loaded it is the single source of truth: the Recipients box and the variable inputs are disabled and dimmed, and **Clear CSV** returns to manual entry. Because the columns map to a specific template's variables, changing the template re-checks the file rather than sending the old mapping against new variables.

Rows with a problem are skipped and listed by line number — a missing number, or a column count that doesn't match the header — and the rest still send. A blank variable cell sends as empty text rather than falling back to the template's sample value, which would put someone else's placeholder data in a real message. A blank `Body` cell does fall back to the message body typed above, and the summary says how many rows that affected.

> **On Programmable Messaging, keep the tab open while sending.** The chunk loop runs in your browser, not on Twilio. Each request sends what fits in one 9-second Function invocation and returns; the page then initiates the next. Your credentials live only in this tab, so nothing server-side can carry the campaign on by itself.
>
> This does not apply in Bulk Messaging mode: one request covers the whole campaign (up to 10,000 recipients), Twilio processes it after that, and you can close the tab as soon as the request is accepted.
>
> Closing the tab, navigating away, or letting the machine sleep stops sending. Switching to another tab or app is fine — background tabs keep running, though browsers throttle timers to about one per second, which matches the delay already in the loop.
>
> Nothing is lost if sending is interrupted. Progress is checkpointed to Sync, so the campaign shows as **In Progress** with a **Resume** button that picks up from the last index, and no recipient is messaged twice. Closing the tab also clears your credentials, so you will need to sign in again before resuming.

### Monitor progress

The campaign card shows sent, failed, and pending counts with a progress percentage. The delivery panel lists per-message status, refreshed every 5 seconds, and exports to CSV.

In Bulk Messaging mode the campaign card reports recipients **accepted**, not sent — the API answers `202` before any message leaves, so "accepted" is the honest word for what just happened. Delivery is reported separately by the stats block: `delivered`, `read`, `undelivered`, `failed` and `unaddressable`, polled on the same 5-second timer. Per-recipient rows are fetched only when the delivery panel is opened or a CSV export is requested, not on every poll — a 10,000-recipient operation is too large to pull down repeatedly just to refresh a summary.

## Channels

| Channel | Sender | Content templates |
| --- | --- | --- |
| SMS | Twilio phone number | templates defining `twilio/text` |
| MMS | MMS-capable number | templates defining `twilio/media` |
| RCS | RCS agent | text, media, card, carousel, quick-reply |
| WhatsApp | WhatsApp-enabled sender, approved for messaging | any template, subject to Meta approval status |
| Facebook Messenger | Facebook Page ID | not supported |

A Messaging Service can be used as the sender on any channel. WhatsApp senders and recipients are auto-prefixed with `whatsapp:`, so either form works.

This table describes what Programmable Messaging supports. Bulk Messaging mode offers the same four channels except Facebook Messenger, and cannot take a Messaging Service as the sender — see [Two sending APIs](#two-sending-apis).

### How SMS and MMS templates are filtered

Both channels render exactly one content type — `twilio/text` for SMS, `twilio/media` for MMS — so the picker lists only templates defining it. A template defining both appears under each channel.

Templates carrying richer types (card, carousel, quick-reply) are still listed, because Twilio delivers the most complex translation the destination channel supports; over SMS or MMS that is the text or media translation. The preview and variable inputs are narrowed to that translation, so what you see is what the recipient receives — a card's copy is not previewed on SMS, and a media-URL variable is not prompted for on a channel that drops the media.

A template with no type the channel can render is omitted rather than offered, since sending it fails with [error 216602](https://www.twilio.com/docs/api/errors/216602).

## How resumable execution works

Messages are processed in chunks of 100. `send-messages.js` keeps going until it approaches a 9-second budget (inside the platform's 10-second ceiling), then saves the current index to Sync and returns. The page calls back in to continue from that checkpoint until the Function reports completion.

**The browser drives that loop** — `sendMessagesBatch()` in `assets/app.js`, not a Twilio-side scheduler. This follows from never storing user credentials server-side: the Functions receive a Client ID and Secret per request and keep nothing, so no queue or cron could authenticate a continuation. Hence the tab must stay open. Making sending fire-and-forget would mean granting the deployment standing authorization to send on the user's behalf.

None of this applies to Bulk Messaging mode. `send-bulk.js` submits the whole campaign in one request and returns; there is no loop in the browser to drive, and so nothing to check in on or resume.

## Architecture

```
functions/
  verify.js                 Validates OAuth credentials at sign-in
  send-messages.js          Chunked sending, checkpointed to Sync
  resume-execution.js       Continues a campaign from its last checkpoint
  check-status.js           Campaign status, re-fetching each message from Twilio
  send-bulk.js              One-request sending via the Bulk Messaging API
  check-bulk-status.js      Bulk operation stats, and recipients on demand
  get-phone-numbers.js      Senders for the selected channel and mode
  get-content-templates.js  Template picker, scoped per channel
  list-campaigns.js         Campaign history
  webhook.protected.js      Delivery-status callbacks (signature-validated)
assets/
  index.html  app.js  styles.css
  twilio-oauth.private.js   Shared OAuth client helper (private, not web-reachable)
  twilio-comms.private.js   comms.twilio.com client (no SDK support exists)
  bulk-payload.private.js   Pure request mapping for the Bulk API
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

- **`sessionStorage` is readable by JavaScript on the page.** Any XSS on the deployed origin can exfiltrate it. OAuth does not remove that exposure — the Client Secret sits where the Auth Token used to. What changes is blast radius and revocability: the app is scoped to Messaging, Phone Numbers and Content (plus Comms, if Bulk Messaging mode is granted), and its secret rotates independently of the account's master credential. Access tokens are never stored.
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

**Bulk mode rejects the sender.** A Messaging Service cannot be used as a bulk sender — the Bulk API's `from` accepts a phone number, a sender, or a sender pool, and a Messaging Service is none of those. Pick a phone number or sender pool, or switch to Programmable Messaging.

**Bulk mode returns 401 but sign-in worked.** Sign-in only proves the Messaging and Phone Numbers scopes. Bulk Messaging authenticates against `comms.twilio.com`, which needs the Comms scopes granted separately on the OAuth app.

## License

[MIT](LICENSE) © Abel Ng
