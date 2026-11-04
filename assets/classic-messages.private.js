/**
 * Programmable Messaging calls for a classic campaign: sending a chunk, and
 * refreshing the statuses of messages already sent.
 *
 * Messages are sent with no statusCallback. check-status.js re-fetches every
 * message whose status can still change, and the webhook that used to take
 * callbacks could not find a message once statuses moved into Sync buckets.
 *
 * This is a *private* asset. Require it as:
 *
 *   const classicMessages = require(Runtime.getAssets()['/classic-messages.js'].path);
 */

'use strict';

/**
 * A real Twilio message SID, as opposed to the "failed-<n>" key of a send
 * Twilio refused. Mirrors MESSAGE_SID in app.js.
 */
const MESSAGE_SID = /^[A-Z]{2}[0-9a-f]{32}$/i;
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

/**
 * Keys a recipient whose chunk was claimed but whose result was never saved
 * (see claimChunk in classic-campaign.private.js). Such an entry holds only
 * `to`: its status is implied by the key.
 */
const PLACEHOLDER_PREFIX = 'unconfirmed-';

/**
 * How long a claim's placeholders read as still sending. A Function runs for
 * at most 10 seconds, so after this no sender is left to replace them.
 */
const CLAIM_SENDING_MS = 15000;

/** Statuses that never change again. */
const FINAL = new Set(['failed', 'undelivered', 'canceled', 'read']);

/** Channels that report `read`, so `delivered` is not final on them. */
const READ_RECEIPT_CHANNELS = new Set(['whatsapp', 'rcs', 'messenger']);

/**
 * Terminal failure. `undelivered` matters: Meta rejecting a WhatsApp template
 * (error 63049) lands there, and reporting that as a success is worse than
 * reporting nothing.
 */
const TERMINAL_FAILURE = new Set(['failed', 'undelivered']);

/** Sends in flight at once, within one chunk. */
const SEND_CONCURRENCY = 64;

/** Status fetches in flight at once. */
const FETCH_CONCURRENCY = 20;

/**
 * Characters kept of why a status fetch failed. The page never shows it, and
 * twilio-node's messages run long (a 404's is about 140 characters), so 32 of
 * them beside long error messages could overflow a status bucket's 16 KiB.
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
 * fallback. A null field (see packRecipient in classic-campaign.private.js) is
 * treated as absent.
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

/**
 * Sends one chunk, `concurrency` at a time. Resolves to one result per message,
 * in message order, and never rejects: a send Twilio refuses is a result,
 * recorded as a failure. So is a send still rate limited when a retry would
 * sleep past `deadline`; it can be sent again later.
 */
async function sendChunk(client, messages, {
  startIndex = 0, channel, from, messagingServiceSid, retry, deadline, now, concurrency = SEND_CONCURRENCY,
} = {}) {
  const results = new Array(messages.length);
  let next = 0;

  const sendOne = async (message, index) => {
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

/** An entry's status, lower-cased, with a placeholder's implied by its key. */
function statusOf(key, entry) {
  if (entry && entry.status) return String(entry.status).toLowerCase();
  return key.startsWith(PLACEHOLDER_PREFIX) ? 'unconfirmed' : '';
}

function isFinal(entry, channel) {
  const status = String((entry && entry.status) || '').toLowerCase();
  if (FINAL.has(status)) return true;
  return status === 'delivered' && !READ_RECEIPT_CHANNELS.has(String(channel || '').toLowerCase());
}

/** Keys of messages whose status can still change: real SIDs, not yet final. */
function pendingKeys(statuses, channel) {
  return Object.keys(statuses).filter((key) => MESSAGE_SID.test(key) && !isFinal(statuses[key], channel));
}

/**
 * The status buckets to refresh this poll: those with a status that can still
 * change, least recently checked first (never checked before any), at most
 * `limit`. `takingTurns` is true when some were left for a later poll.
 */
function selectRefreshBuckets(buckets, channel, limit) {
  const candidates = buckets
    .filter((bucket) => pendingKeys(bucket.statuses, channel).length)
    .sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || '')));
  return { selected: candidates.slice(0, limit), takingTurns: candidates.length > limit };
}

/**
 * Re-fetches from Twilio every message whose status can still change, in the
 * order given, `concurrency` at a time. No fetch starts once `deadline` has
 * passed; the rest wait for a later poll.
 *
 * Resolves to a new statuses map, the keys whose entry changed, so the caller
 * writes back only what moved, and the keys fetched at all.
 */
async function refreshStatuses(client, statuses, {
  channel, deadline, now = Date.now, concurrency = FETCH_CONCURRENCY,
} = {}) {
  const next = { ...statuses };
  const changed = new Set();
  const fetched = new Set();
  const queue = pendingKeys(statuses, channel);

  const worker = async () => {
    while (queue.length && now() < deadline) {
      const messageSid = queue.shift();
      fetched.add(messageSid);
      const before = statuses[messageSid];
      let after;
      try {
        const message = await client.messages(messageSid).fetch();
        after = {
          ...before,
          status: message.status,
          errorCode: message.errorCode,
          errorMessage: message.errorMessage,
          dateSent: message.dateSent,
          dateUpdated: message.dateUpdated,
          // Kept once set: older campaigns had these flags from the webhook.
          delivered: Boolean(before.delivered) || message.status === 'delivered' || message.status === 'read',
          read: Boolean(before.read) || message.status === 'read',
        };
        delete after.error;
      } catch (error) {
        after = { ...before, error: String(error.message).slice(0, FETCH_ERROR_MAX_CHARS) };
      }
      // Compared as JSON, which is also how Sync stores the Dates the SDK returns.
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        next[messageSid] = after;
        changed.add(messageSid);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { statuses: next, changed, fetched };
}

/**
 * What to write back for each bucket selectRefreshBuckets chose, given what
 * refreshStatuses returned. A bucket is `complete` when every status in it that
 * could change was fetched; only then is it stamped `checkedAt`, so one cut off
 * by the fetch deadline stays at the front of the queue. A bucket is written
 * when an entry in it changed or, while buckets are taking turns, when it is
 * complete, to record that it has had its turn. Buckets take turns too when
 * any was cut off, or the same ones would be fetched first on every poll.
 */
function bucketUpdates(selected, { statuses, changed, fetched }, { channel, takingTurns, checkedAt }) {
  const isComplete = (bucket) => pendingKeys(bucket.statuses, channel).every((key) => fetched.has(key));
  takingTurns = takingTurns || !selected.every(isComplete);
  return selected.map((bucket) => {
    const keys = Object.keys(bucket.statuses);
    const complete = isComplete(bucket);
    return {
      ...bucket,
      statuses: Object.fromEntries(keys.map((key) => [key, statuses[key]])),
      checkedAt: complete ? checkedAt : bucket.checkedAt,
      complete,
      write: keys.some((key) => changed.has(key)) || (takingTurns && complete),
    };
  });
}

/**
 * One bucket's statuses with each placeholder given the status it is reported
 * with: `sending` while the bucket's claim is under CLAIM_SENDING_MS old, else
 * `unconfirmed`. A claim replaced after its send, keeping the placeholders of a
 * bucket it could not write, has no `claimedAt`, so those are unconfirmed.
 * Returns a new map, for the response only: placeholders are stored as `{ to }`.
 */
function placeholderStatuses(statuses, claimedAt, now = Date.now()) {
  const sending = Boolean(claimedAt) && now - Date.parse(claimedAt) < CLAIM_SENDING_MS;
  const next = {};
  for (const [key, entry] of Object.entries(statuses)) {
    next[key] = key.startsWith(PLACEHOLDER_PREFIX)
      ? { ...entry, status: sending ? 'sending' : 'unconfirmed' }
      : entry;
  }
  return next;
}

/**
 * The derived counters. This is the only place that counts per-message
 * status, so a badge and a counter cannot disagree. `sent` is every send
 * Twilio accepted; `failed` includes the sends it refused; `pending` is
 * accepted and not yet delivered or failed, or still being sent; `unconfirmed`
 * is the recipients of a chunk whose results were never saved (see
 * classic-campaign.private.js).
 */
function tally(statuses) {
  const counts = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, unconfirmed: 0 };
  for (const [key, entry] of Object.entries(statuses)) {
    const status = statusOf(key, entry);
    const isDelivered = Boolean(entry.delivered) || status === 'delivered' || status === 'read';
    const isFailed = TERMINAL_FAILURE.has(status);
    if (isDelivered) counts.delivered++;
    if (entry.read || status === 'read') counts.read++;
    if (isFailed) counts.failed++;
    if (status === 'unconfirmed') counts.unconfirmed++;
    if (status === 'sending') counts.pending++;
    if (MESSAGE_SID.test(key)) {
      counts.sent++;
      if (!isDelivered && !isFailed) counts.pending++;
    }
  }
  return counts;
}

module.exports = {
  FETCH_ERROR_MAX_CHARS,
  messageParams,
  retryWithExponentialBackoff,
  sendChunk,
  pendingKeys,
  selectRefreshBuckets,
  refreshStatuses,
  bucketUpdates,
  placeholderStatuses,
  tally,
};
