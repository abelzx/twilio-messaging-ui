const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * POST /resume-execution — sends the next chunks of an existing classic campaign.
 *
 * Recipients come from the campaign's Sync storage, not from the caller. The
 * server still never resumes a campaign on its own: the browser calls this
 * until the campaign completes. That is what keeps credentials in the browser
 * rather than server-side. See docs/superpowers/specs/2026-08-07-oauth-login-design.md
 */

/**
 * A campaign stored before classic-campaign.private.js keeps its list inline.
 * One that outgrew its Document mid-send recorded a startIndex behind what was
 * actually sent, so resuming it could message recipients twice.
 */
const LEGACY_CAMPAIGN = 'This campaign was saved in an older format and cannot be resumed. ' +
  'Its saved progress may be behind what was actually sent, so check the Messaging logs in the ' +
  'Twilio Console before sending the rest as a new campaign.';

const INCOMPLETE_UPLOAD = 'This campaign\'s recipient list was not fully saved, so it cannot be resumed. ' +
  'Nothing was sent; send it again as a new campaign.';

exports.handler = async function(context, event, callback) {
  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000;
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const { campaignId } = event;

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
    // autoRetry absorbs 429s from Sync's per-Map write rate.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN, { autoRetry: true, maxRetries: 3 });
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

    const refusal = campaignData.mode === 'bulk'
      ? 'Bulk Messaging campaigns run on Twilio and are never resumed.'
      : !storage.isBucketed(campaignData) ? LEGACY_CAMPAIGN
      : !storage.isFullyStored(campaignData) ? INCOMPLETE_UPLOAD
      : null;
    if (refusal) {
      response.setStatusCode(409);
      response.setBody({ error: refusal });
      return callback(null, response);
    }

    // The browser passes back the resumeFrom it was last given. That can be
    // ahead of the stored index when a checkpoint failed after its chunk was
    // sent, and resuming from the stored index would send the chunk again. It
    // is never allowed behind the stored index: going back only ever re-sends.
    const hint = Number(event.resumeFrom);
    const startIndex = Math.max(
      campaignData.startIndex || 0,
      Number.isSafeInteger(hint) && hint <= campaignData.totalMessages ? hint : 0
    );

    const outcome = await storage.runChunks({
      syncClient,
      campaignId,
      campaignData,
      startIndex,
      // The handler's own start time, so the 9s ceiling bounds total elapsed
      // time including the token exchange and the fetch above.
      deadline: startTime + MAX_EXECUTION_TIME,
      send: (batch, index) => classicMessages.sendChunk(client, batch, {
        startIndex: index,
        channel: campaignData.channel,
        from: campaignData.from,
        messagingServiceSid: context.MESSAGING_SERVICE_SID,
      }),
    });

    response.setStatusCode(200);
    response.setBody(storage.progressBody(campaignId, campaignData, startIndex, outcome));
    return callback(null, response);
  } catch (error) {
    console.error('Resume execution error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to resume execution',
      message: error.message
    });
    return callback(null, response);
  }
};
