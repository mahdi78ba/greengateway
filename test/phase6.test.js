'use strict';
// Phase 6: readiness vs liveness. Hermetic: no Redis, no limiter, no upstream.
process.env.GGW_REDIS_DISABLED = '1';
process.env.GGW_RATELIMIT_DISABLED = '1';

const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../src/server');

test('readiness answers 200 while serving and 503 once draining; liveness stays 200', async () => {
  const app = build();
  try {
    let res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.json(), { ready: true });

    app.ggwState.ready = false; // what the SIGTERM handler does first
    res = await app.inject({ method: 'GET', url: '/readyz' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.json().ready, false);

    res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.strictEqual(res.statusCode, 200, 'draining is not a reason to restart the pod');
  } finally {
    await app.close();
  }
});

test('a draining pod still serves the requests it already accepted', async () => {
  const app = build();
  try {
    app.ggwState.ready = false;
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    assert.strictEqual(res.statusCode, 200);
  } finally {
    await app.close();
  }
});
