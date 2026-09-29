'use strict';

/**
 * Shared model health.
 *
 * Wrapper around src/routing/health.js. Every sample is also pushed to a
 * per-model Redis list that is HARD BOUNDED:
 *
 *   ggw:health:<model>   LPUSH sample -> LTRIM 0 maxSamples-1 -> PEXPIRE ttlMs
 *
 * Without the LTRIM+PEXPIRE this is one list element per request per replica
 * forever, i.e. an unbounded growth path in shared Redis.
 *
 * Each sample carries the replica id and refresh() SKIPS this replica's own
 * samples, so blending remote into local never double-counts our own traffic.
 */

const crypto = require('node:crypto');

const noop = () => {};

function createSharedHealth(opts = {}) {
  const redis = opts.redis || null;
  const local = opts.health;
  const now = opts.now || (() => Date.now());
  const prefix = opts.keyPrefix || 'ggw:health:';
  const maxSamples = Number(opts.maxSamples || 50);
  const ttlMs = Number(opts.ttlMs || 300_000);
  const replicaId = opts.replicaId || crypto.randomBytes(4).toString('hex');
  const log = opts.log || noop;

  if (!local) throw new Error('createSharedHealth requires the local { health } implementation');

  const remote = new Map(); // model -> { samples, errRate, p95ish }
  const key = (model) => `${prefix}${model}`;
  let timer = null;

  async function publish(model, sample) {
    if (!redis) return false;
    const payload = JSON.stringify({
      r: replicaId,
      ok: sample && sample.ok ? 1 : 0,
      ms: Math.max(0, Number(sample && sample.ms) || 0),
      t: now()
    });
    await redis.call('health', ['LPUSH', key(model), payload]);
    await redis.call('health', ['LTRIM', key(model), '0', String(maxSamples - 1)]);
    await redis.call('health', ['PEXPIRE', key(model), String(ttlMs)]);
    return true;
  }

  async function syncNow(model, sample) {
    try {
      return await publish(model, sample);
    } catch (err) {
      log('debug', `health publish skipped (redis unavailable): ${err && err.message}`);
      return false;
    }
  }

  async function refresh(model) {
    if (!redis) return null;
    try {
      const rows = await redis.call('health', ['LRANGE', key(model), '0', String(maxSamples - 1)]);
      let n = 0;
      let errors = 0;
      let sumMs = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        let s = null;
        try {
          s = JSON.parse(row);
        } catch (_err) {
          continue;
        }
        if (!s || s.r === replicaId) continue; // never double-count our own
        n += 1;
        if (!s.ok) errors += 1;
        sumMs += Number(s.ms) || 0;
      }
      if (n === 0) remote.delete(model);
      else remote.set(model, { samples: n, errRate: errors / n, p95ish: sumMs / n });
      return remote.get(model) || null;
    } catch (err) {
      log('debug', `health refresh skipped (redis unavailable): ${err && err.message}`);
      return null;
    }
  }

  return {
    record(model, sample) {
      local.record(model, sample);
      // fire-and-forget MUST be caught or an unhandled rejection kills Node 20.
      syncNow(model, sample).catch(noop);
    },
    syncNow,
    refresh,

    /**
     * Pull peer samples for `models` every `everyMs`. The scorer reads
     * snapshot() synchronously on the request path, so the Redis reads happen
     * here in the background instead. Without this loop the shared health is
     * write-only: every replica publishes, none ever reads.
     */
    start(models, everyMs = 2000) {
      const list = [...new Set(models || [])];
      if (timer || !redis || !list.length) return;
      timer = setInterval(() => {
        for (const m of list) refresh(m).catch(noop);
      }, everyMs);
      // unref: this interval must never hold `node --test` open.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** local snapshot blended with peer samples, weighted by sample count. */
    snapshot(model) {
      const base = local.snapshot(model) || { p95ish: 0, errRate: 0, samples: 0 };
      const r = remote.get(model);
      if (!r || !r.samples) return base;
      const ls = Number(base.samples) || 0;
      const total = ls + r.samples;
      if (total === 0) return base;
      return {
        p95ish: ((Number(base.p95ish) || 0) * ls + r.p95ish * r.samples) / total,
        errRate: ((Number(base.errRate) || 0) * ls + r.errRate * r.samples) / total,
        samples: total
      };
    },
    remoteSnapshot: (model) => remote.get(model) || null,
    replicaId
  };
}

module.exports = { createSharedHealth };

