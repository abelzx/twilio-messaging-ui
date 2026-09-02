/**
 * Pure mapping from this app's campaign request to Bulk Messaging API JSON.
 *
 * This is a *private* asset: the `.private.js` suffix makes Twilio Serverless
 * mark it `access: private`, so it is never served over HTTP. Require it as:
 *
 *   const bulk = require(Runtime.getAssets()['/bulk-payload.js'].path);
 *
 * Note the key drops the `.private` segment.
 *
 * Nothing here does I/O, and nothing here requires the Twilio SDK. Every rule
 * that decides what Twilio receives lives in this file so it can be tested
 * without an account.
 */

'use strict';

/** Sender channel and recipient channel per app channel. Only WhatsApp differs. */
const CHANNEL_MAP = {
  sms: { from: 'SMS', to: 'PHONE' },
  mms: { from: 'MMS', to: 'PHONE' },
  rcs: { from: 'RCS', to: 'PHONE' },
  whatsapp: { from: 'WHATSAPP', to: 'WHATSAPP' },
};

const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;
const SENDER_POOL_SID = /^SP[0-9a-f]{32}$/i;

/** An Error carrying the HTTP status a handler should respond with. */
function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Strips a channel prefix. `whatsapp:+65…` is a Programmable Messaging
 * convention; here the channel is a field of its own, so the prefix would be
 * read as part of the address.
 */
function bareAddress(value) {
  return String(value == null ? '' : value).trim().replace(/^[a-z]+:/i, '');
}

/**
 * Resolves the `from` object.
 *
 * A Messaging Service is rejected rather than passed through. The Bulk API's
 * `from` accepts an address/channel pair, a `senderId` or a `senderPoolId`, and
 * an MG SID is none of the three — sending it produces a validation error that
 * does not name the real problem.
 */
function resolveSender(from, channelNames) {
  const raw = String(from == null ? '' : from).trim();
  if (!raw) {
    throw httpError(400, 'A sender is required.');
  }
  if (MESSAGING_SERVICE_SID.test(raw)) {
    throw httpError(
      400,
      'A Messaging Service cannot be used as a sender in bulk mode. Choose a phone number or a sender pool, or switch to Programmable Messaging.'
    );
  }
  if (SENDER_POOL_SID.test(raw)) {
    return { senderPoolId: raw };
  }
  return { address: bareAddress(raw), channel: channelNames.from };
}

const CONTENT_SID = /^HX[0-9a-f]{32}$/i;

/**
 * Wraps text so Liquid renders it verbatim.
 *
 * `content.text` is Liquid-templated, so an unwrapped `{{name}}` in a body typed
 * by a user would be interpreted and almost certainly render empty. The classic
 * path sends bodies literally, and the two modes must not differ on this.
 *
 * `{% endraw %}` in the text would close the wrapper early and expose the rest
 * to interpretation. Liquid offers no way to escape it, so it is refused.
 */
function escapeLiquid(text) {
  const raw = String(text);
  // No /i flag: Liquid tag names are case-sensitive, so "{% ENDRAW %}" does not
  // close a raw block and cannot be used to break out of the wrapper. Matching
  // case-insensitively here would reject harmless text that Liquid itself treats
  // as inert.
  if (/\{%-?\s*endraw\s*-?%\}/.test(raw)) {
    throw httpError(
      400,
      'The message body contains the literal text "{% endraw %}", which cannot be sent safely on this mode. Remove it, or switch to Programmable Messaging.'
    );
  }
  return `{% raw %}${raw}{% endraw %}`;
}

/**
 * Resolves the single `content` object shared by every recipient in the request.
 *
 * Precedence is template, then per-recipient text, then literal body. The middle
 * case is the CSV `Body` column: the Bulk API carries one content object per
 * request, so per-recipient text has no direct equivalent and is routed through
 * a single Liquid variable instead. Liquid substitutes in one pass, so a
 * recipient's own text is not itself re-rendered.
 */
function resolveContent(request, recipients) {
  const contentSid = String(request.contentSid || '').trim();
  if (contentSid) {
    if (!CONTENT_SID.test(contentSid)) {
      throw httpError(400, `"${contentSid}" is not a content template SID.`);
    }
    // Template wins outright: any per-recipient `body` values are silently
    // discarded here (perRecipientBody stays false, so the recipient loop never
    // reads recipient.body). This can't arise through the app — the CSV is
    // either `Number,Body` with no template selected or `Number,{{1}}` with one,
    // never both — but a caller that wires this module up differently should
    // know a template always overrides a CSV body column.
    return { content: { contentId: contentSid }, perRecipientBody: false };
  }

  const body = String(request.body == null ? '' : request.body);
  const anyOwnBody = recipients.some(
    (recipient) => String(recipient.body == null ? '' : recipient.body).trim() !== ''
  );

  const media = MEDIA_CHANNELS.has(String(request.channel).toLowerCase())
    ? [].concat(request.mediaUrl || []).filter(Boolean)
    : [];

  if (anyOwnBody) {
    // Unlike the campaign-wide case below, a blank body here isn't necessarily
    // fatal — it might still fall back to the campaign body per recipient, in
    // the loop in buildPayloads. But a recipient with neither their own body
    // nor a campaign body to fall back on would get `variables.body === ''`,
    // i.e. a genuinely blank message sent to a real person. The classic path
    // (interpretCsv in assets/app.js) skips such a row entirely; this module
    // has no "skip a recipient" concept, and silently sending nothing is worse
    // than a loud rejection, so it throws instead.
    const missing = recipients.filter(
      (recipient) =>
        String(recipient.body == null ? '' : recipient.body).trim() === '' && !body.trim()
    ).length;
    if (missing > 0) {
      throw httpError(
        400,
        `${missing} recipient(s) have no message text: their row's body is blank and no message body was typed to fall back on.`
      );
    }
    const content = { text: '{{body}}' };
    if (media.length) content.media = media;
    return { content, perRecipientBody: true };
  }

  if (!body.trim()) {
    throw httpError(400, 'A message body or a content template is required.');
  }

  const content = { text: escapeLiquid(body) };
  if (media.length) content.media = media;
  return { content, perRecipientBody: false };
}

const MEDIA_CHANNELS = new Set(['mms', 'rcs']);
const MAX_TAGS = 10;
const MAX_TAG_KEY = 128;
const MAX_TAG_VALUE = 256;

/** Tags carry at most 10 pairs, with bounded key and value lengths. */
function buildTags(request, channel) {
  const candidates = {
    ...(request.campaignName ? { campaign: String(request.campaignName) } : {}),
    channel,
    mode: 'bulk',
  };

  const tags = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (Object.keys(tags).length >= MAX_TAGS) break;
    tags[String(key).slice(0, MAX_TAG_KEY)] = String(value).slice(0, MAX_TAG_VALUE);
  }
  return tags;
}

/**
 * Validates `sendAt` without normalising it.
 *
 * Passed through exactly as received: the API reference renders the field as
 * `{sendAt: [RFC 3339 date-time]}` while the scheduling guide shows a literal
 * array, so the shape is confirmed against a live call rather than guessed. If
 * it turns out to want an array, this function is the only thing that changes.
 */
function resolveSchedule(sendAt) {
  if (sendAt == null || String(sendAt).trim() === '') return null;
  const value = String(sendAt).trim();
  if (Number.isNaN(Date.parse(value))) {
    throw httpError(400, `"${value}" is not a valid RFC 3339 date and time.`);
  }
  return { sendAt: value };
}

/**
 * Fallback is expressed per recipient as an ordered `addresses` array, which
 * needs no sender pool.
 *
 * WhatsApp only, and not for want of trying: an RCS recipient's channel is
 * already PHONE (see CHANNEL_MAP), so an RCS-then-SMS array would name the same
 * channel twice and mean nothing. RCS fallback requires sender-pool
 * `channels.priority`, which this app does not create.
 */
function assertFallbackSupported(channel) {
  if (channel !== 'whatsapp') {
    throw httpError(
      400,
      'Channel fallback is only available on WhatsApp. On RCS it requires a sender pool, which this app does not manage.'
    );
  }
}

function buildPayloads(request) {
  const channel = String((request && request.channel) || '').toLowerCase();
  const channelNames = CHANNEL_MAP[channel];
  if (!channelNames) {
    throw httpError(
      400,
      `Bulk Messaging does not support the ${channel || 'selected'} channel. Supported channels: SMS, MMS, RCS, WhatsApp.`
    );
  }

  const recipients = Array.isArray(request.recipients) ? request.recipients : [];
  if (recipients.length === 0) {
    throw httpError(400, 'At least one recipient is required.');
  }

  const fallbackToSms = Boolean(request.fallbackToSms);
  if (fallbackToSms) assertFallbackSupported(channel);

  const from = resolveSender(request.from, channelNames);
  const { content, perRecipientBody } = resolveContent(request, recipients);
  const campaignBody = String(request.body == null ? '' : request.body);

  const to = recipients.map((recipient) => {
    const address = bareAddress(recipient.to);

    const entry = fallbackToSms
      ? {
          addresses: [
            { address, channel: channelNames.to },
            { address, channel: 'PHONE' },
          ],
        }
      : { address, channel: channelNames.to };

    // `variables.body` below is set unconditionally in perRecipientBody mode,
    // clobbering any `variables.body` a caller supplied directly. This can't
    // arise through the app — the CSV is either `Number,Body` (perRecipientBody,
    // no template variables) or `Number,{{1}}` (template variables, no body
    // column), never both — but a caller combining the two should know body
    // wins.
    const variables = { ...(recipient.variables || {}) };

    if (perRecipientBody) {
      // The fallback-to-campaign-body mechanic matches the classic path
      // (interpretCsv in assets/app.js): a blank cell falls back to the body
      // typed above rather than being treated as missing. It does NOT fully
      // match that path's behaviour, though — interpretCsv skips a row outright
      // when neither the cell nor the campaign body has text; this module has
      // no way to skip one recipient out of a shared Bulk request, so
      // resolveContent instead rejects the whole request up front when that
      // would happen. A blank *variable* (as opposed to a blank body) does not
      // fall back at all — see resolveContent.
      const own = String(recipient.body == null ? '' : recipient.body);
      variables.body = own.trim() === '' ? campaignBody : own;
    }

    if (Object.keys(variables).length > 0) {
      entry.variables = variables;
    }

    return entry;
  });

  const payload = { from, to, content, tags: buildTags(request, channel) };

  const schedule = resolveSchedule(request.sendAt);
  if (schedule) payload.schedule = schedule;

  return [payload];
}

module.exports = { buildPayloads, CHANNEL_MAP, bareAddress };
