/**
 * Sync records for a classic (Programmable Messaging) campaign, and the chunk
 * loop that sends it.
 *
 * Sync is written as little as possible. Measured on 2026-11-12, a Map took 22
 * of 48 writes of 9 KB sent 8 at a time and refused the rest, and took 20 of 20
 * at 2 a second: about 20 writes of a few KB per 10-second window. So only what
 * Twilio cannot tell us is stored:
 *
 *   campaign_<id>         Document  owner, list fingerprint, counters, startIndex, display fields
 *   campaign_<id>_chunks  Map       chunk start -> { claimedAt, to, sentAt, rows, checkedAt, settled }
 *
 * The recipient list is not stored. The browser holds it and sends it slice by
 * slice; resuming means sending the same list again, which its fingerprint, a
 * SHA-256 of the messages stored on the Document, must match. Statuses come
 * from Twilio; a chunk's record is rewritten only when a poll refreshes it.
 *
 * Chunks are fixed: chunk k is recipients 128k to 128k + 127, keyed by its
 * first index, zero-padded so that Sync's key order is send order. Before a
 * chunk is sent its record is created holding the recipients' numbers. Sync
 * refuses a key that exists, so a chunk is sent at most once, by whichever
 * sender created its record. After the send the record is updated with one row
 * per recipient, in the order of `to`:
 *
 *   [sid or null, status, errorCode or null, updated (epoch seconds) or null]
 *
 * A record with no rows is a chunk whose result was never saved: it is being
 * sent, or its send was cut off. Its recipients show as "sending", then as
 * "not confirmed".
 *
 * This is a *private* asset. Require it as:
 *
 *   const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
 */

'use strict';

/** Marks a Document laid out as above. Earlier layouts cannot be continued. */
const STORAGE = 'lean';

/** Recipients per chunk. Mirrors CHUNK_SIZE in app.js. */
const CHUNK_SIZE = 128;

/**
 * Least time between chunk starts. A chunk writes its record twice, and a Map
 * takes about 2 writes a second once its burst allowance is spent.
 */
const CHUNK_INTERVAL_MS = 1100;

/**
 * How long a chunk is assumed to take before one has been timed in this call.
 * Each chunk is then assumed to take as long as the longest so far.
 */
const FIRST_CHUNK_ESTIMATE_MS = 2500;

/** Budget for the display fields stored once on the Document. */
const SHARED_MAX_BYTES = 4 * 1024;

/**
 * How long a claim with no result reads as still sending. A Function runs for
 * at most 10 seconds, so after this no sender is left to record it.
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

/** A real Twilio message SID. Mirrors MESSAGE_SID in app.js. */
const MESSAGE_SID = /^[A-Z]{2}[0-9a-f]{32}$/i;

const KEY_DIGITS = 7;

const NOT_FOUND = 20404;
const ITEM_EXISTS = 54208;
const NAME_TAKEN = 54301;

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isNotFound(error) {
  return Boolean(error) && (error.status === 404 || error.code === NOT_FOUND);
}

/** Sync refused a write for its rate, even after the client's own retries. */
function isRateLimited(error) {
  return Boolean(error) && (error.status === 429 || error.code === 20429);
}

function chunkKey(start) {
  return String(start).padStart(KEY_DIGITS, '0');
}

function chunksMapName(campaignId) {
  return `${campaignId}_chunks`;
}

function isLean(campaignData) {
  return Boolean(campaignData) && campaignData.storage === STORAGE;
}

/**
 * Fields every message carries with the same value, for the campaign card and
 * delivery panel (campaign-details.private.js reads them as `shared`).
 */
function sharedFields(messages) {
  const shared = {};
  const first = messages[0] || {};
  for (const field of Object.keys(first)) {
    if (field === 'to') continue;
    const json = JSON.stringify(first[field]);
    if (json === undefined) continue;
    if (!messages.every((message) => JSON.stringify(message[field]) === json)) continue;
    if (byteSize({ ...shared, [field]: first[field] }) > SHARED_MAX_BYTES) continue;
    shared[field] = first[field];
  }
  return shared;
}

/**
 * A new campaign's Document data. `accountSid` is for display only, never an
 * authorization key: ownership is `ownerKey` alone.
 */
function newCampaignData({ ownerKey, accountSid, totalMessages, fingerprint, shared, channel, from, campaignName, details, now }) {
  return {
    storage: STORAGE,
    ownerKey,
    accountSid,
    totalMessages,
    fingerprint,
    sent: 0,
    failed: 0,
    pending: totalMessages,
    startIndex: 0,
    shared,
    channel,
    from,
    campaignName: campaignName || null,
    details,
    createdAt: now,
    lastUpdated: now,
  };
}

/** A sent chunk's results as rows, in recipient order. */
function rowsFor(results) {
  return results.map((result) => (result.success
    ? [result.sid, result.status, null, null]
    : [null, 'failed', result.errorCode || null, null]));
}

function epochSeconds(date) {
  if (!date) return null;
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function isFinal(status, channel) {
  const value = String(status || '').toLowerCase();
  if (FINAL.has(value)) return true;
  return value === 'delivered' && !READ_RECEIPT_CHANNELS.has(String(channel || '').toLowerCase());
}

/** Positions, within the chunk, of messages whose status can still change. */
function pendingRows(chunk, channel) {
  return (chunk.rows || []).flatMap((row, i) => (row[0] && !isFinal(row[1], channel) ? [i] : []));
}

/**
 * The chunks to refresh this poll: those with a status that can still change,
 * least recently checked first (never checked before any), at most `limit`.
 * `takingTurns` is true when some were left for a later poll.
 */
function selectChunks(chunks, channel, limit) {
  const candidates = chunks
    .filter((chunk) => pendingRows(chunk, channel).length)
    .sort((a, b) => String(a.checkedAt || '').localeCompare(String(b.checkedAt || '')));
  return { selected: candidates.slice(0, limit), takingTurns: candidates.length > limit };
}

/**
 * A chunk with fetched statuses applied. `changed` is whether any row moved;
 * `complete` whether every pending row was reached (a fetch that failed counts
 * as reached: it is retried on the chunk's next turn); `settled` on the new
 * chunk whether no row can change any more.
 */
function applyFetched(chunk, fetched, channel) {
  let changed = false;
  let complete = true;
  const rows = (chunk.rows || []).map((row) => {
    const [messageSid, status] = row;
    if (!messageSid || isFinal(status, channel)) return row;
    const result = fetched.get(messageSid);
    if (!result) {
      complete = false;
      return row;
    }
    if (result.error) return row;
    const next = [messageSid, result.status, result.errorCode == null ? null : result.errorCode, epochSeconds(result.dateUpdated)];
    if (JSON.stringify(next) !== JSON.stringify(row)) changed = true;
    return next;
  });
  const settled = rows.every(([messageSid, status]) => !messageSid || isFinal(status, channel));
  return { chunk: { ...chunk, rows, settled }, changed, complete };
}

/**
 * What to write back for each chunk selectChunks chose. A chunk is stamped
 * `checkedAt` only when complete, so one cut off by the fetch deadline stays at
 * the front of the queue. It is written when a row changed or, while chunks are
 * taking turns, when complete, to record its turn. Chunks take turns too when
 * any was cut off, or the same ones would be fetched first on every poll.
 */
function refreshPlan(selected, fetched, { channel, takingTurns, checkedAt }) {
  const applied = selected.map((chunk) => applyFetched(chunk, fetched, channel));
  const rotating = takingTurns || !applied.every((entry) => entry.complete);
  return applied.map(({ chunk, changed, complete }) => ({
    chunk: { ...chunk, checkedAt: complete ? checkedAt : chunk.checkedAt },
    write: changed || (rotating && complete),
  }));
}

/**
 * One chunk as the delivery table reads it: entries keyed by message SID, by
 * `failed-<index>` for a send Twilio refused, or by `unconfirmed-<index>` for a
 * recipient whose result was never saved.
 */
function chunkStatuses(chunk, now = Date.now()) {
  const statuses = {};
  const to = chunk.to || [];
  if (!chunk.rows) {
    const sending = Boolean(chunk.claimedAt) && now - Date.parse(chunk.claimedAt) < CLAIM_SENDING_MS;
    to.forEach((number, i) => {
      statuses[`unconfirmed-${chunk.start + i}`] = { to: number, status: sending ? 'sending' : 'unconfirmed' };
    });
    return statuses;
  }
  chunk.rows.forEach(([messageSid, status, errorCode, updated], i) => {
    statuses[messageSid || `failed-${chunk.start + i}`] = {
      to: to[i] || null,
      status,
      errorCode,
      sentAt: chunk.sentAt || null,
      dateUpdated: updated ? new Date(updated * 1000).toISOString() : null,
      delivered: status === 'delivered' || status === 'read',
      read: status === 'read',
    };
  });
  return statuses;
}

/** SIDs in an older campaign's inline statuses whose status can still change. */
function legacyPending(statuses, channel) {
  return Object.keys(statuses).filter((key) =>
    MESSAGE_SID.test(key) && !isFinal((statuses[key] || {}).status, channel));
}

/** An older campaign's inline statuses with fetched results applied. */
function applyLegacy(statuses, fetched) {
  const next = { ...statuses };
  for (const [messageSid, result] of fetched) {
    const before = next[messageSid];
    if (!before || result.error) continue;
    next[messageSid] = {
      ...before,
      status: result.status,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      dateSent: result.dateSent,
      dateUpdated: result.dateUpdated,
      // Kept once set: older campaigns had these flags from the webhook.
      delivered: Boolean(before.delivered) || result.status === 'delivered' || result.status === 'read',
      read: Boolean(before.read) || result.status === 'read',
    };
  }
  return next;
}

/**
 * The derived counters, from the statuses as the delivery table reads them.
 * This is the only place that counts per-message status, so a badge and a
 * counter cannot disagree. `sent` is every send Twilio accepted; `failed`
 * includes the sends it refused; `pending` is accepted and not yet delivered or
 * failed, or still being sent; `unconfirmed` is recipients whose result was
 * never saved.
 */
function tally(statuses) {
  const counts = { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, unconfirmed: 0 };
  for (const [key, entry] of Object.entries(statuses)) {
    const status = String((entry && entry.status) || '').toLowerCase();
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

/** Creates the campaign's chunk Map. One left by an earlier attempt is reused. */
async function createChunksMap(syncClient, campaignId) {
  try {
    await syncClient.syncMaps.create({ uniqueName: chunksMapName(campaignId) });
  } catch (error) {
    if (error.code !== NAME_TAKEN) throw error;
  }
}

/**
 * Claims the chunk starting at `start` before any of it is sent, by creating
 * its record holding the recipients' numbers. Sync refuses a key that exists,
 * so resolves to false when the chunk is already claimed, by another sender or
 * by an earlier attempt that may have sent it.
 */
async function claimChunk(syncClient, campaignId, start, messages, claimedAt) {
  try {
    await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems.create({
      key: chunkKey(start),
      data: { claimedAt, to: messages.map((message) => message.to) },
    });
    return true;
  } catch (error) {
    if (error.code === ITEM_EXISTS) return false;
    throw error;
  }
}

/** Records a sent chunk's rows over its claim. */
async function recordChunk(syncClient, campaignId, start, { claimedAt, to }, rows, sentAt) {
  await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems(chunkKey(start)).update({
    data: { claimedAt, to, sentAt, rows },
  });
}

/** Every chunk record in send order, or [] when the Map is missing. */
async function readChunks(syncClient, campaignId) {
  let items;
  try {
    items = await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems.list({ pageSize: 100 });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return items.map((item) => ({ ...(item.data || {}), key: item.key, start: Number(item.key), revision: item.revision }));
}

/**
 * Writes a refreshed chunk record back, conditional on the revision it was
 * read at: a 412 means something wrote it since.
 */
async function updateChunk(syncClient, campaignId, chunk) {
  const { claimedAt, to, sentAt, rows, checkedAt, settled } = chunk;
  await syncClient.syncMaps(chunksMapName(campaignId)).syncMapItems(chunk.key).update({
    data: { claimedAt, to, sentAt, rows, checkedAt, settled },
    ...(chunk.revision ? { ifMatch: chunk.revision } : {}),
  });
}

/**
 * Sends `messages`, the slice of the campaign starting at `offset`, chunk by
 * chunk until the slice is done, `deadline` passes, or the next chunk would
 * end after `finishBy` if it took as long as the longest so far: claiming each
 * chunk, sending it, recording its rows. A chunk already claimed is skipped,
 * uncounted, because it may have been sent. Chunk starts are at least
 * `interval` apart, to stay under the Map's write rate; there is no wait when
 * the next chunk could not start after it.
 *
 * `send(messages, startIndex)` is classic-messages.js sendChunk, passed in
 * because deployed assets cannot require each other. `campaignData` is the
 * Document's data, updated in place and written once, at the end.
 *
 * Resolves to { resumeFrom, checkpointFailed, throttled }: where the next call
 * starts; whether a result or the Document could not be saved; and whether Sync
 * refused a write for its rate, so the caller should wait before the next call.
 * A sent chunk whose rows cannot be recorded keeps its claim, so its recipients
 * show as not confirmed rather than disappearing. Throws only when the first
 * claim fails for a reason other than the rate.
 */
async function runChunks({
  syncClient, campaignId, campaignData, messages, offset, deadline, finishBy = Infinity, send,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), interval = CHUNK_INTERVAL_MS,
}) {
  const end = offset + messages.length;
  let currentIndex = offset;
  let checkpointFailed = false;
  let throttled = false;
  let longest = null;
  const canStart = (at) => at < deadline && at + (longest === null ? FIRST_CHUNK_ESTIMATE_MS : longest) <= finishBy;

  while (currentIndex < end && canStart(now())) {
    const chunkStart = currentIndex;
    const started = now();
    const batch = messages.slice(chunkStart - offset, chunkStart - offset + CHUNK_SIZE);
    const claimedAt = new Date(started).toISOString();

    let claimed;
    try {
      claimed = await claimChunk(syncClient, campaignId, chunkStart, batch, claimedAt);
    } catch (error) {
      if (isRateLimited(error)) {
        throttled = true;
        break;
      }
      if (currentIndex === offset) throw error;
      console.error(`Could not claim ${campaignId} at index ${chunkStart}:`, error);
      break;
    }
    currentIndex += batch.length;

    if (claimed) {
      const sending = now();
      const results = await send(batch, chunkStart);
      const recording = now();
      const accepted = results.filter((result) => result.success).length;
      campaignData.sent = (campaignData.sent || 0) + accepted;
      campaignData.failed = (campaignData.failed || 0) + (results.length - accepted);
      let recordError = null;
      try {
        await recordChunk(syncClient, campaignId, chunkStart,
          { claimedAt, to: batch.map((message) => message.to) }, rowsFor(results), new Date(now()).toISOString());
      } catch (error) {
        recordError = error;
      }
      const done = now();
      // Read in the Function logs to see where a call's time goes.
      console.log(`chunk ${chunkStart} of ${campaignId}: claim ${sending - started} ms, `
        + `send ${recording - sending} ms, record ${done - recording} ms`);
      if (recordError) {
        console.error(`Could not record ${campaignId} at index ${chunkStart}:`, recordError);
        checkpointFailed = true;
        throttled = throttled || isRateLimited(recordError);
        break;
      }
      longest = Math.max(longest || 0, done - started);
    }

    const elapsed = now() - started;
    if (currentIndex < end && elapsed < interval) {
      if (!canStart(now() + interval - elapsed)) break;
      await sleep(interval - elapsed);
    }
  }

  // Once per call. With claims guarding every chunk, a stale stored index can
  // only make a later call skip chunks already claimed, never re-send them.
  campaignData.startIndex = Math.max(campaignData.startIndex || 0, currentIndex);
  campaignData.pending = Math.max(0, campaignData.totalMessages - (campaignData.sent || 0) - (campaignData.failed || 0));
  campaignData.lastUpdated = new Date(now()).toISOString();
  try {
    await syncClient.documents(campaignId).update({ data: campaignData });
  } catch (error) {
    console.error(`Could not save progress for ${campaignId} at index ${currentIndex}:`, error);
    checkpointFailed = true;
  }

  return { resumeFrom: currentIndex, checkpointFailed, throttled };
}

/** The 200 body of send-messages.js. */
function progressBody(campaignId, campaignData, outcome) {
  return {
    success: true,
    campaignId,
    totalMessages: campaignData.totalMessages,
    resumeFrom: outcome.resumeFrom,
    isComplete: outcome.resumeFrom >= campaignData.totalMessages,
    checkpointFailed: outcome.checkpointFailed,
    throttled: outcome.throttled,
    stats: { sent: campaignData.sent, failed: campaignData.failed },
  };
}

module.exports = {
  STORAGE,
  CHUNK_SIZE,
  CHUNK_INTERVAL_MS,
  FIRST_CHUNK_ESTIMATE_MS,
  SHARED_MAX_BYTES,
  CLAIM_SENDING_MS,
  chunkKey,
  chunksMapName,
  isLean,
  sharedFields,
  newCampaignData,
  rowsFor,
  isFinal,
  pendingRows,
  selectChunks,
  applyFetched,
  refreshPlan,
  chunkStatuses,
  legacyPending,
  applyLegacy,
  tally,
  createChunksMap,
  claimChunk,
  recordChunk,
  readChunks,
  updateChunk,
  runChunks,
  progressBody,
};
