// deploy/k6/load.js — a small, honest load test for the Phase 6 drills.
//
//   npm run k6                       (targets the k3d gateway on localhost:8090)
//   BASE_URL=http://localhost:8080 npm run k6
//
// Ramps to 30 virtual users for two minutes: enough CPU to make the HPA scale
// out, and a steady stream of requests during the kill-a-pod / kill-Redis
// drills. Thresholds make the run itself pass or fail.
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '2m', target: 30 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],   // < 1 % failed requests, even during the drills
    http_req_duration: ['p(95)<2000'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:8090';
const KEY = __ENV.API_KEY || 'gg_live_loadtest'; // the MOCK-ONLY tenant (rpm 6000)

// Safety interlock, same as tools/traffic.js: never burn the real free-tier quota.
export function setup() {
  const metrics = http.get(`${BASE}/metrics`);
  if (metrics.status !== 200) throw new Error(`cannot read ${BASE}/metrics (status ${metrics.status})`);
  if (metrics.body.includes('upstream="openrouter.ai"') && !__ENV.ALLOW_REAL_UPSTREAM) {
    throw new Error("refusing: this gateway's upstream is openrouter.ai, the REAL OpenRouter. Deploy with mock.enabled=true, or set ALLOW_REAL_UPSTREAM=1 if you really mean it.");
  }
}

export default function () {
  // A new question each time: cache misses keep the gateway busy.
  const body = JSON.stringify({
    model: 'z-ai/glm-5.2:free',
    messages: [{ role: 'user', content: `Question ${__VU}-${__ITER}: how tall will tree number ${__ITER} grow?` }],
  });
  const res = http.post(`${BASE}/v1/chat/completions`, body, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.2);
}
