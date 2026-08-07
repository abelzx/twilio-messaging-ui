const twilio = require('twilio');

/**
 * Get content templates for WhatsApp, RCS, and other supported channels
 */
exports.handler = async function(context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Access-Control-Allow-Origin', '*');
  response.appendHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.appendHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.appendHeader('Content-Type', 'application/json');

  if (event.request.method === 'OPTIONS') {
    return callback(null, response);
  }

  try {
    const { sessionId, channel } = event;

    console.log('Received request - sessionId:', sessionId, 'channel:', channel);
    console.log('Event keys:', Object.keys(event));

    if (!sessionId) {
      response.setStatusCode(400);
      response.setBody({ error: 'sessionId is required' });
      return callback(null, response);
    }

    if (!channel) {
      console.warn('No channel parameter provided');
      response.setStatusCode(200);
      response.setBody({
        success: true,
        templates: [],
        message: 'No channel specified. Content templates require a channel parameter.'
      });
      return callback(null, response);
    }

    // Get credentials from Sync using runtime credentials
    const runtimeClient = twilio(context.ACCOUNT_SID, context.AUTH_TOKEN);
    const syncServiceSid = context.SYNC_SERVICE_SID || await getOrCreateSyncService(runtimeClient);
    const syncClient = runtimeClient.sync.v1.services(syncServiceSid);
    
    const credentialsDoc = await syncClient.documents(`credentials_${sessionId}`).fetch();
    const credentials = credentialsDoc.data;

    // Initialize Twilio client with user credentials
    let client;
    if (credentials.authToken) {
      client = twilio(credentials.accountSid, credentials.authToken);
    } else if (credentials.apiKey && credentials.apiSecret) {
      client = twilio(credentials.apiKey, credentials.apiSecret, { 
        accountSid: credentials.accountSid 
      });
    } else {
      throw new Error('Invalid credentials');
    }

    const templates = [];

    // Fetch content templates based on channel
    if (channel === 'whatsapp') {
      try {
        // Use the ContentAndApprovals endpoint so each template comes back with
        // its Meta/WhatsApp approval status populated inline. The plain
        // contents.list() endpoint does not reliably include approval info.
        const contentTemplates = await client.content.v1.contentAndApprovals.list({ limit: 100 });

        console.log(`Found ${contentTemplates.length} total content templates`);

        // Every Content template can be sent over WhatsApp regardless of its
        // content type (twilio/text, twilio/media, twilio/quick-reply, ...).
        // WhatsApp usability is governed by Meta approval, not by a channel key
        // inside `types`, so we list all templates and surface their status.
        // Exclude Twilio Verify auto-created templates (not user-facing).
        templates.push(...contentTemplates.filter(isNotVerifyAutoCreated).map(template => {
          const approval = template.approvalRequests;
          let status = 'unsubmitted';
          if (approval && typeof approval === 'object') {
            status = approval.status || approval.Status || 'unsubmitted';
          }

          return {
            sid: template.sid,
            friendlyName: template.friendlyName || template.name || template.sid,
            language: template.language || 'en',
            types: template.types,
            variables: template.variables || {},
            status: String(status).toLowerCase()
          };
        }));

        console.log(`Returning ${templates.length} WhatsApp templates`);
      } catch (error) {
        console.error('Error fetching WhatsApp content templates:', error);
        console.error('Error details:', error.message, error.stack);
        // Return error info in response for debugging
        response.setStatusCode(200);
        response.setBody({
          success: false,
          templates: [],
          error: `Failed to fetch WhatsApp templates: ${error.message}`
        });
        return callback(null, response);
      }
    } else if (channel === 'rcs') {
      try {
        // Get RCS Content Templates
        const contentTemplates = await client.content.v1.contents.list({ limit: 100 });

        console.log(`Found ${contentTemplates.length} total content templates`);

        // RCS support is determined by the content types a template uses
        // (twilio/text, twilio/media, twilio/card, twilio/carousel,
        // twilio/quick-reply), NOT by a "rcs" key inside `types`. Card and
        // carousel are RCS-specific; the rest also render on RCS. We surface
        // all templates that contain at least one RCS-capable content type.
        const RCS_CAPABLE_TYPES = [
          'twilio/text',
          'twilio/media',
          'twilio/card',
          'twilio/carousel',
          'twilio/quick-reply',
          'twilio/call-to-action'
        ];
        const rcsTemplates = contentTemplates.filter(template => {
          if (!isNotVerifyAutoCreated(template)) {
            return false;
          }
          if (!template.types || typeof template.types !== 'object') {
            return false;
          }
          return Object.keys(template.types).some(t => RCS_CAPABLE_TYPES.includes(t));
        });

        console.log(`Filtered to ${rcsTemplates.length} RCS templates`);

        templates.push(...rcsTemplates.map(template => ({
          sid: template.sid,
          friendlyName: template.friendlyName || template.name || template.sid,
          language: template.language || 'en',
          types: template.types,
          variables: template.variables || {},
          status: 'approved'
        })));
      } catch (error) {
        console.error('Error fetching RCS content templates:', error);
        console.error('Error details:', error.message, error.stack);
        // Return error info in response for debugging
        response.setStatusCode(200);
        response.setBody({
          success: false,
          templates: [],
          error: `Failed to fetch RCS templates: ${error.message}`
        });
        return callback(null, response);
      }
    } else {
      // Channel not supported for content templates
      response.setStatusCode(200);
      response.setBody({
        success: true,
        templates: [],
        message: `Content templates are not supported for channel: ${channel}`
      });
      return callback(null, response);
    }

    response.setStatusCode(200);
    response.setBody({
      success: true,
      templates: templates
    });

    return callback(null, response);
  } catch (error) {
    console.error('Get content templates error:', error);
    response.setStatusCode(500);
    response.setBody({ 
      error: 'Failed to fetch content templates',
      message: error.message 
    });
    return callback(null, response);
  }
};

/**
 * Twilio Verify auto-generates Content templates for OTP delivery. These are
 * named with a `verify_auto_created` prefix and should not appear in the
 * user-facing template picker.
 */
function isNotVerifyAutoCreated(template) {
  const name = (template.friendlyName || template.name || '').toLowerCase();
  return !name.startsWith('verify_auto_created');
}

async function getOrCreateSyncService(client) {
  try {
    // Try to find existing service
    const services = await client.sync.v1.services.list({ limit: 20 });
    const existingService = services.find(s => s.friendlyName === 'Messaging UI Sync Service');
    if (existingService) {
      return existingService.sid;
    }
    
    // Create new service if not found
    const service = await client.sync.v1.services.create({
      friendlyName: 'Messaging UI Sync Service'
    });
    return service.sid;
  } catch (error) {
    console.error('Error getting/creating Sync service:', error);
    // If we can't create/get Sync service, try to continue with first available
    try {
      const services = await client.sync.v1.services.list({ limit: 1 });
      if (services.length > 0) {
        return services[0].sid;
      }
    } catch (e) {
      console.error('Error getting any Sync service:', e);
    }
    throw error;
  }
}

