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
import { remember, recall } from "../../src/memory/memory.js";
import { closePool } from "../../src/db/client.js";
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

  item.status = "approved";
  item.execution = { tool: "draft_journal_entry", ok: true, summary: "done", output: {} };
  await store.update(item);

  const fetched = await store.get(item.id);
  assert.equal(fetched?.status, "approved");
  assert.equal(fetched?.execution?.ok, true);
  // The loop trace survives the JSONB round-trip (no new column needed).
  assert.equal(fetched?.trace.length, 1);
  assert.equal(fetched?.trace[0]?.tool, "recall_vendor_history");
  // No longer in the pending queue.
  assert.equal((await store.listPending()).some((p) => p.id === item.id), false);
});
