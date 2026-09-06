'use strict';

/**
 * src/metrics.js — GreenGateway Prometheus registry.
 *
 * Phase 3 ADDS six cache series and changes NOTHING else: every metric name,
 * label set and export from Phases 1-2 is byte-identical, so the existing
 * /metrics smoke test (`/ggw_requests_total/`) and any Grafana panels keep
 * working.
 *
 * LABEL CARDINALITY RULE: labels are drawn only from bounded, gateway-controlled
 * vocabularies — tenant id, model id, provider, status class, cache tier.
 * User input (prompt text, cache keys, error strings) NEVER becomes a label.
 */

const client = require('prom-client');

const register = new client.Registry();

/* ------------------------------------------------------------------------- */
/* Phase 1 — request accounting (UNCHANGED)                                  */
/* ------------------------------------------------------------------------- */

const requests = new client.Counter({
  name: 'ggw_requests_total',
  help: 'Total chat completion requests handled by the gateway',
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
/* Phase 2 — routing, breaker, health (UNCHANGED)                            */
/* ------------------------------------------------------------------------- */

const breakerState = new client.Gauge({
  name: 'ggw_breaker_state',
  help: 'Circuit breaker state per model (0=closed, 1=half-open, 2=open)',
  labelNames: ['model'],
  registers: [register],
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
});

const modelLatency = new client.Gauge({
  name: 'ggw_model_latency_ms',
  help: 'Rolling latency estimate per model in milliseconds',
  labelNames: ['model'],
  registers: [register],
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
/* Phase 3 — cache (NEW)                                                     */
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
 * COMPATIBILITY NOTE FOR EXISTING PANELS: the NAME and LABELS of every Phase-1/2
 * metric are byte-identical, but the MEANING of ggw_requests_total widens —
 * src/routes/chat.js counts a cache hit under provider="cache". Any panel or
 * alert that means "requests sent upstream" must now say
 *   ggw_requests_total{provider!="cache"}
 * Nothing else in Phases 1-2 is affected: ggw_cost_usd_total and
 * ggw_tokens_total are deliberately NOT touched on a hit.
 */
const cacheSaved = new client.Counter({
  name: 'ggw_cache_saved_requests_total',
  help: 'Upstream requests avoided by a cache hit (the real free-tier saving)',
  labelNames: ['tenant'],
  registers: [register],
});

const cacheEntries = new client.Gauge({
  name: 'ggw_cache_entries',
  help: 'Live entries currently held in the in-memory cache (all tenants)',
  registers: [register],
});

/**
 * Buckets are sub-millisecond-heavy on purpose: the lexical backend scans a
 * bucket in-process, so anything above ~10 ms means the bucket scan cap
 * (maxSemanticCandidates) needs lowering.
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
};
