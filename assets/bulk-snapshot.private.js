/**
 * Keeps a copy of a bulk campaign's per-recipient rows in Sync.
 *
 * The Bulk Messaging API does not keep them. Campaigns sent on 2026-09-03 were
 * returning 404 for their operations and an empty message list two months
 * later, on 2026-11-03, while the account's whole `GET /v1/Messages` was empty
 * too. The retention period is not documented (the API is in Public Beta). Until
 * this copy existed, the delivery panel went blank once Twilio dropped the data,
 * even though the campaign's totals were still in Sync.
 *
 * Rows are saved each time the delivery panel loads them live, and read back
 * only when the live list comes back empty. Only campaigns opened at least once
 * before Twilio expired them have anything to show.
 *
 * This is a *private* asset. Require it as:
 *
 *   const snapshot = require(Runtime.getAssets()['/bulk-snapshot.js'].path);
 *
 * Storage shape: one Sync Map per campaign, never a Document. Documents are
 * listed by list-campaigns.js with a 1000-item limit, so filling them with row
 * chunks would hide real campaigns. Each Map item holds one chunk of one page of
 * one operation, packed as tuples to fit as many rows as possible per item:
 * Sync allows 20 writes/s per Map, and only 2/s for items of 10 KiB or more.
 */

'use strict';

/**
 * Bytes per item. Below the 2 writes/s threshold, which applies at 10 KiB and
 * up, and well under Sync's 16 KiB item limit. Sync warns that stored size can
 * differ slightly from the size sent, so it is not safe to fill items to 16 KiB.
 */
const MAX_ITEM_BYTES = 9 * 1024;

const NOT_FOUND = 20404;
const NAME_TAKEN = 54301;
const ITEM_EXISTS = 54208;

function mapNameFor(campaignId) {
  return `${campaignId}_rows`;
}

function isNotFound(error) {
  return error && (error.status === 404 || error.code === NOT_FOUND);
}

/**
 * The recipient address of a row. The shape of `to` is not confirmed, so this
 * accepts the same shapes as `bulkRecipientAddress` in app.js: a string,
 * `{ address }`, or an array whose first element is one of those.
 */
function addressOf(to) {
  if (typeof to === 'string') return to;
  if (Array.isArray(to)) return addressOf(to[0]);
  if (to && typeof to.address === 'string') return to.address;
  return '';
}

/** One row as a tuple. Error fields are added only when the row has them. */
function pack(row) {
  const tuple = [
    row.id || row.messageId || '',
    addressOf(row.to),
    row.status || '',
    row.createdAt || null,
    row.updatedAt || null,
  ];
  if (row.errorCode != null || row.errorMessage != null) {
    tuple.push(row.errorCode == null ? null : row.errorCode);
    tuple.push(row.errorMessage == null ? null : row.errorMessage);
  }
  return tuple;
}

function unpack(tuple) {
  const [id, to, status, createdAt, updatedAt, errorCode, errorMessage] = tuple;
  return {
    id,
    to,
    status,
    createdAt,
    updatedAt,
    errorCode: errorCode == null ? null : errorCode,
    errorMessage: errorMessage == null ? null : errorMessage,
  };
}

/**
 * Splits one page of rows into Map items of at most `maxBytes` each.
 *
 * The key encodes operation, page and chunk, zero-padded so that Sync's
 * ascending key order matches page order. Loading the same page again writes
 * the same keys, so newer statuses replace older ones.
 */
function chunkRows(rows, { operationIndex, pageIndex, savedAt, maxBytes = MAX_ITEM_BYTES }) {
  const stamp = savedAt || new Date().toISOString();
  const prefix = `op${String(operationIndex).padStart(3, '0')}-p${String(pageIndex).padStart(5, '0')}`;
  const sizeOf = (packed) => Buffer.byteLength(JSON.stringify({ savedAt: stamp, rows: packed }));

  const chunks = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      key: `${prefix}-c${String(chunks.length).padStart(3, '0')}`,
      data: { savedAt: stamp, rows: current },
    });
    current = [];
  };

  for (const row of rows) {
    const tuple = pack(row);
    if (current.length && sizeOf([...current, tuple]) > maxBytes) flush();
    current.push(tuple);
  }
  flush();

  return chunks;
}

/**
 * Turns Map items back into rows, one per message.
 *
 * Page boundaries can move while an operation is still creating messages, so
 * the same message can be saved under two keys. The copy with the newest
 * `savedAt` is kept.
 */
function expandItems(items) {
  const byId = new Map();
  let latest = null;

  for (const { data } of items) {
    if (!data || !Array.isArray(data.rows)) continue;
    const savedAt = data.savedAt || '';
    if (savedAt && (!latest || savedAt > latest)) latest = savedAt;

    data.rows.forEach((tuple, index) => {
      const row = unpack(tuple);
      const id = row.id || `${savedAt}-${index}`;
      const existing = byId.get(id);
      if (!existing || savedAt >= existing.savedAt) byId.set(id, { savedAt, row });
    });
  }

  return { rows: [...byId.values()].map((entry) => entry.row), savedAt: latest };
}

/** Creates a Map item, creating the Map first if it does not exist yet. */
async function createItem(syncClient, name, key, data) {
  const items = syncClient.syncMaps(name).syncMapItems;
  try {
    await items.create({ key, data });
  } catch (error) {
    if (error.code === ITEM_EXISTS) {
      await items(key).update({ data });
      return;
    }
    if (!isNotFound(error)) throw error;

    try {
      await syncClient.syncMaps.create({ uniqueName: name });
    } catch (createError) {
      // Another chunk of the same page got there first.
      if (createError.code !== NAME_TAKEN) throw createError;
    }
    await items.create({ key, data });
  }
}

/**
 * Saves one page of rows. Tries an update first, because after the first load
 * every key already exists. An empty page writes nothing, so a list that Twilio
 * has already emptied never overwrites rows saved earlier.
 */
async function saveRows(syncClient, campaignId, rows, { operationIndex, pageIndex, savedAt }) {
  const name = mapNameFor(campaignId);
  const chunks = chunkRows(rows, { operationIndex, pageIndex, savedAt });

  await Promise.all(
    chunks.map(async ({ key, data }) => {
      try {
        await syncClient.syncMaps(name).syncMapItems(key).update({ data });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await createItem(syncClient, name, key, data);
      }
    })
  );
}

/** Saved rows and when they were saved, or null if none were ever saved. */
async function readRows(syncClient, campaignId) {
  let items;
  try {
    items = await syncClient.syncMaps(mapNameFor(campaignId)).syncMapItems.list({ pageSize: 100 });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return expandItems(items);
}

module.exports = { mapNameFor, chunkRows, expandItems, saveRows, readRows };
