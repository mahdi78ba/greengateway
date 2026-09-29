'use strict';
/* Phase 5 — observability.
 * Offline: in-memory state (GGW_REDIS_DISABLED=1) and the repo's own mock
 * upstream (tools/mock-openrouter.js) on 127.0.0.1:<random port>. The limiter
 * stays ON in this file, because "throttled" is one of the outcomes under test. */

process.env.GGW_REDIS_DISABLED = '1';
delete process.env.GGW_RATELIMIT_DISABLED;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../src/metrics');
const { requestId, defaultOutcome, upstreamHost } = require('../src/observability');
const { createMockOpenRouter } = require('../tools/mock-openrouter');
const { createAlertSink, describe: describeAlert } = require('../tools/alert-sink');

const A = 'mock/model-a:free';
const B = 'mock/model-b:free';
const C = 'mock/model-c:free';
const D = 'mock/model-d:free';

const TENANTS = [
  'tenants:',
  '  obs:',
  '    key: gg_test_obs',
  '    budget_usd: 1',
  `    allow_models: [${A}, ${B}]`,
  `    fallbacks: [${B}]`,
  '    limits: { rpm: 1000, rpd: 100000 }',
  '  tight:',
  '    key: gg_test_tight',
  '    budget_usd: 1',
  `    allow_models: [${A}]`,
  '    cache: { enabled: false }',
  '    limits: { rpm: 1, rpd: 100 }',
  '  brk:',
  '    key: gg_test_brk',
  '    budget_usd: 1',
  `    allow_models: [${C}, ${D}]`,
  `    fallbacks: [${D}]`,
  '    cache: { enabled: false }',
  '    limits: { rpm: 1000, rpd: 100000 }',
  '',
].join('\n');

let mock;
let app;
let dir;
const saved = {};

before(async () => {
  mock = createMockOpenRouter({ quiet: true, env: {} });
  await mock.listen(0, '127.0.0.1');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggw-p5-'));
  fs.writeFileSync(path.join(dir, 'tenants.yaml'), TENANTS);
  const env = {
    GGW_TENANTS_FILE: path.join(dir, 'tenants.yaml'),
    OPENROUTER_BASE: mock.url,
    OPENROUTER_API_KEY: 'sk-mock',
    LOG_LEVEL: 'silent',
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { build } = require('../src/server');
  app = build();
  await app.ready();
});

after(async () => {
  await app.close();
  await mock.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function chat(key, model, content, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      ...headers,
    },
    payload: { model, messages: [{ role: 'user', content }] },
  });
}

/** Sum of every series of `metric` whose labels include all of `labels`. */
async function count(metric, labels) {
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
    .reduce((n, v) => n + v.value, 0);
}

const edge = (outcome, tenant) => ({ route: '/v1/chat/completions', outcome, tenant });

/* ================================================================ edge metric */

test('edge metric: one sample per response, classified by outcome', async () => {
  const cases = {
    auth: edge('rejected_auth', 'none'),
    policy: edge('rejected_policy', 'obs'),
    served: edge('served', 'obs'),
    hit: edge('cache_hit', 'obs'),
    tightServed: edge('served', 'tight'),
    throttled: edge('throttled', 'tight'),
  };
  const before0 = {};
  for (const [name, labels] of Object.entries(cases)) before0[name] = await count(M.httpRequests, labels);

  assert.equal((await chat(null, A, 'no key at all')).statusCode, 401);
  assert.equal((await chat('gg_test_obs', 'openai/o1', 'a model that is not allowed')).statusCode, 403);
  assert.equal((await chat('gg_test_obs', A, 'What is observability?')).statusCode, 200);
  const again = await chat('gg_test_obs', A, 'What is observability?');
  assert.equal(again.headers['x-ggw-cache'], 'hit-exact');
  assert.equal((await chat('gg_test_tight', A, 'first question 1')).statusCode, 200);
  assert.equal((await chat('gg_test_tight', A, 'second question 2')).statusCode, 429);

  for (const [name, labels] of Object.entries(cases)) {
    assert.equal(await count(M.httpRequests, labels) - before0[name], 1, `${name}: exactly one sample`);
  }

  const text = await M.register.metrics();
  assert.match(text, /^ggw_http_request_duration_seconds_count\{route="\/v1\/chat\/completions",outcome="served"\} \d+$/m);
});

test('a failover is ONE request at the edge but TWO upstream attempts', async () => {
  mock.setFaults({ failModels: [A] });
  try {
    const served0 = await count(M.httpRequests, edge('served', 'obs'));
    const a429 = await count(M.requests, { tenant: 'obs', model: A, status: '429' });
    const b200 = await count(M.requests, { tenant: 'obs', model: B, status: '200' });

    const res = await chat('gg_test_obs', A, 'Which model will answer this one?');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-ggw-model'], B);
    assert.equal(res.headers['x-ggw-attempts'], '2');

    assert.equal(await count(M.httpRequests, edge('served', 'obs')) - served0, 1,
      'the client sent ONE request, and it succeeded');
    assert.equal(await count(M.requests, { tenant: 'obs', model: A, status: '429' }) - a429, 1,
      'ggw_requests_total saw attempt 1 (a 429)…');
    assert.equal(await count(M.requests, { tenant: 'obs', model: B, status: '200' }) - b200, 1,
      '…and attempt 2 (a 200): an error ratio built on it would say 50%');
  } finally {
    mock.reset();
  }
});

test('breaker and model gauges are computed at scrape time', async () => {
  mock.setFaults({ failModels: [C, D] });
  try {
    const opened0 = await count(M.breakerTransitions, { model: C, to: 'OPEN' });
    const exhausted0 = await count(M.httpRequests, edge('upstream_exhausted', 'brk'));
    const unavailable0 = await count(M.httpRequests, edge('unavailable', 'brk'));

    for (let i = 1; i <= 3; i += 1) {
      assert.equal((await chat('gg_test_brk', C, `breaker question ${i}`)).statusCode, 429,
        'every candidate refused');
    }
    assert.equal(await count(M.httpRequests, edge('upstream_exhausted', 'brk')) - exhausted0, 3);

    const text = await M.register.metrics();
    assert.match(text, /^ggw_breaker_state\{model="mock\/model-c:free"\} 2$/m);
    assert.match(text, /^ggw_breaker_state\{model="mock\/model-d:free"\} 2$/m);
    assert.match(text, /^ggw_breaker_state\{model="mock\/model-a:free"\} 0$/m,
      'every routable model has a series, not only the ones that failed');
    assert.equal(await count(M.breakerTransitions, { model: C, to: 'OPEN' }) - opened0, 1);
    const errRate = Number(text.match(/^ggw_model_error_rate\{model="mock\/model-c:free"\} (\S+)$/m)[1]);
    assert.ok(errRate > 0.5, `error rate should be high after 3 failures, got ${errRate}`);

    assert.equal((await chat('gg_test_brk', C, 'breaker question 4')).statusCode, 503);
    assert.equal(await count(M.httpRequests, edge('unavailable', 'brk')) - unavailable0, 1);
  } finally {
    mock.reset();
  }
});

test('unknown URLs are counted as route="unmatched", never by their raw path', async () => {
  const res = await app.inject({ method: 'GET', url: '/wp-login.php?user=admin' });
  assert.equal(res.statusCode, 404);
  const text = await M.register.metrics();
  assert.ok(!text.includes('wp-login'), 'a raw URL must never become a label');
  assert.ok(await count(M.httpRequests, { route: 'unmatched', outcome: 'not_found' }) >= 1);
});

/* ============================================================== correlation */

test('x-request-id: minted when absent, echoed when sane, replaced when not', async () => {
  const minted = await app.inject({ method: 'GET', url: '/healthz' });
  assert.match(minted.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const echoed = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'demo-123.abc_X' } });
  assert.equal(echoed.headers['x-request-id'], 'demo-123.abc_X');

  const replaced = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'bad id; drop table' } });
  assert.notEqual(replaced.headers['x-request-id'], 'bad id; drop table');
  assert.match(replaced.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('build info and Node.js runtime metrics are exposed', async () => {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  const pkg = require('../package.json');
  const host = new URL(mock.url).host;
  assert.ok(res.body.includes(`ggw_build_info{version="${pkg.version}",node="${process.version}",upstream="${host}"} 1`),
    'version, runtime and upstream host of this replica');
  assert.match(res.body, /^process_resident_memory_bytes \d+/m);
  assert.match(res.body, /^nodejs_eventloop_lag_p99_seconds \S+$/m);
});

test('helpers: default outcomes, request ids, upstream host', () => {
  assert.equal(defaultOutcome(200), 'ok');
  assert.equal(defaultOutcome(400), 'rejected_client');
  assert.equal(defaultOutcome(401), 'rejected_auth');
  assert.equal(defaultOutcome(404), 'not_found');
  assert.equal(defaultOutcome(500), 'error');
  assert.equal(requestId({ headers: { 'x-request-id': 'ok-1' } }), 'ok-1');
  assert.equal(upstreamHost('https://openrouter.ai/api/v1'), 'openrouter.ai');
  assert.equal(upstreamHost('http://mock-openrouter:8099'), 'mock-openrouter:8099');
  assert.equal(upstreamHost('not a url'), 'invalid');
});

/* ==================================================================== tools */

test('mock upstream: faults change at runtime through its admin API', async () => {
  const post = (p, body) => fetch(`${mock.url}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ask = { model: A, messages: [{ role: 'user', content: 'hi' }] };

  const set = await post('/__admin/faults', { errorRate: 1, errorStatus: 503 });
  assert.equal((await set.json()).faults.errorStatus, 503);
  assert.equal((await post('/chat/completions', ask)).status, 503);

  await post('/__admin/reset', {});
  const ok = await post('/chat/completions', ask);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).choices[0].finish_reason, 'stop');
});

test('alert sink: records and describes Alertmanager notifications', async () => {
  const sink = createAlertSink({ quiet: true });
  await sink.listen(0, '127.0.0.1');
  try {
    const alert = {
      status: 'firing',
      labels: { alertname: 'RedisDegraded', severity: 'warning', replica: 'gateway' },
      annotations: { summary: 'Replica gateway lost Redis' },
      startsAt: '2026-01-01T00:00:00Z',
    };
    const res = await fetch(`${sink.url}/alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '4', status: 'firing', alerts: [alert] }),
    });
    assert.equal(res.status, 200);
    const received = await (await fetch(sink.url)).json();
    assert.equal(received[0].alertname, 'RedisDegraded');
    assert.equal(received[0].status, 'firing');
    assert.equal(describeAlert(alert, 'firing'),
      'FIRING   [warning] RedisDegraded (replica=gateway): Replica gateway lost Redis');
  } finally {
    await sink.close();
  }
});
