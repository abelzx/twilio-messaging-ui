/**
 * What a campaign was sent with — sender, template, message, recipients — for
 * the campaign card and the delivery panel.
 *
 * Recorded once, when the campaign is created. The browser supplies the labels
 * only it knows (dropdown text, template name, CSV file name, the template's
 * media with shared variables filled in). The send Function supplies the facts
 * it actually sent, and those win over anything the browser claims for the
 * same field: a template name with no template SID behind it is dropped.
 *
 * A classic campaign document already holds the recipient list and every
 * message status, and sits close to Sync's 16 KiB item limit (see
 * docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md). So a
 * classic `details` leaves out the body and variable values, which
 * `messages[0]` already holds, and every `details` is held to 2 KiB.
 *
 * This is a *private* asset. Require it as:
 *
 *   const campaignDetails = require(Runtime.getAssets()['/campaign-details.js'].path);
 */

'use strict';

/**
 * Serialised size ceiling. Every classic checkpoint rewrites the whole
 * document, and a write over 16 KiB fails after the chunk has already been
 * sent, so this field must not eat into that headroom.
 */
const MAX_DETAILS_BYTES = 2 * 1024;

const LIMITS = {
  label: 120,
  language: 16,
  body: 500,
  variableCount: 10,
  variableKey: 40,
  variableValue: 100,
  mediaCount: 3,
  mediaUrl: 300,
};

const SENDER_KINDS = new Set(['direct', 'service', 'pool', 'typed']);
const CONTENT_SID = /^HX[0-9a-f]{32}$/i;
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Trimmed and capped, or null for anything that is not a non-empty string. */
function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // By code point, so a cut never leaves half an emoji in Sync.
  const chars = Array.from(trimmed);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : trimmed;
}

function contentSidOf(value) {
  const sid = typeof value === 'string' ? value.trim() : '';
  return CONTENT_SID.test(sid) ? sid : null;
}

/** Accepts an object or the JSON string send-messages.js may have stored. */
function cleanVariables(values) {
  let source = values;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (error) {
      return null;
    }
  }
  source = asObject(source);
  if (!source) return null;

  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(out).length >= LIMITS.variableCount) break;
    const cleanKey = text(key, LIMITS.variableKey);
    const cleanValue = text(typeof value === 'number' ? String(value) : value, LIMITS.variableValue);
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
  }
  return Object.keys(out).length ? out : null;
}

function cleanMedia(media) {
  const source = asObject(media) || {};
  const urls = [...new Set(
    (Array.isArray(source.urls) ? source.urls : [])
      .filter((url) => typeof url === 'string')
      .map((url) => url.trim())
      // Dropped rather than truncated: a cut-off URL is a broken link.
      .filter((url) => url && url.length <= LIMITS.mediaUrl)
  )].slice(0, LIMITS.mediaCount);
  const perRecipient = source.perRecipient === true;
  return urls.length || perRecipient ? { urls, perRecipient } : null;
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Drops media, then variable values, then body, then the labels, until the
 * budget is met. Control characters serialise to 6 bytes each, so capped labels
 * alone can overflow; with the labels gone only facts remain, which always fit.
 */
function fitBudget(details) {
  const drops = [
    () => { details.media = null; },
    () => { if (details.variables) details.variables.values = null; },
    () => { details.message.body = null; },
    () => {
      details.sender.label = null;
      if (details.template) details.template.name = null;
      details.recipients.fileName = null;
    },
  ];
  for (const drop of drops) {
    if (byteSize(details) <= MAX_DETAILS_BYTES) break;
    drop();
  }
  return details;
}

/**
 * The `details` object stored on a new campaign document.
 *
 * `input` is the browser's `event.details` and may be anything, including
 * absent; a malformed one costs the labels, never the send. `facts` comes from
 * the send Function:
 *
 *   { mode: 'bulk' | 'classic', contentSid, recipientCount,
 *     body?, perRecipientBody?, fallbackToSms? }
 */
function buildDetails(input, facts) {
  const given = asObject(input) || {};
  const known = asObject(facts) || {};
  const classic = known.mode === 'classic';

  const sender = asObject(given.sender) || {};
  const template = asObject(given.template) || {};
  const message = asObject(given.message) || {};
  const variables = asObject(given.variables) || {};
  const recipients = asObject(given.recipients) || {};

  const contentSid = contentSidOf(known.contentSid);

  // A template overrides any body on both APIs, so text sent alongside one
  // never reached anybody and is not recorded as the message.
  const bodyPerRecipient = !contentSid &&
    (typeof known.perRecipientBody === 'boolean' ? known.perRecipientBody : message.perRecipient === true);
  const variablesPerRecipient = Boolean(contentSid) && variables.perRecipient === true;
  const csv = recipients.source === 'csv';
  // Null when the browser did not say (no or malformed details): unknown, not typed.
  const source = csv ? 'csv' : (recipients.source === 'typed' ? 'typed' : null);

  return fitBudget({
    sender: {
      label: text(sender.label, LIMITS.label),
      kind: SENDER_KINDS.has(sender.kind) ? sender.kind : null,
    },
    template: contentSid
      ? {
          sid: contentSid,
          name: text(template.name, LIMITS.label),
          language: text(template.language, LIMITS.language),
        }
      : null,
    message: {
      body: classic || contentSid || bodyPerRecipient ? null : text(known.body, LIMITS.body),
      perRecipient: bodyPerRecipient,
    },
    variables: contentSid
      ? {
          values: classic || variablesPerRecipient ? null : cleanVariables(variables.values),
          perRecipient: variablesPerRecipient,
        }
      : null,
    media: contentSid ? cleanMedia(given.media) : null,
    recipients: {
      source,
      fileName: csv ? text(recipients.fileName, LIMITS.label) : null,
      count: Number.isFinite(known.recipientCount) ? known.recipientCount : 0,
    },
    fallbackToSms: typeof known.fallbackToSms === 'boolean' ? known.fallbackToSms : null,
  });
}

/** null when there is nothing to show, so the row can be hidden. */
function presentMessage(value) {
  const message = asObject(value);
  return message && (message.body || message.perRecipient)
    ? { body: message.body || null, perRecipient: message.perRecipient === true }
    : null;
}

function presentVariables(value) {
  const variables = asObject(value);
  return variables && (variables.values || variables.perRecipient)
    ? { values: variables.values || null, perRecipient: variables.perRecipient === true }
    : null;
}

/**
 * The display shape for one campaign document, new or old.
 *
 * A document from before `details` existed gets what can be derived: a classic
 * one from `messages[0]`, a bulk one only its channel and sender. Bulk never
 * stored its template or body, so those are marked `{ notRecorded: true }`
 * rather than shown as absent.
 */
function resolveDetails(campaignData) {
  const data = asObject(campaignData) || {};
  const bulk = data.mode === 'bulk';
  const stored = asObject(data.details);
  const first = (!bulk && Array.isArray(data.messages) && asObject(data.messages[0])) || {};
  const from = typeof data.from === 'string' && data.from.trim() ? data.from.trim() : null;

  const storedSender = (stored && asObject(stored.sender)) || {};
  const sender = {
    label: storedSender.label || null,
    kind: storedSender.kind ||
      (from ? (MESSAGING_SERVICE_SID.test(from) ? 'service' : 'direct') : null),
    address: from,
  };

  let template;
  let message;
  let variables;
  if (bulk) {
    template = stored ? asObject(stored.template) : { notRecorded: true };
    message = stored ? presentMessage(stored.message) : { notRecorded: true };
    variables = stored ? presentVariables(stored.variables) : null;
  } else {
    // messages[0] holds only the first recipient's values. When the stored
    // flags say a CSV varied them per recipient, they are not the campaign's.
    const contentSid = contentSidOf(first.contentSid);
    const storedTemplate = (stored && asObject(stored.template)) || {};
    const storedMessage = (stored && asObject(stored.message)) || {};
    const storedVariables = (stored && asObject(stored.variables)) || {};

    template = contentSid
      ? { sid: contentSid, name: storedTemplate.name || null, language: storedTemplate.language || null }
      : null;
    message = contentSid ? null : presentMessage({
      body: storedMessage.perRecipient ? null : text(first.body, LIMITS.body),
      perRecipient: storedMessage.perRecipient === true,
    });
    variables = contentSid ? presentVariables({
      values: storedVariables.perRecipient ? null : cleanVariables(first.contentVariables),
      perRecipient: storedVariables.perRecipient === true,
    }) : null;
  }

  const storedRecipients = (stored && asObject(stored.recipients)) || {};

  return {
    mode: bulk ? 'bulk' : 'classic',
    channel: typeof data.channel === 'string' && data.channel ? data.channel : null,
    sender,
    template,
    message,
    variables,
    media: (stored && asObject(stored.media)) || null,
    recipients: {
      source: storedRecipients.source || null,
      fileName: storedRecipients.fileName || null,
      count: Number((bulk ? data.recipientCount : data.totalMessages) || 0),
    },
    scheduledFor: bulk ? data.scheduledFor || null : null,
    fallbackToSms: bulk && stored && typeof stored.fallbackToSms === 'boolean' ? stored.fallbackToSms : null,
    operationIds: bulk && Array.isArray(data.operationIds) ? data.operationIds : null,
  };
}

/** The three strings on a campaign card's summary line, any of them null. */
function summaryLine(campaignData) {
  const details = resolveDetails(campaignData);
  const template = details.template && !details.template.notRecorded ? details.template : null;
  return {
    channel: details.channel,
    sender: details.sender.label || details.sender.address,
    template: template ? template.name || template.sid : null,
  };
}

module.exports = {
  buildDetails,
  resolveDetails,
  summaryLine,
  MAX_DETAILS_BYTES,
};
