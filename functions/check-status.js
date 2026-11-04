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
 * Status buckets refreshed per poll: up to 768 fetches, and no more writes
 * than Sync's 20/s per Map comfortably allows. A larger campaign's buckets take
 * turns, least recently checked first, over several polls.
 */
const MAX_REFRESH_BUCKETS = 24;

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

    // A bucketed campaign keeps its statuses in a Map. One stored before that
    // keeps them inline, on the Document, and is treated as a single bucket.
    const bucketed = storage.isBucketed(campaignData);
    const buckets = bucketed
      ? await storage.readStatusBuckets(syncClient, campaignId)
      : [{ key: null, statuses: campaignData.statuses || {}, checkedAt: null }];

    const candidates = buckets
      .filter((bucket) => classicMessages.pendingKeys(bucket.statuses, campaignData.channel).length)
      .sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || '')));
    const selected = candidates.slice(0, MAX_REFRESH_BUCKETS);
    const takingTurns = candidates.length > selected.length;

    const { statuses: refreshed, changed } = await classicMessages.refreshStatuses(
      client,
      Object.assign({}, ...selected.map((bucket) => bucket.statuses)),
      { channel: campaignData.channel, deadline: startTime + FETCH_DEADLINE_MS }
    );

    // A selected bucket is written when an entry in it changed, or, while
    // buckets are taking turns, to record that it has had its turn.
    const checkedAt = new Date().toISOString();
    const toWrite = [];
    for (const bucket of selected) {
      const keys = Object.keys(bucket.statuses);
      if (takingTurns || keys.some((key) => changed.has(key))) toWrite.push(bucket);
      bucket.statuses = Object.fromEntries(keys.map((key) => [key, refreshed[key]]));
    }

    if (bucketed) {
      await storage.inBatches(toWrite.map((bucket) => () =>
        storage.updateStatusBucket(syncClient, campaignId, bucket.key, bucket.statuses, checkedAt)));
    } else {
      campaignData.statuses = buckets[0].statuses;
    }

    const statuses = Object.assign({}, ...buckets.map((bucket) => bucket.statuses));
    campaignData.lastUpdated = checkedAt;

    const counts = classicMessages.tally(statuses);
    campaignData.delivered = counts.delivered;
    campaignData.read = counts.read;
    campaignData.failed = counts.failed;
    // Anything accepted by Twilio that has not yet reached a terminal state.
    // Clamped at zero: a chunk sent twice inflates `sent` past the recipient
    // count, and a negative "pending" is noise rather than information.
    campaignData.pending = Math.max(0, (campaignData.sent || 0) - counts.delivered - counts.failed);

    // Conditional on the revision read above. A send that checkpointed since
    // then owns startIndex, and writing this older copy over it would move the
    // index back, so the next resume would send a chunk again. Losing this write
    // costs a stale counter until the next poll.
    try {
      await syncClient.documents(campaignId).update({ data: campaignData, ifMatch: revision });
    } catch (error) {
      if (error.status !== 412) throw error;
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

