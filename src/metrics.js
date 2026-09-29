'use strict';

/**
 * src/metrics.js — GreenGateway Prometheus registry.
 *
 * Every metric in the process is declared HERE, at module scope, exactly once.
 * Never construct a Counter/Gauge/Histogram inside a factory: prom-client throws
 * "A metric with the name ... has already been registered" the second time the
 * factory runs (two limiters in one process, two tests in one file). Phase-4
 * components take the metric objects by injection instead.
 *
 * Phase 3 added six cache series, Phase 4 five Redis / rate-limit series, and
 * Phase 5 adds the edge series (one sample per client request, the source of
 * every SLI), build info and Node.js runtime metrics. Phase 5 also makes the
 * three Phase-2 model gauges live: they were declared but never set. No name or
 * label set from an earlier phase changed, so existing tests and panels keep
 * working.
 *
 * LABEL CARDINALITY RULE: labels are drawn only from bounded, gateway-controlled
 * vocabularies — tenant id, model id, provider, status code, cache tier,
 * rate-limit window, route pattern, outcome. User input (prompt text, cache
 * keys, error strings, raw URLs) NEVER becomes a label.
 */

const client = require('prom-client');

const register = new client.Registry();

/* ------------------------------------------------------------------------- */
/* Phase 1 — request accounting (UNCHANGED)                                  */
/* ------------------------------------------------------------------------- */

const requests = new client.Counter({
  name: 'ggw_requests_total',
  // PHASE 5: help text corrected, name and labels unchanged.
  help: 'Chat outcomes per UPSTREAM ATTEMPT (a failover adds one sample per attempt), plus cache hits (provider="cache") and local 429s (provider="none"). For per-request SLIs use ggw_http_requests_total',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  registers: [register],
});

const cost = new client.Counter({
  name: 'ggw_cost_usd_total',
  help: 'Total upstream cost in USD (reads 0 on :free models)',
  labelNames: ['tenant', 'model', 'provider'],
  registers: [register],
});

const tokens = new client.Counter({
  name: 'ggw_tokens_total',
  help: 'Total tokens by kind (prompt/completion)',
  labelNames: ['tenant', 'model', 'provider', 'kind'],
  registers: [register],
});

const duration = new client.Histogram({
  name: 'ggw_request_duration_seconds',
  help: 'End-to-end request duration in seconds',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
  registers: [register],
});

/* ------------------------------------------------------------------------- */
/* Phase 2 — routing, breaker, health (names and labels UNCHANGED)           */
/* ------------------------------------------------------------------------- */

/*
 * PHASE 5: ggw_breaker_state, ggw_model_error_rate and ggw_model_latency_ms are
 * computed at SCRAPE time from the live breaker and health objects, which
 * src/server.js hands over with setModelStateSource(). A value set only when a
 * request happens would go stale on a quiet model: "OPEN" long after the
 * cooldown ended, just because nobody asked since.
 */
let modelSource = null;

/** source = { models: string[], breakerState(model) -> 0|1|2, health(model) -> snapshot } */
function setModelStateSource(source) {
  modelSource = source;
}

function eachModel(fn) {
  if (!modelSource) return;
  for (const model of modelSource.models) fn(model);
}

const breakerState = new client.Gauge({
  name: 'ggw_breaker_state',
  help: 'Circuit breaker state per model (0=closed, 1=half-open, 2=open)',
  labelNames: ['model'],
  registers: [register],
  collect() {
    eachModel((model) => this.set({ model }, modelSource.breakerState(model)));
  },
});

const breakerTransitions = new client.Counter({
  name: 'ggw_breaker_transitions_total',
  help: 'Circuit breaker state transitions',
  labelNames: ['model', 'to'],
  registers: [register],
});

const modelErrorRate = new client.Gauge({
  name: 'ggw_model_error_rate',
  help: 'Rolling error rate per model (0..1)',
  labelNames: ['model'],
  registers: [register],
  collect() {
    eachModel((model) => this.set({ model }, Number(modelSource.health(model).errRate) || 0));
  },
});

const modelLatency = new client.Gauge({
  name: 'ggw_model_latency_ms',
  help: 'Rolling latency estimate per model in milliseconds',
  labelNames: ['model'],
  registers: [register],
  collect() {
    eachModel((model) => this.set({ model }, Number(modelSource.health(model).p95ish) || 0));
  },
});

const routeSelected = new client.Counter({
  name: 'ggw_route_selected_total',
  help: 'Model selected by the router, with the reason',
  labelNames: ['model', 'reason'],
  registers: [register],
});

const failover = new client.Counter({
  name: 'ggw_failover_total',
  help: 'Failovers from one model to another',
  labelNames: ['from', 'to'],
  registers: [register],
});

/* ------------------------------------------------------------------------- */
/* Phase 3 — cache (UNCHANGED)                                               */
/* ------------------------------------------------------------------------- */

/**
 * tier is 'exact' | 'semantic' — a two-value vocabulary owned by the gateway.
 */
const cacheHits = new client.Counter({
  name: 'ggw_cache_hits_total',
  help: 'Cache hits by tier (exact = normalized key match, semantic = near-duplicate)',
  labelNames: ['tenant', 'tier'],
  registers: [register],
});

const cacheMisses = new client.Counter({
  name: 'ggw_cache_misses_total',
  help: 'Cache lookups that found nothing usable and went upstream',
  labelNames: ['tenant'],
  registers: [register],
});

/**
 * THE HEADLINE METRIC ON THE FREE TIER.
 * One increment = one HTTP request NOT sent to OpenRouter = one request not
 * spent against the ~20 req/min, ~50 req/day per-account free quota.
 * Hit rate = ggw_cache_hits_total / (ggw_cache_hits_total + ggw_cache_misses_total).
 *
 * src/routes/chat.js counts a cache hit in ggw_requests_total under
 * provider="cache". Any panel or alert that means "requests sent upstream"
 * must therefore say ggw_requests_total{provider!="cache"}.
 */
const cacheSaved = new client.Counter({
  name: 'ggw_cache_saved_requests_total',
  help: 'Upstream requests avoided by a cache hit (the real free-tier saving)',
  labelNames: ['tenant'],
  registers: [register],
});

const cacheEntries = new client.Gauge({
  name: 'ggw_cache_entries',
  help: 'Live cache entries (all tenants; with Redis: as of this replica\'s last write)',
  registers: [register],
});

/**
 * Buckets are sub-millisecond-heavy on purpose: the lexical backend scans a
 * bucket in-process, so anything above ~10 ms means the bucket scan cap
 * (maxSemanticCandidates) needs lowering — or, with Redis, that Redis is slow.
 */
const cacheLookup = new client.Histogram({
  name: 'ggw_cache_lookup_seconds',
  help: 'Time spent in cache.lookup(), labelled by the tier that answered',
  labelNames: ['tier'],
  buckets: [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register],
});

/**
 * Dollars that the cached response originally cost upstream.
 * ON THIS DEPLOYMENT IT READS 0.00 AND ALWAYS WILL: every allowed model is a
 * ':free' id, so usage.cost is 0. It is kept so the same dashboard keeps working
 * the day a paid model is added. Do not present it as the value of the cache.
 */
const cacheSavings = new client.Counter({
  name: 'ggw_cache_savings_usd',
  help: 'USD that cache hits would have cost upstream (0.00 on :free models)',
  labelNames: ['tenant'],
  registers: [register],
});

/* ------------------------------------------------------------------------- */
/* Phase 4 — shared state (Redis) + proactive rate limiting (UNCHANGED)      */
/* ------------------------------------------------------------------------- */

const redisUp = new client.Gauge({
  name: 'ggw_redis_up',
  help: 'Whether shared Redis state is usable right now (1) or the gateway is degraded to in-memory state (0)',
  registers: [register],
});
// Initialised at boot so `curl /metrics | grep ggw_redis_up` prints a line
// before the very first chat request.
redisUp.set(0);

const redisDegraded = new client.Counter({
  name: 'ggw_redis_degraded_total',
  help: 'Transitions into degraded (in-memory) mode, by the component that saw the failure. Moves on the TRANSITION only, never per call',
  labelNames: ['component'],
  registers: [register],
});

const ratelimitAllowed = new client.Counter({
  name: 'ggw_ratelimit_allowed_total',
  help: 'Proactive rate-limit checks that passed, counted once per window',
  labelNames: ['tenant', 'window'],
  registers: [register],
});

const ratelimitThrottled = new client.Counter({
  name: 'ggw_ratelimit_throttled_total',
  help: 'Requests refused locally by the proactive limiter, labelled with the deciding window',
  labelNames: ['tenant', 'window'],
  registers: [register],
});

const ratelimitRemaining = new client.Gauge({
  name: 'ggw_ratelimit_remaining',
  help: 'Requests left in the window after the most recent check',
  labelNames: ['tenant', 'window'],
  registers: [register],
});

/* ------------------------------------------------------------------------- */
/* Phase 5 — the edge, build info, runtime (NEW)                             */
/* ------------------------------------------------------------------------- */

/**
 * ONE sample per client request, recorded when the response is sent
 * (src/observability.js). `outcome` is decided by the gateway itself, so an SLI
 * can say "a failover that ended in a 200 is a success" — something
 * ggw_requests_total, which counts upstream attempts, cannot express.
 */
const httpRequests = new client.Counter({
  name: 'ggw_http_requests_total',
  help: 'HTTP responses, counted ONCE per client request, by route pattern, status code and outcome. SLIs are built on this',
  labelNames: ['route', 'method', 'status', 'outcome', 'tenant'],
  registers: [register],
});

/** Buckets include 10 s exactly: the latency SLO is "served in under 10 s". */
const httpDuration = new client.Histogram({
  name: 'ggw_http_request_duration_seconds',
  help: 'Time from request received to response sent, per client request',
  labelNames: ['route', 'outcome'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30],
  registers: [register],
});

const buildInfo = new client.Gauge({
  name: 'ggw_build_info',
  help: 'Always 1. The labels say which version runs, on which Node.js, against which upstream host',
  labelNames: ['version', 'node', 'upstream'],
  registers: [register],
});

// Node.js runtime metrics (CPU, memory, event-loop lag, GC, handles) under
// their standard names, so community Node.js dashboards work unchanged.
// Module scope on purpose: calling this twice throws "already registered".
client.collectDefaultMetrics({ register });

module.exports = {
  register,
  // Phase 1
  requests,
  cost,
  tokens,
  duration,
  // Phase 2
  breakerState,
  breakerTransitions,
  modelErrorRate,
  modelLatency,
  routeSelected,
  failover,
  // Phase 3
  cacheHits,
  cacheMisses,
  cacheSaved,
  cacheEntries,
  cacheLookup,
  cacheSavings,
  // Phase 4
  redisUp,
  redisDegraded,
  ratelimitAllowed,
  ratelimitThrottled,
  ratelimitRemaining,
  // Phase 5
  httpRequests,
  httpDuration,
  buildInfo,
  setModelStateSource,
};
