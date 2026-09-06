'use strict';

/**
 * src/cache/store.js — GreenGateway Phase 3 in-memory cache store.
 *
 * Zero dependencies. One process, one Map. This matches Phases 1-2, where the
 * budget ledger (`spend`), the circuit breaker and the health window are all
 * plain in-memory structures. A shared/Redis-backed store is Phase 4.
 *
 * Structure
 *   entries : Map<exactKey, entry>        -- ALSO the LRU order. A JS Map keeps
 *                                            insertion order, so "delete then
 *                                            set" moves a key to the most-recent
 *                                            end and the first key is the LRU
 *                                            victim. O(1), no linked list.
 *   buckets : Map<bucketKey, Set<exactKey>> -- the per-bucket candidate list the
 *                                            semantic tier scans. Sets keep
 *                                            insertion order too, so scans can
 *                                            walk newest-first and stop early.
 *
 * A bucket is tenant + model + paramsHash + conversation-prefix hash (built by
 * src/cache/index.js). Nothing is ever compared across buckets, so parameters,
 * models, tenants and multi-turn history can never bleed into one another.
 *
 * TWO BOUNDS, NOT ONE (Phase-3 review fix). Entry COUNT alone does not bound
 * memory: 500 entries x a 200 KB body is 100 MB per tenant. Every entry may
 * carry `bytes` (src/cache/index.js sets it to the serialized body length) and
 * the store evicts LRU-first until BOTH `maxEntries` and `maxBytes` hold.
 *
 * Both limits are mutable via setLimits(): a tenant's `cache:` block is read on
 * every request, so a shard created by an unusual first request must be able to
 * pick up the tenant's real configuration afterwards.
 *
 * Time is injectable: pass `now` (a () => epoch-ms function) so TTL expiry is
 * testable offline without sleeping.
 */

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per store (i.e. per tenant)

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * createStore(opts)
 * @param {object}   [opts]
 * @param {number}   [opts.maxEntries=500]      hard cap; LRU evicted past it
 * @param {number}   [opts.maxBytes=8388608]    hard byte cap over entry.bytes
 * @param {function} [opts.now=Date.now]        injectable clock, returns epoch ms
 * @param {function} [opts.onEvict]             (entry, reason) for bookkeeping.
 *                   reason: 'lru' | 'bytes' | 'expired' | 'replaced' | 'deleted' | 'clear'
 */
function createStore(opts) {
  const o = opts || {};
  let maxEntries = positiveInt(Number(o.maxEntries), DEFAULT_MAX_ENTRIES);
  let maxBytes = positiveInt(Number(o.maxBytes), DEFAULT_MAX_BYTES);
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const onEvict = typeof o.onEvict === 'function' ? o.onEvict : null;

  const entries = new Map();
  const buckets = new Map();
  let totalBytes = 0;

  const stats = { puts: 0, hits: 0, misses: 0, evictions: 0, expirations: 0 };

  function unlink(key, entry, reason) {
    entries.delete(key);
    totalBytes -= Number(entry.bytes) || 0;
    if (totalBytes < 0) totalBytes = 0;
    const set = buckets.get(entry.bucketKey);
    if (set) {
      set.delete(key);
      if (set.size === 0) buckets.delete(entry.bucketKey);
    }
    if (onEvict) onEvict(entry, reason);
  }

  function isExpired(entry, t) {
    return entry.expiresAt !== 0 && entry.expiresAt <= t;
  }

  function evictIfNeeded() {
    while (entries.size > 0 && (entries.size > maxEntries || totalBytes > maxBytes)) {
      const reason = entries.size > maxEntries ? 'lru' : 'bytes';
      const victimKey = entries.keys().next().value;
      if (victimKey === undefined) break;
      const victim = entries.get(victimKey);
      stats.evictions += 1;
      unlink(victimKey, victim, reason);
    }
  }

  return {
    /**
     * put(entry) -> entry
     * `entry` must carry at least { key, bucketKey } and is stored by reference.
     * src/cache/index.js sets: key, bucketKey, tenantId, model, paramsHash,
     * probe, vector, body, meta, bytes, createdAt, expiresAt, hits.
     * Replacing an existing key refreshes recency and fires onEvict(old,'replaced').
     */
    put(entry) {
      if (!entry || !entry.key || !entry.bucketKey) {
        throw new TypeError('[ggw-cache] store.put requires { key, bucketKey }');
      }
      const t = now();
      if (typeof entry.createdAt !== 'number') entry.createdAt = t;
      if (typeof entry.expiresAt !== 'number') entry.expiresAt = 0; // 0 = never
      if (typeof entry.hits !== 'number') entry.hits = 0;
      if (typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes)) entry.bytes = 0;

      const prev = entries.get(entry.key);
      if (prev) unlink(entry.key, prev, 'replaced');

      entries.set(entry.key, entry);
      totalBytes += entry.bytes;
      let set = buckets.get(entry.bucketKey);
      if (!set) { set = new Set(); buckets.set(entry.bucketKey, set); }
      set.add(entry.key);

      stats.puts += 1;
      evictIfNeeded();
      return entry;
    },

    /**
     * get(key) -> entry | null
     * Exact-key lookup. Expired entries are dropped (onEvict 'expired') and
     * reported as a miss. A hit refreshes LRU recency and bumps entry.hits.
     */
    get(key) {
      const entry = entries.get(key);
      if (!entry) { stats.misses += 1; return null; }
      const t = now();
      if (isExpired(entry, t)) {
        stats.expirations += 1;
        unlink(key, entry, 'expired');
        stats.misses += 1;
        return null;
      }
      // Refresh recency: delete + set moves the key to the end of the Map.
      entries.delete(key);
      entries.set(key, entry);
      entry.hits += 1;
      entry.lastHitAt = t;
      stats.hits += 1;
      return entry;
    },

    /**
     * peek(key) -> entry | null
     * Like get() but does NOT touch recency, hit counters or stats. For tests
     * and for the semantic tier, which must not distort LRU while scanning.
     */
    peek(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (isExpired(entry, now())) return null;
      return entry;
    },

    /**
     * listBucket(bucketKey, limit?) -> entry[]
     * Live (non-expired) entries in one bucket, NEWEST FIRST, capped at `limit`.
     * Expired entries encountered here are pruned on the way past.
     */
    listBucket(bucketKey, limit) {
      const set = buckets.get(bucketKey);
      if (!set) return [];
      const t = now();
      const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
      const out = [];
      const keys = Array.from(set);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i];
        const entry = entries.get(key);
        if (!entry) { set.delete(key); continue; }
        if (isExpired(entry, t)) {
          stats.expirations += 1;
          unlink(key, entry, 'expired');
          continue;
        }
        out.push(entry);
        if (out.length >= cap) break;
      }
      if (set.size === 0) buckets.delete(bucketKey);
      return out;
    },

    /** touch(entry) — mark an entry as most-recently-used after a semantic hit. */
    touch(entry) {
      if (!entry || !entries.has(entry.key)) return;
      entries.delete(entry.key);
      entries.set(entry.key, entry);
      entry.hits += 1;
      entry.lastHitAt = now();
      stats.hits += 1;
    },

    /** delete(key) -> boolean */
    delete(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      unlink(key, entry, 'deleted');
      return true;
    },

    /** prune() -> number of entries dropped because their TTL had passed. */
    prune() {
      const t = now();
      let dropped = 0;
      for (const [key, entry] of Array.from(entries)) {
        if (isExpired(entry, t)) {
          stats.expirations += 1;
          unlink(key, entry, 'expired');
          dropped += 1;
        }
      }
      return dropped;
    },

    /** clear() -> number of entries removed. */
    clear() {
      const n = entries.size;
      for (const [key, entry] of Array.from(entries)) unlink(key, entry, 'clear');
      entries.clear();
      buckets.clear();
      totalBytes = 0;
      return n;
    },

    /**
     * setLimits({ maxEntries, maxBytes }) — apply a tenant's current config to a
     * shard that was created earlier (possibly by an atypical first request) and
     * evict immediately if the new bounds are tighter. Invalid/absent values are
     * ignored, so a partial object is safe.
     */
    setLimits(next) {
      const n = next || {};
      const e = positiveInt(Number(n.maxEntries), 0);
      const b = positiveInt(Number(n.maxBytes), 0);
      let changed = false;
      if (e && e !== maxEntries) { maxEntries = e; changed = true; }
      if (b && b !== maxBytes) { maxBytes = b; changed = true; }
      if (changed) evictIfNeeded();
      return changed;
    },

    /** size() -> entry count (expired-but-not-yet-pruned entries included). */
    size() { return entries.size; },

    /** bytes() -> summed entry.bytes currently held. */
    bytes() { return totalBytes; },

    /** bucketCount() -> number of distinct buckets currently held. */
    bucketCount() { return buckets.size; },

    /** maxEntries / maxBytes — the configured hard caps (read-only view). */
    get maxEntries() { return maxEntries; },
    get maxBytes() { return maxBytes; },

    /** stats() -> a copy of the counters (diagnostics only; Prometheus lives in metrics.js). */
    stats() {
      return Object.assign(
        { size: entries.size, buckets: buckets.size, bytes: totalBytes, maxEntries, maxBytes },
        stats
      );
    },

    /** keys() -> exact keys in LRU order (oldest first). Tests use this. */
    keys() { return Array.from(entries.keys()); },
  };
}

module.exports = { createStore, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES };
