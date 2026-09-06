'use strict';
const metrics = require('../metrics');
const { createBreaker } = require('../routing/breaker');
const { createHealth } = require('../routing/health');
const { orderCandidates } = require('../routing/scorer');

const OPENROUTER_BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';

// ---- shared in-memory routing state (per process), same spirit as Phase-1 `spend` ----
// The breaker is a process-global singleton keyed by model slug with FIXED
// thresholds (defined in breaker.js). Model health belongs to the shared free
// pool, not to any tenant, so breaker thresholds are deliberately NOT
// per-tenant. Only maxAttempts + the per-attempt timeout are tenant-tunable
// (see getRouting()).
const breaker = createBreaker({
  onTransition(model, to) {
    const num = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
    metrics.breakerState.set({ model }, num[to] ?? 0);
    metrics.breakerTransitions.inc({ model, to: to.toLowerCase() });
  },
});
const health = createHealth();

// ---- helpers ----
function isFailover(status) {
  // retryable: rate-limit, request timeout, and any 5xx
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

// Parse a cooldown (ms) from upstream headers. Read defensively: OpenRouter's
// X-RateLimit-Reset unit is not pinned in docs (epoch ms vs s vs delta).
function parseRetryAfterMs(headers) {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(ra); // HTTP-date form
    if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) {
      if (n > 1e12) return Math.max(0, n - Date.now());        // epoch ms
      if (n > 1e9) return Math.max(0, n * 1000 - Date.now());  // epoch seconds
      return Math.max(0, n * 1000);                            // delta seconds
    }
  }
  return null;
}

// Per-tenant routing config with sane defaults. Only the knobs that actually
// take effect are exposed: maxAttempts (bounded failover hops) and the
// per-attempt AbortController timeout. Breaker thresholds are global/fixed
// (see breaker.js) — this function deliberately does NOT advertise controls
// that would silently no-op.
function getRouting(t) {
  const r = (t && t.routing) || {};
  const slo = r.slo || {};
  return {
    maxAttempts: r.maxAttempts ?? 3,
    slo: {
      timeoutMs: slo.timeoutMs ?? 20_000,
    },
  };
}

function syncHealthMetrics(model) {
  const s = health.snapshot(model);
  metrics.modelErrorRate.set({ model }, s.errRate);
  metrics.modelLatency.set({ model }, s.p95ish);
}

async function safeJson(res) {
  try { return await res.json(); }
  catch { return { error: { message: 'upstream returned non-JSON', type: 'bad_upstream' } }; }
}
async function safeText(res) {
  try { return await res.text(); } catch { return null; }
}

module.exports = function chatRoutes(spend) {
  return async function (app, opts) {
    const auth = opts.auth;

    app.post('/v1/chat/completions', { preHandler: auth }, async (req, reply) => {
      const t = req.tenant;                       // (M1) set by auth preHandler; 401 handled there
      const requested = req.body && req.body.model;

      // (M3) allow-list -> 403  [Phase-1 preserved exactly]
      if (!t.allow_models.includes(requested)) {
        return reply.code(403).send({
          error: { message: `model '${requested}' not allowed for tenant`, type: 'model_not_allowed' },
        });
      }

      // (M4) pre-flight budget -> 402  [Phase-1 preserved exactly]
      const already = spend.get(t.id) || 0;
      if (already >= t.budget_usd) {
        return reply.code(402).send({
          error: { message: 'tenant budget exhausted', type: 'insufficient_budget' },
        });
      }

      const routing = getRouting(t);

      // Candidate pool: requested first, then fallbacks, then the rest of the
      // allow-list. Filtered to allow-listed slugs only (never user input),
      // de-duped and ordered by the scorer (excludes OPEN breakers).
      const pool = [requested, ...(t.fallbacks || []), ...t.allow_models]
        .filter((m) => t.allow_models.includes(m));
      const ordered = orderCandidates(pool, { health, breaker });

      // If EVERY candidate's breaker is OPEN, don't burn scarce daily-quota calls
      // probing models we KNOW are cooling down -> return 503 immediately with the
      // shortest remaining cooldown as Retry-After.
      if (!ordered.length) {
        const uniquePool = [...new Set(pool)];
        let minCd = Infinity;
        for (const m of uniquePool) {
          const rem = breaker.cooldownRemainingMs(m);
          if (rem < minCd) minCd = rem;
        }
        reply.header('x-ggw-attempts', '0');
        if (Number.isFinite(minCd) && minCd > 0) {
          reply.header('retry-after', String(Math.ceil(minCd / 1000)));
        }
        return reply.code(503).send({
          error: {
            message: 'all candidate models are cooling down (circuit open)',
            type: 'upstream_unavailable',
            attempts: 0,
          },
        });
      }

      const candidates = ordered;
      const maxAttempts = Math.max(1, Math.min(routing.maxAttempts, candidates.length));
      let attempts = 0;
      let lastErr = null;

      for (let i = 0; i < maxAttempts; i++) {
        const model = candidates[i];
        attempts++;

        // (M2) build body — one model per attempt: the GATEWAY drives failover.
        const body = {
          ...req.body,
          model,
          models: [model],
          stream: false,
          provider: { data_collection: 'deny', ...t.policy },
        };

        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), routing.slo.timeoutMs);

        let res, ms, status = 0;
        try {
          res = await fetch(OPENROUTER_BASE + '/chat/completions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, // (M1) inject key
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          status = res.status;
          ms = Date.now() - started;
          // The per-attempt deadline is "get a response (headers)". Once the fetch
          // resolves, DISARM the abort clock BEFORE reading the body — otherwise a
          // slow body read could trip controller.abort() mid-read, corrupt res.json()
          // into a bad_upstream object, and (on res.ok) get served as a bogus 200.
          clearTimeout(timer);

          // (M5) 402 = insufficient CREDITS (account balance). Account-global,
          // so failing over to another free model won't help -> terminal.
          if (status === 402) {
            health.record(model, { ok: false, ms, status });
            syncHealthMetrics(model);
            metrics.requests.inc({ tenant: t.id, model, provider: 'unknown', status: '402' });
            metrics.duration.observe({ tenant: t.id, model, provider: 'unknown', status: '402' }, ms / 1000);
            reply.header('x-ggw-model', model);
            reply.header('x-ggw-attempts', String(attempts));
            return reply.code(402).send(await safeJson(res));
          }

          // (M5) 429 / 5xx / timeout(408) -> record failure, trip breaker, try next.
          if (isFailover(status)) {
            const retryAfterMs = parseRetryAfterMs(res.headers);
            health.record(model, { ok: false, ms, status });
            breaker.recordFailure(model, { status, retryAfterMs });
            syncHealthMetrics(model);
            metrics.requests.inc({ tenant: t.id, model, provider: 'unknown', status: String(status) });
            metrics.duration.observe({ tenant: t.id, model, provider: 'unknown', status: String(status) }, ms / 1000);
            lastErr = { status, retryAfterMs, bodyText: await safeText(res) };
            continue; // <-- failover hop
          }

          // Non-retryable upstream error (400 bad request, 404 data-policy, ...).
          const data = await safeJson(res);
          if (!res.ok) {
            health.record(model, { ok: false, ms, status });
            syncHealthMetrics(model);
            metrics.requests.inc({ tenant: t.id, model, provider: 'unknown', status: String(status) });
            metrics.duration.observe({ tenant: t.id, model, provider: 'unknown', status: String(status) }, ms / 1000);
            reply.header('x-ggw-model', model);
            reply.header('x-ggw-attempts', String(attempts));
            return reply.code(status).send(data);
          }

          // ---- 2xx SUCCESS ----
          // NOTE: `provider` is the ONE metric label sourced from upstream, not from
          // the allow-list. Bounded in practice (OpenRouter provider names), but if
          // that ever changes shape this is the label to watch for cardinality.
          const provider = data.provider || 'unknown';
          const usage = data.usage || {};
          const spent = Number(usage.cost || 0); // $0 for :free models

          health.record(model, { ok: true, ms, status });
          breaker.recordSuccess(model);
          syncHealthMetrics(model);

          // metering (Phase-1 parity: requests / cost / tokens / duration)
          metrics.requests.inc({ tenant: t.id, model, provider, status: String(status) });
          metrics.cost.inc({ tenant: t.id, model, provider }, spent);
          if (usage.prompt_tokens) metrics.tokens.inc({ tenant: t.id, model, provider, kind: 'prompt' }, usage.prompt_tokens);
          if (usage.completion_tokens) metrics.tokens.inc({ tenant: t.id, model, provider, kind: 'completion' }, usage.completion_tokens);
          metrics.duration.observe({ tenant: t.id, model, provider, status: String(status) }, ms / 1000);

          spend.set(t.id, (spend.get(t.id) || 0) + spent);

          // route reason + failover metrics
          const reason = i === 0 ? (model === requested ? 'primary' : 'only-healthy') : 'failover';
          metrics.routeSelected.inc({ model, reason });
          if (i > 0) metrics.failover.inc({ from: candidates[0], to: model });

          // headers: Phase-1 spend headers + Phase-2 provenance
          reply.header('x-ggw-model', model);
          reply.header('x-ggw-attempts', String(attempts));
          reply.header('x-ggw-cost-usd', spent.toFixed(6));
          reply.header('x-ggw-tenant-spend-usd', (spend.get(t.id)).toFixed(6));
          return reply.code(200).send(data);
        } catch (e) {
          // timeout (AbortError) or network error -> retryable failure
          clearTimeout(timer);
          ms = Date.now() - started;
          const timeout = e && e.name === 'AbortError';
          status = timeout ? 408 : 0;
          health.record(model, { ok: false, ms, status });
          breaker.recordFailure(model, { status, retryAfterMs: null });
          syncHealthMetrics(model);
          metrics.requests.inc({ tenant: t.id, model, provider: 'unknown', status: String(status || 'ERR') });
          metrics.duration.observe({ tenant: t.id, model, provider: 'unknown', status: String(status || 'ERR') }, ms / 1000);
          lastErr = { status, err: String(e), bodyText: null };
          continue; // <-- failover hop
        }
      }

      // All candidates exhausted -> return the last upstream signal.
      reply.header('x-ggw-attempts', String(attempts));
      if (lastErr && lastErr.status === 429 && lastErr.retryAfterMs != null) {
        reply.header('retry-after', String(Math.ceil(lastErr.retryAfterMs / 1000)));
      }
      const code = lastErr && lastErr.status ? (lastErr.status === 0 ? 503 : lastErr.status) : 503;
      return reply.code(code).send({
        error: {
          message: 'all candidate models unavailable',
          type: 'upstream_unavailable',
          attempts,
          last_status: lastErr && lastErr.status,
        },
      });
    });
  };
};
