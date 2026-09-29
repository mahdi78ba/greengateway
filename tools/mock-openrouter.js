#!/usr/bin/env node
'use strict';

/**
 * tools/mock-openrouter.js — a fake OpenRouter for labs, demos and tests.
 * Costs $0 and uses none of the free quota. Faults can be changed WHILE it runs,
 * which is what makes alert demos possible without restarting anything.
 *
 *   POST <any path>          a chat completion, or an injected fault
 *   GET  /healthz            {"ok":true}
 *   GET  /__admin/faults     the current faults and counters
 *   POST /__admin/faults     merge a JSON patch into the faults
 *   POST /__admin/reset      back to the faults it started with
 *
 * Faults (environment at start, or the admin API later):
 *   failModels   MOCK_FAIL_MODELS (or FAIL_MODEL)  models that always answer 429 + Retry-After: 30
 *   errorRate    MOCK_ERROR_RATE    0..1: chance of answering errorStatus instead of 200
 *   errorStatus  MOCK_ERROR_STATUS  default 500
 *   delayMs      MOCK_DELAY_MS      wait this long before answering
 *   cost         MOCK_COST          fake usage.cost in USD (real :free models report 0)
 *
 * Example:
 *   curl -s -X POST localhost:8099/__admin/faults -d '{"errorRate":0.5}'
 */

const http = require('node:http');

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function faultsFromEnv(env) {
  return {
    failModels: list(env.MOCK_FAIL_MODELS || env.FAIL_MODEL),
    errorRate: clamp(num(env.MOCK_ERROR_RATE, 0), 0, 1),
    errorStatus: num(env.MOCK_ERROR_STATUS, 500),
    delayMs: Math.max(0, num(env.MOCK_DELAY_MS, 0)),
    cost: Math.max(0, num(env.MOCK_COST, 0)),
  };
}

/** Merge a patch into `base`, ignoring unknown keys and clamping every value. */
function merge(base, patch) {
  const p = patch || {};
  const out = { ...base };
  if (p.failModels !== undefined) out.failModels = list(p.failModels);
  if (p.errorRate !== undefined) out.errorRate = clamp(num(p.errorRate, base.errorRate), 0, 1);
  if (p.errorStatus !== undefined) out.errorStatus = num(p.errorStatus, base.errorStatus);
  if (p.delayMs !== undefined) out.delayMs = Math.max(0, num(p.delayMs, base.delayMs));
  if (p.cost !== undefined) out.cost = Math.max(0, num(p.cost, base.cost));
  return out;
}

function createMockOpenRouter(opts = {}) {
  const initial = merge(faultsFromEnv(opts.env || process.env), opts.faults);
  let faults = { ...initial };
  const stats = { requests: 0, faulted: 0 };
  const log = opts.quiet ? () => {} : (line) => console.log(line);

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function answer(res, n, body, f) {
    const model = body.model || 'unknown';
    const last = (Array.isArray(body.messages) ? body.messages : []).slice(-1)[0] || {};
    const question = typeof last.content === 'string' ? last.content : '';

    if (f.failModels.includes(model)) {
      stats.faulted += 1;
      log(`UPSTREAM #${n}  ${model}  -> 429 (failModels)`);
      send(res, 429, { error: { message: 'mock: rate limited', code: 429 } }, { 'retry-after': '30' });
      return;
    }
    if (f.errorRate > 0 && Math.random() < f.errorRate) {
      stats.faulted += 1;
      log(`UPSTREAM #${n}  ${model}  -> ${f.errorStatus} (errorRate ${f.errorRate})`);
      send(res, f.errorStatus, { error: { message: `mock: injected ${f.errorStatus}`, code: f.errorStatus } });
      return;
    }
    log(`UPSTREAM #${n}  ${model}  "${question}"${f.delayMs ? `  (+${f.delayMs} ms)` : ''}`);
    send(res, 200, {
      id: `gen-mock-${n}`,
      model,
      provider: 'Mock',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: `Mock answer #${n} to: ${question}` },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 9, cost: f.cost },
    });
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const path = (req.url || '/').split('?')[0];

      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

      if (path === '/__admin/faults') {
        if (req.method === 'POST') {
          let patch;
          try {
            patch = JSON.parse(raw || '{}');
          } catch (_err) {
            return send(res, 400, { error: 'invalid JSON' });
          }
          faults = merge(faults, patch);
          log(`faults -> ${JSON.stringify(faults)}`);
        }
        return send(res, 200, { faults, stats });
      }

      if (req.method === 'POST' && path === '/__admin/reset') {
        faults = { ...initial };
        log(`faults -> reset ${JSON.stringify(faults)}`);
        return send(res, 200, { faults, stats });
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

      stats.requests += 1;
      const n = stats.requests;
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch (_err) { /* keep {} */ }
      const f = faults; // a change through the admin API applies to the NEXT request
      if (f.delayMs > 0) setTimeout(() => answer(res, n, body, f), f.delayMs);
      else answer(res, n, body, f);
      return undefined;
    });
  });

  return {
    server,
    stats,
    get faults() { return faults; },
    setFaults(patch) {
      faults = merge(faults, patch);
      return faults;
    },
    reset() {
      faults = { ...initial };
      return faults;
    },
    get url() {
      const a = server.address();
      if (!a || typeof a === 'string') return null;
      const host = a.address === '0.0.0.0' || a.address === '::' ? '127.0.0.1' : a.address;
      return `http://${host}:${a.port}`;
    },
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(this.url)));
    },
    close() {
      return new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

if (require.main === module) {
  const mock = createMockOpenRouter();
  const port = Number(process.env.MOCK_PORT || 8099);
  const host = process.env.MOCK_HOST || '127.0.0.1';
  mock.listen(port, host).then(() => {
    console.log(`mock OpenRouter on http://${host}:${port}  faults=${JSON.stringify(mock.faults)}`);
  });
}

module.exports = { createMockOpenRouter, faultsFromEnv };
