'use strict';
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Load tenants.yaml and build a fast key -> tenant lookup, validating as we go.
function loadConfig(file) {
  const target = file
    || process.env.TENANTS_FILE
    || path.join(__dirname, '..', 'config', 'tenants.yaml');

  const doc = yaml.load(fs.readFileSync(target, 'utf8'));
  if (!doc || typeof doc !== 'object' || !doc.tenants) {
    throw new Error(`Invalid tenants config at ${target}: missing "tenants"`);
  }

  const byKey = new Map();
  for (const [id, t] of Object.entries(doc.tenants)) {
    if (!t.key) throw new Error(`Tenant "${id}" is missing "key"`);
    if (typeof t.budget_usd !== 'number') throw new Error(`Tenant "${id}" needs numeric "budget_usd"`);
    if (!Array.isArray(t.allow_models) || t.allow_models.length === 0) {
      throw new Error(`Tenant "${id}" needs a non-empty "allow_models"`);
    }
    byKey.set(t.key, {
      id,
      budget_usd: t.budget_usd,
      allow_models: t.allow_models,
      fallbacks: t.fallbacks || [],
      policy: t.policy || {},
      routing: t.routing || undefined,
    });
  }
  return { byKey };
}

module.exports = { loadConfig };
