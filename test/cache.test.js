'use strict';
// PHASE 4: HTTP-level suites run on in-memory state only, so they never read or
// write a developer's real Redis and give the same result on every run, and
// with the proactive limiter off, so they test one behaviour at a time. Redis
// logic and the limiter have their own offline tests in phase4.test.js.
process.env.GGW_REDIS_DISABLED = '1';
process.env.GGW_RATELIMIT_DISABLED = '1';

/**
 * test/cache.test.js — Phase 3, fully OFFLINE.
 *
 * Nothing here talks to OpenRouter. The unit tests are pure function calls with
 * an injected clock; the end-to-end test uses the established Phase-2 pattern —
 * a tiny mock upstream on 127.0.0.1 plus
 *   OPENROUTER_BASE="http://127.0.0.1:<port>"
 *   OPENROUTER_API_KEY="sk-mock"
 * so the whole suite costs ZERO of the ~20 req/min ~50 req/day free quota.
 *
 * The mock binds port 0 (kernel-assigned) rather than a fixed 8099: `node --test`
 * runs test FILES in parallel processes, so a hard-coded port is a latent
 * EADDRINUSE the moment a second file adopts the same pattern. The two env vars
 * are restored in t.after so this file cannot leak state into another.
 *
 * Run: npm test   (node --test)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createCache } = require('../src/cache');
const { createStore } = require('../src/cache/store');
const sim = require('../src/cache/similarity');

/* ------------------------------------------------------------------------- */
/* helpers                                                                    */
/* ------------------------------------------------------------------------- */

const MODEL = 'z-ai/glm-5.2:free';

function desc(prompt, extra, tenantCache, tenantId) {
  return {
    tenantId: tenantId || 'treetracker-admin',
    tenantCache: tenantCache,
    model: MODEL,
    body: Object.assign(
      { model: MODEL, messages: [{ role: 'user', content: prompt }] },
      extra || {}
    ),
  };
}

function completion(text, finishReason) {
  return {
    id: 'gen-test',
    object: 'chat.completion',
    model: MODEL,
    provider: 'mock',
    choices: [{
      index: 0,
      finish_reason: finishReason || 'stop',
      message: { role: 'assistant', content: text },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 8, cost: 0 },
  };
}

const META = { model: MODEL, provider: 'mock', attempts: 1, costUsd: 0 };

/* ------------------------------------------------------------------------- */
/* 1. exact hit                                                               */
/* ------------------------------------------------------------------------- */

test('exact tier: identical request hits, and reports the model that produced it', async () => {
  const cache = createCache();
  const d = desc('How do I reset my password?');

  const miss = await cache.lookup(d);
  assert.equal(miss.hit, false);
  assert.equal(miss.tier, 'miss');

  const put = await cache.store(d, { status: 200, body: completion('Use the reset link.') },
    Object.assign({}, META, { model: 'google/gemma-4-31b-it:free' }));
  assert.equal(put.stored, true);

  const hit = await cache.lookup(d);
  assert.equal(hit.hit, true);
  assert.equal(hit.tier, 'exact');
  assert.equal(hit.entry.body.choices[0].message.content, 'Use the reset link.');
  // x-ggw-model must stay the model that ORIGINALLY produced the answer.
  assert.equal(hit.entry.meta.model, 'google/gemma-4-31b-it:free');
  assert.equal(typeof hit.ageSeconds, 'number');
  assert.equal(cache.size(), 1);
});

test('exact tier: casing/punctuation differences do NOT collapse into one key', async () => {
  const cache = createCache({ defaults: { semantic: false } });
  await cache.store(desc('DROP TABLE users;'), { status: 200, body: completion('a') }, META);
  const hit = await cache.lookup(desc('DROP TABLE users;'));
  assert.equal(hit.tier, 'exact');
  const other = await cache.lookup(desc('drop table users'));
  assert.equal(other.hit, false, 'exact tier is case- and punctuation-preserving');
});

test('exact tier: the key includes the tenant id (Phase-4 Redis safety)', () => {
  const cache = createCache();
  const a = cache.plan(desc('shared question'));
  const b = cache.plan(desc('shared question', null, undefined, 'demo-nobudget'));
  assert.notEqual(a.exactKey, b.exactKey, 'exactKey must never be shareable across tenants');
  assert.notEqual(a.bucketKey, b.bucketKey);
});

/* ------------------------------------------------------------------------- */
/* 2. miss                                                                    */
/* ------------------------------------------------------------------------- */

test('miss: an unrelated prompt does not hit', async () => {
  const cache = createCache();
  await cache.store(desc('How do I reset my password?'), { status: 200, body: completion('a') }, META);

  const res = await cache.lookup(desc('What is the capital of France?'));
  assert.equal(res.hit, false);
  assert.equal(res.reason, 'miss');
});

test('miss: a different parameter set cannot read another bucket (no key bleed)', async () => {
  const cache = createCache();
  await cache.store(desc('summarise this', { max_tokens: 100 }), { status: 200, body: completion('short') }, META);

  const other = await cache.lookup(desc('summarise this', { max_tokens: 4000 }));
  assert.equal(other.hit, false, 'max_tokens is part of paramsHash');

  const same = await cache.lookup(desc('summarise this', { max_tokens: 100 }));
  assert.equal(same.hit, true);
});

test('miss: an UNKNOWN body parameter also changes the key (paramsHash fails closed)', async () => {
  const cache = createCache();
  const plain = desc('list the free models');
  await cache.store(plain, { status: 200, body: completion('no web search was used') }, META);

  // `plugins` (OpenRouter web search) is not on any pick-list; a request that
  // asks for web search must never be served the plain answer.
  const web = await cache.lookup(desc('list the free models', { plugins: [{ id: 'web' }] }));
  assert.equal(web.hit, false, 'unlisted params must produce a miss, not a wrong answer');

  const invented = await cache.lookup(desc('list the free models', { some_param_from_2027: true }));
  assert.equal(invented.hit, false);

  assert.equal((await cache.lookup(plain)).hit, true, 'the original request still hits');
});

test('miss: another tenant never sees this tenant answers', async () => {
  const cache = createCache();
  await cache.store(desc('shared question'), { status: 200, body: completion('secret') }, META);
  const other = await cache.lookup(desc('shared question', null, undefined, 'demo-nobudget'));
  assert.equal(other.hit, false);
});

/* ------------------------------------------------------------------------- */
/* 3. TTL expiry (injected clock)                                             */
/* ------------------------------------------------------------------------- */

test('TTL: an entry expires exactly at ttlSeconds, using an injected clock', async () => {
  let clock = 1700000000000;
  const cache = createCache({ now: () => clock });
  const tenantCache = { ttlSeconds: 60 };
  const d = desc('what is a circuit breaker', null, tenantCache);

  await cache.store(d, { status: 200, body: completion('a pattern') }, META);

  clock += 59000;
  const fresh = await cache.lookup(d);
  assert.equal(fresh.hit, true);
  assert.equal(fresh.ageSeconds, 59);

  clock += 2000; // now 61s old, past the 60s TTL
  const stale = await cache.lookup(d);
  assert.equal(stale.hit, false, 'expired entry must not be served');
  assert.equal(cache.size(), 0, 'expired entry is dropped, not merely hidden');
});

test('TTL: time/price-relative prompts get the short volatile TTL', async () => {
  let clock = 1700000000000;
  const cache = createCache({ now: () => clock });
  const tenantCache = { ttlSeconds: 86400, volatileTtlSeconds: 60 };
  const d = desc('what is the price today', null, tenantCache);

  const put = await cache.store(d, { status: 200, body: completion('$5') }, META);
  assert.equal(put.ttlSeconds, 60, 'volatile prompt must not be pinned for 24h');

  clock += 61000;
  assert.equal((await cache.lookup(d)).hit, false);
});

test('TTL: 0 means DO NOT CACHE, never "cache forever"', async () => {
  let clock = 1700000000000;
  const cache = createCache({ now: () => clock });

  const off = await cache.store(desc('anything', null, { ttlSeconds: 0 }),
    { status: 200, body: completion('x') }, META);
  assert.deepEqual(off, { stored: false, reason: 'ttl-zero' });
  assert.equal(cache.size(), 0);

  // volatileTtlSeconds: 0 means "never cache volatile prompts" — and ONLY those.
  const volCfg = { ttlSeconds: 86400, volatileTtlSeconds: 0 };
  const volatilePut = await cache.store(desc('what is the price today', null, volCfg),
    { status: 200, body: completion('$5') }, META);
  assert.deepEqual(volatilePut, { stored: false, reason: 'ttl-zero' });

  const steadyPut = await cache.store(desc('what is a circuit breaker', null, volCfg),
    { status: 200, body: completion('a pattern') }, META);
  assert.equal(steadyPut.stored, true, 'non-volatile prompts are unaffected');
});

test('TTL: a malformed value falls back to the default, and -1 is the never-expire sentinel', async () => {
  let clock = 1700000000000;
  const cache = createCache({ now: () => clock });

  // "1h" -> NaN. It must NOT become 0 (do-not-cache) or Infinity (immortal).
  const typo = await cache.store(desc('typo tenant', null, { ttlSeconds: '1h' }),
    { status: 200, body: completion('x') }, META);
  assert.equal(typo.ttlSeconds, 86400, 'NaN falls back to the DEFAULT ttl');

  const forever = desc('pinned answer', null, { ttlSeconds: -1 });
  const pinned = await cache.store(forever, { status: 200, body: completion('y') }, META);
  assert.equal(pinned.entry.expiresAt, 0, '-1 is the explicit never-expire sentinel');
  clock += 10 * 365 * 24 * 3600 * 1000;
  assert.equal((await cache.lookup(forever)).hit, true);
});

test('TTL: expired entries are swept opportunistically, so the gauge stays honest', async () => {
  let clock = 1700000000000;
  const cache = createCache({ now: () => clock });
  const tc = { ttlSeconds: 60, semantic: false };

  await cache.store(desc('question alpha', null, tc), { status: 200, body: completion('A') }, META);
  await cache.store(desc('question bravo', null, tc), { status: 200, body: completion('B') }, META);
  assert.equal(cache.size(), 2);

  clock += 120000;                       // both entries are now stale
  // Nothing has touched their keys or their buckets; only the sweep frees them.
  await cache.store(desc('question charlie', null, tc), { status: 200, body: completion('C') }, META);
  assert.equal(cache.size(), 1, 'the prune interval elapsed, so the stale pair was dropped');
});

/* ------------------------------------------------------------------------- */
/* 4. LRU eviction and the byte budget                                        */
/* ------------------------------------------------------------------------- */

test('LRU: maxEntries evicts the least-recently-used entry', async () => {
  const cache = createCache();
  const tenantCache = { maxEntries: 2, semantic: false };

  const a = desc('question alpha', null, tenantCache);
  const b = desc('question bravo', null, tenantCache);
  const c = desc('question charlie', null, tenantCache);

  await cache.store(a, { status: 200, body: completion('A') }, META);
  await cache.store(b, { status: 200, body: completion('B') }, META);
  assert.equal(cache.size(), 2);

  // Touch A so B becomes the least-recently-used entry.
  assert.equal((await cache.lookup(a)).hit, true);

  await cache.store(c, { status: 200, body: completion('C') }, META);
  assert.equal(cache.size(), 2, 'cap is a hard bound');
  assert.equal((await cache.lookup(b)).hit, false, 'B was the LRU victim');
  assert.equal((await cache.lookup(a)).hit, true);
  assert.equal((await cache.lookup(c)).hit, true);
});

test('LRU: store.js evicts in insertion order and keeps buckets consistent', () => {
  const store = createStore({ maxEntries: 2, now: () => 1000 });
  store.put({ key: 'k1', bucketKey: 'b', expiresAt: 0 });
  store.put({ key: 'k2', bucketKey: 'b', expiresAt: 0 });
  store.put({ key: 'k3', bucketKey: 'b', expiresAt: 0 });
  assert.deepEqual(store.keys(), ['k2', 'k3']);
  assert.equal(store.listBucket('b').length, 2);
  assert.equal(store.bucketCount(), 1);
});

test('LRU: memory is bounded by BYTES as well as by entry count', async () => {
  const big = 'x'.repeat(4000);
  const oneBody = JSON.stringify(completion(big)).length;
  const tenantCache = { maxEntries: 500, maxBytes: Math.floor(oneBody * 1.5), semantic: false };
  const cache = createCache();

  await cache.store(desc('question alpha', null, tenantCache), { status: 200, body: completion(big) }, META);
  assert.equal(cache.size(), 1);
  await cache.store(desc('question bravo', null, tenantCache), { status: 200, body: completion(big) }, META);
  assert.equal(cache.size(), 1, 'the byte budget evicted the older entry well before 500 entries');
  assert.ok(cache.bytes() <= tenantCache.maxBytes);
});

test('LRU: a shard picks up the tenant current limits, it is not frozen at creation', async () => {
  const cache = createCache();
  // First request from this tenant carries an atypical, tiny cap.
  await cache.store(desc('question alpha', null, { maxEntries: 1, semantic: false }),
    { status: 200, body: completion('A') }, META);
  assert.equal(cache.size(), 1);

  // Later requests carry the tenant real configuration.
  await cache.store(desc('question bravo', null, { maxEntries: 500, semantic: false }),
    { status: 200, body: completion('B') }, META);
  assert.equal(cache.size(), 2, 'the shard reconciled its cap instead of staying at 1');
});

/* ------------------------------------------------------------------------- */
/* 5. near-duplicate (semantic) hit                                           */
/* ------------------------------------------------------------------------- */

test('semantic tier: a reworded question hits the stored answer', async () => {
  const cache = createCache();
  await cache.store(
    desc('How do I reset my password?'),
    { status: 200, body: completion('Use the reset link on the login page.') },
    META
  );

  const hit = await cache.lookup(desc('how can i reset my password'));
  assert.equal(hit.hit, true);
  assert.equal(hit.tier, 'semantic');
  assert.ok(hit.score >= 0.85, `score ${hit.score} must clear the threshold`);
  assert.equal(hit.entry.body.choices[0].message.content, 'Use the reset link on the login page.');
  assert.equal(cache.size(), 1, 'a semantic hit reuses an entry, it does not add one');
});

test('semantic tier: the negation guard blocks enable/disable confusion', async () => {
  const cache = createCache();
  await cache.store(desc('how do I enable data collection'), { status: 200, body: completion('turn it on') }, META);

  const res = await cache.lookup(desc('how do I disable data collection'));
  assert.equal(res.hit, false, 'negation mismatch must never be served from cache');
});

test('semantic tier: the number/ID guard blocks near-identical ids', async () => {
  const cache = createCache();
  await cache.store(desc('what is the status of invoice 4471'), { status: 200, body: completion('paid') }, META);

  const res = await cache.lookup(desc('what is the status of invoice 4472'));
  assert.equal(res.hit, false);
});

test('semantic tier: honest about synonym paraphrase (documented miss)', async () => {
  const cache = createCache();
  await cache.store(desc('how do I get a refund'), { status: 200, body: completion('open a ticket') }, META);

  const res = await cache.lookup(desc('how do I get my money back'));
  assert.equal(res.hit, false, 'the lexical backend cannot do synonyms; this is a documented limitation');
});

test('semantic tier: a prompt the tokenizer cannot represent is refused, not guessed', async () => {
  const cache = createCache();

  // The lexical backend deletes every non-Latin character, so both of these
  // prompts reduce to {password}. Without the guards they score 1.00 and the
  // second question ("delete account") is answered with the first answer.
  const stored = desc('重置密码 password');
  await cache.store(stored, { status: 200, body: completion('RESET-PASSWORD-ANSWER') }, META);

  const different = await cache.lookup(desc('删除账户 password'));
  assert.equal(different.hit, false, 'two different CJK questions must not collide');
  assert.ok(different.plan.blockers.includes('too-few-content-tokens'));

  // A longer CJK prompt with enough Latin tokens is caught by the coverage ratio.
  const mostlyCjk = cache.plan(desc('重置密码请帮我看看 reset password'));
  assert.equal(mostlyCjk.semanticAllowed, false);
  assert.ok(mostlyCjk.blockers.includes('unsupported-script'));

  // The exact tier still serves these prompts — it preserves Unicode.
  const again = await cache.lookup(stored);
  assert.equal(again.tier, 'exact');
});

test('semantic tier: an all-stopword prompt never reaches cosine', () => {
  const cache = createCache();
  const p = cache.plan(desc('what is it'));
  assert.equal(p.semanticAllowed, false);
  assert.ok(p.blockers.includes('stopword-only-prompt'));
  assert.equal(sim.vectorize('what is it').stopwordsOnly, true);
});

test('similarity: normalize / vectorize / cosine are pure and behave', () => {
  assert.equal(sim.normalize('  Hello,   WORLD!  '), 'hello world');
  assert.equal(sim.normalize("don't"), 'dont');
  const a = sim.vectorize('reset my password please');
  const b = sim.vectorize('please reset my password');
  assert.ok(sim.cosine(a, b) > 0.999, 'word order does not matter');
  assert.equal(sim.cosine(a, sim.vectorize('')), 0);
  assert.equal(sim.vectorize('what is the price today').volatile, true);
  // Narrowed VOLATILE list: ordinary support words no longer force a 60s TTL.
  assert.equal(sim.vectorize('what is the status of my ticket').volatile, false);
  assert.equal(sim.vectorize('current best practice for backups').volatile, false);
});

/* ------------------------------------------------------------------------- */
/* 6. guardrails: tools / response_format / stream / temperature              */
/* ------------------------------------------------------------------------- */

const TOOLS = [{
  type: 'function',
  function: { name: 'get_tree', description: 'x', parameters: { type: 'object', properties: {} } },
}];

test('guardrail: tools present => exact tier only, never semantic', async () => {
  const cache = createCache();
  const stored = desc('How do I reset my password?', { tools: TOOLS });
  await cache.store(stored, { status: 200, body: completion('Use the reset link.') }, META);

  const exact = await cache.lookup(stored);
  assert.equal(exact.tier, 'exact', 'the exact tier stays available with tools');

  const reworded = await cache.lookup(desc('how can i reset my password', { tools: TOOLS }));
  assert.equal(reworded.hit, false, 'a semantic hit would skip the whole tool loop');
  assert.ok(reworded.plan.blockers.includes('tools'));
});

test('guardrail: null-valued SDK fields do NOT disable the semantic tier', async () => {
  const cache = createCache();
  // LiteLLM / LangChain send these on every request.
  const sdkShape = { tools: null, tool_choice: null, response_format: null };
  const p = cache.plan(desc('How do I reset my password?', sdkShape));
  assert.equal(p.semanticAllowed, true, 'null means absent, not present');
  assert.deepEqual(p.blockers, []);

  await cache.store(desc('How do I reset my password?', sdkShape),
    { status: 200, body: completion('Use the reset link.') }, META);
  const hit = await cache.lookup(desc('how can i reset my password', sdkShape));
  assert.equal(hit.tier, 'semantic');
});

test('guardrail: response_format and stream also disable the semantic tier', async () => {
  const cache = createCache();
  const p1 = cache.plan(desc('list the free models', { response_format: { type: 'json_object' } }));
  assert.equal(p1.semanticAllowed, false);
  assert.ok(p1.blockers.includes('response_format'));

  const p2 = cache.plan(desc('list the free models', { stream: true }));
  assert.equal(p2.semanticAllowed, false);
  assert.ok(p2.blockers.includes('stream'));

  const p3 = cache.plan(desc('list the free models', { n: 3 }));
  assert.equal(p3.semanticAllowed, false);
  assert.ok(p3.blockers.includes('n'));
});

test('guardrail: temperature above the threshold => exact tier only', async () => {
  const cache = createCache();
  const hot = desc('write me a haiku about trees', { temperature: 0.9 });
  await cache.store(hot, { status: 200, body: completion('green leaves...') }, META);

  const exact = await cache.lookup(hot);
  assert.equal(exact.tier, 'exact');

  const reworded = await cache.lookup(desc('write a haiku about trees', { temperature: 0.9 }));
  assert.equal(reworded.hit, false, 'the caller asked for variance');
  assert.ok(reworded.plan.blockers.includes('temperature'));

  // At or below the threshold the semantic tier is back on.
  const cache2 = createCache();
  const cool = desc('write me a haiku about trees', { temperature: 0.2 });
  await cache2.store(cool, { status: 200, body: completion('green leaves...') }, META);
  const warm = await cache2.lookup(desc('write a haiku about trees', { temperature: 0.2 }));
  assert.equal(warm.hit, true);
  assert.equal(warm.tier, 'semantic');
});

test('guardrail: an ABSENT temperature is treated as cacheable, and that is configurable', async () => {
  // Documented policy: no `temperature` field => treated as 0, semantic tier on,
  // even though an OpenAI-compatible upstream would default it to 1.0.
  const cache = createCache();
  const p = cache.plan(desc('write me a haiku about trees'));
  assert.equal(p.semanticAllowed, true);

  // A tenant that wants the strict reading turns it off with a negative bound.
  const strict = createCache();
  const q = strict.plan(desc('write me a haiku about trees', null, { semanticMaxTemperature: -1 }));
  assert.equal(q.semanticAllowed, false);
  assert.ok(q.blockers.includes('temperature'));
});

test('guardrail: a tenant can switch the cache off entirely', async () => {
  const cache = createCache();
  const off = { enabled: false };
  const d = desc('anything at all', null, off);
  assert.equal((await cache.store(d, { status: 200, body: completion('x') }, META)).stored, false);
  const res = await cache.lookup(d);
  assert.equal(res.hit, false);
  assert.equal(res.reason, 'disabled');
});

test('defaults: a tenant with no cache block behaves exactly like DEFAULTS', async () => {
  const cache = createCache();
  const d = desc('how do I reset my password?', null, undefined, 'demo-nobudget');
  await cache.store(d, { status: 200, body: completion('link') }, META);
  const hit = await cache.lookup(d);
  assert.equal(hit.hit, true);
  assert.equal(hit.tier, 'exact');
});

test('backend: a tenant asking for a backend that is not installed fails LOUDLY', async () => {
  const cache = createCache();
  await assert.rejects(
    () => cache.lookup(desc('anything', null, { similarity: 'local' })),
    /similarity backend 'local' is not available/,
    'silently downgrading to lexical would misrepresent what the cache is doing'
  );
  // src/routes/chat.js catches this, logs it and goes upstream (fail open).
});

/* ------------------------------------------------------------------------- */
/* 7. never store non-2xx / empty / truncated                                 */
/* ------------------------------------------------------------------------- */

test('no-store: non-2xx, empty, truncated and tool-call responses are refused', async () => {
  const cache = createCache();
  const d = desc('what is a circuit breaker');

  assert.deepEqual(
    await cache.store(d, { status: 500, body: { error: { message: 'boom' } } }, META),
    { stored: false, reason: 'non-2xx' }
  );
  assert.deepEqual(
    await cache.store(d, { status: 429, body: { error: { message: 'rate limited' } } }, META),
    { stored: false, reason: 'non-2xx' }
  );
  assert.equal((await cache.store(d, { status: 200, body: completion('cut off', 'length') }, META)).reason, 'truncated');
  assert.equal((await cache.store(d, { status: 200, body: completion('') }, META)).reason, 'empty-content');
  assert.equal((await cache.store(d, { status: 200, body: { choices: [] } }, META)).reason, 'no-choices');

  const toolCall = completion('');
  toolCall.choices[0].message.content = null;
  toolCall.choices[0].message.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }];
  toolCall.choices[0].finish_reason = 'tool_calls';
  assert.equal((await cache.store(d, { status: 200, body: toolCall }, META)).reason, 'tool-calls');

  const tooBig = completion('x'.repeat(40000));
  assert.equal((await cache.store(d, { status: 200, body: tooBig }, META)).reason, 'too-large');

  assert.equal(cache.size(), 0, 'nothing above was allowed into the cache');
  assert.equal((await cache.lookup(d)).hit, false);
});

test('no-store: an EMPTY tool_calls array is an ordinary completion and is cacheable', async () => {
  const cache = createCache();
  const d = desc('what is a circuit breaker');
  const body = completion('a pattern');
  body.choices[0].message.tool_calls = []; // several providers always send this
  const put = await cache.store(d, { status: 200, body }, META);
  assert.equal(put.stored, true, 'tool_calls: [] must not blank out the whole cache');
  assert.equal((await cache.lookup(d)).tier, 'exact');
});

/* ------------------------------------------------------------------------- */
/* 8. end-to-end through the gateway (mock upstream, zero OpenRouter quota)   */
/* ------------------------------------------------------------------------- */

test('end-to-end: a hit returns 200 with cache headers and sends NO upstream request', async (t) => {
  const prevBase = process.env.OPENROUTER_BASE;
  const prevKey = process.env.OPENROUTER_API_KEY;

  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion('Use the reset link on the login page.')));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  process.env.OPENROUTER_BASE = `http://127.0.0.1:${upstream.address().port}`;
  process.env.OPENROUTER_API_KEY = 'sk-mock';

  const { build } = require('../src/server');
  const { register } = require('../src/metrics');
  const app = build();
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    if (prevBase === undefined) delete process.env.OPENROUTER_BASE;
    else process.env.OPENROUTER_BASE = prevBase;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  });

  await app.ready();
  assert.equal(typeof app.ggwCache.lookup, 'function', 'the cache is reachable at the root instance');

  const headers = { authorization: 'Bearer gg_live_local_dev_key', 'content-type': 'application/json' };
  const ask = (content) => app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload: { model: MODEL, messages: [{ role: 'user', content }] },
  });

  const first = await ask('How do I reset my password?');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-ggw-cache'], 'miss');
  assert.equal(upstreamCalls, 1);

  const second = await ask('How do I reset my password?');
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['x-ggw-cache'], 'hit-exact');
  assert.ok('x-ggw-cache-age' in second.headers);
  assert.equal(second.headers['x-ggw-model'], MODEL, 'x-ggw-model stays the model that produced it');
  assert.equal(upstreamCalls, 1, 'a cache hit spends zero OpenRouter quota');
  assert.equal(JSON.parse(second.body).choices[0].message.content,
    'Use the reset link on the login page.');

  const third = await ask('how can i reset my password');
  assert.equal(third.statusCode, 200);
  assert.equal(third.headers['x-ggw-cache'], 'hit-semantic');
  assert.equal(upstreamCalls, 1, 'the near-duplicate was served locally too');

  // A hit must record the saved request — the headline free-tier metric.
  const metrics = await register.metrics();
  assert.match(metrics, /ggw_cache_saved_requests_total\{tenant="treetracker-admin"\} 2/);
  assert.match(metrics, /ggw_cache_hits_total\{tenant="treetracker-admin",tier="exact"\} 1/);
  assert.match(metrics, /ggw_cache_hits_total\{tenant="treetracker-admin",tier="semantic"\} 1/);
  assert.match(metrics, /ggw_cache_misses_total\{tenant="treetracker-admin"\} 1/);
  assert.match(metrics, /ggw_cache_entries 1/);
  assert.match(metrics, /ggw_cache_savings_usd\{tenant="treetracker-admin"\} 0/);
  assert.match(metrics, /ggw_cache_lookup_seconds_count\{tier="exact"\} 1/);
  // Cache hits are visible in ggw_requests_total under provider="cache" — any
  // "upstream request rate" panel must filter provider!="cache".
  assert.match(metrics, /ggw_requests_total\{tenant="treetracker-admin",model="z-ai\/glm-5\.2:free",provider="cache",status="200"\} 2/);
});

test('end-to-end: the budget 402 still fires before the cache', async (t) => {
  const { build } = require('../src/server');
  const app = build();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer gg_live_nobudget', 'content-type': 'application/json' },
    payload: { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.statusCode, 402);
  assert.equal(JSON.parse(res.body).error.type, 'insufficient_budget');
  assert.equal(res.headers['x-ggw-cache'], undefined, 'the cache is never consulted for a 402');
});
