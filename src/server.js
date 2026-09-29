'use strict';

const Fastify = require('fastify');

const { loadConfig } = require('./config');
const { makeAuth } = require('./plugins/auth');
const healthRoutes = require('./routes/health');
const chatRoutes = require('./routes/chat');
const { register } = require('./metrics');

const { createBreaker } = require('./routing/breaker');
const { createHealth } = require('./routing/health');
const { createStore } = require('./cache/store');
const { createCache } = require('./cache/index');

const { createRedisClient } = require('./redis/client');
const { createRedisStore } = require('./redis/store');
const { createBudget } = require('./redis/budget');
const { createRateLimiter } = require('./redis/ratelimit');
const { createSharedBreaker } = require('./redis/breaker');
const { createSharedHealth } = require('./redis/health');

const {
  requestId,
  instrumentHttp,
  breakerTransitions,
  exposeModelState,
  setBuildInfo,
} = require('./observability');

/** Every model any tenant may be routed to (fallbacks are a subset of allow_models). */
function routableModels(config) {
  const out = new Set();
  for (const t of config.byKey.values()) for (const m of t.allow_models) out.add(m);
  return [...out];
}

function build() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 256 * 1024,
    // PHASE 5: every request gets an id that is printed in each of its log lines
    // and returned as x-request-id. A sane incoming x-request-id is reused, so a
    // caller can follow one request through our logs.
    requestIdHeader: false,
    genReqId: requestId,
  });
  const config = loadConfig();
  const auth = makeAuth(config);
  const models = routableModels(config);
  const log = (level, msg) => app.log[level] && app.log[level](msg);

  // PHASE 5: one edge sample per response (the source of every SLI).
  instrumentHttp(app);
  setBuildInfo();

  // Phase-2 in-memory spend Map: still here, now as the budget's fallback AND
  // live mirror, so an outage mid-flight degrades without a code path change.
  const spend = new Map();

  /* --------------------------------------------------------- Phase 4 */
  // Lazy: no socket is opened here, so build() stays synchronous, offline and
  // handle-free for `node --test`.
  const redis = createRedisClient({ log });

  const budget = createBudget({ redis, fallback: spend });
  const limiter = createRateLimiter({ redis });

  // PHASE 5: every state change is counted in ggw_breaker_transitions_total.
  const localBreaker = createBreaker({ onTransition: breakerTransitions() });
  const breaker = createSharedBreaker({ redis, breaker: localBreaker, log });
  breaker.start(); // unref'd 1s snapshot refresh

  const localHealth = createHealth();
  const health = createSharedHealth({ redis, health: localHealth });
  health.start(models); // unref'd 2s pull of peer samples

  // PHASE 5: ggw_breaker_state / ggw_model_error_rate / ggw_model_latency_ms
  // are computed from these objects at every scrape.
  exposeModelState({ models, localBreaker, sharedBreaker: breaker, health });

  const store = createRedisStore({
    redis,
    fallback: createStore({}), // the Phase-3 in-memory store, unchanged
    maxEntries: Number(process.env.GGW_CACHE_MAX_ENTRIES || 500),
    maxBytes: Number(process.env.GGW_CACHE_MAX_BYTES || 8 * 1024 * 1024)
  });
  const cache = createCache({ store });

  app.register(healthRoutes);
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', register.contentType);
    return register.metrics();
  });

  const chatPlugin = chatRoutes({ spend, budget, limiter, breaker, health, cache, redis });
  app.register(chatPlugin, { auth });
  app.decorate('ggwCache', chatPlugin.cache); // unchanged decoration
  app.decorate('ggwRedis', redis);

  app.addHook('onClose', async () => {
    breaker.stop();
    health.stop();
    await redis.quit();
  });

  return app;
}

async function start() {
  const app = build();
  try {
    await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 8080) });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { build };
