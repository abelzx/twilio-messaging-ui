# Twilio Messaging UI

A modern web application for sending messages through Twilio's Programmable Messaging API with support for all messaging channels (SMS, WhatsApp, Facebook Messenger). Built with Twilio Serverless Functions and Assets, featuring resumable execution to handle the 10-second function timeout limit.

## Features

- **Multi-Channel Support**: Send messages via SMS, WhatsApp, and Facebook Messenger
- **OAuth Authentication**: Sign in with an account-level [OAuth app](https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps) using the Client Credentials grant — scoped, independently revocable, and never stored server-side
- **Resumable Execution**: Automatically handles 10-second function timeout by chunking messages and resuming from checkpoints
- **Progress Tracking**: Real-time campaign status updates using Twilio Sync
- **Modern UI**: Clean, responsive interface built with vanilla JavaScript
- **State Management**: Uses Twilio Sync to store campaign progress. No user credential is stored server-side.

## Architecture

### Serverless Functions

1. **verify.js**: Validates OAuth credentials at sign-in — a token fetch plus a phone-number read, persisting nothing
2. **send-messages.js**: Sends messages in chunks, tracking progress in Twilio Sync
3. **check-status.js**: Retrieves campaign status and updates message statuses from Twilio
4. **resume-execution.js**: Resumes interrupted campaigns from the last checkpoint
5. **get-phone-numbers.js** / **get-content-templates.js** / **list-campaigns.js**: Populate the From dropdown, the template picker, and the campaign list
6. **webhook.js**: Receives delivery-status callbacks from Twilio

The first five receive `accountSid`, `clientId` and `clientSecret` in their POST body and build a per-request Twilio client through `assets/twilio-oauth.private.js`. `webhook.js` is the exception: Twilio calls it, not the browser, so it carries no user credentials and uses only the injected runtime credentials. Those runtime credentials (`context.ACCOUNT_SID` / `context.AUTH_TOKEN`) are used for Twilio Sync access throughout, never for the user's own account.

### Frontend

- Single-page application with login and messaging interface
- Real-time status updates and progress tracking
- Automatic resume functionality for interrupted campaigns

### Timeout Handling

The application processes messages in chunks of 100 at a time. If execution approaches the 10-second limit, it:
1. Saves progress to Twilio Sync
2. Returns the current state to the frontend
3. Automatically resumes from the last checkpoint
4. Continues until all messages are sent

## Prerequisites

1. **Twilio Account**: Sign up at [twilio.com](https://www.twilio.com)
2. **Twilio CLI**: Install the [Twilio CLI](https://www.twilio.com/docs/twilio-cli/quickstart)
3. **Node.js**: Version 14 or higher

## Setup

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd messaging-ui
npm install
```

### 2. Configure Environment Variables

Only needed for **local development**. Create a `.env` file in the root directory containing the *deployment's* own credentials — these are used for Twilio Sync access, and are unrelated to the OAuth credentials each user signs in with:

```env
ACCOUNT_SID=your_account_sid
AUTH_TOKEN=your_auth_token
```

`.env` is gitignored. There is no `.env.example` to copy.

**Note**: When deploying to Twilio, you don't need to set `ACCOUNT_SID` and `AUTH_TOKEN` in `.env` as the Functions runtime provides these automatically.

### 3. Deploy to Twilio

```bash
twilio login
twilio serverless:deploy
```

After deployment, you'll receive a URL like:
```
https://your-service-12345-dev.twil.io/index.html
```

### 4. Local Development (Optional)

To run locally:

```bash
twilio serverless:start
```

Then visit `http://localhost:3000/index.html`

## Usage

### 1. Sign In

First, create an account-level OAuth app: **Twilio Console → Account → API keys & tokens → OAuth apps → Create**. Grant it Messaging (read and write), Phone Numbers (read), and Content (read). Copy the **Client ID** and **Client Secret** — the secret is shown only once.

1. Open the application URL
2. Enter three values:
   - **Account SID** (`AC…`) — an identifier, not a credential. It is required because Twilio's Messaging and Phone Numbers endpoints embed it in the request path.
   - **OAuth Client ID**
   - **OAuth Client Secret**
3. Click "Sign In"

Credentials are held in the browser's `sessionStorage` for the life of the tab and sent with each request. Nothing is written to disk and nothing is stored server-side.

### 2. Send Messages

1. Select the messaging channel (SMS, WhatsApp, or Messenger)
2. Enter your "From" number or ID:
   - **SMS**: `+1234567890`
   - **WhatsApp**: `whatsapp:+1234567890` or just `+1234567890` (will be auto-formatted)
   - **Messenger**: Your Facebook Page ID
3. Enter your message body
4. Enter recipient numbers (one per line or comma-separated)
5. Click "Send Messages"

### 3. Monitor Progress

- The campaign status card shows:
  - Total messages sent
  - Failed messages
  - Pending messages
  - Progress percentage
- If execution is interrupted, click "Resume Campaign" to continue

## Channel-Specific Requirements

### SMS
- Requires a Twilio phone number
- Format: `+1234567890`

### WhatsApp
- Requires WhatsApp-enabled Twilio number
- Format: `whatsapp:+1234567890` or `+1234567890` (auto-formatted)
- Must be approved for WhatsApp messaging

### Facebook Messenger
- Requires a Facebook Page connected to your Twilio account
- Uses Messaging Service SID (configured in environment or per message)
- Format: Facebook Page ID

## How Resumable Execution Works

1. **Chunking**: Messages are processed in batches of 100
2. **Progress Tracking**: Each chunk's progress is saved to Twilio Sync
3. **Timeout Detection**: Function monitors execution time (9-second limit)
4. **Checkpointing**: Before timeout, saves current index to Sync
5. **Resume**: Next execution starts from the saved checkpoint
6. **Completion**: Process continues until all messages are sent

## Security Considerations

- **No user credential is stored server-side** — not in Twilio Sync, not in environment variables, not in logs. Earlier versions of this app wrote the user's Auth Token into a Sync Document; that store is gone.
- Credentials travel over HTTPS in POST request bodies only, never in query strings. Twilio Functions do not log request bodies and Twilio Serverless does not serve plaintext HTTP.
- A fresh Twilio client is built per request, so nothing leaks between callers.
- Campaigns are owned by the OAuth Client ID that created them. Requesting another app's campaign returns 404 rather than 403, so a guessed campaign ID is not confirmed to exist.
- The deployment holds no credentials of its own beyond the runtime credentials used for Sync, so the public Function URLs cannot be used to spend the owner's balance.

Two limits are worth stating plainly:

- **`sessionStorage` is readable by JavaScript on the page.** Any XSS on the deployed origin can exfiltrate it. OAuth does not remove that exposure — the Client Secret sits where the Auth Token used to. What changes is blast radius and revocability: the app is scoped to Messaging and Phone Numbers, and its secret rotates independently of the account's master credential. Access tokens are never stored.
- **The Function URLs are public.** Anyone with the URL can use the tool, but only with OAuth credentials they already hold.

## Project Structure

```
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
└── README.md
```

## Environment Variables

### Required (for local development)
- `ACCOUNT_SID`: Your Twilio Account SID
- `AUTH_TOKEN`: Your Twilio Auth Token

### Optional
- `SYNC_SERVICE_SID`: Custom Sync Service SID (auto-created if not provided)
- `MESSAGING_SERVICE_SID`: Messaging Service SID for Messenger

## Troubleshooting

### Sign-In Fails

- *"Invalid OAuth credentials"* — check the Client ID and Client Secret, and that the secret has not been rotated. The secret is shown only once at creation; if it was lost, create a new one.
- *"Those OAuth credentials are valid, but they do not grant access to that Account SID"* (Twilio error 70051) — the credentials work, but not against this account. Either the Account SID is mistyped, or the OAuth app lacks the Phone Numbers read scope.
- *"Those OAuth credentials do not belong to that Account SID"* — the same underlying mistake reported via a plain HTTP 401 rather than error 70051, usually an OAuth app created under a different account or subaccount.
- *"That Account SID was not found"* (Twilio error 20404) — check the SID against the Console dashboard.
- *"Twilio's token endpoint did not respond in time"* — a transient upstream problem, not a credential problem. Try again.

Sign-in deliberately reads one phone number to prove the credentials match the Account SID. That is why a missing Phone Numbers read scope fails sign-in even with a valid Client ID and Secret.

### Template Picker Is Empty

If the OAuth app lacks Content read scope, the picker falls back to "None (Use custom message)" and shows the error in red. Both channels still send with a literal message body; only the template picker is lost.

### Messages Not Sending
- Verify your "From" number is correct for the selected channel
- For WhatsApp, ensure your number is approved
- Check Twilio Console for error logs

### Sync Service Errors
- Ensure Sync API is enabled in your Twilio account
- Check that your account has Sync service permissions
- Verify runtime credentials have Sync access

### Timeout Issues
- The function automatically handles timeouts
- If issues persist, reduce `CHUNK_SIZE` in `send-messages.js`
- Check function logs in Twilio Console

## Limitations

- Function execution time limit: 10 seconds (handled via chunking)
- A session lasts as long as the browser tab. Closing it requires signing in again.
- Rate limits: Subject to Twilio's messaging rate limits
- Large campaigns: May take multiple function invocations to complete

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - feel free to use this project for your own purposes.

## Support

For issues related to:
- **This application**: Open an issue in the repository
- **Twilio API**: Check [Twilio Documentation](https://www.twilio.com/docs)
- **Twilio Support**: Contact [Twilio Support](https://support.twilio.com)

