/**
 * Content Template names, looked up by SID for campaigns that never recorded
 * one: classic campaigns sent before campaign details existed keep only the
 * SID, in messages[0].contentSid.
 *
 * The browser cannot fill these in reliably. Its template list holds only the
 * currently selected channel's templates, so a WhatsApp campaign's template is
 * missing whenever the form is on SMS. The Content API has every one.
 *
 * list-campaigns is polled every five seconds while a campaign is open, so
 * lookups are cached for the life of the warm Function container, per account.
 * A lookup is display data only: a slow or failing Content API costs the name,
 * never the response it would have decorated.
 *
 * This is a *private* asset. Require it as:
 *
 *   const { templateNames } = require(Runtime.getAssets()['/template-names.js'].path);
 */

'use strict';

const CONTENT_SID = /^HX[0-9a-f]{32}$/i;

/** `${accountSid}:${contentSid}` to { name, language }, or null when the lookup will not succeed. */
const cache = new Map();

async function fetchInto(client, key, sid) {
  try {
    const content = await client.content.v1.contents(sid).fetch();
    cache.set(key, { name: content.friendlyName || null, language: content.language || null });
  } catch (error) {
    // A 4xx other than 429 gives the same answer next time: the template was
    // deleted (404), or the OAuth app lacks the Content scope (403). Remember
    // it, or every poll asks again. Rate limits and 5xx may clear, so retry.
    const status = Number(error.status);
    const final = status >= 400 && status < 500 && status !== 429;
    if (final) {
      cache.set(key, null);
    }
    if (status !== 404) {
      console.error(`Content template ${sid} lookup failed:`, error.message);
    }
  }
}

/**
 * Map of content SID to { name, language } for every SID in `sids` that could
 * be resolved within `timeoutMs`. Anything else is left out, so the caller
 * keeps showing the SID.
 */
async function templateNames(client, sids, { timeoutMs = 2000 } = {}) {
  const account = client.accountSid;
  const wanted = [...new Set(sids.filter((sid) => typeof sid === 'string' && CONTENT_SID.test(sid)))];
  const missing = wanted.filter((sid) => !cache.has(`${account}:${sid}`));

  if (missing.length) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    // Each lookup writes into the cache as it lands, so whatever finished
    // before the deadline is still used.
    await Promise.race([
      Promise.all(missing.map((sid) => fetchInto(client, `${account}:${sid}`, sid))),
      deadline,
    ]);
    clearTimeout(timer);
  }

  const names = new Map();
  for (const sid of wanted) {
    const entry = cache.get(`${account}:${sid}`);
    if (entry) names.set(sid, entry);
  }
  return names;
}

module.exports = { templateNames };
