/**
 * Narrows the bulk sender dropdown to numbers the Bulk API will send from.
 *
 * A number can be SMS- and MMS-capable and still have no ACTIVATED Sender, in
 * which case the Bulk API rejects it at send time with "from address must be a
 * valid sender". On the test account on 2026-11-19, none of the 8 US local
 * numbers had one; only the toll-free numbers did.
 *
 * Both lists hold E.164 strings exactly as their APIs return them, so they are
 * compared as-is.
 *
 * This is a *private* asset. Require it as:
 *
 *   const { filterToBulkSenders } = require(Runtime.getAssets()['/bulk-senders.js'].path);
 */

'use strict';

/**
 * Returns the options whose number has a Sender, in their original order, and
 * how many were dropped, so the dropdown can say why they are missing.
 */
function filterToBulkSenders(options, senders) {
  const addresses = new Set(senders.map((sender) => sender && sender.address).filter(Boolean));
  const kept = options.filter((option) => addresses.has(option.value));
  return { kept, notBulkSenders: options.length - kept.length };
}

module.exports = { filterToBulkSenders };
