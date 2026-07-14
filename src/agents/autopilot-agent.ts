// AutopilotAgent — the end-to-end accounts-payable orchestration loop.
//
// This is the Track-4 "autopilot" itself: it runs the AP workflow from a messy
// incoming invoice all the way to an executed action, with a HUMAN APPROVAL GATE
// in the middle. It recommends; it never auto-executes.
//
//   intake()   Normalize the invoice, then run a bounded multi-step ReAct loop
//              (AutopilotLoop): the agent recalls the vendor's history from
//              persistent memory, validates, checks for a duplicate, and computes
//              the amount variance — each an autonomous read/analyze step with NO
//              side-effect — before Qwen chooses ONE terminal action. That proposal
//              plus the full step trace is persisted as a PENDING work item —
//              nothing executes yet.
//   pending()  The human approval queue.
//   approve()  A human approves → the chosen tool runs for real → the outcome is
//              written BACK to memory so the agent gets smarter next time.
//   amend()    A human edits the proposed arguments, then approves → the EXACT
//              amended args are what execute (the HITL integrity guarantee).
//   reject()   A human discards the proposal → nothing executes.
//
// Everything is injected (embedder, memory store, work-item store, loop, sinks) so
// the whole loop runs offline with Fakes in tests and against real Qwen + a
// pgvector database (local, CI, Alibaba Cloud) in production, unchanged.

import { randomUUID } from "node:crypto";
import type { Embedder } from "../memory/embeddings.js";
import { remember, recall } from "../memory/memory.js";
import type { MemoryStore } from "../memory/store.js";
import { AutopilotLoop } from "../ap/loop.js";
import { canonicalReference, canonicalVendorKey, normalizeInvoice } from "../ap/normalize.js";
import { assertValidToolArgs, toolByName } from "../ap/tools.js";
import { toRecalledFact } from "../ap/validate.js";
import { EXTRACTION_REVIEW_THRESHOLD, hasLowExtractionConfidence } from "../ap/extraction-confidence.js";
import type { Sinks } from "../ap/sinks.js";
import { findLiveDuplicate, type WorkItemStore } from "../ap/workitem-store.js";
import type { ExecutionResult, RawInvoice, RecalledFact, ToolName, TraceStep, WorkItem } from "../types.js";
import { scanForInjection } from "../qwen/injection-scan.js";

// Raised when a work item id does not exist → HTTP 404.
export class NotFoundError extends Error {}
// Raised when a work item has already been decided (approved/rejected) → HTTP 409.
// The core of the approval gate: a decided item can never be re-executed.
export class ConflictError extends Error {}
// The sink may have completed before failing/losing its acknowledgement. We keep
// the durable item in `executing`; an authenticated reviewer must reconcile it.
export class ExecutionUncertainError extends Error {}

export interface AmendPatch {
  args?: Record<string, unknown>; // domain-arg edits merged onto the proposal
  tool?: ToolName; // explicit reviewer-authorized tool override
  confirmToolOverride?: boolean; // required when `tool` differs from Qwen's proposal
  reason?: string; // human note on why it was amended
  by?: string; // optional operator identity, recorded on the amend audit trail
}

export type RecoveryAction = "retry" | "mark_completed";

// Options for a single intake run. `onStep` is an optional live observer of the
// loop's autonomous read/analyze steps (used by the SSE /intake/stream route to
// stream the reasoning as it happens); it never affects the decision.
export interface IntakeOptions {
  onStep?: (step: TraceStep) => void;
}

export class AutopilotAgent {
  constructor(
    private embedder: Embedder,
    private memory: MemoryStore,
    private workitems: WorkItemStore,
    private loop: AutopilotLoop,
    private sinks: Sinks
  ) {}

  // ── intake → multi-step ReAct loop → PENDING (no execution) ────────────────
  async intake(raw: RawInvoice, opts: IntakeOptions = {}): Promise<WorkItem> {
    const invoice = normalizeInvoice(raw);
    const scan = scanForInjection(raw);

    // A live pending/executing proposal is the deterministic source for in-flight
    // duplicates. Pending memory is intentionally not a historical R5/R6 baseline.
    const existing = findLiveDuplicate(await this.workitems.listPending(), invoice);
    if (existing) {
      // A streamed/UI caller still needs an explicit explanation. Reusing the
      // existing live item is intentional idempotency, not a silent failure or an
      // empty agent run. This observation is read-only and does not alter the
      // persisted trace of the proposal that originally won the race.
      opts.onStep?.({
        step: 1,
        tool: "live_idempotency_guard",
        args: { existingStatus: existing.status },
        observation: "An identical invoice already has a live proposal; reusing it instead of creating a duplicate queue item.",
        reasoning: "Exactly one live proposal may exist for the same logical invoice.",
      });
      return existing;
    }

    // Run the bounded observe→decide→act loop. Inside it the agent recalls the
    // vendor's history (the MemoryAgent foundation), validates (R1..R4), and — when
    // the recalled facts warrant it — confirms a duplicate (R5) or an amount anomaly
    // (R6), each an autonomous read/analyze step with NO side-effect, before Qwen
    // chooses ONE terminal action. The loop returns the proposal, the accumulated
    // findings + recalled facts, and the full ordered step trace.
    let { proposed, findings, recalled, trace, stopReason } = await this.loop.run({
      invoice,
      embedder: this.embedder,
      memory: this.memory,
      onStep: opts.onStep, // live-stream each reasoning step (SSE) — no effect on the decision
    });

    // Qwen-VL extraction confidence and Qwen's decision confidence are different
    // signals. A low-quality source read deterministically overrides any proposed
    // financial action with human review, and the override is explicit in the trace.
    if (hasLowExtractionConfidence(invoice.extraction_confidence)) {
      const sourceConfidence = invoice.extraction_confidence!;
      const originalTool = proposed.tool;
      const observation =
        `Qwen-VL extraction confidence ${sourceConfidence.toFixed(3)} is below the ` +
        `${EXTRACTION_REVIEW_THRESHOLD.toFixed(3)} source-quality threshold. ` +
        `The ${originalTool} proposal was replaced with mandatory human review.`;
      const guardStep: TraceStep = {
        step: trace.length + 1,
        tool: "extraction_confidence_guard",
        args: { extractionConfidence: sourceConfidence, threshold: EXTRACTION_REVIEW_THRESHOLD },
        observation,
        reasoning: "A weak document read must be verified before any AP action is approved.",
      };
      trace = [...trace, guardStep];
      opts.onStep?.(guardStep);
      findings = [
        ...findings,
        {
          rule: "SOURCE_CONFIDENCE",
          passed: false,
          severity: "warn",
          message: observation,
        },
      ];
      proposed = {
        tool: "flag_for_review",
        args: {
          reason: `Verify the Qwen-VL extraction before processing (source confidence ${sourceConfidence.toFixed(3)}).`,
          priority: "high",
        },
        reasoning: "Deterministic source-quality guard: low Qwen-VL extraction confidence requires human review.",
        confidence: 0,
        modelId: "policy:extraction-confidence-guard",
      };
      stopReason = "extraction_confidence_guard";
    }

    const item: WorkItem = {
      id: randomUUID(),
      status: "pending",
      invoice,
      findings,
      recalled,
      proposed,
      trace,
      stopReason,
      inputSecurity: {
        injectionDetected: scan.detected,
        injectionCount: scan.count,
        matches: scan.matches,
        autonomousExecutionBlocked: true,
      },
      createdAt: new Date().toISOString(),
    };
    // This create is itself atomic across replicas. If another intake for the same
    // live invoice won the race while our loop was running, return that one queue
    // item instead of creating two independent proposals.
    const concurrentExisting = await this.workitems.create(item);
    if (concurrentExisting) return concurrentExisting;

    return item;
  }

  // The human approval queue.
  async pending(): Promise<WorkItem[]> {
    return this.workitems.listPending();
  }

  // The DECIDED history (approved / amended / rejected), most-recent first — the
  // "where did the one I approved go?" view. Read-only: decided items are terminal
  // and can never re-execute.
  async decided(): Promise<WorkItem[]> {
    return this.workitems.listDecided();
  }

  async get(id: string): Promise<WorkItem> {
    const item = await this.workitems.get(id);
    if (!item) throw new NotFoundError(`work item ${id} not found`);
    return item;
  }

  // Recall a vendor's prior facts from persistent memory — the same
  // memory-grounding the loop's recall_vendor_history skill uses, exposed on its
  // own so an operator (or an MCP client) can inspect what the agent knows about a
  // vendor WITHOUT running an intake. Read-only: it touches no sink and decides
  // nothing; it surfaces the recalled facts (prior invoices, actions, insights).
  async recallVendor(vendor: string, limit = 8): Promise<RecalledFact[]> {
    const name = vendor.trim();
    if (!name) return [];
    const hits = await recall(this.embedder, this.memory, `history for vendor ${name}`, {
      vendor: name,
      limit,
    });
    return hits.map(toRecalledFact);
  }

  // ── 6: approve → EXECUTE the tool for real → remember the outcome ───────────
  async approve(id: string): Promise<WorkItem> {
    // Validate before claiming so a malformed model proposal remains amendable.
    const preview = await this.requirePending(id);
    assertValidToolArgs(preview.proposed.tool, preview.proposed.args, preview.invoice);
    const item = await this.claimPending(id);
    return this.executeAndRemember(item, item.proposed.args, { amended: false });
  }

  // A human edits the proposed DOMAIN arguments, then approves. The merged args
  // are what execute — so the human approves EXACTLY what runs. We capture the
  // ORIGINAL proposed args BEFORE merging, then persist both sides as an audit
  // trail (item.amendment = { proposedArgs → amendedArgs }) so the decided view can
  // show the exact prev → new diff.
  async amend(id: string, patch: AmendPatch): Promise<WorkItem> {
    assertReviewerReason(patch.reason);
    const preview = await this.requirePending(id);
    const amendedTool = patch.tool ?? preview.proposed.tool;
    const toolChanged = amendedTool !== preview.proposed.tool;
    if (toolChanged && (!patch.confirmToolOverride || !patch.reason?.trim())) {
      throw new ConflictError(
        "changing the proposed tool requires confirmToolOverride=true and a non-empty audit reason"
      );
    }
    const previewArgs = toolChanged
      ? { ...(patch.args ?? {}) }
      : { ...preview.proposed.args, ...(patch.args ?? {}) };
    assertValidToolArgs(amendedTool, previewArgs, preview.invoice);

    const item = await this.claimPending(id);
    const proposedTool = item.proposed.tool;
    const proposedArgs = item.proposed.args;
    const mergedArgs = toolChanged
      ? { ...(patch.args ?? {}) }
      : { ...proposedArgs, ...(patch.args ?? {}) };
    item.proposed = { ...item.proposed, tool: amendedTool, args: mergedArgs };
    item.amendment = {
      proposedTool,
      amendedTool,
      proposedArgs,
      amendedArgs: mergedArgs,
      amendedBy: patch.by,
      reason: patch.reason,
    };
    const result = await this.executeAndRemember(item, mergedArgs, {
      amended: true,
      reason: patch.reason,
    });
    // THE APPROVAL GATE AS A TRAINING SIGNAL: when the human approved a LOWER amount
    // than was billed, record that downward correction as a first-class, recallable
    // memory (structured metadata), so the next invoice from this vendor can reason
    // over "we already corrected this vendor's amount down" and escalate a re-bill
    // rather than straight-through paying it (see analysis-tools.ts runRecall).
    await this.rememberAmountCorrection(item, mergedArgs, patch.reason).catch(() => {});
    return result;
  }

  // A human discards the proposal. Nothing executes; the rejection is remembered.
  async reject(id: string, reason?: string): Promise<WorkItem> {
    assertReviewerReason(reason);
    const item = await this.claimPending(id);
    item.status = "rejected";
    item.decisionReason = reason;
    item.decidedAt = new Date().toISOString();
    if (!(await this.workitems.finishExecuting(item))) {
      throw new ConflictError(`work item ${id} lost its execution claim before rejection completed`);
    }

    await remember(this.embedder, this.memory, {
      kind: "insight",
      vendor: item.invoice.vendor ?? "_global",
      sourceRef: item.invoice.invoice_id,
      importance: 0.7,
      content:
        `A proposed ${item.proposed.tool} for ${item.invoice.vendor ?? "a vendor"} ` +
        `(invoice ${item.invoice.vendor_ref ?? item.invoice.invoice_id}) was REJECTED by a human` +
        `${reason ? `: ${reason}` : "."}`,
      // Structured so recall can surface this rejection as a first-class prior human
      // correction on the vendor (the approval gate feeding the next decision).
      metadata: {
        correction: "rejected",
        vendor: item.invoice.vendor,
        vendor_key: canonicalVendorKey(item.invoice.vendor),
        tool: item.proposed.tool,
        invoice_id: item.invoice.invoice_id,
        reason: reason ?? null,
      },
    }).catch(() => {});
    return item;
  }

  // Recovery is intentionally explicit. `retry` is allowed only after a reviewer
  // has verified that no sink effect completed. `mark_completed` records external
  // reconciliation without calling the sink again.
  async recover(id: string, action: RecoveryAction, reason: string): Promise<WorkItem> {
    assertReviewerReason(reason);
    if (!reason?.trim()) throw new ConflictError("recovery requires a non-empty audit reason");
    const current = await this.requireExecuting(id);
    this.assertRecoveryEligible(current);
    if (action === "retry") {
      const reset = await this.workitems.resetExecuting(id, reason.trim());
      if (reset) return reset;
      const latest = await this.workitems.get(id);
      if (!latest) throw new NotFoundError(`work item ${id} not found`);
      throw new ConflictError(`work item ${id} is ${latest.status}, not awaiting execution recovery`);
    }
    if (action !== "mark_completed") throw new ConflictError(`unsupported recovery action ${action}`);

    const item = current;
    item.status = "approved";
    item.amended = item.amended ?? false;
    item.decisionReason = reason.trim();
    item.recoveryReason = reason.trim();
    item.recoveredAt = new Date().toISOString();
    item.decidedAt = item.recoveredAt;
    item.execution = {
      tool: item.proposed.tool,
      ok: true,
      summary: `Manually reconciled as completed: ${reason.trim()}`,
      output: { manuallyReconciled: true, reason: reason.trim() },
    };
    try {
      await this.rememberApprovedInvoice(item, item.proposed.args);
    } catch (err) {
      item.execution.output["memoryWarning"] = safeFailure(err);
    }
    if (!(await this.workitems.finishExecuting(item))) {
      throw new ConflictError(`work item ${id} was concurrently recovered`);
    }
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

  private async claimPending(id: string): Promise<WorkItem> {
    const claimed = await this.workitems.claimPending(id);
    if (claimed) return claimed;
    // Distinguish missing from already claimed/decided without weakening the
    // atomic UPDATE/compare-and-swap above.
    const current = await this.workitems.get(id);
    if (!current) throw new NotFoundError(`work item ${id} not found`);
    throw new ConflictError(`work item ${id} is already ${current.status} and cannot be acted on again`);
  }

  private async requireExecuting(id: string): Promise<WorkItem> {
    const item = await this.workitems.get(id);
    if (!item) throw new NotFoundError(`work item ${id} not found`);
    if (item.status !== "executing") {
      throw new ConflictError(`work item ${id} is ${item.status}, not awaiting execution recovery`);
    }
    return item;
  }

  // Do not let a reviewer reset a claim while its sink call is normally still in
  // flight. A recorded failure is immediately recoverable; a claim left behind by
  // a crashed process becomes recoverable only after a bounded stale-claim window.
  // Recovery still requires the reviewer to verify the external system first.
  private assertRecoveryEligible(item: WorkItem): void {
    if (item.executionFailure) return;
    const started = Date.parse(item.executionStartedAt ?? "");
    const minAgeMs = boundedEnvInt("EXECUTION_RECOVERY_AFTER_MS", 5 * 60_000, 30_000, 24 * 60 * 60_000);
    if (!Number.isFinite(started) || Date.now() - started < minAgeMs) {
      throw new ConflictError(
        `work item ${item.id} is still within its active execution window; wait for a recorded failure or stale-claim timeout`
      );
    }
  }

  // Record a human DOWNWARD amount correction as a recallable memory. Fires only
  // when the human approved a numeric `amount` materially BELOW what the vendor
  // billed (the invoice total) — i.e. "you billed X, the agreed amount is the lower
  // Y". Stored with structured metadata so runRecall can lift `corrected_amount`
  // back out and the loop can escalate a future re-bill above it. A no-op for an
  // amendment that did not lower the amount (e.g. a memo/account edit), so it never
  // manufactures a correction that did not happen.
  private async rememberAmountCorrection(
    item: WorkItem,
    approvedArgs: Record<string, unknown>,
    reason?: string
  ): Promise<void> {
    const billed = item.invoice.total;
    const approved = numericAmount(approvedArgs["amount"]);
    if (approved == null || billed == null) return;
    if (approved >= billed - 0.01) return; // not a downward correction → nothing to learn
    const cur = item.invoice.currency;
    const ref = item.invoice.vendor_ref ?? item.invoice.invoice_id;
    await remember(this.embedder, this.memory, {
      kind: "insight",
      vendor: item.invoice.vendor ?? "_global",
      sourceRef: item.invoice.invoice_id,
      importance: 0.85,
      content:
        `Human CORRECTION for ${item.invoice.vendor ?? "a vendor"}: the ${item.proposed.tool} on invoice ${ref} ` +
        `was AMENDED DOWN from ${cur} ${billed} (as billed) to ${cur} ${approved} (approved)` +
        `${reason ? ` — ${reason}` : "."} The agreed amount for this vendor is ${cur} ${approved}; a later invoice ` +
        `re-billing materially more should be escalated for review, not auto-paid.`,
      metadata: {
        correction: "amended_down",
        vendor: item.invoice.vendor,
        vendor_key: canonicalVendorKey(item.invoice.vendor),
        tool: item.proposed.tool,
        corrected_amount: approved,
        billed_amount: billed,
        invoice_id: item.invoice.invoice_id,
      },
    });
  }

  // R5/R6 history contains completed facts only. The amount baseline reflects
  // what the reviewer actually approved (when an amount arg exists), while the
  // original billed total remains available for audit.
  private async rememberApprovedInvoice(
    item: WorkItem,
    approvedArgs: Record<string, unknown>
  ): Promise<void> {
    const approvedAmount = numericAmount(approvedArgs["amount"]) ?? item.invoice.total;
    const approvedCurrency =
      typeof approvedArgs["currency"] === "string"
        ? approvedArgs["currency"].toUpperCase()
        : item.invoice.currency;
    await remember(this.embedder, this.memory, {
      kind: "invoice",
      vendor: item.invoice.vendor ?? "_global",
      sourceRef: item.invoice.invoice_id,
      importance: 0.8,
      content:
        `Approved invoice ${item.invoice.vendor_ref ?? item.invoice.invoice_id} from ` +
        `${item.invoice.vendor ?? "unknown vendor"} for ${approvedCurrency} ${approvedAmount ?? "?"}` +
        `${item.invoice.invoice_date ? ` dated ${item.invoice.invoice_date}` : ""}.`,
      metadata: {
        invoice_id: item.invoice.invoice_id,
        work_item_id: item.id,
        vendor: item.invoice.vendor,
        vendor_key: canonicalVendorKey(item.invoice.vendor),
        vendor_ref: item.invoice.vendor_ref,
        vendor_ref_key: canonicalReference(item.invoice.vendor_ref),
        total: approvedAmount,
        billed_total: item.invoice.total,
        invoice_date: item.invoice.invoice_date,
        currency: approvedCurrency,
        processing_status: "approved",
        approved_tool: item.proposed.tool,
      },
    });
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
    let execution: ExecutionResult;
    try {
      // Work-item UUID, not caller-controlled invoice data, is the stable
      // idempotency/correlation key at every sink.
      execution = await spec.execute(args, item.invoice, this.sinks, item.id);
    } catch (err) {
      item.executionFailure = safeFailure(err);
      await this.workitems.updateExecuting(item).catch(() => false);
      throw new ExecutionUncertainError(
        `execution outcome is uncertain for work item ${item.id}; it was NOT retried. ` +
          `Reconcile the sink, then use recovery (retry only if no effect completed, otherwise mark_completed).`
      );
    }

    item.status = "approved";
    item.execution = execution;
    item.amended = opts.amended;
    if (opts.reason) item.decisionReason = opts.reason;
    item.decidedAt = new Date().toISOString();
    // Write the OUTCOME back to memory — the agent gets smarter over time: the
    // next invoice from this vendor recalls what we actually did last time.
    const memoryWarnings: string[] = [];
    try {
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
          work_item_id: item.id,
          vendor: item.invoice.vendor,
          vendor_key: canonicalVendorKey(item.invoice.vendor),
          tool: item.proposed.tool,
          amended: opts.amended,
        },
      });
    } catch (err) {
      memoryWarnings.push(`action memory: ${safeFailure(err)}`);
    }
    try {
      await this.rememberApprovedInvoice(item, args);
    } catch (err) {
      memoryWarnings.push(`invoice memory: ${safeFailure(err)}`);
    }
    if (memoryWarnings.length > 0) {
      execution.output["memoryWarning"] = memoryWarnings.join("; ");
    }
    if (!(await this.workitems.finishExecuting(item))) {
      throw new ExecutionUncertainError(
        `the sink completed for work item ${item.id}, but the durable completion record could not be finalized; reconcile manually`
      );
    }
    return item;
  }
}

function safeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\0]/g, " ").slice(0, 500) || "unknown execution failure";
}

// Coerce an amount arg (number, or a numeric string) to a finite number, else null.
// Kept lenient because a human amend may arrive as a string from a form field.
function numericAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function assertReviewerReason(reason: string | undefined): void {
  if (reason != null && reason.length > 1000) {
    throw new ConflictError("reviewer reason must be at most 1000 characters");
  }
}
