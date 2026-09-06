// src/server.js — COMPLETE
'use strict';
const Fastify = require('fastify');
const { loadConfig } = require('./config');
const { makeAuth } = require('./plugins/auth');
const { register } = require('./metrics');
const healthRoutes = require('./routes/health');
const chatRoutes = require('./routes/chat');

function build() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: 256 * 1024,
  });
  const config = loadConfig();
  const auth = makeAuth(config);
  const spend = new Map();

  app.register(healthRoutes);
  app.get('/metrics', async (req, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });

  // Phase 3: chatRoutes() returns the plugin with the cache instance attached
  // as `.cache`. Decorating from inside the plugin would only decorate its own
  // encapsulated context, so the root-level decoration happens here.
  const chatPlugin = chatRoutes(spend);
  app.register(chatPlugin, { auth });
  app.decorate('ggwCache', chatPlugin.cache);

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
