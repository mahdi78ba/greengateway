#!/usr/bin/env node
'use strict';

/**
 * tools/alert-sink.js — a tiny webhook receiver for Alertmanager.
 * It stands in for Slack / PagerDuty / e-mail in the lab: every notification is
 * printed as one line (docker compose logs -f alert-sink) and the last 50 are
 * kept in memory.
 *
 *   POST <any path>   an Alertmanager webhook payload (version 4)
 *   GET  /            the notifications received, newest first (JSON)
 *   GET  /healthz     {"ok":true}
 *
 * Environment: SINK_PORT (default 9099), SINK_HOST (default 127.0.0.1).
 */

const http = require('node:http');

function describe(alert, status) {
  const l = alert.labels || {};
  const a = alert.annotations || {};
  const where = ['tenant', 'replica', 'model']
    .filter((k) => l[k])
    .map((k) => `${k}=${l[k]}`)
    .join(' ');
  return `${status === 'resolved' ? 'RESOLVED' : 'FIRING  '} [${l.severity || 'none'}] ${l.alertname || '?'}` +
    `${where ? ` (${where})` : ''}: ${a.summary || ''}`;
}

function createAlertSink(opts = {}) {
  const keep = Number(opts.keep || 50);
  const received = [];
  const log = opts.quiet ? () => {} : (line) => console.log(line);

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const path = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/') return send(res, 200, received);
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch (_err) {
        return send(res, 400, { error: 'invalid JSON' });
      }
      const at = new Date().toISOString();
      for (const alert of Array.isArray(payload.alerts) ? payload.alerts : []) {
        const status = alert.status || payload.status || 'firing';
        log(`${at}  ${describe(alert, status)}`);
        received.unshift({
          at,
          status,
          alertname: alert.labels && alert.labels.alertname,
          severity: alert.labels && alert.labels.severity,
          summary: alert.annotations && alert.annotations.summary,
          labels: alert.labels || {},
          startsAt: alert.startsAt,
        });
      }
      received.length = Math.min(received.length, keep);
      return send(res, 200, { ok: true });
    });
  });

  return {
    server,
    received,
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
  const sink = createAlertSink();
  const port = Number(process.env.SINK_PORT || 9099);
  const host = process.env.SINK_HOST || '127.0.0.1';
  sink.listen(port, host).then(() => console.log(`alert sink on http://${host}:${port}`));
}

module.exports = { createAlertSink, describe };
