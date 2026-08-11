/**
 * POST /get-phone-numbers — SMS-enabled numbers on the caller's own account.
 */

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

  let client;
  try {
    client = await oauth.authenticate(oauth.credsFrom(event));
  } catch (error) {
    response.setStatusCode(error.statusCode || 401);
    response.setBody({ error: error.message });
    return callback(null, response);
  }

  try {
    const channel = String(event.channel || 'sms').toLowerCase();

    // sms/mms send from a Twilio phone number; whatsapp/rcs send from a
    // registered channel sender, which is a different resource entirely. Asking
    // incomingPhoneNumbers for a WhatsApp sender returns numbers that cannot
    // send on WhatsApp — the defect this fixes.
    let senders;
    let totalRegistered;

    if (channel === 'whatsapp' || channel === 'rcs') {
      // `channel` is required by this endpoint; omitting it throws.
      const registered = await client.messaging.v2.channelsSenders.list({
        channel,
        limit: 100,
      });
      totalRegistered = registered.length;

      senders = registered
        .filter((s) => String(s.status || '').toUpperCase() === 'ONLINE')
        .map((s) => ({
          // senderId already carries the channel prefix (whatsapp:+65…), which
          // is exactly what `from` needs. Do not strip it — the send path's
          // prefixing is idempotent (Step 2).
          value: s.senderId,
          label: s.profile && s.profile.name
            ? `${s.senderId.replace(/^[a-z]+:/, '')} · ${s.profile.name}`
            : s.senderId.replace(/^[a-z]+:/, ''),
          status: s.status,
        }));
    } else if (channel === 'messenger') {
      // Facebook Pages are not exposed by the Channel Senders API (it answers
      // 63105 "Channel does not support this action"). Pages attach to a
      // Messaging Service, and the send path already consumes
      // messagingServiceSid for this channel, so list the services.
      const services = await client.messaging.v1.services.list({ limit: 50 });
      totalRegistered = services.length;
      senders = services.map((s) => ({
        value: s.sid,
        label: `${s.friendlyName} · ${s.sid.slice(0, 10)}…`,
        status: 'ONLINE',
      }));
    } else {
      const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });

      // MMS carries media, and a number that can send SMS cannot necessarily
      // send MMS — on the test account 5 of 13 sms-capable numbers are not
      // mms-capable. Filtering both on `sms` offers senders that will fail.
      const needsMms = channel === 'mms';
      const capable = numbers.filter((n) => {
        const c = n.capabilities || {};
        const flag = needsMms ? c.mms : c.sms;
        return flag === true || flag === 'true';
      });

      totalRegistered = capable.length;
      senders = capable.map((n) => ({
        value: n.phoneNumber,
        label: n.friendlyName && n.friendlyName !== n.phoneNumber
          ? `${n.phoneNumber} · ${n.friendlyName}`
          : n.phoneNumber,
        status: 'ONLINE',
      }));
    }

    response.setStatusCode(200);
    response.setBody({
      success: true,
      channel,
      senders,
      // The frontend needs both counts to tell "none registered" apart from
      // "some registered but none usable" — two different things to say.
      usableCount: senders.length,
      totalRegistered,
      // Kept so nothing that still reads `phoneNumbers` breaks silently.
      phoneNumbers: senders.map((s) => ({ phoneNumber: s.value })),
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
