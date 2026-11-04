const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * POST /send-messages — stores a classic campaign's recipient list, one slice
 * per call, and starts sending once all of it is stored.
 *
 * A Function request is capped at 1 MB, so the browser sends the list in
 * slices, each starting at the storedCount the previous call returned. The
 * first slice creates the campaign. Sending then carries on through
 * resume-execution. See classic-campaign.private.js for the storage layout.
 */

/**
 * No recipient write starts after this. A slice that completes the list then
 * has the rest of the 9-second budget to start sending.
 */
const STORE_DEADLINE_MS = 6000;

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000; // 9 seconds to leave buffer

  try {
    const {
      messages,
      campaignId,
      channel = 'sms',
      from,
      campaignName
    } = event;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      response.setStatusCode(400);
      response.setBody({ error: 'messages array is required' });
      return callback(null, response);
    }

    const offset = event.offset === undefined ? 0 : Number(event.offset);
    const totalMessages = event.totalMessages === undefined ? messages.length : Number(event.totalMessages);
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(totalMessages) || offset + messages.length > totalMessages) {
      response.setStatusCode(400);
      response.setBody({ error: 'offset and totalMessages must place this slice inside the campaign' });
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

    const ownerKey = oauth.ownerKeyFor(creds);

    // The runtime client is used for Sync only, never for the user's account.
    // autoRetry absorbs 429s from Sync's per-Map write rate.
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN, { autoRetry: true, maxRetries: 3 });
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    const campaignDocName = campaignId || `campaign_${Date.now()}`;
    let existing = null;
    try {
      existing = await syncClient.documents(campaignDocName).fetch();
    } catch (error) {
      // 20404 is "document not found"; anything else is a real failure.
      if (error.status !== 404 && error.code !== 20404) {
        throw error;
      }
    }

    // 404 rather than 403 for another app's campaign, so a guessed ID is not
    // confirmed to exist. Same `!data` guard as list-campaigns.js and
    // check-status.js.
    const owned = Boolean(existing && existing.data) && existing.data.ownerKey === ownerKey;
    if (existing && !owned) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    const storeDeadline = startTime + STORE_DEADLINE_MS;
    let campaignData;

    if (offset === 0) {
      if (existing) {
        response.setStatusCode(409);
        response.setBody({ error: 'This campaign already exists. Resume it from the campaigns list.' });
        return callback(null, response);
      }

      // The first slice decides which fields are stored once, on the Document;
      // later slices are packed against the same set. The Document is created
      // after the first slice is stored, so a failure here leaves nothing that
      // points at a half-written list.
      const shared = storage.sharedFields(messages);
      await storage.createMaps(syncClient, campaignDocName);
      const storedCount = await storage.storeRecipients(syncClient, campaignDocName, messages, {
        startIndex: 0, shared, deadline: storeDeadline,
      });

      campaignData = storage.newCampaignData({
        ownerKey,
        accountSid: client.accountSid,
        totalMessages,
        shared,
        channel,
        from,
        campaignName,
        // What the campaign was sent with, for the card and the delivery panel.
        // Body and variables are not repeated here: `shared` holds them when
        // every recipient had the same ones.
        details: campaignDetails.buildDetails(event.details, {
          mode: 'classic',
          contentSid: messages[0] && messages[0].contentSid,
          recipientCount: totalMessages,
        }),
        now: new Date().toISOString(),
      });
      campaignData.storedCount = storedCount;
      await syncClient.documents.create({ uniqueName: campaignDocName, data: campaignData });
    } else {
      if (!existing) {
        response.setStatusCode(404);
        response.setBody({ error: 'Campaign not found' });
        return callback(null, response);
      }
      campaignData = existing.data;
      if (!storage.isBucketed(campaignData) || campaignData.storedCount !== offset) {
        response.setStatusCode(409);
        response.setBody({
          error: 'This slice does not continue the campaign\'s recipient list.',
          storedCount: campaignData.storedCount
        });
        return callback(null, response);
      }

      campaignData.storedCount = await storage.storeRecipients(syncClient, campaignDocName, messages, {
        startIndex: offset, shared: campaignData.shared || {}, deadline: storeDeadline,
      });
      campaignData.lastUpdated = new Date().toISOString();
      await syncClient.documents(campaignDocName).update({ data: campaignData });
    }

    // Nothing is sent until the whole list is stored, so a campaign whose
    // upload is cut off has sent nothing and can simply be sent again.
    const startIndex = campaignData.startIndex || 0;
    let outcome = { resumeFrom: startIndex, results: [], checkpointFailed: false };
    if (storage.isFullyStored(campaignData)) {
      outcome = await storage.runChunks({
        syncClient,
        campaignId: campaignDocName,
        campaignData,
        startIndex,
        deadline: startTime + MAX_EXECUTION_TIME,
        send: (batch, index) => classicMessages.sendChunk(client, batch, {
          startIndex: index,
          channel: campaignData.channel,
          from: campaignData.from,
          messagingServiceSid: context.MESSAGING_SERVICE_SID,
        }),
      });
    }

    response.setStatusCode(200);
    response.setBody(storage.progressBody(campaignDocName, campaignData, startIndex, outcome));
    return callback(null, response);
  } catch (error) {
    console.error('Send messages error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to send messages',
      message: error.message
    });
    return callback(null, response);
  }
};
