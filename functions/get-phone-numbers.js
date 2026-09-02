/**
 * POST /get-phone-numbers — SMS-enabled numbers on the caller's own account.
 */

const oauth = require(Runtime.getAssets()['/twilio-oauth.js'].path);
const comms = require(Runtime.getAssets()['/twilio-comms.js'].path);

exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  let client;
  let authString;
  try {
    const authed = await oauth.authenticateWithToken(oauth.credsFrom(event));
    client = authed.client;
    authString = authed.authString;
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
    const channel = String(event.channel || 'sms').toLowerCase();

    const mode = String(event.mode || 'classic').toLowerCase();

    // In bulk mode a Messaging Service is not a valid sender — the Bulk API's
    // `from` takes an address/channel pair, a senderId or a senderPoolId, and an
    // MG SID is none of them. Sender pools take its place in the dropdown.
    //
    // Either way, this list is fetched concurrently with the channel-specific
    // list: it's a second network call inside a 10s Function budget, and
    // serialising them wastes headroom.
    //
    // A pool listing that fails must not fail the whole request: phone numbers
    // are the common case and are still perfectly usable without pools. When it
    // does fail, `poolListFailed` is set so the response can say so.
    let poolListFailed = false;
    const secondaryPromise = mode === 'bulk'
      ? comms
          .listSenderPools(authString)
          .then((pools) => pools
            // The response shape is unconfirmed — mirror listSenderPools' own
            // tolerance and accept either field. A pool with neither is not
            // selectable, so it is dropped rather than offered as an option
            // that fails later at send time.
            .filter((pool) => pool.id || pool.sid)
            .map((pool) => {
              const value = pool.id || pool.sid;
              return {
                value,
                label: `${pool.friendlyName || value} · pool`,
                status: 'ONLINE',
                kind: 'pool',
              };
            }))
          .catch((error) => {
            console.error('Sender pool list failed:', error.message);
            poolListFailed = true;
            return [];
          })
      : client.messaging.v1.services.list({ limit: 50 }).then((services) =>
          services.map((s) => ({
            value: s.sid,
            label: `${s.friendlyName} · ${s.sid.slice(0, 10)}…`,
            status: 'ONLINE',
            kind: 'service',
          }))
        );

    let directPromise;
    if (channel === 'whatsapp' || channel === 'rcs') {
      // `channel` is required by this endpoint; omitting it throws.
      directPromise = client.messaging.v2.channelsSenders
        .list({ channel, limit: 100 })
        .then((registered) => ({
          total: registered.length,
          senders: registered
            .filter((s) => String(s.status || '').toUpperCase() === 'ONLINE')
            .map((s) => ({
              // senderId already carries the channel prefix (whatsapp:+65…), which
              // is exactly what `from` needs. Do not strip it — the send path's
              // prefixing is idempotent.
              value: s.senderId,
              label: s.profile && s.profile.name
                ? `${s.senderId.replace(/^[a-z]+:/, '')} · ${s.profile.name}`
                : s.senderId.replace(/^[a-z]+:/, ''),
              status: s.status,
              kind: 'direct',
            })),
        }));
    } else if (channel === 'messenger') {
      // Facebook Pages are not exposed by any list API, so a Messaging Service that
      // owns the Page is the only selectable sender here.
      directPromise = Promise.resolve({ total: 0, senders: [] });
    } else {
      const needsMms = channel === 'mms';
      // MMS carries media, and a number that can send SMS cannot necessarily
      // send MMS — on the test account 5 of 13 sms-capable numbers are not
      // mms-capable. Filtering both on `sms` offers senders that will fail.
      directPromise = client.incomingPhoneNumbers.list({ limit: 100 }).then((numbers) => {
        const capable = numbers.filter((n) => {
          const c = n.capabilities || {};
          const flag = needsMms ? c.mms : c.sms;
          return flag === true || flag === 'true';
        });
        return {
          total: capable.length,
          senders: capable.map((n) => ({
            value: n.phoneNumber,
            label: n.friendlyName && n.friendlyName !== n.phoneNumber
              ? `${n.phoneNumber} · ${n.friendlyName}`
              : n.phoneNumber,
            status: 'ONLINE',
            kind: 'direct',
          })),
        };
      });
    }

    const [direct, serviceSenders] = await Promise.all([directPromise, secondaryPromise]);

    response.setStatusCode(200);
    response.setBody({
      success: true,
      channel,
      mode,
      senders: [...direct.senders, ...serviceSenders],
      directCount: direct.senders.length,
      serviceCount: serviceSenders.length,
      // The frontend needs both counts to tell "none registered" apart from
      // "some registered but none usable" — two different things to say.
      usableCount: direct.senders.length + serviceSenders.length,
      totalRegistered: direct.total,
      // Only meaningful in bulk mode, where serviceSenders is actually the pool
      // list — without this, a failed pool lookup is indistinguishable from an
      // account with no pools configured, and both collapse usableCount the
      // same way. Absent in classic mode, where it would mean nothing.
      ...(mode === 'bulk' ? { poolListFailed } : {}),
      // Kept so nothing that still reads `phoneNumbers` breaks silently.
      phoneNumbers: direct.senders.map((s) => ({ phoneNumber: s.value })),
    });
    return callback(null, response);
  } catch (error) {
    console.error('Get phone numbers error:', error);
    response.setStatusCode(500);
    response.setBody({
      error: 'Failed to fetch phone numbers',
      message: error.message
    });
    return callback(null, response);
  }
};
