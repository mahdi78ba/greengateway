'use strict';
// Pure/testable ranker. Given a candidate model list + health + breaker,
// returns an ORDERED array (healthiest first), excluding OPEN-breaker models.
// Cost weight is ~0 because every candidate is a :free model ($0), so ranking
// is purely availability/health: errRate first, then latency.

const COLD_SAMPLES = 3;      // below this a model is "cold" (unproven)
const OPTIMISTIC_ERR = 0.05; // optimistic prior so cold models get tried
const OPTIMISTIC_MS = 1000;

// orderCandidates(models, { health, breaker }) -> [model, ...]
function orderCandidates(models, deps = {}) {
  const { health, breaker } = deps;

  // de-dup, preserve input order (input[0] = tenant's requested model)
  const seen = new Set();
  const uniq = [];
  for (const m of models || []) {
    if (m && !seen.has(m)) {
      seen.add(m);
      uniq.push(m);
    }
  }

  const scored = uniq
    .filter((m) => !breaker.isOpen(m)) // exclude OPEN breakers (HALF_OPEN admits its single probe)
    .map((m, idx) => {
      const s = health.snapshot(m);
      const cold = s.samples < COLD_SAMPLES;
      return {
        model: m,
        idx, // stable tie-break -> keeps requested model first on a tie
        errRate: cold ? OPTIMISTIC_ERR : s.errRate,
        latency: cold ? OPTIMISTIC_MS : (s.p95ish || OPTIMISTIC_MS),
      };
    });

  scored.sort((a, b) => (a.errRate - b.errRate) || (a.latency - b.latency) || (a.idx - b.idx));
  return scored.map((x) => x.model);
}

module.exports = { orderCandidates, COLD_SAMPLES, OPTIMISTIC_ERR, OPTIMISTIC_MS };
