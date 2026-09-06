'use strict';

/**
 * src/routes/chat.js — Phase 2 handler with the Phase 3 cache spliced in.
 *
 * The ONLY changes versus Phase 2 are the blocks fenced with
 *   // ===== PHASE 3 CACHE ... =====  /  // ===== END PHASE 3 =====
 * plus the two new requires and the optional second parameter of chatRoutes().
 * Everything else — the allow-list 403, the budget 402, getRouting, the
 * candidate pool, orderCandidates, the 503 cooling-down reply with Retry-After,
 * the failover loop, the breaker/health bookkeeping, every metric and every
 * x-ggw-* header — is unchanged.
 *
 * ORDER MATTERS: the cache sits AFTER the allow-list (403) and AFTER the budget
 * check (402) and BEFORE routing. Keeping budget first is what preserves the
 * existing smoke test — demo-nobudget must still get 402, never a cache hit.
 */

const { createBreaker } = require('../routing/breaker');
const { createHealth } = require('../routing/health');
const { orderCandidates } = require('../routing/scorer');
const M = require('../metrics');

// ===== PHASE 3 CACHE (require) =====
const { createCache } = require('../cache');
// ===== END PHASE 3 =====

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

/**
 * chatRoutes(spend, cache?) -> fastify plugin
 * `cache` is optional so src/server.js keeps calling chatRoutes(spend) exactly as
 * it does today; tests can inject a cache built with a fake clock.
 *
 * The cache instance is hung on the RETURNED PLUGIN FUNCTION as `.cache`.
 * app.decorate() inside the plugin would only decorate the plugin's own
 * encapsulated context (fastify-plugin is not a dependency here and is not
 * being added), so `app.ggwCache` would read `undefined` at the root. src/server.js
 * does the root-level decoration from this property instead.
 */
module.exports = function chatRoutes(spend, injectedCache) {
  const breaker = createBreaker();
  const health = createHealth();

  // ===== PHASE 3 CACHE (instance) =====
  // One process-wide cache, per-tenant sharded inside. In-memory, exactly like
  // `spend`, the breaker and the health window. Redis is Phase 4.
  const cache = injectedCache || createCache();
  // ===== END PHASE 3 =====

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
      const already = spend.get(t.id) || 0;
      if (already >= t.budget_usd) {
        return reply.code(402).send({
          error: {
            message: `tenant '${t.id}' has exhausted its budget (${already.toFixed(6)} / ${Number(t.budget_usd).toFixed(6)} USD)`,
            type: 'insufficient_budget',
          },
        });
      }

      // ===== PHASE 3 CACHE LOOKUP =====
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
        // Fail open: a broken cache (including a tenant asking for a similarity
        // backend that is not installed) must never break a request. The reason
        // is logged, never swallowed.
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
        // NOTE: cache hits DO land in ggw_requests_total with provider="cache".
        // That keeps one series for "requests the gateway answered", but it means
        // any panel that means "requests sent upstream" must filter
        // provider!="cache". This is called out in the runtime note.
        M.requests.inc({ tenant: t.id, model: servedModel, provider: 'cache', status });
        M.duration.observe(
          { tenant: t.id, model: servedModel, provider: 'cache', status },
          (Date.now() - startedAt) / 1000
        );
        // Deliberately NOT touched on a hit: ggw_cost_usd_total, ggw_tokens_total
        // and the `spend` ledger. No upstream call happened, so nothing was spent.

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
      // ===== END PHASE 3 =====

      /* 3) routing config ------------------------------------------------ */
      const routing = getRouting(t);

      /* 4) candidate pool ------------------------------------------------ */
      const pool = [requested, ...(t.fallbacks || []), ...t.allow_models]
        .filter((m) => t.allow_models.includes(m));
      const ordered = orderCandidates(pool, { health, breaker });

      /* 5) everything cooling down -------------------------------------- */
      if (!ordered.length) {
        const waitMs = breaker.cooldownRemainingMs(pool);
        reply.header('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000))));
        return reply.code(503).send({
          error: {
            message: 'all candidate models are cooling down',
            type: 'service_unavailable',
          },
        });
      }

      /* 6) failover loop ------------------------------------------------- */
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
          health.record(model, { ok: false, latencyMs });
          breaker.recordFailure(model);
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
          health.record(model, { ok: true, latencyMs });
          M.requests.inc({ tenant: t.id, model, provider: 'openrouter', status: '402' });
          return reply.code(402).send(body);
        }

        /* retryable: 429 / 408 / 5xx */
        if (isFailover(res.status)) {
          const text = await res.text().catch(() => '');
          health.record(model, { ok: false, latencyMs });
          breaker.recordFailure(model);
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
          health.record(model, { ok: true, latencyMs });
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

        health.record(model, { ok: true, latencyMs });
        breaker.recordSuccess(model);

        M.requests.inc({ tenant: t.id, model, provider, status: '200' });
        M.cost.inc({ tenant: t.id, model, provider }, costUsd);
        M.tokens.inc({ tenant: t.id, model, provider, kind: 'prompt' }, promptTokens);
        M.tokens.inc({ tenant: t.id, model, provider, kind: 'completion' }, completionTokens);
        M.duration.observe(
          { tenant: t.id, model, provider, status: '200' },
          (Date.now() - startedAt) / 1000
        );

        const newSpend = already + costUsd;
        spend.set(t.id, newSpend);

        // ===== PHASE 3 CACHE STORE =====
        // Only 2xx bodies reach here; cache.store() additionally refuses empty,
        // truncated (finish_reason !== 'stop'), tool-call and oversized responses,
        // and anything whose effective TTL is 0.
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
        // ===== END PHASE 3 =====

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

  // ===== PHASE 3 CACHE (root-level handle) =====
  // src/server.js does app.decorate('ggwCache', chatPlugin.cache) with this.
  plugin.cache = cache;
  // ===== END PHASE 3 =====

  return plugin;
};
