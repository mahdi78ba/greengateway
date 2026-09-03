'use strict';
const Fastify = require('fastify');
const { loadConfig } = require('./config');
const { register } = require('./metrics');
const { makeAuth } = require('./plugins/auth');
const healthRoutes = require('./routes/health');
const chatRoutes = require('./routes/chat');

function build() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 256 * 1024, // 256 KB request guardrail
  });

  const config = loadConfig();
  const auth = makeAuth(config);
  const spend = new Map(); // in-memory per-tenant spend (MVP; Redis in Phase 4)

  // Unauthenticated ops endpoints
  app.register(healthRoutes);
  app.get('/metrics', async (req, reply) => {
    reply.header('content-type', register.contentType);
    return register.metrics();
  });

  // Authenticated proxy
  app.register(chatRoutes(spend), { auth });

  return app;
}

async function start() {
  const app = build();
  try {
    // bind 0.0.0.0 so Windows/WSL2 localhost forwarding + Docker both reach it
    await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 8080) });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) start();
module.exports = { build };
