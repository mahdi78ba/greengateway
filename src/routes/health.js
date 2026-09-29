'use strict';

module.exports = async function healthRoutes(app) {
  // Liveness: the process is up. Kubernetes restarts the container if this fails.
  app.get('/healthz', async () => ({ ok: true }));

  // PHASE 6. Readiness: may this pod receive traffic? It answers 503 while the
  // process drains after SIGTERM, so the Service stops sending it new requests
  // before the listener closes. Liveness stays 200 the whole time: draining is
  // not a reason to kill the pod.
  app.get('/readyz', async (req, reply) => {
    if (app.ggwState && app.ggwState.ready === false) {
      req.ggwOutcome = 'not_ready';
      reply.code(503);
      return { ready: false, reason: 'shutting down' };
    }
    return { ready: true };
  });
};
