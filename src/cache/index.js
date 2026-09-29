'use strict';

/**
 * src/cache/index.js — GreenGateway Phase 3 cache facade.
 *
 * Owns: normalization, the cache key, paramsHash, bucketing, TTL policy and
 * every correctness guardrail. src/routes/chat.js only calls lookup() / store()
 * and reads cache.size() for the gauge; it holds no cache logic of its own.
 *
 * TWO TIERS
 *   tier 'exact'    sha256(tenant + model + paramsHash + normalized messages).
 *                   Whitespace-normalized, CASE-PRESERVING, script-agnostic.
 *                   Zero false positives. Always on, safe for every request shape.
 *   tier 'semantic' Near-duplicate scan inside one bucket via a pluggable
 *                   similarity backend (default: the zero-dependency lexical
 *                   IDF-cosine in ./similarity.js). Off for tools /
 *                   response_format / stream / n>1 / temperature above
 *                   `semanticMaxTemperature` / prompts the lexical backend
 *                   cannot represent (see semantic blockers below).
 *
 * BUCKETING
 *   bucketKey = sha256(tenantId | model | paramsHash | prefixHash)
 *   - tenantId   : tenants never see each other's answers.
 *   - model      : the model the CLIENT asked for (not the one that served it).
 *   - paramsHash : EVERY body field except `messages` and `model` (see
 *                  paramsHashOf). This is the fix for the classic cache-key
 *                  bleed bug, and it fails CLOSED on parameters nobody has
 *                  heard of yet.
 *   - prefixHash : every message EXCEPT the final user turn. A multi-turn chat
 *                  can therefore only match another chat with an identical
 *                  history, and the semantic scan compares just the last turn.
 *
 * WHY THIS EXISTS (free tier): a hit sends no HTTP request to OpenRouter, so it
 * consumes none of the ~20 req/min, ~50 req/day PER-ACCOUNT free quota. On
 * ':free' models usage.cost is 0, so the dollar counter reads 0.00 — the real
 * saving is REQUESTS, and that is what ggw_cache_saved_requests_total counts.
 */

const crypto = require('crypto');
const sim = require('./similarity');
const { createStore } = require('./store');

/* ------------------------------------------------------------------------- */
/* Defaults — a tenant with NO `cache:` block gets exactly these.             */
/* ------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  enabled: true,                 // master switch (per tenant)
  ttlSeconds: 86400,             // 24h. 0 = "do not cache". -1 = never expire.
  volatileTtlSeconds: 60,        // prompts with today/now/price/... words
  maxEntries: 500,               // per-tenant hard cap (LRU eviction)
  maxBytes: 8 * 1024 * 1024,     // per-tenant byte cap over stored bodies
  semantic: true,                // tier 1 on/off
  threshold: 0.85,               // cosine score required for a semantic hit
  similarity: 'lexical',         // backend name; 'lexical' is the only core one
  semanticMaxTemperature: 0.3,   // above this: exact tier only
  maxSemanticCandidates: 200,    // per-bucket scan cap (bounded latency)
  maxPromptChars: 8000,          // longer final turns: exact tier only
  maxResponseChars: 32000,       // do not memoize absurd payloads
  minContentTokens: 2,           // fewer surviving content tokens: exact tier only
  minScriptCoverage: 0.6,        // fraction of the prompt the tokenizer must keep
  pruneIntervalMs: 60000,        // opportunistic TTL sweep, at most this often
});

/**
 * DOCUMENTATION ONLY. paramsHashOf() no longer uses a pick-list — it hashes
 * every body key except `messages` and `model`, so a parameter this list has
 * never heard of (plugins, prediction, parallel_tool_calls, structured_outputs,
 * web_search_options, verbosity, user, whatever OpenRouter ships next month)
 * changes the key and produces a MISS rather than a confidently wrong hit.
 * A pick-list fails open; the cache key must fail closed.
 */
const PARAM_KEYS = [
  'temperature', 'top_p', 'top_k', 'min_p', 'top_a',
  'max_tokens', 'max_completion_tokens',
  'frequency_penalty', 'presence_penalty', 'repetition_penalty',
  'seed', 'stop', 'n', 'logit_bias', 'logprobs', 'top_logprobs',
  'response_format', 'tools', 'tool_choice', 'stream', 'reasoning',
  'models', 'route', 'transforms', 'plugins',
];

/** The only two body fields that are NOT part of paramsHash. */
const KEY_EXCLUDED = new Set(['messages', 'model']);

const SEP = '|#|';

/* ------------------------------------------------------------------------- */
/* Small pure helpers                                                        */
/* ------------------------------------------------------------------------- */

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Deterministic JSON: object keys sorted recursively so key order never leaks. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    if (value[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(value[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * normalizeForKey(text) — the CONSERVATIVE normalization used by the EXACT tier.
 * Unicode NFKC, CRLF -> LF, runs of spaces/tabs collapsed, trailing space per
 * line stripped, outer whitespace trimmed. Case, punctuation and script are all
 * PRESERVED: "DROP TABLE users;" must never share a key with "drop table users",
 * and a CJK prompt must key on its actual characters.
 */
function normalizeForKey(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Flatten OpenAI content (string, or array of {type:'text',text} parts) to text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const part of content) {
      if (typeof part === 'string') out.push(part);
      else if (part && typeof part.text === 'string') out.push(part.text);
      else out.push(stableStringify(part)); // images etc: structural, not textual
    }
    return out.join('\n');
  }
  if (content === null || content === undefined) return '';
  return stableStringify(content);
}

/** [{role, content}] -> [{role, text}] with conservative normalization. */
function normalizeMessages(messages) {
  return messages.map((m) => ({
    role: String((m && m.role) || 'user'),
    text: normalizeForKey(contentToText(m && m.content)),
    name: m && m.name ? String(m.name) : undefined,
    tool_call_id: m && m.tool_call_id ? String(m.tool_call_id) : undefined,
    tool_calls: m && m.tool_calls ? m.tool_calls : undefined,
  }));
}

/**
 * paramsHashOf(body) — hash EVERYTHING except messages/model (fail closed).
 * Keys are sorted and stableStringify sorts nested objects, so key order never
 * changes the hash; `undefined` values are skipped so an explicitly-undefined
 * field behaves like an absent one.
 */
function paramsHashOf(body) {
  const picked = {};
  for (const k of Object.keys(body).sort()) {
    if (KEY_EXCLUDED.has(k)) continue;
    if (body[k] === undefined) continue;
    picked[k] = body[k];
  }
  return sha256(stableStringify(picked));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * resolveConfig(tenantCache, base) -> cfg
 * Precedence: tenant `cache:` block  >  process-wide base (createCache opts.defaults)
 *             >  DEFAULTS. An absent tenant block therefore behaves exactly like
 *             the defaults, which is what keeps demo-nobudget working untouched.
 *
 * A malformed value (`ttlSeconds: "1h"` -> NaN) falls back to the DEFAULT, never
 * to 0: "0" is a meaningful setting here ("do not cache") and a YAML typo must
 * not silently select it.
 */
function resolveConfig(tenantCache, base) {
  const cfg = Object.assign({}, DEFAULTS, base || {});
  if (tenantCache && typeof tenantCache === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (tenantCache[k] !== undefined) cfg[k] = tenantCache[k];
    }
  }
  cfg.enabled = cfg.enabled !== false;
  cfg.semantic = cfg.semantic !== false;

  // TTLs: finite numbers only. 0 = do not cache, negative = never expire.
  cfg.ttlSeconds = finiteOr(cfg.ttlSeconds, DEFAULTS.ttlSeconds);
  cfg.volatileTtlSeconds = finiteOr(cfg.volatileTtlSeconds, DEFAULTS.volatileTtlSeconds);

  cfg.maxEntries = positiveOr(cfg.maxEntries, DEFAULTS.maxEntries);
  cfg.maxBytes = positiveOr(cfg.maxBytes, DEFAULTS.maxBytes);
  cfg.maxSemanticCandidates = positiveOr(cfg.maxSemanticCandidates, DEFAULTS.maxSemanticCandidates);
  cfg.maxPromptChars = positiveOr(cfg.maxPromptChars, DEFAULTS.maxPromptChars);
  cfg.maxResponseChars = positiveOr(cfg.maxResponseChars, DEFAULTS.maxResponseChars);
  cfg.minContentTokens = positiveOr(cfg.minContentTokens, DEFAULTS.minContentTokens);
  cfg.minScriptCoverage = finiteOr(cfg.minScriptCoverage, DEFAULTS.minScriptCoverage);
  cfg.pruneIntervalMs = positiveOr(cfg.pruneIntervalMs, DEFAULTS.pruneIntervalMs);
  cfg.threshold = finiteOr(cfg.threshold, DEFAULTS.threshold);
  cfg.semanticMaxTemperature = finiteOr(cfg.semanticMaxTemperature, DEFAULTS.semanticMaxTemperature);
  cfg.similarity = typeof cfg.similarity === 'string' && cfg.similarity
    ? cfg.similarity
    : DEFAULTS.similarity;
  return cfg;
}

/**
 * ABSENT `temperature` IS TREATED AS 0, I.E. CACHEABLE. Stated explicitly
 * because it is a policy choice, not an accident: an OpenAI-compatible upstream
 * defaults to 1.0, so a request with no `temperature` field is in fact served
 * hot upstream while this gateway still allows near-duplicate matching for it.
 * That is deliberate — the overwhelming majority of clients never send the
 * field, and treating them all as "asked for variance" would disable the
 * semantic tier for essentially all traffic. A caller who actually wants
 * variance says so with a number, and anything above semanticMaxTemperature
 * (0.3 by default) then drops to the exact tier. A tenant that wants the strict
 * reading sets `semanticMaxTemperature: -1`, which blocks every request.
 */
const ABSENT_TEMPERATURE = 0;

/**
 * semanticBlockers(body, cfg) -> string[]
 * Non-empty means: EXACT TIER ONLY for this request. Each reason is a bounded
 * constant (never user input), so it is safe in a log line.
 *
 * `!= null` on purpose: LiteLLM, LangChain and several OpenAI-compatible SDKs
 * send `tools: null` / `tool_choice: null` / `response_format: null` on EVERY
 * request. Testing with `!== undefined` turned the semantic tier permanently
 * off for those clients, silently.
 */
function semanticBlockers(body, cfg) {
  const out = [];
  if (!cfg.semantic) out.push('semantic-disabled');
  if (body.tools != null || body.tool_choice != null) out.push('tools');
  if (body.response_format != null) out.push('response_format');
  if (body.stream === true) out.push('stream');
  if (typeof body.n === 'number' && body.n > 1) out.push('n');
  const temp = typeof body.temperature === 'number' ? body.temperature : ABSENT_TEMPERATURE;
  if (temp > cfg.semanticMaxTemperature) out.push('temperature');
  return out;
}

/**
 * storable(response, cfg) -> { ok, reason, size }
 * NEVER memoize: a non-2xx, an empty body, a truncated generation
 * (finish_reason !== 'stop'), a tool-call turn (a hit would skip the whole tool
 * loop), or an oversized payload.
 *
 * `tool_calls` is checked for a NON-EMPTY ARRAY: several providers return
 * `tool_calls: []` on ordinary completions, and a truthiness test there made the
 * cache refuse to store anything at all against those providers.
 */
function storable(response, cfg) {
  if (!response || typeof response !== 'object') return { ok: false, reason: 'no-response', size: 0 };
  const status = Number(response.status);
  if (!(status >= 200 && status < 300)) return { ok: false, reason: 'non-2xx', size: 0 };

  const body = response.body;
  if (!body || typeof body !== 'object') return { ok: false, reason: 'no-body', size: 0 };
  if (!Array.isArray(body.choices) || body.choices.length === 0) return { ok: false, reason: 'no-choices', size: 0 };

  const choice = body.choices[0];
  if (!choice || !choice.message) return { ok: false, reason: 'no-message', size: 0 };
  if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
    return { ok: false, reason: 'tool-calls', size: 0 };
  }

  const text = choice.message.content;
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty-content', size: 0 };
  if (choice.finish_reason !== 'stop') return { ok: false, reason: 'truncated', size: 0 };

  let size = 0;
  try { size = JSON.stringify(body).length; } catch (e) { return { ok: false, reason: 'unserializable', size: 0 }; }
  if (size > cfg.maxResponseChars) return { ok: false, reason: 'too-large', size };

  return { ok: true, reason: 'ok', size };
}

/**
 * effectiveTtlSeconds(cfg, isVolatile) -> number
 *   > 0  seconds to live
 *   = 0  DO NOT CACHE (an explicit `ttlSeconds: 0` means exactly that)
 *   < 0  never expire (explicit sentinel, e.g. `ttlSeconds: -1`)
 * A volatile prompt takes the SHORTER of the two TTLs, with the "never expire"
 * sentinel handled explicitly so `ttlSeconds: -1` + `volatileTtlSeconds: 60`
 * still expires volatile answers after a minute.
 */
function effectiveTtlSeconds(cfg, isVolatile) {
  const base = cfg.ttlSeconds;
  if (!isVolatile) return base;
  const vol = cfg.volatileTtlSeconds;
  if (vol === 0 || base === 0) return 0;      // either says "do not cache"
  if (base < 0) return vol;                   // base never expires -> volatile wins
  if (vol < 0) return base;                   // volatile never expires -> base wins
  return Math.min(base, vol);
}

/* ------------------------------------------------------------------------- */
/* createCache                                                               */
/* ------------------------------------------------------------------------- */

/**
 * createCache(opts) -> cache
 *
 * @param {object}          [opts]
 * @param {object}          [opts.defaults]  overrides for DEFAULTS (process-wide)
 * @param {function}        [opts.now=Date.now] injectable clock (epoch ms) — tests
 * @param {string|object}   [opts.backend]   PROCESS-WIDE backend override: a name
 *                          or an object implementing { name, prepare(text),
 *                          score(a,b,idf) }. When given it wins over every
 *                          tenant's `similarity:` value. When absent, each
 *                          tenant's `similarity:` is resolved through
 *                          sim.createBackend(), which THROWS on anything but
 *                          'lexical' — a tenant asking for 'local' gets a loud
 *                          error in the log, not a silent downgrade.
 *
 * cache.lookup(descriptor) -> { hit:false, tier:'miss', reason }
 *                          |  { hit:true, tier:'exact'|'semantic', entry, ageSeconds, score }
 * cache.store(descriptor, response, meta) -> { stored:boolean, reason, entry?, ttlSeconds? }
 *
 * descriptor = {
 *   tenantId:    string   req.tenant.id
 *   tenantCache: object   req.tenant.cache  (may be undefined -> DEFAULTS)
 *   model:       string   the model the CLIENT requested
 *   body:        object   the raw req.body
 * }
 * response  = { status:number, body:object }
 * meta      = { model, provider, attempts, costUsd, promptTokens, completionTokens, latencyMs }
 */
/**
 * PHASE 4 - store adapter.
 *
 * src/redis/store.js is async and exposes get/set/candidates/size/delete/clear/
 * stats. The per-shard store this file drives is sync and exposes
 * get/put/listBucket/touch/setLimits/size/bytes/prune/clear/stats. This bridges
 * the two so a Redis-backed cache survives gateway restarts.
 *
 * Only get/put/listBucket are awaited at their call sites, so the rest stay
 * synchronous and cheap. Three deliberate differences from the in-memory store:
 *   - recency (LRU) and the maxEntries/maxBytes caps live inside the shared
 *     store, so touch() and setLimits() are no-ops here;
 *   - eviction callbacks never fire, so IDF statistics are not decremented on
 *     evict (and start empty after a restart). IDF only re-weights terms; the
 *     number/negation guards and the threshold still decide every hit;
 *   - size()/bytes() are sync but the shared store counts asynchronously, so
 *     they return the numbers loaded on this shard's first lookup and after
 *     every put. They only feed the ggw_cache_entries gauge.
 */
function adaptInjectedStore(injected, tenantId) {
  const ctx = { tenantId };
  let known = { entries: 0, bytes: 0 };
  let loaded = null;

  async function refresh() {
    try {
      const s = await injected.stats(ctx);
      known = { entries: Number(s && s.entries) || 0, bytes: Number(s && s.bytes) || 0 };
    } catch (_err) { /* keep the last known numbers */ }
  }

  return {
    async get(key) {
      // Once per shard: a restarted replica must report the entries already in
      // Redis, not 0, before it has written anything itself.
      if (!loaded) loaded = refresh();
      await loaded;
      return injected.get(key, ctx);
    },
    async put(entry) {
      const ok = await injected.set(entry.key, entry, ctx);
      await refresh();
      return ok;
    },
    listBucket(bucketKey, limit) {
      return injected.candidates(bucketKey, { limit, tenantId });
    },
    touch() { /* recency lives in the shared store */ },
    setLimits() { /* the shared store enforces its own caps */ },
    size() { return known.entries; },
    bytes() { return known.bytes; },
    prune() { return 0; }, // entries carry their own TTL; the store sweeps on write
    clear() {
      const n = known.entries;
      known = { entries: 0, bytes: 0 };
      Promise.resolve()
        .then(() => injected.clear(ctx))
        .catch(() => {}); // fire-and-forget must never become an unhandled rejection
      return n;
    },
    stats() {
      return { store: injected.backend(), tenant: tenantId, size: known.entries, bytes: known.bytes };
    },
  };
}

function createCache(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const defaults = Object.assign({}, DEFAULTS, o.defaults || {});
  // PHASE 4: when server.js injects an async (Redis-backed) store, every shard
  // uses it instead of building a per-tenant in-memory store. When it is absent
  // the Phase-3 in-memory path runs unchanged.
  const injectedStore = o.store || null;

  let overrideBackend = null;
  if (o.backend && typeof o.backend === 'object') overrideBackend = o.backend;
  else if (typeof o.backend === 'string' && o.backend) overrideBackend = sim.createBackend(o.backend);

  const backendsByName = new Map();

  /** Resolve (and memoize) the backend a tenant's config asks for. Throws loudly. */
  function backendFor(cfg) {
    if (overrideBackend) return overrideBackend;
    const name = cfg.similarity || defaults.similarity;
    let b = backendsByName.get(name);
    if (!b) { b = sim.createBackend(name); backendsByName.set(name, b); }
    return b;
  }

  // One shard per tenant: gives per-tenant maxEntries/TTL for free and keeps
  // the IDF statistics from being polluted across tenants.
  const shards = new Map();

  function shardFor(tenantId, cfg) {
    const backend = backendFor(cfg); // may throw for an unknown backend name
    let shard = shards.get(tenantId);

    if (shard) {
      // Re-apply the tenant's CURRENT limits: a shard created by an atypical
      // first request (or before a config reload) must not stay frozen at that
      // request's maxEntries/maxBytes.
      shard.store.setLimits({ maxEntries: cfg.maxEntries, maxBytes: cfg.maxBytes });
      if (shard.backend.name !== backend.name) {
        // Vectors from two different backends are not comparable. Swapping the
        // backend therefore invalidates everything stored for this tenant.
        shard.store.clear();
        shard.idf.clear();
        shard.backend = backend;
      }
      return shard;
    }

    const idf = sim.createIdf();
    // PHASE 4: an injected store is shared across tenants and namespaces itself
    // by tenantId, so it is adapted rather than constructed once per shard.
    const store = injectedStore
      ? adaptInjectedStore(injectedStore, tenantId)
      : createStore({
          maxEntries: cfg.maxEntries,
          maxBytes: cfg.maxBytes,
          now,
          onEvict(entry) { if (entry && entry.vector) idf.remove(entry.vector); },
        });
    shard = {
      store,
      idf,
      backend,
      weight: (term) => idf.weight(term),
      lastPruneAt: now(),
    };
    shards.set(tenantId, shard);
    return shard;
  }

  /**
   * Opportunistic TTL sweep. Nothing else ever frees an expired entry in a cold
   * bucket, so ggw_cache_entries would drift upward and the memory would be held
   * until an LRU eviction happened to reach it. Runs at most once per
   * cfg.pruneIntervalMs of CLOCK time (the injected clock, so tests stay
   * deterministic) and uses no timers, so nothing keeps the process alive.
   */
  function maybePrune(shard, cfg) {
    const t = now();
    if (t - shard.lastPruneAt < cfg.pruneIntervalMs) return 0;
    shard.lastPruneAt = t;
    return shard.store.prune();
  }

  /**
   * plan(descriptor) — everything derived from the request, computed once and
   * identically for lookup() and store(). Pure apart from reading DEFAULTS.
   */
  function plan(descriptor) {
    const d = descriptor || {};
    const body = d.body;
    const tenantId = String(d.tenantId || 'unknown');
    const cfg = resolveConfig(d.tenantCache, defaults);

    if (!cfg.enabled) return { ok: false, reason: 'disabled', cfg, tenantId };
    if (!body || typeof body !== 'object') return { ok: false, reason: 'no-body', cfg, tenantId };
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return { ok: false, reason: 'no-messages', cfg, tenantId };
    }

    const model = String(d.model || body.model || '');
    if (!model) return { ok: false, reason: 'no-model', cfg, tenantId };

    const normMsgs = normalizeMessages(body.messages);
    const paramsHash = paramsHashOf(body);

    // Final user turn = the semantic probe. Everything else is the prefix.
    let lastUser = -1;
    for (let i = normMsgs.length - 1; i >= 0; i -= 1) {
      if (normMsgs[i].role === 'user' && normMsgs[i].text) { lastUser = i; break; }
    }
    const prefix = lastUser === -1 ? normMsgs : normMsgs.filter((_, i) => i !== lastUser);
    const prefixHash = sha256(stableStringify(prefix));
    const probeText = lastUser === -1 ? '' : normMsgs[lastUser].text;

    // tenantId is in the exact key as well as the bucket key. Today the shards
    // already isolate tenants; in Phase 4 exactKey becomes the Redis key, where
    // omitting the tenant would be an immediate cross-tenant leak.
    const exactKey = sha256([tenantId, model, paramsHash, stableStringify(normMsgs)].join(SEP));
    const bucketKey = sha256([tenantId, model, paramsHash, prefixHash].join(SEP));

    const blockers = semanticBlockers(body, cfg);
    if (!probeText) blockers.push('no-user-turn');
    if (probeText.length > cfg.maxPromptChars) blockers.push('prompt-too-long');

    // Cheap, pure, always computed: drives volatile-TTL detection and doubles as
    // the stored vector when the backend is the default lexical one.
    const lex = probeText ? sim.vectorize(probeText) : null;

    // REPRESENTABILITY GUARDS. The lexical backend deletes every character
    // outside [a-z0-9.:+#_/-], so a CJK/Cyrillic/Arabic prompt can collapse to
    // the handful of Latin tokens it happens to contain — "重置密码 password"
    // and "删除账户 password" both become {password} and score 1.00. Refusing
    // the comparison is the only honest answer; the EXACT tier still serves
    // these prompts, and it is script-agnostic.
    if (lex) {
      if (lex.stopwordsOnly) blockers.push('stopword-only-prompt');
      if (lex.tf.size < cfg.minContentTokens) blockers.push('too-few-content-tokens');
      const kept = lex.text.replace(/\s+/g, '').length;
      const raw = probeText.replace(/\s+/g, '').length;
      if (raw > 0 && kept / raw < cfg.minScriptCoverage) blockers.push('unsupported-script');
    }

    return {
      ok: true,
      reason: 'ok',
      cfg,
      tenantId,
      model,
      paramsHash,
      prefixHash,
      exactKey,
      bucketKey,
      probeText,
      lex,
      semanticAllowed: blockers.length === 0,
      blockers,
    };
  }

  function ageSecondsOf(entry) {
    return Math.max(0, Math.round((now() - entry.createdAt) / 1000));
  }

  async function vectorFor(p, backend) {
    if (backend.name === 'lexical') return p.lex;
    return Promise.resolve(backend.prepare(p.probeText));
  }

  /* --------------------------------------------------------------------- */

  async function lookup(descriptor) {
    const p = plan(descriptor);
    if (!p.ok) return { hit: false, tier: 'miss', reason: p.reason, plan: p };

    const shard = shardFor(p.tenantId, p.cfg);
    maybePrune(shard, p.cfg);

    // Tier 0 — exact.
    const exact = await shard.store.get(p.exactKey);
    if (exact) {
      return {
        hit: true, tier: 'exact', entry: exact,
        ageSeconds: ageSecondsOf(exact), score: 1, reason: 'exact', plan: p,
      };
    }

    // Tier 1 — near-duplicate, inside this bucket only.
    if (p.semanticAllowed) {
      const probe = await vectorFor(p, shard.backend);
      if (probe) {
        const candidates = await shard.store.listBucket(p.bucketKey, p.cfg.maxSemanticCandidates);
        let best = null;
        let bestScore = 0;
        for (const cand of candidates) {
          if (!cand.vector) continue;
          const s = shard.backend.score(probe, cand.vector, shard.weight);
          if (s > bestScore) { bestScore = s; best = cand; }
        }
        if (best && bestScore >= p.cfg.threshold) {
          shard.store.touch(best);
          return {
            hit: true, tier: 'semantic', entry: best,
            ageSeconds: ageSecondsOf(best), score: bestScore, reason: 'semantic', plan: p,
          };
        }
      }
    }

    return { hit: false, tier: 'miss', reason: 'miss', plan: p };
  }

  /* --------------------------------------------------------------------- */

  async function store(descriptor, response, meta) {
    const p = (descriptor && descriptor.__plan) ? descriptor.__plan : plan(descriptor);
    if (!p.ok) return { stored: false, reason: p.reason };

    const check = storable(response, p.cfg);
    if (!check.ok) return { stored: false, reason: check.reason };

    const volatile_ = !!(p.lex && p.lex.volatile);
    const ttlSeconds = effectiveTtlSeconds(p.cfg, volatile_);
    // An explicit TTL of 0 means "do not cache this", not "cache forever".
    if (ttlSeconds === 0) return { stored: false, reason: 'ttl-zero' };

    const shard = shardFor(p.tenantId, p.cfg);
    maybePrune(shard, p.cfg);
    const vector = p.semanticAllowed ? await vectorFor(p, shard.backend) : null;

    const t = now();
    const m = meta || {};
    const entry = {
      key: p.exactKey,
      bucketKey: p.bucketKey,
      tenantId: p.tenantId,
      model: p.model,                 // what the CLIENT asked for
      paramsHash: p.paramsHash,
      prefixHash: p.prefixHash,
      probe: p.probeText,
      vector,
      status: Number(response.status),
      body: response.body,
      bytes: check.size,              // drives the store's byte budget
      meta: {
        model: m.model || p.model,    // what ACTUALLY produced it -> x-ggw-model
        provider: m.provider || 'unknown',
        attempts: Number(m.attempts) || 1,
        costUsd: Number(m.costUsd) || 0,
        promptTokens: Number(m.promptTokens) || 0,
        completionTokens: Number(m.completionTokens) || 0,
        latencyMs: Number(m.latencyMs) || 0,
      },
      volatile: volatile_,
      createdAt: t,
      // ttlSeconds < 0 is the explicit "never expire" sentinel.
      expiresAt: ttlSeconds > 0 ? t + ttlSeconds * 1000 : 0,
      hits: 0,
    };

    await shard.store.put(entry);
    if (vector) shard.idf.add(vector);

    return { stored: true, reason: 'stored', entry, ttlSeconds };
  }

  /* --------------------------------------------------------------------- */

  function size() {
    let n = 0;
    for (const shard of shards.values()) n += shard.store.size();
    return n;
  }

  function bytes() {
    let n = 0;
    for (const shard of shards.values()) n += shard.store.bytes();
    return n;
  }

  /** prune(tenantId?) -> expired entries dropped. Also called opportunistically. */
  function prune(tenantId) {
    let n = 0;
    for (const [id, shard] of shards) {
      if (tenantId && id !== tenantId) continue;
      shard.lastPruneAt = now();
      n += shard.store.prune();
    }
    return n;
  }

  /** purge(tenantId?) -> entries removed. STRETCH hook for a future admin route. */
  function purge(tenantId) {
    if (tenantId) {
      const shard = shards.get(tenantId);
      if (!shard) return 0;
      const n = shard.store.clear();
      shard.idf.clear();
      shards.delete(tenantId);
      return n;
    }
    let n = 0;
    for (const shard of shards.values()) { n += shard.store.clear(); shard.idf.clear(); }
    shards.clear();
    return n;
  }

  function stats() {
    const out = {
      backend: overrideBackend ? overrideBackend.name : defaults.similarity,
      entries: size(),
      bytes: bytes(),
      tenants: shards.size,
      byTenant: {},
    };
    for (const [tenantId, shard] of shards) {
      out.byTenant[tenantId] = Object.assign(shard.store.stats(), {
        backend: shard.backend.name,
        idfDocs: shard.idf.docs,
        idfTerms: shard.idf.terms,
      });
    }
    return out;
  }

  return {
    lookup,
    store,
    size,
    bytes,
    prune,
    purge,
    stats,
    plan,             // exported for tests / debugging
    backendName: overrideBackend ? overrideBackend.name : defaults.similarity,
    defaults,
  };
}

module.exports = {
  createCache,
  DEFAULTS,
  PARAM_KEYS,
  KEY_EXCLUDED,
  resolveConfig,
  normalizeForKey,
  normalizeMessages,
  contentToText,
  paramsHashOf,
  semanticBlockers,
  storable,
  effectiveTtlSeconds,
  stableStringify,
  sha256,
};
