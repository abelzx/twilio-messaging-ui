'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { templateNames } = require('../assets/template-names.private.js');

const HX1 = `HX${'1'.repeat(32)}`;
const HX2 = `HX${'2'.repeat(32)}`;

// The cache is keyed by account, so each test uses its own account and none
// sees another's cached lookups.
let accounts = 0;

/** A Twilio client whose Content API answers from `templates`, counting fetches. */
function fakeClient(templates, { delayMs = 0 } = {}) {
  const client = {
    accountSid: `AC${String(++accounts).padStart(32, '0')}`,
    fetches: 0,
    content: {
      v1: {
        contents: (sid) => ({
          fetch: async () => {
            client.fetches += 1;
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            const found = templates[sid];
            if (found instanceof Error) throw found;
            if (!found) throw Object.assign(new Error('not found'), { status: 404 });
            return found;
          },
        }),
      },
    },
  };
  return client;
}

test('looks up each template name and language once, whatever the repeats', async () => {
  const client = fakeClient({
    [HX1]: { friendlyName: 'promo_v2', language: 'en' },
    [HX2]: { friendlyName: 'reminder', language: 'es' },
  });
  const names = await templateNames(client, [HX1, HX2, HX1]);
  assert.deepStrictEqual(names.get(HX1), { name: 'promo_v2', language: 'en' });
  assert.deepStrictEqual(names.get(HX2), { name: 'reminder', language: 'es' });
  assert.strictEqual(client.fetches, 2);
});

test('a second call for the same account is answered from the cache', async () => {
  const client = fakeClient({ [HX1]: { friendlyName: 'promo_v2', language: 'en' } });
  await templateNames(client, [HX1]);
  const names = await templateNames(client, [HX1]);
  assert.strictEqual(names.get(HX1).name, 'promo_v2');
  assert.strictEqual(client.fetches, 1);
});

test('a deleted template is remembered as missing and not asked for again', async () => {
  const client = fakeClient({});
  const first = await templateNames(client, [HX1]);
  const second = await templateNames(client, [HX1]);
  assert.strictEqual(first.has(HX1), false);
  assert.strictEqual(second.has(HX1), false);
  assert.strictEqual(client.fetches, 1);
});

test('a refused lookup is not retried on every poll', async () => {
  const client = fakeClient({ [HX1]: Object.assign(new Error('forbidden'), { status: 403 }) });
  const originalError = console.error;
  console.error = () => {};
  try {
    await templateNames(client, [HX1]);
    await templateNames(client, [HX1]);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(client.fetches, 1);
});

test('a server error or rate limit is not cached, so the next call tries again', async () => {
  for (const status of [503, 429]) {
    const client = fakeClient({ [HX1]: Object.assign(new Error('try later'), { status }) });
    const originalError = console.error;
    console.error = () => {};
    try {
      await templateNames(client, [HX1]);
      await templateNames(client, [HX1]);
    } finally {
      console.error = originalError;
    }
    assert.strictEqual(client.fetches, 2, `status ${status}`);
  }
});

test('a slow Content API costs the names, never the caller', async () => {
  const client = fakeClient({ [HX1]: { friendlyName: 'promo_v2', language: 'en' } }, { delayMs: 200 });
  const started = Date.now();
  const names = await templateNames(client, [HX1], { timeoutMs: 20 });
  assert.ok(Date.now() - started < 150);
  assert.strictEqual(names.has(HX1), false);
});

test('anything that is not a content template SID is skipped without a fetch', async () => {
  const client = fakeClient({});
  const names = await templateNames(client, [null, 'promo_v2', 'HXnope', 42]);
  assert.strictEqual(names.size, 0);
  assert.strictEqual(client.fetches, 0);
});
