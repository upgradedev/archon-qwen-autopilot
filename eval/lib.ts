// Eval library — the runnable core of both eval harnesses, with NO top-level side
// effect, so it can be imported (by the CLI wrappers eval/run.ts + eval/corrections.ts
// AND by scripts/readiness.ts) without executing anything. The CLI wrappers own all
// printing + gating; this module owns only the measurement.
//
// Two measurements, one seam (the model): with no DASHSCOPE_API_KEY both fall back to
// the deterministic FakeQwenChatClient + FakeEmbedder, so the numbers are a hermetic
// policy/regression signal; with a key they become live qwen-plus decision quality.

import { AutopilotAgent } from "../src/agents/autopilot-agent.js";
import { defaultLoop } from "../src/ap/loop.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { InMemoryStore } from "../src/memory/store.js";
import { InMemoryWorkItemStore } from "../src/ap/workitem-store.js";
import { fakeSinks } from "../src/ap/sinks.js";
import { toolByName } from "../src/ap/tools.js";
import { EVAL_SET, type EvalScenario } from "./dataset.js";
import type { RawInvoice, WorkItem } from "../src/types.js";

// ── Decision-quality eval ───────────────────────────────────────────────────────

export interface EvalRow {
  scenario: EvalScenario;
  proposed: string;
  correct: boolean;
  argSane: boolean;
  argNote: string;
  steps: number; // autonomous read/analyze steps before the terminal action
}

export interface EvalSummary {
  rows: EvalRow[];
  n: number;
  correct: number;
  argSane: number;
  acc: number; // correct / n
  avgSteps: number;
  minSteps: number;
  multiStep: number; // scenarios that took ≥2 autonomous steps
}

// Run ONE scenario end to end through a fresh, hermetic agent. Seeds are intaken first
// (writing their invoices into this agent's memory) so the scenario invoice is judged
// with the vendor history a real cross-session agent would recall.
export async function runScenario(s: EvalScenario): Promise<EvalRow> {
  const agent = new AutopilotAgent(
    defaultEmbedder(),
    new InMemoryStore(),
    new InMemoryWorkItemStore(),
    defaultLoop(),
    fakeSinks()
  );

  for (const seed of s.seed ?? []) await agent.intake(seed as RawInvoice);
  const item = await agent.intake(s.invoice as RawInvoice);

  const proposed = item.proposed.tool;
  const correct = proposed === s.expected;
  const { argSane, argNote } = await checkArgSanity(item);
  const steps = item.trace.length;
  return { scenario: s, proposed, correct, argSane, argNote, steps };
}

// Arg-sanity (reported, NOT gated): would the proposed action actually execute? Run the
// chosen tool's execute() against throwaway fake sinks and require a truthy, non-empty
// result — catching an action whose args cannot be carried out, without penalising the
// model for omitting an arg execute() back-fills.
export async function checkArgSanity(item: WorkItem): Promise<{ argSane: boolean; argNote: string }> {
  const spec = toolByName(item.proposed.tool);
  if (!spec) return { argSane: false, argNote: "unknown tool" };
  try {
    const res = await spec.execute(item.proposed.args, item.invoice, fakeSinks());
    if (res.ok && res.summary.trim().length > 0) return { argSane: true, argNote: res.summary };
    return { argSane: false, argNote: "execute returned not-ok / empty summary" };
  } catch (err) {
    return { argSane: false, argNote: `execute threw: ${(err as Error).message}` };
  }
}

export async function runEval(): Promise<EvalSummary> {
  const rows: EvalRow[] = [];
  for (const s of EVAL_SET) rows.push(await runScenario(s));

  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const argSane = rows.filter((r) => r.argSane).length;
  const stepsArr = rows.map((r) => r.steps);
  const avgSteps = stepsArr.reduce((s, x) => s + x, 0) / n;
  const minSteps = Math.min(...stepsArr);
  const multiStep = rows.filter((r) => r.steps >= 2).length;

  return { rows, n, correct, argSane, acc: correct / n, avgSteps, minSteps, multiStep };
}

// ── Learning-from-corrections eval (the approval gate as a training signal) ───────

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

const V = "Globex Corp";
export const CORRECTION_SCENARIOS: CorrectionScenario[] = [
  {
    id: "c1",
    label: "vendor over-bills 5000, human amends DOWN to 3000; next invoice RE-BILLS 5000",
    establish: [{ vendor: V, invoice_number: "GX-1", date: "2026-01-05", subtotal: 2500, tax: 500, total: 3000, tax_id: "TX-100", currency: "EUR" }],
    corrected: { vendor: V, invoice_number: "GX-2", date: "2026-02-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" },
    correction: { kind: "amend_down", amount: 3000, reason: "agreed/contracted amount for this vendor is 3000" },
    decision: { vendor: V, invoice_number: "GX-3", date: "2026-03-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" },
    expectChange: true,
  },
  {
    id: "c2",
    label: "same correction, but the next invoice BILLS the corrected 3000 (negative control — no crying wolf)",
    establish: [{ vendor: V, invoice_number: "GX-1", date: "2026-01-05", subtotal: 2500, tax: 500, total: 3000, tax_id: "TX-100", currency: "EUR" }],
    corrected: { vendor: V, invoice_number: "GX-2", date: "2026-02-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" },
    correction: { kind: "amend_down", amount: 3000, reason: "agreed amount is 3000" },
    decision: { vendor: V, invoice_number: "GX-4", date: "2026-03-05", subtotal: 3000, tax: 0, total: 3000, tax_id: "TX-100", currency: "EUR" },
    expectChange: false,
  },
];

function newCorrectionAgent(): AutopilotAgent {
  return new AutopilotAgent(defaultEmbedder(), new InMemoryStore(), new InMemoryWorkItemStore(), defaultLoop(), fakeSinks());
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
