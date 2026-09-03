'use strict';
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const requests = new client.Counter({
  name: 'llm_requests_total',
  help: 'Total LLM requests by tenant/model/provider/status',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  registers: [register],
});

const cost = new client.Counter({
  name: 'llm_request_cost_usd',
  help: 'Upstream spend in USD, taken from OpenRouter usage.cost',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  registers: [register],
});

const tokens = new client.Counter({
  name: 'llm_tokens_total',
  help: 'Tokens by direction (in/out)',
  labelNames: ['tenant', 'model', 'direction'],
  registers: [register],
});

const duration = new client.Histogram({
  name: 'llm_request_duration_seconds',
  help: 'Upstream request duration in seconds',
  labelNames: ['tenant', 'model', 'provider', 'status'],
  buckets: [0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

module.exports = { register, requests, cost, tokens, duration };
