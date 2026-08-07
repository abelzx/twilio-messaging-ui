/**
 * POST /check-status — campaign status, with per-message status refreshed
 * from Twilio.
 */

const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const campaignId = event.campaignId;

  if (!campaignId) {
    response.setStatusCode(400);
    response.setBody({ error: 'campaignId is required' });
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

