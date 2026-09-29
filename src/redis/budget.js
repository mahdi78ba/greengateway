'use strict';

/**
 * Shared per-tenant budget counter.
 *
 * UNITS, decided once and for all: the Redis value is an INTEGER number of
 * MICRO-DOLLARS (1 USD = 1_000_000) incremented with INCRBY.
 *
 * We deliberately do NOT use INCRBYFLOAT: it returns a decimal STRING whose
 * precision depends on the server build, and every read would need re-parsing
 * before it can be compared against `budget_usd`. Integer micro-dollars are
 * exact, atomic, and cross-replica reproducible.
 *
 *   write: micro = Math.round(usd * 1e6)      (ties away from zero, JS default)
 *   read:  usd   = Number(reply) / 1e6
 *   header x-ggw-tenant-spend-usd = usd.toFixed(6)
 *   redis-cli GET ggw:budget:<tenant>  ->  the micro-dollar integer
 *
 * The Phase-2 `spend` Map is kept as the fallback AND as a live mirror, so an
 * outage mid-flight degrades seamlessly. The mirror always stores a NUMBER:
 * the Phase-2 pre-flight does `spend.get(id) >= t.budget_usd` and
 * `x-ggw-tenant-spend-usd` calls .toFixed() on it, both of which break on a
 * string ("0.4" + 0.25 === "0.40.25").
 */

const MICRO = 1_000_000;

function toMicro(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * MICRO);
}

function createBudget(opts = {}) {
  const redis = opts.redis || null;
  const prefix = opts.keyPrefix || 'ggw:budget:';
  const spend = opts.fallback instanceof Map ? opts.fallback : new Map();

  const key = (tenantId) => `${prefix}${tenantId}`;

  function memGet(tenantId) {
    const v = Number(spend.get(tenantId));
    return Number.isFinite(v) ? v : 0;
  }

  function mirror(tenantId, usd) {
    const n = Number(usd);
    spend.set(tenantId, Number.isFinite(n) ? n : 0); // ALWAYS a number
    return spend.get(tenantId);
  }

  async function get(tenantId) {
    if (redis) {
      try {
        const reply = await redis.call('budget', ['GET', key(tenantId)]);
        const micro = reply === null || reply === undefined ? 0 : Number(reply);
        if (Number.isFinite(micro)) return mirror(tenantId, micro / MICRO);
      } catch (_err) {
        /* fall through to the Phase-2 Map */
      }
    }
    return memGet(tenantId);
  }

  async function add(tenantId, usd) {
    const micro = toMicro(usd);
    if (micro === 0) return get(tenantId); // free models report 0.00: never write
    if (redis) {
      try {
        const reply = await redis.call('budget', ['INCRBY', key(tenantId), String(micro)]);
        const total = Number(reply);
        if (Number.isFinite(total)) return mirror(tenantId, total / MICRO);
      } catch (_err) {
        /* fall through to the Phase-2 Map */
      }
    }
    return mirror(tenantId, memGet(tenantId) + micro / MICRO);
  }

  /**
   * The Phase-2 402 comparator, preserved EXACTLY.
   * demo-nobudget has budget_usd: 0 and spend 0 and must still 402,
   * so this is `>=`, and 0 does NOT mean "unlimited".
   */
  function exceeds(spendUsd, budgetUsd) {
    return Number(spendUsd) >= Number(budgetUsd);
  }

  return { get, add, exceeds, toMicro, fallback: spend, MICRO };
}

module.exports = { createBudget, toMicro, MICRO };

