// Agent memory — the persistent foundation the autopilot reasons over.
//
// This module pairs an Embedder with a MemoryStore to give the AP agent a
// persistent, semantic memory:
//   remember() : embed a natural-language fact and durably store it + metadata
//   recall()   : embed a query and run ANN vector search (cosine) for top-k
//
// Every durable thing the autopilot learns — a vendor's usual invoice amount, a
// processed invoice (for duplicate detection), an executed action outcome —
// becomes a memory. On the next invoice, even in a different session or process,
// the agent recalls the relevant prior facts by MEANING and grounds its decision
// in them instead of starting cold. That persistent memory is the foundation the
// Track-4 autopilot is built on (it layers directly on the Track-1 MemoryAgent).

import type { Embedder } from "./embeddings.js";
import type { MemoryInput, MemoryStore, RecallHit, RecallOptions } from "./store.js";

// Embed `content` and persist the memory through the store. Returns the row id.
export async function remember(
  embedder: Embedder,
  store: MemoryStore,
  input: MemoryInput
): Promise<string> {
  const embedding = await embedder.embed(input.content);
  return store.remember({ ...input, embedding, embedModel: embedder.modelId });
}

// Recall the top-k memories most semantically similar to `queryText`, optionally
// pre-filtered by kind/vendor. The query is embedded with the SAME model the
// memories were written with, then ranked by cosine distance in the store.
export async function recall(
  embedder: Embedder,
  store: MemoryStore,
  queryText: string,
  opts: RecallOptions = {}
): Promise<RecallHit[]> {
  const qvec = await embedder.embed(queryText);
  return store.recall(qvec, opts);
}
