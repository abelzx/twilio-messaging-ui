const twilio = require('twilio');

/**
 * Webhook endpoint to capture message status updates
 * Handles delivery status, read receipts, and other status callbacks
 *
 * `.protected.js`: the Serverless runtime rejects any request without a valid
 * X-Twilio-Signature, and the visibility keyword is stripped from the path, so
 * this still serves at /webhook and the statusCallback URLs need no change.
 * Without it the handler is an unauthenticated writer — the loop below scans
 * every campaign document and updates whichever holds the posted MessageSid,
 * with none of the ownerKey checks that guard check-status and list-campaigns,
 * so a forged callback could rewrite delivery state for any campaign here.
 *
 * Signatures are validated against the deployment's own auth token. A user
 * signed in with OAuth credentials for a DIFFERENT account therefore has their
 * callbacks rejected, since Twilio signs them with the sending account's token.
 * That costs nothing: check-status.js re-fetches each message from Twilio on
 * the 5s poll, so this webhook only ever made statuses fresher, sooner.
 */
exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'text/xml');

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

    // Deliberately narrow: a status callback carries To and From, so dumping the
    // whole event — as this did — wrote recipient numbers into the Function logs
    // on every delivery receipt. SID, status and error code are enough to debug
    // with, and none of them identify a person. ErrorMessage is still recorded
    // in Sync for the UI; it just does not belong in logs.
    console.log(`Status callback: ${messageSid || '(no sid)'} -> ${status || '(no status)'}`
      + (ErrorCode ? ` [error ${ErrorCode}]` : ''));

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

