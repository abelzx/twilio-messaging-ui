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
    const phoneNumbers = await client.incomingPhoneNumbers.list({ limit: 100 });

    const smsNumbers = phoneNumbers
      .filter(number => {
        const capabilities = number.capabilities || {};
        return capabilities.sms === true || capabilities.sms === 'true';
      })
      .map(number => ({
        phoneNumber: number.phoneNumber,
        friendlyName: number.friendlyName || number.phoneNumber,
        sid: number.sid,
        capabilities: number.capabilities
      }));

    response.setStatusCode(200);
    response.setBody({
      success: true,
      phoneNumbers: smsNumbers
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
