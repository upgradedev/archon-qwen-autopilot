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
import { canonicalVendorKey } from "../ap/normalize.js";

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
  // Deterministic invoice history used by R5/R6. This is deliberately separate
  // from semantic top-k recall: a duplicate must not disappear because it ranked
  // ninth, and case/Unicode/whitespace variants share the same vendor key. Only
  // approved/executed invoice facts qualify; pending/rejected uploads never become
  // amount baselines or durable duplicate evidence.
  invoiceHistory(vendor: string, limit?: number): Promise<MemoryRecord[]>;
  clear(): Promise<void>;
}

// ── pgvector-backed store (production + CI + Alibaba Cloud) ────────────────────
export class PgVectorStore implements MemoryStore {
  constructor(private readonly runQuery: typeof query = query) {}

  async remember(m: StoredMemory): Promise<string> {
    const metadata = {
      ...(m.metadata ?? {}),
      vendor_key: canonicalVendorKey(m.vendor ?? "_global"),
    };
    const rows = await this.runQuery<{ id: string }>(
      `INSERT INTO agent_memory
         (kind, vendor, source_ref, content, metadata, embedding, embed_model, importance)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       RETURNING id`,
      [
        m.kind,
        m.vendor ?? "_global",
        m.sourceRef ?? null,
        m.content,
        JSON.stringify(metadata),
        toVectorLiteral(m.embedding),
        m.embedModel,
        clampImportance(m.importance),
      ]
    );
    return rows[0]!.id;
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
      params.push(canonicalVendorKey(opts.vendor));
      filters.push(
        `COALESCE(metadata->>'vendor_key', lower(regexp_replace(trim(vendor), '\\s+', ' ', 'g'))) = $${params.length}`
      );
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(limit);
    const rows = await this.runQuery<PgRow>(
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
      ? await this.runQuery<{ n: string }>(
          `SELECT count(*) AS n FROM agent_memory
            WHERE lower(regexp_replace(trim(vendor), '\\s+', ' ', 'g')) = $1`,
          [canonicalVendorKey(vendor)]
        )
      : await this.runQuery<{ n: string }>(`SELECT count(*) AS n FROM agent_memory`);
    return Number(rows[0]!.n);
  }

  async invoiceHistory(vendor: string, limit = 1000): Promise<MemoryRecord[]> {
    const vendorKey = canonicalVendorKey(vendor);
    const bounded = Math.max(1, Math.min(limit, 5000));
    const rows = await this.runQuery<Omit<PgRow, "distance">>(
      `SELECT id, kind, vendor, source_ref, content, metadata, created_at, embed_model
         FROM agent_memory
        WHERE kind = 'invoice'
          AND metadata->>'processing_status' IN ('approved', 'executed')
          AND COALESCE(
                metadata->>'vendor_key',
                lower(regexp_replace(trim(COALESCE(metadata->>'vendor', vendor)), '\\s+', ' ', 'g'))
              ) = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [vendorKey, bounded]
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      vendor: r.vendor,
      sourceRef: r.source_ref,
      content: r.content,
      metadata: r.metadata,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  }

  async clear(): Promise<void> {
    await this.runQuery(`DELETE FROM agent_memory`);
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
  embed_model?: string;
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
      .filter((r) =>
        opts.vendor ? canonicalVendorKey(r.vendor) === canonicalVendorKey(opts.vendor) : true
      )
      .map((r) => {
        const distance = 1 - cosineSimilarity(queryVec, r.embedding);
        const { embedding, importance, ...rec } = r;
        return { ...rec, distance, score: 1 - distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  async count(vendor?: string): Promise<number> {
    return this.rows.filter((r) =>
      vendor ? canonicalVendorKey(r.vendor) === canonicalVendorKey(vendor) : true
    ).length;
  }

  async invoiceHistory(vendor: string, limit = 1000): Promise<MemoryRecord[]> {
    const key = canonicalVendorKey(vendor);
    const bounded = Math.max(1, Math.min(limit, 5000));
    return this.rows
      .filter((r) => r.kind === "invoice")
      .filter(
        (r) =>
          r.metadata?.["processing_status"] === "approved" ||
          r.metadata?.["processing_status"] === "executed"
      )
      .filter((r) => {
        const fromMetadata =
          r.metadata && typeof r.metadata["vendor_key"] === "string"
            ? (r.metadata["vendor_key"] as string)
            : canonicalVendorKey(
                r.metadata && typeof r.metadata["vendor"] === "string"
                  ? (r.metadata["vendor"] as string)
                  : r.vendor
              );
        return fromMetadata === key;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded)
      .map(({ embedding: _embedding, importance: _importance, ...record }) => structuredClone(record));
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
