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

let app: FastifyInstance;

function deps(): ServerDeps {
  return {
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks: fakeSinks(),
  };
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

test("CORS: a cross-origin GET reflects the request origin", async () => {
  const origin = "https://autopilot.example.com";
  const res = await app.inject({ method: "GET", url: "/health", headers: { origin } });
  assert.equal(res.headers["access-control-allow-origin"], origin);
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

  const missing = await app.inject({ method: "POST", url: "/approve/nope" });
  assert.equal(missing.statusCode, 404);

  const first = await app.inject({ method: "POST", url: `/approve/${id}` });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, "approved");

  const second = await app.inject({ method: "POST", url: `/approve/${id}` });
  assert.equal(second.statusCode, 409);
});

test("GET /pending lists proposals awaiting a decision", async () => {
  const res = await app.inject({ method: "GET", url: "/pending" });
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
  for (const path of ["/health", "/intake", "/pending", "/approve/{id}", "/amend/{id}", "/reject/{id}"]) {
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
