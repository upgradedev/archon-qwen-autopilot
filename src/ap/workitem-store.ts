// Work-item store — durable persistence of the human-in-the-loop approval queue.
//
// When the decider proposes an action it is persisted here as a PENDING work item
// and NEVER executed automatically. A human then approves / amends / rejects it.
// Two implementations behind one interface, mirroring the memory store:
//
//   InMemoryWorkItemStore — offline workflow + unit/integration tests (no DB).
//   PgWorkItemStore        — production / CI. One JSONB row per work item, so the
//                            full item (invoice, findings, recall, proposal,
//                            execution) survives across sessions on Alibaba Cloud
//                            PostgreSQL. Same pg-wire, same SQL everywhere.

import { query } from "../db/client.js";
import type { WorkItem, WorkItemStatus } from "../types.js";

export interface WorkItemStore {
  create(item: WorkItem): Promise<void>;
  get(id: string): Promise<WorkItem | null>;
  listPending(): Promise<WorkItem[]>;
  update(item: WorkItem): Promise<void>;
  clear(): Promise<void>;
}

// ── In-memory (offline + tests) ───────────────────────────────────────────────
export class InMemoryWorkItemStore implements WorkItemStore {
  private rows = new Map<string, WorkItem>();

  async create(item: WorkItem): Promise<void> {
    this.rows.set(item.id, clone(item));
  }
  async get(id: string): Promise<WorkItem | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }
  async listPending(): Promise<WorkItem[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }
  async update(item: WorkItem): Promise<void> {
    this.rows.set(item.id, clone(item));
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
}

// ── pgvector database (production + CI + Alibaba Cloud) ────────────────────────
export class PgWorkItemStore implements WorkItemStore {
  async create(item: WorkItem): Promise<void> {
    await query(
      `INSERT INTO ap_workitems (id, status, item, created_at)
       VALUES ($1, $2, $3::jsonb, now())`,
      [item.id, item.status, JSON.stringify(item)]
    );
  }
  async get(id: string): Promise<WorkItem | null> {
    const rows = await query<{ item: WorkItem }>(`SELECT item FROM ap_workitems WHERE id = $1`, [id]);
    return rows[0]?.item ?? null;
  }
  async listPending(): Promise<WorkItem[]> {
    const rows = await query<{ item: WorkItem }>(
      `SELECT item FROM ap_workitems WHERE status = 'pending' ORDER BY created_at ASC`
    );
    return rows.map((r) => r.item);
  }
  async update(item: WorkItem): Promise<void> {
    await query(
      `UPDATE ap_workitems
          SET status = $2, item = $3::jsonb, decided_at = now()
        WHERE id = $1`,
      [item.id, item.status, JSON.stringify(item)]
    );
  }
  async clear(): Promise<void> {
    await query(`DELETE FROM ap_workitems`);
  }
}

// Documented status values (kept in sync with the WorkItemStatus union).
export const WORK_ITEM_STATUSES: WorkItemStatus[] = ["pending", "approved", "rejected"];

function clone(item: WorkItem): WorkItem {
  return structuredClone(item);
}
