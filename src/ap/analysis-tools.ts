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
import type { MemoryStore } from "../memory/store.js";
import { recall } from "../memory/memory.js";
import {
  detectAmountAnomaly,
  detectDuplicate,
  priorInvoicesFromRecall,
  toRecalledFact,
  validateInvoice,
  type PriorInvoice,
} from "./validate.js";
import type {
  NormalizedInvoice,
  RecalledFact,
  ValidationFinding,
} from "../types.js";

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
  amountRatio: number | null; // this total ÷ the vendor's historical average

  // CONFIRMED findings — set ONLY once the owning analysis tool actually runs
  duplicate: boolean; // R5 confirmed by check_duplicate
  missingFields: boolean; // R2 confirmed by validate_invoice
  reconcileIssue: boolean; // R3/R4 confirmed by validate_invoice
  anomaly: boolean; // R6 confirmed by compute_variance_vs_history
  noTotal: boolean; // R1 confirmed by validate_invoice
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
    duplicate: false,
    missingFields: false,
    reconcileIssue: false,
    anomaly: false,
    noTotal: false,
  };
}

export interface AnalysisDeps {
  embedder: Embedder;
  memory: MemoryStore;
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

async function runRecall(state: LoopState, { embedder, memory }: AnalysisDeps): Promise<string> {
  const inv = state.invoice;
  if (state.didRecall) return recallSummary(state); // idempotent — never re-query
  const query =
    `${inv.vendor ?? "vendor"} invoice ${inv.vendor_ref ?? ""} ` +
    `${inv.total ?? ""} ${inv.currency}`.trim();
  const hits = inv.vendor
    ? await recall(embedder, memory, query, { vendor: inv.vendor, limit: 8 })
    : [];
  state.recalled = hits.map(toRecalledFact);
  state.priors = priorInvoicesFromRecall(hits);

  // Derive raw FACTS from the recalled priors — NOT decisions. The R5/R6 verdicts
  // are produced later by check_duplicate / compute_variance, so this stays honest.
  const vendorPriors = state.priors.filter(
    (p) => !!inv.vendor && norm(p.vendor) === norm(inv.vendor) && p.invoiceId !== inv.invoice_id
  );
  state.priorCount = vendorPriors.length;
  state.knownVendor = vendorPriors.length > 0;
  state.refMatch =
    !!inv.vendor_ref && vendorPriors.some((p) => !!p.vendorRef && norm(p.vendorRef) === norm(inv.vendor_ref));
  state.amountDateMatch = vendorPriors.some(
    (p) =>
      inv.total != null &&
      p.total != null &&
      Math.abs(p.total - inv.total) <= 0.01 &&
      !!inv.invoice_date &&
      !!p.date &&
      p.date === inv.invoice_date
  );
  const amounts = vendorPriors.map((p) => p.total).filter((a): a is number => a != null);
  if (amounts.length > 0 && inv.total != null) {
    const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    state.amountRatio = avg > 0 ? round2(inv.total / avg) : null;
  }
  state.didRecall = true;
  return recallSummary(state);
}

function recallSummary(state: LoopState): string {
  const inv = state.invoice;
  if (!inv.vendor) return "No vendor name on the invoice — no history could be recalled.";
  if (state.priorCount === 0) {
    return `No prior invoices recalled for ${inv.vendor} — this vendor is new (first time seen).`;
  }
  const parts = [
    `Recalled ${state.priorCount} prior invoice(s) for ${inv.vendor}.`,
    state.refMatch ? `A prior invoice shares this vendor reference (${inv.vendor_ref}).` : null,
    state.amountDateMatch ? `A prior invoice shares this amount and date.` : null,
    state.amountRatio != null ? `This total is ${state.amountRatio}x the vendor's historical average.` : null,
  ].filter(Boolean);
  return parts.join(" ");
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
  const ratio = state.amountRatio != null ? ` (measured ${state.amountRatio}x the vendor average)` : "";
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
    `reconcile_issue=${b(state.reconcileIssue)} anomaly=${b(state.anomaly)} no_total=${b(state.noTotal)}`
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
      "ANALYZE (no side-effect): decide rule R6 — is this amount anomalous versus the vendor's historical average? Requires recall_vendor_history first."
    ),
    def(
      "request_more_context",
      "READ (no side-effect): record that more information is needed before a safe decision can be made.",
      { question: { type: "string", description: "What additional information you would need." } }
    ),
  ];
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
