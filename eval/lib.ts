// Eval library — the runnable core of both eval harnesses, with NO top-level side
// effect, so it can be imported (by the CLI wrappers eval/run.ts + eval/corrections.ts
// AND by scripts/readiness.ts) without executing anything. The CLI wrappers own all
// printing + gating; this module owns only the measurement.
//
// Two measurements, one seam (the model): with no DASHSCOPE_API_KEY both fall back to
// the deterministic FakeQwenChatClient + FakeEmbedder, so the numbers are a hermetic
// policy/regression signal; with a key they become live qwen-plus decision quality.

import { AutopilotAgent } from "../src/agents/autopilot-agent.js";
import { AutopilotLoop, DEFAULT_DECIDER_MODEL, defaultLoop } from "../src/ap/loop.js";
import { EMBED_DIM, DEFAULT_EMBED_MODEL, FakeEmbedder, type Embedder } from "../src/memory/embeddings.js";
import { InMemoryStore } from "../src/memory/store.js";
import { InMemoryWorkItemStore } from "../src/ap/workitem-store.js";
import { fakeSinks } from "../src/ap/sinks.js";
import { assertValidToolArgs, toolByName } from "../src/ap/tools.js";
import { FakeQwenChatClient } from "../src/ap/fake-chat.js";
import { chatClient, createQwenClient, type QwenEmbeddingsClient } from "../src/qwen/client.js";
import { EVAL_SET, type EvalScenario } from "./dataset.js";
import type { RawInvoice, WorkItem } from "../src/types.js";
import { categoricalEvalError } from "./artifact-safety.js";

// ── Decision-quality eval ───────────────────────────────────────────────────────

export interface EvalRow {
  scenario: EvalScenario;
  proposed: string;
  correct: boolean;
  argSane: boolean;
  argNote: string;
  rawArgsExecutable: boolean;
  reviewerEnrichmentRequired: string[];
  reviewerEnrichedExecutionVerified: boolean;
  steps: number; // autonomous read/analyze steps before the terminal action
  latencyMs: number; // wall-clock intake→persisted proposal for this hermetic case
  stopReason: WorkItem["stopReason"];
  modelId: string;
  duplicateCaught: boolean;
  anomalyCaught: boolean;
  rawModelProposed: string | null;
  modelCorrect: boolean;
  conclusive: boolean;
  policyOverride: boolean;
  policyOverrideSource: string | null;
  policyOverrideReason: string | null;
  fallback: boolean;
  modelCalls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  embeddingCalls: number;
  embeddingTokens: number | null;
  traceTools: string[];
  setupDecisionModelCalls: number;
  finalDecisionModelCalls: number;
  setupPromptTokens: number | null;
  setupCompletionTokens: number | null;
}

export interface EvalSummary {
  rows: EvalRow[];
  n: number;
  correct: number;
  argSane: number;
  rawArgsExecutable: number;
  reviewerEnrichedExecutionVerified: number;
  acc: number; // correct / n
  avgSteps: number;
  minSteps: number;
  multiStep: number; // scenarios that took ≥2 autonomous steps
  latencyMs: { mean: number; p50: number; p95: number; min: number; max: number };
}

export type EvalMode = "offline" | "online";

class MeteredEvalEmbedder implements Embedder {
  readonly dim = EMBED_DIM;
  readonly modelId: string;
  calls = 0;
  tokens = 0;
  sawUsage = false;
  private fake?: FakeEmbedder;
  private client?: QwenEmbeddingsClient;

  constructor(private mode: EvalMode, embeddingModelId = DEFAULT_EMBED_MODEL) {
    this.modelId = mode === "online" ? embeddingModelId : "fake-hash-embedder";
    if (mode === "online") this.client = createQwenClient() as unknown as QwenEmbeddingsClient;
    else this.fake = new FakeEmbedder();
  }

  async embed(input: string): Promise<number[]> {
    this.calls++;
    if (this.fake) return this.fake.embed(input);
    const res = await this.client!.embeddings.create({ model: this.modelId, input, dimensions: this.dim });
    const vector = res.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== this.dim) throw new Error(`embedding returned ${vector?.length ?? 0} dims, expected ${this.dim}`);
    if (res.usage) {
      this.sawUsage = true;
      this.tokens += Number(res.usage.total_tokens ?? res.usage.prompt_tokens ?? 0);
    }
    return vector;
  }
}

// Run ONE scenario end to end through a fresh, hermetic agent. Seeds are intaken AND
// approved first, because only completed work is valid R5/R6 history; pending or
// rejected uploads must never poison the vendor baseline.
export interface EvalModelConfig {
  decisionModelId?: string;
  embeddingModelId?: string;
}

export async function runScenario(
  s: EvalScenario,
  mode: EvalMode = "offline",
  models: EvalModelConfig = {}
): Promise<EvalRow> {
  const started = performance.now();
  const embedder = new MeteredEvalEmbedder(mode, models.embeddingModelId);
  let setupDecisionModelCalls = 0;
  let setupPromptTokens: number | null = 0;
  let setupCompletionTokens: number | null = 0;
  const agent = new AutopilotAgent(
    embedder,
    new InMemoryStore(),
    new InMemoryWorkItemStore(),
    new AutopilotLoop(
      mode === "online" ? chatClient() : new FakeQwenChatClient(),
      models.decisionModelId ?? DEFAULT_DECIDER_MODEL
    ),
    fakeSinks()
  );

  for (const seed of s.seed ?? []) {
    const seeded = await agent.intake(seed as RawInvoice);
    setupDecisionModelCalls += seeded.telemetry?.modelCalls ?? 0;
    setupPromptTokens = addNullable(setupPromptTokens, seeded.telemetry?.promptTokens ?? null);
    setupCompletionTokens = addNullable(setupCompletionTokens, seeded.telemetry?.completionTokens ?? null);
    await agent.approve(seeded.id);
  }
  const item = await agent.intake(s.invoice as RawInvoice);

  const proposed = item.proposed.tool;
  const correct = proposed === s.expected;
  const {
    argSane,
    argNote,
    rawArgsExecutable,
    reviewerEnrichmentRequired,
    reviewerEnrichedExecutionVerified,
  } = await checkArgSanity(item);
  const steps = item.telemetry?.readAnalyzeSteps ?? item.trace.length;
  const failed = (rule: string) => item.findings.some((f) => f.rule === rule && !f.passed);
  return {
    scenario: s,
    proposed,
    correct,
    argSane,
    argNote,
    rawArgsExecutable,
    reviewerEnrichmentRequired,
    reviewerEnrichedExecutionVerified,
    steps,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    stopReason: item.stopReason,
    modelId: item.proposed.modelId,
    duplicateCaught: failed("R5"),
    anomalyCaught: failed("R6"),
    rawModelProposed: item.telemetry?.rawModelTerminalTool ?? null,
    modelCorrect: item.telemetry?.rawModelTerminalTool === s.expected && !item.telemetry?.fallback,
    conclusive: Boolean(item.telemetry?.rawModelTerminalTool) && !item.telemetry?.fallback,
    policyOverride: item.telemetry?.policyOverride ?? false,
    policyOverrideSource: item.telemetry?.policyOverrideSource ?? null,
    policyOverrideReason: item.telemetry?.policyOverrideReason ?? null,
    fallback: item.telemetry?.fallback ?? item.stopReason !== "terminal_action",
    modelCalls: setupDecisionModelCalls + (item.telemetry?.modelCalls ?? 0),
    promptTokens: addNullable(setupPromptTokens, item.telemetry?.promptTokens ?? null),
    completionTokens: addNullable(setupCompletionTokens, item.telemetry?.completionTokens ?? null),
    totalTokens: addNullable(addNullable(setupPromptTokens, item.telemetry?.promptTokens ?? null), addNullable(setupCompletionTokens, item.telemetry?.completionTokens ?? null)),
    embeddingCalls: embedder.calls,
    embeddingTokens: embedder.sawUsage ? embedder.tokens : null,
    traceTools: item.trace.map((step) => step.tool),
    setupDecisionModelCalls,
    finalDecisionModelCalls: item.telemetry?.modelCalls ?? 0,
    setupPromptTokens,
    setupCompletionTokens,
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  return left == null || right == null ? null : left + right;
}

// Arg-sanity: use the same runtime validator as the human gate, then run the chosen
// tool against throwaway fake sinks and require a truthy, non-empty result. This does
// not bless sink fallback values that the real gate would reject.
export async function checkArgSanity(item: WorkItem): Promise<{
  argSane: boolean;
  argNote: string;
  rawArgsExecutable: boolean;
  reviewerEnrichmentRequired: string[];
  reviewerEnrichedExecutionVerified: boolean;
}> {
  const spec = toolByName(item.proposed.tool);
  const required = [...(item.proposed.requiresReviewerInput ?? [])];
  if (!spec) return {
    argSane: false,
    argNote: "unknown tool",
    rawArgsExecutable: false,
    reviewerEnrichmentRequired: required,
    reviewerEnrichedExecutionVerified: false,
  };
  if (item.proposed.tool === "draft_vendor_reply") {
    if (Object.prototype.hasOwnProperty.call(item.proposed.args, "to") || !required.includes("to")) {
      return {
        argSane: false,
        argNote: "vendor reply proposal must omit model-selected `to` and declare reviewer enrichment",
        rawArgsExecutable: false,
        reviewerEnrichmentRequired: required,
        reviewerEnrichedExecutionVerified: false,
      };
    }
    try {
      const enriched = { ...item.proposed.args, to: "reviewer-verified-recipient@example.test" };
      assertValidToolArgs(item.proposed.tool, enriched, item.invoice);
      const res = await spec.execute(enriched, item.invoice, fakeSinks());
      const verified = res.ok && res.summary.trim().length > 0;
      return {
        argSane: verified,
        argNote: verified
          ? "policy-safe draft omits recipient; execution verified after explicit reviewer recipient enrichment"
          : "reviewer-enriched execution returned not-ok / empty summary",
        rawArgsExecutable: false,
        reviewerEnrichmentRequired: required,
        reviewerEnrichedExecutionVerified: verified,
      };
    } catch (err) {
      return {
        argSane: false,
        argNote: `reviewer-enriched execution failed (${categoricalEvalError(err).category})`,
        rawArgsExecutable: false,
        reviewerEnrichmentRequired: required,
        reviewerEnrichedExecutionVerified: false,
      };
    }
  }
  if (required.length > 0) {
    return {
      argSane: false,
      argNote: `unexpected reviewer enrichment requirement: ${required.join(", ")}`,
      rawArgsExecutable: false,
      reviewerEnrichmentRequired: required,
      reviewerEnrichedExecutionVerified: false,
    };
  }
  try {
    assertValidToolArgs(item.proposed.tool, item.proposed.args, item.invoice);
    const res = await spec.execute(item.proposed.args, item.invoice, fakeSinks());
    if (res.ok && res.summary.trim().length > 0) return {
      argSane: true,
      argNote: res.summary,
      rawArgsExecutable: true,
      reviewerEnrichmentRequired: [],
      reviewerEnrichedExecutionVerified: true,
    };
    return {
      argSane: false,
      argNote: "execute returned not-ok / empty summary",
      rawArgsExecutable: false,
      reviewerEnrichmentRequired: [],
      reviewerEnrichedExecutionVerified: false,
    };
  } catch (err) {
    return {
      argSane: false,
      argNote: `execution failed (${categoricalEvalError(err).category})`,
      rawArgsExecutable: false,
      reviewerEnrichmentRequired: [],
      reviewerEnrichedExecutionVerified: false,
    };
  }
}

export async function runEval(mode: EvalMode = "offline"): Promise<EvalSummary> {
  const rows: EvalRow[] = [];
  for (const s of EVAL_SET) rows.push(await runScenario(s, mode));

  return summarizeRows(rows);
}

export function summarizeRows(rows: EvalRow[]): EvalSummary {

  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const argSane = rows.filter((r) => r.argSane).length;
  const rawArgsExecutable = rows.filter((r) => r.rawArgsExecutable).length;
  const reviewerEnrichedExecutionVerified = rows.filter((r) => r.reviewerEnrichedExecutionVerified).length;
  const stepsArr = rows.map((r) => r.steps);
  const avgSteps = stepsArr.reduce((s, x) => s + x, 0) / Math.max(1, n);
  const minSteps = n ? Math.min(...stepsArr) : 0;
  const multiStep = rows.filter((r) => r.steps >= 2).length;

  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] ?? 0;
  return {
    rows,
    n,
    correct,
    argSane,
    rawArgsExecutable,
    reviewerEnrichedExecutionVerified,
    acc: n ? correct / n : 0,
    avgSteps,
    minSteps,
    multiStep,
    latencyMs: {
      mean: latencies.reduce((sum, n) => sum + n, 0) / Math.max(1, latencies.length),
      p50: percentile(0.5),
      p95: percentile(0.95),
      min: latencies[0] ?? 0,
      max: latencies.at(-1) ?? 0,
    },
  };
}

// ── Runtime-correction eval (behavioral signal; no model-weight training) ─────────

interface Correction {
  kind: "amend_down";
  amount: number;
  reason: string;
}
export interface CorrectionScenario {
  id: string;
  label: string;
  establish: RawInvoice[];
  corrected: RawInvoice;
  correction: Correction | { kind: "reject"; reason: string };
  decision: RawInvoice;
  expectChange: boolean;
}

const V = "Juniper Supply Group";
export const CORRECTION_SCENARIOS: CorrectionScenario[] = [
  {
    id: "c1",
    label: "vendor over-bills 5000, human amends DOWN to 3000; next invoice RE-BILLS 5000",
    establish: [{ vendor: V, invoice_number: "JS-1", date: "2026-01-05", subtotal: 2500, tax: 500, total: 3000, tax_id: "TX-100", currency: "EUR" }],
    corrected: { vendor: V, invoice_number: "JS-2", date: "2026-02-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" },
    correction: { kind: "amend_down", amount: 3000, reason: "agreed/contracted amount for this vendor is 3000" },
    decision: { vendor: V, invoice_number: "JS-3", date: "2026-03-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" },
    expectChange: true,
  },
  {
    id: "c2",
    label: "same correction, but the next invoice BILLS the corrected 3000 (negative control — no crying wolf)",
    establish: [{ vendor: V, invoice_number: "JS-1", date: "2026-01-05", subtotal: 2500, tax: 500, total: 3000, tax_id: "TX-100", currency: "EUR" }],
    corrected: { vendor: V, invoice_number: "JS-2", date: "2026-02-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" },
    correction: { kind: "amend_down", amount: 3000, reason: "agreed amount is 3000" },
    decision: { vendor: V, invoice_number: "JS-4", date: "2026-03-05", subtotal: 3000, tax: 0, total: 3000, tax_id: "TX-100", currency: "EUR" },
    expectChange: false,
  },
];

function newCorrectionAgent(): AutopilotAgent {
  return new AutopilotAgent(
    new FakeEmbedder(),
    new InMemoryStore(),
    new InMemoryWorkItemStore(),
    defaultLoop(new FakeQwenChatClient()),
    fakeSinks()
  );
}

// Run the decision invoice with the correction either APPLIED or SKIPPED.
export async function decide(s: CorrectionScenario, applyCorrection: boolean): Promise<string> {
  const agent = newCorrectionAgent();
  for (const e of s.establish) {
    const item = await agent.intake(e);
    await agent.approve(item.id);
  }
  const corr = await agent.intake(s.corrected);
  if (applyCorrection) {
    if (s.correction.kind === "amend_down") {
      await agent.amend(corr.id, { args: { amount: s.correction.amount }, reason: s.correction.reason });
    } else {
      await agent.reject(corr.id, s.correction.reason);
    }
  } else {
    await agent.approve(corr.id);
  }
  const decided = await agent.intake(s.decision);
  return decided.proposed.tool;
}

export interface CorrectionRow {
  scenario: CorrectionScenario;
  before: string;
  after: string;
  changed: boolean;
  asPredicted: boolean;
}

export interface CorrectionsSummary {
  rows: CorrectionRow[];
  total: number;
  changed: number; // proposals the correction signal changed
  asPredicted: number; // rows that matched the reviewer's prediction
}

export async function runCorrections(): Promise<CorrectionsSummary> {
  const rows: CorrectionRow[] = [];
  for (const s of CORRECTION_SCENARIOS) {
    const before = await decide(s, false);
    const after = await decide(s, true);
    const changed = before !== after;
    const asPredicted = changed === s.expectChange;
    rows.push({ scenario: s, before, after, changed, asPredicted });
  }
  return {
    rows,
    total: rows.length,
    changed: rows.filter((r) => r.changed).length,
    asPredicted: rows.filter((r) => r.asPredicted).length,
  };
}
