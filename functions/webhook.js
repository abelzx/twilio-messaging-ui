const twilio = require('twilio');

/**
 * Webhook endpoint to capture message status updates
 * Handles delivery status, read receipts, and other status callbacks
 */
exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'text/xml');

  // Log all incoming status callback data
  console.log('=== Status Callback Received ===');
  console.log('Full event object:', JSON.stringify(event, null, 2));
  console.log('Context DOMAIN_NAME:', context.DOMAIN_NAME);
  console.log('Request method:', event.request?.method);
  console.log('Request URL:', event.request?.url);
  console.log('All event keys:', Object.keys(event));
  console.log('================================');

  try {
    const {
      MessageSid,
      MessageStatus,
      ErrorCode,
      ErrorMessage,
      SmsStatus,
      SmsSid
    } = event;

    // Use MessageSid or SmsSid
    const messageSid = MessageSid || SmsSid;
    const status = MessageStatus || SmsStatus;

    console.log('Extracted values:');
    console.log('  MessageSid:', MessageSid);
    console.log('  SmsSid:', SmsSid);
    console.log('  MessageStatus:', MessageStatus);
    console.log('  SmsStatus:', SmsStatus);
    console.log('  ErrorCode:', ErrorCode);
    console.log('  ErrorMessage:', ErrorMessage);
    console.log('  Final messageSid:', messageSid);
    console.log('  Final status:', status);

    if (!messageSid || !status) {
      console.log('WARNING: Missing messageSid or status, returning empty response');
      // Return empty TwiML response
      response.setBody('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return callback(null, response);
    }

    // Get runtime client for Sync operations
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    // Find the campaign document that contains this message SID
    // We'll search through all campaign documents (in production, you might want to optimize this)
    try {
      const documents = await syncClient.documents.list({ limit: 100 });
      
      for (const doc of documents) {
        if (doc.uniqueName && doc.uniqueName.startsWith('campaign_')) {
          const campaignData = doc.data;
          
          if (campaignData.statuses && campaignData.statuses[messageSid]) {
            // Update the status
            campaignData.statuses[messageSid] = {
              ...campaignData.statuses[messageSid],
              status: status,
              errorCode: ErrorCode || null,
              errorMessage: ErrorMessage || null,
              webhookReceivedAt: new Date().toISOString(),
              // Update delivery status based on status
              delivered: status === 'delivered' || status === 'read',
              read: status === 'read'
            };

            // Counters are derived in check-status.js from this statuses map, not
            // maintained here. Two writers meant two chances to double-count, and
            // the guard on the increments this replaced was inverted anyway: it
            // tested the object it had just overwritten, so it never fired.

            campaignData.lastUpdated = new Date().toISOString();

            // Update the Sync document
            await syncClient.documents(doc.uniqueName).update({
              data: campaignData
            });

            console.log(`Updated status for message ${messageSid} in campaign ${doc.uniqueName}: ${status}`);
            break;
          }
        }
      }
    } catch (error) {
      console.error('Error updating campaign status from webhook:', error);
      // Don't fail the webhook, just log the error
    }

    // Return TwiML response
    response.setBody('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return callback(null, response);
  } catch (error) {
    console.error('Webhook error:', error);
    // Always return a valid TwiML response even on error
    response.setBody('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
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

