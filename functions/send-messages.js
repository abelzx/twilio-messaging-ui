const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

/**
 * POST /send-messages — sends a chunk of messages via the caller's OAuth app,
 * with chunking and timeout handling.
 * Uses Twilio Sync to track progress and enable resumable execution.
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

  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000; // 9 seconds to leave buffer
  const CHUNK_SIZE = 100; // Process 100 messages at a time for full-speed sending

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
          accountSid: client.accountSid, // display only; never an authorization key
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

    const campaignData = campaignDoc.data;
    let currentIndex = resumeFrom || campaignData.startIndex || 0;
    const results = [];
    let hasMore = true;

    // Process messages in chunks until timeout or completion
    while (hasMore && (Date.now() - startTime) < MAX_EXECUTION_TIME) {
      const chunk = messages.slice(currentIndex, currentIndex + CHUNK_SIZE);
      
      if (chunk.length === 0) {
        hasMore = false;
        break;
      }

      // Process chunk in parallel with retry logic for rate limits
      const chunkPromises = chunk.map(async (message, idx) => {
        const actualIndex = currentIndex + idx;
        try {
          // Use DOMAIN_NAME environment variable for webhook URL (default Twilio env var)
          const webhookUrl = `https://${context.DOMAIN_NAME}/webhook`;
          //console.log('Status callback URL:', webhookUrl);
          //console.log('DOMAIN_NAME from context:', context.DOMAIN_NAME);
          
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

            // Content template variable values, e.g. {"1": "Sarah", "2": "10am"}
            if (message.contentVariables) {
              messageParams.contentVariables = typeof message.contentVariables === 'string'
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

      // Update campaign status
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
          // A rejected create() has no message SID, so it is keyed by its
          // position in the array — stable, so re-running a chunk overwrites
          // rather than duplicates. Without an entry here the failure was
          // invisible twice over: check-status.js recomputes `failed` purely
          // from this map, so it reset the count to zero, and the delivery
          // table renders from this map, so the row never appeared. A number
          // rejected for not being E.164 reported as "0 failed, no results".
          campaignData.statuses[`failed-${result.index}`] = {
            status: 'failed',
            to: result.to,
            errorCode: result.errorCode || null,
            errorMessage: result.error || 'Twilio rejected the message',
            sentAt: new Date().toISOString()
          };
        }
      });

      currentIndex += chunk.length;
      campaignData.sent = sent;
      campaignData.failed = failed;
      campaignData.pending = campaignData.totalMessages - sent - failed;
      campaignData.startIndex = currentIndex;
      campaignData.lastUpdated = new Date().toISOString();

      // Update Sync document
      await syncClient.documents(campaignDocName).update({
        data: campaignData
      });

      // Check if we've processed all messages
      if (currentIndex >= messages.length) {
        hasMore = false;
      }
    }

    const isComplete = currentIndex >= messages.length;
    const timeRemaining = MAX_EXECUTION_TIME - (Date.now() - startTime);

    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaignId: campaignDocName,
      processed: currentIndex - resumeFrom,
      totalProcessed: currentIndex,
      totalMessages: messages.length,
      isComplete,
      hasMore: !isComplete,
      resumeFrom: currentIndex,
      results: results.slice(-CHUNK_SIZE), // Return last chunk results
      stats: {
        sent: campaignData.sent,
        failed: campaignData.failed,
        pending: campaignData.pending
      },
      timeRemaining
    });

    return callback(null, response);
  } catch (error) {
    console.error('Send messages error:', error);
    response.setStatusCode(500);
    response.setBody({ 
      error: 'Failed to send messages',
      message: error.message 
    });
    return callback(null, response);
  }
};

