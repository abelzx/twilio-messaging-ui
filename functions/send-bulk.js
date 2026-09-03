const twilio = require('twilio');
const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);
const bulk = require(Runtime.getAssets()['/bulk-payload.js'].path);

/**
 * POST /send-bulk — submits a campaign through the Bulk Messaging API.
 *
 * Unlike send-messages.js there is no chunk loop and no checkpoint: one request
 * carries up to 10,000 recipients, so the browser does not have to drive
 * anything and the tab need not stay open. Campaigns above 10,000 become
 * several operations, submitted here in one invocation.
 */
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  let creds;
  let authString;
  let accountSid;
  try {
    creds = oauth.credsFrom(event);
    const authed = await oauth.authenticateWithToken(creds);
    authString = authed.authString;
    accountSid = authed.accountSid;
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  // Payloads are built before anything is sent, so a mapping or validation
  // error costs nothing: nothing has left the building yet.
  let payloads;
  try {
    payloads = bulk.buildPayloads({
      channel: event.channel,
      from: event.from,
      body: event.body,
      contentSid: event.contentSid,
      mediaUrl: event.mediaUrl,
      recipients: event.recipients,
      campaignName: event.campaignName,
      sendAt: event.sendAt,
      fallbackToSms: event.fallbackToSms,
    });
  } catch (error) {
    response.setStatusCode(error.statusCode || 400);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  const recipientCount = payloads.reduce((total, p) => total + p.to.length, 0);

  const operationIds = [];
  // Counted separately from operationIds, because Twilio can accept a request
  // without returning an ID for it. Such an operation still sends every message;
  // it just cannot be polled. Conflating the two counts would either report a
  // successful send as a failure or claim tracking that does not exist.
  let acceptedOperations = 0;
  let submitError = null;
  try {
    for (const payload of payloads) {
      const { operationId } = await comms.createMessages(authString, payload);
      acceptedOperations += 1;
      if (operationId) operationIds.push(operationId);
    }
  } catch (error) {
    // Any operation already accepted will send regardless of this failure, so
    // the campaign is still recorded below with the IDs that succeeded.
    // Dropping them would leave traffic in flight that nothing can track.
    submitError = error;
  }

  if (acceptedOperations === 0) {
    response.setStatusCode((submitError && submitError.statusCode) || 502);
    response.setBody({
      error: (submitError && submitError.message) || 'Twilio accepted no operations.',
    });
    return callback(null, response);
  }

  const untrackedOperations = acceptedOperations - operationIds.length;

  const campaignDocName = event.campaignId || `campaign_${Date.now()}`;

  try {
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid =
      context.SYNC_SERVICE_SID || (await oauth.getOrCreateSyncService(runtimeClient));

    await runtimeClient.sync.v1.services(syncServiceSid).documents.create({
      uniqueName: campaignDocName,
      data: {
        mode: 'bulk',
        ownerKey: oauth.ownerKeyFor(creds),
        accountSid, // display only; never an authorization key
        operationIds,
        // Accepted but unpollable. Recorded so check-bulk-status can stop
        // polling a campaign it will never learn anything about, and say why,
        // rather than reporting zeroes for messages that did send.
        untrackedOperations,
        recipientCount,
        // No recipient list and no per-message statuses: there is nothing to
        // resume, so there is nothing to checkpoint — and a Sync Document holds
        // only 16KiB, which a 10,000-recipient list would blow past many times.
        channel: String(event.channel || '').toLowerCase(),
        from: event.from || null,
        campaignName: event.campaignName || null,
        scheduledFor: event.sendAt || null,
        stats: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Bulk campaign record failed:', error.message);
    // The messages are already accepted regardless of which branch below
    // fires. Report that plainly rather than returning an error that reads as
    // though nothing was sent.
    //
    // 54301 is Sync's "unique name already exists" — naming the real cause
    // here matters because a caller reusing a campaign ID would otherwise be
    // told only that recording failed. This is NOT idempotency: the
    // operations above are submitted before this write, so by the time the
    // collision is detected the messages have already gone out a second
    // time. Genuine deduplication would need to reserve the campaign ID
    // before sending, which is out of scope here — this only reports the
    // collision honestly instead of masking it.
    const isDuplicateName = error.code === 54301 || error.status === 409;
    response.setStatusCode(200);
    response.setBody({
      success: true,
      campaignId: null,
      operationIds,
      accepted: recipientCount,
      recordFailed: true,
      warning: isDuplicateName
        ? `The campaign ID "${campaignDocName}" is already in use, so this campaign could not be recorded under it. The messages were already sent. Track them in the Twilio Console using the operation ID.`
        : 'Twilio accepted the messages, but this campaign could not be recorded, so it will not appear in history. Track it in the Twilio Console using the operation ID.',
    });
    return callback(null, response);
  }

  response.setStatusCode(submitError ? 207 : 200);
  response.setBody({
    success: true,
    campaignId: campaignDocName,
    operationIds,
    // "accepted", not "sent": a 202 means Twilio took the request. Delivery is
    // what the stats block reports later.
    accepted: recipientCount,
    // Every message was accepted, but nothing came back to poll with. Said
    // plainly so the UI can explain why the delivery stats stay empty instead
    // of leaving the user to conclude the send failed.
    ...(untrackedOperations > 0 && operationIds.length === 0
      ? {
          trackingUnavailable: true,
          warning:
            'Twilio accepted every message, but returned no operation ID, so delivery progress cannot be tracked for this campaign. The messages are sending — check the Twilio Console message logs to confirm delivery.',
        }
      : {}),
    ...(submitError
      ? {
          partial: true,
          error: `Accepted ${operationIds.length} of ${payloads.length} batches. The rest failed: ${submitError.message}`,
        }
      : {}),
  });
  return callback(null, response);
};
