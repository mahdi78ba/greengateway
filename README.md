# GreenGateway

[![ci](https://github.com/mahdi78ba/greengateway/actions/workflows/ci.yml/badge.svg)](https://github.com/mahdi78ba/greengateway/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-24%20LTS-339933)
![image](https://img.shields.io/badge/image-ghcr.io%2Fmahdi78ba%2Fgreengateway-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

A self-hosted, OpenAI-compatible **LLM gateway** in front of
[OpenRouter](https://openrouter.ai) (one API and one key that reach many LLM
providers). Apps call the gateway with their own key; it enforces per-tenant
budgets, model allow-lists and rate limits, routes around failing models, caches
answers, and exposes SLOs. A $0 pipeline builds it, boots it, scans it and
publishes it to GHCR with Sigstore-signed provenance and SBOM attestations; one
command runs the same Dockerfile on a local Kubernetes (k3d) with Helm.

Built as a learning project, phase by phase, on the OpenRouter **free tier**
(~20 requests/min, ~50/day per account, `:free` models only). That constraint
shaped every design decision below.

---

## What it does

| Concern | Mechanism | Client sees |
|---|---|---|
| Who is calling | Bearer key → tenant (`config/tenants.yaml`); the real OpenRouter key never leaves the gateway | `401` |
| What they may use | Per-tenant model allow-list and policy | `403 model_not_allowed` |
| How much they may spend | Per-tenant USD budget, shared across replicas | `402 insufficient_budget`, `x-ggw-tenant-spend-usd` |
| Not burning the free tier | Two-tier response cache (exact + near-duplicate) | `x-ggw-cache: hit-exact` / `hit-semantic` / `miss`, `x-ggw-cache-age` |
| Not tripping OpenRouter's limits | Proactive per-tenant sliding-window limiter (per minute and per day) | `429`, `retry-after`, `x-ggw-ratelimit-remaining-*` |
| Upstream having a bad day | Health-ranked routing, bounded failover, per-model circuit breaker | `x-ggw-model`, `x-ggw-attempts` |
| Knowing how it is doing | Prometheus metrics, SLO recording rules, burn-rate alerts, Grafana dashboard | `/metrics`, `x-request-id` |

```
client ──▶ GreenGateway ──▶ OpenRouter (or the mock upstream in the lab)
             │
             ├─ Redis        shared budget, limiter windows, cache, breaker snapshots
             └─ Prometheus   ──▶ Alertmanager, Grafana
```

---

## Quick start

Needs **Node 24+**. The platform commands below need **Docker with Compose v2**;
`npm run k8s:*` and `npm run check` also need **k3d, kubectl and helm** on the PATH.

```bash
git clone https://github.com/mahdi78ba/greengateway && cd greengateway && npm ci
cp .env.example .env      # put your OpenRouter key in it (free models work with $0 credits)
npm start                 # http://localhost:8080 — works without Redis (falls back to in-memory
                          # state; GGW_REDIS_DISABLED=1 skips the connection attempts entirely)
```

```bash
curl -s localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer gg_live_local_dev_key' -H 'content-type: application/json' \
  -d '{"model":"z-ai/glm-5.2:free","messages":[{"role":"user","content":"Say Pong"}]}'
```

Three ways to run the whole platform:

| Command | What you get | Cost |
|---|---|---|
| `docker compose up -d --build` | gateway + Redis + Prometheus + Alertmanager + Grafana, real OpenRouter from `.env` | free-tier quota |
| `npm run lab:up` | the same, against a **mock OpenRouter** with faults on demand | $0 |
| `npm run k8s:up` | a local Kubernetes cluster (k3d) running the Helm chart with an autoscaler; gateway on `http://localhost:8090`, mock upstream by default | $0 |

Ports: gateway `8080` · Grafana `3000` (anonymous viewer, no login) · Prometheus
`9090` · Alertmanager `9093` · Redis `6379`. The lab adds the mock OpenRouter on
`8099`; `npm run lab:ha` adds a second gateway replica on `8081`.

---

## One request, start to finish

`POST /v1/chat/completions` goes through these gates, in this order
(`src/plugins/auth.js` for the `401`, then `src/routes/chat.js` for the rest):

```
401 bad key → 403 model not allowed → 402 budget exhausted → CACHE (exact, then near-duplicate)
→ 429 local rate limit → 503 every model's breaker open → failover loop → 200
```

- The **cache sits before the limiter**: a hit makes no upstream call, so it must not
  consume a free-tier slot.
- The **failover loop** ranks the tenant's models by measured health (error rate,
  then latency), skips models whose breaker is open, and stops after
  `routing.maxAttempts`. A `429` upstream becomes a `200` from the next model.
- The **budget is charged once**, after a successful reply, from OpenRouter's
  reported cost (`x-ggw-cost-usd`). Served and cache-served replies carry
  `x-ggw-model` and `x-ggw-attempts` (`0` on a hit); gateway-side rejections
  (`401`/`403`/`402`/`429`/`503`) do not.
- One **edge metric per client request** (`ggw_http_requests_total{outcome}`)
  feeds the SLO; per-attempt counters stay separate, so a retried request is not
  counted as half an error.

A tenant is a few lines of YAML in `config/tenants.yaml` (a map under `tenants:`,
keyed by tenant id; `key`, `budget_usd` and `allow_models` are required, every other
block is optional and falls back to defaults, e.g. `limits` to 20 rpm / 50 rpd):

```yaml
tenants:
  treetracker-admin:
    key: gg_live_local_dev_key
    budget_usd: 1.00
    allow_models: [z-ai/glm-5.2:free, google/gemma-4-31b-it:free]
    fallbacks: [google/gemma-4-31b-it:free]
    policy: { allow_fallbacks: true, data_collection: allow }   # forwarded to OpenRouter
    routing: { maxAttempts: 3, slo: { timeoutMs: 20000 } }
    cache: { enabled: true, ttlSeconds: 86400, semantic: true, threshold: 0.85 }
    limits: { rpm: 20, rpd: 50 }
```

---

## The phases

Numbers follow the original plan; this is the order they were built in.

| Phase | Delivered | Key choice | Trade-off accepted |
|---|---|---|---|
| **1 · MVP** | OpenAI-compatible endpoint, tenants, budgets, allow-lists, `/metrics`, distroless image | Static YAML tenants, in-process state | Budgets reset on gateway restart (shared in Redis since 4; a Redis restart still resets them) |
| **2 · Routing** | Health-ranked failover, per-model circuit breaker, `Retry-After` awareness | Availability-first ranking (every model is $0) | Bounded attempts: latency capped, some requests still fail |
| **3 · Cache** | Exact + near-duplicate tiers, TTL policy, per-tenant caps, fail-open | Lexical IDF-cosine similarity, zero dependencies | Catches rewordings, not paraphrases; embeddings would cost quota |
| **4 · Redis** | Shared budget, atomic sliding-window limiter, shared cache and breaker state, graceful degradation | Lua limiter; integer micro-dollars; degrade to memory | Availability over strict global consistency while Redis is down |
| **5 · Observability** | SLI/SLO, 16 recording rules, 10 alerts, 11 `promtool` unit tests, Alertmanager, 20-panel Grafana dashboard as code | Multi-window burn-rate alerts | No traces or log pipeline (yet) |
| **9+10 · CI/CD & supply chain** | SHA-pinned pipeline, gitleaks, hadolint/actionlint, Trivy gate, SBOM, GHCR publish with signed provenance, Dependabot | Gate only on **fixable** HIGH/CRITICAL | A new CVE can turn CI red without a code change — by design |
| **6 · Kubernetes** | Helm chart, liveness/readiness, graceful shutdown, hardened pods, CPU HPA, k3d lab, k6 load test run while Redis and a gateway pod were killed | k3d and image import: real Kubernetes, no registry, disposable | One node: HA of pods, not machines |

### 1 · MVP — the security desk
Apps get their own `gg_live_…` key; the real OpenRouter key stays in the gateway.
Every request is authenticated, checked against the tenant's model list and budget,
forwarded, and metered. **Why Fastify:** small, fast, first-class hooks and
`inject()` for tests. **Why OpenAI-compatible:** non-streaming clients and SDKs work
unchanged; `stream: true` is accepted but answered as one JSON body (streaming is
deferred, see *Not done*). **How to see it:** the `401` / `403` / `402` rows of the
*What it does* table, and `x-ggw-*` headers on every reply that gets past them.

### 2 · Routing — turning 429s into 200s
On the free tier, availability matters more than price. Each model gets a
three-state breaker (closed / open / half-open with a single probe) and a health
record (EWMA latency, rolling error rate). Candidates are ranked healthiest-first;
a failing model is skipped before you see its error. **Trade-off:** per-model, not
per-provider, breaking — each `:free` model is its own upstream endpoint that fails
or 429s on its own, so tripping the whole provider would take healthy models down
with it. (The per-*account* quota is a different problem: the limiter in Phase 4.)

### 3 · Cache — one hit is one request not spent
Tier 0 is a hash of tenant + model + parameters + normalised messages (zero false
positives). Tier 1 scans one bucket for near-duplicates with an IDF-weighted token
cosine, off for tool calls and high temperatures. Prompts with words like *today*
or *latest* get a short TTL. Cache errors never block a request: a failed lookup or
store is logged and the call goes upstream (fail-open). **Trade-off:** a lexical
similarity is honest about what it catches (rewordings, punctuation, word order)
and costs nothing; an embedding model would catch paraphrases but spend the very
quota the cache exists to protect.

### 4 · Redis — several replicas, one truth
Budgets become an integer counter in micro-dollars, incremented atomically
(`INCRBY`) after each successful reply; the check is post-paid, with no reservation,
so in-flight requests can overshoot the line by their own cost. The limiter is one
Lua script over two sorted sets (per-minute and per-day windows, count-then-add,
all-or-nothing, so a denied request never fills its own window). Cache and breaker
snapshots are shared. Every Redis call is time-boxed behind a process-level
circuit: three failures and the gateway serves from memory, probing every 5 s.
**Why:** the free tier is limited per OpenRouter *account*, so two gateway replicas
must count together. Windows are keyed per tenant (default 20 rpm / 50 rpd, the
account ceiling); several production tenants could add up past it — an
account-wide window is not implemented. **Trade-off:** while Redis is away,
replicas count separately.

### 5 · Observability — a number for "is it okay?"
Availability SLO 99 % over 30 days, computed from the edge metric. Alerts follow the
multi-window, multi-burn-rate pattern (fast burn on 1 h/5 m, slow on 6 h/30 m) so a
real outage pages in minutes and a slow leak in hours, without flapping. Eleven
`promtool` unit tests run in CI and cover 9 of the 10 alerts plus the recording
rules (the slow-burn alert is the one gap). Grafana is stateless: datasource and
dashboard are provisioned from git. A mock upstream with a fault-injection API and
a traffic generator make outages reproducible at $0.

### 9+10 · CI/CD and supply chain — refuse to ship what you cannot vouch for
Five gates run in parallel — tests + `npm audit`, hadolint + actionlint, gitleaks
over the full history, the alert-rule tests, `helm lint` — and pull requests also
get a dependency review that reports but does not gate. When the five are green,
one image job builds once, **boots the container**, scans it, writes an SBOM and —
on pushes only — publishes to GHCR with Sigstore-signed provenance and SBOM
attestations. Every action is pinned to a commit SHA, every base image to a
digest, the token is read-only by default, config is mounted, never baked into the
image. The gate found real problems on day one: an end-of-life Node 20 base with
**1 CRITICAL + 5 HIGH** fixable CVEs and two HIGH advisories in Fastify 4 — now
Node 24, Fastify 5, **0 fixable**.

### 6 · Kubernetes — the same image, run properly
A Helm chart with liveness (`/healthz`) and readiness (`/readyz`) probes, rolling
updates that never drop below capacity, non-root read-only pods, a tenant
ConfigMap with a checksum annotation, and a CPU HPA (2–5 pods). On SIGTERM the
gateway fails readiness first, waits for the endpoint change to propagate, then
drains. Measured with k6 on k3d against the in-cluster mock upstream (so the
latency is the gateway's own overhead, not a model's) while Redis and one gateway
pod were deleted mid-run (`kubectl delete pod -l app.kubernetes.io/component=redis`,
then one gateway pod): **8,853 requests, 0 failed, p95 296 ms**; the HPA scaled
2 → 5 in 45 s.

---

## Technology and why

| Technology | Used for | Why this one |
|---|---|---|
| Node 24 LTS · Fastify 5 | the gateway | Async I/O fits a proxy; Fastify's hooks, decorators and `inject()` keep tests hermetic; 20 → 24 because 20 is end-of-life |
| Redis 8 | shared state | Atomic counters, sorted sets and Lua give correct limiters without a database. No persistence: cache, limiter windows and breaker snapshots rebuild themselves; a Redis restart zeroes the budget counters — accepted for a $0 lab |
| Prometheus · Alertmanager · Grafana | observability | The standard stack; recording rules, unit-testable alerts and dashboards as code |
| Docker (distroless, non-root) | packaging | No shell or package manager in the runtime image; digest-pinned base images |
| GitHub Actions · Trivy · gitleaks · syft · attestations | CI/CD, supply chain | Free for public repos; SHA-pinned actions; SLSA v1.0 Build L2 provenance via GitHub artifact attestations — keyless Sigstore signing, verifiable with `gh attestation verify` |
| Helm · k3d · k6 | Kubernetes, load and chaos | A real Kubernetes in Docker, disposable; Helm is what a platform team would consume; k6 gives thresholds, not just numbers |
| `node --test`, promtool tests, hadolint, actionlint | quality gates | Zero-dependency tests; the same commands locally (`npm run check`, `scan:image`) and in CI |

---

## Repository layout

```
src/
  server.js            wiring, graceful shutdown
  config.js            loads and validates config/tenants.yaml, indexes tenants by key
  plugins/auth.js      Bearer key → tenant (the 401)
  routes/chat.js       the request path after auth (policy → budget → cache → limiter → failover)
  routes/health.js     /healthz (liveness), /readyz (readiness)
  routing/             breaker, health, scorer (Phase 2)
  cache/               facade, in-memory store, lexical similarity (Phase 3)
  redis/               client circuit, budget, limiter (Lua), shared store/breaker/health (Phase 4)
  metrics.js, observability.js   Prometheus metrics, edge SLI, request ids (Phase 5)
config/tenants.yaml    tenants: keys, budgets, models, policies, cache and limit settings
observability/         Prometheus config + rules + alert unit tests, Alertmanager, Grafana provisioning
deploy/helm/greengateway/   the chart; deploy/k3d/ cluster scripts; deploy/k6/ load test
tools/                 mock OpenRouter (fault injection), alert sink, traffic generator
test/                  101 hermetic tests (loopback-only mock upstream, no external network, no Redis)
.github/               ci.yml (7 jobs), dependabot.yml
Dockerfile, docker-compose.yml, docker-compose.lab.yml
```

## Commands

| Command | Does |
|---|---|
| `npm test` | 101 tests, hermetic (loopback only, no external network, no Redis) |
| `npm run check` | the five pre-image CI gates locally: tests, `npm audit`, hadolint, actionlint, gitleaks, promtool/amtool, `helm lint` (needs Docker and `helm`) |
| `npm run scan:image` / `sbom` / `scan:secrets` | the image job's Trivy gate and syft SBOM, plus gitleaks — same tool versions and flags as CI (build `greengateway:dev` first, e.g. `npm run lab:up`; the container boot test runs only in CI) |
| `npm run lab:up` / `lab:ha` / `lab:down` | compose platform with the mock upstream (`lab:ha` adds a second gateway replica) |
| `npm run traffic` | demo traffic for dashboards and alert drills (refuses to hit the real OpenRouter) |
| `npm run obs:check` | Prometheus/Alertmanager config checks and the 11 alert unit tests |
| `npm run k8s:up` / `k8s:status` / `k8s:down` | k3d cluster + Helm release (gateway on `:8090`, mock upstream) |
| `npm run k6` | 30-VU load test with pass/fail thresholds, against the k3d gateway on `:8090` by default; `BASE_URL=http://host.docker.internal:8080 npm run k6` targets the compose stack (k6 runs in a container). Refuses the real OpenRouter |

---

## Measured

| | |
|---|---|
| Tests | 101 hermetic (no external network, no Redis), on Node 24 |
| Image | distroless, non-root, 0 fixable HIGH/CRITICAL (was 8 before the Node 24 / Fastify 5 move) |
| Alerting | full outage → critical alert delivered in ~1.5 min, burn-rate alert at ~6 min, duplicates suppressed (compose lab, 5 s scrape; the alerts' `for:` windows dominate) |
| Kubernetes | k6 against the mock upstream (gateway overhead, not model latency): 8,853 requests, 0.00 % failed, p95 296 ms, with Redis and a gateway pod killed mid-run; HPA 2 → 5 pods in 45 s |
| Pipeline | 7 jobs, every action SHA-pinned; first push green |

## Principles

- **Free tier first.** Every feature is judged by requests saved and 429s avoided, not dollars.
- **Degrade, don't die.** Redis down → memory. Cache error → miss. Model down → next model.
- **Gates must be actionable.** Block on fixable vulnerabilities; report the rest.
- **Same tools everywhere.** Every gate that can run on a laptop is one npm script with the same pinned tool version as CI: `npm run check` for the source gates, `scan:image` / `sbom` for the image.
- **Config is not code.** Tenants and keys are mounted at run time; images are identical across environments.
- **Verify, don't trust.** Alerts have tests, images are booted before being scanned, and images imported into k3d are checked inside the node before Helm runs (k3d can report success on an empty import).

## Not done (yet)

- Phase 7 — GitOps (Argo CD) and a replay/eval harness that scores routing changes against recorded traffic.
- Streaming responses (planned for Phase 4, deferred): `stream: true` is answered as one JSON body, not SSE.
- An account-wide rate-limit window (today the windows are per tenant).
- Durable budget counters (Redis runs without persistence; a managed Redis would fix it).
- In-cluster Prometheus, PodDisruptionBudget and anti-affinity, cosign, CodeQL, a slow-burn alert unit test.

## License

MIT
