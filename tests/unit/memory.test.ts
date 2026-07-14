// Unit — the memory foundation: remember() + recall() over the InMemoryStore
// (same cosine ranking as pgvector), with kind/vendor pre-filters. No DB, no key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore, PgVectorStore } from "../../src/memory/store.js";
import { query as databaseQuery } from "../../src/db/client.js";
import { recall, remember } from "../../src/memory/memory.js";

test("remember then recall returns the most semantically similar memory first", async () => {
  const e = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(e, store, { kind: "invoice", vendor: "Northwind", content: "Northwind Supplies invoice NW-1001 for EUR 1200" });
  await remember(e, store, { kind: "invoice", vendor: "Contoso", content: "Contoso Ltd invoice CO-9 for EUR 500" });

  const hits = await recall(e, store, "Northwind Supplies invoice", { limit: 2 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.content, /Northwind/);
  assert.ok(hits[0]!.score >= hits[hits.length - 1]!.score);
});

test("recall respects the vendor pre-filter", async () => {
  const e = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(e, store, { kind: "invoice", vendor: "Northwind", content: "Northwind invoice A" });
  await remember(e, store, { kind: "invoice", vendor: "Contoso", content: "Contoso invoice B" });

  const hits = await recall(e, store, "invoice", { vendor: "Contoso" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.vendor, "Contoso");
});

test("recall respects the kind pre-filter", async () => {
  const e = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(e, store, { kind: "invoice", vendor: "Acme", content: "Acme invoice" });
  await remember(e, store, { kind: "action", vendor: "Acme", content: "Approved payment to Acme" });

  const hits = await recall(e, store, "Acme", { kind: "action" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, "action");
});

test("count reflects what was remembered, and clear empties the store", async () => {
  const e = new FakeEmbedder();
  const store = new InMemoryStore();
  await remember(e, store, { kind: "insight", content: "one" });
  await remember(e, store, { kind: "insight", content: "two" });
  assert.equal(await store.count(), 2);
  await store.clear();
  assert.equal(await store.count(), 0);
});

test("deterministic invoice history excludes pending/rejected facts and keeps approved facts", async () => {
  const e = new FakeEmbedder();
  const store = new InMemoryStore();
  const base = { kind: "invoice" as const, vendor: "Acme", content: "Acme invoice" };
  await remember(e, store, { ...base, sourceRef: "pending", metadata: { vendor: "Acme", processing_status: "pending" } });
  await remember(e, store, { ...base, sourceRef: "rejected", metadata: { vendor: "Acme", processing_status: "rejected" } });
  await remember(e, store, { ...base, sourceRef: "approved", metadata: { vendor: "Acme", processing_status: "approved" } });

  const history = await store.invoiceHistory("  ACME  ");
  assert.deepEqual(history.map((h) => h.sourceRef), ["approved"]);
});

test("PgVectorStore remember writes only to its configured database", async () => {
  let calls = 0;
  const fakeQuery = (async (sql: string) => {
    calls += 1;
    assert.match(sql, /INSERT INTO agent_memory/);
    return [{ id: "11111111-1111-4111-8111-111111111111" }];
  }) as typeof databaseQuery;
  const store = new PgVectorStore(fakeQuery);

  const id = await store.remember({
    kind: "invoice",
    vendor: "Private Tenant Vendor",
    sourceRef: "private-1",
    content: "tenant-scoped invoice fact",
    metadata: { processing_status: "approved" },
    embedding: [1, 0],
    embedModel: "test",
  });

  assert.equal(id, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls, 1, "default remember must not open or double-write to another database");
});
