// k6 load / performance test for the Archon Autopilot HTTP service.
//
// This is the LOAD tier of the testing pyramid (unit / integration / e2e already
// exist). It exercises the LIVE service over HTTP and holds its latency +
// error-rate SLOs to per-endpoint thresholds under ramping concurrency.
//
// ── What it targets ─────────────────────────────────────────────────────────
// The MAIN workflow endpoint is POST /intake — the human-gated AP loop (normalize
// → recall → validate → Qwen-decide → a PENDING proposal). Nothing executes at
// intake (it only proposes), so load-testing it never moves money and never fires
// a side-effect. Run it against the OFFLINE server (no DASHSCOPE key → the
// deterministic Fakes) and /intake is CPU-cheap with zero spend; point it at a
// live Qwen-backed box and each /intake is a real decider completion (real spend).
//
// The profile mixes the workflow write with two cheap reads — GET /health
// (liveness) and GET /pending (the approval queue) — so the HTTP/service layer is
// stressed without a wall of concurrent decider calls dominating the sample.
//
// ── The daily rate limiter ──────────────────────────────────────────────────
// /intake is capped per UTC day (DailyRateLimiter, default 20/day). Under load
// that cap is hit almost immediately, so a 429 is an EXPECTED, correct response —
// NOT a failure. The checks below treat 200 and 429 as both-valid and track the
// two separately (see intake_accepted / intake_rate_limited). To actually exercise
// the loop under load, boot the target server with a high UPLOAD_DAILY_LIMIT (the
// bundled load-test workflow does exactly this against an offline server).
//
// ── Run ─────────────────────────────────────────────────────────────────────
//   k6 run load/workflow-load.js                          # smoke, localhost:9000
//   BASE_URL=http://host:9000 k6 run load/workflow-load.js
//   RUN_RAMP=true  k6 run load/workflow-load.js            # add the 0→20→50→0 ramp
//   INTAKE_RATIO=0.5 k6 run load/workflow-load.js          # share of iters that POST /intake
//
// ── Env knobs ───────────────────────────────────────────────────────────────
//   BASE_URL      base URL (default http://localhost:9000; TARGET_URL also accepted)
//   RUN_RAMP      'true' → run the 0→20→50→0 ramping-vus scenario after the smoke
//   INTAKE_RATIO  0..1, share of iterations that POST /intake (default 0.3); the rest
//                 hit /pending (a cheap read). /health runs every iteration.
//   K6_REVIEWER_TOKEN  reviewer credential for durable intake + approval-queue reads

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = (__ENV.BASE_URL || __ENV.TARGET_URL || "http://localhost:9000").replace(/\/+$/, "");
const RUN_RAMP = (__ENV.RUN_RAMP || "").toLowerCase() === "true";
const INTAKE_RATIO = clamp01(parseFloat(__ENV.INTAKE_RATIO || "0.3"), 0.3);
const SUMMARY_PATH = __ENV.K6_SUMMARY_PATH || "load-summary.json";
const REVIEWER_TOKEN = (__ENV.K6_REVIEWER_TOKEN || "").trim();
if (!REVIEWER_TOKEN) {
  throw new Error("K6_REVIEWER_TOKEN is required: load targets durable intake and the protected approval queue");
}

function clamp01(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const REVIEWER_HEADERS = { Authorization: `Bearer ${REVIEWER_TOKEN}` };
const JSON_HEADERS = { "Content-Type": "application/json", ...REVIEWER_HEADERS };

// Two custom rates so the rate-limit behaviour is visible independent of the
// pass/fail aggregate: how many /intake calls were accepted (200) vs correctly
// rate-limited (429). Both are "healthy" outcomes; a 5xx/other is the real failure.
const intakeAccepted = new Rate("intake_accepted");
const intakeRateLimited = new Rate("intake_rate_limited");

// ── Scenarios ─────────────────────────────────────────────────────────────────
// smoke: 1 VU for ~30s — a fast, cheap sanity pass that always runs.
// ramp:  0→20→50→0 over ~3.5 min — opt-in (RUN_RAMP=true), starts AFTER the smoke
//        so the two never overlap and the summary stays interpretable.
const scenarios = {
  smoke: {
    executor: "constant-vus",
    vus: 1,
    duration: "30s",
    tags: { scenario: "smoke" },
  },
};
if (RUN_RAMP) {
  scenarios.ramp = {
    executor: "ramping-vus",
    startVUs: 0,
    startTime: "32s", // begin just after the 30s smoke finishes
    stages: [
      { duration: "45s", target: 20 },
      { duration: "60s", target: 50 },
      { duration: "60s", target: 50 },
      { duration: "45s", target: 0 },
    ],
    gracefulRampDown: "10s",
    tags: { scenario: "ramp" },
  };
}

// ── Thresholds (SLOs) ──────────────────────────────────────────────────────────
// Per-endpoint tagged thresholds are the real SLOs. /health is a trivial in-process
// liveness handler; /pending is a store read; /intake runs the multi-step loop
// (offline: CPU only; live: a real decider completion), so it is legitimately slower.
// http_req_failed stays loose because an EXPECTED 429 from the daily cap is counted
// by k6 as a failed request — intake health is asserted via the custom rates instead.
const thresholds = {
  checks: ["rate>0.99"], // >99% of assertions must pass
  "http_req_duration{endpoint:health}": ["p(95)<500", "p(99)<800"],
  "http_req_duration{endpoint:pending}": ["p(95)<800", "p(99)<1200"],
  "http_req_duration{endpoint:intake}": ["p(95)<2500", "p(99)<4000"],
  // Loose global ceiling; the tagged SLOs above are the meaningful ones.
  http_req_duration: ["p(95)<2500"],
  // Every /intake response must be a VALID outcome (accepted OR rate-limited) — a
  // 5xx or unexpected status drives this below 1 and fails the run.
  intake_valid_response: ["rate>0.99"],
};

export const options = {
  scenarios,
  thresholds,
};

// A fresh, unique invoice per call so each /intake is a genuine new-vendor decision
// (not a duplicate short-circuit). Universal finance terms only — no locale/authority.
function newInvoice() {
  const n = Math.floor(Math.random() * 1e9);
  return {
    invoice: {
      vendor: `k6 Load Vendor ${n}`,
      invoice_number: `K6-${Date.now()}-${n}`,
      invoice_date: "2026-06-30",
      tax_id: `TX-${n}`,
      currency: "EUR",
      subtotal: 5200,
      tax: 1248,
      total: 6448,
      line_items: [{ description: "Freight and warehousing", quantity: 1, unit_price: 5200, amount: 5200 }],
    },
  };
}

// A second custom rate that flags any /intake response that is NEITHER 200 nor 429
// as invalid — this is what the threshold above gates on.
const intakeValid = new Rate("intake_valid_response");

// ── Test body ──────────────────────────────────────────────────────────────────
export default function () {
  // Always probe liveness first — cheap and read-only.
  health();

  // A bounded share of iterations exercise the main workflow endpoint; the rest hit
  // the cheap /pending read so the service layer is stressed under mixed traffic.
  if (Math.random() < INTAKE_RATIO) {
    intake();
  } else {
    pending();
  }

  sleep(1);
}

function health() {
  const res = http.get(`${BASE}/health`, { tags: { endpoint: "health" } });
  check(
    res,
    {
      "health: 200": (r) => r.status === 200,
      "health: status ok": (r) => safeJson(r)?.status === "ok",
      "health: reports decider": (r) => typeof safeJson(r)?.decider === "string",
    },
    { endpoint: "health" }
  );
}

function pending() {
  const res = http.get(`${BASE}/pending`, { headers: REVIEWER_HEADERS, tags: { endpoint: "pending" } });
  check(
    res,
    {
      "pending: 200": (r) => r.status === 200,
      "pending: is array": (r) => Array.isArray(safeJson(r)?.pending),
    },
    { endpoint: "pending" }
  );
}

function intake() {
  const res = http.post(`${BASE}/intake`, JSON.stringify(newInvoice()), {
    headers: JSON_HEADERS,
    tags: { endpoint: "intake" },
  });
  const json = safeJson(res);
  const accepted = res.status === 200;
  const limited = res.status === 429;
  intakeAccepted.add(accepted);
  intakeRateLimited.add(limited);
  intakeValid.add(accepted || limited);
  check(
    res,
    {
      // 200 (queued a PENDING proposal) OR 429 (the daily cap — a correct response),
      // never a 5xx.
      "intake: 200 or 429 (never 5xx)": () => accepted || limited,
      // When accepted, the proposal is PENDING and NOTHING executed (the gate held).
      "intake: 200 → pending proposal, nothing executed": () =>
        !accepted || (json?.status === "pending" && json?.execution == null),
      // When accepted, the multi-step trace is present (the loop actually ran).
      "intake: 200 → has a step trace": () => !accepted || Array.isArray(json?.trace),
      // When rate-limited, the body states the cap clearly.
      "intake: 429 → states the daily cap": () => !limited || typeof json?.error === "string",
    },
    { endpoint: "intake" }
  );
}

function safeJson(res) {
  try {
    return res.json();
  } catch (_e) {
    return null;
  }
}

// ── Summary artifact ────────────────────────────────────────────────────────────
// Emit a dependency-free, bounded stdout summary and the full machine-readable
// JSON artifact. Keeping summary formatting local avoids executing mutable remote
// JavaScript during the supply-chain-locked load job.
export function handleSummary(data) {
  const metric = (name, value) => data.metrics?.[name]?.values?.[value];
  const lines = [
    "k6 Archon Autopilot summary",
    `checks rate: ${metric("checks", "rate") ?? "n/a"}`,
    `http p95 ms: ${metric("http_req_duration", "p(95)") ?? "n/a"}`,
    `iterations: ${metric("iterations", "count") ?? "n/a"}`,
    `intake valid rate: ${metric("intake_valid_response", "rate") ?? "n/a"}`,
  ];
  return {
    stdout: `${lines.join("\n")}\n`,
    [SUMMARY_PATH]: JSON.stringify(data, null, 2),
  };
}
