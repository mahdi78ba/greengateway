'use strict';
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ---- Phase 1 (unchanged shape) ----
const requests = new client.Counter({
  name: 'ggw_requests_total',
  help: 'Total chat completion requests (per attempt)',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  registers: [register],
});
const cost = new client.Counter({
  name: 'ggw_cost_usd_total',
  help: 'Total USD cost (0 for :free models)',
  labelNames: ['tenant', 'model', 'provider'],
  registers: [register],
});
const tokens = new client.Counter({
  name: 'ggw_tokens_total',
  help: 'Total tokens by kind',
  labelNames: ['tenant', 'model', 'provider', 'kind'],
  registers: [register],
});
const duration = new client.Histogram({
  name: 'ggw_request_duration_seconds',
  help: 'Upstream request duration (per attempt)',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32],
  registers: [register],
});

// ---- Phase 2 additions ----
// NOTE: every `model` / `from` / `to` label comes from the tenant allow-list,
// NEVER from user input, so label cardinality stays bounded. (The one exception
// is the upstream-controlled `provider` label on the Phase-1 metrics above.)
const breakerState = new client.Gauge({
  name: 'ggw_breaker_state',
  help: 'Circuit breaker state per model: 0=closed, 1=half-open, 2=open',
  labelNames: ['model'],
  registers: [register],
});
const breakerTransitions = new client.Counter({
  name: 'ggw_breaker_transitions_total',
  help: 'Circuit breaker state transitions',
  labelNames: ['model', 'to'], // to = closed|half_open|open
  registers: [register],
});
const modelErrorRate = new client.Gauge({
  name: 'ggw_model_error_rate',
  help: 'EWMA error/429 rate per model (0..1)',
  labelNames: ['model'],
  registers: [register],
});
const modelLatency = new client.Gauge({
  name: 'ggw_model_latency_ms',
  help: 'p95-ish latency per model (ms)',
  labelNames: ['model'],
  registers: [register],
});
const routeSelected = new client.Counter({
  name: 'ggw_route_selected_total',
  help: 'Route decisions',
  labelNames: ['model', 'reason'], // reason = primary|failover|only-healthy
  registers: [register],
});
const failover = new client.Counter({
  name: 'ggw_failover_total',
  help: 'Failover hops (first-choice model -> model that actually served)',
  labelNames: ['from', 'to'],
  registers: [register],
});

module.exports = {
  register,
  // Phase 1
  requests, cost, tokens, duration,
  // Phase 2
  breakerState, breakerTransitions, modelErrorRate, modelLatency, routeSelected, failover,
};
