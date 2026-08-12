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
  const startTime = Date.now();
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
      resumeFrom: campaignData.startIndex || 0,
      // Pass the handler's own start time down. Measuring from inside
      // sendMessagesChunk would exclude the token exchange and the ownership
      // fetch above it, so the 9s ceiling would no longer bound total elapsed
      // time — the exact accounting send-messages.js gets right by capturing
      // startTime at the top of its handler.
      startTime
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
    resumeFrom,
    startTime
  } = params;

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

          // contentVariables MUST travel with contentSid. send-messages.js does
          // this (lines 207-210); the pre-migration version of this file did not,
          // so a resumed chunk of a personalised template campaign sent the
          // template with its placeholders unfilled. app.js puts the variables on
          // every message object, so the data was there — it was simply dropped.
          if (message.contentVariables) {
            messageParams.contentVariables =
              typeof message.contentVariables === 'string'
                ? message.contentVariables
                : JSON.stringify(message.contentVariables);
          }
        }

        // Resolve the sender BEFORE any channel prefixing. A Messaging Service is
        // chosen by SID and must travel as messagingServiceSid — never as From, and
        // never with a channel prefix glued to it. This was inside the messenger
        // branch until a service became selectable on every channel; left there,
        // picking one for WhatsApp produced from: "whatsapp:MG7f6b…".
        const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;
        const usingService = MESSAGING_SERVICE_SID.test(String(messageParams.from || ''));
        if (usingService) {
          messageParams.messagingServiceSid = String(messageParams.from);
          delete messageParams.from;
        }

        // The recipient always takes the channel prefix. From only takes it when a
        // concrete sender was chosen — a service SID must stay bare.
        if (channel === 'whatsapp') {
          const wa = (v) => (String(v).startsWith('whatsapp:') ? String(v) : `whatsapp:${v}`);
          messageParams.to = wa(messageParams.to);
          if (messageParams.from) messageParams.from = wa(messageParams.from);
        } else if (channel === 'messenger') {
          const ms = (v) => (String(v).startsWith('messenger:') ? String(v) : `messenger:${v}`);
          messageParams.to = ms(messageParams.to);
          if (messageParams.from) messageParams.from = ms(messageParams.from);
          if (!usingService) {
            const svc = message.messagingServiceSid || context.MESSAGING_SERVICE_SID;
            if (svc) messageParams.messagingServiceSid = svc;
          }
        } else if (channel === 'mms' || channel === 'rcs') {
          if (message.mediaUrl) {
            messageParams.mediaUrl = Array.isArray(message.mediaUrl) ? message.mediaUrl : [message.mediaUrl];
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
