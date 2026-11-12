/**
 * Programmable Messaging calls for a classic campaign: sending a chunk, and
 * refreshing the statuses of messages already sent.
 *
 * Messages are sent with no statusCallback: check-status.js fetches the statuses
 * that can still change (see classic-campaign.private.js for which).
 *
 * This is a *private* asset. Require it as:
 *
 *   const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);
 */

'use strict';

const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

/** Sends in flight at once, within one chunk. */
const SEND_CONCURRENCY = 64;

/** Status fetches in flight at once. */
const FETCH_CONCURRENCY = 20;

/**
 * Characters kept of why a status fetch failed: enough to debug with, short
 * enough to keep a response small.
 */
const FETCH_ERROR_MAX_CHARS = 64;

/**
 * Retries `fn` with exponential backoff and jitter, on 429 rate limits only.
 * A retry that would sleep past `deadline` is not made: the 429 is thrown, so
 * the caller can finish inside the Function's 10-second limit.
 */
async function retryWithExponentialBackoff(fn, options = {}) {
  const { maxRetries = 5, baseDelay = 1000, maxDelay = 30000, deadline = Infinity, now = Date.now } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isRateLimit = error.status === 429 ||
        error.code === 20429 ||
        (error.message && error.message.toLowerCase().includes('rate limit'));

      if (!isRateLimit || attempt === maxRetries) {
        throw error;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      // Up to 30% jitter, so parallel sends do not retry in lockstep.
      const totalDelay = delay + Math.random() * 0.3 * delay;
      if (now() + totalDelay > deadline) throw error;

      console.log(`Rate limit (429) encountered. Retrying in ${Math.round(totalDelay)}ms (attempt ${attempt + 1}/${maxRetries})`);

      await new Promise((resolve) => setTimeout(resolve, totalDelay));
    }
  }

  throw lastError;
}

/**
 * What client.messages.create() receives for one message. `from` is the
 * campaign's sender, used when the message carries none of its own;
 * `messagingServiceSid` is the deployment's MESSAGING_SERVICE_SID, Messenger's
 * fallback. A null field is treated as absent.
 */
function messageParams(message, { channel, from, messagingServiceSid } = {}) {
  const params = {
    to: message.to,
    from: message.from || from,
  };

  // Not required when a content template is used.
  if (message.body) {
    params.body = message.body;
  }

  if (message.contentSid) {
    params.contentSid = message.contentSid;

    // Template variable values, e.g. {"1": "Sarah", "2": "10am"}. They must
    // travel with contentSid, or the template goes out with its placeholders.
    if (message.contentVariables) {
      params.contentVariables = typeof message.contentVariables === 'string'
        ? message.contentVariables
        : JSON.stringify(message.contentVariables);
    }
  }

  // Resolve the sender BEFORE any channel prefixing. A Messaging Service is
  // chosen by SID and must travel as messagingServiceSid — never as From, and
  // never with a channel prefix glued to it, which once produced
  // from: "whatsapp:MG7f6b…".
  const usingService = MESSAGING_SERVICE_SID.test(String(params.from || ''));
  if (usingService) {
    params.messagingServiceSid = String(params.from);
    delete params.from;
  }

  // The recipient always takes the channel prefix. From only takes it when a
  // concrete sender was chosen — a service SID must stay bare.
  if (channel === 'whatsapp') {
    const wa = (v) => (String(v).startsWith('whatsapp:') ? String(v) : `whatsapp:${v}`);
    params.to = wa(params.to);
    if (params.from) params.from = wa(params.from);
  } else if (channel === 'messenger') {
    const ms = (v) => (String(v).startsWith('messenger:') ? String(v) : `messenger:${v}`);
    params.to = ms(params.to);
    if (params.from) params.from = ms(params.from);
    if (!usingService) {
      const service = message.messagingServiceSid || messagingServiceSid;
      if (service) params.messagingServiceSid = service;
    }
  } else if (channel === 'mms' || channel === 'rcs') {
    if (message.mediaUrl) {
      params.mediaUrl = Array.isArray(message.mediaUrl) ? message.mediaUrl : [message.mediaUrl];
    }
  }

  return params;
}

/** Recorded for a send not started because its call ran out of time. */
const OUT_OF_TIME = { errorCode: 20429, error: 'Not sent: the request ran out of time before this message. It can be sent again.' };

/**
 * Sends one chunk, `concurrency` at a time. Resolves to one result per message,
 * in message order, and never rejects: a send Twilio refuses is a result,
 * recorded as a failure. So is a send still rate limited when a retry would
 * sleep past `deadline`, and one not started because `deadline` had passed;
 * either can be sent again later.
 */
async function sendChunk(client, messages, {
  startIndex = 0, channel, from, messagingServiceSid, retry, deadline = Infinity, now = Date.now,
  concurrency = SEND_CONCURRENCY,
} = {}) {
  const results = new Array(messages.length);
  let next = 0;

  const sendOne = async (message, index) => {
    if (now() >= deadline) return { index, success: false, ...OUT_OF_TIME, to: message.to };
    try {
      const sent = await retryWithExponentialBackoff(
        () => client.messages.create(messageParams(message, { channel, from, messagingServiceSid })),
        { ...retry, deadline, now }
      );
      return { index, success: true, sid: sent.sid, status: sent.status, to: message.to };
    } catch (error) {
      return {
        index,
        success: false,
        error: error.message,
        errorCode: error.code || error.status,
        to: message.to,
      };
    }
  };

  const worker = async () => {
    while (next < messages.length) {
      const offset = next++;
      results[offset] = await sendOne(messages[offset], startIndex + offset);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, worker));
  return results;
}

/**
 * Fetches each message's current status from Twilio, in the order given,
 * `concurrency` at a time, starting none once `deadline` has passed. Resolves
 * to a Map from SID to its status fields, or to `{ error }` when the fetch
 * failed. A SID missing from the Map was not reached; a later poll gets it.
 */
async function fetchStatuses(client, sids, { deadline = Infinity, now = Date.now, concurrency = FETCH_CONCURRENCY } = {}) {
  const fetched = new Map();
  const queue = [...sids];

  const worker = async () => {
    while (queue.length && now() < deadline) {
      const messageSid = queue.shift();
      try {
        const message = await client.messages(messageSid).fetch();
        fetched.set(messageSid, {
          status: message.status,
          errorCode: message.errorCode == null ? null : message.errorCode,
          errorMessage: message.errorMessage || null,
          dateSent: message.dateSent || null,
          dateUpdated: message.dateUpdated || null,
        });
      } catch (error) {
        fetched.set(messageSid, { error: String(error.message).slice(0, FETCH_ERROR_MAX_CHARS) });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return fetched;
}

module.exports = { messageParams, retryWithExponentialBackoff, sendChunk, fetchStatuses };
