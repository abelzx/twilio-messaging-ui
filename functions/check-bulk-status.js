const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);

/**
 * POST /check-bulk-status — aggregate progress for a bulk campaign, and
 * optionally its per-recipient rows.
 *
 * Operation stats are cheap and polled on a timer. The per-message list is not,
 * so it is fetched only when `includeMessages` is set — when the delivery panel
 * is opened or a CSV export is requested.
 */

const STAT_KEYS = [
  'total', 'recipients', 'attempts', 'unaddressable', 'queued', 'sent',
  'scheduled', 'delivered', 'read', 'undelivered', 'failed', 'canceled',
];

/** An operation is finished when it is COMPLETED or CANCELED. */
const TERMINAL_STATUSES = new Set(['COMPLETED', 'CANCELED']);

function sumStats(operations) {
  const totals = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
  for (const operation of operations) {
    const stats = (operation && operation.stats) || {};
    for (const key of STAT_KEYS) {
      totals[key] += Number(stats[key] || 0);
    }
  }
  return totals;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  const startTime = Date.now();
  const MAX_EXECUTION_TIME = 9000;

  let creds;
  let authString;
  try {
    creds = oauth.credsFrom(event);
    authString = (await oauth.authenticateWithToken(creds)).authString;
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  const campaignId = String(event.campaignId || '').trim();
  if (!campaignId) {
    response.setStatusCode(400);
    response.setBody({ error: 'campaignId is required' });
    return callback(null, response);
  }

  try {
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid =
      context.SYNC_SERVICE_SID || (await oauth.getOrCreateSyncService(runtimeClient));
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);

    let campaignData = null;
    try {
      const doc = await syncClient.documents(campaignId).fetch();
      campaignData = doc.data;
    } catch (error) {
      if (error.status !== 404 && error.code !== 20404) throw error;
    }

    // 404 rather than 403 for someone else's campaign, so a guessed ID is never
    // confirmed to exist. Same `!campaignData` guard as check-status.js.
    if (!campaignData || campaignData.ownerKey !== oauth.ownerKeyFor(creds)) {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    // A classic campaign owned by this same caller would otherwise pass the
    // ownership check above and fall through to an empty operationIds array,
    // an all-zero stats write, and a response claiming mode: 'bulk' for a
    // document that is not. 404 rather than 409: this endpoint should not
    // confirm the existence of a campaign it will not serve, the same
    // reasoning the ownership check above already follows.
    if (campaignData.mode !== 'bulk') {
      response.setStatusCode(404);
      response.setBody({ error: 'Campaign not found' });
      return callback(null, response);
    }

    const operationIds = Array.isArray(campaignData.operationIds)
      ? campaignData.operationIds
      : [];

    // Accepted by Twilio but with no operation ID returned, so there is nothing
    // to poll — ever. Reported as terminal rather than perpetually in progress:
    // `isComplete` below requires at least one reachable operation, so without
    // this the browser would poll this campaign every 5 seconds forever and the
    // card would sit at "in progress" for messages that already delivered.
    const trackingUnavailable =
      operationIds.length === 0 && Number(campaignData.untrackedOperations || 0) > 0;

    if (trackingUnavailable) {
      response.setStatusCode(200);
      response.setBody({
        success: true,
        campaign: {
          campaignId,
          mode: 'bulk',
          channel: campaignData.channel,
          from: campaignData.from,
          campaignName: campaignData.campaignName,
          scheduledFor: campaignData.scheduledFor || null,
          recipientCount: campaignData.recipientCount || 0,
          operationIds: [],
          operationStatuses: [],
          stats: null,
          isComplete: true,
          trackingUnavailable: true,
          unreachableOperations: 0,
          createdAt: campaignData.createdAt,
          lastUpdated: campaignData.lastUpdated,
        },
        ...(event.includeMessages ? { messages: [], nextCursor: null } : {}),
      });
      return callback(null, response);
    }

    const operations = await Promise.all(
      operationIds.map((id) =>
        comms.fetchOperation(authString, id).catch((error) => {
          console.error(`Operation ${id} fetch failed:`, error.message);
          return null;
        })
      )
    );

    const reachable = operations.filter(Boolean);

    // A transient comms.twilio.com blip that fails every fetchOperation call
    // must not look like a campaign that has sent nothing: overwriting a
    // previous poll's real stats with all-zero would make a failed lookup
    // indistinguishable from an empty campaign. When there was something to
    // fetch and none of it came back, keep whatever was already recorded.
    const totalFailure = operationIds.length > 0 && reachable.length === 0;

    const stats = totalFailure ? campaignData.stats || sumStats([]) : sumStats(reachable);
    const operationStatuses = totalFailure
      ? campaignData.operationStatuses || []
      : reachable.map((o) => o.status);
    const isComplete = totalFailure
      ? Boolean(campaignData.isComplete)
      : reachable.length === operationIds.length &&
        reachable.length > 0 &&
        reachable.every((operation) => TERMINAL_STATUSES.has(String(operation.status)));

    if (!totalFailure) {
      campaignData.stats = stats;
      campaignData.operationStatuses = operationStatuses;
      campaignData.isComplete = isComplete;
    }
    campaignData.lastUpdated = new Date().toISOString();

    // Fixed-size write: stats and a handful of statuses, never per-message rows.
    await syncClient.documents(campaignId).update({ data: campaignData });

    let messages;
    let nextCursor = null;
    if (event.includeMessages) {
      messages = [];
      let token = event.pageToken || null;
      let operationIndex = Number(event.operationIndex || 0);

      // Pages until the budget runs low, then hands the caller a token. A
      // 10,000-recipient operation is ten pages, which will not always fit.
      while (operationIndex < operationIds.length) {
        const page = await comms.listMessages(authString, {
          operationId: operationIds[operationIndex],
          pageToken: token,
        });
        messages.push(...page.messages);

        if (page.nextPageToken) {
          token = page.nextPageToken;
        } else {
          operationIndex += 1;
          token = null;
        }

        if (Date.now() - startTime > MAX_EXECUTION_TIME) break;
      }

      const exhausted = operationIndex >= operationIds.length;
      // Named a cursor, not a token: it carries both the opaque page token and
      // which operation that token belongs to, which a bare token cannot.
      nextCursor = exhausted ? null : { pageToken: token, operationIndex };
    }

    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaign: {
        campaignId,
        mode: 'bulk',
        channel: campaignData.channel,
        from: campaignData.from,
        campaignName: campaignData.campaignName,
        scheduledFor: campaignData.scheduledFor || null,
        recipientCount: campaignData.recipientCount || 0,
        operationIds,
        operationStatuses,
        stats,
        isComplete,
        unreachableOperations: operationIds.length - reachable.length,
        createdAt: campaignData.createdAt,
        lastUpdated: campaignData.lastUpdated,
      },
      ...(messages ? { messages, nextCursor } : {}),
    });
    return callback(null, response);
  } catch (error) {
    console.error('Check bulk status error:', error);
    response.setStatusCode(error.statusCode || 500);
    response.setBody({
      error: 'Failed to check bulk campaign status',
      message: error.message,
    });
    return callback(null, response);
  }
};
