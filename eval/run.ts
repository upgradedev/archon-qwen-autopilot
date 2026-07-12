// Decision-quality eval runner — the measured number on the autopilot's own output.
//
//   npm run eval           # drive every scenario, print the table + accuracy N/M
//   npm run eval -- --gate # also FAIL if tool-choice accuracy is below the floor (CI)
//
// For each labelled scenario (eval/dataset.ts) this drives the REAL decider path
// end to end: it builds a fresh AutopilotAgent (hermetic in-memory stores + fake
// sinks), intakes any `seed` invoices so the vendor's history lands in persistent
// memory, then intakes the invoice under decision and reads back the tool the
// decider PROPOSED. It compares that proposed tool to the business-correct
// `expected` label and reports tool-choice accuracy as N/M + %.
//
// OFFLINE vs ONLINE — the same runner, only the model seam changes:
//   • No DASHSCOPE_API_KEY  → FakeQwenChatClient + FakeEmbedder (deterministic).
//     The number is a POLICY / REGRESSION guard over the real intake pipeline
//     (normalization + R1..R6 validation + memory-grounded duplicate/anomaly
//     detection). This is what CI gates.
//   • DASHSCOPE_API_KEY set → real qwen-plus function-calling + text-embedding-v4.
//     The number is the actual DECISION-QUALITY of the model choosing freely
//     against the same labels. Capture it live (it costs a few cents).
// The header prints the live model ids so a run is self-labelling (fake vs qwen).
//
// We grade TOOL CHOICE (gated). We ALSO report arg-sanity — does the proposed
// action execute cleanly against the fake sinks — as an un-gated signal, because
// the model may legitimately omit an arg the execute() fallback fills from the
// invoice (see fake-chat.ts omitting `amount` for draft_payment on purpose).

import { AutopilotAgent } from "../src/agents/autopilot-agent.js";
import { defaultLoop } from "../src/ap/loop.js";
import { hasQwenCreds } from "../src/qwen/client.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { InMemoryStore } from "../src/memory/store.js";
import { InMemoryWorkItemStore } from "../src/ap/workitem-store.js";
import { fakeSinks } from "../src/ap/sinks.js";
import { toolByName } from "../src/ap/tools.js";
import { EVAL_SET, type EvalScenario } from "./dataset.js";
import type { RawInvoice, WorkItem } from "../src/types.js";

// Enforced FLOOR — set to the MEASURED offline result, not an aspiration. The
// offline path is deterministic, so this never flakes; it fails CI only on a real
// regression in the intake→signals→tool pipeline. It is deliberately at (not
// above) the measured number, honestly accounting for the one documented
// known-limitation scenario the deterministic policy misses (see EVAL.md).
const GATE_ACCURACY = 0.9;

interface Row {
  scenario: EvalScenario;
  proposed: string;
  correct: boolean;
  argSane: boolean;
  argNote: string;
  steps: number; // autonomous read/analyze steps the loop took before the terminal action
}

// Run ONE scenario end to end through a fresh, hermetic agent. Seeds are intaken
// first (writing their invoices into this agent's memory) so the scenario invoice
// is judged with the vendor history a real cross-session agent would recall.
async function runScenario(s: EvalScenario): Promise<Row> {
  const agent = new AutopilotAgent(
    defaultEmbedder(), // real text-embedding-v4 with a key; FakeEmbedder without
    new InMemoryStore(), // hermetic per scenario — no cross-scenario leakage, no DB
    new InMemoryWorkItemStore(),
    defaultLoop(), // real qwen-plus with a key; FakeQwenChatClient without
    fakeSinks()
  );

  for (const seed of s.seed ?? []) await agent.intake(seed as RawInvoice);
  const item = await agent.intake(s.invoice as RawInvoice);

  const proposed = item.proposed.tool;
  const correct = proposed === s.expected;
  const { argSane, argNote } = await checkArgSanity(item);
  // How many autonomous read/analyze steps the loop took before the terminal action.
  const steps = item.trace.length;
  return { scenario: s, proposed, correct, argSane, argNote, steps };
}

// Arg-sanity (reported, NOT gated): would the proposed action actually execute?
// We run the chosen tool's execute() against throwaway fake sinks and require a
// truthy, non-empty result. This catches an action whose args cannot be carried
// out, without penalising the model for omitting an arg execute() back-fills.
async function checkArgSanity(item: WorkItem): Promise<{ argSane: boolean; argNote: string }> {
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

async function main() {
  const gate = process.argv.slice(2).includes("--gate");

  const embedder = defaultEmbedder();
  const decider = defaultLoop();
  // Online iff a real DashScope key is configured. NOTE: decider.modelId is the
  // "qwen-plus" schema id in BOTH modes (the Fake sits at the qwen-plus tool-call
  // seam), so the key — not the model id — is the honest online/offline signal.
  const online = hasQwenCreds();
  const mode = online
    ? "ONLINE (real qwen-plus function-calling + text-embedding-v4)"
    : "OFFLINE (deterministic FakeQwenChatClient + FakeEmbedder)";

  console.log(`\nArchon Autopilot — decision-quality eval`);
  console.log(`Mode      : ${mode}`);
  console.log(`Decider   : ${decider.modelId}${online ? "" : "  (offline Fake at the qwen-plus tool-call seam)"}`);
  console.log(`Embedder  : ${embedder.modelId}`);
  console.log(`Scenarios : ${EVAL_SET.length}   ·   grading: proposed tool vs. business-correct label\n`);
  console.log(`ID    Category               Expected             Proposed             Tool  Args`);
  console.log("-".repeat(94));

  const rows: Row[] = [];
  for (const s of EVAL_SET) rows.push(await runScenario(s));

  for (const r of rows) {
    const mark = (b: boolean) => (b ? " ✓ " : " ✗ ");
    const known = r.scenario.knownLimitation && !r.correct ? "  (known limitation)" : "";
    console.log(
      `${r.scenario.id.padEnd(6)}${r.scenario.category.padEnd(22)} ${r.scenario.expected.padEnd(20)} ` +
        `${r.proposed.padEnd(20)}${mark(r.correct)}  ${mark(r.argSane)}${known}`
    );
  }

  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const argSane = rows.filter((r) => r.argSane).length;
  const acc = correct / n;

  // Multi-step depth: every scenario now runs the bounded ReAct loop, so it takes
  // ≥1 autonomous read/analyze step before any (human-gated) terminal action.
  const stepsArr = rows.map((r) => r.steps);
  const minSteps = Math.min(...stepsArr);
  const avgSteps = (stepsArr.reduce((s, x) => s + x, 0) / n).toFixed(1);
  const multiStep = rows.filter((r) => r.steps >= 2).length;

  console.log("-".repeat(94));
  console.log(`Tool-choice accuracy : ${correct}/${n}  (${(acc * 100).toFixed(1)}%)   ← the graded, gated number`);
  console.log(`Arg-sanity (executes): ${argSane}/${n}  (${((argSane / n) * 100).toFixed(1)}%)   (reported, not gated)`);
  console.log(`Loop autonomy        : ${multiStep}/${n} scenarios took ≥2 autonomous steps (avg ${avgSteps}, min ${minSteps}) before a terminal action`);

  // Per-category breakdown — where the decisions are strong / weak.
  const cats = [...new Set(EVAL_SET.map((s) => s.category))];
  console.log(`\nBy category:`);
  for (const c of cats) {
    const cr = rows.filter((r) => r.scenario.category === c);
    const ok = cr.filter((r) => r.correct).length;
    console.log(`  ${c.padEnd(22)} ${ok}/${cr.length}`);
  }

  const misses = rows.filter((r) => !r.correct);
  if (misses.length) {
    console.log(`\nMisses:`);
    for (const r of misses) {
      console.log(`  ${r.scenario.id} [${r.scenario.category}] expected ${r.scenario.expected}, proposed ${r.proposed}`);
      if (r.scenario.knownLimitation) console.log(`     known limitation: ${r.scenario.knownLimitation}`);
    }
  }

  if (gate) {
    console.log(`\nGate: tool-choice accuracy ≥ ${(GATE_ACCURACY * 100).toFixed(0)}%`);
    if (acc < GATE_ACCURACY - 1e-9) {
      console.error(`\nGATE FAILED — accuracy ${(acc * 100).toFixed(1)}% is below the ${(GATE_ACCURACY * 100).toFixed(0)}% floor.`);
      process.exit(1);
    }
    console.log("GATE PASSED.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
