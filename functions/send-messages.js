const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * POST /send-messages — sends one slice of a classic campaign's recipient list.
 *
 * The browser holds the list and sends it slice by slice, each call starting
 * where the last one reached; the first call creates the campaign. A call for a
 * campaign that exists must carry the same list, by fingerprint, so resuming
 * means sending the same list again. Chunks already claimed are skipped, so
 * nothing is sent twice. See classic-campaign.private.js.
 */

/**
 * No chunk starts after this. A chunk is up to 128 sends plus two writes of its
 * record, and must finish inside the 10-second ceiling.
 */
const SEND_DEADLINE_MS = 7000;

/** No send or 429 retry starts after this. */
const RETRY_DEADLINE_MS = 9000;

const FINGERPRINT = /^[0-9a-f]{64}$/;

const OLDER_FORMAT = 'This campaign was saved in an older format and cannot be continued. ' +
  'Check the Messaging logs in the Twilio Console for what was sent before sending the rest as a new campaign.';

const DIFFERENT_LIST = 'These recipients and messages do not match the campaign being continued. ' +
  'Load the same list with the same settings, or send it as a new campaign.';

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

    // Slices hold whole chunks, so a chunk is always sent from one call.
    const offset = event.offset === undefined ? 0 : Number(event.offset);
    const totalMessages = event.totalMessages === undefined ? messages.length : Number(event.totalMessages);
    const end = offset + messages.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % storage.CHUNK_SIZE !== 0 ||
        !Number.isSafeInteger(totalMessages) || end > totalMessages ||
        (messages.length % storage.CHUNK_SIZE !== 0 && end !== totalMessages)) {
      response.setStatusCode(400);
      response.setBody({ error: 'offset, totalMessages and the slice must cover whole chunks of the campaign' });
      return callback(null, response);
    }

    const fingerprint = String(event.fingerprint || '');
    if (!FINGERPRINT.test(fingerprint)) {
      response.setStatusCode(400);
      response.setBody({ error: 'fingerprint is required' });
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
    // confirmed to exist. Same `!data` guard as list-campaigns.js.
    if (existing && !(existing.data && existing.data.ownerKey === ownerKey)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    let campaignData;
    if (!existing) {
      if (offset !== 0) {
        response.setStatusCode(404);
        response.setBody({ error: 'Campaign not found' });
        return callback(null, response);
      }
      await storage.createChunksMap(syncClient, campaignDocName);
      campaignData = storage.newCampaignData({
        ownerKey,
        accountSid: client.accountSid,
        totalMessages,
        fingerprint,
        // For the card and the delivery panel: what every message had in common.
        shared: storage.sharedFields(messages),
        channel,
        from,
        campaignName,
        details: campaignDetails.buildDetails(event.details, {
          mode: 'classic',
          contentSid: messages[0] && messages[0].contentSid,
          recipientCount: totalMessages,
        }),
        now: new Date().toISOString(),
      });
      await syncClient.documents.create({ uniqueName: campaignDocName, data: campaignData });
    } else {
      campaignData = existing.data;
      const refusal = campaignData.mode === 'bulk'
        ? 'Bulk Messaging campaigns run on Twilio and are never continued here.'
        : !storage.isLean(campaignData) ? OLDER_FORMAT
        : (campaignData.fingerprint !== fingerprint || campaignData.totalMessages !== totalMessages) ? DIFFERENT_LIST
        : null;
      if (refusal) {
        response.setStatusCode(409);
        response.setBody({ error: refusal });
        return callback(null, response);
      }
    }

    const outcome = await storage.runChunks({
      syncClient,
      campaignId: campaignDocName,
      campaignData,
      messages,
      offset,
      deadline: startTime + SEND_DEADLINE_MS,
      send: (batch, index) => classicMessages.sendChunk(client, batch, {
        startIndex: index,
        channel: campaignData.channel,
        from: campaignData.from,
        messagingServiceSid: context.MESSAGING_SERVICE_SID,
        deadline: startTime + RETRY_DEADLINE_MS,
      }),
    });

    response.setStatusCode(200);
    response.setBody(storage.progressBody(campaignDocName, campaignData, outcome));
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
