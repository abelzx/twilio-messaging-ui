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

const MAX_RECIPIENTS_PER_OPERATION = 10000;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

const CONTENT_SID = /^HX[0-9a-f]{32}$/i;

/**
 * Detects whether a body needs protecting from Liquid at all.
 *
 * `content.text` is Liquid-templated, so `{{name}}` typed by a user would be
 * interpreted and almost certainly render empty. This used to be handled by
 * wrapping every body in `{% raw %}…{% endraw %}`, which was wrong twice over:
 * the API delivers that wrapper as literal text, so recipients received
 * "{% raw %}Hi there{% endraw %}", and a body containing `{% endraw %}` had to
 * be refused outright because it could close the wrapper early.
 *
 * Bodies are now sent verbatim when there is nothing to interpret, and routed
 * through a variable when there is — see resolveContent. So this only has to
 * answer "does Liquid care about this string", and a body containing
 * `{% endraw %}` is no longer a special case at all.
 */
const LIQUID_SYNTAX = /\{\{|\{%/;

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
    // The `default` filter is not decoration — the API validates inline Liquid
    // up front and rejects the entire request with "all template variable
    // occurrences must have default values using the 'default' filter" when any
    // variable lacks one. A bare `{{body}}` fails that check outright.
    //
    // The empty default never actually renders: the loop in buildPayloads gives
    // every recipient a `body` variable, falling back to the campaign body, and
    // the guard above rejects any recipient that would have neither. It exists
    // to satisfy the validator, not to paper over missing text.
    const content = { text: '{{ body | default: "" }}' };
    if (media.length) content.media = media;
    return { content, perRecipientBody: true };
  }

  if (!body.trim()) {
    throw httpError(400, 'A message body or a content template is required.');
  }

  // A body with no Liquid syntax in it is sent exactly as typed. It used to be
  // wrapped in `{% raw %}…{% endraw %}` to stop Liquid interpreting it, but the
  // API delivers that wrapper as literal text — recipients received
  // "{% raw %}Hi there{% endraw %}" — so the wrapper protected nothing and
  // corrupted every message. There is nothing to escape here anyway.
  if (!LIQUID_SYNTAX.test(body)) {
    const content = { text: body };
    if (media.length) content.media = media;
    return { content, perRecipientBody: false };
  }

  // A body that does contain `{{` or `{%` cannot be sent as text: Liquid would
  // interpret it, and the raw wrapper is not available. So it goes through the
  // same variable route the CSV case uses. A variable's *value* is substituted
  // in, not re-rendered, which makes this a genuine escape rather than a dodge —
  // and it is a route the API demonstrably accepts.
  //
  // perRecipientBody is true so the loop in buildPayloads assigns each recipient
  // a `body` variable; none of them has an own body here, so every one falls
  // back to this campaign body and receives identical, literal text.
  const content = { text: '{{ body | default: "" }}' };
  if (media.length) content.media = media;
  return { content, perRecipientBody: true };
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

  const schedule = resolveSchedule(request.sendAt);
  const tags = buildTags(request, channel);

  const payloads = [];
  for (let i = 0; i < to.length; i += MAX_RECIPIENTS_PER_OPERATION) {
    const slice = to.slice(i, i + MAX_RECIPIENTS_PER_OPERATION);
    const one = { from, to: slice, content, tags };
    if (schedule) one.schedule = schedule;

    // Recipient count is bounded above; payload *size* is not, because variable
    // values are arbitrary. Measured per operation, since that is what is sent.
    const bytes = Buffer.byteLength(JSON.stringify(one), 'utf8');
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw httpError(
        400,
        `One request would be ${(bytes / 1024 / 1024).toFixed(1)}MB, over the Bulk Messaging limit of 10MB. Shorten the personalisation values or split the campaign.`
      );
    }

    payloads.push(one);
  }

  return payloads;
}

module.exports = {
  buildPayloads,
  CHANNEL_MAP,
  bareAddress,
  MAX_RECIPIENTS_PER_OPERATION,
};
