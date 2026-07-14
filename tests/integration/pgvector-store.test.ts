// Integration — the real pgvector-backed stores against a live PostgreSQL (the CI
// service container, or a local `docker compose up -d db`). Exercises the DB seam
// that the in-memory doubles stand in for: vector recall over agent_memory and
// the JSONB work-item queue over ap_workitems. Same pg-wire + SQL as Alibaba Cloud.
//
// SKIPPED automatically when DATABASE_URL is unset, so `npm test` stays green on a
// bare clone with no database. In CI the schema is applied first (npm run db:schema).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { PgVectorStore } from "../../src/memory/store.js";
import { PgWorkItemStore } from "../../src/ap/workitem-store.js";
import { PostgresDailyRateLimiter } from "../../src/ap/rate-limit.js";
import { remember, recall } from "../../src/memory/memory.js";
import { closePool, query } from "../../src/db/client.js";
import type { WorkItem } from "../../src/types.js";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed integration";
const VENDOR = `IntegVendor-${Date.now()}`;

after(async () => {
  if (!skip) await closePool();
});

test("PgVectorStore: remember then recall ranks the closest memory first", { skip }, async () => {
  const e = new FakeEmbedder();
  const store = new PgVectorStore();
  await remember(e, store, { kind: "invoice", vendor: VENDOR, content: `${VENDOR} invoice INV-1 for EUR 1000`, metadata: { total: 1000 } });
  await remember(e, store, { kind: "invoice", vendor: VENDOR, content: `${VENDOR} invoice INV-2 for EUR 2000`, metadata: { total: 2000 } });

  const hits = await recall(e, store, `${VENDOR} invoice INV-1`, { vendor: VENDOR, limit: 5 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.content, /INV-1/);
  assert.ok(hits[0]!.score >= hits[hits.length - 1]!.score);
});

test("PgWorkItemStore: create → listPending → update round-trips the JSONB item", { skip }, async () => {
  const store = new PgWorkItemStore();
  const item: WorkItem = {
    id: `11111111-1111-4111-8111-${Date.now().toString().slice(-12).padStart(12, "0")}`,
    status: "pending",
    invoice: {
      invoice_id: "inv-int-1", vendor: VENDOR, vendor_ref: "INV-1", invoice_date: "2026-01-01",
      currency: "EUR", subtotal: 1000, tax: 0, tax_id: "T", total: 1000, line_items: [], notes: [], raw: {},
    },
    findings: [],
    recalled: [],
    proposed: { tool: "draft_journal_entry", args: { amount: 1000 }, reasoning: "r", confidence: 0.8, modelId: "test" },
    trace: [{ step: 1, tool: "recall_vendor_history", args: {}, observation: "new vendor", reasoning: "establish history" }],
    stopReason: "terminal_action",
    createdAt: new Date().toISOString(),
  };
  await store.create(item);

  const pending = await store.listPending();
  assert.ok(pending.some((p) => p.id === item.id));

  const claimed = await store.claimPending(item.id);
  assert.equal(claimed?.status, "executing");
  claimed!.status = "approved";
  claimed!.execution = { tool: "draft_journal_entry", ok: true, summary: "done", output: {} };
  assert.equal(await store.finishExecuting(claimed!), true);

  const fetched = await store.get(item.id);
  assert.equal(fetched?.status, "approved");
  assert.equal(fetched?.execution?.ok, true);
  // The loop trace survives the JSONB round-trip (no new column needed).
  assert.equal(fetched?.trace.length, 1);
  assert.equal(fetched?.trace[0]?.tool, "recall_vendor_history");
  // No longer in the pending queue.
  assert.equal((await store.listPending()).some((p) => p.id === item.id), false);
});

test("PgVectorStore: vendor recall uses the same NFKC key for Unicode variants", { skip }, async () => {
  const e = new FakeEmbedder();
  const store = new PgVectorStore();
  const wideVendor = `ＵＮＩＣＯＤＥ-${Date.now()}`;
  const asciiVendor = wideVendor.normalize("NFKC");
  await remember(e, store, {
    kind: "insight",
    vendor: wideVendor,
    sourceRef: `unicode-${Date.now()}`,
    content: `${wideVendor} approved correction`,
  });

  const hits = await recall(e, store, "approved correction", { vendor: asciiVendor, kind: "insight", limit: 5 });
  assert.ok(hits.some((hit) => hit.vendor === wideVendor));
});

test("PgWorkItemStore: atomic live dedupe preserves distinct non-empty invoice refs", { skip }, async () => {
  const store = new PgWorkItemStore();
  const nonce = Date.now().toString().slice(-12).padStart(12, "0");
  const vendor = `${VENDOR}-distinct-refs`;
  const base: WorkItem = {
    id: `22222222-2222-4222-8222-${nonce}`,
    status: "pending",
    invoice: {
      invoice_id: "inv-ref-a", vendor, vendor_ref: "REF-A", invoice_date: "2026-04-05",
      currency: "EUR", subtotal: 100, tax: 0, tax_id: "T", total: 100, line_items: [], notes: [], raw: {},
    },
    findings: [], recalled: [],
    proposed: { tool: "draft_journal_entry", args: { amount: 100 }, reasoning: "r", confidence: 0.8, modelId: "test" },
    trace: [], stopReason: "terminal_action", createdAt: new Date().toISOString(),
  };
  const second: WorkItem = structuredClone(base);
  second.id = `33333333-3333-4333-8333-${nonce}`;
  second.invoice.invoice_id = "inv-ref-b";
  second.invoice.vendor_ref = "REF-B";

  try {
    const [leftExisting, rightExisting] = await Promise.all([store.create(base), store.create(second)]);
    assert.equal(leftExisting, null);
    assert.equal(rightExisting, null);
    const pending = await store.listPending();
    assert.equal(pending.filter((item) => item.id === base.id || item.id === second.id).length, 2);
  } finally {
    await query(`DELETE FROM ap_workitems WHERE id IN ($1, $2)`, [base.id, second.id]);
  }
});

test("PgWorkItemStore: live dedupe uses the same NFKC vendor key as the in-memory store", { skip }, async () => {
  const store = new PgWorkItemStore();
  const nonce = Date.now().toString().slice(-12).padStart(12, "0");
  // Keep every dedupe component unique to this run. Unit and integration suites share
  // the CI service database, so fixed ACME/UNICODE-1 fixtures can collide with a row
  // inserted by an earlier test and turn this two-request assertion into 2 existing
  // rows. The full-width and ASCII vendors still normalize to the same NFKC key.
  const fullWidthVendor = `ＡＣＭＥ-${nonce}`;
  const asciiVendor = `ACME-${nonce}`;
  const vendorRef = `UNICODE-${nonce}`;
  const make = (id: string, vendor: string, invoiceId: string): WorkItem => ({
    id,
    status: "pending",
    invoice: {
      invoice_id: invoiceId, vendor, vendor_ref: vendorRef, invoice_date: "2026-04-06",
      currency: "EUR", subtotal: 25, tax: 0, tax_id: "T", total: 25, line_items: [], notes: [], raw: {},
    },
    findings: [], recalled: [],
    proposed: { tool: "draft_journal_entry", args: { amount: 25 }, reasoning: "r", confidence: 0.8, modelId: "test" },
    trace: [], stopReason: "terminal_action", createdAt: new Date().toISOString(),
  });
  const fullWidth = make(`44444444-4444-4444-8444-${nonce}`, fullWidthVendor, `inv-wide-${nonce}`);
  const ascii = make(`55555555-5555-4555-8555-${nonce}`, asciiVendor, `inv-ascii-${nonce}`);

  try {
    const outcomes = await Promise.all([store.create(fullWidth), store.create(ascii)]);
    assert.equal(outcomes.filter((value) => value === null).length, 1);
    assert.equal(outcomes.filter((value) => value !== null).length, 1);
    const pending = await store.listPending();
    assert.equal(pending.filter((item) => item.id === fullWidth.id || item.id === ascii.id).length, 1);
  } finally {
    await query(`DELETE FROM ap_workitems WHERE id IN ($1, $2)`, [fullWidth.id, ascii.id]);
  }
});

test("PostgresDailyRateLimiter atomically enforces the global tier across concurrent clients", { skip }, async () => {
  const day = `2099-12-${String((Date.now() % 20) + 1).padStart(2, "0")}`;
  const now = () => new Date(`${day}T12:00:00Z`);
  await query(`DELETE FROM ap_daily_quota WHERE day = $1::date`, [day]);
  try {
    const limiter = new PostgresDailyRateLimiter(1, now, 1);
    const [a, b] = await Promise.all([limiter.consume("concurrent-a"), limiter.consume("concurrent-b")]);
    assert.equal([a, b].filter((r) => r.allowed).length, 1);
    assert.equal([a, b].filter((r) => !r.allowed && r.scope === "global").length, 1);
  } finally {
    await query(`DELETE FROM ap_daily_quota WHERE day = $1::date`, [day]);
  }
});
