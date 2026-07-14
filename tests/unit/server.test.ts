// Unit — the HTTP shell (src/server.ts) via Fastify's in-process `inject`, with
// injected in-memory dependencies (no DB, no key). Covers /health, the swagger
// surface, the permissive /intake guard, and the 404/409 mapping of the gate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerDeps } from "../../src/server.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { DailyRateLimiter } from "../../src/ap/rate-limit.js";
import {
  withReviewFlags,
  LOW_CONFIDENCE_THRESHOLD,
  EXTRACTION_REVIEW_THRESHOLD,
} from "../../src/server.js";
import type { WorkItem } from "../../src/types.js";
import { FakeExtractionClient } from "../../src/qwen/vision.js";

let app: FastifyInstance;
const REVIEWER_TOKEN = "unit-test-reviewer-token-32-characters";
const AUTH = { authorization: `Bearer ${REVIEWER_TOKEN}` };

function deps(extra: Partial<ServerDeps> = {}): ServerDeps {
  return {
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks: fakeSinks(),
    extractor: new FakeExtractionClient(), // offline vision — no key, no poppler
    reviewerToken: REVIEWER_TOKEN,
    ...extra,
  };
}

const sampleInvoice = { vendor: "Acme", invoice_number: "A-1", date: "2026-01-01", currency: "EUR", tax_id: "T", subtotal: 100, tax: 20, total: 120 };

// The upload path now content-sniffs the leading bytes, so a fixture PNG must carry
// the real 8-byte PNG signature. The offline FakeExtractionClient ignores the bytes
// (returns the canonical Meridian invoice), so any valid-magic buffer works here.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

// Build a multipart/form-data body with ONE file part. Multipart parts REQUIRE
// CRLF line endings, so a bare-\n body would not parse — hence the explicit \r\n.
function multipartFile(field: string, filename: string, contentType: string, content: Buffer | string): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----archontest" + Math.random().toString(16).slice(2);
  const head =
    `--${boundary}\r\n` +
    `content-disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `content-type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(tail, "utf8")]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

before(async () => {
  delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes
  app = await buildServer(deps());
  await app.ready();
});

after(async () => {
  await app.close();
});

test("GET /health returns ok with embedder + decider identity (no DB, no key)", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.ok(typeof body.embedder === "string" && body.embedder.length > 0);
  assert.ok(typeof body.decider === "string" && body.decider.length > 0);
});

test("withReviewFlags flags a below-threshold confidence for review, and leaves a confident one alone", () => {
  const base = (confidence: number, extractionConfidence: number | null = null): WorkItem =>
    ({
      invoice: { extraction_confidence: extractionConfidence },
      proposed: { tool: "draft_payment", args: {}, reasoning: "", confidence, modelId: "x" },
    } as unknown as WorkItem);
  assert.ok(LOW_CONFIDENCE_THRESHOLD > 0 && LOW_CONFIDENCE_THRESHOLD <= 1);
  assert.equal(withReviewFlags(base(0.2)).lowConfidence, true, "0.2 < threshold → flagged");
  assert.equal(withReviewFlags(base(0.9)).lowConfidence, false, "0.9 ≥ threshold → not flagged");
  assert.ok(EXTRACTION_REVIEW_THRESHOLD > 0 && EXTRACTION_REVIEW_THRESHOLD <= 1);
  const weakSource = withReviewFlags(base(0.9, EXTRACTION_REVIEW_THRESHOLD / 2));
  assert.equal(weakSource.lowConfidence, false, "decision confidence stays a separate signal");
  assert.equal(weakSource.lowExtractionConfidence, true, "weak Qwen-VL read is flagged independently");
  assert.equal(weakSource.requiresCarefulReview, true);
});

test("GET /pending carries the advisory lowConfidence review flag on each item", async () => {
  await app.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
  const res = await app.inject({ method: "GET", url: "/pending", headers: AUTH });
  assert.equal(res.statusCode, 200);
  const items = res.json().pending as Array<{ lowConfidence: unknown }>;
  assert.ok(items.length >= 1);
  for (const it of items) assert.equal(typeof it.lowConfidence, "boolean", "every pending item exposes lowConfidence");
});

test("CORS is same-origin by default and reflects only an exact configured allowlist origin", async () => {
  const hostile = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
  assert.equal(hostile.headers["access-control-allow-origin"], undefined);

  const local = await buildServer(deps({ corsOrigins: ["https://trusted.example"] }));
  await local.ready();
  try {
    const trusted = await local.inject({ method: "GET", url: "/health", headers: { origin: "https://trusted.example" } });
    assert.equal(trusted.headers["access-control-allow-origin"], "https://trusted.example");
    const evil = await local.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
  } finally {
    await local.close();
  }
});

test("reviewer APIs fail closed: missing/wrong credentials cannot read or execute, valid Bearer can", async () => {
  const localSinks = fakeSinks();
  const local = await buildServer(deps({ sinks: localSinks }));
  await local.ready();
  try {
    const intake = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    const id = intake.json().id;
    assert.equal((await local.inject({ method: "GET", url: "/pending" })).statusCode, 401);
    assert.equal(
      (await local.inject({ method: "POST", url: `/approve/${id}`, headers: { authorization: "Bearer wrong" } })).statusCode,
      401
    );
    assert.equal(localSinks.ledger.entries().length, 0, "unauthenticated callers reach no sink");
    const approved = await local.inject({ method: "POST", url: `/approve/${id}`, headers: AUTH });
    assert.equal(approved.statusCode, 200);
    assert.equal(localSinks.ledger.entries().length, 1);
  } finally {
    await local.close();
  }
});

test("reviewer APIs return 503 when REVIEWER_TOKEN is unconfigured; public health/UI remain available", async () => {
  const local = await buildServer(deps({ reviewerToken: null }));
  await local.ready();
  try {
    assert.equal((await local.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await local.inject({ method: "GET", url: "/" })).statusCode, 200);
    const denied = await local.inject({ method: "GET", url: "/pending" });
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().error, "reviewer service unavailable");
    assert.ok(typeof denied.json().requestId === "string" && denied.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(denied.json()), /token|configured/i);

    const notReady = await local.inject({ method: "GET", url: "/ready" });
    assert.equal(notReady.statusCode, 503);
    assert.deepEqual(Object.keys(notReady.json()).sort(), ["error", "requestId"]);
    assert.equal(notReady.json().error, "service not ready");
    assert.ok(typeof notReady.json().requestId === "string" && notReady.json().requestId.length > 0);
  } finally {
    await local.close();
  }
});

test("production startup fails closed when REVIEWER_TOKEN is absent from real configuration", async () => {
  const explicit = deps();
  delete (explicit as Partial<ServerDeps>).reviewerToken;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousToken = process.env.REVIEWER_TOKEN;
  process.env.NODE_ENV = "production";
  delete process.env.REVIEWER_TOKEN;
  try {
    await assert.rejects(
      () => buildServer(explicit),
      /production requires REVIEWER_TOKEN/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousToken === undefined) delete process.env.REVIEWER_TOKEN;
    else process.env.REVIEWER_TOKEN = previousToken;
  }
});

test("reviewer amendment/rejection bodies reject unknown fields and oversized audit reasons", async () => {
  const extra = await app.inject({
    method: "POST",
    url: "/reject/not-used",
    headers: AUTH,
    payload: { reason: "reviewed", unexpected: "not persisted" },
  });
  assert.equal(extra.statusCode, 400);

  const oversized = "x".repeat(1001);
  const amend = await app.inject({
    method: "POST",
    url: "/amend/not-used",
    headers: AUTH,
    payload: { reason: oversized },
  });
  const reject = await app.inject({
    method: "POST",
    url: "/reject/not-used",
    headers: AUTH,
    payload: { reason: oversized },
  });
  assert.equal(amend.statusCode, 400);
  assert.equal(reject.statusCode, 400);
});

test("GET /ready distinguishes liveness from dependency/security readiness", async () => {
  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().status, "ready");
  assert.equal(ready.json().checks.reviewerAuth.configured, true);
  assert.equal(ready.json().checks.qwen.probed, false);
});

test("POST /intake with an empty body → 400", async () => {
  const res = await app.inject({ method: "POST", url: "/intake", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /invoice/);
});

test("POST /intake accepts a MESSY invoice (permissive schema) and returns a pending proposal", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/intake",
    payload: { invoice: { supplier: "Contoso", amount: "€ 2.500,00", date: "not-a-date" } },
  });
  assert.equal(res.statusCode, 200);
  const item = res.json();
  assert.equal(item.status, "pending");
  assert.ok(item.proposed.tool);
  assert.ok(item.invoice.notes.length > 0); // the messiness was recorded, not rejected
});

test("approve on an unknown id → 404; approve twice → 409 (the gate over HTTP)", async () => {
  const intake = await app.inject({
    method: "POST",
    url: "/intake",
    payload: { invoice: { vendor: "Acme", invoice_number: "A-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 } },
  });
  const id = intake.json().id;

  const missing = await app.inject({ method: "POST", url: "/approve/nope", headers: AUTH });
  assert.equal(missing.statusCode, 404);

  const first = await app.inject({ method: "POST", url: `/approve/${id}`, headers: AUTH });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, "approved");

  const second = await app.inject({ method: "POST", url: `/approve/${id}`, headers: AUTH });
  assert.equal(second.statusCode, 409);
});

test("GET /pending lists proposals awaiting a decision", async () => {
  const res = await app.inject({ method: "GET", url: "/pending", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().pending));
});

test("GET / serves the approval UI as HTML (200, text/html)", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(res.body, /<!doctype html>/i);
  assert.match(res.body, /Archon Autopilot/);
  // The page wires the real approval endpoints (not a placeholder).
  assert.match(res.body, /\/pending/);
  assert.match(res.body, /\/approve\//);
});

test("GET / includes the guided tour + one-click demo (self-explanatory for a first-time visitor)", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  // One-line header explaining what the app is.
  assert.match(res.body, /it proposes, you approve/i);
  // One-click "Load sample invoice" demo button + its realistic payload.
  assert.match(res.body, /Load sample invoice/);
  assert.match(res.body, /id="loadSample"/);
  assert.match(res.body, /Meridian Logistics/);
  // First-visit guided tour: trigger button, engine, and localStorage first-visit flag.
  assert.match(res.body, /Take the tour/);
  assert.match(res.body, /id="tourBtn"/);
  assert.match(res.body, /id="tourOverlay"/);
  assert.match(res.body, /function startTour/);
  assert.match(res.body, /localStorage/);
  // Tour highlights the multi-step trace + the human gate.
  assert.match(res.body, /How the agent decided/);
  assert.match(res.body, /Nothing executes until you approve/);
  // Clear empty-state guidance instead of a blank list.
  assert.match(res.body, /No invoices in the queue/);
});

test("GET / ships the enriched UI: upload + live process view, collapsible trace, decided tab, charts", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  // Document/invoice upload + real-time process view (streamed over SSE).
  assert.match(res.body, /Upload an invoice/i);
  assert.match(res.body, /id="fileInput"/);
  assert.match(res.body, /id="processBtn"/);
  // The file picker accepts REAL documents (PDF/PNG/JPG), read by Qwen-VL.
  assert.match(res.body, /accept="\.pdf,\.png,\.jpg,\.jpeg/);
  assert.match(res.body, /Qwen-VL/);
  assert.match(res.body, /id="sampleDoc"/); // "Use sample document" button
  // The two-step review flow: the UI posts the file to the extract-only endpoint,
  // renders it for review, then processes the reviewed invoice over the SSE stream.
  assert.match(res.body, /\/extract\/document/); // step 1: extract-only upload
  assert.match(res.body, /\/intake\/stream/); // step 2: process the reviewed invoice (SSE)
  assert.match(res.body, /id="fileName"/); // selected-filename display
  assert.match(res.body, /Choose file/); // custom file-picker button (wired change handler)
  assert.match(res.body, /id="extractReview"/); // the extracted-invoice review panel
  assert.match(res.body, /review the extracted fields, then Process/); // the demo review note
  assert.match(res.body, /pendingTicket/); // single-use ticket → process without re-consuming
  assert.match(res.body, /getReader|text\/event-stream|Processing invoice/);
  // The durable two-tier rate limit is surfaced without hard-coding an env-tunable cap.
  assert.match(res.body, /rate-limited per visitor and globally/);
  // Collapsible "How the agent decided" trace (chevron toggle).
  assert.match(res.body, /How the agent decided/);
  assert.match(res.body, /class: 'collapsible'|collapsible/);
  assert.match(res.body, /chevron/);
  // Decided view fed by the real /decided endpoint + a decided tab.
  assert.match(res.body, /\/decided/);
  assert.match(res.body, /data-tab="decided"/);
  // Charts (inline SVG, no CDN / no build step) — pending clean-vs-flagged + decided.
  assert.match(res.body, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg'/);
  assert.match(res.body, /Clean/);
  assert.match(res.body, /Amended/);
});

test("GET /ui serves the same approval UI (alias)", async () => {
  const res = await app.inject({ method: "GET", url: "/ui" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
});

test("GET /openapi.json documents every workflow + approval route", async () => {
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const spec = res.json();
  assert.equal(spec.openapi?.startsWith("3."), true);
  assert.equal(spec.info?.title, "Archon Autopilot API");
  for (const path of ["/health", "/ready", "/intake", "/pending", "/approve/{id}", "/amend/{id}", "/reject/{id}", "/recover/{id}"]) {
    assert.ok(spec.paths?.[path], `spec should document ${path}`);
  }
});

test("GET /docs serves the interactive Swagger UI", async () => {
  const res = await app.inject({ method: "GET", url: "/docs" });
  assert.ok([200, 301, 302].includes(res.statusCode));
  if (res.statusCode >= 300) {
    const follow = await app.inject({ method: "GET", url: res.headers.location as string });
    assert.equal(follow.statusCode, 200);
  }
});

test("GET /decided lists decided items (empty array on a fresh app)", async () => {
  const res = await app.inject({ method: "GET", url: "/decided", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().decided));
});

test("upload rate limit: a per-client cap of 20/day means the 21st upload from that client → 429 (open-demo budget guard)", async () => {
  // A dedicated app so the shared `before` app's usage does not affect the count,
  // and a pinned clock so all 21 uploads land in the same UTC day.
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(20, () => new Date("2026-07-06T09:00:00Z")) }));
  await local.ready();
  try {
    for (let i = 1; i <= 20; i++) {
      const ok = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
      assert.equal(ok.statusCode, 200, `upload #${i} should be accepted`);
    }
    const over = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(over.statusCode, 429);
    assert.match(over.json().error, /daily upload limit/i);
    assert.equal(over.json().limit, 20);
    // The streaming upload shares the same budget — also 429 once over.
    const overStream = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice } });
    assert.equal(overStream.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("rate limit is PER-CLIENT over HTTP: one client's exhausted budget does not 429 another (X-Forwarded-For)", async () => {
  // Per-client cap of 1, pinned clock. Client A exhausts its slot; client B (a
  // different X-Forwarded-For) still gets its own. This is the judging-window fix:
  // one busy visitor cannot lock the next judge out on their first upload.
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1, () => new Date("2026-07-06T09:00:00Z")) }));
  await local.ready();
  try {
    const a1 = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.1" }, payload: { invoice: sampleInvoice } });
    assert.equal(a1.statusCode, 200);
    const a2 = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.1" }, payload: { invoice: sampleInvoice } });
    assert.equal(a2.statusCode, 429, "client A is over its own cap");
    // A different client is NOT affected.
    const b1 = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.2" }, payload: { invoice: sampleInvoice } });
    assert.equal(b1.statusCode, 200, "client B has its own independent budget");
  } finally {
    await local.close();
  }
});

test("rate limit: an invalid payload is a 400 and does NOT consume budget", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // Two empty-body 400s must not exhaust the budget-of-1 …
    for (let i = 0; i < 2; i++) {
      const bad = await local.inject({ method: "POST", url: "/intake", payload: {} });
      assert.equal(bad.statusCode, 400);
    }
    // … so the one real upload still succeeds.
    const ok = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(ok.statusCode, 200);
  } finally {
    await local.close();
  }
});

test("POST /intake/document: a real PNG upload → Qwen-VL extraction → the loop → a PENDING proposal (SSE), executing nothing", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const { payload, headers } = multipartFile("file", "sample-invoice.png", "image/png", PNG_BYTES);
    const res = await local.inject({ method: "POST", url: "/intake/document", payload, headers });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    // The stream shows extraction, then the live loop steps, then the proposal.
    assert.match(res.body, /event: extracting/);
    assert.match(res.body, /event: extracted/);
    assert.match(res.body, /Meridian Logistics/); // the fake-extracted invoice fields
    assert.match(res.body, /event: step/);
    assert.match(res.body, /recall_vendor_history/);
    assert.match(res.body, /event: proposal/);
    assert.match(res.body, /event: done/);
    // The human gate held: exactly one PENDING item, nothing executed, /decided empty.
    const pending = (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].execution, undefined);
    assert.equal(pending[0].invoice.vendor, "Meridian Logistics");
    const decided = (await local.inject({ method: "GET", url: "/decided", headers: AUTH })).json().decided;
    assert.equal(decided.length, 0);
  } finally {
    await local.close();
  }
});

test("POST /intake/document rejects an unsupported type (400) WITHOUT burning the daily budget", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // A .txt is rejected with 400 …
    const bad = multipartFile("file", "notes.txt", "text/plain", "hello");
    const badRes = await local.inject({ method: "POST", url: "/intake/document", payload: bad.payload, headers: bad.headers });
    assert.equal(badRes.statusCode, 400);
    // … and did NOT consume the budget-of-1, so a valid PNG still succeeds.
    const ok = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const okRes = await local.inject({ method: "POST", url: "/intake/document", payload: ok.payload, headers: ok.headers });
    assert.equal(okRes.statusCode, 200);
  } finally {
    await local.close();
  }
});

test("POST /intake/document shares the daily budget — the 2nd upload → 429 (open-demo guard)", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    const one = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const first = await local.inject({ method: "POST", url: "/intake/document", payload: one.payload, headers: one.headers });
    assert.equal(first.statusCode, 200);
    const two = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const over = await local.inject({ method: "POST", url: "/intake/document", payload: two.payload, headers: two.headers });
    assert.equal(over.statusCode, 429);
    assert.match(over.json().error, /daily upload limit/i);
    // The JSON intake shares the SAME exhausted budget.
    const overJson = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(overJson.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("POST /extract/document: a PNG upload → Qwen-VL extraction → invoice JSON + a ticket, running NO loop", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const { payload, headers } = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const res = await local.inject({ method: "POST", url: "/extract/document", payload, headers });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // The extracted invoice is returned for review …
    assert.equal(body.invoice.vendor, "Meridian Logistics");
    assert.equal(body.invoice.total, 6448);
    assert.equal(body.sourceType, "image");
    // … with a single-use process ticket …
    assert.ok(typeof body.ticket === "string" && body.ticket.length > 0);
    // … and NOTHING was proposed or executed: the queue is still empty.
    const pending = (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending;
    assert.equal(pending.length, 0);
  } finally {
    await local.close();
  }
});

test("POST /extract/document surfaces an extractor failure as 502 (the vision call failed)", async () => {
  const failing = {
    modelId: "boom-vision",
    async extract() { throw new Error("vision backend unavailable"); },
  };
  const local = await buildServer(deps({ extractor: failing }));
  await local.ready();
  try {
    const { payload, headers } = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const res = await local.inject({ method: "POST", url: "/extract/document", payload, headers });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "document extraction service unavailable");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /vision backend unavailable/);

    const streamed = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const streamRes = await local.inject({ method: "POST", url: "/intake/document", payload: streamed.payload, headers: streamed.headers });
    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.body, /event: error/);
    assert.match(streamRes.body, /requestId/);
    assert.doesNotMatch(streamRes.body, /vision backend unavailable/);
  } finally {
    await local.close();
  }
});

test("POST /extract/document rejects an unsupported type (400) WITHOUT burning the daily budget", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    const bad = multipartFile("file", "notes.txt", "text/plain", "hello");
    const badRes = await local.inject({ method: "POST", url: "/extract/document", payload: bad.payload, headers: bad.headers });
    assert.equal(badRes.statusCode, 400);
    // Budget-of-1 intact → a valid extract still succeeds.
    const ok = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const okRes = await local.inject({ method: "POST", url: "/extract/document", payload: ok.payload, headers: ok.headers });
    assert.equal(okRes.statusCode, 200);
  } finally {
    await local.close();
  }
});

test("two-step flow: extract consumes ONE slot, process-with-ticket consumes NONE (open-demo budget honored once)", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // Extract consumes the only slot and mints a ticket.
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({ method: "POST", url: "/extract/document", payload: up.payload, headers: up.headers });
    assert.equal(ex.statusCode, 200);
    const ticket = ex.json().ticket;
    const invoice = ex.json().invoice;
    // Processing the reviewed invoice WITH the ticket runs the loop WITHOUT a 2nd slot.
    const proc = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice, ticket } });
    assert.equal(proc.statusCode, 200);
    assert.match(proc.body, /event: proposal/);
    // Exactly one PENDING proposal, nothing executed (the human gate held).
    const pending = (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].execution, undefined);
    // The budget is now exhausted for a NON-ticketed intake → 429.
    const over = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(over.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("a process ticket is single-use: replaying the SAME ticket consumes the daily budget the second time", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(2) }));
  await local.ready();
  try {
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({ method: "POST", url: "/extract/document", payload: up.payload, headers: up.headers });
    const ticket = ex.json().ticket; // consumed slot #1
    const invoice = ex.json().invoice;
    // First use: free (ticket valid) — budget still has 1 left.
    const first = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice, ticket } });
    assert.equal(first.statusCode, 200);
    // Replay the SAME ticket: it is spent, so this consumes slot #2 …
    const second = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice, ticket } });
    assert.equal(second.statusCode, 200);
    // … and the budget of 2 is now exhausted.
    const third = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(third.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("an unknown ticket does not skip the limiter (no free bypass)", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // A made-up ticket must NOT grant free processing: it consumes the slot …
    const first = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice, ticket: "not-a-real-ticket" } });
    assert.equal(first.statusCode, 200);
    // … so the next intake is over budget.
    const over = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(over.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("GET /sample-document serves the committed sample invoice PNG", async () => {
  const res = await app.inject({ method: "GET", url: "/sample-document" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /image\/png/);
  // PNG magic bytes — a real, uncorrupted image (not text-normalized).
  assert.equal(res.rawPayload.subarray(0, 4).toString("latin1"), "\x89PNG");
  assert.ok(res.rawPayload.length > 1000);
});

test("security headers: helmet sets X-Frame-Options + X-Content-Type-Options on responses", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.headers["x-content-type-options"]).toLowerCase(), "nosniff");
  assert.ok(res.headers["x-frame-options"], "X-Frame-Options is set");
});

test("POST /intake sanitizes an upstream decider failure and returns a request id", async () => {
  // A loop whose run() throws models Qwen/the embedder being unreachable. The route
  // must translate that into a clean 503 { error }, not a generic 500.
  const boomLoop = {
    modelId: "boom",
    async run() { throw new Error("qwen unreachable"); },
  } as unknown as ServerDeps["loop"];
  const local = await buildServer(deps({ loop: boomLoop }));
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "decision service unavailable");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /qwen unreachable/);

    const streamRes = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice } });
    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.body, /event: error/);
    assert.match(streamRes.body, /requestId/);
    assert.doesNotMatch(streamRes.body, /qwen unreachable/);
  } finally {
    await local.close();
  }
});

test("global error handler: unexpected DB details stay in logs and the 500 returns only a generic error + request id", async () => {
  // A work-item store whose approve() throws a generic error exercises the guard()
  // rethrow → the global setErrorHandler, which must answer { error } (not a stack).
  const throwingStore = new InMemoryWorkItemStore();
  throwingStore.get = async () => { throw new Error("db exploded"); };
  throwingStore.claimPending = async () => { throw new Error("db exploded"); };
  const local = await buildServer(deps({ workitems: throwingStore }));
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/approve/anything", headers: AUTH });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(Object.keys(res.json()).sort(), ["error", "requestId"]);
    assert.equal(res.json().error, "internal server error");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /db exploded|at .*\(.*:\d+:\d+\)/);
  } finally {
    await local.close();
  }
});

test("approval 502 does not expose an uncertain sink failure detail", async () => {
  const localSinks = fakeSinks();
  localSinks.ledger.post = () => {
    throw new Error("SECRET ledger transport response");
  };
  const local = await buildServer(deps({ sinks: localSinks }));
  await local.ready();
  try {
    const intake = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    const res = await local.inject({ method: "POST", url: `/approve/${intake.json().id}`, headers: AUTH });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "execution could not be confirmed; reconcile it before retrying");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /SECRET|ledger transport/i);
  } finally {
    await local.close();
  }
});

test("approval gate: a malformed :id that hits a uuid column (Postgres 22P02) → 400, not a 500 leak", async () => {
  // Simulate the pgvector store rejecting a non-UUID id with SQLSTATE 22P02.
  const pgLikeStore = new InMemoryWorkItemStore();
  const invalidUuid = () =>
    Promise.reject(Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: "22P02" }));
  pgLikeStore.get = invalidUuid;
  pgLikeStore.claimPending = invalidUuid;
  const local = await buildServer(deps({ workitems: pgLikeStore }));
  await local.ready();
  try {
    for (const route of ["/approve/not-a-uuid", "/amend/not-a-uuid", "/reject/not-a-uuid"]) {
      const res = await local.inject({ method: "POST", url: route, headers: AUTH, payload: {} });
      assert.equal(res.statusCode, 400, `${route} should be 400`);
      assert.match(res.json().error, /invalid work item id/i);
    }
  } finally {
    await local.close();
  }
});

test("POST /intake/stream streams the reasoning live (SSE) then the proposal, executing nothing", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    // The stream carries live step events, then the final proposal + done.
    assert.match(res.body, /event: step/);
    assert.match(res.body, /recall_vendor_history/);
    assert.match(res.body, /event: proposal/);
    assert.match(res.body, /event: done/);
    // It only PROPOSED — the item sits PENDING in the queue, nothing executed.
    const pending = await local.inject({ method: "GET", url: "/pending", headers: AUTH });
    assert.equal(pending.json().pending.length, 1);
    assert.equal(pending.json().pending[0].status, "pending");
    assert.equal(pending.json().pending[0].execution, undefined);
  } finally {
    await local.close();
  }
});
