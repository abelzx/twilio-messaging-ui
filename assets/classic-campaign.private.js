/**
 * Sync storage for a classic (Programmable Messaging) campaign, and the chunk
 * loop that sends from it.
 *
 * A classic campaign used to live in one Sync Document holding its whole
 * recipient list and every message status. A Document holds at most 16 KiB, so
 * campaigns of about 50 recipients and up failed: creation failed outright, or
 * a checkpoint failed after its chunk had already been sent, and the retry sent
 * that chunk again. See docs/superpowers/specs/2026-09-02-sync-storage-ceiling-design.md.
 *
 * The Document now holds only what does not grow with the campaign. The two
 * lists live in Sync Maps, split into buckets:
 *
 *   campaign_<id>             Document  owner, counters, storedCount, startIndex, shared fields
 *   campaign_<id>_recipients  Map       key -> { recipients: [...] }      up to 128 recipients
 *   campaign_<id>_statuses    Map       key -> { statuses, checkedAt }    up to 32 statuses
 *
 * A key is the index of the first recipient its item covers, zero-padded so
 * that Sync's ascending key order is send order. A chunk is one recipient
 * bucket, so startIndex is always a recipient bucket key. The chunk's statuses
 * go in status buckets keyed at its start, start + 32, start + 64 and
 * start + 96, so no status bucket is written by two chunks.
 *
 * The recipient list arrives in slices, one per send-messages call, because a
 * Function request is capped at 1 MB. storedCount says how much has arrived.
 * Nothing is sent until all of it has, so a campaign whose upload was cut off
 * has sent nothing.
 *
 * Maps are created without a TTL, as Documents always have been: an expired Map
 * under a surviving Document would empty the delivery panel of a campaign that
 * still shows in the list.
 *
 * This is a *private* asset. Require it as:
 *
 *   const storage = require(Runtime.getAssets()['/classic-campaign.js'].path);
 */

'use strict';

/** Marks a Document laid out as above. One without it is the old, inline shape. */
const STORAGE = 'buckets';

/** Recipients per recipient bucket, and so per chunk sent. */
const RECIPIENT_BUCKET_MAX_ENTRIES = 128;

/**
 * Bytes per recipient bucket. The same margin bulk-snapshot.js keeps under the
 * 16 KiB item limit, since the stored size can differ slightly from the size
 * sent. Long per-recipient bodies fill a bucket by size before count.
 */
const RECIPIENT_BUCKET_MAX_BYTES = 9 * 1024;

/**
 * Entries per status bucket. An enriched status entry runs about 260 bytes, so
 * 32 of them is about 8.4 KiB, under the 10 KiB at which Sync throttles writes
 * to 2/s.
 */
const STATUS_BUCKET_ENTRIES = 32;

/** Budget for the fields stored once on the Document instead of per recipient. */
const SHARED_MAX_BYTES = 4 * 1024;

/** Sync writes in flight at once. Retries on 429 come from the client's autoRetry. */
const WRITE_CONCURRENCY = 8;

const KEY_DIGITS = 7;
const NOT_FOUND = 20404;
const ITEM_EXISTS = 54208;

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isNotFound(error) {
  return Boolean(error) && (error.status === 404 || error.code === NOT_FOUND);
}

const EMPTY_BUCKET_BYTES = byteSize({ recipients: [] });

function bucketKey(start) {
  return String(start).padStart(KEY_DIGITS, '0');
}

function recipientsMapName(campaignId) {
  return `${campaignId}_recipients`;
}

function statusesMapName(campaignId) {
  return `${campaignId}_statuses`;
}

function isBucketed(campaignData) {
  return Boolean(campaignData) && campaignData.storage === STORAGE;
}

/** True once the whole recipient list is in Sync, so the campaign can be sent and resumed. */
function isFullyStored(campaignData) {
  return isBucketed(campaignData) && (campaignData.storedCount || 0) >= campaignData.totalMessages;
}

/**
 * Fields every message carries with the same value. They are stored once, on
 * the Document. A typed body or one template for the whole campaign is the
 * common case, and leaves each stored recipient as little more than `to`.
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
 * One recipient as stored: `to`, plus every field that differs from `shared`.
 * A shared field this message lacks is stored as null, which every send path
 * treats as absent. That only happens in a later slice, packed against the
 * fields the first slice shared.
 */
function packRecipient(message, shared) {
  const entry = { to: message.to };
  for (const [field, value] of Object.entries(message)) {
    if (field === 'to') continue;
    if (field in shared && JSON.stringify(value) === JSON.stringify(shared[field])) continue;
    entry[field] = value;
  }
  for (const field of Object.keys(shared)) {
    if (!(field in message)) entry[field] = null;
  }
  return entry;
}

function unpackRecipient(entry, shared) {
  return { ...shared, ...entry };
}

/**
 * Splits messages into recipient buckets of at most
 * RECIPIENT_BUCKET_MAX_ENTRIES recipients and RECIPIENT_BUCKET_MAX_BYTES bytes,
 * keyed from `startIndex`. A recipient bigger than that gets a bucket to
 * itself; Twilio's own body limits keep it under 16 KiB.
 */
function packRecipients(messages, { shared = sharedFields(messages), startIndex = 0 } = {}) {
  const buckets = [];
  let current = null;
  // Serialized size of { recipients: [...] } so far: the wrapper, each entry,
  // and a comma between entries. Kept as a running total rather than
  // re-serializing the bucket on every add.
  let bytes = 0;

  messages.forEach((message, offset) => {
    const entry = packRecipient(message, shared);
    const entryBytes = byteSize(entry);
    if (current && current.recipients.length < RECIPIENT_BUCKET_MAX_ENTRIES &&
        bytes + 1 + entryBytes <= RECIPIENT_BUCKET_MAX_BYTES) {
      current.recipients.push(entry);
      bytes += 1 + entryBytes;
      return;
    }
    current = { start: startIndex + offset, recipients: [entry] };
    buckets.push(current);
    bytes = EMPTY_BUCKET_BYTES + entryBytes;
  });

  return { shared, buckets };
}

/**
 * One chunk's results as status entries. An accepted send is keyed by its SID.
 * A refused one has no SID, so it is keyed by its position, which is stable:
 * re-sending a chunk overwrites the entry rather than duplicating it. Without an
 * entry a refusal would be invisible, both in check-status.js's counters and in
 * the delivery table.
 */
function statusEntries(results, sentAt) {
  const entries = {};
  for (const result of results) {
    if (result.success) {
      entries[result.sid] = { status: result.status, to: result.to, sentAt };
    } else {
      entries[`failed-${result.index}`] = {
        status: 'failed',
        to: result.to,
        errorCode: result.errorCode || null,
        errorMessage: result.error || 'Twilio rejected the message',
        sentAt,
      };
    }
  }
  return entries;
}

/**
 * A new campaign's Document data. `accountSid` is for display only, never an
 * authorization key: ownership is `ownerKey` alone.
 */
function newCampaignData({ ownerKey, accountSid, totalMessages, shared, channel, from, campaignName, details, now }) {
  return {
    storage: STORAGE,
    ownerKey,
    accountSid,
    totalMessages,
    storedCount: 0,
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

/** Runs `tasks` (functions returning promises) at most `limit` at a time. */
async function inBatches(tasks, limit = WRITE_CONCURRENCY) {
  const results = [];
  for (let i = 0; i < tasks.length; i += limit) {
    results.push(...(await Promise.all(tasks.slice(i, i + limit).map((task) => task()))));
  }
  return results;
}

/** Creates an item, or overwrites it when the key is already taken. */
async function putItem(items, key, data) {
  try {
    await items.create({ key, data });
  } catch (error) {
    if (error.code !== ITEM_EXISTS) throw error;
    await items(key).update({ data });
  }
}

async function createMaps(syncClient, campaignId) {
  await syncClient.syncMaps.create({ uniqueName: recipientsMapName(campaignId) });
  await syncClient.syncMaps.create({ uniqueName: statusesMapName(campaignId) });
}

/**
 * Stores one upload slice, starting at `startIndex`, packed against the
 * campaign's `shared` fields. Buckets are written in order, WRITE_CONCURRENCY
 * at a time. Once `deadline` passes no further batch starts, but the first
 * always does, so every call makes progress. Resolves to how many recipients
 * are now stored; the caller sends the next slice from there.
 */
async function storeRecipients(syncClient, campaignId, messages, { startIndex, shared, deadline, now = Date.now }) {
  const { buckets } = packRecipients(messages, { shared, startIndex });
  const items = syncClient.syncMaps(recipientsMapName(campaignId)).syncMapItems;
  let stored = startIndex;

  for (let i = 0; i < buckets.length; i += WRITE_CONCURRENCY) {
    if (i > 0 && now() >= deadline) break;
    const batch = buckets.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(batch.map((bucket) =>
      putItem(items, bucketKey(bucket.start), { recipients: bucket.recipients })));
    const last = batch[batch.length - 1];
    stored = last.start + last.recipients.length;
  }

  return stored;
}

/** The recipient bucket keyed `start`, or null when no bucket starts there. */
async function readRecipientBucket(syncClient, campaignId, start) {
  try {
    const item = await syncClient.syncMaps(recipientsMapName(campaignId)).syncMapItems(bucketKey(start)).fetch();
    return { start, recipients: (item.data && item.data.recipients) || [] };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Records one status bucket's send results. The key normally does not exist
 * yet. It does when a chunk is sent a second time, and then the new entries are
 * merged in, so the first send's SIDs stay on record beside the second's.
 */
async function writeStatusBucket(syncClient, campaignId, start, statuses) {
  const items = syncClient.syncMaps(statusesMapName(campaignId)).syncMapItems;
  const key = bucketKey(start);
  try {
    await items.create({ key, data: { statuses } });
  } catch (error) {
    if (error.code !== ITEM_EXISTS) throw error;
    const existing = await items(key).fetch();
    const before = (existing.data && existing.data.statuses) || {};
    await items(key).update({ data: { statuses: { ...before, ...statuses } } });
  }
}

/**
 * Every status bucket in send order, or [] when the Map is missing. A bucket
 * not yet refreshed by check-status.js has a null `checkedAt`.
 */
async function readStatusBuckets(syncClient, campaignId) {
  let items;
  try {
    items = await syncClient.syncMaps(statusesMapName(campaignId)).syncMapItems.list({ pageSize: 100 });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return items.map((item) => ({
    key: item.key,
    statuses: (item.data && item.data.statuses) || {},
    checkedAt: (item.data && item.data.checkedAt) || null,
  }));
}

async function updateStatusBucket(syncClient, campaignId, key, statuses, checkedAt) {
  await syncClient.syncMaps(statusesMapName(campaignId)).syncMapItems(key).update({
    data: { statuses, checkedAt },
  });
}

/** One chunk's results split into the status buckets they belong in. */
function statusGroups(chunkStart, results) {
  const groups = [];
  for (let i = 0; i < results.length; i += STATUS_BUCKET_ENTRIES) {
    groups.push({ start: chunkStart + i, results: results.slice(i, i + STATUS_BUCKET_ENTRIES) });
  }
  return groups;
}

/**
 * Sends from `startIndex` until the campaign is done or `deadline` passes, one
 * recipient bucket per chunk, recording each chunk's statuses and checkpoint as
 * it goes.
 *
 * `send(messages, startIndex)` sends one chunk and resolves to one result per
 * message (classic-messages.js sendChunk). It is passed in because assets
 * cannot require each other once deployed. `campaignData` is the Document's
 * data and is updated in place.
 *
 * A failed checkpoint does not fail the call. By then the chunk has been sent,
 * and failing would send the browser back to retry it, which is how recipients
 * used to get the same message twice. The loop stops and reports
 * `checkpointFailed`, and `resumeFrom` still moves past the chunk. The cost is
 * that chunk's statuses, and its share of the counters if the Document write
 * was the one that failed.
 */
async function runChunks({ syncClient, campaignId, campaignData, startIndex, deadline, send, now = Date.now }) {
  const storedIndex = campaignData.startIndex || 0;
  const shared = campaignData.shared || {};
  let currentIndex = startIndex;
  let results = [];
  let chunks = 0;
  let checkpointFailed = false;

  while (currentIndex < campaignData.totalMessages && now() < deadline) {
    const bucket = await readRecipientBucket(syncClient, campaignId, currentIndex);
    if (!bucket || !bucket.recipients.length) {
      throw new Error(`No stored recipients start at index ${currentIndex}`);
    }

    const chunkStart = currentIndex;
    results = await send(bucket.recipients.map((entry) => unpackRecipient(entry, shared)), chunkStart);
    chunks++;
    currentIndex += bucket.recipients.length;

    const accepted = results.filter((result) => result.success).length;
    campaignData.sent = (campaignData.sent || 0) + accepted;
    campaignData.failed = (campaignData.failed || 0) + (results.length - accepted);
    campaignData.pending = Math.max(0, campaignData.totalMessages - campaignData.sent - campaignData.failed);
    campaignData.startIndex = currentIndex;
    campaignData.lastUpdated = new Date(now()).toISOString();

    try {
      await Promise.all(statusGroups(chunkStart, results).map((group) =>
        writeStatusBucket(syncClient, campaignId, group.start, statusEntries(group.results, campaignData.lastUpdated))));
      await syncClient.documents(campaignId).update({ data: campaignData });
    } catch (error) {
      console.error(`Checkpoint failed for ${campaignId} at index ${currentIndex}:`, error);
      checkpointFailed = true;
      break;
    }
  }

  // A resume that starts past the stored index, after a failed checkpoint, and
  // finds nothing left to send must still save the index, or the campaign would
  // show as in progress forever.
  if (!chunks && currentIndex !== storedIndex) {
    campaignData.startIndex = currentIndex;
    campaignData.lastUpdated = new Date(now()).toISOString();
    try {
      await syncClient.documents(campaignId).update({ data: campaignData });
    } catch (error) {
      console.error(`Checkpoint failed for ${campaignId} at index ${currentIndex}:`, error);
      checkpointFailed = true;
    }
  }

  return { resumeFrom: currentIndex, results, checkpointFailed };
}

/** The 200 body of send-messages.js and resume-execution.js. */
function progressBody(campaignId, campaignData, startIndex, outcome) {
  const isComplete = outcome.resumeFrom >= campaignData.totalMessages;
  return {
    success: true,
    campaignId,
    storedCount: campaignData.storedCount,
    processed: outcome.resumeFrom - startIndex,
    totalProcessed: outcome.resumeFrom,
    totalMessages: campaignData.totalMessages,
    isComplete,
    hasMore: !isComplete,
    resumeFrom: outcome.resumeFrom,
    results: outcome.results,
    checkpointFailed: outcome.checkpointFailed,
    stats: {
      sent: campaignData.sent,
      failed: campaignData.failed,
      pending: campaignData.pending,
    },
  };
}

module.exports = {
  STORAGE,
  RECIPIENT_BUCKET_MAX_ENTRIES,
  RECIPIENT_BUCKET_MAX_BYTES,
  STATUS_BUCKET_ENTRIES,
  SHARED_MAX_BYTES,
  WRITE_CONCURRENCY,
  bucketKey,
  recipientsMapName,
  statusesMapName,
  isBucketed,
  isFullyStored,
  sharedFields,
  packRecipients,
  unpackRecipient,
  statusEntries,
  newCampaignData,
  inBatches,
  createMaps,
  storeRecipients,
  readRecipientBucket,
  writeStatusBucket,
  readStatusBuckets,
  updateStatusBucket,
  runChunks,
  progressBody,
};
