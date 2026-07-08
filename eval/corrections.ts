// Learning-from-corrections eval — the approval gate as a training signal, measured.
//
//   npm run eval:corrections
//
// The decision-quality eval (eval/run.ts) grades a single invoice in isolation. THIS
// harness measures something the main eval cannot: does a HUMAN CORRECTION written
// back at the approval gate actually change the NEXT decision for that vendor?
//
// It reports a BEHAVIORAL delta, not an accuracy claim. For each scenario it runs the
// SAME decision invoice twice through the real AutopilotAgent (offline Fakes, the
// genuine amend()/reject() → memory → recall path — nothing hand-injected), differing
// ONLY in whether the human correction happened:
//
//   • WITHOUT the correction  — the "before": what the agent proposes cold.
//   • WITH    the correction  — the "after":  what it proposes once the gate fed back.
//
// The delta between the two columns is the isolated effect of the learning signal.
// Honest by construction: if a scenario's proposal does NOT change (the negative
// control), that is reported too — the learning is amount-scoped, so it must NOT
// escalate a vendor that later bills the corrected amount (no crying wolf).

import { AutopilotAgent } from "../src/agents/autopilot-agent.js";
import { defaultLoop } from "../src/ap/loop.js";
import { hasQwenCreds } from "../src/qwen/client.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { InMemoryStore } from "../src/memory/store.js";
import { InMemoryWorkItemStore } from "../src/ap/workitem-store.js";
import { fakeSinks } from "../src/ap/sinks.js";
import type { RawInvoice } from "../src/types.js";

// A single learning scenario: establish the vendor, apply (or skip) a human
// correction, then decide the same invoice. `expectChange` is what a reviewer would
// predict — the harness reports whether it held, it does not enforce it.
interface Correction {
  kind: "amend_down"; // amend the establish invoice's amount down to `amount`
  amount: number;
  reason: string;
}
interface Scenario {
  id: string;
  label: string;
  establish: RawInvoice[]; // intaken + APPROVED first (vendor history)
  corrected: RawInvoice; // the invoice a human corrects (or, in the "before", just approves)
  correction: Correction | { kind: "reject"; reason: string };
  decision: RawInvoice; // the invoice under decision, run identically in both worlds
  expectChange: boolean; // reviewer's prediction: should the proposal change?
}

const V = "Globex Corp";
const SCENARIOS: Scenario[] = [
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

function newAgent(): AutopilotAgent {
  return new AutopilotAgent(defaultEmbedder(), new InMemoryStore(), new InMemoryWorkItemStore(), defaultLoop(), fakeSinks());
}

// Run the decision invoice with the correction either APPLIED or SKIPPED.
async function decide(s: Scenario, applyCorrection: boolean): Promise<string> {
  const agent = newAgent();
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
    await agent.approve(corr.id); // the "before" world: the invoice is simply approved as billed
  }
  const decided = await agent.intake(s.decision);
  return decided.proposed.tool;
}

async function main(): Promise<void> {
  const online = hasQwenCreds();
  console.log(`\nArchon Autopilot — learning-from-corrections (the approval gate as a training signal)`);
  console.log(`Mode : ${online ? "ONLINE (real qwen-plus)" : "OFFLINE (deterministic Fakes)"}`);
  console.log(`Each row runs the SAME decision invoice twice — the only difference is whether the human correction happened.\n`);
  console.log(`ID    Before (no correction)   After (with correction)   Δ changed   matches prediction`);
  console.log("-".repeat(84));

  let changed = 0;
  let asPredicted = 0;
  for (const s of SCENARIOS) {
    const before = await decide(s, false);
    const after = await decide(s, true);
    const didChange = before !== after;
    if (didChange) changed++;
    const ok = didChange === s.expectChange;
    if (ok) asPredicted++;
    console.log(`${s.id.padEnd(6)}${before.padEnd(25)}${after.padEnd(26)}${(didChange ? "yes" : "no").padEnd(12)}${ok ? "✓" : "✗"}`);
    console.log(`      ${s.label}`);
  }

  console.log("-".repeat(84));
  console.log(`Proposals changed by the correction signal : ${changed}/${SCENARIOS.length}`);
  console.log(`Behaved as a reviewer would predict         : ${asPredicted}/${SCENARIOS.length}`);
  console.log(
    `\nHeadline: when a human amend-down is on record, a re-bill ABOVE the corrected amount flips ` +
      `draft_payment → flag_for_review; a re-bill AT the corrected amount is left as draft_payment ` +
      `(the signal is amount-scoped — it escalates the genuine error, not the compliant invoice).\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
