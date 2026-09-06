'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { createBreaker } = require('../src/routing/breaker');
const { createHealth } = require('../src/routing/health');
const { orderCandidates } = require('../src/routing/scorer');

test('breaker trips OPEN after consecutive-failure threshold', () => {
  const br = createBreaker({ consecutiveThreshold: 3, baseCooldownMs: 1000 });
  const m = 'z-ai/glm-5.2:free';

  assert.strictEqual(br.state(m), 'CLOSED');
  br.recordFailure(m, { status: 429 });
  br.recordFailure(m, { status: 429 });
  assert.strictEqual(br.isOpen(m), false); // 2 < threshold
  br.recordFailure(m, { status: 429 });
  assert.strictEqual(br.state(m), 'OPEN');
  assert.strictEqual(br.isOpen(m), true);
});

test('breaker recovers via HALF_OPEN -> CLOSED on a successful probe', () => {
  let clock = 0;
  const br = createBreaker({ consecutiveThreshold: 3, baseCooldownMs: 1000, now: () => clock });
  const m = 'google/gemma-4-31b-it:free';

  br.recordFailure(m, { status: 500 });
  br.recordFailure(m, { status: 500 });
  br.recordFailure(m, { status: 500 });
  assert.strictEqual(br.state(m), 'OPEN');

  clock += 1500; // past the 1000ms cooldown
  assert.strictEqual(br.state(m), 'HALF_OPEN'); // one probe allowed
  assert.strictEqual(br.isOpen(m), false);

  br.recordSuccess(m); // probe succeeds
  assert.strictEqual(br.state(m), 'CLOSED');
});

test('breaker admits exactly one HALF_OPEN probe under concurrency', () => {
  let clock = 0;
  const br = createBreaker({ consecutiveThreshold: 1, baseCooldownMs: 1000, now: () => clock });
  const m = 'z-ai/glm-5.2:free';

  br.recordFailure(m, { status: 500 });
  assert.strictEqual(br.state(m), 'OPEN');
  clock += 1500; // enter HALF_OPEN window
  assert.strictEqual(br.isOpen(m), false); // first caller wins the single probe
  assert.strictEqual(br.isOpen(m), true);  // second concurrent caller is blocked
});

test('breaker honors Retry-After for the OPEN cooldown', () => {
  let clock = 0;
  const br = createBreaker({ consecutiveThreshold: 1, now: () => clock });
  const m = 'z-ai/glm-5.2:free';

  br.recordFailure(m, { status: 429, retryAfterMs: 5000 });
  assert.strictEqual(br.state(m), 'OPEN');
  clock += 4000;
  assert.strictEqual(br.state(m), 'OPEN');      // still cooling
  clock += 2000;                                 // total 6000 > 5000
  assert.strictEqual(br.state(m), 'HALF_OPEN');
});

test('breaker reports remaining cooldown for Retry-After', () => {
  let clock = 0;
  const br = createBreaker({ consecutiveThreshold: 1, now: () => clock });
  const m = 'z-ai/glm-5.2:free';
  br.recordFailure(m, { status: 429, retryAfterMs: 5000 });
  assert.strictEqual(br.cooldownRemainingMs(m), 5000);
  clock += 2000;
  assert.strictEqual(br.cooldownRemainingMs(m), 3000);
});

test('scorer excludes OPEN-breaker models and orders healthiest-first', () => {
  const health = createHealth();
  const breaker = createBreaker({ consecutiveThreshold: 3 });

  const A = 'z-ai/glm-5.2:free';        // healthy, fast
  const B = 'google/gemma-4-31b-it:free'; // higher error rate
  const C = 'some/broken:free';         // breaker OPEN

  for (let i = 0; i < 5; i++) health.record(A, { ok: true, ms: 100, status: 200 });
  for (let i = 0; i < 3; i++) health.record(B, { ok: false, ms: 400, status: 429 });
  for (let i = 0; i < 2; i++) health.record(B, { ok: true, ms: 400, status: 200 });

  breaker.recordFailure(C, { status: 429 });
  breaker.recordFailure(C, { status: 429 });
  breaker.recordFailure(C, { status: 429 });
  assert.strictEqual(breaker.isOpen(C), true);

  const ordered = orderCandidates([A, B, C], { health, breaker });
  assert.deepStrictEqual(ordered, [A, B]); // C excluded, A (lower errRate) first
});

test('scorer keeps cold models (optimistic prior) so they get tried', () => {
  const health = createHealth();
  const breaker = createBreaker();
  const A = 'a/model:free'; // cold (no samples)
  const B = 'b/model:free'; // cold
  const ordered = orderCandidates([A, B], { health, breaker });
  assert.deepStrictEqual(ordered, [A, B]); // stable order, requested-first preserved
});
