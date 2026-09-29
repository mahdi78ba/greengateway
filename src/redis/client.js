'use strict';

/**
 * The single Redis seam for GreenGateway.
 *
 * Rules this file enforces so Redis can NEVER take the gateway down:
 *   - lazy connect: nothing happens at require() or at build(); the socket is
 *     opened on the first command, so `node --test` never inherits a live handle.
 *   - an 'error' listener is attached BEFORE connect(); an EventEmitter 'error'
 *     with no listener throws, and an unhandled connect() rejection kills Node.
 *   - disableOfflineQueue: commands reject instantly while disconnected instead
 *     of piling up and then all firing at once on reconnect.
 *   - every command is time-boxed with Promise.race + clearTimeout in finally.
 *   - a process-level circuit: after `failureThreshold` consecutive failures we
 *     stop talking to Redis entirely and re-probe every `probeIntervalMs`, so a
 *     black-holed Redis costs one timeout per probe window, not six per request.
 *   - ggw_redis_up / ggw_redis_degraded_total move on TRANSITIONS only.
 *
 * Tests inject a fake via `{ client }` (any object with isReady/isOpen and
 * sendCommand(argv)); nothing else in Phase 4 imports `redis` directly.
 *
 * GGW_REDIS_DISABLED=1 (or `{ disabled: true }`) switches Redis off entirely:
 * no socket, no timers, every component takes its in-memory path at once.
 */

const defaultMetrics = require('../metrics');

const noop = () => {};

class RedisUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RedisUnavailableError';
    this.ggwRedisUnavailable = true;
  }
}

function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    // NOT unref'd: if the socket black-holes, this timer is the only thing left
    // to fire, and an unref'd one would let the loop drain with the caller's
    // promise pending forever. It is always cleared in the finally below.
    timer = setTimeout(() => reject(new RedisUnavailableError('redis command timeout')), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function createRedisClient(opts = {}) {
  const url = opts.url || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const commandTimeoutMs = Number(opts.commandTimeoutMs || process.env.GGW_REDIS_TIMEOUT_MS || 50);
  const connectTimeoutMs = Number(opts.connectTimeoutMs || 500);
  const failureThreshold = Number(opts.failureThreshold || 3);
  const probeIntervalMs = Number(opts.probeIntervalMs || 5000);
  const now = opts.now || (() => Date.now());
  const log = opts.log || noop;
  const m = opts.metrics === false ? null : (opts.metrics || defaultMetrics);

  const injected = opts.client || null;

  // Explicitly off. The HTTP-level test suites use this so they never read or
  // write a developer's real Redis (a cache entry left there by one `npm test`
  // turns the next run's expected miss into a hit), and it is also a clean way
  // to run a single replica with no Redis at all. An injected client wins.
  if (!injected && (opts.disabled === true || String(process.env.GGW_REDIS_DISABLED || '') === '1')) {
    if (m && m.redisUp) m.redisUp.set(0);
    return {
      call: () => Promise.reject(new RedisUnavailableError('redis disabled (GGW_REDIS_DISABLED=1)')),
      usable: () => false,
      quit: async () => {},
      url: 'disabled',
      disabled: true,
      isDegraded: () => true,
      raw: () => null
    };
  }

  let client = injected;
  let connectPromise = null;
  let connectStarted = false;
  let closed = false;
  let degraded = false;
  let consecutiveFailures = 0;
  let nextProbeAt = 0;

  function setUp(value) {
    if (m && m.redisUp) m.redisUp.set(value ? 1 : 0);
  }

  function ready(c) {
    if (!c) return false;
    if (c.isReady === false) return false;
    if (c.isOpen === false) return false;
    return true;
  }

  function onSuccess() {
    consecutiveFailures = 0;
    if (degraded) {
      degraded = false;
      log('info', 'redis recovered; shared state re-enabled');
    }
    setUp(true);
  }

  function onFailure(component, err) {
    consecutiveFailures += 1;
    if (!degraded && consecutiveFailures >= failureThreshold) {
      degraded = true;
      if (m && m.redisDegraded) m.redisDegraded.inc({ component: component || 'unknown' });
      log('warn', `redis degraded after ${consecutiveFailures} consecutive failures: ${err && err.message}`);
    }
    if (degraded) nextProbeAt = now() + probeIntervalMs;
    setUp(false);
  }

  function ensureClient() {
    if (injected) return injected;
    if (client) return client;
    // require() is deferred so a repo without node_modules/redis still boots.
    const { createClient } = require('redis');
    const c = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: (retries) => (closed ? false : Math.min(200 * (retries + 1), 10000))
      }
    });
    // MUST be registered before connect().
    c.on('error', (err) => {
      log('warn', `redis client error: ${err && err.message}`);
      setUp(false);
    });
    c.on('ready', () => {
      consecutiveFailures = 0;
      degraded = false;
      setUp(true);
    });
    c.on('end', () => setUp(false));
    client = c;
    return c;
  }

  async function waitReady(c) {
    if (ready(c)) return;
    if (injected) throw new RedisUnavailableError('injected client not ready');
    if (!connectStarted) {
      connectStarted = true;
      // The rejection is swallowed here on purpose; readiness is decided below.
      connectPromise = c.connect().catch((err) => {
        log('warn', `redis connect failed: ${err && err.message}`);
      });
    }
    await withTimeout(connectPromise || Promise.resolve(), connectTimeoutMs);
    if (!ready(c)) throw new RedisUnavailableError('redis not ready');
  }

  async function call(component, argv) {
    if (closed) throw new RedisUnavailableError('redis client closed');
    if (degraded && now() < nextProbeAt) throw new RedisUnavailableError('redis degraded');
    let c;
    try {
      c = ensureClient();
      await waitReady(c);
      const reply = await withTimeout(c.sendCommand(argv.map(String)), commandTimeoutMs);
      onSuccess();
      return reply;
    } catch (err) {
      onFailure(component, err);
      throw err && err.ggwRedisUnavailable ? err : new RedisUnavailableError(String(err && err.message));
    }
  }

  /** Sync best-effort answer for callers that cannot await (e.g. store.backend()). */
  function usable() {
    if (closed || degraded) return false;
    if (injected) return ready(injected);
    if (!client) return true; // not connected yet: optimistic, first call decides
    return ready(client);
  }

  async function quit() {
    closed = true;
    setUp(false);
    if (injected || !client) return;
    const c = client;
    client = null;
    if (c.isReady) {
      try {
        // Connected: QUIT lets in-flight replies drain. Bounded, so a socket
        // that stops answering cannot hold shutdown hostage.
        await withTimeout(c.quit(), 1000);
        return;
      } catch (_err) {
        /* fall through to a hard disconnect */
      }
    }
    // Never connected, or still retrying: QUIT would wait in the command queue
    // for a socket that never opens, and app.close() would hang forever (this is
    // exactly what CI hits, since it runs with no Redis). Drop the socket instead;
    // the reconnect loop sees the client closed and stops.
    try {
      if (c.isOpen) await c.disconnect();
    } catch (_ignored) { /* already closed */ }
  }

  return {
    call,
    usable,
    quit,
    url,
    isDegraded: () => degraded,
    raw: () => client
  };
}

module.exports = { createRedisClient, RedisUnavailableError };

