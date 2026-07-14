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

import { query, withClient } from "../db/client.js";
import { canonicalReference, canonicalVendorKey } from "./normalize.js";
import type { NormalizedInvoice, WorkItem, WorkItemStatus } from "../types.js";

export interface WorkItemStore {
  // Atomically create a pending item unless the same invoice is already live.
  // Returns that live item on duplicate, or null when `item` was created.
  create(item: WorkItem): Promise<WorkItem | null>;
  get(id: string): Promise<WorkItem | null>;
  listPending(): Promise<WorkItem[]>;
  // The DECIDED history — every item a human has approved / amended / rejected,
  // most-recently-decided first. Answers "I approved one, where did it go?" and
  // backs the decided view + its charts. Decided items are terminal: they are
  // never re-executed (the approval gate), so this is a read-only audit list.
  listDecided(): Promise<WorkItem[]>;
  // Atomically acquire the one execution right for a pending item. Returning
  // null means missing or no longer pending; callers then inspect get() for the
  // correct 404/409. This is the concurrency boundary for every reviewer action.
  claimPending(id: string): Promise<WorkItem | null>;
  // Compare-and-set completion: only the holder of an `executing` claim can
  // finalize it. A false return leaves the caller in an explicit conflict.
  finishExecuting(item: WorkItem): Promise<boolean>;
  // Persist diagnostic state while retaining the execution claim.
  updateExecuting(item: WorkItem): Promise<boolean>;
  // Explicit recovery after the reviewer has established that no external side
  // effect completed. There is intentionally no automatic retry.
  resetExecuting(id: string, reason: string): Promise<WorkItem | null>;
  clear(): Promise<void>;
}

// ── In-memory (offline + tests) ───────────────────────────────────────────────
export class InMemoryWorkItemStore implements WorkItemStore {
  private rows = new Map<string, WorkItem>();

  async create(item: WorkItem): Promise<WorkItem | null> {
    const existing = findLiveDuplicate(this.rows.values(), item.invoice);
    if (existing) return clone(existing);
    this.rows.set(item.id, clone(item));
    return null;
  }
  async get(id: string): Promise<WorkItem | null> {
    const row = this.rows.get(id);
    return row ? clone(row) : null;
  }
  async listPending(): Promise<WorkItem[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" || r.status === "executing")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }
  async listDecided(): Promise<WorkItem[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "approved" || r.status === "rejected")
      .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "")) // newest decision first
      .map(clone);
  }
  async claimPending(id: string): Promise<WorkItem | null> {
    const current = this.rows.get(id);
    if (!current || current.status !== "pending") return null;
    const claimed = clone(current);
    claimed.status = "executing";
    claimed.executionStartedAt = new Date().toISOString();
    this.rows.set(id, clone(claimed));
    return claimed;
  }
  async finishExecuting(item: WorkItem): Promise<boolean> {
    const current = this.rows.get(item.id);
    if (!current || current.status !== "executing") return false;
    this.rows.set(item.id, clone(item));
    return true;
  }
  async updateExecuting(item: WorkItem): Promise<boolean> {
    const current = this.rows.get(item.id);
    if (!current || current.status !== "executing" || item.status !== "executing") return false;
    this.rows.set(item.id, clone(item));
    return true;
  }
  async resetExecuting(id: string, reason: string): Promise<WorkItem | null> {
    const current = this.rows.get(id);
    if (!current || current.status !== "executing") return null;
    const reset = clone(current);
    reset.status = "pending";
    delete reset.executionStartedAt;
    delete reset.executionFailure;
    reset.recoveryReason = reason;
    reset.recoveredAt = new Date().toISOString();
    this.rows.set(id, clone(reset));
    return reset;
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
}

// ── pgvector database (production + CI + Alibaba Cloud) ────────────────────────
export class PgWorkItemStore implements WorkItemStore {
  async create(item: WorkItem): Promise<WorkItem | null> {
    const vendorKey = canonicalVendorKey(item.invoice.vendor);
    if (!vendorKey) {
      await query(
        `INSERT INTO ap_workitems
           (id, status, item, created_at, vendor_key, vendor_ref_key, invoice_total, invoice_date, currency)
         VALUES ($1, $2, $3::jsonb, now(), $4, $5, $6, $7::date, $8)`,
        [
          item.id,
          item.status,
          JSON.stringify(item),
          vendorKey,
          canonicalReference(item.invoice.vendor_ref),
          item.invoice.total,
          item.invoice.invoice_date,
          item.invoice.currency.toUpperCase(),
        ]
      );
      return null;
    }

    // Serialize intake for the same canonical vendor in an EXPLICIT transaction.
    // This must be two statements: if lock acquisition and the duplicate SELECT live
    // in one statement, PostgreSQL fixes that statement's MVCC snapshot *before* a
    // concurrent transaction releases the advisory lock. The waiter can then miss
    // the just-committed row and insert a duplicate. Acquiring the lock first gives
    // the following SELECT a fresh READ COMMITTED snapshot and closes that race.
    //
    // A pair of non-empty references is authoritative: only equal refs collapse.
    // The amount/date/currency fingerprint is a fallback when at least one side has
    // no reference, avoiding silent loss of two real same-day invoices with refs A/B.
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [vendorKey]);
        const vendorRefKey = canonicalReference(item.invoice.vendor_ref);
        const currency = item.invoice.currency.toUpperCase();
        const existing = await client.query<{ item: WorkItem }>(
          `SELECT w.item
             FROM ap_workitems w
            WHERE w.status IN ('pending', 'executing')
              AND w.vendor_key = $1
              AND (
                ($2 <> '' AND COALESCE(w.vendor_ref_key, '') = $2)
                OR (
                  ($2 = '' OR COALESCE(w.vendor_ref_key, '') = '')
                  AND $3::double precision IS NOT NULL
                  AND $4::text IS NOT NULL
                  AND ABS(w.invoice_total - $3::double precision) <= 0.01
                  AND w.invoice_date = $4::date
                  AND COALESCE(w.currency, '') = $5
                )
              )
            ORDER BY w.created_at ASC
            LIMIT 1`,
          [vendorKey, vendorRefKey, item.invoice.total, item.invoice.invoice_date, currency]
        );

        if (existing.rows[0]) {
          await client.query("COMMIT");
          return existing.rows[0].item;
        }

        await client.query(
          `INSERT INTO ap_workitems
             (id, status, item, created_at, vendor_key, vendor_ref_key, invoice_total, invoice_date, currency)
           VALUES ($1, $2, $3::jsonb, now(), $4, $5, $6, $7::date, $8)`,
          [
            item.id,
            item.status,
            JSON.stringify(item),
            vendorKey,
            vendorRefKey,
            item.invoice.total,
            item.invoice.invoice_date,
            currency,
          ]
        );
        await client.query("COMMIT");
        return null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
  async get(id: string): Promise<WorkItem | null> {
    const rows = await query<{ item: WorkItem }>(`SELECT item FROM ap_workitems WHERE id = $1`, [id]);
    return rows[0]?.item ?? null;
  }
  async listPending(): Promise<WorkItem[]> {
    const rows = await query<{ item: WorkItem }>(
      `SELECT item FROM ap_workitems WHERE status IN ('pending', 'executing') ORDER BY created_at ASC`
    );
    return rows.map((r) => r.item);
  }
  async listDecided(): Promise<WorkItem[]> {
    const rows = await query<{ item: WorkItem }>(
      `SELECT item FROM ap_workitems WHERE status IN ('approved', 'rejected') ORDER BY decided_at DESC NULLS LAST`
    );
    return rows.map((r) => r.item);
  }
  async claimPending(id: string): Promise<WorkItem | null> {
    const patch = { status: "executing", executionStartedAt: new Date().toISOString() };
    const rows = await query<{ item: WorkItem }>(
      `UPDATE ap_workitems
          SET status = 'executing', item = item || $2::jsonb
        WHERE id = $1 AND status = 'pending'
      RETURNING item`,
      [id, JSON.stringify(patch)]
    );
    return rows[0]?.item ?? null;
  }
  async finishExecuting(item: WorkItem): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE ap_workitems
          SET status = $2, item = $3::jsonb,
              decided_at = CASE WHEN $2 IN ('approved', 'rejected') THEN now() ELSE decided_at END
        WHERE id = $1 AND status = 'executing'
      RETURNING id`,
      [item.id, item.status, JSON.stringify(item)]
    );
    return rows.length === 1;
  }
  async updateExecuting(item: WorkItem): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE ap_workitems SET item = $2::jsonb
        WHERE id = $1 AND status = 'executing'
      RETURNING id`,
      [item.id, JSON.stringify(item)]
    );
    return rows.length === 1;
  }
  async resetExecuting(id: string, reason: string): Promise<WorkItem | null> {
    const patch = {
      status: "pending",
      recoveryReason: reason,
      recoveredAt: new Date().toISOString(),
    };
    const rows = await query<{ item: WorkItem }>(
      `UPDATE ap_workitems
          SET status = 'pending',
              item = ((item || $2::jsonb) - 'executionStartedAt') - 'executionFailure',
              decided_at = NULL
        WHERE id = $1 AND status = 'executing'
      RETURNING item`,
      [id, JSON.stringify(patch)]
    );
    return rows[0]?.item ?? null;
  }
  async clear(): Promise<void> {
    await query(`DELETE FROM ap_workitems`);
  }
}

// Documented status values (kept in sync with the WorkItemStatus union).
export const WORK_ITEM_STATUSES: WorkItemStatus[] = ["pending", "executing", "approved", "rejected"];

function clone(item: WorkItem): WorkItem {
  return structuredClone(item);
}

export function findLiveDuplicate(
  items: Iterable<WorkItem>,
  invoice: NormalizedInvoice
): WorkItem | null {
  for (const item of items) {
    if ((item.status === "pending" || item.status === "executing") && sameInvoice(item.invoice, invoice)) {
      return item;
    }
  }
  return null;
}

function sameInvoice(left: NormalizedInvoice, right: NormalizedInvoice): boolean {
  const vendor = canonicalVendorKey(left.vendor);
  if (!vendor || vendor !== canonicalVendorKey(right.vendor)) return false;
  const leftRef = canonicalReference(left.vendor_ref);
  const rightRef = canonicalReference(right.vendor_ref);
  if (leftRef && rightRef) return leftRef === rightRef;
  return (
    left.total != null &&
    right.total != null &&
    Math.abs(left.total - right.total) <= 0.01 &&
    Boolean(left.invoice_date) &&
    left.invoice_date === right.invoice_date &&
    left.currency.toUpperCase() === right.currency.toUpperCase()
  );
}
