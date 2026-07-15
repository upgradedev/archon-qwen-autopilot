// Runtime-correction eval — measured behavior change; no model weights are updated.
//
//   npm run eval:corrections
//
// Thin CLI wrapper: the measurement lives in eval/lib.ts (runCorrections, no side effect
// on import, so scripts/readiness.ts reuses it); this file only prints.
//
// The decision-quality eval (eval/run.ts) grades a single invoice in isolation. THIS
// harness measures something the main eval cannot: does a HUMAN CORRECTION written back
// at the approval gate actually change the NEXT decision for that vendor?
//
// It reports a BEHAVIORAL delta, not an accuracy claim. For each scenario it runs the
// SAME decision invoice twice through the real AutopilotAgent (offline Fakes, the genuine
// amend()/reject() → memory → recall path — nothing hand-injected), differing ONLY in
// whether the human correction happened:
//
//   • WITHOUT the correction  — the "before": what the agent proposes cold.
//   • WITH    the correction  — the "after":  what it proposes once the gate fed back.
//
// The delta between the two columns is the isolated effect of the learning signal.
// Honest by construction: if a scenario's proposal does NOT change (the negative
// control), that is reported too — the learning is amount-scoped, so it must NOT
// escalate a vendor that later bills the corrected amount (no crying wolf).

import { runCorrections } from "./lib.js";
import { safeOperationalSummary } from "../src/security/operational-error.js";

async function main(): Promise<void> {
  console.log(`\nArchon Autopilot — runtime correction recall (no model-weight training)`);
  console.log(`Mode : OFFLINE (deterministic regression; genuine amend → memory → recall path)`);
  console.log(`Each row runs the SAME decision invoice twice — the only difference is whether the human correction happened.\n`);
  console.log(`ID    Before (no correction)   After (with correction)   Δ changed   matches prediction`);
  console.log("-".repeat(84));

  const { rows, total, changed, asPredicted } = await runCorrections();
  for (const r of rows) {
    console.log(`${r.scenario.id.padEnd(6)}${r.before.padEnd(25)}${r.after.padEnd(26)}${(r.changed ? "yes" : "no").padEnd(12)}${r.asPredicted ? "✓" : "✗"}`);
    console.log(`      ${r.scenario.label}`);
  }

  console.log("-".repeat(84));
  console.log(`Proposals changed by the correction signal : ${changed}/${total}`);
  console.log(`Behaved as a reviewer would predict         : ${asPredicted}/${total}`);
  console.log(
    `\nHeadline: when a human amend-down is on record, a re-bill ABOVE the corrected amount flips ` +
      `draft_payment → flag_for_review; a re-bill AT the corrected amount is left as draft_payment ` +
      `(the signal is amount-scoped — it escalates the genuine error, not the compliant invoice).\n`
  );
}

main().catch((err) => {
  console.error(`Correction evaluation failed: ${safeOperationalSummary(err, "eval-corrections")}`);
  process.exit(1);
});
