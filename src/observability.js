'use strict';

/**
 * src/observability.js — Phase 5 instrumentation glue.
 *
 *   instrumentHttp(app)    one edge sample per response + an x-request-id header
 *   requestId(req)         Fastify genReqId: reuse a sane x-request-id, else a UUID
 *   breakerTransitions()   onTransition callback for src/routing/breaker.js
 *   exposeModelState(...)  feeds the scrape-time breaker / model gauges
 *   setBuildInfo()         ggw_build_info{version,node,upstream} 1
 *
 * WHY AN EDGE METRIC. ggw_requests_total counts one sample per UPSTREAM ATTEMPT:
 * a request that fails over once shows up as one 429 and one 200, so an error
 * ratio built on it reports 50% for a request that succeeded. An SLI needs
 * exactly one sample per client request, with an outcome decided by the
 * gateway. That is ggw_http_requests_total, recorded here in onResponse.
 */

const crypto = require('node:crypto');
const M = require('./metrics');
const pkg = require('../package.json');

/**
 * The outcome vocabulary (bounded on purpose: it is a metric label).
 * The availability SLI in observability/prometheus/rules/recording.yml counts
 *   good = served | cache_hit      bad = upstream_exhausted | unavailable | error
 * and ignores the rest: those were caused by the caller or the tenant's policy.
 */
const OUTCOMES = Object.freeze([
  'served',             // 2xx answered by an upstream model
  'cache_hit',          // 2xx answered from the cache
  'rejected_auth',      // 401: missing or unknown API key
  'rejected_policy',    // 403 model not allowed, 402 budget exhausted
  'rejected_client',    // any other 4xx the gateway refused (e.g. invalid JSON)
  'throttled',          // 429 from our own proactive limiter
  'unavailable',        // 503: every candidate model's breaker is open
  'upstream_exhausted', // every attempt failed (429, 5xx or timeout)
  'upstream_rejected',  // upstream refused with a non-retryable 4xx (or its own 402)
  'error',              // an unexpected 5xx
  'not_found',          // 404: no such route
  'ok',                 // 2xx on the other routes (/healthz, /metrics)
]);

const STATE_VALUE = Object.freeze({ CLOSED: 0, HALF_OPEN: 1, OPEN: 2 });

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Reuse a sane incoming x-request-id (so a caller can follow its request), else mint one. */
function requestId(req) {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}

/** For responses the chat handler did not classify itself. */
function defaultOutcome(status) {
  if (status === 401) return 'rejected_auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'error';
  if (status >= 400) return 'rejected_client';
  return 'ok';
}

function instrumentHttp(app) {
  app.decorateRequest('ggwOutcome', null);
  app.decorateRequest('ggwStartNs', null);

  app.addHook('onRequest', async (req) => {
    req.ggwStartNs = process.hrtime.bigint();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    // The route PATTERN, never the raw URL: /v1/chat/completions?x=1 and a
    // scanner's /wp-login.php must not create new series.
    const route = (req.routeOptions && req.routeOptions.url) || 'unmatched';
    const status = reply.statusCode;
    const outcome = req.ggwOutcome || defaultOutcome(status);
    const tenant = (req.tenant && req.tenant.id) || 'none';
    M.httpRequests.inc({ route, method: req.method, status: String(status), outcome, tenant });
    if (req.ggwStartNs !== null) {
      const seconds = Number(process.hrtime.bigint() - req.ggwStartNs) / 1e9;
      M.httpDuration.observe({ route, outcome }, seconds);
    }
  });
}

/** For createBreaker({ onTransition }): counts CLOSED -> OPEN -> HALF_OPEN -> CLOSED moves. */
function breakerTransitions() {
  return (model, to) => M.breakerTransitions.inc({ model, to });
}

/**
 * Wire the scrape-time model gauges. Reads only, with no side effects on
 * routing: localBreaker.state() never reserves the HALF_OPEN probe (isOpen()
 * does), and a model a PEER replica opened is reported as OPEN from the shared
 * snapshot, so a dashboard shows the fleet's view, not just this replica's.
 */
function exposeModelState({ models, localBreaker, sharedBreaker, health, now = () => Date.now() }) {
  M.setModelStateSource({
    models,
    breakerState(model) {
      const until = sharedBreaker && sharedBreaker.remoteSnapshot
        ? sharedBreaker.remoteSnapshot().get(model)
        : 0;
      if (until && until > now()) return STATE_VALUE.OPEN;
      const value = STATE_VALUE[localBreaker.state(model)];
      return value === undefined ? 0 : value;
    },
    health(model) {
      return health.snapshot(model) || { errRate: 0, p95ish: 0 };
    },
  });
}

/** The upstream HOST only (never a path or a key), e.g. "openrouter.ai" or "mock-openrouter:8099". */
function upstreamHost(base = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1') {
  try {
    return new URL(base).host;
  } catch (_err) {
    return 'invalid';
  }
}

function setBuildInfo() {
  M.buildInfo.reset();
  M.buildInfo.set({ version: pkg.version, node: process.version, upstream: upstreamHost() }, 1);
}

module.exports = {
  OUTCOMES,
  STATE_VALUE,
  requestId,
  defaultOutcome,
  instrumentHttp,
  breakerTransitions,
  exposeModelState,
  upstreamHost,
  setBuildInfo,
};
