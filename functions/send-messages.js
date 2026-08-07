const twilio = require('twilio');

/**
 * Send messages endpoint with chunking and timeout handling
 * Uses Twilio Sync to track progress and enable resumable execution
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
      sessionId, 
      messages, 
      campaignId,
      channel = 'sms',
      from,
      resumeFrom = 0,
      campaignName
    } = event;

    if (!sessionId || !messages || !Array.isArray(messages) || messages.length === 0) {
      response.setStatusCode(400);
      response.setBody({ error: 'sessionId and messages array are required' });
      return callback(null, response);
    }

    // Get credentials from Sync using runtime credentials
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);
    
    const credentialsDoc = await syncClient.documents(`credentials_${sessionId}`).fetch();
    const credentials = credentialsDoc.data;

    // Initialize Twilio client with user credentials
    let client;
    if (credentials.authToken) {
      client = twilio(credentials.accountSid, credentials.authToken);
    } else if (credentials.apiKey && credentials.apiSecret) {
      client = twilio(credentials.apiKey, credentials.apiSecret, { 
        accountSid: credentials.accountSid 
      });
    } else {
      throw new Error('Invalid credentials');
    }

    // Get or create campaign document in Sync
    // Use campaignId directly if provided, otherwise create a new one with prefix
    const campaignDocName = campaignId || `campaign_${Date.now()}`;
    let campaignDoc;
    try {
      campaignDoc = await syncClient.documents(campaignDocName).fetch();
    } catch (error) {
      // Create new campaign document
      // Store messages array and metadata for resume functionality
      campaignDoc = await syncClient.documents.create({
        uniqueName: campaignDocName,
        data: {
          accountSid: credentials.accountSid,
          totalMessages: messages.length,
          sent: 0,
          failed: 0,
          pending: messages.length,
          statuses: {},
          startIndex: resumeFrom,
          messages: messages, // Store messages for resume
          channel: channel, // Store channel for resume
          from: from, // Store from number/ID for resume
          campaignName: campaignName || null, // Store campaign name
          createdAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        }
      });
    }
    
    // Ensure accountSid is set (for existing campaigns)
    if (!campaignDoc.data.accountSid) {
      campaignDoc.data.accountSid = credentials.accountSid;
    }
    
    // Ensure messages and metadata are stored (for existing campaigns that might not have them)
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

          // Add channel-specific parameters
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

async function getOrCreateSyncService(client) {
  try {
    // Try to find existing service
    const services = await client.sync.v1.services.list({ limit: 20 });
    const existingService = services.find(s => s.friendlyName === 'Messaging UI Sync Service');
    if (existingService) {
      return existingService.sid;
    }
    
    // Create new service if not found
    const service = await client.sync.v1.services.create({
      friendlyName: 'Messaging UI Sync Service'
    });
    return service.sid;
  } catch (error) {
    console.error('Error getting/creating Sync service:', error);
    // If we can't create/get Sync service, try to continue with first available
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

