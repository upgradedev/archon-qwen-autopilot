// AutopilotAgent — the end-to-end accounts-payable orchestration loop.
//
// This is the Track-4 "autopilot" itself: it runs the AP workflow from a messy
// incoming invoice all the way to an executed action, with a HUMAN APPROVAL GATE
// in the middle. It recommends; it never auto-executes.
//
//   intake()   Extract + validate the invoice, RECALL the vendor's history from
//              persistent memory (the MemoryAgent foundation), then ask Qwen (via
//              function-calling) to CHOOSE one action. The proposal is persisted
//              as a PENDING work item — nothing executes yet.
//   pending()  The human approval queue.
//   approve()  A human approves → the chosen tool runs for real → the outcome is
//              written BACK to memory so the agent gets smarter next time.
//   amend()    A human edits the proposed arguments, then approves → the EXACT
//              amended args are what execute (the HITL integrity guarantee).
//   reject()   A human discards the proposal → nothing executes.
//
// Everything is injected (embedder, memory store, work-item store, decider,
// sinks) so the whole loop runs offline with Fakes in tests and against real Qwen
// + a pgvector database (local, CI, Alibaba Cloud) in production, unchanged.

import { randomUUID } from "node:crypto";
import type { Embedder } from "../memory/embeddings.js";
import { recall, remember } from "../memory/memory.js";
import type { MemoryStore } from "../memory/store.js";
import { QwenDecider } from "../ap/decider.js";
import { normalizeInvoice } from "../ap/normalize.js";
import {
  detectAmountAnomaly,
  detectDuplicate,
  priorInvoicesFromRecall,
  toRecalledFact,
  validateInvoice,
} from "../ap/validate.js";
import { toolByName } from "../ap/tools.js";
import type { Sinks } from "../ap/sinks.js";
import type { WorkItemStore } from "../ap/workitem-store.js";
import type {
  ProposedAction,
  RawInvoice,
  RecalledFact,
  WorkItem,
} from "../types.js";

// Raised when a work item id does not exist → HTTP 404.
export class NotFoundError extends Error {}
// Raised when a work item has already been decided (approved/rejected) → HTTP 409.
// The core of the approval gate: a decided item can never be re-executed.
export class ConflictError extends Error {}

export interface AmendPatch {
  args?: Record<string, unknown>; // domain-arg edits merged onto the proposal
  reason?: string; // human note on why it was amended
}

export class AutopilotAgent {
  constructor(
    private embedder: Embedder,
    private memory: MemoryStore,
    private workitems: WorkItemStore,
    private decider: QwenDecider,
    private sinks: Sinks
  ) {}

  // ── 1..5: intake → decide → PENDING (no execution) ─────────────────────────
  async intake(raw: RawInvoice): Promise<WorkItem> {
    const invoice = normalizeInvoice(raw);

    // Structural validation (R1..R4).
    const findings = validateInvoice(invoice);

    // Recall the vendor's history from persistent memory (the foundation).
    const recallQuery =
      `${invoice.vendor ?? "vendor"} invoice ${invoice.vendor_ref ?? ""} ` +
      `${invoice.total ?? ""} ${invoice.currency}`.trim();
    const hits = invoice.vendor
      ? await recall(this.embedder, this.memory, recallQuery, { vendor: invoice.vendor, limit: 8 })
      : [];
    const knownVendor = hits.length > 0;
    const priors = priorInvoicesFromRecall(hits);
    const recalled: RecalledFact[] = hits.map(toRecalledFact);

    // Memory-grounded checks (R5 duplicate, R6 amount anomaly).
    findings.push(detectDuplicate(invoice, priors));
    findings.push(detectAmountAnomaly(invoice, priors));

    // Decide via Qwen function-calling — one tool + args + reasoning + confidence.
    const proposed: ProposedAction = await this.decider.decide({
      invoice,
      findings,
      recalled,
      knownVendor,
    });

    const item: WorkItem = {
      id: randomUUID(),
      status: "pending",
      invoice,
      findings,
      recalled,
      proposed,
      createdAt: new Date().toISOString(),
    };
    await this.workitems.create(item);

    // Remember the invoice itself so FUTURE invoices can detect duplicates and
    // learn the vendor's usual amount — even in a later, separate session.
    await remember(this.embedder, this.memory, {
      kind: "invoice",
      vendor: invoice.vendor ?? "_global",
      sourceRef: invoice.invoice_id,
      content:
        `Invoice ${invoice.vendor_ref ?? invoice.invoice_id} from ${invoice.vendor ?? "unknown vendor"} ` +
        `for ${invoice.currency} ${invoice.total ?? "?"}${invoice.invoice_date ? ` dated ${invoice.invoice_date}` : ""}.`,
      metadata: {
        invoice_id: invoice.invoice_id,
        vendor: invoice.vendor,
        vendor_ref: invoice.vendor_ref,
        total: invoice.total,
        invoice_date: invoice.invoice_date,
      },
    });

    return item;
  }

  // The human approval queue.
  async pending(): Promise<WorkItem[]> {
    return this.workitems.listPending();
  }

  async get(id: string): Promise<WorkItem> {
    const item = await this.workitems.get(id);
    if (!item) throw new NotFoundError(`work item ${id} not found`);
    return item;
  }

  // ── 6: approve → EXECUTE the tool for real → remember the outcome ───────────
  async approve(id: string): Promise<WorkItem> {
    const item = await this.requirePending(id);
    return this.executeAndRemember(item, item.proposed.args, { amended: false });
  }

  // A human edits the proposed DOMAIN arguments, then approves. The merged args
  // are what execute — so the human approves EXACTLY what runs.
  async amend(id: string, patch: AmendPatch): Promise<WorkItem> {
    const item = await this.requirePending(id);
    const mergedArgs = { ...item.proposed.args, ...(patch.args ?? {}) };
    item.proposed = { ...item.proposed, args: mergedArgs };
    return this.executeAndRemember(item, mergedArgs, { amended: true, reason: patch.reason });
  }

  // A human discards the proposal. Nothing executes; the rejection is remembered.
  async reject(id: string, reason?: string): Promise<WorkItem> {
    const item = await this.requirePending(id);
    item.status = "rejected";
    item.decisionReason = reason;
    item.decidedAt = new Date().toISOString();
    await this.workitems.update(item);

    await remember(this.embedder, this.memory, {
      kind: "insight",
      vendor: item.invoice.vendor ?? "_global",
      sourceRef: item.invoice.invoice_id,
      importance: 0.7,
      content:
        `A proposed ${item.proposed.tool} for ${item.invoice.vendor ?? "a vendor"} ` +
        `(invoice ${item.invoice.vendor_ref ?? item.invoice.invoice_id}) was REJECTED by a human` +
        `${reason ? `: ${reason}` : "."}`,
    });
    return item;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  // The approval-gate guard: only a PENDING item may be acted on. A missing id is
  // a 404; an already-decided item is a 409 (never re-executed).
  private async requirePending(id: string): Promise<WorkItem> {
    const item = await this.workitems.get(id);
    if (!item) throw new NotFoundError(`work item ${id} not found`);
    if (item.status !== "pending") {
      throw new ConflictError(`work item ${id} is already ${item.status} and cannot be acted on again`);
    }
    return item;
  }

  private async executeAndRemember(
    item: WorkItem,
    args: Record<string, unknown>,
    opts: { amended: boolean; reason?: string }
  ): Promise<WorkItem> {
    const spec = toolByName(item.proposed.tool);
    if (!spec) {
      throw new ConflictError(`unknown tool ${item.proposed.tool} on work item ${item.id}`);
    }
    const execution = spec.execute(args, item.invoice, this.sinks);

    item.status = "approved";
    item.execution = execution;
    item.amended = opts.amended;
    if (opts.reason) item.decisionReason = opts.reason;
    item.decidedAt = new Date().toISOString();
    await this.workitems.update(item);

    // Write the OUTCOME back to memory — the agent gets smarter over time: the
    // next invoice from this vendor recalls what we actually did last time.
    await remember(this.embedder, this.memory, {
      kind: "action",
      vendor: item.invoice.vendor ?? "_global",
      sourceRef: item.invoice.invoice_id,
      importance: 0.75,
      content:
        `${opts.amended ? "Amended and approved" : "Approved"} action ${item.proposed.tool} for ` +
        `${item.invoice.vendor ?? "a vendor"} (invoice ${item.invoice.vendor_ref ?? item.invoice.invoice_id}): ` +
        `${execution.summary}`,
      metadata: {
        invoice_id: item.invoice.invoice_id,
        vendor: item.invoice.vendor,
        tool: item.proposed.tool,
        amended: opts.amended,
      },
    });
    return item;
  }
}
