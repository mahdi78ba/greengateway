'use strict';
// Per-model circuit breaker (CLOSED / OPEN / HALF_OPEN) over an in-memory Map.
// Keyed by model slug (e.g. "z-ai/glm-5.2:free"). Per-MODEL is the correct
// granularity for OpenRouter free tier: rate limits + single free endpoint are
// both model-scoped, so per-provider breaking is a no-op on :free variants.
//
// This breaker is a PROCESS-GLOBAL singleton with FIXED thresholds (see the
// defaults below). Model health is a property of the shared free pool, not of
// any one tenant, so thresholds are intentionally NOT tenant-tunable.

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

function createBreaker(opts = {}) {
  const cfg = {
    rollingWindowMs: opts.rollingWindowMs ?? 60_000,   // window for the rolling failure count
    failureThreshold: opts.failureThreshold ?? 5,      // trip if >= N failures inside the window
    consecutiveThreshold: opts.consecutiveThreshold ?? 3, // trip on N consecutive 429/5xx/timeout
    baseCooldownMs: opts.baseCooldownMs ?? 1_000,      // exponential-backoff base
    maxCooldownMs: opts.maxCooldownMs ?? 5 * 60_000,   // cap ~5 min
    probeTtlMs: opts.probeTtlMs ?? 30_000,             // reclaim an abandoned HALF_OPEN probe
    now: opts.now ?? (() => Date.now()),               // injectable clock (tests)
    onTransition: opts.onTransition ?? (() => {}),     // (model, toState) -> void
  };

  const map = new Map(); // model -> slot

  function slot(model) {
    let s = map.get(model);
    if (!s) {
      s = {
        status: STATES.CLOSED, fails: [], consecutive: 0,
        openedAt: 0, cooldownMs: 0, backoff: 0,
        probing: false, probeStartedAt: 0,
      };
      map.set(model, s);
    }
    return s;
  }

  function transition(model, s, to) {
    if (s.status === to) return;
    s.status = to;
    cfg.onTransition(model, to);
  }

  // Lazy OPEN -> HALF_OPEN once the cooldown has elapsed (allows exactly one probe).
  function refresh(model) {
    const s = slot(model);
    if (s.status === STATES.OPEN && cfg.now() >= s.openedAt + s.cooldownMs) {
      s.probing = false;         // fresh HALF_OPEN window -> a new probe may be admitted
      s.probeStartedAt = 0;
      transition(model, s, STATES.HALF_OPEN);
    }
    return s;
  }

  function prune(s) {
    const cutoff = cfg.now() - cfg.rollingWindowMs;
    while (s.fails.length && s.fails[0] < cutoff) s.fails.shift();
  }

  return {
    state(model) {
      // Read-only: never reserves a probe (so metrics/tests can observe HALF_OPEN).
      return refresh(model).status;
    },

    isOpen(model) {
      const s = refresh(model);
      if (s.status === STATES.OPEN) return true;
      if (s.status === STATES.HALF_OPEN) {
        // Admit EXACTLY ONE probe. A second caller (concurrency) sees the model as
        // open until the probe records its result. Reclaim a probe that was handed
        // out but abandoned (e.g. scored yet never attempted) after a TTL.
        if (s.probing) {
          if (cfg.now() - s.probeStartedAt >= cfg.probeTtlMs) {
            s.probing = false; // stale reservation reclaimed
          } else {
            return true;       // probe already in flight -> treat as open for everyone else
          }
        }
        s.probing = true;
        s.probeStartedAt = cfg.now();
        return false;          // this caller owns the single probe
      }
      return false;
    },

    // Remaining cooldown (ms) if OPEN, else 0. Used to set Retry-After when
    // every candidate is cooling down.
    cooldownRemainingMs(model) {
      const s = refresh(model);
      if (s.status !== STATES.OPEN) return 0;
      return Math.max(0, (s.openedAt + s.cooldownMs) - cfg.now());
    },

    recordSuccess(model) {
      const s = refresh(model);
      s.consecutive = 0;
      s.probing = false;
      if (s.status === STATES.HALF_OPEN || s.status === STATES.OPEN) {
        s.fails = [];
        s.backoff = 0;
        s.cooldownMs = 0;
        transition(model, s, STATES.CLOSED); // probe succeeded -> recover
      }
    },

    // info: { status, retryAfterMs }  (retryAfterMs from Retry-After / X-RateLimit-Reset)
    recordFailure(model, info = {}) {
      const s = refresh(model);
      const now = cfg.now();
      s.probing = false; // this attempt was the probe (if HALF_OPEN); it failed
      s.fails.push(now);
      prune(s);
      s.consecutive += 1;

      if (s.status === STATES.OPEN) return; // already cooling, nothing to do

      const wasHalf = s.status === STATES.HALF_OPEN;
      const tripByRolling = s.fails.length >= cfg.failureThreshold;
      const tripByStreak = s.consecutive >= cfg.consecutiveThreshold;

      if (wasHalf || tripByRolling || tripByStreak) {
        let cd;
        if (info.retryAfterMs != null && Number.isFinite(info.retryAfterMs)) {
          // Honor upstream signal (Retry-After / X-RateLimit-Reset) when present.
          cd = Math.min(Math.max(info.retryAfterMs, 0), cfg.maxCooldownMs);
        } else {
          // Otherwise exponential backoff, capped.
          cd = Math.min(cfg.baseCooldownMs * Math.pow(2, s.backoff), cfg.maxCooldownMs);
          s.backoff += 1;
        }
        s.openedAt = now;
        s.cooldownMs = cd;
        transition(model, s, STATES.OPEN);
      }
    },
  };
}

module.exports = { createBreaker, STATES };
