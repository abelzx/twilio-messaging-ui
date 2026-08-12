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

    // Single source of truth for the derived counters. The webhook records
    // per-message status; this is the only place that counts them, so a badge
    // and a counter cannot disagree.
    //
    // Terminal failure is `failed` or `undelivered`. `undelivered` matters: Meta
    // rejecting a WhatsApp template (error 63049) lands here, and reporting that
    // as a success is worse than reporting nothing.
    const TERMINAL_FAILURE = new Set(['failed', 'undelivered']);

    let delivered = 0;
    let read = 0;
    let failed = 0;
    for (const statusInfo of Object.values(statusUpdates)) {
      const status = String(statusInfo.status || '').toLowerCase();
      if (statusInfo.delivered || status === 'delivered' || status === 'read') {
        delivered++;
      }
      if (statusInfo.read || status === 'read') {
        read++;
      }
      if (TERMINAL_FAILURE.has(status)) {
        failed++;
      }
    }

    campaignData.delivered = delivered;
    campaignData.read = read;
    campaignData.failed = failed;
    // Anything accepted by Twilio that has not yet reached a terminal state.
    // Clamped at zero: a chunk sent twice inflates `sent` past the recipient
    // count, and a negative "pending" is noise rather than information.
    campaignData.pending = Math.max(0, (campaignData.sent || 0) - delivered - failed);

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

