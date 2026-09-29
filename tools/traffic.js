#!/usr/bin/env node
'use strict';

/**
 * tools/traffic.js — steady demo traffic, so the dashboards and alerts have
 * something to show.
 *
 *   node tools/traffic.js [--rps 2] [--seconds 600] [--repeat 0.6]
 *                         [--url http://localhost:8080] [--key gg_live_loadtest]
 *                         [--model z-ai/glm-5.2:free] [--allow-real-upstream]
 *
 * --repeat is the share of questions drawn from a small fixed pool (they become
 * cache hits); the rest are new, numbered questions (misses: upstream calls).
 *
 * SAFETY: before sending anything it reads ggw_build_info from /metrics and
 * refuses to run against a gateway whose upstream is openrouter.ai, unless you
 * pass --allow-real-upstream. A demo can never burn the real free quota by
 * accident.
 */

const POOL = [
  'How do I reset my password?',
  'What is Greenstand?',
  'How do I plant a tree?',
  'What does the wallet app do?',
  'How are trees verified?',
  'How do I contact support?',
  'Which trees grow fastest?',
  'How is tree data stored?',
];

const USAGE = 'usage: node tools/traffic.js [--rps 2] [--seconds 600] [--repeat 0.6] ' +
  '[--url http://localhost:8080] [--key gg_live_loadtest] [--model z-ai/glm-5.2:free] [--allow-real-upstream]';

function parseArgs(argv) {
  const o = {
    rps: 2,
    seconds: 600,
    repeat: 0.6,
    url: 'http://localhost:8080',
    key: 'gg_live_loadtest',
    model: 'z-ai/glm-5.2:free',
    allowReal: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--rps') o.rps = Number(value());
    else if (arg === '--seconds') o.seconds = Number(value());
    else if (arg === '--repeat') o.repeat = Number(value());
    else if (arg === '--url') o.url = value().replace(/\/+$/, '');
    else if (arg === '--key') o.key = value();
    else if (arg === '--model') o.model = value();
    else if (arg === '--allow-real-upstream') o.allowReal = true;
    else if (arg === '--help' || arg === '-h') o.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!(o.rps > 0) || !(o.seconds > 0) || !(o.repeat >= 0 && o.repeat <= 1)) {
    throw new Error('--rps and --seconds must be > 0, --repeat between 0 and 1');
  }
  return o;
}

async function upstreamOf(url) {
  const res = await fetch(`${url}/metrics`);
  const text = await res.text();
  const m = text.match(/^ggw_build_info\{[^}]*upstream="([^"]*)"/m);
  return m ? m[1] : null;
}

function p95(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

function classify(status, cache) {
  if (status === 200) return cache && cache.startsWith('hit') ? 'hit' : 'served';
  if (status === 429) return '429';
  if (status === 503) return '503';
  if (status >= 500) return '5xx';
  return 'other';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(USAGE);
    return;
  }

  const upstream = await upstreamOf(o.url).catch(() => null);
  if (!upstream) {
    console.error(`cannot read ${o.url}/metrics: is the gateway running?`);
    process.exit(1);
  }
  if (/(^|\.)openrouter\.ai(:\d+)?$/.test(upstream) && !o.allowReal) {
    console.error(`refusing: this gateway's upstream is ${upstream}, the REAL OpenRouter. ` +
      'Start the lab stack (npm run lab:up) or pass --allow-real-upstream.');
    process.exit(2);
  }

  const run = Date.now().toString(36); // new questions stay new across runs
  console.log(`traffic -> ${o.url} (upstream ${upstream}): ${o.rps} req/s for ${o.seconds}s, ` +
    `${Math.round(o.repeat * 100)}% repeated questions. Ctrl+C to stop.`);

  const total = { hit: 0, served: 0, '429': 0, '503': 0, '5xx': 0, other: 0 };
  let win = { ...total };
  let latencies = [];
  let sent = 0;
  let inflight = 0;
  let fresh = 0;
  const startedAt = Date.now();

  async function one() {
    if (inflight >= 50) return; // back-pressure: never pile up on a slow gateway
    const repeated = Math.random() < o.repeat;
    fresh += repeated ? 0 : 1;
    const question = repeated
      ? POOL[Math.floor(Math.random() * POOL.length)]
      : `Question ${run}-${fresh}: how tall will tree number ${fresh} grow?`;
    inflight += 1;
    sent += 1;
    const t0 = Date.now();
    let kind = 'other';
    try {
      const res = await fetch(`${o.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: o.model, messages: [{ role: 'user', content: question }] }),
      });
      await res.arrayBuffer();
      kind = classify(res.status, res.headers.get('x-ggw-cache'));
    } catch (_err) {
      kind = 'other';
    } finally {
      inflight -= 1;
    }
    latencies.push((Date.now() - t0) / 1000);
    total[kind] += 1;
    win[kind] += 1;
  }

  function line(c, extra) {
    return `200 hit ${c.hit} · 200 served ${c.served} · 429 ${c['429']} · 503 ${c['503']} · ` +
      `5xx ${c['5xx']} · other ${c.other}${extra}`;
  }

  const timer = setInterval(() => { one(); }, Math.max(10, Math.round(1000 / o.rps)));
  const report = setInterval(() => {
    const t = Math.round((Date.now() - startedAt) / 1000);
    console.log(`t=${t}s sent=${sent} | ${line(win, ` | p95 ${p95(latencies).toFixed(3)}s`)}`);
    win = { hit: 0, served: 0, '429': 0, '503': 0, '5xx': 0, other: 0 };
    latencies = [];
  }, 10_000);

  function stop() {
    clearInterval(timer);
    clearInterval(report);
    const wait = setInterval(() => {
      if (inflight > 0) return;
      clearInterval(wait);
      console.log(`done: sent=${sent} | ${line(total, '')}`);
      process.exit(0);
    }, 100);
  }

  setTimeout(stop, o.seconds * 1000);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
});
