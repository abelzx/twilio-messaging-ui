const twilio = require('twilio');

/**
 * Get SMS-enabled phone numbers from Twilio account
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

    // Fetch all phone numbers
    const phoneNumbers = await client.incomingPhoneNumbers.list({ limit: 100 });
    
    // Filter for SMS-capable numbers and format them
    const smsNumbers = phoneNumbers
      .filter(number => {
        // Check if number has SMS capability
        const capabilities = number.capabilities || {};
        return capabilities.sms === true || capabilities.sms === 'true';
      })
      .map(number => ({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName || number.phoneNumber,
        sid: number.sid,
        capabilities: number.capabilities
      }));

    response.setStatusCode(200);
    response.setBody({
      success: true,
      phoneNumbers: smsNumbers
    });

    return callback(null, response);
  } catch (error) {
    console.error('Get phone numbers error:', error);
    response.setStatusCode(500);
    response.setBody({ 
      error: 'Failed to fetch phone numbers',
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

