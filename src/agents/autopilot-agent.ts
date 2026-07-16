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
import { isDeepStrictEqual } from "node:util";
import type { Embedder } from "../memory/embeddings.js";
import { remember, recall } from "../memory/memory.js";
import type { MemoryStore } from "../memory/store.js";
import { AutopilotLoop } from "../ap/loop.js";
import { canonicalReference, canonicalVendorKey, normalizeInvoice } from "../ap/normalize.js";
import { assertValidToolArgs, toolByName } from "../ap/tools.js";
import { toRecalledFact } from "../ap/validate.js";
import {
  EXTRACTION_REVIEW_THRESHOLD,
  hasInferredPayableTotal,
  hasLowExtractionConfidence,
} from "../ap/extraction-confidence.js";
import type { Sinks } from "../ap/sinks.js";
import { sameMaterialInvoice, type WorkItemStore } from "../ap/workitem-store.js";
import type {
  Amendment,
  DecisionIntent,
  ExecutionResult,
  RawInvoice,
  RecalledFact,
  ToolName,
  TraceStep,
  WorkItem,
} from "../types.js";
import { scanForInjection } from "../qwen/injection-scan.js";
import { safeOperationalSummary } from "../security/operational-error.js";

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
  by?: string; // legacy direct-call field; HTTP identity is supplied separately and wins
}

export type RecoveryAction = "retry" | "mark_completed";

// Options for a single intake run. `onStep` is an optional live observer of the
// loop's autonomous read/analyze steps (used by the SSE /intake/stream route to
// stream the reasoning as it happens); it never affects the decision.
export interface IntakeOptions {
  onStep?: (step: TraceStep) => void;
  signal?: AbortSignal;
  retainProviderCallUntilSettled?: (operation: Promise<unknown>) => void;
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
    opts.signal?.throwIfAborted();
    const intakeStartedAt = performance.now();
    const invoice = normalizeInvoice(raw);
    const scan = scanForInjection(raw);

    // A live pending/executing proposal is the deterministic source for in-flight
    // duplicates. Pending memory is intentionally not a historical R5/R6 baseline.
    const existing = await this.workitems.findLive(invoice);
    if (existing) {
      assertCompatibleLiveRetry(existing, invoice);
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
    // vendor's completed evidence from the Autopilot store, validates (R1..R4), and — when
    // the recalled facts warrant it — confirms a duplicate (R5) or an amount anomaly
    // (R6), each an autonomous read/analyze step with NO side-effect, before Qwen
    // chooses ONE terminal action. The loop returns the proposal, the accumulated
    // findings + recalled facts, and the full ordered step trace.
    let { proposed, findings, recalled, trace, stopReason, telemetry } = await this.loop.run({
      invoice,
      embedder: this.embedder,
      memory: this.memory,
      onStep: opts.onStep, // live-stream each reasoning step (SSE) — no effect on the decision
      signal: opts.signal,
      retainProviderCallUntilSettled: opts.retainProviderCallUntilSettled,
    });
    opts.signal?.throwIfAborted();

    // Qwen-VL extraction confidence and Qwen's decision confidence are different
    // signals. A low-quality source read, or a payable total inferred because the
    // source did not provide it, deterministically overrides any proposed financial
    // action with human review. The exact source reason stays explicit in the trace.
    const lowExtractionConfidence = hasLowExtractionConfidence(invoice.extraction_confidence);
    const inferredPayableTotal = hasInferredPayableTotal(invoice.extraction_confidence, invoice.notes);
    if (lowExtractionConfidence || inferredPayableTotal) {
      const sourceConfidence = invoice.extraction_confidence!;
      const originalTool = proposed.tool;
      const sourceReasons = [
        ...(lowExtractionConfidence
          ? [
              `Qwen-VL extraction confidence ${sourceConfidence.toFixed(3)} is below the ` +
                `${EXTRACTION_REVIEW_THRESHOLD.toFixed(3)} source-quality threshold.`,
            ]
          : []),
        ...(inferredPayableTotal
          ? [
              `Qwen-VL did not return a readable payable total; normalization inferred ` +
                `${invoice.currency} ${invoice.total?.toFixed(2) ?? "unknown"} from subtotal + tax.`,
            ]
          : []),
      ];
      const guardName = inferredPayableTotal ? "source_extraction_guard" : "extraction_confidence_guard";
      const observation =
        `${sourceReasons.join(" ")} The ${originalTool} proposal was replaced ` +
        "with mandatory human review.";
      const guardStep: TraceStep = {
        step: trace.length + 1,
        tool: guardName,
        args: {
          extractionConfidence: sourceConfidence,
          threshold: EXTRACTION_REVIEW_THRESHOLD,
          payableTotalWasInferred: inferredPayableTotal,
        },
        observation,
        reasoning: "A weak or inferred document read must be verified before any AP action is approved.",
      };
      trace = [...trace, guardStep];
      opts.onStep?.(guardStep);
      findings = [
        ...findings,
        ...(lowExtractionConfidence
          ? [{ rule: "SOURCE_CONFIDENCE", passed: false, severity: "warn" as const, message: observation }]
          : []),
        ...(inferredPayableTotal
          ? [{ rule: "SOURCE_PAYABLE_TOTAL", passed: false, severity: "warn" as const, message: observation }]
          : []),
      ];
      proposed = {
        tool: "flag_for_review",
        args: {
          reason: inferredPayableTotal
            ? "Verify the payable total against the source document; it was inferred from subtotal + tax."
            : `Verify the Qwen-VL extraction before processing (source confidence ${sourceConfidence.toFixed(3)}).`,
          priority: "high",
        },
        reasoning: "Deterministic source-quality guard: weak or inferred Qwen-VL evidence requires human review.",
        confidence: 0,
        modelId: inferredPayableTotal ? "policy:source-extraction-guard" : "policy:extraction-confidence-guard",
      };
      stopReason = guardName;
      telemetry = {
        ...telemetry,
        finalProposedTool: "flag_for_review",
        policyOverride: true,
        policyOverrideSource: guardName,
        policyOverrideReason: observation,
      };
    }

    const failed = (rule: string) => findings.some((f) => f.rule === rule && !f.passed);

    const item: WorkItem = {
      id: randomUUID(),
      status: "pending",
      invoice,
      findings,
      recalled,
      proposed,
      trace,
      stopReason,
      telemetry: {
        ...telemetry,
        intakeToProposalMs: Math.round((performance.now() - intakeStartedAt) * 100) / 100,
        duplicateCaught: failed("R5"),
        anomalyCaught: failed("R6"),
        structuralBlock: ["R1", "R2", "R3", "R4", "SOURCE_CONFIDENCE", "SOURCE_PAYABLE_TOTAL"].some(failed),
        humanTouches: 0,
      },
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
    if (concurrentExisting) {
      assertCompatibleLiveRetry(concurrentExisting, invoice);
      return concurrentExisting;
    }

    return item;
  }

  // The human approval queue.
  async pending(limit = 100, offset = 0): Promise<WorkItem[]> {
    return this.workitems.listPending(limit, offset);
  }

  // The DECIDED history (approved / amended / rejected), most-recent first — the
  // "where did the one I approved go?" view. Read-only: decided items are terminal
  // and can never re-execute.
  async decided(limit = 100, offset = 0): Promise<WorkItem[]> {
    return this.workitems.listDecided(limit, offset);
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
  async approve(id: string, by = "direct-reviewer"): Promise<WorkItem> {
    const actor = reviewerActor(by);
    // Validate before claiming so a malformed model proposal remains amendable.
    const preview = await this.requirePending(id);
    const approvedArgs = canonicalizeReviewerArgs(preview.proposed.args);
    assertValidToolArgs(preview.proposed.tool, approvedArgs, preview.invoice);
    const item = await this.claimPending(id);
    recordHumanTouch(item);
    item.proposed = { ...item.proposed, args: structuredClone(approvedArgs) };
    // A retry after an uncertain amended execution preserves the exact amendment
    // the reviewer already authorized. Deriving this from the durable audit trail
    // prevents a recovered amend from being mislabeled as an ordinary approval.
    const amended = Boolean(item.amendment);
    const intent = await this.persistDecisionIntent(item, {
      kind: amended ? "amend" : "approve",
      tool: item.proposed.tool,
      args: structuredClone(approvedArgs),
      ...(item.amendment
        ? {
            amendment: structuredClone(item.amendment),
            ...(item.amendment.reason !== undefined ? { reason: item.amendment.reason } : {}),
          }
        : {}),
      by: amended ? (item.amendment?.amendedBy ?? actor) : actor,
      recordedAt: new Date().toISOString(),
    });
    return this.executeAndRemember(item, intent);
  }

  // A human edits the proposed DOMAIN arguments, then approves. The merged args
  // are what execute — so the human approves EXACTLY what runs. We capture the
  // ORIGINAL proposed args BEFORE merging, then persist both sides as an audit
  // trail (item.amendment = { proposedArgs → amendedArgs }) so the decided view can
  // show the exact prev → new diff.
  async amend(id: string, patch: AmendPatch, by = "direct-reviewer"): Promise<WorkItem> {
    const actor = reviewerActor(by);
    const preview = await this.requirePending(id);
    assertRequiredReviewerReason(patch.reason, "amendment");
    const amendedTool = patch.tool ?? preview.proposed.tool;
    const toolChanged = amendedTool !== preview.proposed.tool;
    if (toolChanged && (!patch.confirmToolOverride || (patch.reason?.trim().length ?? 0) < 12)) {
      throw new ConflictError(
        "changing the proposed tool requires confirmToolOverride=true and a specific audit reason of at least 12 characters"
      );
    }
    const previewArgs = canonicalizeReviewerArgs(toolChanged
      ? { ...(patch.args ?? {}) }
      : { ...preview.proposed.args, ...(patch.args ?? {}) });
    assertValidToolArgs(amendedTool, previewArgs, preview.invoice);

    const item = await this.claimPending(id);
    recordHumanTouch(item);
    const proposedTool = item.proposed.tool;
    const proposedArgs = item.proposed.args;
    const mergedArgs = canonicalizeReviewerArgs(toolChanged
      ? { ...(patch.args ?? {}) }
      : { ...proposedArgs, ...(patch.args ?? {}) });
    item.proposed = { ...item.proposed, tool: amendedTool, args: mergedArgs };
    item.amendment = {
      proposedTool,
      amendedTool,
      proposedArgs,
      amendedArgs: mergedArgs,
      amendedBy: actor,
      reason: patch.reason,
    };
    const intent = await this.persistDecisionIntent(item, {
      kind: "amend",
      tool: amendedTool,
      args: structuredClone(mergedArgs),
      amendment: structuredClone(item.amendment),
      reason: patch.reason,
      by: actor,
      recordedAt: new Date().toISOString(),
    });
    return this.executeAndRemember(item, intent);
  }

  // A human discards the proposal. Nothing executes; the rejection is remembered.
  async reject(id: string, reason?: string, by = "direct-reviewer"): Promise<WorkItem> {
    const actor = reviewerActor(by);
    await this.requirePending(id);
    assertRequiredReviewerReason(reason, "rejection");
    const item = await this.claimPending(id);
    recordHumanTouch(item);
    const intent = await this.persistDecisionIntent(item, {
      kind: "reject",
      tool: item.proposed.tool,
      args: structuredClone(item.proposed.args),
      reason,
      by: actor,
      recordedAt: new Date().toISOString(),
    });
    return this.completeRejection(item, intent);
  }

  // Recovery is intentionally explicit. `retry` is allowed only after a reviewer
  // has verified that no sink effect completed. `mark_completed` records external
  // reconciliation without calling the sink again.
  async recover(id: string, action: RecoveryAction, reason: string, by = "direct-reviewer"): Promise<WorkItem> {
    const actor = reviewerActor(by);
    assertReviewerReason(reason);
    if (!reason?.trim()) throw new ConflictError("recovery requires a non-empty audit reason");
    if (action !== "retry" && action !== "mark_completed") {
      throw new ConflictError(`unsupported recovery action ${action}`);
    }

    const observed = await this.requireExecuting(id);
    this.assertRecoveryEligible(observed);
    if (action === "retry" && observed.execution?.ok) {
      throw new ConflictError(
        `work item ${id} has a durably acknowledged sink result; only mark_completed is safe`
      );
    }
    const lease = {
      id: randomUUID(),
      action,
      reason: reason.trim(),
      by: actor,
      startedAt: new Date().toISOString(),
    } as const;
    // Five minutes is deliberately above the strict maximum duration of every
    // configured real sink (SMTP <= 120s total; JSONL is synchronous). A holder
    // renews immediately before the sink, so takeover cannot overlap an in-flight
    // effect. The lease id also fences every later checkpoint/finalization.
    const leaseMs = boundedEnvInt("EXECUTION_RECOVERY_LEASE_MS", 10 * 60_000, 5 * 60_000, 30 * 60_000);
    const current = await this.workitems.claimRecovery(
      id,
      lease,
      new Date(Date.now() - leaseMs).toISOString()
    );
    if (!current) {
      throw new ConflictError(`work item ${id} already has an active recovery attempt`);
    }
    // The row can change between the optimistic read above and the lease CAS. In
    // particular, the original executor may have refreshed its immediately-before-
    // sink fence while this recovery request was waiting to claim. Re-evaluate the
    // durable row returned by the CAS and relinquish the lease if it is no longer
    // stale/failing. This closes the recovery-read/original-fence race without ever
    // guessing which process owns the external effect.
    try {
      if (!isDeepStrictEqual(current.decisionIntent, observed.decisionIntent)) {
        throw new ConflictError(
          `work item ${id} reviewer authorization changed while recovery was claiming ownership`
        );
      }
      // claimRecovery itself replaces the (possibly expired) lease, so applying
      // assertRecoveryEligible directly to the returned row would mistake every
      // legitimate expired-lease takeover for a fresh recovery. The execution
      // timestamp is not changed by the lease CAS: an intervening executor fence
      // necessarily changes it and therefore requires a fresh eligibility check.
      if (current.executionStartedAt !== observed.executionStartedAt) {
        this.assertRecoveryEligible(current);
      }
    } catch (error) {
      await this.workitems.releaseRecovery(id, lease.id).catch(() => false);
      throw error;
    }
    if (action === "retry" && current.execution?.ok) {
      await this.workitems.releaseRecovery(id, lease.id).catch(() => false);
      throw new ConflictError(
        `work item ${id} has a durably acknowledged sink result; only mark_completed is safe`
      );
    }
    recordHumanTouch(current);
    current.recoveryBy = actor;
    const intent = current.decisionIntent;
    if (!intent) {
      await this.workitems.releaseRecovery(id, lease.id).catch(() => false);
      throw new ConflictError(
        `work item ${id} has no durable reviewer decision intent; recovery cannot infer an action`
      );
    }
    try {
      // A rejection has no external sink effect to retry. Its persisted rejection
      // intent is authoritative, so either recovery verb idempotently completes that
      // exact rejection instead of reopening it as a potentially approvable item.
      if (intent.kind === "reject") {
        current.recoveryReason = reason.trim();
        current.recoveredAt = new Date().toISOString();
        await this.persistRecoveryCheckpoint(current);
        return await this.completeRejection(current, intent);
      }

      if (action === "retry") {
        // Retry the exact immutable intent already on disk; never reopen PENDING
        // where a later request could mutate the authorized tool or arguments.
        current.recoveryReason = reason.trim();
        current.recoveredAt = new Date().toISOString();
        current.executionStartedAt = current.recoveredAt;
        delete current.executionFailure;
        await this.persistRecoveryCheckpoint(current);
        return await this.executeAndRemember(current, intent);
      }

      const item = current;
      item.proposed = { ...item.proposed, tool: intent.tool, args: structuredClone(intent.args) };
      item.amendment = intent.amendment ? structuredClone(intent.amendment) : undefined;
      item.amended = intent.kind === "amend";
      item.decisionReason = intent.reason ?? reason.trim();
      item.recoveryReason = reason.trim();
      item.recoveredAt = new Date().toISOString();
      const acknowledged = item.execution?.ok && item.execution.tool === intent.tool ? item.execution : null;
      item.execution = acknowledged
        ? {
            ...acknowledged,
            summary: `${acknowledged.summary} (reviewer reconciled: ${reason.trim()})`,
            output: { ...acknowledged.output, manuallyReconciled: true, reason: reason.trim() },
          }
        : {
            tool: intent.tool,
            ok: true,
            summary: `Manually reconciled as completed: ${reason.trim()}`,
            output: { manuallyReconciled: true, reason: reason.trim() },
          };
      await this.persistRecoveryCheckpoint(item);
      await this.rememberCompletedOutcome(
        item,
        intent.args,
        { amended: intent.kind === "amend", reason: intent.reason },
      item.execution
      );
      await this.persistPostEffectCheckpoint(item);
      item.status = "approved";
      item.decidedAt = item.recoveredAt;
      // The expected lease id fences the durable CAS; it is not terminal audit
      // state. Do not serialize an expired-looking "active" lease into approved
      // history, where releaseRecovery can no longer remove it.
      delete item.recoveryLease;
      if (!(await this.workitems.finishExecuting(item, lease.id))) {
        throw new ExecutionUncertainError(
          `work item ${id} outcome was reconciled but durable finalization did not complete; retry mark_completed`
        );
      }
      return item;
    } finally {
      // Terminal rows no longer match `status='executing'`; uncertain failures do,
      // and release lets a later audited recovery proceed. A process crash leaves
      // the lease behind until the bounded stale threshold permits takeover.
      await this.workitems.releaseRecovery(id, lease.id).catch(() => false);
    }
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
    if (item.executionFailure || item.execution?.ok || (item.decisionIntent?.kind === "reject" && item.rejectionMemory)) return;
    // A recovery holder refreshes `executionStartedAt` before its retry, so that
    // timestamp alone cannot decide takeover eligibility.  If its durable lease is
    // demonstrably stale, a new reviewer recovery may claim it; the lease-id CAS
    // still fences the old process at every checkpoint and immediately before a
    // sink.  This also makes a crashed recovery recoverable without waiting for a
    // second, unrelated execution-age window.
    const leaseStarted = Date.parse(item.recoveryLease?.startedAt ?? "");
    const leaseMs = boundedEnvInt("EXECUTION_RECOVERY_LEASE_MS", 10 * 60_000, 5 * 60_000, 30 * 60_000);
    if (item.recoveryLease && Number.isFinite(leaseStarted) && Date.now() - leaseStarted >= leaseMs) return;
    const started = Date.parse(item.executionStartedAt ?? "");
    const minAgeMs = boundedEnvInt("EXECUTION_RECOVERY_AFTER_MS", 5 * 60_000, 30_000, 24 * 60 * 60_000);
    if (!Number.isFinite(started) || Date.now() - started < minAgeMs) {
      throw new ConflictError(
        `work item ${item.id} is still within its active execution window; wait for a recorded failure or stale-claim timeout`
      );
    }
  }

  // Persist the exact reviewer-authorized decision while the claim is held and
  // BEFORE calling any sink or writing any correction memory. A false/failed CAS
  // is a safe abort: the external world has not been touched.
  private async persistDecisionIntent(
    item: WorkItem,
    intent: DecisionIntent
  ): Promise<DecisionIntent> {
    if (item.status !== "executing") {
      throw new ConflictError(`work item ${item.id} is not executing; decision intent was not recorded`);
    }
    if (item.decisionIntent) {
      throw new ConflictError(`work item ${item.id} already has a durable decision intent`);
    }
    const immutable = structuredClone(intent);
    item.decisionIntent = immutable;
    item.decisionReason = immutable.reason;
    delete item.executionFailure;
    delete item.execution;
    delete item.decidedAt;
    let persisted = false;
    try {
      persisted = await this.workitems.updateExecuting(item);
    } catch {
      throw new ConflictError(
        `could not confirm the durable reviewer intent for work item ${item.id}; nothing was executed`
      );
    }
    if (!persisted) {
      throw new ConflictError(
        `work item ${item.id} lost its execution claim before reviewer intent was recorded; nothing was executed`
      );
    }
    return immutable;
  }

  private async persistRecoveryCheckpoint(item: WorkItem): Promise<void> {
    const leaseId = item.recoveryLease?.id;
    if (!leaseId) throw new ConflictError(`work item ${item.id} has no active recovery lease`);
    try {
      if (await this.workitems.updateExecuting(item, leaseId)) return;
    } catch {
      // Stable operator-facing error below; raw infrastructure details stay out of
      // the durable work item and API response.
    }
    throw new ConflictError(
      `could not persist recovery authorization for work item ${item.id}; no recovery side effect ran`
    );
  }

  // Used only after a sink or memory effect may have completed. Failure is
  // explicitly uncertain and never triggers an automatic retry.
  private async persistPostEffectCheckpoint(item: WorkItem): Promise<void> {
    try {
      if (await this.workitems.updateExecuting(item, item.recoveryLease?.id)) return;
    } catch {
      // Converted to the stable uncertainty error below.
    }
    throw new ExecutionUncertainError(
      `an effect completed for work item ${item.id}, but its durable checkpoint failed; reconcile and use mark_completed`
    );
  }

  private async renewRecoveryFence(item: WorkItem): Promise<void> {
    const leaseId = item.recoveryLease?.id;
    const startedAt = new Date().toISOString();
    let current: WorkItem | null = null;
    try {
      current = await this.workitems.fenceExecution(item.id, startedAt, leaseId);
    } catch {
      // Stable no-effect conflict below.
    }
    if (!current) {
      throw new ConflictError(
        `${leaseId ? "recovery" : "execution"} ownership changed for work item ${item.id}; ` +
          `no new side effect was started`
      );
    }
    // Fencing ownership is necessary but not sufficient: the exact immutable
    // reviewer authorization must still be the durable one at the boundary. The
    // order-insensitive comparison also works for JSONB objects returned by PG.
    if (!item.decisionIntent || !isDeepStrictEqual(current.decisionIntent, item.decisionIntent)) {
      throw new ConflictError(
        `reviewer authorization changed for work item ${item.id}; no new side effect was started`
      );
    }
    if (current.execution?.ok && !isDeepStrictEqual(current.execution, item.execution)) {
      throw new ConflictError(
        `work item ${item.id} already has a different acknowledged outcome; no new side effect was started`
      );
    }
    item.executionStartedAt = current.executionStartedAt;
    if (leaseId && item.recoveryLease && current.recoveryLease) {
      item.recoveryLease.startedAt = current.recoveryLease.startedAt;
    }
  }

  private async completeRejection(item: WorkItem, intent: DecisionIntent): Promise<WorkItem> {
    if (intent.kind !== "reject") {
      throw new ConflictError(`work item ${item.id} does not carry a rejection intent`);
    }
    // Recovery is allowed to re-enter this block. The idempotency key returns the
    // same correction row, so a finish failure cannot duplicate rejection evidence.
    item.proposed = { ...item.proposed, tool: intent.tool, args: structuredClone(intent.args) };
    item.decisionReason = intent.reason;
    item.rejectionMemory = { stored: false };
    await this.renewRecoveryFence(item);
    try {
      await remember(this.embedder, this.memory, {
        idempotencyKey: outcomeMemoryKey(item.id, "rejection"),
        kind: "insight",
        vendor: item.invoice.vendor ?? "_global",
        sourceRef: item.invoice.invoice_id,
        importance: 0.7,
        content:
          `A proposed ${intent.tool} for ${item.invoice.vendor ?? "a vendor"} ` +
          `(invoice ${item.invoice.vendor_ref ?? item.invoice.invoice_id}) was REJECTED by a human` +
          `${intent.reason ? `: ${intent.reason}` : "."}`,
        metadata: {
          correction: "rejected",
          vendor: item.invoice.vendor,
          vendor_key: canonicalVendorKey(item.invoice.vendor),
          tool: intent.tool,
          invoice_id: item.invoice.invoice_id,
          work_item_id: item.id,
          reason: intent.reason ?? null,
        },
      });
      item.rejectionMemory.stored = true;
    } catch (err) {
      item.rejectionMemory.error = safeFailure(err);
    }
    await this.persistPostEffectCheckpoint(item);
    item.status = "rejected";
    item.decidedAt = new Date().toISOString();
    const recoveryLeaseId = item.recoveryLease?.id;
    delete item.recoveryLease;
    if (!(await this.workitems.finishExecuting(item, recoveryLeaseId))) {
      throw new ExecutionUncertainError(
        `rejection ${item.id} was authorized and correction evidence was attempted, but durable finalization failed; retry recovery`
      );
    }
    return item;
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
    const cur = approvedCurrencyCode(approvedArgs, item.invoice.currency);
    if (cur !== item.invoice.currency) return; // cross-currency amounts are not comparable
    const ref = item.invoice.vendor_ref ?? item.invoice.invoice_id;
    await remember(this.embedder, this.memory, {
      idempotencyKey: outcomeMemoryKey(item.id, "correction"),
      kind: "insight",
      vendor: item.invoice.vendor ?? "_global",
      sourceRef: item.invoice.invoice_id,
      importance: 0.85,
      content:
        `Human CORRECTION for ${item.invoice.vendor ?? "a vendor"}: the ${item.proposed.tool} on invoice ${ref} ` +
        `was AMENDED DOWN from ${cur} ${billed} (as billed) to ${cur} ${approved} (approved)` +
        `${reason ? ` — ${reason}` : "."} The agreed amount for this vendor is ${cur} ${approved}; a later invoice ` +
        `re-billing materially more should be escalated for review, not receive a payment proposal.`,
      metadata: {
        correction: "amended_down",
        vendor: item.invoice.vendor,
        vendor_key: canonicalVendorKey(item.invoice.vendor),
        tool: item.proposed.tool,
        corrected_amount: approved,
        corrected_currency: cur,
        billed_amount: billed,
        invoice_id: item.invoice.invoice_id,
        work_item_id: item.id,
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
    const approvedCurrency = approvedCurrencyCode(approvedArgs, item.invoice.currency);
    await remember(this.embedder, this.memory, {
      idempotencyKey: outcomeMemoryKey(item.id, "invoice"),
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
    intent: DecisionIntent
  ): Promise<WorkItem> {
    if (intent.kind === "reject") {
      throw new ConflictError(`rejection intent ${item.id} cannot enter a side-effecting execution path`);
    }
    const spec = toolByName(intent.tool);
    if (!spec) {
      throw new ConflictError(`unknown tool ${intent.tool} on work item ${item.id}`);
    }
    let execution: ExecutionResult;
    try {
      await this.renewRecoveryFence(item);
      // Work-item UUID, not caller-controlled invoice data, is the stable
      // idempotency/correlation key at every sink.
      execution = await spec.execute(intent.args, item.invoice, this.sinks, item.id);
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      item.executionFailure = safeFailure(err);
      await this.workitems.updateExecuting(item, item.recoveryLease?.id).catch(() => false);
      throw new ExecutionUncertainError(
        `execution outcome is uncertain for work item ${item.id}; it was NOT retried. ` +
          `Reconcile the sink, then use recovery (retry only if no effect completed, otherwise mark_completed).`
      );
    }

    // Acknowledge the sink result durably while the item remains executing. If the
    // process dies after this checkpoint, recovery has both the exact intent and
    // the acknowledged outcome and never has to infer either from mutable fields.
    item.execution = execution;
    item.proposed = { ...item.proposed, tool: intent.tool, args: structuredClone(intent.args) };
    item.amendment = intent.amendment ? structuredClone(intent.amendment) : undefined;
    item.amended = intent.kind === "amend";
    item.decisionReason = intent.reason;
    await this.persistPostEffectCheckpoint(item);

    await this.rememberCompletedOutcome(
      item,
      intent.args,
      { amended: intent.kind === "amend", reason: intent.reason },
      execution
    );
    await this.persistPostEffectCheckpoint(item);
    item.status = "approved";
    item.decidedAt = new Date().toISOString();
    const recoveryLeaseId = item.recoveryLease?.id;
    delete item.recoveryLease;
    if (!(await this.workitems.finishExecuting(item, recoveryLeaseId))) {
      throw new ExecutionUncertainError(
        `the sink completed for work item ${item.id}, but the durable completion record could not be finalized; reconcile manually`
      );
    }
    return item;
  }

  // Persist the action/invoice outcome and, when applicable, the downward amount
  // correction before finalizing the work item. Shared by ordinary execution and
  // audited mark_completed recovery so recovery cannot bypass correction evidence.
  private async rememberCompletedOutcome(
    item: WorkItem,
    args: Record<string, unknown>,
    opts: { amended: boolean; reason?: string },
    execution: ExecutionResult
  ): Promise<void> {
    // Write the OUTCOME back to memory — the agent gets smarter over time: the
    // next invoice from this vendor recalls what we actually did last time.
    const memoryWarnings: string[] = [];
    try {
      await remember(this.embedder, this.memory, {
        idempotencyKey: outcomeMemoryKey(item.id, "action"),
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
    // Only financially finalized tools create processed-invoice history used by
    // R5/R6. A clarification email or specialist-review escalation leaves the
    // invoice unresolved; treating either as paid/posted would poison duplicate
    // and amount baselines on the next submission.
    if (item.proposed.tool === "draft_payment" || item.proposed.tool === "draft_journal_entry") {
      try {
        await this.rememberApprovedInvoice(item, args);
      } catch (err) {
        memoryWarnings.push(`invoice memory: ${safeFailure(err)}`);
      }
    }
    // THE APPROVAL GATE AS A RUNTIME CORRECTION SIGNAL. This write is attempted
    // after the approved sink succeeds but BEFORE durable work-item finalization,
    // so its verified result travels with the decided item. It cannot roll back an
    // already-completed external effect, but failure is never swallowed or labelled
    // as persisted. No model weights are updated.
    if (opts.amended && item.amendment) {
      const billed = item.invoice.total;
      const approved = numericAmount(args["amount"]);
      const correctionCurrency = approvedCurrencyCode(args, item.invoice.currency);
      const applicable =
        approved != null &&
        billed != null &&
        correctionCurrency === item.invoice.currency &&
        approved < billed - 0.01;
      item.amendment.correctionMemory = { applicable, stored: false };
      if (applicable) {
        try {
          await this.rememberAmountCorrection(item, args, opts.reason);
          item.amendment.correctionMemory.stored = true;
        } catch (err) {
          const failure = safeFailure(err);
          item.amendment.correctionMemory.error = failure;
          memoryWarnings.push(`correction memory: ${failure}`);
        }
      }
    }
    if (memoryWarnings.length > 0) {
      execution.output["memoryWarning"] = memoryWarnings.join("; ");
    }
  }
}

function safeFailure(err: unknown): string {
  return safeOperationalSummary(err, "autopilot-workflow");
}

function assertCompatibleLiveRetry(existing: WorkItem, invoice: WorkItem["invoice"]): void {
  if (sameMaterialInvoice(existing.invoice, invoice)) return;
  throw new ConflictError(
    `invoice identity collides with live work item ${existing.id}, but its normalized financial payload differs; ` +
      `review the existing proposal instead of silently replacing or reusing it`
  );
}

function outcomeMemoryKey(
  workItemId: string,
  kind: "action" | "invoice" | "correction" | "rejection"
): string {
  return `work-item:${workItemId}:outcome:${kind}:v1`;
}

function recordHumanTouch(item: WorkItem): void {
  if (!item.telemetry) return;
  item.telemetry.humanTouches = Math.max(0, item.telemetry.humanTouches ?? 0) + 1;
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

function approvedCurrencyCode(args: Record<string, unknown>, fallback: string): string {
  return typeof args["currency"] === "string" ? args["currency"].toUpperCase() : fallback;
}

// Reviewer form values are user-controlled, but the durable intent and the sink
// receive one canonical representation. In particular, `eur` cannot execute as a
// lowercase currency while later memory silently records `EUR`.
function canonicalizeReviewerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  if (typeof normalized["currency"] === "string") {
    normalized["currency"] = normalized["currency"].trim().toUpperCase();
  }
  if (typeof normalized["to"] === "string") {
    normalized["to"] = normalized["to"].trim();
  }
  return normalized;
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

function assertRequiredReviewerReason(reason: string | undefined, action: string): void {
  assertReviewerReason(reason);
  if (!reason?.trim()) {
    throw new ConflictError(`${action} requires a non-empty audit reason`);
  }
}

function reviewerActor(value: string): string {
  const actor = value.trim();
  if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(actor)) {
    throw new ConflictError("reviewer identity must be 1–128 printable characters");
  }
  return actor;
}
