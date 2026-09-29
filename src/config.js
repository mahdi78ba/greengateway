'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Relative to this file, not to process.cwd(): `node src/server.js` must find
// the config no matter which directory it is started from.
const DEFAULT_FILE = path.join(__dirname, '..', 'config', 'tenants.yaml');

function parseLimits(raw, id) {
  if (raw === undefined || raw === null) return undefined; // absent block = defaults
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`tenant "${id}": limits must be a map`);
  }
  const out = {};
  if (raw.enabled !== undefined) out.enabled = Boolean(raw.enabled);
  for (const field of ['rpm', 'rpd']) {
    if (raw[field] === undefined || raw[field] === null) continue;
    const n = Number(raw[field]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(`tenant "${id}": limits.${field} must be a non-negative integer`);
    }
    out[field] = n;
  }
  return out;
}

function loadConfig(file) {
  // GGW_TENANTS_FILE is the Phase-4 name; TENANTS_FILE (Phases 1-3) still works.
  const target = file || process.env.GGW_TENANTS_FILE || process.env.TENANTS_FILE || DEFAULT_FILE;
  const doc = yaml.load(fs.readFileSync(target, 'utf8'));

  if (!doc || typeof doc !== 'object' || !doc.tenants || typeof doc.tenants !== 'object' || Array.isArray(doc.tenants)) {
    throw new Error('config: "tenants" must be a map keyed by tenant id');
  }

  const byKey = new Map();
  for (const [id, t] of Object.entries(doc.tenants)) {
    if (!t || typeof t !== 'object') throw new Error(`tenant "${id}": must be a map`);
    if (!t.key || typeof t.key !== 'string') throw new Error(`tenant "${id}": missing "key"`);
    if (typeof t.budget_usd !== 'number' || !Number.isFinite(t.budget_usd) || t.budget_usd < 0) {
      throw new Error(`tenant "${id}": budget_usd must be a non-negative number`);
    }
    if (!Array.isArray(t.allow_models) || t.allow_models.length === 0) {
      throw new Error(`tenant "${id}": allow_models must be a non-empty list`);
    }
    if (byKey.has(t.key)) throw new Error(`tenant "${id}": duplicate key`);

    byKey.set(t.key, {
      id,
      budget_usd: t.budget_usd,
      allow_models: t.allow_models,
      fallbacks: t.fallbacks || [],
      policy: t.policy || {},
      routing: t.routing || undefined,
      cache: t.cache || undefined,
      // Phase 4: optional per-tenant proactive rate limits. Absent = defaults
      // (20 rpm / 50 rpd, the OpenRouter free-tier account ceiling).
      limits: parseLimits(t.limits, id)
    });
  }

  return { byKey };
}

module.exports = { loadConfig };

