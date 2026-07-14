// Integration — learning from corrections: the approval gate as a training signal.
//
// This is the gated proof that the human decisions written back at the approval gate
// are actually READ on the next decision (retiring the old write-only claim). It
// drives the REAL AutopilotAgent end to end (offline Fakes, in-memory stores) through
// the genuine amend()/reject() → memory → recall path — nothing is hand-injected.
//
// The measurement is a BEHAVIORAL delta, isolated so the ONLY difference between the
// two runs is whether the human correction happened:
//
//   • re-bill ABOVE a human-corrected-down amount:
//       WITHOUT the correction  → the agent proposes draft_payment (straight-through)
//       WITH   the correction   → the agent proposes flag_for_review (escalate)
//   • re-bill AT the corrected amount (the negative control — no crying wolf):
//       WITH the correction     → still draft_payment (the signal is amount-scoped)
//
// We assert the tool CHANGES on the first and does NOT change on the second, plus
// that the correction is surfaced in the recall observation the model reads.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AutopilotAgent } from "../../src/agents/autopilot-agent.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import type { RawInvoice } from "../../src/types.js";

// Offline — no key means the loop + embedder auto-select the deterministic Fakes.
delete process.env.DASHSCOPE_API_KEY;

function newAgent(): AutopilotAgent {
  return new AutopilotAgent(
    new FakeEmbedder(),
    new InMemoryStore(),
    new InMemoryWorkItemStore(),
    defaultLoop(),
    fakeSinks()
  );
}

const VENDOR = "Globex Corp";
const seedEstablish: RawInvoice = { vendor: VENDOR, invoice_number: "GX-1", date: "2026-01-05", subtotal: 2500, tax: 500, total: 3000, tax_id: "TX-100", currency: "EUR" };
// The vendor over-bills 5000; the contracted/agreed amount is 3000.
const seedOverbill: RawInvoice = { vendor: VENDOR, invoice_number: "GX-2", date: "2026-02-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" };
// A later invoice that re-bills the same over-billed 5000.
const rebillHigh: RawInvoice = { vendor: VENDOR, invoice_number: "GX-3", date: "2026-03-05", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-100", currency: "EUR" };
// A later invoice that bills the CORRECTED amount 3000 (the honest negative control).
const billsCorrected: RawInvoice = { vendor: VENDOR, invoice_number: "GX-4", date: "2026-03-05", subtotal: 3000, tax: 0, total: 3000, tax_id: "TX-100", currency: "EUR" };

test("BASELINE (no correction): a re-billed over-amount is proposed for straight-through payment", async () => {
  const agent = newAgent();
  // Establish the vendor, then APPROVE the 5000 invoice as-is (no human correction).
  const a = await agent.intake(seedEstablish);
  await agent.approve(a.id);
  const b = await agent.intake(seedOverbill);
  await agent.approve(b.id); // paid 5000 — no correction on record
  const c = await agent.intake(rebillHigh);
  assert.equal(c.proposed.tool, "draft_payment", "without a correction, a clean known-vendor invoice is paid");
});

test("LEARNED (with correction): the same re-bill is ESCALATED — the gate feedback changed the decision", async () => {
  const agent = newAgent();
  const a = await agent.intake(seedEstablish);
  await agent.approve(a.id);
  const b = await agent.intake(seedOverbill);
  // The human AMENDS the amount DOWN to the agreed 3000 (catching the over-bill).
  await agent.amend(b.id, { args: { amount: 3000 }, reason: "agreed/contracted amount for this vendor is 3000" });
  const c = await agent.intake(rebillHigh);

  assert.equal(c.proposed.tool, "flag_for_review", "with the correction on record, a re-bill above it is escalated, not paid");
  // The delta is exactly the isolated learning signal (baseline draft_payment → flag_for_review).
  assert.notEqual(c.proposed.tool, "draft_payment");
  // …and it is READ, not silent: the recall observation the model sees names the correction.
  const recallStep = c.trace.find((s) => s.tool === "recall_vendor_history");
  assert.ok(recallStep, "the loop recalled vendor history");
  assert.match(recallStep!.observation, /corrected this vendor's amount DOWN to 3000/i);
  assert.match(recallStep!.observation, /re-bills materially ABOVE/i);
});

test("NEGATIVE CONTROL (no crying wolf): after a correction, an invoice that bills the CORRECTED amount is still paid", async () => {
  const agent = newAgent();
  const a = await agent.intake(seedEstablish);
  await agent.approve(a.id);
  const b = await agent.intake(seedOverbill);
  await agent.amend(b.id, { args: { amount: 3000 }, reason: "agreed amount is 3000" });
  // This invoice bills the corrected 3000 — the vendor complied; nothing to escalate.
  const d = await agent.intake(billsCorrected);
  assert.equal(d.proposed.tool, "draft_payment", "the learning is amount-scoped — it does not escalate a compliant invoice");
});

test("a REJECTED proposal is written back with structured metadata and surfaced on the vendor's next recall", async () => {
  const agent = newAgent();
  const a = await agent.intake(seedEstablish);
  await agent.reject(a.id, "not a recognised purchase");
  // A later invoice from the same vendor recalls the rejection as a prior human correction.
  const c = await agent.intake({ ...seedOverbill });
  const recallStep = c.trace.find((s) => s.tool === "recall_vendor_history");
  assert.ok(recallStep, "the loop recalled vendor history");
  assert.match(recallStep!.observation, /REJECTED by a human/i);
  assert.ok(
    !c.findings.some((f) => f.rule === "R5" && !f.passed),
    "the rejected invoice itself is not durable duplicate history"
  );
});
