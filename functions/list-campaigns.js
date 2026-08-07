const twilio = require('twilio');

/**
 * List all campaigns for a given Account SID
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
    const { sessionId } = event;

    if (!sessionId) {
      response.setStatusCode(400);
      response.setBody({ error: 'sessionId is required' });
      return callback(null, response);
    }

    // Get credentials from Sync using runtime credentials
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);
    
    const credentialsDoc = await syncClient.documents(`credentials_${sessionId}`).fetch();
    const credentials = credentialsDoc.data;
    const accountSid = credentials.accountSid;

    // List all documents in Sync service
    const documents = await syncClient.documents.list({ limit: 1000 });
    
    // Filter campaign documents for this account
    const campaigns = [];
    for (const doc of documents) {
      if (doc.uniqueName && doc.uniqueName.startsWith('campaign_')) {
        const campaignData = doc.data;
        
        // Only include campaigns for this account SID
        if (campaignData.accountSid === accountSid) {
          // Calculate delivered and read counts
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
      }
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

