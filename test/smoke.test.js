'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../src/server');

test('healthz returns ok', async () => {
  const app = build();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.json(), { ok: true });
  await app.close();
});

test('chat without a token is 401', async () => {
  const app = build();
  const res = await app.inject({
    method: 'POST', url: '/v1/chat/completions',
    payload: { model: 'openai/gpt-4o-mini', messages: [] },
  });
  assert.strictEqual(res.statusCode, 401);
  await app.close();
});

test('disallowed model is 403', async () => {
  const app = build();
  const res = await app.inject({
    method: 'POST', url: '/v1/chat/completions',
    headers: { authorization: 'Bearer gg_live_local_dev_key' },
    payload: { model: 'openai/o1', messages: [] },
  });
  assert.strictEqual(res.statusCode, 403);
  await app.close();
});

test('zero-budget tenant is 402 before any spend', async () => {
  const app = build();
  const res = await app.inject({
    method: 'POST', url: '/v1/chat/completions',
    headers: { authorization: 'Bearer gg_live_nobudget' },
    payload: { model: 'z-ai/glm-5.2:free', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.strictEqual(res.statusCode, 402);
  await app.close();
});

test('metrics endpoint exposes counters', async () => {
  const app = build();
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body, /llm_requests_total/);
  await app.close();
});
