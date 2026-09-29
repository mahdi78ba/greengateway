'use strict';

/**
 * Proactive sliding-window rate limiter (THE Phase-4 free-tier feature).
 *
 * Both windows are ZSETs, so there is no INCR+EXPIRE fixed-window variant and
 * therefore no "TTL refreshed on every call = permanent lockout" hazard.
 *
 * The script is COUNT-THEN-ADD and only adds on allow. A denied request must
 * never push a timestamp into the window, otherwise a hammering client keeps
 * its own window permanently full and locks itself out forever.
 *
 * It is also all-or-nothing across windows: both counts are evaluated before
 * EITHER member is written, so a request rejected by rpd does not silently
 * consume an rpm slot.
 *
 * Window semantics (identical in Redis and in the memory fallback):
 *   ZREMRANGEBYSCORE k '-inf' (now - window)   -> inclusive removal
 *   => the live window is (now-window, now]; a sample at exactly now-window is
 *      already outside. The memory path uses `ts > now - window` to match.
 */

const defaultMetrics = require('../metrics');

const RPM_WINDOW_MS = 60_000;
const RPD_WINDOW_MS = 86_400_000;
const DEFAULT_RPM = 20; // OpenRouter free tier: ~20 requests/minute per account
const DEFAULT_RPD = 50; // ~50 requests/day per account

const RATELIMIT_LUA = `
-- KEYS[1]=rpm zset  KEYS[2]=rpd zset
-- ARGV[1]=now ms  ARGV[2]=rpm window ms  ARGV[3]=rpm limit
-- ARGV[4]=rpd window ms  ARGV[5]=rpd limit  ARGV[6]=unique member
local now = tonumber(ARGV[1])
local wm  = tonumber(ARGV[2])
local lm  = tonumber(ARGV[3])
local wd  = tonumber(ARGV[4])
local ld  = tonumber(ARGV[5])
local member = ARGV[6]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - wm)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - wd)

local nm = redis.call('ZCARD', KEYS[1])
local nd = redis.call('ZCARD', KEYS[2])

local function retry_for(key, window)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local r = window
  if oldest[2] then r = (tonumber(oldest[2]) + window) - now + 1 end
  if r < 1 then r = 1 end
  return r
end

local win = ''
local retry = 0
if nm >= lm then
  win = 'rpm'
  retry = retry_for(KEYS[1], wm)
end
if nd >= ld then
  local r = retry_for(KEYS[2], wd)
  -- tie-break: when both windows are exhausted, report the LONGER wait (rpd),
  -- otherwise clients retry after 60s and burn the daily pool all over again.
  if r > retry then
    win = 'rpd'
    retry = r
  end
end

if win ~= '' then
  return {0, win, retry, lm - nm, ld - nd}
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], wm + 1000)
redis.call('ZADD', KEYS[2], now, member)
redis.call('PEXPIRE', KEYS[2], wd + 1000)
return {1, '', 0, lm - nm - 1, ld - nd - 1}
`;

function intOr(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function createRateLimiter(opts = {}) {
  const redis = opts.redis || null;
  const now = opts.now || (() => Date.now());
  const prefix = opts.keyPrefix || 'ggw:rl:';
  const m = opts.metrics === false ? null : (opts.metrics || defaultMetrics);
  const defaults = {
    rpm: intOr(opts.defaultRpm !== undefined ? opts.defaultRpm : process.env.GGW_DEFAULT_RPM, DEFAULT_RPM),
    rpd: intOr(opts.defaultRpd !== undefined ? opts.defaultRpd : process.env.GGW_DEFAULT_RPD, DEFAULT_RPD)
  };
  const hardDisabled =
    opts.enabled === false || String(process.env.GGW_RATELIMIT_DISABLED || '') === '1';

  // PER-INSTANCE state. Never module-level: `node --test` gives one process per
  // FILE, so module-level buckets would leak between tests in the same file.
  const mem = new Map();
  let seq = 0;

  // The ZSET member MUST be globally unique. `${now}:${pid}:${seq}` is not:
  // two limiters in one process at the same millisecond produce the same
  // string, ZADD overwrites instead of appending, and the window silently
  // under-counts — exactly the two-replica case this feature exists for.
  const instanceId = opts.instanceId || require('node:crypto').randomBytes(6).toString('hex');

  function member(t) {
    seq += 1;
    return `${t}:${instanceId}:${seq}`;
  }

  function resolve(limits) {
    const l = limits || {};
    return {
      enabled: l.enabled !== false && !hardDisabled,
      rpm: intOr(l.rpm, defaults.rpm),
      rpd: intOr(l.rpd, defaults.rpd)
    };
  }

  function memCheck(tenantId, lim, t) {
    let st = mem.get(tenantId);
    if (!st) {
      st = { rpm: [], rpd: [] };
      mem.set(tenantId, st);
    }
    st.rpm = st.rpm.filter((ts) => ts > t - RPM_WINDOW_MS);
    st.rpd = st.rpd.filter((ts) => ts > t - RPD_WINDOW_MS);
    const nm = st.rpm.length;
    const nd = st.rpd.length;

    let win = null;
    let retry = 0;
    if (nm >= lim.rpm) {
      win = 'rpm';
      retry = st.rpm.length ? Math.max(1, st.rpm[0] + RPM_WINDOW_MS - t + 1) : RPM_WINDOW_MS;
    }
    if (nd >= lim.rpd) {
      const r = st.rpd.length ? Math.max(1, st.rpd[0] + RPD_WINDOW_MS - t + 1) : RPD_WINDOW_MS;
      if (r > retry) {
        win = 'rpd';
        retry = r;
      }
    }
    if (win) {
      return {
        allowed: false,
        window: win,
        retryAfterMs: retry,
        remaining: { rpm: Math.max(0, lim.rpm - nm), rpd: Math.max(0, lim.rpd - nd) }
      };
    }
    st.rpm.push(t);
    st.rpd.push(t);
    return {
      allowed: true,
      window: null,
      retryAfterMs: 0,
      remaining: { rpm: lim.rpm - nm - 1, rpd: lim.rpd - nd - 1 }
    };
  }

  function decode(reply) {
    if (!Array.isArray(reply) || reply.length < 5) return null;
    const allowed = Number(reply[0]) === 1;
    const win = String(reply[1] || '');
    return {
      allowed,
      window: allowed ? null : win || 'rpm',
      retryAfterMs: allowed ? 0 : Math.max(1, Number(reply[2]) || 1),
      remaining: {
        rpm: Math.max(0, Number(reply[3]) || 0),
        rpd: Math.max(0, Number(reply[4]) || 0)
      }
    };
  }

  function meter(tenantId, out) {
    if (!m) return;
    if (m.ratelimitRemaining) {
      m.ratelimitRemaining.set({ tenant: tenantId, window: 'rpm' }, out.remaining.rpm);
      m.ratelimitRemaining.set({ tenant: tenantId, window: 'rpd' }, out.remaining.rpd);
    }
    if (out.allowed) {
      if (m.ratelimitAllowed) {
        m.ratelimitAllowed.inc({ tenant: tenantId, window: 'rpm' });
        m.ratelimitAllowed.inc({ tenant: tenantId, window: 'rpd' });
      }
      return;
    }
    // labels MUST be exactly {tenant, window}; `source` is a response header,
    // never a metric label (an undeclared label makes prom-client throw).
    if (m.ratelimitThrottled) m.ratelimitThrottled.inc({ tenant: tenantId, window: out.window });
  }

  async function check(tenantId, limits) {
    const lim = resolve(limits);
    const t = now();
    if (!lim.enabled) {
      return {
        allowed: true,
        source: 'disabled',
        window: null,
        retryAfterMs: 0,
        remaining: { rpm: lim.rpm, rpd: lim.rpd },
        limits: { rpm: lim.rpm, rpd: lim.rpd }
      };
    }

    let res = null;
    let source = 'redis';
    if (redis) {
      try {
        const reply = await redis.call('ratelimit', [
          'EVAL',
          RATELIMIT_LUA,
          '2',
          `${prefix}${tenantId}:rpm`,
          `${prefix}${tenantId}:rpd`,
          String(t),
          String(RPM_WINDOW_MS),
          String(lim.rpm),
          String(RPD_WINDOW_MS),
          String(lim.rpd),
          member(t)
        ]);
        res = decode(reply);
      } catch (_err) {
        res = null;
      }
    }
    if (!res) {
      res = memCheck(tenantId, lim, t);
      source = 'memory';
    }

    const out = {
      allowed: res.allowed,
      source,
      window: res.window,
      retryAfterMs: res.retryAfterMs,
      remaining: res.remaining,
      limits: { rpm: lim.rpm, rpd: lim.rpd }
    };
    meter(tenantId, out);
    return out;
  }

  return {
    check,
    windows: { rpm: RPM_WINDOW_MS, rpd: RPD_WINDOW_MS },
    defaults: () => ({ ...defaults }),
    /** test/ops helper: drop this instance's memory buckets. */
    resetMemory: () => mem.clear()
  };
}

module.exports = {
  createRateLimiter,
  RATELIMIT_LUA,
  RPM_WINDOW_MS,
  RPD_WINDOW_MS,
  DEFAULT_RPM,
  DEFAULT_RPD
};

