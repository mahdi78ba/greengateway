'use strict';
/* Phase 4 — Redis shared state + proactive rate limiting.
 * CommonJS, node:test, 100% offline: no Redis server, no internet, no timers left
 * running. Everything Redis-backed is driven through an injected fake client;
 * the only real sockets are to 127.0.0.1 (a refused port, and a mock upstream). */

const test = require('node:test');
const assert = require('node:assert');

// This file exercises the limiter and the Redis client directly, so the
// suite-wide switches that test/smoke|routing|cache use must NOT leak in.
delete process.env.GGW_RATELIMIT_DISABLED;
delete process.env.GGW_REDIS_DISABLED;

const M = require('../src/metrics');
const { createRedisClient } = require('../src/redis/client');
const { createRateLimiter, RATELIMIT_LUA } = require('../src/redis/ratelimit');
const { createBudget } = require('../src/redis/budget');
const { createSharedBreaker } = require('../src/redis/breaker');
const { createSharedHealth } = require('../src/redis/health');
const { createRedisStore } = require('../src/redis/store');
const { createStore } = require('../src/cache/store'); // the REAL Phase-3 fallback
const { createCache } = require('../src/cache');
const sim = require('../src/cache/similarity');

/* ------------------------------------------------------------ fake redis */
/* A tiny in-process Redis. EVAL is dispatched on the exact script text and runs
 * an INDEPENDENT transliteration of the Lua, so the limiter's memory path and
 * its script path are genuinely cross-checked. The Lua itself is additionally
 * proven against a real server by the two-replica procedure in the README. */

function makeFake({ clock }) {
  const db = new Map();
  const nowMs = () => clock.ms;

  function alive(k) {
    const rec = db.get(k);
    if (!rec) return null;
    if (rec.px !== undefined && rec.px <= nowMs()) {
      db.delete(k);
      return null;
    }
    return rec;
  }
  function ensure(k, type, init) {
    let rec = alive(k);
    if (!rec) {
      rec = { type, v: init(), px: undefined };
      db.set(k, rec);
    }
    return rec;
  }
  const zsorted = (rec) =>
    [...rec.v.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  function slice(pairs, start, stop) {
    const n = pairs.length;
    let s = Number(start);
    let e = Number(stop);
    if (s < 0) s = Math.max(0, n + s);
    if (e < 0) e = n + e;
    if (e >= n) e = n - 1;
    if (s > e || s >= n) return [];
    return pairs.slice(s, e + 1);
  }
  const has = (a, word) => a.some((x) => String(x).toUpperCase() === word);
  const bound = (v) => (v === '-inf' ? -Infinity : v === '+inf' ? Infinity : Number(v));

  function exec(argv) {
    const a = argv.map(String);
    const cmd = a[0].toUpperCase();
    switch (cmd) {
      case 'SET': {
        const i = a.indexOf('PX');
        db.set(a[1], { type: 'string', v: a[2], px: i > 0 ? nowMs() + Number(a[i + 1]) : undefined });
        return 'OK';
      }
      case 'GET': {
        const r = alive(a[1]);
        return r ? String(r.v) : null;
      }
      case 'MGET':
        return a.slice(1).map((k) => {
          const r = alive(k);
          return r ? String(r.v) : null;
        });
      case 'DEL': {
        let n = 0;
        for (const k of a.slice(1)) if (db.delete(k)) n += 1;
        return n;
      }
      case 'INCRBY': {
        const r = alive(a[1]);
        const next = (r ? Number(r.v) : 0) + Number(a[2]);
        db.set(a[1], { type: 'string', v: String(next), px: r ? r.px : undefined });
        return next;
      }
      case 'PEXPIRE': {
        const r = alive(a[1]);
        if (!r) return 0;
        r.px = nowMs() + Number(a[2]);
        return 1;
      }
      case 'HSET': {
        const r = ensure(a[1], 'hash', () => new Map());
        for (let i = 2; i + 1 < a.length; i += 2) r.v.set(a[i], a[i + 1]);
        return 1;
      }
      case 'HMGET': {
        const r = alive(a[1]);
        return a.slice(2).map((f) => (r && r.v.has(f) ? r.v.get(f) : null));
      }
      case 'HDEL': {
        const r = alive(a[1]);
        if (!r) return 0;
        let n = 0;
        for (const f of a.slice(2)) if (r.v.delete(f)) n += 1;
        return n;
      }
      case 'ZADD': {
        const r = ensure(a[1], 'zset', () => new Map());
        let n = 0;
        for (let i = 2; i + 1 < a.length; i += 2) {
          if (!r.v.has(a[i + 1])) n += 1;
          r.v.set(a[i + 1], Number(a[i]));
        }
        return n;
      }
      case 'ZCARD': {
        const r = alive(a[1]);
        return r ? r.v.size : 0;
      }
      case 'ZREM': {
        const r = alive(a[1]);
        if (!r) return 0;
        let n = 0;
        for (const mem of a.slice(2)) if (r.v.delete(mem)) n += 1;
        if (!r.v.size) db.delete(a[1]);
        return n;
      }
      case 'ZRANGE':
      case 'ZREVRANGE': {
        const r = alive(a[1]);
        if (!r) return [];
        let pairs = zsorted(r);
        if (cmd === 'ZREVRANGE') pairs = pairs.reverse();
        const out = slice(pairs, a[2], a[3]);
        return has(a, 'WITHSCORES')
          ? out.flatMap(([m, s]) => [m, String(s)])
          : out.map(([m]) => m);
      }
      case 'ZRANGEBYSCORE': {
        const r = alive(a[1]);
        if (!r) return [];
        const min = bound(a[2]);
        const max = bound(a[3]);
        let pairs = zsorted(r).filter(([, s]) => s >= min && s <= max);
        const li = a.findIndex((x) => String(x).toUpperCase() === 'LIMIT');
        if (li > 0) {
          const off = Number(a[li + 1]);
          const cnt = Number(a[li + 2]);
          pairs = pairs.slice(off, cnt < 0 ? undefined : off + cnt);
        }
        return has(a, 'WITHSCORES')
          ? pairs.flatMap(([m, s]) => [m, String(s)])
          : pairs.map(([m]) => m);
      }
      case 'ZREMRANGEBYSCORE': {
        const r = alive(a[1]);
        if (!r) return 0;
        const min = bound(a[2]);
        const max = bound(a[3]);
        let n = 0;
        for (const [m, s] of [...r.v]) if (s >= min && s <= max) { r.v.delete(m); n += 1; }
        if (!r.v.size) db.delete(a[1]);
        return n;
      }
      case 'LPUSH': {
        const r = ensure(a[1], 'list', () => []);
        for (const v of a.slice(2)) r.v.unshift(v);
        return r.v.length;
      }
      case 'LTRIM': {
        const r = alive(a[1]);
        if (!r) return 'OK';
        r.v = slice(r.v.map((v) => [v, 0]), a[2], a[3]).map(([v]) => v);
        return 'OK';
      }
      case 'LRANGE': {
        const r = alive(a[1]);
        if (!r) return [];
        return slice(r.v.map((v) => [v, 0]), a[2], a[3]).map(([v]) => v);
      }
      case 'EVAL': {
        const numKeys = Number(a[2]);
        const keys = a.slice(3, 3 + numKeys);
        const args = a.slice(3 + numKeys);
        if (a[1] === RATELIMIT_LUA) return luaRateLimit(keys, args);
        throw new Error('fake redis: unknown script');
      }
      default:
        throw new Error(`fake redis: unsupported command ${cmd}`);
    }
  }

  function luaRateLimit(keys, args) {
    const now = Number(args[0]);
    const wm = Number(args[1]);
    const lm = Number(args[2]);
    const wd = Number(args[3]);
    const ld = Number(args[4]);
    const member = args[5];
    exec(['ZREMRANGEBYSCORE', keys[0], '-inf', String(now - wm)]);
    exec(['ZREMRANGEBYSCORE', keys[1], '-inf', String(now - wd)]);
    const nm = exec(['ZCARD', keys[0]]);
    const nd = exec(['ZCARD', keys[1]]);
    const retryFor = (k, w) => {
      const oldest = exec(['ZRANGE', k, '0', '0', 'WITHSCORES']);
      const r = oldest[1] === undefined ? w : Number(oldest[1]) + w - now + 1;
      return r < 1 ? 1 : r;
    };
    let win = '';
    let retry = 0;
    if (nm >= lm) { win = 'rpm'; retry = retryFor(keys[0], wm); }
    if (nd >= ld) {
      const r = retryFor(keys[1], wd);
      if (r > retry) { win = 'rpd'; retry = r; }
    }
    if (win !== '') return [0, win, Math.trunc(retry), lm - nm, ld - nd];
    exec(['ZADD', keys[0], String(now), member]);
    exec(['PEXPIRE', keys[0], String(wm + 1000)]);
    exec(['ZADD', keys[1], String(now), member]);
    exec(['PEXPIRE', keys[1], String(wd + 1000)]);
    return [1, '', 0, lm - nm - 1, ld - nd - 1];
  }

  return {
    exec,
    db,
    client: { isOpen: true, isReady: true, sendCommand: async (argv) => exec(argv) }
  };
}

function wrap(fake, clock) {
  const now = () => clock.ms;
  return {
    now,
    client: createRedisClient({ client: fake.client, now, metrics: false, commandTimeoutMs: 1000 })
  };
}

function downClient(opts = {}) {
  return createRedisClient({
    client: {
      isOpen: false,
      isReady: false,
      sendCommand: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:6379');
      }
    },
    metrics: false,
    ...opts
  });
}

/* =========================================================== rate limiter */

test('limiter allows up to rpm then throttles, newest state shared in redis', async () => {
  const clock = { ms: 1_000_000 };
  const { client, now } = wrap(makeFake({ clock }), clock);
  const rl = createRateLimiter({ redis: client, now, metrics: false });

  const a = await rl.check('t1', { rpm: 2, rpd: 10 });
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.source, 'redis');
  assert.strictEqual(a.remaining.rpm, 1);
  assert.strictEqual((await rl.check('t1', { rpm: 2, rpd: 10 })).remaining.rpm, 0);

  const denied = await rl.check('t1', { rpm: 2, rpd: 10 });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.window, 'rpm');
  assert.strictEqual(denied.remaining.rpm, 0);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_001);
});

test('two limiter instances (two replicas) share ONE window through redis', async () => {
  const clock = { ms: 1_100_000 };
  const fake = makeFake({ clock });
  const a = createRateLimiter({ redis: wrap(fake, clock).client, now: () => clock.ms, metrics: false });
  const b = createRateLimiter({ redis: wrap(fake, clock).client, now: () => clock.ms, metrics: false });

  assert.strictEqual((await a.check('shared', { rpm: 2, rpd: 9 })).allowed, true);
  assert.strictEqual((await b.check('shared', { rpm: 2, rpd: 9 })).allowed, true);
  const third = await b.check('shared', { rpm: 2, rpd: 9 });
  assert.strictEqual(third.allowed, false, 'replica B is throttled by replica A traffic');
  assert.strictEqual(third.window, 'rpm');
});

test('all-or-nothing across windows: an rpd denial consumes NO rpm slot', async () => {
  const clock = { ms: 1_200_000 };
  const { client, now } = wrap(makeFake({ clock }), clock);
  const rl = createRateLimiter({ redis: client, now, metrics: false });

  assert.strictEqual((await rl.check('t2', { rpm: 100, rpd: 1 })).allowed, true);
  const denied = await rl.check('t2', { rpm: 100, rpd: 1 });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.window, 'rpd');
  // observed directly, not inferred from a clock jump that ages out both windows
  assert.strictEqual(denied.remaining.rpm, 99);
});

test('denied checks never extend the window (no self-inflicted lockout)', async () => {
  const clock = { ms: 2_000_000 };
  const t0 = clock.ms;
  const { client, now } = wrap(makeFake({ clock }), clock);
  const rl = createRateLimiter({ redis: client, now, metrics: false });
  const lim = { rpm: 2, rpd: 1000 };

  await rl.check('t3', lim);
  await rl.check('t3', lim);
  for (let i = 0; i < 20; i += 1) {
    clock.ms += 100;
    assert.strictEqual((await rl.check('t3', lim)).allowed, false, `hammer #${i}`);
  }
  clock.ms = t0 + 59_999;
  assert.strictEqual((await rl.check('t3', lim)).allowed, false, 'still inside the window');
  clock.ms = t0 + 60_000;
  assert.strictEqual((await rl.check('t3', lim)).allowed, true, 'recovers exactly at windowStart+window');
});

test('window boundary is IDENTICAL in redis and in the memory fallback', async () => {
  for (const offset of [59_999, 60_000]) {
    const clock = { ms: 3_000_000 };
    const t0 = clock.ms;
    const { client, now } = wrap(makeFake({ clock }), clock);
    const viaRedis = createRateLimiter({ redis: client, now, metrics: false });
    const viaMemory = createRateLimiter({ redis: downClient(), now, metrics: false });

    assert.strictEqual((await viaRedis.check('edge', { rpm: 1, rpd: 99 })).source, 'redis');
    assert.strictEqual((await viaMemory.check('edge', { rpm: 1, rpd: 99 })).source, 'memory');
    clock.ms = t0 + offset;
    const r = await viaRedis.check('edge', { rpm: 1, rpd: 99 });
    const m = await viaMemory.check('edge', { rpm: 1, rpd: 99 });
    assert.strictEqual(r.allowed, m.allowed, `redis and memory disagree at +${offset}`);
    assert.strictEqual(r.allowed, offset >= 60_000);
  }
});

test('both windows exhausted: retryAfterMs reports the LONGER (rpd) wait', async () => {
  const clock = { ms: 4_000_000 };
  const { client, now } = wrap(makeFake({ clock }), clock);
  const rl = createRateLimiter({ redis: client, now, metrics: false });
  await rl.check('t4', { rpm: 1, rpd: 1 });
  const denied = await rl.check('t4', { rpm: 1, rpd: 1 });
  assert.strictEqual(denied.window, 'rpd');
  assert.ok(denied.retryAfterMs > 60_000, 'a 60s Retry-After would burn the daily pool again');
});

test('FALLBACK: limiter throttles in memory when Redis is down', async () => {
  const clock = { ms: 5_000_000 };
  const rl = createRateLimiter({ redis: downClient(), now: () => clock.ms, metrics: false });

  const a = await rl.check('t5', { rpm: 2, rpd: 10 });
  assert.strictEqual(a.allowed, true);
  assert.strictEqual(a.source, 'memory');
  await rl.check('t5', { rpm: 2, rpd: 10 });

  const denied = await rl.check('t5', { rpm: 2, rpd: 10 });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.source, 'memory');
  assert.strictEqual(denied.window, 'rpm');
  assert.ok(denied.retryAfterMs > 0);

  clock.ms += 60_001;
  assert.strictEqual((await rl.check('t5', { rpm: 2, rpd: 10 })).allowed, true);
});

test('FALLBACK: memory limiter is also all-or-nothing across windows', async () => {
  const clock = { ms: 6_000_000 };
  const rl = createRateLimiter({ redis: downClient(), now: () => clock.ms, metrics: false });
  await rl.check('t6', { rpm: 100, rpd: 1 });
  const denied = await rl.check('t6', { rpm: 100, rpd: 1 });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.window, 'rpd');
  assert.strictEqual(denied.remaining.rpm, 99, 'the rejected call consumed nothing');
});

test('limiter state is PER INSTANCE (no leakage between tests in one file)', async () => {
  const clock = { ms: 7_000_000 };
  const one = createRateLimiter({ redis: null, now: () => clock.ms, metrics: false });
  const two = createRateLimiter({ redis: null, now: () => clock.ms, metrics: false });
  assert.strictEqual((await one.check('iso', { rpm: 1, rpd: 5 })).allowed, true);
  assert.strictEqual((await one.check('iso', { rpm: 1, rpd: 5 })).allowed, false);
  assert.strictEqual((await two.check('iso', { rpm: 1, rpd: 5 })).allowed, true, 'fresh instance, fresh buckets');
});

test('limiter kill switches: limits.enabled=false and GGW_RATELIMIT_DISABLED=1', async () => {
  const rl = createRateLimiter({ redis: null, metrics: false });
  for (let i = 0; i < 30; i += 1) {
    const r = await rl.check('off', { rpm: 1, rpd: 1, enabled: false });
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.source, 'disabled');
  }
  process.env.GGW_RATELIMIT_DISABLED = '1';
  const envOff = createRateLimiter({ redis: null, metrics: false });
  delete process.env.GGW_RATELIMIT_DISABLED;
  for (let i = 0; i < 30; i += 1) {
    assert.strictEqual((await envOff.check('off2', { rpm: 1, rpd: 1 })).allowed, true);
  }
});

test('metrics are module-level: two limiters WITH metrics enabled, exact label sets', async () => {
  const clock = { ms: 8_000_000 };
  const first = createRateLimiter({ redis: null, now: () => clock.ms }); // metrics default = real
  const second = createRateLimiter({ redis: null, now: () => clock.ms }); // must NOT throw

  await first.check('mtenant', { rpm: 1, rpd: 5 });
  await first.check('mtenant', { rpm: 1, rpd: 5 }); // throttled on rpm
  await second.check('mtenant', { rpm: 5, rpd: 5 });

  const scrape = await M.register.metrics();
  assert.ok(scrape.includes('ggw_ratelimit_allowed_total{tenant="mtenant",window="rpm"}'), scrape.slice(0, 400));
  assert.ok(scrape.includes('ggw_ratelimit_allowed_total{tenant="mtenant",window="rpd"}'));
  assert.ok(scrape.includes('ggw_ratelimit_throttled_total{tenant="mtenant",window="rpm"} 1'));
  assert.ok(scrape.includes('ggw_ratelimit_remaining{tenant="mtenant",window="rpd"}'));
  assert.ok(/^ggw_redis_up \d+$/m.test(scrape), 'ggw_redis_up must exist at scrape time');
  // `source` is a header, never a label: no such series may appear.
  assert.ok(!scrape.includes('source="memory"'));
});

/* ================================================================ budget */

test('budget counter is atomic and exact (integer micro-dollars, INCRBY)', async () => {
  const clock = { ms: 1 };
  const fake = makeFake({ clock });
  const { client } = wrap(fake, clock);
  const budget = createBudget({ redis: client });

  assert.strictEqual(await budget.get('treetracker-admin'), 0);
  await budget.add('treetracker-admin', 0.001234);
  await budget.add('treetracker-admin', 0.001234);
  assert.strictEqual((await budget.get('treetracker-admin')).toFixed(6), '0.002468');
  assert.strictEqual(fake.exec(['GET', 'ggw:budget:treetracker-admin']), '2468', 'redis holds micro-dollars');

  await budget.add('treetracker-admin', 0); // free models report 0.00
  assert.strictEqual(fake.exec(['GET', 'ggw:budget:treetracker-admin']), '2468', 'no write for a 0 cost');
});

test('budget is shared across two independent instances (two replicas)', async () => {
  const clock = { ms: 1 };
  const fake = makeFake({ clock });
  const a = createBudget({ redis: wrap(fake, clock).client });
  const b = createBudget({ redis: wrap(fake, clock).client });
  await a.add('demo', 0.25);
  assert.strictEqual((await b.get('demo')).toFixed(2), '0.25');
});

test('FALLBACK: budget uses the Phase-2 spend Map when Redis is down', async () => {
  const spend = new Map([['demo', 0.5]]);
  const budget = createBudget({ redis: downClient(), fallback: spend });
  assert.strictEqual(await budget.get('demo'), 0.5);
  assert.strictEqual(await budget.add('demo', 0.25), 0.75);
  assert.strictEqual(spend.get('demo'), 0.75);
});

test('budget mirrors a NUMBER into the Map so a mid-flight outage degrades cleanly', async () => {
  const clock = { ms: 1 };
  const fake = makeFake({ clock });
  const spend = new Map();
  const live = createBudget({ redis: wrap(fake, clock).client, fallback: spend });
  await live.add('demo', 0.4);
  assert.strictEqual(typeof spend.get('demo'), 'number', 'a string here concatenates in the Phase-2 path');
  assert.strictEqual(spend.get('demo'), 0.4);
  assert.strictEqual((spend.get('demo') + 0.25).toFixed(2), '0.65');
});

test('402 comparator is preserved exactly: demo-nobudget (budget 0, spend 0) still 402s', () => {
  const budget = createBudget({ redis: null, fallback: new Map() });
  assert.strictEqual(budget.exceeds(0, 0), true, '0 does NOT mean unlimited');
  assert.strictEqual(budget.exceeds(0.999999, 1), false);
  assert.strictEqual(budget.exceeds(1, 1), true);
  assert.strictEqual(budget.toMicro(0.001234), 1234);
});

/* =============================================================== breaker */

function stubBreaker() {
  const open = new Map();
  return {
    calls: [],
    state: (m) => (open.get(m) ? 'OPEN' : 'CLOSED'),
    isOpen: (m) => Boolean(open.get(m)),
    cooldownRemainingMs: (m) => open.get(m) || 0,
    recordSuccess(m) {
      this.calls.push(['success', m]);
      open.delete(m);
    },
    recordFailure(m, meta) {
      this.calls.push(['failure', m, meta]);
      open.set(m, 30_000);
    }
  };
}

test('breaker wrapper delegates to the existing state machine (no fork)', async () => {
  const clock = { ms: 100_000 };
  const local = stubBreaker();
  const { client, now } = wrap(makeFake({ clock }), clock);
  const shared = createSharedBreaker({ redis: client, breaker: local, now });

  shared.recordFailure('z-ai/glm-5.2:free', { status: 429, retryAfterMs: 30_000 });
  assert.deepStrictEqual(local.calls[0].slice(0, 2), ['failure', 'z-ai/glm-5.2:free']);
  assert.strictEqual(shared.isOpen('z-ai/glm-5.2:free'), true);
  shared.recordSuccess('z-ai/glm-5.2:free');
  assert.strictEqual(local.calls[1][0], 'success');
});

test('one replica opening a breaker protects the other replica', async () => {
  const clock = { ms: 100_000 };
  const fake = makeFake({ clock });
  const now = () => clock.ms;
  const model = 'google/gemma-4-31b-it:free';

  const a = createSharedBreaker({ redis: wrap(fake, clock).client, breaker: stubBreaker(), now });
  const bLocal = stubBreaker();
  const b = createSharedBreaker({ redis: wrap(fake, clock).client, breaker: bLocal, now });

  assert.strictEqual(b.isOpen(model), false);
  a.recordFailure(model, { status: 429 });
  await a.syncNow(model);

  await b.refresh();
  assert.strictEqual(b.isOpen(model), true, 'replica B inherits the open breaker');
  assert.strictEqual(b.state(model), 'OPEN');
  assert.ok(b.cooldownRemainingMs(model) > 0);
  assert.strictEqual(bLocal.isOpen(model), false, 'local machine untouched');

  clock.ms += 31_000;
  assert.strictEqual(b.isOpen(model), false, 'remote entry expires with the cooldown');
});

test('recordSuccess clears the SHARED entry, not just the local one', async () => {
  const clock = { ms: 200_000 };
  const fake = makeFake({ clock });
  const now = () => clock.ms;
  const model = 'z-ai/glm-5.2:free';

  const a = createSharedBreaker({ redis: wrap(fake, clock).client, breaker: stubBreaker(), now });
  const b = createSharedBreaker({ redis: wrap(fake, clock).client, breaker: stubBreaker(), now });

  a.recordFailure(model, { status: 429 });
  await a.syncNow(model);
  await b.refresh();
  assert.strictEqual(b.isOpen(model), true);

  a.recordSuccess(model); // replica A recovered after 5s, not 30s
  await a.syncNow(model);
  await b.refresh();
  assert.strictEqual(b.isOpen(model), false, 'B must not stay blocked for the rest of the cooldown');
  assert.strictEqual(fake.exec(['ZCARD', 'ggw:breaker:open']), 0);
});

test('FALLBACK: breaker wrapper is pure local when Redis is down', async () => {
  const local = stubBreaker();
  const shared = createSharedBreaker({ redis: downClient(), breaker: local, now: () => 1 });
  shared.recordFailure('m', { status: 500 }); // fire-and-forget must not reject
  assert.strictEqual(shared.isOpen('m'), true);
  shared.recordSuccess('m');
  assert.strictEqual(shared.isOpen('m'), false);
  await new Promise((r) => setImmediate(r)); // let any stray rejection surface
});

/* ================================================================ health */

function stubHealth(snap) {
  return {
    records: [],
    record(m, s) {
      this.records.push([m, s]);
    },
    snapshot: () => snap
  };
}

test('health wrapper blends remote samples into a COLD local snapshot', async () => {
  const clock = { ms: 10_000 };
  const fake = makeFake({ clock });
  const now = () => clock.ms;

  const a = createSharedHealth({ redis: wrap(fake, clock).client, health: stubHealth(null), now, replicaId: 'A' });
  await a.syncNow('m1', { ok: true, ms: 200 });
  await a.syncNow('m1', { ok: false, ms: 400 });

  const cold = createSharedHealth({
    redis: wrap(fake, clock).client,
    health: stubHealth({ p95ish: 0, errRate: 0, samples: 0 }),
    now,
    replicaId: 'B'
  });
  await cold.refresh('m1');
  const s = cold.snapshot('m1');
  assert.strictEqual(s.samples, 2);
  assert.strictEqual(s.errRate, 0.5);
  assert.strictEqual(s.p95ish, 300);
});

test('health blending is sample-weighted when the local snapshot is WARM', async () => {
  const clock = { ms: 20_000 };
  const fake = makeFake({ clock });
  const now = () => clock.ms;

  const a = createSharedHealth({ redis: wrap(fake, clock).client, health: stubHealth(null), now, replicaId: 'A' });
  await a.syncNow('m2', { ok: true, ms: 200 });
  await a.syncNow('m2', { ok: false, ms: 400 });

  const warm = createSharedHealth({
    redis: wrap(fake, clock).client,
    health: stubHealth({ p95ish: 100, errRate: 0, samples: 2 }),
    now,
    replicaId: 'B'
  });
  await warm.refresh('m2');
  const s = warm.snapshot('m2');
  assert.strictEqual(s.samples, 4);
  assert.strictEqual(s.errRate, 0.25); // (0*2 + 0.5*2)/4
  assert.strictEqual(s.p95ish, 200); //  (100*2 + 300*2)/4
});

test('a replica never double-counts its OWN published samples', async () => {
  const clock = { ms: 30_000 };
  const fake = makeFake({ clock });
  const a = createSharedHealth({
    redis: wrap(fake, clock).client,
    health: stubHealth({ p95ish: 111, errRate: 0.2, samples: 5 }),
    now: () => clock.ms,
    replicaId: 'A'
  });
  await a.syncNow('m3', { ok: true, ms: 200 });
  await a.refresh('m3');
  assert.deepStrictEqual(a.snapshot('m3'), { p95ish: 111, errRate: 0.2, samples: 5 });
});

test('remote health storage is bounded (LTRIM to maxSamples)', async () => {
  const clock = { ms: 40_000 };
  const fake = makeFake({ clock });
  const h = createSharedHealth({
    redis: wrap(fake, clock).client,
    health: stubHealth(null),
    now: () => clock.ms,
    maxSamples: 5,
    replicaId: 'A'
  });
  for (let i = 0; i < 40; i += 1) await h.syncNow('m4', { ok: true, ms: i });
  assert.strictEqual(fake.exec(['LRANGE', 'ggw:health:m4', '0', '-1']).length, 5);
});

test('FALLBACK: health wrapper returns the local snapshot when Redis is down', async () => {
  const local = stubHealth({ p95ish: 123, errRate: 0.1, samples: 9 });
  const shared = createSharedHealth({ redis: downClient(), health: local, now: () => 1 });
  shared.record('m', { ok: true, ms: 5 });
  assert.deepStrictEqual(shared.snapshot('m'), { p95ish: 123, errRate: 0.1, samples: 9 });
  assert.strictEqual(local.records.length, 1);
  await new Promise((r) => setImmediate(r));
});

/* =========================================================== redis cache */

function entry(key, bucketKey, clock, ttlMs) {
  return {
    key,
    bucketKey,
    createdAt: clock.ms,
    expiresAt: ttlMs ? clock.ms + ttlMs : 0,
    response: { id: key, choices: [{ message: { content: key } }] }
  };
}

const memStore = (clock) =>
  createStore({ maxEntries: 500, maxBytes: 8 * 1024 * 1024, now: () => clock.ms });

test('redis store round-trips entries and honours TTL', async () => {
  const clock = { ms: 50_000 };
  const { client } = wrap(makeFake({ clock }), clock);
  const store = createRedisStore({ redis: client, fallback: memStore(clock), now: () => clock.ms });

  await store.set('k1', entry('k1', 'b1', clock, 10_000));
  assert.strictEqual((await store.get('k1')).response.id, 'k1');
  assert.strictEqual(store.backend(), 'redis');

  clock.ms += 10_001;
  assert.strictEqual(await store.get('k1'), null, 'entry must expire');
});

test('expiresAt === 0 means NEVER expire (no PEXPIREAT 0 self-delete)', async () => {
  const clock = { ms: 60_000 };
  const { client } = wrap(makeFake({ clock }), clock);
  const store = createRedisStore({ redis: client, fallback: memStore(clock), now: () => clock.ms });

  await store.set('perm', entry('perm', 'b', clock, 0));
  clock.ms += 365 * 86_400_000;
  const got = await store.get('perm');
  assert.ok(got, 'a permanent entry must survive an arbitrary clock jump');
  assert.strictEqual(got.response.id, 'perm');
  assert.strictEqual(await store.size(), 1, 'and the sweep must not eat it');
});

test('candidate scan is newest-first and BOUNDED by maxSemanticCandidates', async () => {
  const clock = { ms: 100_000 };
  const { client } = wrap(makeFake({ clock }), clock);
  const store = createRedisStore({
    redis: client, fallback: memStore(clock), now: () => clock.ms, maxSemanticCandidates: 3
  });

  for (let i = 0; i < 10; i += 1) {
    clock.ms += 10;
    await store.set(`c${i}`, entry(`c${i}`, 'bucketA', clock, 60_000));
  }
  const bounded = await store.candidates('bucketA', { limit: 200 });
  assert.strictEqual(bounded.length, 3, 'store cap wins over the caller limit');
  assert.strictEqual(bounded[0].key, 'c9', 'newest first');
  assert.strictEqual(bounded[1].key, 'c8');

  assert.strictEqual((await store.candidates('bucketA', { limit: 2 })).length, 2, 'caller limit wins when smaller');
  assert.strictEqual(await store.size(), 10);
});

test('redis store trims to maxEntries and to maxBytes', async () => {
  const clock = { ms: 200_000 };
  const { client } = wrap(makeFake({ clock }), clock);
  const store = createRedisStore({
    redis: client, fallback: memStore(clock), now: () => clock.ms, maxEntries: 5
  });
  for (let i = 0; i < 9; i += 1) {
    clock.ms += 5;
    await store.set(`t${i}`, entry(`t${i}`, 'b', clock, 60_000));
  }
  assert.ok((await store.size()) <= 5);
  assert.strictEqual(await store.get('t0'), null, 'oldest evicted');
  assert.ok(await store.get('t8'), 'newest retained');

  const tiny = createRedisStore({
    redis: client, fallback: memStore(clock), now: () => clock.ms, tenantId: 'bytes', maxBytes: 400
  });
  for (let i = 0; i < 8; i += 1) {
    clock.ms += 5;
    await tiny.set(`z${i}`, entry(`z${i}`, 'b', clock, 60_000));
  }
  const s = await tiny.stats();
  assert.ok(s.bytes <= 400, `byte ceiling enforced, got ${s.bytes}`);
  assert.ok(s.entries >= 1 && s.entries < 8);
});

test('expired entries are purged from the bucket index (no tombstones, no leak)', async () => {
  const clock = { ms: 250_000 };
  const fake = makeFake({ clock });
  const { client } = wrap(fake, clock);
  const store = createRedisStore({ redis: client, fallback: memStore(clock), now: () => clock.ms });

  for (let i = 0; i < 3; i += 1) await store.set(`h${i}`, entry(`h${i}`, 'hb', clock, 10_000));
  assert.strictEqual((await store.candidates('hb', { limit: 10 })).length, 3);

  clock.ms += 10_001;
  assert.deepStrictEqual(await store.candidates('hb', { limit: 10 }), [], 'never serve tombstones');
  assert.strictEqual(await store.size(), 0, 'size() must not over-report');
  assert.strictEqual(fake.exec(['ZCARD', 'ggw:cache:default:b:hb']), 0, 'bucket ZSET is pruned');
  assert.strictEqual(fake.exec(['GET', 'ggw:cache:default:bytes']), '0', 'byte total returns to zero');
});

test('cache keys are tenant-namespaced: two tenants, one prompt, no collision', async () => {
  const clock = { ms: 260_000 };
  const fake = makeFake({ clock });
  const now = () => clock.ms;
  const A = createRedisStore({ redis: wrap(fake, clock).client, fallback: memStore(clock), now, tenantId: 'treetracker-admin' });
  const B = createRedisStore({ redis: wrap(fake, clock).client, fallback: memStore(clock), now, tenantId: 'demo-nobudget' });

  await A.set('same', { ...entry('same', 'bkt', clock, 60_000), response: { id: 'from-A' } });
  await B.set('same', { ...entry('same', 'bkt', clock, 60_000), response: { id: 'from-B' } });

  assert.strictEqual((await A.get('same')).response.id, 'from-A');
  assert.strictEqual((await B.get('same')).response.id, 'from-B');
  assert.strictEqual((await A.candidates('bkt', { limit: 10 })).length, 1);
  assert.strictEqual((await A.candidates('bkt', { limit: 10 }))[0].response.id, 'from-A');
  assert.strictEqual(await A.size(), 1);
  assert.strictEqual(await B.size(), 1);
});

test('cache survives a "restart": a fresh store instance sees existing entries', async () => {
  const clock = { ms: 300_000 };
  const fake = makeFake({ clock });
  const first = createRedisStore({ redis: wrap(fake, clock).client, fallback: memStore(clock), now: () => clock.ms });
  await first.set('warm', entry('warm', 'b', clock, 86_400_000));

  const restarted = createRedisStore({ redis: wrap(fake, clock).client, fallback: memStore(clock), now: () => clock.ms });
  assert.strictEqual((await restarted.get('warm')).response.id, 'warm');
});

test('FALLBACK: redis store delegates to the REAL src/cache/store.js when Redis is down', async () => {
  const clock = { ms: 400_000 };
  const fallback = memStore(clock);
  const store = createRedisStore({ redis: downClient(), fallback, now: () => clock.ms, maxSemanticCandidates: 3 });

  assert.strictEqual(store.backend(), 'memory');
  for (let i = 0; i < 5; i += 1) {
    clock.ms += 10;
    await store.set(`f${i}`, entry(`f${i}`, 'bx', clock, 60_000));
  }
  assert.strictEqual(fallback.size(), 5, 'writes landed in the Phase-3 store');
  assert.strictEqual((await store.get('f4')).response.id, 'f4');

  const cands = await store.candidates('bx', { limit: 200 });
  assert.strictEqual(cands.length, 3, 'degraded path respects maxSemanticCandidates identically');
  assert.deepStrictEqual(cands.map((c) => c.key), ['f4', 'f3', 'f2'], 'degraded path is newest-first too');
  assert.strictEqual((await store.candidates('bx', { limit: 2 })).length, 2);
  assert.strictEqual(await store.size(), 5);
  assert.strictEqual((await store.stats()).backend, 'memory');

  clock.ms += 60_001;
  assert.strictEqual(await store.get('f4'), null, 'TTL is honoured in degraded mode as well');
  assert.deepStrictEqual(await store.candidates('bx', { limit: 10 }), []);
});

test('FALLBACK: tenants stay isolated in the shared in-memory store too', async () => {
  const clock = { ms: 450_000 };
  const fallback = memStore(clock);
  const now = () => clock.ms;
  const A = createRedisStore({ redis: downClient(), fallback, now, tenantId: 'ta' });
  const B = createRedisStore({ redis: downClient(), fallback, now, tenantId: 'tb' });

  await A.set('same', { ...entry('same', 'bkt', clock, 60_000), response: { id: 'from-A' } });
  await B.set('same', { ...entry('same', 'bkt', clock, 60_000), response: { id: 'from-B' } });

  assert.strictEqual((await A.get('same')).response.id, 'from-A');
  assert.strictEqual((await B.get('same')).response.id, 'from-B');
  assert.strictEqual((await A.candidates('bkt', { limit: 10 })).length, 1);
  assert.strictEqual(await A.size(), 1);
  assert.strictEqual((await A.get('same')).key, 'same', 'the namespace prefix never leaks into the entry');
});

test('FALLBACK: store falls back mid-flight when a live client starts erroring', async () => {
  const clock = { ms: 500_000 };
  const fallback = memStore(clock);
  let broken = false;
  const flaky = {
    isOpen: true,
    isReady: true,
    async sendCommand() {
      if (broken) throw new Error('connection reset');
      return null; // GET miss
    }
  };
  const redis = createRedisClient({ client: flaky, metrics: false, now: () => clock.ms });
  const store = createRedisStore({ redis, fallback, now: () => clock.ms });

  assert.strictEqual(await store.get('nope'), null);
  broken = true;
  await store.set('f2', entry('f2', 'b', clock, 60_000)); // write lands in memory
  assert.strictEqual(fallback.size(), 1);
  assert.strictEqual((await store.get('f2')).response.id, 'f2', 'served from memory after the error');
});

/* ========================================================= redis client */

test('a HANGING redis never blocks a request: every component answers from memory', async () => {
  const clock = { ms: 600_000 };
  const hang = { isOpen: true, isReady: true, sendCommand: () => new Promise(() => {}) };
  const redis = createRedisClient({ client: hang, metrics: false, commandTimeoutMs: 25, now: () => clock.ms });

  const store = createRedisStore({ redis, fallback: memStore(clock), now: () => clock.ms });
  const budget = createBudget({ redis, fallback: new Map([['demo', 0.75]]) });
  const rl = createRateLimiter({ redis, now: () => clock.ms, metrics: false });

  const started = Date.now();
  assert.strictEqual(await store.get('anything'), null);
  assert.strictEqual(await budget.get('demo'), 0.75);
  assert.strictEqual((await rl.check('hangs', { rpm: 5, rpd: 5 })).source, 'memory');
  assert.ok(Date.now() - started < 2000, 'time-boxed, not hung');
});

test('the redis-level circuit stops talking to a black hole after K failures', async () => {
  const clock = { ms: 700_000 };
  let calls = 0;
  const blackhole = {
    isOpen: true,
    isReady: true,
    async sendCommand() {
      calls += 1;
      throw new Error('ETIMEDOUT');
    }
  };
  const redis = createRedisClient({
    client: blackhole, metrics: false, now: () => clock.ms, failureThreshold: 3, probeIntervalMs: 5000
  });
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(() => redis.call('test', ['GET', 'x']));
  }
  assert.strictEqual(calls, 3, 'after 3 consecutive failures the circuit opens and no I/O is attempted');
  assert.strictEqual(redis.isDegraded(), true);
  assert.strictEqual(redis.usable(), false);

  clock.ms += 5001; // probe window elapsed
  await assert.rejects(() => redis.call('test', ['GET', 'x']));
  assert.strictEqual(calls, 4, 'exactly one probe per interval');
});

test('quit() is safe on an injected client and leaves no open handles', async () => {
  const clock = { ms: 800_000 };
  const { client } = wrap(makeFake({ clock }), clock);
  await client.quit();
  await assert.rejects(() => client.call('test', ['GET', 'x']), /closed/);
});

test('quit() never hangs when Redis was never reachable (real client, refused port)', async () => {
  // 127.0.0.1:1 refuses at once: the CI situation, where no Redis runs at all.
  // A QUIT queued behind a socket that never opens used to hang app.close().
  const redis = createRedisClient({ url: 'redis://127.0.0.1:1', metrics: false, connectTimeoutMs: 200 });
  await assert.rejects(() => redis.call('test', ['PING']));
  const started = Date.now();
  await redis.quit();
  assert.ok(Date.now() - started < 1000, `quit() took ${Date.now() - started} ms`);
});

test('GGW_REDIS_DISABLED=1: no socket at all, every component answers from memory', async () => {
  process.env.GGW_REDIS_DISABLED = '1';
  let redis;
  try {
    redis = createRedisClient({ metrics: false });
  } finally {
    delete process.env.GGW_REDIS_DISABLED;
  }
  assert.strictEqual(redis.disabled, true);
  assert.strictEqual(redis.usable(), false);
  assert.strictEqual(redis.raw(), null, 'no node-redis client was ever created');
  await assert.rejects(() => redis.call('test', ['PING']), /disabled/);

  const budget = createBudget({ redis, fallback: new Map([['demo', 0.5]]) });
  assert.strictEqual(await budget.get('demo'), 0.5);
  const rl = createRateLimiter({ redis, now: () => 1, metrics: false });
  assert.strictEqual((await rl.check('off', { rpm: 5, rpd: 5 })).source, 'memory');
  await redis.quit();
});

/* ============================================ cache facade on the Redis store */

test('entries keep their Map/Set vector through Redis (the semantic tier needs it)', async () => {
  const clock = { ms: 900_000 };
  const { client } = wrap(makeFake({ clock }), clock);
  const store = createRedisStore({ redis: client, fallback: memStore(clock), now: () => clock.ms });
  const vector = sim.vectorize('How do I reset my password?');
  await store.set('v1', { ...entry('v1', 'bv', clock, 60_000), vector });

  const got = await store.get('v1');
  assert.ok(got.vector.tf instanceof Map, 'plain JSON would turn tf into {}');
  assert.ok(got.vector.numbers instanceof Set);
  assert.deepStrictEqual([...got.vector.tf], [...vector.tf]);
  const [cand] = await store.candidates('bv', { limit: 5 });
  assert.ok(cand.vector.tf instanceof Map);
  assert.ok(sim.score(vector, cand.vector) > 0.999);
});

test('the cache facade on the Redis store: exact AND semantic hits survive a restart', async () => {
  const clock = { ms: 950_000 };
  const fake = makeFake({ clock });
  const now = () => clock.ms;
  // A fresh createCache() is what a restarted gateway has: no shards, empty IDF.
  const boot = () => createCache({
    now,
    store: createRedisStore({ redis: wrap(fake, clock).client, fallback: memStore(clock), now }),
  });
  const MODEL = 'z-ai/glm-5.2:free';
  const d = (content) => ({
    tenantId: 'treetracker-admin',
    model: MODEL,
    body: { model: MODEL, messages: [{ role: 'user', content }] },
  });
  const body = {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Use the reset link.' } }],
  };

  const first = boot();
  assert.strictEqual((await first.lookup(d('How do I reset my password?'))).hit, false);
  const put = await first.store(d('How do I reset my password?'), { status: 200, body }, { model: MODEL });
  assert.strictEqual(put.stored, true);
  assert.strictEqual(first.size(), 1, 'ggw_cache_entries reads the shared store, not a constant 0');

  const restarted = boot();
  const exact = await restarted.lookup(d('How do I reset my password?'));
  assert.strictEqual(exact.tier, 'exact');
  assert.strictEqual(restarted.size(), 1, 'a restarted replica reports what is already in Redis');
  assert.strictEqual(exact.entry.body.choices[0].message.content, 'Use the reset link.');
  const near = await restarted.lookup(d('how can i reset my password'));
  assert.strictEqual(near.tier, 'semantic', 'the vector survived the JSON round-trip');
  assert.strictEqual(fake.exec(['ZCARD', 'ggw:cache:treetracker-admin:idx']), 1, 'namespaced per tenant');
});

/* ======================================================= end-to-end (HTTP) */

test('end-to-end: the local limiter answers 429 BEFORE any upstream call', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http = require('node:http');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggw-rl-'));
  const file = path.join(dir, 'tenants.yaml');
  fs.writeFileSync(file, [
    'tenants:',
    '  rl-demo:',
    '    key: gg_test_ratelimit',
    '    budget_usd: 1',
    '    allow_models: [mock/model-a:free]',
    '    cache: { enabled: false }',
    '    limits: { rpm: 1, rpd: 50 }',
    '',
  ].join('\n'));

  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.25 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const env = {
    GGW_TENANTS_FILE: file,
    GGW_REDIS_DISABLED: '1',
    OPENROUTER_BASE: `http://127.0.0.1:${upstream.address().port}`,
    OPENROUTER_API_KEY: 'sk-mock',
    LOG_LEVEL: 'silent',
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }

  const { build } = require('../src/server');
  const app = build();
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ask = (content) => app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer gg_test_ratelimit', 'content-type': 'application/json' },
    payload: { model: 'mock/model-a:free', messages: [{ role: 'user', content }] },
  });

  const ok = await ask('first question');
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.headers['x-ggw-ratelimit-source'], 'memory');
  assert.strictEqual(ok.headers['x-ggw-ratelimit-remaining-rpm'], '0');
  assert.strictEqual(ok.headers['x-ggw-tenant-spend-usd'], '0.250000', 'charged once, from usage.cost');
  assert.strictEqual(upstreamCalls, 1);

  const limited = await ask('a different question');
  assert.strictEqual(limited.statusCode, 429);
  assert.strictEqual(JSON.parse(limited.body).error.type, 'ggw_rate_limited');
  assert.match(limited.headers['retry-after'], /^\d{1,2}$/, 'Retry-After is SECONDS, not ms');
  assert.strictEqual(limited.headers['x-ggw-ratelimit-window'], 'rpm');
  assert.strictEqual(upstreamCalls, 1, 'the throttled request never reached OpenRouter');
  assert.strictEqual(limited.headers['x-ggw-tenant-spend-usd'], undefined, 'no budget charge on a local 429');
});

