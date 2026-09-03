/**
 * POST /list-campaigns — campaigns belonging to the calling OAuth app.
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

  let creds;
  try {
    creds = oauth.credsFrom(event);
    // This function makes no call against the user's own account — it only
    // reads Sync through the runtime client. It authenticates anyway, because
    // the ownerKey filter below rests on the caller actually holding the Client
    // ID they sent, and only a successful token exchange establishes that.
    // Skipping this would let anyone list another app's campaigns by sending
    // its Client ID with any secret.
    // The returned client is intentionally unused — this call exists solely as
    // the authorization step.
    await oauth.authenticate(creds);
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  const ownerKey = oauth.ownerKeyFor(creds);

  try {
    // The runtime client is used for Sync only, never for the user's account.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    const documents = await syncClient.documents.list({ limit: 1000 });

    const campaigns = [];
    for (const doc of documents) {
      if (!doc.uniqueName || !doc.uniqueName.startsWith('campaign_')) {
        continue;
      }

      const campaignData = doc.data;

      // `!campaignData` guard so one malformed document skips itself rather than
      // throwing and turning the caller's whole campaign list into a 500. Same
      // shape as the checks in check-status.js and resume-execution.js.
      if (!campaignData || campaignData.ownerKey !== ownerKey) {
        continue;
      }

      // Bulk campaigns keep aggregate stats rather than a per-message map, so
      // the counter arithmetic below would report zeroes for all of them.
      // `unaddressable` counts as a failure: Twilio could not reach the
      // recipient at all, which is not a pending state and never will be.
      if (campaignData.mode === 'bulk') {
        const stats = campaignData.stats || {};
        campaigns.push({
          campaignId: doc.uniqueName,
          mode: 'bulk',
          campaignName: campaignData.campaignName || null,
          channel: campaignData.channel || null,
          recipientCount: campaignData.recipientCount || 0,
          totalMessages: campaignData.recipientCount || 0,
          sent:
            Number(stats.sent || 0) +
            Number(stats.delivered || 0) +
            Number(stats.read || 0),
          delivered: Number(stats.delivered || 0) + Number(stats.read || 0),
          read: Number(stats.read || 0),
          failed:
            Number(stats.failed || 0) +
            Number(stats.undelivered || 0) +
            Number(stats.unaddressable || 0),
          pending: Number(stats.queued || 0) + Number(stats.scheduled || 0),
          isComplete: Boolean(campaignData.isComplete),
          scheduledFor: campaignData.scheduledFor || null,
          createdAt: campaignData.createdAt,
          lastUpdated: campaignData.lastUpdated,
        });
        continue;
      }

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
        mode: 'classic',
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
