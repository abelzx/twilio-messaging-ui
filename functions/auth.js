const twilio = require('twilio');

/**
 * Authentication endpoint
 * Supports login with Account SID + Auth Token OR API Key + API Secret
 */
exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  // Handle CORS preflight
  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  try {
    const { accountSid, authToken, apiKey, apiSecret } = event;

    if (!accountSid) {
      response.setStatusCode(400);
      response.setBody({ error: 'Account SID is required' });
      return callback(null, response);
    }

    let client;
    
    // Try Account SID + Auth Token first
    if (authToken) {
      client = twilio(accountSid, authToken);
    } 
    // Try API Key + API Secret
    else if (apiKey && apiSecret) {
      client = twilio(apiKey, apiSecret, { accountSid });
    } 
    else {
      response.setStatusCode(400);
      response.setBody({ error: 'Either Auth Token or API Key/Secret pair is required' });
      return callback(null, response);
    }

    // Verify credentials by making a simple API call
    await client.api.accounts(accountSid).fetch();

    // Store credentials securely in Twilio Sync
    // Use runtime credentials for Sync operations
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);
    
    // Generate a session token
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store credentials in Sync (encrypted)
    const credentials = {
      accountSid,
      authToken: authToken || null,
      apiKey: apiKey || null,
      apiSecret: apiSecret || null,
      createdAt: new Date().toISOString()
    };

    await syncClient.documents.create({
      uniqueName: `credentials_${sessionId}`,
      data: credentials,
      ttl: 3600 // 1 hour TTL
    });

    response.setStatusCode(200);
    response.setBody({
      success: true,
      sessionId,
      accountSid
    });

    return callback(null, response);
  } catch (error) {
    console.error('Authentication error:', error);
    response.setStatusCode(401);
    response.setBody({ 
      error: 'Authentication failed',
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

