'use strict';
// Per-model health: EWMA latency + rolling error/429 rate + a small latency
// ring buffer for a p95-ish estimate. Pure in-memory, no network.

function createHealth(opts = {}) {
  const alpha = opts.alpha ?? 0.3;        // EWMA smoothing
  const maxSamples = opts.maxSamples ?? 50; // ring buffer size for p95ish
  const map = new Map(); // model -> slot

  function slot(m) {
    let s = map.get(m);
    if (!s) {
      s = { ewmaMs: 0, errEwma: 0, lat: [], n: 0 };
      map.set(m, s);
    }
    return s;
  }

  return {
    // record(model, { ok, ms, status })
    record(model, obs = {}) {
      const { ok, ms, status } = obs;
      const s = slot(model);

      const failed =
        ok === false ||
        (typeof status === 'number' && (status === 429 || status === 408 || status >= 500));

      s.errEwma = alpha * (failed ? 1 : 0) + (1 - alpha) * s.errEwma;

      if (typeof ms === 'number' && Number.isFinite(ms)) {
        s.ewmaMs = s.n === 0 ? ms : alpha * ms + (1 - alpha) * s.ewmaMs;
        s.lat.push(ms);
        if (s.lat.length > maxSamples) s.lat.shift();
      }
      s.n += 1;
    },

    // snapshot(model) -> { p95ish, errRate, samples }
    snapshot(model) {
      const s = map.get(model);
      if (!s || s.n === 0) return { p95ish: 0, errRate: 0, samples: 0 };

      let p95 = s.ewmaMs;
      if (s.lat.length) {
        const sorted = [...s.lat].sort((a, b) => a - b);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1));
        p95 = sorted[idx];
      }
      return {
        p95ish: Math.round(p95),
        errRate: Number(s.errEwma.toFixed(4)),
        samples: s.n,
      };
    },
  };
}

module.exports = { createHealth };
