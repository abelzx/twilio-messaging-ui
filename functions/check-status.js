/**
 * POST /check-status — campaign status, with per-message status refreshed
 * from Twilio.
 */

const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
const { templateNames } = require(Runtime.getAssets()['/template-names.js'].path);
const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);

/**
 * How far into the invocation a status fetch may still start. The token
 * exchange can take up to 4s of the 10s ceiling, and the writes after the
 * fetches need the rest. Messages not reached are fetched on a later poll.
 */
const FETCH_DEADLINE_MS = 6500;

/**
 * Chunks refreshed per poll: up to 384 fetches and 3 writes, leaving most of the
 * chunk Map's write rate (about 2 a second) to sending. A larger campaign's
 * chunks take turns, least recently checked first, over several polls.
 */
const MAX_REFRESH_CHUNKS = 3;

/**
 * A Function response is capped at 4 MB. Past this, roughly 13,000 messages,
 * the counts are sent without the per-message list.
 */
const MAX_STATUSES_BYTES = 3.5 * 1024 * 1024;

exports.handler = async function(context, event, callback) {
  const startTime = Date.now();
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
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN, { autoRetry: true, maxRetries: 3 });
    const syncServiceSid = context.SYNC_SERVICE_SID || await oauth.getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    // Campaign IDs are `campaign_<timestamp>`, so they are guessable rather
    // than secret. Answer 404 both when the document is absent and when it
    // belongs to someone else — a 403 would confirm that a guessed ID exists.
    let campaignData = null;
    let revision = null;
    try {
      const campaignDoc = await syncClient.documents(campaignId).fetch();
      campaignData = campaignDoc.data;
      revision = campaignDoc.revision;
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

    // A bulk campaign has no per-message SID map to re-fetch — its progress
    // lives in the operation, not in Sync. Pointing the caller at the right
    // endpoint beats returning a campaign with every counter at zero.
    if (campaignData.mode === 'bulk') {
      response.setStatusCode(409);
      response.setBody({
        error: 'This is a Bulk Messaging campaign. Use check-bulk-status instead.',
        mode: 'bulk',
      });
      return callback(null, response);
    }

    // `refresh: false` reads only: the page sends it while this tab is sending,
    // so polls take nothing from the chunk Map's write rate.
    const refresh = event.refresh !== false && event.refresh !== 'false';
    const channel = campaignData.channel;
    const checkedAt = new Date().toISOString();
    let statuses;

    if (storage.isLean(campaignData)) {
      const chunks = await storage.readChunks(syncClient, campaignId);
      if (refresh) {
        const { selected, takingTurns } = storage.selectChunks(chunks, channel, MAX_REFRESH_CHUNKS);
        const sids = selected.flatMap((chunk) => storage.pendingRows(chunk, channel).map((i) => chunk.rows[i][0]));
        const fetched = await classicMessages.fetchStatuses(client, sids, { deadline: startTime + FETCH_DEADLINE_MS });
        const plan = storage.refreshPlan(selected, fetched, { channel, takingTurns, checkedAt });
        const refreshed = new Map(plan.map((entry) => [entry.chunk.key, entry.chunk]));
        chunks.forEach((chunk, i) => {
          if (refreshed.has(chunk.key)) chunks[i] = refreshed.get(chunk.key);
        });
        // One at a time: at most three, and each conditional on the revision
        // read. A 412 means a send wrote the record since; a later poll retries.
        for (const entry of plan.filter((item) => item.write)) {
          try {
            await storage.updateChunk(syncClient, campaignId, entry.chunk);
          } catch (error) {
            if (error.status !== 412) console.error(`Could not save chunk ${entry.chunk.key} of ${campaignId}:`, error);
          }
        }
      }
      const now = Date.now();
      statuses = Object.assign({}, ...chunks.map((chunk) => storage.chunkStatuses(chunk, now)));
    } else {
      // An older campaign keeps its statuses inline, on the Document.
      statuses = campaignData.statuses || {};
      if (refresh) {
        const fetched = await classicMessages.fetchStatuses(client, storage.legacyPending(statuses, channel),
          { deadline: startTime + FETCH_DEADLINE_MS });
        statuses = storage.applyLegacy(statuses, fetched);
        campaignData.statuses = statuses;
      }
    }

    const counts = storage.tally(statuses);
    campaignData.sent = counts.sent;
    campaignData.delivered = counts.delivered;
    campaignData.read = counts.read;
    campaignData.failed = counts.failed;
    campaignData.pending = counts.pending;
    campaignData.unconfirmed = counts.unconfirmed;

    if (refresh) {
      campaignData.lastUpdated = checkedAt;
      // Conditional on the revision read above. A send that saved progress
      // since then owns startIndex; losing this write costs a stale counter
      // until the next poll.
      try {
        await syncClient.documents(campaignId).update({ data: campaignData, ifMatch: revision });
      } catch (error) {
        if (error.status !== 412) throw error;
      }
    }

    const statusesFit = Buffer.byteLength(JSON.stringify(statuses), 'utf8') <= MAX_STATUSES_BYTES;

    // A campaign sent before details were recorded has only its template's
    // SID, so look the name up rather than show the SID.
    const details = campaignDetails.resolveDetails(campaignData);
    if (details.template && details.template.sid && !details.template.name) {
      const found = (await templateNames(client, [details.template.sid])).get(details.template.sid);
      if (found) Object.assign(details.template, found);
    }

    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaign: {
        campaignId,
        mode: 'classic',
        totalMessages: campaignData.totalMessages,
        sent: campaignData.sent,
        failed: campaignData.failed,
        pending: campaignData.pending,
        unconfirmed: campaignData.unconfirmed,
        delivered: campaignData.delivered || 0,
        read: campaignData.read || 0,
        startIndex: campaignData.startIndex,
        isComplete: campaignData.startIndex >= campaignData.totalMessages,
        createdAt: campaignData.createdAt,
        lastUpdated: campaignData.lastUpdated,
        statuses: statusesFit ? statuses : {},
        statusesOmitted: !statusesFit,
        channel: campaignData.channel || null,
        from: campaignData.from || null,
        details
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

