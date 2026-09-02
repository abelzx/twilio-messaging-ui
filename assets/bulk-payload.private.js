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

function buildPayloads() {
  throw new Error('not implemented');
}

module.exports = { buildPayloads };
