// Decision-quality eval runner — the measured number on the autopilot's own output.
//
//   npm run eval           # drive every scenario, print the table + accuracy N/M
//   npm run eval -- --gate # also FAIL if tool-choice accuracy is below the floor (CI)
//
// This is the thin CLI wrapper: the measurement lives in eval/lib.ts (no side effect on
// import, so scripts/readiness.ts reuses runEval() directly); this file only prints and
// gates. For each labelled scenario (eval/dataset.ts) the lib drives the REAL decider
// path end to end — build a fresh AutopilotAgent (hermetic in-memory stores + fake
// sinks), intake any `seed` invoices so the vendor's history lands in persistent memory,
// then intake the invoice under decision and read back the tool the decider PROPOSED,
// comparing it to the business-correct `expected` label.
//
// OFFLINE vs ONLINE — the same runner, only the model seam changes:
//   • No DASHSCOPE_API_KEY  → FakeQwenChatClient + FakeEmbedder (deterministic). The
//     number is a POLICY / REGRESSION guard over the real intake pipeline. CI gates it.
//   • DASHSCOPE_API_KEY set → real qwen-plus function-calling + text-embedding-v4. The
//     number is the actual DECISION-QUALITY of the model choosing freely. Costs cents.
// The header prints the live model ids so a run is self-labelling (fake vs qwen).
//
// We grade TOOL CHOICE (gated). We ALSO report arg-sanity — does the proposed action
// execute cleanly against the fake sinks — as an un-gated signal.

import { defaultLoop } from "../src/ap/loop.js";
import { hasQwenCreds } from "../src/qwen/client.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { EVAL_SET } from "./dataset.js";
import { runEval } from "./lib.js";

// Enforced FLOOR — set to the MEASURED offline result, not an aspiration. The offline
// path is deterministic, so this never flakes; it fails CI only on a real regression in
// the intake→signals→tool pipeline. It is deliberately at (not above) the measured
// number, honestly accounting for the one documented known-limitation scenario.
const GATE_ACCURACY = 0.9;

async function main() {
  const gate = process.argv.slice(2).includes("--gate");

  const embedder = defaultEmbedder();
  const decider = defaultLoop();
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

  const { rows, n, correct, argSane, acc, avgSteps, minSteps, multiStep } = await runEval();

  for (const r of rows) {
    const mark = (b: boolean) => (b ? " ✓ " : " ✗ ");
    const known = r.scenario.knownLimitation && !r.correct ? "  (known limitation)" : "";
    console.log(
      `${r.scenario.id.padEnd(6)}${r.scenario.category.padEnd(22)} ${r.scenario.expected.padEnd(20)} ` +
        `${r.proposed.padEnd(20)}${mark(r.correct)}  ${mark(r.argSane)}${known}`
    );
  }

  console.log("-".repeat(94));
  console.log(`Tool-choice accuracy : ${correct}/${n}  (${(acc * 100).toFixed(1)}%)   ← the graded, gated number`);
  console.log(`Arg-sanity (executes): ${argSane}/${n}  (${((argSane / n) * 100).toFixed(1)}%)   (reported, not gated)`);
  console.log(`Loop autonomy        : ${multiStep}/${n} scenarios took ≥2 autonomous steps (avg ${avgSteps.toFixed(1)}, min ${minSteps}) before a terminal action`);

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
