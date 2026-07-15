// The AUTONOMOUS read/analyze tool tier — the tools that make the loop multi-step.
//
// These are the tools the agent may call INSIDE the bounded ReAct loop with NO
// external side-effect. Because they only read memory / compute over the invoice,
// the agent can genuinely reason across several observations before it proposes a
// terminal, human-gated action (e.g. recall history → see the prior amount →
// compute the variance → conclude it is anomalous → flag it). They NEVER touch the
// Sinks and NEVER end the loop — that is what keeps the human-in-the-loop gate
// ironclad while still letting the agent do real multi-step work.
//
//   recall_vendor_history        — pgvector recall of this vendor's prior invoices;
//                                  surfaces raw FACTS (prior refs, amounts, dates,
//                                  the amount ratio) — it does NOT decide anything.
//   validate_invoice             — structural cross-checks R1–R4.
//   check_duplicate              — the memory-grounded R5 duplicate finding
//                                  (needs recall first).
//   compute_variance_vs_history  — the memory-grounded R6 amount-anomaly finding
//                                  (needs recall first).
//   request_more_context         — record that more information is needed.
//
// The R1–R6 rule set is split across the tools by data dependency: validate_invoice
// owns the structural R1–R4 (no memory needed); check_duplicate owns R5 and
// compute_variance_vs_history owns R6, because both need the vendor history recall
// has to fetch first. Together they cover R1–R6.

import type { ToolDef } from "../qwen/client.js";
import type { Embedder } from "../memory/embeddings.js";
import type { MemoryRecord, MemoryStore } from "../memory/store.js";
import { recall } from "../memory/memory.js";
import {
  detectAmountAnomaly,
  detectDuplicate,
  priorInvoicesFromRecall,
  robustAmountBaseline,
  toRecalledFact,
  validateInvoice,
  type PriorInvoice,
} from "./validate.js";
import type {
  NormalizedInvoice,
  RecalledFact,
  ValidationFinding,
} from "../types.js";
import { canonicalReference, canonicalVendorKey } from "./normalize.js";
import { isSupportedCurrency } from "./currency.js";

// The names of the autonomous tools (the read/analyze tier).
export const ANALYSIS_TOOL_NAMES = [
  "recall_vendor_history",
  "validate_invoice",
  "check_duplicate",
  "compute_variance_vs_history",
  "request_more_context",
] as const;
export type AnalysisToolName = (typeof ANALYSIS_TOOL_NAMES)[number];

export function isAnalysisTool(name: string): name is AnalysisToolName {
  return (ANALYSIS_TOOL_NAMES as readonly string[]).includes(name);
}

// The accumulator carried across loop steps: the invoice under decision, the facts
// and findings gathered so far, and the progress flags the loop + the deterministic
// offline policy read from the machine-readable EVIDENCE line (see computeEvidence).
export interface LoopState {
  invoice: NormalizedInvoice;
  recalled: RecalledFact[];
  priors: PriorInvoice[];
  findings: ValidationFinding[];

  // progress flags — which autonomous tools have already run
  didRecall: boolean;
  didValidate: boolean;
  didCheckDuplicate: boolean;
  didComputeVariance: boolean;

  // FACTS surfaced by recall (not decisions) — the routing hints the loop reasons over
  knownVendor: boolean; // recall found ≥1 prior invoice for this vendor
  priorCount: number;
  refMatch: boolean; // a prior invoice shares this vendor_ref (a fact, not a verdict)
  amountDateMatch: boolean; // a prior shares this total + date (a fact, not a verdict)
  amountRatio: number | null; // this total ÷ the vendor's robust historical median
  currencyChanged: boolean; // known vendor has completed history, but none in this supported currency

  // CONFIRMED findings — set ONLY once the owning analysis tool actually runs
  duplicate: boolean; // R5 confirmed by check_duplicate
  missingFields: boolean; // R2 confirmed by validate_invoice
  reconcileIssue: boolean; // R3/R4 confirmed by validate_invoice
  anomaly: boolean; // R6 confirmed by compute_variance_vs_history
  noTotal: boolean; // R1 confirmed by validate_invoice

  // PRIOR HUMAN CORRECTIONS surfaced by recall — the "approval gate as training
  // signal". These are FACTS read back from what a human previously did to this
  // vendor's proposals (amended the amount down, or rejected one), NOT verdicts:
  priorRejection: boolean; // a past proposal for this vendor was rejected by a human
  priorCorrection: boolean; // any prior human correction on record for this vendor
  correctedAmount: number | null; // the most-recent amount a human corrected this vendor DOWN to
  rebillsCorrected: boolean; // this invoice re-bills materially ABOVE that corrected amount
}

export function newLoopState(invoice: NormalizedInvoice): LoopState {
  return {
    invoice,
    recalled: [],
    priors: [],
    findings: [],
    didRecall: false,
    didValidate: false,
    didCheckDuplicate: false,
    didComputeVariance: false,
    knownVendor: false,
    priorCount: 0,
    refMatch: false,
    amountDateMatch: false,
    amountRatio: null,
    currencyChanged: false,
    duplicate: false,
    missingFields: false,
    reconcileIssue: false,
    anomaly: false,
    noTotal: false,
    priorRejection: false,
    priorCorrection: false,
    correctedAmount: null,
    rebillsCorrected: false,
  };
}

// A future invoice must re-bill more than 5% ABOVE the human-corrected amount before
// it counts as re-billing the corrected-down amount — a small margin so a trivial,
// legitimate increase (or rounding) does not trip the escalation (no crying wolf).
const CORRECTION_REBILL_MARGIN = 1.05;

export interface AnalysisDeps {
  embedder: Embedder;
  memory: MemoryStore;
  signal?: AbortSignal;
}

// Execute one autonomous read/analyze tool. Mutates `state` (adds findings / facts)
// and returns the natural-language observation the model reads on the next step. No
// tool here has any external side-effect — none touch the Sinks.
export async function executeAnalysisTool(
  name: AnalysisToolName,
  args: Record<string, unknown>,
  state: LoopState,
  deps: AnalysisDeps
): Promise<string> {
  switch (name) {
    case "recall_vendor_history":
      return runRecall(state, deps);
    case "validate_invoice":
      return runValidate(state);
    case "check_duplicate":
      return runCheckDuplicate(state);
    case "compute_variance_vs_history":
      return runComputeVariance(state);
    case "request_more_context":
      return runRequestContext(args);
  }
}

async function runRecall(state: LoopState, { embedder, memory, signal }: AnalysisDeps): Promise<string> {
  const inv = state.invoice;
  if (state.didRecall) return recallSummary(state); // idempotent — never re-query
  const query =
    `${inv.vendor ?? "vendor"} invoice ${inv.vendor_ref ?? ""} ` +
    `${inv.total ?? ""} ${inv.currency}`.trim();
  const [hits, boundedHistory, deterministicCorrections, exactDuplicate] = inv.vendor
    ? await Promise.all([
        recall(embedder, memory, query, { vendor: inv.vendor, limit: 8 }, signal),
        memory.invoiceHistory(inv.vendor),
        memory.correctionHistory(inv.vendor),
        memory.findProcessedDuplicate(inv),
      ])
    : [[], [], [], null];
  state.recalled = hits.map(toRecalledFact);
  // R5/R6 run over deterministic vendor history, not whichever eight semantic
  // results happened to rank highest. The exact indexed R5 match is injected even
  // when it falls outside the bounded R6 history window. Semantic hits remain the
  // reviewer-facing evidence and correction-recall channel.
  const deterministicHistory = exactDuplicate && !boundedHistory.some((row) => row.id === exactDuplicate.id)
    ? [exactDuplicate, ...boundedHistory]
    : boundedHistory;
  state.priors = priorInvoicesFromRecall(deterministicHistory);

  // Derive raw FACTS from the recalled priors — NOT decisions. The R5/R6 verdicts
  // are produced later by check_duplicate / compute_variance, so this stays honest.
  const vendorPriors = state.priors.filter(
    (p) => !!inv.vendor && canonicalVendorKey(p.vendor) === canonicalVendorKey(inv.vendor)
  );
  state.priorCount = vendorPriors.length;
  state.knownVendor = vendorPriors.length > 0;
  const priorCurrencies = new Set(
    vendorPriors.map((prior) => prior.currency).filter((code): code is string => isSupportedCurrency(code))
  );
  state.currencyChanged =
    state.knownVendor &&
    isSupportedCurrency(inv.currency) &&
    priorCurrencies.size > 0 &&
    !priorCurrencies.has(inv.currency);
  if (state.currencyChanged) {
    state.findings.push({
      rule: "CURRENCY_CHANGE",
      passed: false,
      severity: "warn",
      message:
        `Currency changed to ${inv.currency}; completed history for this vendor uses ` +
        `${[...priorCurrencies].sort().join(", ")}. Human verification is required before a money action.`,
    });
  }
  state.refMatch =
    !!inv.vendor_ref &&
    vendorPriors.some(
      (p) => !!p.vendorRef && canonicalReference(p.vendorRef) === canonicalReference(inv.vendor_ref)
    );
  state.amountDateMatch = vendorPriors.some(
    (p) =>
      inv.total != null &&
      p.total != null &&
      Math.abs(p.total - inv.total) <= 0.01 &&
      isSupportedCurrency(inv.currency) &&
      p.currency === inv.currency &&
      !!inv.invoice_date &&
      !!p.date &&
      p.date === inv.invoice_date
  );
  // Amount baselines are meaningful only within the exact same currency. Mixing
  // EUR and USD history can fabricate or hide an anomaly even when the numbers
  // happen to look comparable.
  const amounts = vendorPriors
    .filter((p) => isSupportedCurrency(inv.currency) && p.currency === inv.currency)
    .map((p) => p.total)
    .filter((a): a is number => a != null);
  if (amounts.length > 0 && inv.total != null) {
    const baseline = robustAmountBaseline(amounts);
    state.amountRatio = baseline != null && baseline > 0 ? round2(inv.total / baseline) : null;
  }

  // THE APPROVAL GATE AS A RUNTIME CORRECTION SIGNAL — read back PRIOR HUMAN CORRECTIONS
  // for this vendor from the recalled memories (written by amend()/reject()). A
  // human amending a proposal's amount DOWN or rejecting one is durable feedback the
  // next decision reasons over. Recall is already vendor-scoped, so these hits are
  // this vendor's; we lift the structured `correction` metadata back out.
  deriveCorrections(state, deterministicCorrections);

  state.didRecall = true;
  return recallSummary(state);
}

// Lift prior human-correction FACTS out of the vendor's recalled memories. Sets the
// rejection flag, the most-recent human-corrected-down amount, and whether THIS
// invoice re-bills materially above it — the signal the loop escalates on.
function deriveCorrections(state: LoopState, hits: MemoryRecord[]): void {
  const corrections = hits.filter(
    (h) => h.metadata && typeof h.metadata === "object" && typeof (h.metadata as Record<string, unknown>)["correction"] === "string"
  );
  state.priorRejection = corrections.some((h) => (h.metadata as Record<string, unknown>)["correction"] === "rejected");

  const amendedDowns = corrections
    .filter(
      (h) =>
        (h.metadata as Record<string, unknown>)["correction"] === "amended_down" &&
        typeof (h.metadata as Record<string, unknown>)["corrected_amount"] === "number" &&
        (h.metadata as Record<string, unknown>)["corrected_currency"] === state.invoice.currency
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")); // most recent first
  if (amendedDowns.length > 0) {
    state.correctedAmount = (amendedDowns[0]!.metadata as Record<string, unknown>)["corrected_amount"] as number;
  }

  state.priorCorrection = state.priorRejection || state.correctedAmount != null;
  const inv = state.invoice;
  state.rebillsCorrected =
    state.correctedAmount != null && inv.total != null && inv.total > state.correctedAmount * CORRECTION_REBILL_MARGIN;
}

function recallSummary(state: LoopState): string {
  const inv = state.invoice;
  if (!inv.vendor) return "No vendor name on the invoice — no history could be recalled.";
  if (state.priorCount === 0) {
    const cold = `No prior invoices recalled for ${inv.vendor} — this vendor is new (first time seen).`;
    const note = correctionNote(state);
    return note ? `${cold} ${note}` : cold;
  }
  const parts = [
    `Recalled ${state.priorCount} prior invoice(s) for ${inv.vendor}.`,
    state.refMatch ? `A prior invoice shares this vendor reference (${inv.vendor_ref}).` : null,
    state.amountDateMatch ? `A prior invoice shares this amount and date.` : null,
    state.amountRatio != null ? `This total is ${state.amountRatio}x the vendor's robust historical median.` : null,
    state.currencyChanged ? `The invoice currency differs from this vendor's completed history and requires review.` : null,
    correctionNote(state),
  ].filter(Boolean);
  return parts.join(" ");
}

// Surface prior HUMAN CORRECTIONS in the natural-language recall observation (what
// the real qwen-plus reads), so a reviewer — and the model — see that the approval
// gate's feedback is being taken into account on this decision.
function correctionNote(state: LoopState): string | null {
  const notes: string[] = [];
  if (state.correctedAmount != null) {
    notes.push(
      `A human previously corrected this vendor's amount DOWN to ${state.correctedAmount}` +
        (state.rebillsCorrected ? `, and this invoice re-bills materially ABOVE that corrected amount` : ``) +
        `.`
    );
  }
  if (state.priorRejection) notes.push(`A prior proposal for this vendor was REJECTED by a human.`);
  return notes.length ? notes.join(" ") : null;
}

function runValidate(state: LoopState): string {
  if (state.didValidate) return validateSummary(state);
  const fs = validateInvoice(state.invoice); // [R1, R2, R3, R4]
  state.findings.push(...fs);
  const failed = (rule: string) => fs.some((f) => f.rule === rule && !f.passed);
  state.noTotal = failed("R1");
  state.missingFields = failed("R2");
  state.reconcileIssue = failed("R3") || failed("R4");
  state.didValidate = true;
  return validateSummary(state);
}

function validateSummary(state: LoopState): string {
  const fs = state.findings.filter((f) => ["R1", "R2", "R3", "R4"].includes(f.rule));
  const fails = fs.filter((f) => !f.passed);
  if (fails.length === 0) return "Structural validation R1–R4 all pass; the invoice is well-formed.";
  return `Structural validation: ${fails.map((f) => `${f.rule} FAIL — ${f.message}`).join("  ")}`;
}

function runCheckDuplicate(state: LoopState): string {
  if (!state.didRecall) {
    return "Cannot check for a duplicate yet — call recall_vendor_history first to load the vendor's prior invoices.";
  }
  if (state.didCheckDuplicate) {
    const prior = state.findings.find((f) => f.rule === "R5");
    return prior ? prior.message : "Duplicate check already performed.";
  }
  const f = detectDuplicate(state.invoice, state.priors); // R5
  state.findings.push(f);
  state.duplicate = !f.passed;
  state.didCheckDuplicate = true;
  return f.message;
}

function runComputeVariance(state: LoopState): string {
  if (!state.didRecall) {
    return "Cannot compute the amount variance yet — call recall_vendor_history first to load the vendor's amount history.";
  }
  if (state.didComputeVariance) {
    const prior = state.findings.find((f) => f.rule === "R6");
    return prior ? prior.message : "Variance already computed.";
  }
  const f = detectAmountAnomaly(state.invoice, state.priors); // R6
  state.findings.push(f);
  state.anomaly = !f.passed;
  state.didComputeVariance = true;
  const ratio = state.amountRatio != null ? ` (measured ${state.amountRatio}x the vendor median)` : "";
  return `${f.message}${ratio}`;
}

function runRequestContext(args: Record<string, unknown>): string {
  const q = typeof args["question"] === "string" ? (args["question"] as string) : "";
  return (
    `Noted a request for more context${q ? `: "${q}"` : ""}. No additional-context channel is wired in ` +
    `this vertical slice — proceed with the available evidence, or choose flag_for_review / draft_vendor_reply ` +
    `if the evidence is insufficient to act safely.`
  );
}

// A compact, machine-readable snapshot of the evidence gathered so far. The loop
// embeds it in the step prompt; the real model reads the whole natural-language
// trace, while the deterministic offline FakeQwenChatClient branches on THIS line
// (exactly as the old single-shot path branched on its SIGNALS line). `dup_candidate`
// / `anomaly_candidate` are FACT-derived routing hints (a prior shares the ref, or
// the ratio is high) — the actual duplicate/anomaly VERDICTS appear only after
// check_duplicate / compute_variance run.
export function computeEvidence(state: LoopState): string {
  const dupCandidate = state.refMatch || state.amountDateMatch;
  const anomalyCandidate = state.amountRatio != null && state.amountRatio > 3;
  const b = (v: boolean) => (v ? "true" : "false");
  return (
    `EVIDENCE: recalled=${b(state.didRecall)} validated=${b(state.didValidate)} ` +
    `dup_checked=${b(state.didCheckDuplicate)} variance_computed=${b(state.didComputeVariance)} ` +
    `known_vendor=${b(state.knownVendor)} dup_candidate=${b(dupCandidate)} anomaly_candidate=${b(anomalyCandidate)} ` +
    `duplicate=${b(state.duplicate)} missing_fields=${b(state.missingFields)} ` +
    `reconcile_issue=${b(state.reconcileIssue)} anomaly=${b(state.anomaly)} currency_changed=${b(state.currencyChanged)} no_total=${b(state.noTotal)} ` +
    `prior_correction=${b(state.priorCorrection)} rebills_corrected=${b(state.rebillsCorrected)}`
  );
}

// The OpenAI-compatible function schemas for the autonomous tools, handed to Qwen
// alongside the terminal-action defs so the model can pick a read/analyze step OR a
// terminal action each turn. Each carries a `reasoning` field the model self-reports.
export function analysisToolDefs(): ToolDef[] {
  const reasoning = {
    type: "string",
    description: "One sentence on WHY this read/analyze step is the right next move given what you know so far.",
  } as const;
  const def = (name: AnalysisToolName, description: string, extra: Record<string, unknown> = {}, required: string[] = []): ToolDef => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { ...extra, reasoning },
        required: [...required, "reasoning"],
      },
    },
  });
  return [
    def(
      "recall_vendor_history",
      "READ (no side-effect): look this vendor up in persistent memory and surface their prior invoices — how many, their references, amounts and dates, and how this invoice's amount compares. Call this FIRST; the duplicate and variance checks depend on it."
    ),
    def(
      "validate_invoice",
      "ANALYZE (no side-effect): run the structural cross-checks R1–R4 — amount sanity, required fields (vendor / reference / tax_id), tax reconciliation, and line-item integrity."
    ),
    def(
      "check_duplicate",
      "ANALYZE (no side-effect): decide rule R5 — is this invoice a duplicate of one already processed (same vendor + reference, or same vendor + amount + date)? Requires recall_vendor_history first."
    ),
    def(
      "compute_variance_vs_history",
      "ANALYZE (no side-effect): decide rule R6 — is this amount anomalous versus the vendor's robust historical median? Requires recall_vendor_history first."
    ),
    def(
      "request_more_context",
      "READ (no side-effect): record that more information is needed before a safe decision can be made.",
      { question: { type: "string", description: "What additional information you would need." } }
    ),
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
