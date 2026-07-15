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

test("stable outcome idempotency keys return one row only for the exact same logical payload", async () => {
  const e = new FakeEmbedder();
  const store = new InMemoryStore();
  const input = {
    idempotencyKey: "work-item:test:outcome:action:v1",
    kind: "action" as const,
    vendor: "Acme",
    content: "approved action",
  };
  const first = await remember(e, store, input);
  const unavailableEmbedder = {
    modelId: "unavailable-test-embedder",
    dim: e.dim,
    embed: async () => {
      throw new Error("embedding provider unavailable");
    },
  };
  const retry = await remember(unavailableEmbedder, store, {
    ...input,
  });
  assert.equal(retry, first);
  assert.equal(await store.count("Acme"), 1);
  const hits = await recall(e, store, "approved action", { vendor: "Acme" });
  assert.equal(hits[0]!.content, "approved action", "the first committed evidence remains authoritative");
  await assert.rejects(
    remember(e, store, { ...input, content: "different summary under the same key" }),
    /idempotency key was reused for a different logical payload/i
  );
  await assert.rejects(
    remember(e, store, { ...input, metadata: { changed: true } }),
    /idempotency key was reused for a different logical payload/i
  );
  assert.equal(await store.count("Acme"), 1);
});

test("semantic recall filters exact embed_model and reports incompatible migration rows", async () => {
  const base = new FakeEmbedder(32);
  const modelA = { modelId: "embed-a", dim: base.dim, embed: (text: string, signal?: AbortSignal) => base.embed(text, signal) };
  const modelB = { modelId: "embed-b", dim: base.dim, embed: (text: string, signal?: AbortSignal) => base.embed(text, signal) };
  const store = new InMemoryStore();
  await remember(modelA, store, { kind: "insight", vendor: "Acme", content: "model A private fact" });
  await remember(modelB, store, { kind: "insight", vendor: "Acme", content: "model B private fact" });
  const a = await recall(modelA, store, "private fact", { vendor: "Acme", limit: 10 });
  assert.deepEqual(a.map((hit) => hit.content), ["model A private fact"]);
  const stats = await store.embeddingModelStats("embed-a");
  assert.deepEqual(stats, { current: 1, other: 1, models: { "embed-a": 1, "embed-b": 1 } });
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
    assert.match(sql, /ON CONFLICT \(idempotency_key\)/);
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
