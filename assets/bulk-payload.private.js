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

  const from = resolveSender(request.from, channelNames);

  const to = recipients.map((recipient) => ({
    address: bareAddress(recipient.to),
    channel: channelNames.to,
  }));

  return [{ from, to }];
}

module.exports = { buildPayloads, CHANNEL_MAP, bareAddress };
