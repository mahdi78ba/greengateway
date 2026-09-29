'use strict';

/**
 * Shared circuit breaker.
 *
 * This is a WRAPPER, not a fork: the CLOSED/OPEN/HALF_OPEN state machine stays
 * in src/routing/breaker.js. All this adds is a published "who is open until
 * when" view in a single ZSET (member = model, score = openUntil ms) plus a
 * locally cached snapshot of it.
 *
 *   ggw:breaker:open  ZSET  model -> openUntil (epoch ms)
 *
 * The snapshot is consulted with the CURRENT clock, so a remote entry stops
 * blocking the moment its cooldown elapses even if no refresh has run: a
 * HALF_OPEN probe can never be starved forever.
 *
 * recordSuccess ZREMs the shared entry. Without that, replica A recovering at
 * t+5s leaves replicas B..N blocked for the remaining 25s of the score.
 */

const noop = () => {};

function createSharedBreaker(opts = {}) {
  const redis = opts.redis || null;
  const local = opts.breaker;
  const now = opts.now || (() => Date.now());
  const key = opts.key || 'ggw:breaker:open';
  const refreshMs = Number(opts.refreshMs || 1000);
  const log = opts.log || noop;

  if (!local) throw new Error('createSharedBreaker requires the local { breaker } state machine');

  const remote = new Map(); // model -> openUntil ms
  let timer = null;

  function remoteOpenUntil(model) {
    const until = remote.get(model);
    if (!until) return 0;
    if (until <= now()) {
      remote.delete(model);
      return 0;
    }
    return until;
  }

  async function publish(model) {
    if (!redis) return false;
    if (local.isOpen(model)) {
      const openUntil = now() + Math.max(0, Number(local.cooldownRemainingMs(model)) || 0);
      remote.set(model, openUntil);
      await redis.call('breaker', ['ZADD', key, String(openUntil), model]);
      return true;
    }
    remote.delete(model);
    await redis.call('breaker', ['ZREM', key, model]);
    return false;
  }

  /** await-able publish; used by tests and by anything that wants determinism. */
  async function syncNow(model) {
    try {
      return await publish(model);
    } catch (err) {
      log('debug', `breaker publish skipped (redis unavailable): ${err && err.message}`);
      return false;
    }
  }

  async function refresh() {
    if (!redis) return remote;
    const t = now();
    try {
      await redis.call('breaker', ['ZREMRANGEBYSCORE', key, '-inf', String(t)]);
      const flat = await redis.call('breaker', ['ZRANGEBYSCORE', key, String(t), '+inf', 'WITHSCORES']);
      remote.clear();
      const arr = Array.isArray(flat) ? flat : [];
      for (let i = 0; i + 1 < arr.length; i += 2) {
        const until = Number(arr[i + 1]);
        if (Number.isFinite(until) && until > t) remote.set(String(arr[i]), until);
      }
    } catch (err) {
      log('debug', `breaker refresh skipped (redis unavailable): ${err && err.message}`);
    }
    return remote;
  }

  return {
    /* --- read side: local OR anything a peer replica published --- */
    isOpen(model) {
      return Boolean(local.isOpen(model)) || remoteOpenUntil(model) > 0;
    },
    state(model) {
      if (remoteOpenUntil(model) > 0 && !local.isOpen(model)) return 'OPEN';
      return local.state(model);
    },
    cooldownRemainingMs(model) {
      const localMs = Number(local.cooldownRemainingMs(model)) || 0;
      const remoteMs = Math.max(0, remoteOpenUntil(model) - now());
      return Math.max(localMs, remoteMs);
    },

    /* --- write side: delegate first, then publish fire-and-forget --- */
    recordFailure(model, meta) {
      local.recordFailure(model, meta);
      // fire-and-forget MUST be caught: an unhandled rejection kills Node 20.
      syncNow(model).catch(noop);
    },
    recordSuccess(model) {
      local.recordSuccess(model);
      remote.delete(model);
      if (redis) redis.call('breaker', ['ZREM', key, model]).catch(noop);
    },

    syncNow,
    refresh,
    remoteSnapshot: () => new Map(remote),

    start() {
      if (timer || !redis) return;
      timer = setInterval(() => {
        refresh().catch(noop);
      }, refreshMs);
      // unref: this interval must never hold `node --test` open.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { createSharedBreaker };

