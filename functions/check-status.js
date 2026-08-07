const twilio = require('twilio');

/**
 * Check campaign status
 */
exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  try {
    const { campaignId, sessionId } = event;

    if (!campaignId || !sessionId) {
      response.setStatusCode(400);
      response.setBody({ error: 'campaignId and sessionId are required' });
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

    // Get campaign document
    const campaignDoc = await syncClient.documents(campaignId).fetch();
    const campaignData = campaignDoc.data;

    // Update message statuses from Twilio
    // Merge with existing webhook data to preserve delivered/read flags
    const statusUpdates = {};
    for (const [sid, statusInfo] of Object.entries(campaignData.statuses || {})) {
      try {
        const message = await client.messages(sid).fetch();
        statusUpdates[sid] = {
          ...statusInfo,
          status: message.status,
          errorCode: message.errorCode,
          errorMessage: message.errorMessage,
          dateSent: message.dateSent,
          dateUpdated: message.dateUpdated,
          // Preserve webhook-delivered flags
          delivered: statusInfo.delivered || message.status === 'delivered' || message.status === 'read',
          read: statusInfo.read || message.status === 'read'
        };
      } catch (error) {
        statusUpdates[sid] = {
          ...statusInfo,
          error: error.message
        };
      }
    }

    campaignData.statuses = statusUpdates;
    campaignData.lastUpdated = new Date().toISOString();

    // Calculate delivered and read counts
    let delivered = 0;
    let read = 0;
    for (const statusInfo of Object.values(statusUpdates)) {
      if (statusInfo.delivered || statusInfo.status === 'delivered') {
        delivered++;
      }
      if (statusInfo.read || statusInfo.status === 'read') {
        read++;
      }
    }
    campaignData.delivered = delivered;
    campaignData.read = read;

    // Update Sync document
    await syncClient.documents(campaignId).update({
      data: campaignData
    });

    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaign: {
        campaignId,
        totalMessages: campaignData.totalMessages,
        sent: campaignData.sent,
        failed: campaignData.failed,
        pending: campaignData.pending,
        delivered: campaignData.delivered || 0,
        read: campaignData.read || 0,
        startIndex: campaignData.startIndex,
        isComplete: campaignData.startIndex >= campaignData.totalMessages,
        createdAt: campaignData.createdAt,
        lastUpdated: campaignData.lastUpdated,
        statuses: statusUpdates,
        // Include resume data if available
        messages: campaignData.messages || null,
        channel: campaignData.channel || null,
        from: campaignData.from || null
      }
    });

    return callback(null, response);
  } catch (error) {
    console.error('Check status error:', error);
    response.setStatusCode(500);
    response.setBody({ 
      error: 'Failed to check status',
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

