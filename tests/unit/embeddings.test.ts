// Unit — the offline FakeEmbedder: correct dimensionality, determinism, and the
// semantic-overlap property that makes cosine recall meaningful without a key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { cosineSimilarity } from "../../src/memory/store.js";

test("FakeEmbedder produces vectors of the configured dimension", async () => {
  const e = new FakeEmbedder(1024);
  const v = await e.embed("Northwind Supplies invoice");
  assert.equal(v.length, 1024);
  assert.equal(e.dim, 1024);
  assert.equal(e.modelId, "fake-hash-embedder");
});

test("FakeEmbedder is deterministic — same text → identical vector", async () => {
  const e = new FakeEmbedder(256);
  const a = await e.embed("invoice NW-1001 from Northwind");
  const b = await e.embed("invoice NW-1001 from Northwind");
  assert.deepEqual(a, b);
});

test("FakeEmbedder output is L2-normalized (unit length)", async () => {
  const e = new FakeEmbedder(512);
  const v = await e.embed("Contoso Ltd payment 1200 EUR");
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
});

test("overlapping text is more cosine-similar than unrelated text", async () => {
  const e = new FakeEmbedder(1024);
  const q = await e.embed("Northwind Supplies invoice payment");
  const near = await e.embed("Northwind Supplies invoice");
  const far = await e.embed("unrelated aardvark umbrella xylophone");
  assert.ok(cosineSimilarity(q, near) > cosineSimilarity(q, far));
});
