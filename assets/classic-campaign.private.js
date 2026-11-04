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

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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
};
