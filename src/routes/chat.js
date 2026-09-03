'use strict';
const { requests, cost, tokens, duration } = require('../metrics');

const OPENROUTER_BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';

// `spend` is an in-memory Map<tenantId, usd> for the MVP (Redis in Phase 4).
module.exports = function chatRoutes(spend) {
  return async function (app, opts) {
    const auth = opts.auth;

    app.post('/v1/chat/completions', { preHandler: auth }, async (req, reply) => {
      const t = req.tenant;
      const requested = req.body && req.body.model;

      // M3 — model allow-list
      if (!requested || !t.allow_models.includes(requested)) {
        requests.inc({ tenant: t.id, model: requested || 'none', provider: 'na', status: '403' });
        return reply.code(403).send({ error: 'model_not_allowed', allowed: t.allow_models });
      }

      // M4 — pre-flight budget check (reject before spending if already at/over cap)
      const used = spend.get(t.id) || 0;
      if (used >= t.budget_usd) {
        requests.inc({ tenant: t.id, model: requested, provider: 'na', status: '402' });
        return reply.code(402).send({ error: 'tenant_budget_exceeded', budget_usd: t.budget_usd, used_usd: used });
      }

      // M2 — policy rewrite: inject the provider block + fallback chain; force non-streaming for the MVP
      const body = {
        ...req.body,
        stream: false,
        provider: { data_collection: 'deny', ...(t.policy || {}) },
        models: [requested, ...t.fallbacks],
      };

      // M1 — inject the real key server-side
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) {
        req.log.error('OPENROUTER_API_KEY is not set');
        return reply.code(500).send({ error: 'gateway_misconfigured' });
      }

      const stop = duration.startTimer({ tenant: t.id, model: requested });
      let res;
      try {
        res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'x-title': 'GreenGateway',
            'http-referer': 'https://greenstand.org',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        stop({ provider: 'na', status: 'error' });
        req.log.error({ err }, 'upstream fetch failed');
        requests.inc({ tenant: t.id, model: requested, provider: 'na', status: '502' });
        return reply.code(502).send({ error: 'upstream_unreachable' });
      }

      // M5 — distinct failure modes: 429 (transient) vs 402 (credits)
      if (res.status === 429) {
        stop({ provider: 'na', status: '429' });
        requests.inc({ tenant: t.id, model: requested, provider: 'na', status: '429' });
        return reply.code(429)
          .header('retry-after', res.headers.get('retry-after') || '5')
          .send({ error: 'rate_limited' });
      }
      if (res.status === 402) {
        stop({ provider: 'na', status: '402' });
        requests.inc({ tenant: t.id, model: requested, provider: 'na', status: '402' });
        return reply.code(402).send({ error: 'upstream_credits_exhausted' });
      }

      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        stop({ provider: 'na', status: String(res.status) });
        requests.inc({ tenant: t.id, model: requested, provider: 'na', status: String(res.status) });
        return reply.code(res.status || 502).send({ error: 'upstream_error', detail: data || null });
      }

      // provider name is on the response body; field name may vary — default safely.
      const provider = data.provider || 'unknown';
      const spent = data.usage && typeof data.usage.cost === 'number' ? data.usage.cost : 0;

      // meter
      stop({ provider, status: '200' });
      requests.inc({ tenant: t.id, model: requested, provider, status: '200' });
      cost.inc({ tenant: t.id, model: requested, provider, status: '200' }, spent);
      if (data.usage) {
        tokens.inc({ tenant: t.id, model: requested, direction: 'in' }, data.usage.prompt_tokens || 0);
        tokens.inc({ tenant: t.id, model: requested, direction: 'out' }, data.usage.completion_tokens || 0);
      }

      // M4 — record spend and surface it to the caller
      const newTotal = used + spent;
      spend.set(t.id, newTotal);
      reply.header('x-ggw-cost-usd', String(spent));
      reply.header('x-ggw-tenant-spend-usd', String(newTotal));
      return reply.send(data);
    });
  };
};
