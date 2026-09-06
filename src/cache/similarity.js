'use strict';

/**
 * src/cache/similarity.js — GreenGateway Phase 3, Tier-1 similarity backend.
 *
 * DEFAULT BACKEND: "lexical" — an IDF-weighted token cosine.
 * Zero npm dependencies, zero network calls, zero OpenRouter quota. Pure and
 * synchronous, so every function below is directly unit-testable.
 *
 * WHAT IT ACTUALLY CATCHES (be honest — this is NOT an embedding model):
 *   - Re-wordings that reuse the same content words:
 *       "How do I reset my password?"  ~  "how can i reset my password"     -> 1.00
 *       "list the free models"         ~  "please list free models for me"  -> ~1.00
 *   - Punctuation / casing / whitespace / filler-word differences.
 *   - Word-order changes ("password reset steps" ~ "steps to reset password").
 *
 * WHAT IT DOES NOT CATCH (these stay cache MISSES — which cost quota, not trust):
 *   - Synonym paraphrase: "refund" vs "money back", "cheapest" vs "lowest cost",
 *     "delete my account" vs "close my account". No shared content tokens -> ~0.
 *   - Cross-lingual restatements.
 *   - Semantic equivalence expressed with entirely different content words.
 *   Upgrade path for those: the OPTIONAL 'local' backend (transformers.js +
 *   all-MiniLM-L6-v2, 384-dim, ~23 MB one-time download, still $0 and still zero
 *   OpenRouter quota). See createBackend() at the bottom. NOT required, NOT default.
 *
 * WHAT IT REFUSES TO CALL SIMILAR (hard guards, applied before cosine is trusted):
 *   - NUMBER/ID guard: both texts must contain the SAME set of digit-bearing
 *     tokens. "invoice 4471" never matches "invoice 4472"; "gpt-4" never matches
 *     "gpt-5". Highest-value guard for a support/ops workload.
 *   - NEGATION guard: both texts must agree on negation words
 *     (not/no/never/without/disable/cancel/...). Without it,
 *     "how do I enable X" vs "how do I disable X" scores ~0.95 and returns a
 *     confidently wrong answer.
 *
 * SCRIPT LIMITATION (why src/cache/index.js adds two more blockers):
 *   normalize() folds everything outside [a-z0-9.:+#_/-] to whitespace, so CJK,
 *   Cyrillic, Arabic, Hebrew, Greek, Devanagari ... are DELETED, not tokenized.
 *   "重置密码 password" and "删除账户 password" would both reduce to {password}
 *   and score 1.00. This file cannot fix that alone, so it exposes the two
 *   signals index.js needs to refuse the comparison entirely:
 *     vector.tf.size        -> how many content tokens actually survived
 *     vector.stopwordsOnly  -> the degenerate all-stopword fallback was used
 *     vector.text           -> the surviving characters (for a coverage ratio)
 *   index.js turns those into the 'too-few-content-tokens', 'unsupported-script'
 *   and 'stopword-only-prompt' blockers. A blocked prompt still uses the EXACT
 *   tier, which is script-agnostic (normalizeForKey preserves Unicode).
 *
 * Vectors are Map-based and live only in process memory: Phase 3 is in-memory
 * only, matching Phases 1-2. Redis is Phase 4.
 */

/* ------------------------------------------------------------------------- */
/* Word lists                                                                */
/* ------------------------------------------------------------------------- */

// Dropped from the term-frequency vector. Deliberately small: over-aggressive
// stopword removal turns short questions into empty vectors.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'for', 'from', 'get', 'give',
  'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'just', 'may', 'me', 'might', 'mine', 'must',
  'my', 'of', 'on', 'or', 'our', 'ours', 'please', 'shall', 'she', 'should',
  'so', 'some', 'tell', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'to', 'us', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'will',
  'with', 'would', 'you', 'your', 'yours',
  // Negation words are stopwords for the VECTOR, but they are captured by the
  // negation guard below BEFORE they are dropped.
  'no', 'not', 'nor', 'never',
]);

// Captured from the raw token stream BEFORE stopword removal.
const NEGATIONS = new Set([
  'no', 'not', 'nor', 'never', 'none', 'without', 'except', 'exclude',
  'excluding', 'disable', 'disabled', 'disabling', 'cancel', 'cancelled',
  'stop', 'remove', 'delete', 'off', 'cannot', 'cant', 'dont', 'doesnt',
  'didnt', 'isnt', 'arent', 'wasnt', 'wont', 'shouldnt', 'couldnt', 'wouldnt',
  'neither', 'unable',
]);

/**
 * Prompts containing these read as time- or price-relative: the answer goes
 * stale fast, so src/cache/index.js gives them a much shorter TTL.
 *
 * DELIBERATELY NARROW (Phase-3 review fix). The first draft also listed
 * 'status', 'available', 'availability', 'current', 'rate', 'rates', 'score',
 * 'live' and 'uptime'. Those words are ordinary in support traffic ("what is
 * the status of my ticket", "current best practice for X"), so a large slice of
 * normal prompts collapsed to a 60-second TTL — quietly capping the hit rate
 * this whole phase exists to raise. Only words whose presence makes the ANSWER
 * itself time- or price-dependent stay in the list.
 */
const VOLATILE = new Set([
  'today', 'tonight', 'now', 'currently', 'latest', 'newest',
  'yesterday', 'tomorrow', 'price', 'prices', 'pricing',
  'cost', 'costs', 'quota', 'balance', 'weather', 'forecast',
]);

/* ------------------------------------------------------------------------- */
/* normalize / tokenize / vectorize                                          */
/* ------------------------------------------------------------------------- */

/**
 * normalize(text) -> string
 * Aggressive normalization used by the SEMANTIC tier ONLY.
 *
 * The EXACT tier uses a conservative, case-preserving normalization that lives
 * in src/cache/index.js (normalizeForKey). Mixing the two would let
 * "DROP TABLE users;" and "drop table users" share an exact cache key.
 *
 * NFKD -> strip combining marks -> strip apostrophes ("don't" -> "dont")
 * -> lowercase -> anything outside [a-z0-9.:+#_/-] becomes a space -> collapse.
 * Dots / slashes / colons / dashes / underscores survive so model ids
 * ("z-ai/glm-5.2:free"), versions ("v1.5") and identifiers ("user_id") stay
 * single tokens.
 *
 * LOSSY BY DESIGN, AND LOSSY FOR NON-LATIN SCRIPTS — see the SCRIPT LIMITATION
 * note at the top of this file.
 */
function normalize(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\p{Pi}\p{Pf}\p{Lm}'`]+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9.:+#_/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split normalized text into tokens, trimming punctuation left on the edges. */
function tokenize(normalized) {
  if (!normalized) return [];
  const out = [];
  for (const raw of normalized.split(' ')) {
    const t = raw.replace(/^[.:/_-]+/, '').replace(/[.:/_-]+$/, '');
    if (t) out.push(t);
  }
  return out;
}

function hasDigit(token) {
  return /[0-9]/.test(token);
}

/**
 * vectorize(text) -> vector
 * Pure. Accepts raw or already-normalized text (normalize() is idempotent).
 *
 * vector = {
 *   text:          string             the normalized string (guards / debugging)
 *   tokens:        string[]           all tokens, stopwords included
 *   tf:            Map<term, count>   term frequencies, stopwords removed
 *   numbers:       Set<string>        digit-bearing tokens (guard input)
 *   negations:     Set<string>        negation tokens (guard input)
 *   volatile:      boolean            contains time/price-relative words
 *   stopwordsOnly: boolean            the all-stopword fallback below was used
 *   norm:          number             sqrt(sum tf^2), UNWEIGHTED (the idf-weighted
 *                                     norm is recomputed inside cosine())
 * }
 */
function vectorize(text) {
  const norm = normalize(text);
  const tokens = tokenize(norm);
  const tf = new Map();
  const numbers = new Set();
  const negations = new Set();
  let isVolatile = false;

  for (const t of tokens) {
    if (hasDigit(t)) numbers.add(t);
    if (NEGATIONS.has(t)) negations.add(t);
    if (VOLATILE.has(t)) isVolatile = true;
    if (!STOPWORDS.has(t)) tf.set(t, (tf.get(t) || 0) + 1);
  }

  // Degenerate case: an all-stopword prompt ("what is it?"). Fall back to the
  // full token stream so a non-empty prompt never yields an empty vector — but
  // FLAG it, because a vector built entirely from stopwords carries no meaning
  // and index.js must refuse to run the semantic tier on it.
  let stopwordsOnly = false;
  if (tf.size === 0 && tokens.length > 0) {
    stopwordsOnly = true;
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  }

  let sq = 0;
  for (const c of tf.values()) sq += c * c;

  return {
    text: norm,
    tokens,
    tf,
    numbers,
    negations,
    volatile: isVolatile,
    stopwordsOnly,
    norm: Math.sqrt(sq),
  };
}

/* ------------------------------------------------------------------------- */
/* cosine + guards                                                           */
/* ------------------------------------------------------------------------- */

const ONE = () => 1;

/**
 * cosine(a, b, idfWeight?) -> number in [0, 1]
 * PURE cosine similarity over the two term-frequency vectors. Applies NO guards.
 * Call score() (or guardsAgree() yourself) before acting on the result.
 *
 * @param {object}   a           vector from vectorize()
 * @param {object}   b           vector from vectorize()
 * @param {function} [idfWeight] term -> weight. Default 1 (plain TF cosine).
 */
function cosine(a, b, idfWeight) {
  if (!a || !b || !a.tf || !b.tf || a.tf.size === 0 || b.tf.size === 0) return 0;
  const w = typeof idfWeight === 'function' ? idfWeight : ONE;

  // Walk the smaller map for the dot product.
  const small = a.tf.size <= b.tf.size ? a : b;
  const large = small === a ? b : a;

  let dot = 0;
  for (const [term, count] of small.tf) {
    const other = large.tf.get(term);
    if (other === undefined) continue;
    const wt = w(term);
    dot += count * other * wt * wt;
  }
  if (dot === 0) return 0;

  let na = 0;
  for (const [term, count] of a.tf) { const v = w(term) * count; na += v * v; }
  let nb = 0;
  for (const [term, count] of b.tf) { const v = w(term) * count; nb += v * v; }
  if (na === 0 || nb === 0) return 0;

  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // Clamp: floating point can hand back 1.0000000000000002.
  if (c > 1) return 1;
  if (c < 0) return 0;
  return c;
}

function sameSet(x, y) {
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

/**
 * guardsAgree(a, b) -> { ok: boolean, reason: string }
 * Hard pre-conditions for trusting a high cosine. Cheap; runs before cosine.
 */
function guardsAgree(a, b) {
  if (!sameSet(a.numbers, b.numbers)) return { ok: false, reason: 'number-mismatch' };
  if (!sameSet(a.negations, b.negations)) return { ok: false, reason: 'negation-mismatch' };
  return { ok: true, reason: 'ok' };
}

/**
 * score(a, b, idfWeight?) -> number in [0, 1]
 * The value the cache compares against `threshold`. A guard failure returns a
 * hard 0, never a near-threshold number.
 */
function score(a, b, idfWeight) {
  const g = guardsAgree(a, b);
  if (!g.ok) return 0;
  return cosine(a, b, idfWeight);
}

/* ------------------------------------------------------------------------- */
/* IDF model (document frequency measured over the cache itself)             */
/* ------------------------------------------------------------------------- */

/**
 * createIdf() -> { add, remove, weight, docs, terms, clear }
 * Maintained by src/cache/index.js: add() on store, remove() on evict/expire.
 * With very few documents every weight collapses toward ~1, i.e. the backend
 * degrades gracefully to a plain TF cosine on a cold cache. That is intended.
 */
function createIdf() {
  const df = new Map();
  let docs = 0;

  return {
    add(vec) {
      if (!vec || !vec.tf) return;
      docs += 1;
      for (const term of vec.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    },
    remove(vec) {
      if (!vec || !vec.tf) return;
      docs = docs > 0 ? docs - 1 : 0;
      for (const term of vec.tf.keys()) {
        const n = (df.get(term) || 1) - 1;
        if (n <= 0) df.delete(term); else df.set(term, n);
      }
    },
    weight(term) {
      const n = df.get(term) || 0;
      return Math.log((docs + 1) / (n + 1)) + 1;
    },
    get docs() { return docs; },
    get terms() { return df.size; },
    clear() { df.clear(); docs = 0; },
  };
}

/* ------------------------------------------------------------------------- */
/* Pluggable backend factory                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Backend contract — src/cache/index.js only ever touches these three fields:
 *   name              string
 *   prepare(text)     -> vector | Promise<vector>
 *   score(a, b, idf?) -> number in [0, 1]
 */
function createLexicalBackend() {
  return {
    name: 'lexical',
    prepare(text) { return vectorize(text); },
    score(a, b, idfWeight) { return score(a, b, idfWeight); },
  };
}

/**
 * createBackend(name) — 'lexical' is the only backend in the CORE path.
 * Anything else THROWS, loudly, and src/cache/index.js resolves a backend per
 * tenant so that `similarity: local` in tenants.yaml produces that error in the
 * log instead of being silently downgraded to lexical.
 *
 * STRETCH (documented, deliberately NOT implemented, adds no npm dependency):
 *   'local'      @huggingface/transformers (v4.x ships a Node CJS build, so bare
 *                require() works) + Xenova/all-MiniLM-L6-v2 dtype 'q8': 384-dim
 *                unit-norm vectors, so dot product IS cosine. ~23 MB one-time
 *                model download, $0 forever, zero OpenRouter quota. Costs
 *                onnxruntime-node + sharp (>100 MB of native binaries) in
 *                node_modules — that is why it is opt-in, not default.
 *   'openrouter' POST /api/v1/embeddings with a ':free' embedding model.
 *                REJECTED as a default: ':free' ids share the same ~20 req/min,
 *                ~50 req/day PER-ACCOUNT quota this cache exists to protect
 *                (the docs state this for ':free' model ids generally; they do
 *                not call out the /embeddings route explicitly — INFERRED,
 *                UNVERIFIED), and the free Liquid model's own description states
 *                requests and embeddings may be retained and used for training.
 */
function createBackend(name) {
  const want = name || 'lexical';
  if (want === 'lexical') return createLexicalBackend();
  throw new Error(
    "[ggw-cache] similarity backend '" + want + "' is not available in the core path. " +
    "Only 'lexical' ships with zero dependencies. See src/cache/similarity.js for the " +
    "documented 'local' (transformers.js) and 'openrouter' upgrade paths."
  );
}

module.exports = {
  normalize,
  tokenize,
  vectorize,
  cosine,
  guardsAgree,
  score,
  createIdf,
  createBackend,
  createLexicalBackend,
  STOPWORDS,
  NEGATIONS,
  VOLATILE,
};
