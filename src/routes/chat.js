'use strict';

/**
 * src/routes/chat.js — Phase 2 routing, Phase 3 cache, Phase 4 shared state.
 *
 * Phase-4 changes versus the committed Phase-3 handler are fenced with
 *   // ===== PHASE 4 ... =====  /  // ===== END PHASE 4 =====
 * or marked `// PHASE 4:` when they are one line. Everything else — error
 * bodies, x-ggw-* headers, metrics, the failover loop — is the Phase-3
 * behaviour, so every earlier test and runbook still holds.
 *
 * Handler order:
 *   401 auth -> 403 allow-list -> 402 budget -> CACHE -> 429 local limiter
 *   -> 503 all-breakers-open -> bounded failover loop -> 200
 *
 * The limiter sits AFTER the cache on purpose: a hit makes no OpenRouter call,
 * so throttling it would cost availability and protect nothing.
 *
 * Three latent Phase-2/3 bugs are fixed here as well (marked FIX):
 *   - health.record() gets `ms`, the field src/routing/health.js reads. The old
 *     `latencyMs` was ignored, so latency never reached the scorer.
 *   - an upstream Retry-After now reaches breaker.recordFailure(), which
 *     already knew how to honour it.
 *   - the all-open 503 asks the breaker per model: cooldownRemainingMs() takes
 *     one model, so passing it the whole pool always answered "retry in 1s".
 */

const { createBreaker } = require('../routing/breaker');
const { createHealth } = require('../routing/health');
const { orderCandidates } = require('../routing/scorer');
const M = require('../metrics');
const { createCache } = require('../cache');

// ===== PHASE 4 (require) =====
const { createBudget } = require('../redis/budget');
const { createRateLimiter } = require('../redis/ratelimit');
// ===== END PHASE 4 =====

const DEFAULT_ROUTING = { maxAttempts: 3, slo: { timeoutMs: 20000 } };

function getRouting(t) {
  const r = t.routing || {};
  return {
    maxAttempts: Number(r.maxAttempts) > 0 ? Number(r.maxAttempts) : DEFAULT_ROUTING.maxAttempts,
    slo: {
      timeoutMs: (r.slo && Number(r.slo.timeoutMs) > 0)
        ? Number(r.slo.timeoutMs)
        : DEFAULT_ROUTING.slo.timeoutMs,
    },
  };
}

/** 429 / 408 / 5xx are worth trying the next candidate for. */
function isFailover(status) {
  return status === 429 || status === 408 || status >= 500;
}

function baseUrl() {
  return process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
}

/** Retry-After (delta-seconds or HTTP-date) -> ms; undefined when absent or junk. */
function retryAfterMs(res) {
  const raw = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * chatRoutes(deps) -> fastify plugin
 *
 * deps = { spend, budget, limiter, breaker, health, cache }. src/server.js
 * builds the Redis-backed versions and injects them. Every field is optional
 * and defaults to the in-memory Phase-3 object, and the Phase-3 call
 * chatRoutes(spend, cache) still works.
 *
 * The cache instance is hung on the RETURNED PLUGIN FUNCTION as `.cache`.
 * app.decorate() inside the plugin would only decorate the plugin's own
 * encapsulated context, so src/server.js does the root-level decoration.
 */
module.exports = function chatRoutes(deps, legacyCache) {
  const d = deps instanceof Map ? { spend: deps, cache: legacyCache } : (deps || {});
  const spend = d.spend instanceof Map ? d.spend : new Map();

  // ===== PHASE 4 (shared state, injected by src/server.js) =====
  const budget = d.budget || createBudget({ redis: null, fallback: spend });
  const limiter = d.limiter || createRateLimiter({ redis: null });
  const breaker = d.breaker || createBreaker();
  const health = d.health || createHealth();
  // ===== END PHASE 4 =====

  const cache = d.cache || createCache();

  async function plugin(app, opts) {
    const auth = opts.auth;

    app.post('/v1/chat/completions', { preHandler: auth }, async (req, reply) => {
      const t = req.tenant;
      const startedAt = Date.now();
      const requested = req.body && req.body.model;

      /* 1) allow-list --------------------------------------------------- */
      if (!t.allow_models.includes(requested)) {
        return reply.code(403).send({
          error: {
            message: `model '${requested}' is not allowed for tenant '${t.id}'`,
            type: 'model_not_allowed',
          },
        });
      }

      /* 2) pre-flight budget -------------------------------------------- */
      // PHASE 4: the shared counter. budget.get() falls back to the Phase-2
      // `spend` Map by itself when Redis is unavailable.
      const already = await budget.get(t.id);
      if (budget.exceeds(already, t.budget_usd)) {
        return reply.code(402).send({
          error: {
            message: `tenant '${t.id}' has exhausted its budget (${already.toFixed(6)} / ${Number(t.budget_usd).toFixed(6)} USD)`,
            type: 'insufficient_budget',
          },
        });
      }

      /* 3) cache lookup ------------------------------------------------- */
      // After 403 and 402, before any routing. A hit performs NO upstream call
      // and therefore spends NONE of the ~20 req/min ~50 req/day free quota.
      const descriptor = {
        tenantId: t.id,
        tenantCache: t.cache,       // may be undefined -> cache DEFAULTS
        model: requested,           // the model the CLIENT asked for
        body: req.body,
      };

      let cached = { hit: false, tier: 'miss', reason: 'lookup-failed', plan: null };
      const lookupStart = process.hrtime.bigint();
      try {
        cached = await cache.lookup(descriptor);
      } catch (err) {
        // Fail open: a broken cache must never break a request. The reason is
        // logged, never swallowed.
        req.log.warn({ err: err && err.message }, 'ggw-cache: lookup failed, going upstream');
      }
      M.cacheLookup.observe(
        { tier: cached.hit ? cached.tier : 'miss' },
        Number(process.hrtime.bigint() - lookupStart) / 1e9
      );

      if (cached.hit) {
        const entry = cached.entry;
        const servedModel = entry.meta.model;      // the model that ORIGINALLY produced it
        const status = '200';

        M.cacheHits.inc({ tenant: t.id, tier: cached.tier });
        M.cacheSaved.inc({ tenant: t.id });
        M.cacheSavings.inc({ tenant: t.id }, entry.meta.costUsd || 0);
        M.cacheEntries.set(cache.size());
        // Cache hits DO land in ggw_requests_total with provider="cache", so a
        // panel that means "requests sent upstream" must filter provider!="cache".
        M.requests.inc({ tenant: t.id, model: servedModel, provider: 'cache', status });
        M.duration.observe(
          { tenant: t.id, model: servedModel, provider: 'cache', status },
          (Date.now() - startedAt) / 1000
        );
        // Deliberately NOT touched on a hit: cost, tokens, the budget and the
        // rate limiter. No upstream call happened, so nothing was spent.

        reply.header('x-ggw-cache', cached.tier === 'exact' ? 'hit-exact' : 'hit-semantic');
        reply.header('x-ggw-cache-age', String(cached.ageSeconds));
        reply.header('x-ggw-model', servedModel);
        reply.header('x-ggw-attempts', '0');
        reply.header('x-ggw-cost-usd', '0.000000');
        reply.header('x-ggw-tenant-spend-usd', already.toFixed(6));
        return reply.code(200).send(entry.body);
      }

      M.cacheMisses.inc({ tenant: t.id });
      M.cacheEntries.set(cache.size());
      reply.header('x-ggw-cache', 'miss');
      // Reuse the plan so store() re-derives no hashes. null if lookup threw.
      const cachePlan = cached.plan || null;

      // ===== PHASE 4: proactive local rate limit =====
      // Only requests that are about to call OpenRouter get here. Refusing them
      // locally, BEFORE the call, keeps the account inside the free tier's
      // ~20 req/min and ~50 req/day instead of provoking upstream 429s.
      // One slot per client request; its failover hops are bounded by
      // routing.maxAttempts.
      const gate = await limiter.check(t.id, t.limits);
      reply.header('x-ggw-ratelimit-source', gate.source);
      reply.header('x-ggw-ratelimit-remaining-rpm', String(gate.remaining.rpm));
      reply.header('x-ggw-ratelimit-remaining-rpd', String(gate.remaining.rpd));
      if (!gate.allowed) {
        // Retry-After is in SECONDS (RFC 9110). Sending the millisecond value
        // would tell a client to wait 60000 s, i.e. 16.6 hours.
        const seconds = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
        reply.header('retry-after', String(seconds));
        reply.header('x-ggw-ratelimit-window', gate.window);
        M.requests.inc({ tenant: t.id, model: requested, provider: 'none', status: '429' });
        M.duration.observe(
          { tenant: t.id, model: requested, provider: 'none', status: '429' },
          (Date.now() - startedAt) / 1000
        );
        // No upstream call, no breaker or health update, no budget charge.
        return reply.code(429).send({
          error: {
            message: `local rate limit reached for window '${gate.window}'; retry in ${seconds}s`,
            type: 'ggw_rate_limited',
          },
        });
      }
      // ===== END PHASE 4 =====

      /* 4) routing config ------------------------------------------------ */
      const routing = getRouting(t);

      /* 5) candidate pool ------------------------------------------------ */
      const pool = [requested, ...(t.fallbacks || []), ...t.allow_models]
        .filter((m) => t.allow_models.includes(m));
      const ordered = orderCandidates(pool, { health, breaker });

      /* 6) everything cooling down -------------------------------------- */
      if (!ordered.length) {
        // FIX: one model per call. The pool reopens when its soonest model does.
        const waits = [...new Set(pool)]
          .map((m) => breaker.cooldownRemainingMs(m))
          .filter((ms) => ms > 0);
        const waitMs = waits.length ? Math.min(...waits) : 1000;
        reply.header('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000))));
        return reply.code(503).send({
          error: {
            message: 'all candidate models are cooling down',
            type: 'service_unavailable',
          },
        });
      }

      /* 7) failover loop ------------------------------------------------- */
      const maxAttempts = Math.min(routing.maxAttempts, ordered.length);
      let previousModel = null;

      for (let i = 0; i < maxAttempts; i += 1) {
        const model = ordered[i];
        if (previousModel && previousModel !== model) {
          M.failover.inc({ from: previousModel, to: model });
        }
        M.routeSelected.inc({ model, reason: i === 0 ? 'primary' : 'failover' });
        previousModel = model;

        const upstreamBody = {
          ...req.body,
          model,
          models: [model],
          stream: false,
          provider: { data_collection: 'deny', ...t.policy },
        };

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), routing.slo.timeoutMs);
        const attemptStart = Date.now();

        let res;
        try {
          res = await fetch(`${baseUrl()}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(upstreamBody),
            signal: ac.signal,
          });
        } catch (err) {
          clearTimeout(timer);
          const latencyMs = Date.now() - attemptStart;
          health.record(model, { ok: false, ms: latencyMs, status: 408 }); // FIX: ms
          breaker.recordFailure(model, { status: 408 });
          M.requests.inc({ tenant: t.id, model, provider: 'openrouter', status: '408' });
          if (i + 1 < maxAttempts) continue;
          return reply.code(504).send({
            error: { message: `upstream request failed: ${err && err.message}`, type: 'upstream_error' },
          });
        }
        clearTimeout(timer); // headers are in; the body read is not on the SLO timer

        const latencyMs = Date.now() - attemptStart;

        /* terminal: upstream says the account is out of credit */
        if (res.status === 402) {
          const body = await res.json().catch(() => ({}));
          health.record(model, { ok: true, ms: latencyMs, status: 402 }); // FIX: ms
          M.requests.inc({ tenant: t.id, model, provider: 'openrouter', status: '402' });
          return reply.code(402).send(body);
        }

        /* retryable: 429 / 408 / 5xx */
        if (isFailover(res.status)) {
          const text = await res.text().catch(() => '');
          health.record(model, { ok: false, ms: latencyMs, status: res.status }); // FIX: ms
          // FIX: pass the upstream Retry-After so the breaker cools down exactly
          // as long as OpenRouter asked, instead of guessing with backoff.
          breaker.recordFailure(model, { status: res.status, retryAfterMs: retryAfterMs(res) });
          M.requests.inc({ tenant: t.id, model, provider: 'openrouter', status: String(res.status) });
          req.log.warn({ model, status: res.status }, 'ggw: failover');
          if (i + 1 < maxAttempts) continue;
          reply.header('x-ggw-model', model);
          reply.header('x-ggw-attempts', String(i + 1));
          return reply.code(res.status).type('application/json').send(text || JSON.stringify({
            error: { message: 'upstream exhausted all candidates', type: 'upstream_error' },
          }));
        }

        /* non-retryable non-2xx: hand it back as-is */
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          health.record(model, { ok: true, ms: latencyMs, status: res.status }); // FIX: ms
          M.requests.inc({ tenant: t.id, model, provider: 'openrouter', status: String(res.status) });
          reply.header('x-ggw-model', model);
          reply.header('x-ggw-attempts', String(i + 1));
          return reply.code(res.status).type('application/json').send(text || '{}');
        }

        /* 2xx ------------------------------------------------------------ */
        const json = await res.json();
        const provider = json.provider || 'openrouter';
        const usage = json.usage || {};
        const costUsd = Number(usage.cost) || 0;
        const promptTokens = Number(usage.prompt_tokens) || 0;
        const completionTokens = Number(usage.completion_tokens) || 0;

        health.record(model, { ok: true, ms: latencyMs, status: res.status }); // FIX: ms
        breaker.recordSuccess(model);

        M.requests.inc({ tenant: t.id, model, provider, status: '200' });
        M.cost.inc({ tenant: t.id, model, provider }, costUsd);
        M.tokens.inc({ tenant: t.id, model, provider, kind: 'prompt' }, promptTokens);
        M.tokens.inc({ tenant: t.id, model, provider, kind: 'completion' }, completionTokens);
        M.duration.observe(
          { tenant: t.id, model, provider, status: '200' },
          (Date.now() - startedAt) / 1000
        );

        // PHASE 4: charged ONCE per request, for the attempt that won, in the
        // shared counter (falls back to the `spend` Map when Redis is down).
        const newSpend = await budget.add(t.id, costUsd);

        /* cache store: only 2xx bodies reach here. cache.store() additionally
           refuses empty, truncated (finish_reason !== 'stop'), tool-call and
           oversized responses, and anything whose effective TTL is 0. */
        if (cachePlan) {
          try {
            await cache.store(
              { ...descriptor, __plan: cachePlan },
              { status: 200, body: json },
              {
                model,                 // the model that ACTUALLY served it
                provider,
                attempts: i + 1,
                costUsd,
                promptTokens,
                completionTokens,
                latencyMs,
              }
            );
            M.cacheEntries.set(cache.size());
          } catch (err) {
            req.log.warn({ err: err && err.message }, 'ggw-cache: store failed');
          }
        }

        reply.header('x-ggw-model', model);
        reply.header('x-ggw-attempts', String(i + 1));
        reply.header('x-ggw-cost-usd', costUsd.toFixed(6));
        reply.header('x-ggw-tenant-spend-usd', newSpend.toFixed(6));
        return reply.code(200).send(json);
      }

      /* loop fell through without returning */
      return reply.code(502).send({
        error: { message: 'no candidate model produced a response', type: 'upstream_error' },
      });
    });
  }

  // src/server.js does app.decorate('ggwCache', chatPlugin.cache) with this.
  plugin.cache = cache;

  return plugin;
};
