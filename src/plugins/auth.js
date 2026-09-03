'use strict';

// Returns a Fastify preHandler that authenticates a tenant by its Bearer key.
// The caller NEVER sees the real OpenRouter key; we only resolve who they are here.
function makeAuth(config) {
  return async function authenticate(req, reply) {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return reply.code(401).send({ error: 'missing_bearer_token' });
    }
    const tenant = config.byKey.get(match[1].trim());
    if (!tenant) {
      return reply.code(401).send({ error: 'invalid_api_key' });
    }
    req.tenant = tenant; // downstream handlers read this
  };
}

module.exports = { makeAuth };
