// Embedding provider for agent memory.
//
// Production path: Qwen `text-embedding-v4` on Alibaba Cloud Model Studio
// (DashScope), called via the OpenAI-compatible endpoint → 1024-dim vectors,
// matching the vector(1024) memory column. text-embedding-v4's default
// dimension is 1024, so we request it explicitly and assert it back.
//
// Everything is INJECTABLE via the `Embedder` interface so the memory layer, the
// demo script, and unit tests can run with NO DashScope key against a
// deterministic local fake. Same contract, same dimensionality.

import {
  createQwenClient,
  hasQwenCreds,
  type QwenEmbeddingsClient,
} from "../qwen/client.js";

export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 1024);
export const DEFAULT_EMBED_MODEL =
  process.env.QWEN_EMBED_MODEL || "text-embedding-v4";

export interface Embedder {
  readonly modelId: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

// Qwen text-embedding via the OpenAI-compatible Model Studio endpoint.
export class QwenEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim: number;
  constructor(
    private client: QwenEmbeddingsClient = createQwenClient(),
    modelId: string = DEFAULT_EMBED_MODEL,
    dim: number = EMBED_DIM
  ) {
    this.modelId = modelId;
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: this.modelId,
      input: text,
      dimensions: this.dim,
    });
    const vec = res.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== this.dim) {
      throw new Error(
        `Qwen embeddings returned ${vec?.length ?? "no"} dims, expected ${this.dim}`
      );
    }
    return vec;
  }
}

// Deterministic, dependency-free embedder for key-free dev + CI. Hashes tokens
// into a bag-of-words vector and L2-normalizes it, so semantically overlapping
// text lands in a similar direction under cosine distance. NOT for production
// recall quality — it exists so the full memory round trip runs offline.
export class FakeEmbedder implements Embedder {
  readonly modelId = "fake-hash-embedder";
  readonly dim: number;
  constructor(dim: number = EMBED_DIM) {
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

// Pick the provider by environment: real Qwen when a DashScope key is present,
// the deterministic fake otherwise. Callers can always inject their own.
export function defaultEmbedder(): Embedder {
  return hasQwenCreds() ? new QwenEmbedder() : new FakeEmbedder();
}
