'use strict';

module.exports = async function healthRoutes(app) {
  app.get('/healthz', async () => ({ ok: true }));
};
