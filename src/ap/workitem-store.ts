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
import { isSupportedCurrency } from "./currency.js";
import type { NormalizedInvoice, RecoveryLease, WorkItem, WorkItemStatus } from "../types.js";

export interface WorkItemStore {
  // Atomically create a pending item unless the same invoice is already live.
  // Returns that live item on duplicate, or null when `item` was created.
  create(item: WorkItem): Promise<WorkItem | null>;
  get(id: string): Promise<WorkItem | null>;
  findLive(invoice: NormalizedInvoice): Promise<WorkItem | null>;
  listPending(limit?: number, offset?: number): Promise<WorkItem[]>;
  // The DECIDED history — every item a human has approved / amended / rejected,
  // most-recently-decided first. Answers "I approved one, where did it go?" and
  // backs the decided view + its charts. Decided items are terminal: they are
  // never re-executed (the approval gate), so this is a read-only audit list.
  listDecided(limit?: number, offset?: number): Promise<WorkItem[]>;
  // Atomically acquire the one execution right for a pending item. Returning
  // null means missing or no longer pending; callers then inspect get() for the
  // correct 404/409. This is the concurrency boundary for every reviewer action.
  claimPending(id: string): Promise<WorkItem | null>;
  // Compare-and-set completion: only the holder of an `executing` claim can
  // finalize it. A false return leaves the caller in an explicit conflict.
  finishExecuting(item: WorkItem, expectedRecoveryLeaseId?: string): Promise<boolean>;
  // Persist diagnostic state while retaining the execution claim.
  updateExecuting(item: WorkItem, expectedRecoveryLeaseId?: string): Promise<boolean>;
  // Atomic immediately-pre-sink fence for BOTH the original reviewer executor and
  // a recovery holder. A normal owner succeeds only while no recovery lease exists;
  // a recovery owner succeeds only with its exact lease id. Returns the durable
  // current row after refreshing execution time, or null when ownership changed.
  fenceExecution(id: string, startedAt: string, expectedRecoveryLeaseId?: string): Promise<WorkItem | null>;
  // Atomically lease one explicit recovery attempt. An absent/non-stale lease is
  // the CAS condition that makes retry/retry and retry/mark_completed races safe.
  claimRecovery(id: string, lease: RecoveryLease, staleBefore: string): Promise<WorkItem | null>;
  renewRecovery(id: string, leaseId: string, startedAt: string): Promise<boolean>;
  releaseRecovery(id: string, leaseId: string): Promise<boolean>;
  // Explicit recovery after the reviewer has established that no external side
  // effect completed. There is intentionally no automatic retry.
  // The caller supplies the executing snapshot so recovery metadata (including
  // the reviewer touch) is persisted atomically with the reset.
  resetExecuting(item: WorkItem, reason: string): Promise<WorkItem | null>;
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
  async findLive(invoice: NormalizedInvoice): Promise<WorkItem | null> {
    const found = findLiveDuplicate(this.rows.values(), invoice);
    return found ? clone(found) : null;
  }
  async listPending(limit = 100, offset = 0): Promise<WorkItem[]> {
    const page = boundedPage(limit, offset);
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" || r.status === "executing")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(page.offset, page.offset + page.limit)
      .map(clone);
  }
  async listDecided(limit = 100, offset = 0): Promise<WorkItem[]> {
    const page = boundedPage(limit, offset);
    return [...this.rows.values()]
      .filter((r) => r.status === "approved" || r.status === "rejected")
      .sort((a, b) =>
        (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "") || b.id.localeCompare(a.id)
      ) // newest decision first
      .slice(page.offset, page.offset + page.limit)
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
  async finishExecuting(item: WorkItem, expectedRecoveryLeaseId?: string): Promise<boolean> {
    const current = this.rows.get(item.id);
    if (!current || current.status !== "executing") return false;
    if (expectedRecoveryLeaseId) {
      if (current.recoveryLease?.id !== expectedRecoveryLeaseId) return false;
    } else if (current.recoveryLease) {
      return false;
    }
    this.rows.set(item.id, clone(item));
    return true;
  }
  async updateExecuting(item: WorkItem, expectedRecoveryLeaseId?: string): Promise<boolean> {
    const current = this.rows.get(item.id);
    if (!current || current.status !== "executing" || item.status !== "executing") return false;
    if (expectedRecoveryLeaseId) {
      if (current.recoveryLease?.id !== expectedRecoveryLeaseId) return false;
    } else if (current.recoveryLease) {
      return false;
    }
    this.rows.set(item.id, clone(item));
    return true;
  }
  async fenceExecution(
    id: string,
    startedAt: string,
    expectedRecoveryLeaseId?: string
  ): Promise<WorkItem | null> {
    const current = this.rows.get(id);
    if (!current || current.status !== "executing") return null;
    if (expectedRecoveryLeaseId) {
      if (current.recoveryLease?.id !== expectedRecoveryLeaseId) return null;
    } else if (current.recoveryLease) {
      return null;
    }
    const fenced = clone(current);
    fenced.executionStartedAt = startedAt;
    if (expectedRecoveryLeaseId && fenced.recoveryLease) {
      fenced.recoveryLease.startedAt = startedAt;
    }
    this.rows.set(id, clone(fenced));
    return fenced;
  }
  async claimRecovery(id: string, lease: RecoveryLease, staleBefore: string): Promise<WorkItem | null> {
    const current = this.rows.get(id);
    if (!current || current.status !== "executing") return null;
    const active = current.recoveryLease;
    if (active) {
      const started = Date.parse(active.startedAt);
      const cutoff = Date.parse(staleBefore);
      if (!Number.isFinite(started) || !Number.isFinite(cutoff) || started > cutoff) return null;
    }
    const claimed = clone(current);
    claimed.recoveryLease = structuredClone(lease);
    this.rows.set(id, clone(claimed));
    return claimed;
  }
  async renewRecovery(id: string, leaseId: string, startedAt: string): Promise<boolean> {
    const current = this.rows.get(id);
    if (!current || current.status !== "executing" || current.recoveryLease?.id !== leaseId) return false;
    const renewed = clone(current);
    renewed.recoveryLease = { ...renewed.recoveryLease!, startedAt };
    this.rows.set(id, renewed);
    return true;
  }
  async releaseRecovery(id: string, leaseId: string): Promise<boolean> {
    const current = this.rows.get(id);
    if (!current || current.status !== "executing" || current.recoveryLease?.id !== leaseId) return false;
    const released = clone(current);
    delete released.recoveryLease;
    this.rows.set(id, released);
    return true;
  }
  async resetExecuting(item: WorkItem, reason: string): Promise<WorkItem | null> {
    const current = this.rows.get(item.id);
    if (!current || current.status !== "executing" || item.status !== "executing") return null;
    const reset = clone(item);
    reset.status = "pending";
    delete reset.executionStartedAt;
    delete reset.executionFailure;
    reset.recoveryReason = reason;
    reset.recoveredAt = new Date().toISOString();
    this.rows.set(item.id, clone(reset));
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
          isSupportedCurrency(item.invoice.currency) ? item.invoice.total : null,
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
          [
            vendorKey,
            vendorRefKey,
            isSupportedCurrency(currency) ? item.invoice.total : null,
            item.invoice.invoice_date,
            currency,
          ]
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
            isSupportedCurrency(currency) ? item.invoice.total : null,
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
  async findLive(invoice: NormalizedInvoice): Promise<WorkItem | null> {
    const vendorKey = canonicalVendorKey(invoice.vendor);
    if (!vendorKey) return null;
    const rows = await query<{ item: WorkItem }>(
      `SELECT item
         FROM ap_workitems
        WHERE status IN ('pending', 'executing')
          AND vendor_key = $1
          AND (
            ($2 <> '' AND COALESCE(vendor_ref_key, '') = $2)
            OR (
              ($2 = '' OR COALESCE(vendor_ref_key, '') = '')
              AND $3::double precision IS NOT NULL
              AND $4::text IS NOT NULL
              AND ABS(invoice_total - $3::double precision) <= 0.01
              AND invoice_date = $4::date
              AND COALESCE(currency, '') = $5
            )
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [
        vendorKey,
        canonicalReference(invoice.vendor_ref),
        isSupportedCurrency(invoice.currency) ? invoice.total : null,
        invoice.invoice_date,
        invoice.currency.toUpperCase(),
      ]
    );
    return rows[0]?.item ?? null;
  }
  async listPending(limit = 100, offset = 0): Promise<WorkItem[]> {
    const page = boundedPage(limit, offset);
    const rows = await query<{ item: WorkItem }>(
      `SELECT item FROM ap_workitems
        WHERE status IN ('pending', 'executing')
        ORDER BY created_at ASC, id ASC
        LIMIT $1 OFFSET $2`,
      [page.limit, page.offset]
    );
    return rows.map((r) => r.item);
  }
  async listDecided(limit = 100, offset = 0): Promise<WorkItem[]> {
    const page = boundedPage(limit, offset);
    const rows = await query<{ item: WorkItem }>(
      `SELECT item FROM ap_workitems
        WHERE status IN ('approved', 'rejected')
        ORDER BY decided_at DESC NULLS LAST, id DESC
        LIMIT $1 OFFSET $2`,
      [page.limit, page.offset]
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
  async finishExecuting(item: WorkItem, expectedRecoveryLeaseId?: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE ap_workitems
          SET status = $2, item = $3::jsonb,
              decided_at = CASE WHEN $2 IN ('approved', 'rejected') THEN now() ELSE decided_at END
        WHERE id = $1 AND status = 'executing'
          AND (
            ($4::text IS NULL AND item->'recoveryLease' IS NULL)
            OR item->'recoveryLease'->>'id' = $4
          )
      RETURNING id`,
      [item.id, item.status, JSON.stringify(item), expectedRecoveryLeaseId ?? null]
    );
    return rows.length === 1;
  }
  async updateExecuting(item: WorkItem, expectedRecoveryLeaseId?: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE ap_workitems SET item = $2::jsonb
        WHERE id = $1 AND status = 'executing'
          AND (
            ($3::text IS NULL AND item->'recoveryLease' IS NULL)
            OR item->'recoveryLease'->>'id' = $3
          )
      RETURNING id`,
      [item.id, JSON.stringify(item), expectedRecoveryLeaseId ?? null]
    );
    return rows.length === 1;
  }
  async fenceExecution(
    id: string,
    startedAt: string,
    expectedRecoveryLeaseId?: string
  ): Promise<WorkItem | null> {
    const rows = await query<{ item: WorkItem }>(
      `UPDATE ap_workitems
          SET item = CASE
            WHEN $3::text IS NULL THEN
              jsonb_set(item, '{executionStartedAt}', to_jsonb($2::text), true)
            ELSE
              jsonb_set(
                jsonb_set(item, '{executionStartedAt}', to_jsonb($2::text), true),
                '{recoveryLease,startedAt}', to_jsonb($2::text), false
              )
          END
        WHERE id = $1 AND status = 'executing'
          AND (
            ($3::text IS NULL AND item->'recoveryLease' IS NULL)
            OR item->'recoveryLease'->>'id' = $3
          )
      RETURNING item`,
      [id, startedAt, expectedRecoveryLeaseId ?? null]
    );
    return rows[0]?.item ?? null;
  }
  async claimRecovery(id: string, lease: RecoveryLease, staleBefore: string): Promise<WorkItem | null> {
    const rows = await query<{ item: WorkItem }>(
      `UPDATE ap_workitems
          SET item = jsonb_set(item, '{recoveryLease}', $2::jsonb, true)
        WHERE id = $1
          AND status = 'executing'
          AND (
            item->'recoveryLease' IS NULL
            OR (item->'recoveryLease'->>'startedAt')::timestamptz <= $3::timestamptz
          )
      RETURNING item`,
      [id, JSON.stringify(lease), staleBefore]
    );
    return rows[0]?.item ?? null;
  }
  async renewRecovery(id: string, leaseId: string, startedAt: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE ap_workitems
          SET item = jsonb_set(item, '{recoveryLease,startedAt}', to_jsonb($3::text), false)
        WHERE id = $1
          AND status = 'executing'
          AND item->'recoveryLease'->>'id' = $2
      RETURNING id`,
      [id, leaseId, startedAt]
    );
    return rows.length === 1;
  }
  async releaseRecovery(id: string, leaseId: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE ap_workitems
          SET item = item - 'recoveryLease'
        WHERE id = $1
          AND status = 'executing'
          AND item->'recoveryLease'->>'id' = $2
      RETURNING id`,
      [id, leaseId]
    );
    return rows.length === 1;
  }
  async resetExecuting(item: WorkItem, reason: string): Promise<WorkItem | null> {
    if (item.status !== "executing") return null;
    const reset = structuredClone(item);
    reset.status = "pending";
    delete reset.executionStartedAt;
    delete reset.executionFailure;
    reset.recoveryReason = reason;
    reset.recoveredAt = new Date().toISOString();
    const rows = await query<{ item: WorkItem }>(
      `UPDATE ap_workitems
          SET status = 'pending',
              item = $2::jsonb,
              decided_at = NULL
        WHERE id = $1 AND status = 'executing'
      RETURNING item`,
      [item.id, JSON.stringify(reset)]
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

function boundedPage(limit: number, offset: number): { limit: number; offset: number } {
  return {
    limit: Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 100, 500)),
    offset: Math.max(0, Math.min(Number.isFinite(offset) ? Math.trunc(offset) : 0, 1_000_000)),
  };
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
    isSupportedCurrency(left.currency) &&
    isSupportedCurrency(right.currency) &&
    Math.abs(left.total - right.total) <= 0.01 &&
    Boolean(left.invoice_date) &&
    left.invoice_date === right.invoice_date &&
    left.currency.toUpperCase() === right.currency.toUpperCase()
  );
}

// A live identity match is safe to reuse only when its normalized financial
// substance also matches. The server-generated invoice id, raw aliases, notes, and
// extraction confidence are intentionally excluded; everything a reviewer could
// authorize at a financial sink is included. A reused vendor reference with a
// changed amount/currency/date/tax payload is a collision, not an idempotent retry.
export function sameMaterialInvoice(left: NormalizedInvoice, right: NormalizedInvoice): boolean {
  const sameNullableAmount = (a: number | null, b: number | null) =>
    a == null || b == null ? a === b : Math.abs(a - b) <= 0.01;
  const normalizeTaxId = (value: string | null) =>
    (value ?? "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
  return (
    canonicalVendorKey(left.vendor) === canonicalVendorKey(right.vendor) &&
    canonicalReference(left.vendor_ref) === canonicalReference(right.vendor_ref) &&
    left.invoice_date === right.invoice_date &&
    left.currency.toUpperCase() === right.currency.toUpperCase() &&
    normalizeTaxId(left.tax_id) === normalizeTaxId(right.tax_id) &&
    sameNullableAmount(left.subtotal, right.subtotal) &&
    sameNullableAmount(left.tax, right.tax) &&
    sameNullableAmount(left.total, right.total) &&
    left.line_items.length === right.line_items.length &&
    left.line_items.every((line, index) => {
      const other = right.line_items[index]!;
      return (
        line.description.normalize("NFKC").trim() === other.description.normalize("NFKC").trim() &&
        sameNullableAmount(line.quantity, other.quantity) &&
        sameNullableAmount(line.unit_price, other.unit_price) &&
        sameNullableAmount(line.amount, other.amount)
      );
    })
  );
}
