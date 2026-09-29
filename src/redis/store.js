'use strict';

/**
 * Redis-backed cache store: a drop-in for src/cache/store.js that SURVIVES
 * RESTARTS and is shared by every replica. Same contract, but async.
 *
 * KEYSPACE (tenant-namespaced — one flat Redis keyspace must not undo the
 * isolation Phase 3 got for free from separate Maps):
 *
 *   ggw:cache:<tenant>:e:<key>      STRING  the JSON entry (PX = its own TTL)
 *   ggw:cache:<tenant>:idx          ZSET    key -> createdAt   (LRU order)
 *   ggw:cache:<tenant>:exp          ZSET    key -> expiresAt   (sweep order)
 *   ggw:cache:<tenant>:b:<bucket>   ZSET    key -> createdAt   (semantic scan)
 *   ggw:cache:<tenant>:meta         HASH    key -> {b,x,s}
 *   ggw:cache:<tenant>:bytes        STRING  integer byte total
 *
 * INDEX HYGIENE (the entry STRING expires by itself, the index members do not):
 *   - sweep(): ZRANGEBYSCORE exp -inf now LIMIT 0 N  -> bounded batch eviction
 *   - candidates()/get(): any MGET/GET returning null is ZREMed, so the scan
 *     never serves tombstones and the bucket ZSET cannot grow without bound
 *   - the bucket ZSETs carry their own PEXPIRE
 *   - size() is ZCARD over the index. NEVER KEYS/DBSIZE.
 *
 * entry.expiresAt === 0 means NEVER EXPIRE (Phase-3 semantics for permanent
 * entries): we then write the STRING with no PX at all. `PEXPIREAT key 0`
 * would delete it instantly.
 *
 * DEGRADED MODE: `fallback` is the real Phase-3 store (src/cache/store.js) and
 * is driven ONLY through its public API: put / get / peek / listBucket /
 * delete / keys. One fallback serves every tenant, so keys and buckets are
 * prefixed with the tenant id on the way in and restored on the way out.
 */

const FAR_FUTURE = 8_640_000_000_000_000; // ~year 275760, safe as a ZSET score
const noop = () => {};

function byteLen(str) {
  return Buffer.byteLength(str, 'utf8');
}

// A cache entry carries the lexical vector, whose `tf` is a Map and whose
// `numbers` / `negations` are Sets. Plain JSON turns all three into {}, and the
// semantic tier then silently never matches an entry read back from Redis.
const MAP_TAG = '__ggw_map__';
const SET_TAG = '__ggw_set__';

function replacer(_key, value) {
  if (value instanceof Map) return { [MAP_TAG]: [...value] };
  if (value instanceof Set) return { [SET_TAG]: [...value] };
  return value;
}

function reviver(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value[MAP_TAG])) return new Map(value[MAP_TAG]);
    if (Array.isArray(value[SET_TAG])) return new Set(value[SET_TAG]);
  }
  return value;
}

const encode = (entry) => JSON.stringify(entry, replacer);
const decode = (raw) => JSON.parse(raw, reviver);

function createRedisStore(opts = {}) {
  const redis = opts.redis || null;
  const fallback = opts.fallback || null;
  const now = opts.now || (() => Date.now());
  const prefix = opts.keyPrefix || 'ggw:cache:';
  const defaultTenant = opts.tenantId || 'default';
  const maxEntries = Number(opts.maxEntries || 500);
  const maxBytes = Number(opts.maxBytes || 8 * 1024 * 1024);
  const maxSemanticCandidates = Number(opts.maxSemanticCandidates || 200);
  const bucketTtlMs = Number(opts.bucketTtlMs || 86_400_000);
  const sweepBatch = Number(opts.sweepBatch || 50);
  const onEvict = opts.onEvict || noop;

  if (!fallback) throw new Error('createRedisStore requires a { fallback } in-memory store');

  /* ------------------------------------------------------------- keys */
  const ns = (tenant) => `${prefix}${tenant}`;
  const kEntry = (tenant, key) => `${ns(tenant)}:e:${key}`;
  const kIdx = (tenant) => `${ns(tenant)}:idx`;
  const kExp = (tenant) => `${ns(tenant)}:exp`;
  const kBucket = (tenant, bucket) => `${ns(tenant)}:b:${bucket}`;
  const kMeta = (tenant) => `${ns(tenant)}:meta`;
  const kBytes = (tenant) => `${ns(tenant)}:bytes`;

  const tenantOf = (ctx) =>
    (ctx && (ctx.tenantId || ctx.tenant)) || defaultTenant;

  function expired(e) {
    // Do not trust the Redis TTL alone: replica clock skew would otherwise
    // serve a stale hit right after the entry logically died.
    return Boolean(e) && Number(e.expiresAt) > 0 && Number(e.expiresAt) <= now();
  }

  const call = (argv) => redis.call('cache', argv);

  /* -------------------------------------------- in-memory fallback path */
  // One injected store serves every tenant, so keys and buckets are prefixed
  // and restored on the way out. Isolation therefore holds in degraded mode too.
  const MEM_SEP = String.fromCharCode(0); // never appears in a cache key
  const memKey = (tenant, key) => `${tenant}${MEM_SEP}${key}`;
  const memTenantKeys = (tenant) => {
    const pfx = `${tenant}${MEM_SEP}`;
    return fallback.keys().filter((k) => String(k).startsWith(pfx));
  };

  function memWrap(tenant, key, e) {
    return Object.assign({}, e, {
      key: memKey(tenant, key),
      bucketKey: memKey(tenant, e.bucketKey || 'default'),
      __k: e.key !== undefined ? e.key : key,
      __b: e.bucketKey
    });
  }

  function memUnwrap(stored) {
    if (!stored) return null;
    const e = Object.assign({}, stored);
    if ('__k' in e) {
      e.key = e.__k;
      delete e.__k;
    }
    if ('__b' in e) {
      e.bucketKey = e.__b;
      delete e.__b;
    }
    return e;
  }

  function memGet(tenant, key) {
    const stored = fallback.get(memKey(tenant, key));
    if (!stored) return null;
    const e = memUnwrap(stored);
    if (expired(e)) {
      if (typeof fallback.delete === 'function') fallback.delete(memKey(tenant, key));
      return null;
    }
    return e;
  }

  function memSet(tenant, key, e) {
    // put() stores by reference and fills in createdAt/expiresAt/hits/bytes
    // defaults, which is why memWrap always hands it a fresh object.
    return fallback.put(memWrap(tenant, key, e));
  }

  function memCandidates(tenant, bucketKey, cap) {
    // listBucket() is already newest-first, capped, and prunes expired entries.
    return fallback
      .listBucket(memKey(tenant, bucketKey), cap)
      .map(memUnwrap)
      .filter((e) => !expired(e));
  }

  function memSize(tenant) {
    return memTenantKeys(tenant).length;
  }

  function memBytes(tenant) {
    let total = 0;
    for (const k of memTenantKeys(tenant)) {
      const e = fallback.peek(k);
      if (e) total += Number(e.bytes) || 0;
    }
    return total;
  }

  function memClear(tenant) {
    // Only this tenant: fallback.clear() would wipe every tenant's entries.
    for (const k of memTenantKeys(tenant)) fallback.delete(k);
  }

  /* ---------------------------------------------------------- eviction */

  // Two evictions of the same key must never both decrement `bytes` (that is
  // how a byte total goes negative). Background evictions are serialised on a
  // chain that size()/stats() can wait for, and in-flight keys are skipped.
  const evicting = new Set();
  let evictChain = Promise.resolve();

  function queueEvict(tenant, keys) {
    evictChain = evictChain.then(() => evictKeys(tenant, keys)).catch(noop);
    return evictChain;
  }

  async function settle() {
    try {
      await evictChain;
    } catch (_err) { /* already swallowed */ }
  }

  async function evictKeys(tenant, keys) {
    const list = [...new Set((keys || []).map(String).filter(Boolean))]
      .filter((k) => !evicting.has(`${tenant}|${k}`));
    if (!list.length) return null;
    list.forEach((k) => evicting.add(`${tenant}|${k}`));
    try {
      return await evictKeysUnguarded(tenant, list);
    } finally {
      list.forEach((k) => evicting.delete(`${tenant}|${k}`));
    }
  }

  async function evictKeysUnguarded(tenant, list) {
    const metas = await call(['HMGET', kMeta(tenant), ...list]);
    const byBucket = new Map();
    let freed = 0;
    list.forEach((k, i) => {
      let meta = null;
      try {
        meta = metas && metas[i] ? JSON.parse(metas[i]) : null;
      } catch (_err) {
        meta = null;
      }
      if (meta) {
        freed += Number(meta.s) || 0;
        const b = meta.b || 'default';
        if (!byBucket.has(b)) byBucket.set(b, []);
        byBucket.get(b).push(k);
      }
      onEvict(k);
    });
    await call(['DEL', ...list.map((k) => kEntry(tenant, k))]);
    await call(['ZREM', kIdx(tenant), ...list]);
    await call(['ZREM', kExp(tenant), ...list]);
    await call(['HDEL', kMeta(tenant), ...list]);
    for (const [b, ks] of byBucket) await call(['ZREM', kBucket(tenant, b), ...ks]);
    // always issue the INCRBY (even by 0) so callers get the live byte total back
    return Number(await call(['INCRBY', kBytes(tenant), String(-freed)]));
  }

  async function sweep(tenant) {
    const dead = await call([
      'ZRANGEBYSCORE', kExp(tenant), '-inf', String(now()), 'LIMIT', '0', String(sweepBatch)
    ]);
    if (Array.isArray(dead) && dead.length) await evictKeys(tenant, dead);
  }

  async function trim(tenant, bytesTotal) {
    const count = Number(await call(['ZCARD', kIdx(tenant)]));
    if (Number.isFinite(count) && count > maxEntries) {
      const oldest = await call(['ZRANGE', kIdx(tenant), '0', String(count - maxEntries - 1)]);
      if (Array.isArray(oldest) && oldest.length) {
        const t = await evictKeys(tenant, oldest);
        if (t !== null) bytesTotal = t;
      }
    }
    let total = Number(bytesTotal);
    let guard = 0;
    // one at a time: dropping a whole batch overshoots and can empty the cache
    while (Number.isFinite(total) && total > maxBytes && guard < 500) {
      guard += 1;
      const oldest = await call(['ZRANGE', kIdx(tenant), '0', '0']);
      if (!Array.isArray(oldest) || !oldest.length) break;
      const t = await evictKeys(tenant, oldest);
      if (t === null) break;
      total = t;
    }
  }

  /* ------------------------------------------------------ public API */

  async function get(key, ctx) {
    const tenant = tenantOf(ctx);
    if (redis) {
      try {
        const raw = await call(['GET', kEntry(tenant, key)]);
        if (raw === null || raw === undefined) {
          // tombstone in the indexes: clean it up, do not serve it
          queueEvict(tenant, [key]);
          return null;
        }
        const e = decode(raw);
        if (expired(e)) {
          queueEvict(tenant, [key]);
          return null;
        }
        return e;
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    return memGet(tenant, key);
  }

  async function set(key, entry, ctx) {
    const tenant = (entry && (entry.tenantId || entry.tenant)) || tenantOf(ctx);
    const e = Object.assign({}, entry, { key: entry.key !== undefined ? entry.key : key });
    const expiresAt = Number(e.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= now()) return false; // already dead
    const bucket = e.bucketKey || 'default';
    const createdAt = Number(e.createdAt) || now();
    const json = encode(e);
    const size = byteLen(json);

    if (redis) {
      try {
        if (expiresAt > 0) {
          await call(['SET', kEntry(tenant, key), json, 'PX', String(expiresAt - now())]);
        } else {
          // 0 === never expire. No PX, and definitely no PEXPIREAT 0.
          await call(['SET', kEntry(tenant, key), json]);
        }
        await call(['HSET', kMeta(tenant), key, JSON.stringify({ b: bucket, x: expiresAt, s: size })]);
        await call(['ZADD', kIdx(tenant), String(createdAt), key]);
        await call(['ZADD', kExp(tenant), String(expiresAt > 0 ? expiresAt : FAR_FUTURE), key]);
        await call(['ZADD', kBucket(tenant, bucket), String(createdAt), key]);
        await call(['PEXPIRE', kBucket(tenant, bucket), String(bucketTtlMs)]);
        const total = Number(await call(['INCRBY', kBytes(tenant), String(size)]));
        await sweep(tenant);
        await trim(tenant, total);
        return true;
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    return Boolean(memSet(tenant, key, e));
  }

  async function candidates(bucketKey, options) {
    const o = options || {};
    const tenant = tenantOf(o);
    const asked = o.limit === undefined || o.limit === null ? maxSemanticCandidates : Number(o.limit);
    // The store cap always wins; a caller asking for less wins over the cap.
    const cap = Math.max(0, Math.min(Number.isFinite(asked) ? asked : maxSemanticCandidates, maxSemanticCandidates));
    if (cap === 0) return [];

    if (redis) {
      try {
        const keys = await call(['ZREVRANGE', kBucket(tenant, bucketKey), '0', String(cap - 1)]);
        const list = Array.isArray(keys) ? keys.map(String) : [];
        if (!list.length) return [];
        const raws = await call(['MGET', ...list.map((k) => kEntry(tenant, k))]);
        const out = [];
        const dead = [];
        list.forEach((k, i) => {
          const raw = raws && raws[i];
          if (raw === null || raw === undefined) {
            dead.push(k);
            return;
          }
          let e = null;
          try {
            e = decode(raw);
          } catch (_err) {
            dead.push(k);
            return;
          }
          if (expired(e)) {
            dead.push(k);
            return;
          }
          out.push(e);
        });
        if (dead.length) queueEvict(tenant, dead);
        return out; // ZREVRANGE already gives newest-first
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    return memCandidates(tenant, bucketKey, cap);
  }

  async function size(ctx) {
    const tenant = tenantOf(ctx);
    await settle();
    if (redis) {
      try {
        await sweep(tenant);
        return Number(await call(['ZCARD', kIdx(tenant)])) || 0;
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    return memSize(tenant);
  }

  async function del(key, ctx) {
    const tenant = tenantOf(ctx);
    if (redis) {
      try {
        await evictKeys(tenant, [key]);
        return true;
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    if (typeof fallback.delete === 'function') return Boolean(fallback.delete(memKey(tenant, key)));
    return false;
  }

  async function clear(ctx) {
    const tenant = tenantOf(ctx);
    if (redis) {
      try {
        for (let i = 0; i < 100; i += 1) {
          const batch = await call(['ZRANGE', kIdx(tenant), '0', String(sweepBatch - 1)]);
          if (!Array.isArray(batch) || !batch.length) break;
          await evictKeys(tenant, batch);
        }
        await call(['DEL', kIdx(tenant), kExp(tenant), kMeta(tenant), kBytes(tenant)]);
        // bucket ZSETs are left to their own PEXPIRE; they are pruned of dead
        // members by candidates() anyway. No KEYS/SCAN sweep is ever issued.
        return true;
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    memClear(tenant);
    return true;
  }

  function backend() {
    return redis && redis.usable() ? 'redis' : 'memory';
  }

  async function stats(ctx) {
    const tenant = tenantOf(ctx);
    await settle();
    if (redis) {
      try {
        const entries = Number(await call(['ZCARD', kIdx(tenant)])) || 0;
        const bytes = Number(await call(['GET', kBytes(tenant)])) || 0;
        return { backend: 'redis', tenant, entries, bytes, maxEntries, maxBytes };
      } catch (_err) {
        /* degraded: fall through */
      }
    }
    return {
      backend: 'memory',
      tenant,
      entries: memSize(tenant),
      bytes: memBytes(tenant),
      maxEntries,
      maxBytes
    };
  }

  return { get, set, candidates, size, delete: del, clear, stats, backend, maxSemanticCandidates };
}

module.exports = { createRedisStore, FAR_FUTURE };

