/**
 * Narrows the bulk sender dropdown to numbers the Bulk API will send from.
 *
 * A number can be SMS- and MMS-capable and still have no ACTIVATED Sender, in
 * which case the Bulk API rejects it at send time with "from address must be a
 * valid sender". On the test account on 2026-11-19, none of the 8 US local
 * numbers had one; only the toll-free numbers did.
 *
 * A channel prefix is ignored on both sides: `/v2/Channels/Senders` gives an
 * RCS agent as `rcs:<agent>`, the Bulk API as bare `<agent>`. Phone numbers
 * carry no prefix in either, so they compare as-is.
 *
 * This is a *private* asset. Require it as:
 *
 *   const { filterToBulkSenders } = require(Runtime.getAssets()['/bulk-senders.js'].path);
 */

'use strict';

/** Drops a `rcs:`-style channel prefix; an E.164 number is returned unchanged. */
const bare = (value) => String(value).replace(/^[a-z]+:/, '');

/**
 * Returns the options whose sender has a Bulk API Sender, in their original
 * order, and how many were dropped, so the dropdown can say why they are missing.
 */
function filterToBulkSenders(options, senders) {
  const addresses = new Set(
    senders.map((sender) => sender && sender.address).filter(Boolean).map(bare)
  );
  const kept = options.filter((option) => addresses.has(bare(option.value)));
  return { kept, notBulkSenders: options.length - kept.length };
}

module.exports = { filterToBulkSenders };
