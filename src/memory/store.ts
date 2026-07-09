// Memory store — the persistence seam of the agent's memory foundation.
//
// A `MemoryStore` durably holds embedded memories and answers approximate-
// nearest-neighbour recall over them. Two implementations behind one interface:
//
//   PgVectorStore  — production / CI. pgvector on a PostgreSQL-wire database.
//                    Local + CI: a stock pgvector/pgvector docker image.
//                    Production: Alibaba Cloud AnalyticDB for PostgreSQL or
//                    ApsaraDB RDS for PostgreSQL (pgvector) — same pg-wire, same
//                    SQL, so the store code is identical across all three.
//   InMemoryStore  — dependency-free double. Same cosine ranking, no infra, so
//                    the whole autopilot workflow runs offline with zero creds.
//
// This is the abstraction that makes the agent's memory PERSISTENT and CROSS-
// SESSION: a memory written while approving one invoice is recalled when a later,
// completely separate session processes the next invoice from that vendor —
// because both point PgVectorStore at the same Alibaba Cloud database.

import { randomUUID } from "node:crypto";
import { query, toVectorLiteral } from "../db/client.js";
import { Pool } from "pg";

let memoryAgentPool: Pool | null = null;

function getMemoryAgentPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (memoryAgentPool) return memoryAgentPool;

  const postgresUrl = url.replace(/\/([^\/]+)$/, "/postgres");
  memoryAgentPool = new Pool({
    connectionString: postgresUrl,
    max: 2,
    application_name: "archon-qwen-autopilot-sync",
  });
  return memoryAgentPool;
}

// The kinds of durable fact the autopilot remembers. `vendor` = a learned vendor
// profile, `invoice` = a processed invoice (for duplicate detection), `action` =
// an executed AP action outcome, `insight` = a salient learning.
export type MemoryKind = "vendor" | "invoice" | "action" | "insight";

export interface MemoryInput {
  kind: MemoryKind;
  vendor?: string; // defaults to '_global'
  sourceRef?: string | null; // originating id (invoice id, work-item id, …)
  content: string; // the recallable natural-language fact
  metadata?: Record<string, unknown> | null;
  importance?: number; // 0..1 salience, defaults to 0.5
}

// A memory ready to persist: the input plus its embedding + which model made it.
export interface StoredMemory extends MemoryInput {
  embedding: number[];
  embedModel: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  vendor: string;
  sourceRef: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecallHit extends MemoryRecord {
  distance: number; // cosine distance (0 = identical direction, 2 = opposite)
  score: number; // cosine SIMILARITY (1 - distance) — the real semantic closeness
}

export interface RecallOptions {
  kind?: MemoryKind; // pre-filter
  vendor?: string; // pre-filter
  limit?: number; // top-k, default 5
}

export interface MemoryStore {
  remember(m: StoredMemory): Promise<string>;
  recall(queryVec: number[], opts?: RecallOptions): Promise<RecallHit[]>;
  count(vendor?: string): Promise<number>;
  clear(): Promise<void>;
}

// ── pgvector-backed store (production + CI + Alibaba Cloud) ────────────────────
export class PgVectorStore implements MemoryStore {
  async remember(m: StoredMemory): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO agent_memory
         (kind, vendor, source_ref, content, metadata, embedding, embed_model, importance)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       RETURNING id`,
      [
        m.kind,
        m.vendor ?? "_global",
        m.sourceRef ?? null,
        m.content,
        m.metadata ? JSON.stringify(m.metadata) : null,
        toVectorLiteral(m.embedding),
        m.embedModel,
        clampImportance(m.importance),
      ]
    );
    const localId = rows[0]!.id;

    // Double-write to MemoryAgent DB (postgres) so it shows up in the memory app!
    try {
      const maPool = getMemoryAgentPool();
      if (maPool) {
        const company = m.vendor ?? "_global";
        await maPool.query(
          `INSERT INTO agent_memory
             (kind, company, source_ref, content, metadata, embedding, embed_model, importance)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
           ON CONFLICT DO NOTHING`,
          [
            m.kind,
            company,
            m.sourceRef ?? null,
            m.content,
            m.metadata ? JSON.stringify(m.metadata) : null,
            toVectorLiteral(m.embedding),
            m.embedModel,
            clampImportance(m.importance),
          ]
        );
      }
    } catch (err) {
      console.warn("Could not sync memory to MemoryAgent DB:", err);
    }

    return localId;
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const params: unknown[] = [toVectorLiteral(queryVec)];
    const filters: string[] = [];
    if (opts.kind) {
      params.push(opts.kind);
      filters.push(`kind = $${params.length}`);
    }
    if (opts.vendor) {
      params.push(opts.vendor);
      filters.push(`vendor = $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(limit);
    const rows = await query<PgRow>(
      `SELECT id, kind, vendor, source_ref, content, metadata, created_at,
              (embedding <=> $1::vector) AS distance
         FROM agent_memory
         ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $${params.length}`,
      params
    );
    return rows.map(rowToHit);
  }

  async count(vendor?: string): Promise<number> {
    const rows = vendor
      ? await query<{ n: string }>(
          `SELECT count(*) AS n FROM agent_memory WHERE vendor = $1`,
          [vendor]
        )
      : await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory`);
    return Number(rows[0]!.n);
  }

  async clear(): Promise<void> {
    await query(`DELETE FROM agent_memory`);
  }
}

interface PgRow {
  id: string;
  kind: MemoryKind;
  vendor: string;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
  distance: string | number;
}

function rowToHit(r: PgRow): RecallHit {
  const distance = Number(r.distance);
  return {
    id: r.id,
    kind: r.kind,
    vendor: r.vendor,
    sourceRef: r.source_ref,
    content: r.content,
    metadata: r.metadata,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    distance,
    score: 1 - distance,
  };
}

function clampImportance(v: number | undefined): number {
  if (v == null || Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ── In-memory store (offline workflow + unit tests — no DB, no creds) ──────────
// Same cosine-distance ranking as pgvector's `<=>`, computed over plain arrays,
// so the whole intake→decide→approve loop is verifiable with zero infra.
interface MemRow extends MemoryRecord {
  embedding: number[];
  importance: number;
}

export class InMemoryStore implements MemoryStore {
  private rows: MemRow[] = [];

  async remember(m: StoredMemory): Promise<string> {
    const id = randomUUID();
    this.rows.push({
      id,
      kind: m.kind,
      vendor: m.vendor ?? "_global",
      sourceRef: m.sourceRef ?? null,
      content: m.content,
      metadata: m.metadata ?? null,
      createdAt: new Date().toISOString(),
      embedding: m.embedding,
      importance: clampImportance(m.importance),
    });
    return id;
  }

  async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    return this.rows
      .filter((r) => (opts.kind ? r.kind === opts.kind : true))
      .filter((r) => (opts.vendor ? r.vendor === opts.vendor : true))
      .map((r) => {
        const distance = 1 - cosineSimilarity(queryVec, r.embedding);
        const { embedding, importance, ...rec } = r;
        return { ...rec, distance, score: 1 - distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async count(vendor?: string): Promise<number> {
    return this.rows.filter((r) => (vendor ? r.vendor === vendor : true)).length;
  }

  async clear(): Promise<void> {
    this.rows = [];
  }
}

// Cosine similarity over two equal-length vectors. Matches the direction that
// pgvector's `<=>` cosine-distance operator ranks by (distance = 1 - similarity).
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
