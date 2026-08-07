# Twilio Messaging UI

A modern web application for sending messages through Twilio's Programmable Messaging API with support for all messaging channels (SMS, WhatsApp, Facebook Messenger). Built with Twilio Serverless Functions and Assets, featuring resumable execution to handle the 10-second function timeout limit.

## Features

- **Multi-Channel Support**: Send messages via SMS, WhatsApp, and Facebook Messenger
- **Flexible Authentication**: Login with Account SID + Auth Token OR API Key + API Secret
- **Resumable Execution**: Automatically handles 10-second function timeout by chunking messages and resuming from checkpoints
- **Progress Tracking**: Real-time campaign status updates using Twilio Sync
- **Modern UI**: Clean, responsive interface built with vanilla JavaScript
- **State Management**: Uses Twilio Sync to store campaign progress and credentials securely

## Architecture

### Serverless Functions

1. **auth.js**: Handles user authentication with Account SID/Auth Token or API Key/Secret
2. **send-messages.js**: Sends messages in chunks, tracking progress in Twilio Sync
3. **check-status.js**: Retrieves campaign status and updates message statuses from Twilio
4. **resume-execution.js**: Resumes interrupted campaigns from the last checkpoint

### Frontend

- Single-page application with login and messaging interface
- Real-time status updates and progress tracking
- Automatic resume functionality for interrupted campaigns

### Timeout Handling

The application processes messages in chunks of 10 messages at a time. If execution approaches the 10-second limit, it:
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

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

For **local development**, add your Twilio credentials:

```env
ACCOUNT_SID=your_account_sid
AUTH_TOKEN=your_auth_token
```

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

### 1. Login

1. Open the application URL
2. Choose authentication method:
   - **Account SID + Auth Token**: Use your main Twilio credentials
   - **API Key + Secret**: Use a Twilio API Key (recommended for production)
3. Enter your credentials and click "Login"

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

1. **Chunking**: Messages are processed in batches of 10
2. **Progress Tracking**: Each chunk's progress is saved to Twilio Sync
3. **Timeout Detection**: Function monitors execution time (9-second limit)
4. **Checkpointing**: Before timeout, saves current index to Sync
5. **Resume**: Next execution starts from the saved checkpoint
6. **Completion**: Process continues until all messages are sent

## Security Considerations

- Credentials are stored in Twilio Sync with 1-hour TTL
- Use API Keys instead of Auth Tokens for better security
- Sync documents are scoped to the session
- Consider implementing additional security measures for production

## Project Structure

```
messaging-ui/
├── functions/
│   ├── auth.js              # Authentication endpoint
│   ├── send-messages.js     # Message sending with chunking
│   ├── check-status.js      # Campaign status checker
│   └── resume-execution.js  # Resume interrupted campaigns
├── assets/
│   ├── index.html          # Main HTML file
│   ├── app.js              # Frontend JavaScript
│   └── styles.css          # Styling
├── package.json
├── twilio.json             # Twilio Serverless configuration
├── .env.example
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

### Authentication Fails
- Verify your Account SID and Auth Token/API Key are correct
- Ensure your Twilio account is active
- Check that API Keys have proper permissions

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
- Sync document TTL: 1 hour for credentials
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

