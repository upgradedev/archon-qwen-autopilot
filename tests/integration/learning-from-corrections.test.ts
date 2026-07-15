// Integration — runtime correction recall: the approval gate records evidence.
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
//       WITHOUT the correction  → the agent proposes draft_payment
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
import type { StoredMemory } from "../../src/memory/store.js";
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

test("BASELINE (no correction): a re-billed over-amount receives the normal payment proposal", async () => {
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
  const amended = await agent.amend(b.id, { args: { amount: 3000 }, reason: "agreed/contracted amount for this vendor is 3000" });
  assert.deepEqual(amended.amendment?.correctionMemory, { applicable: true, stored: true });
  const c = await agent.intake(rebillHigh);

  assert.equal(c.proposed.tool, "flag_for_review", "with the correction on record, a re-bill above it is escalated, not paid");
  // The delta is exactly the isolated runtime correction signal (baseline draft_payment → flag_for_review).
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
  const rejected = await agent.reject(a.id, "not a recognised purchase");
  assert.deepEqual(rejected.rejectionMemory, { stored: true });
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

test("rejection-memory failure is durably surfaced and never labelled persisted", async () => {
  class RejectionFailingStore extends InMemoryStore {
    override async remember(memory: StoredMemory): Promise<string> {
      if (memory.metadata?.["correction"] === "rejected") throw new Error("rejection store unavailable");
      return super.remember(memory);
    }
  }
  const workitems = new InMemoryWorkItemStore();
  const agent = new AutopilotAgent(
    new FakeEmbedder(),
    new RejectionFailingStore(),
    workitems,
    defaultLoop(),
    fakeSinks()
  );
  const item = await agent.intake({
    vendor: "Rejected Memory Failure Co", invoice_number: "RMF-1", date: "2026-07-01",
    currency: "EUR", tax_id: "T", subtotal: 100, tax: 20, total: 120,
  });
  const rejected = await agent.reject(item.id, "reviewer found invalid purchase evidence");

  assert.equal(rejected.status, "rejected", "the human rejection remains terminal");
  assert.equal(rejected.rejectionMemory?.stored, false);
  assert.match(rejected.rejectionMemory?.error ?? "", /\[provider_unavailable; ref [0-9a-f-]+\]/);
  assert.doesNotMatch(rejected.rejectionMemory?.error ?? "", /rejection store unavailable/);
  const persisted = await agent.get(rejected.id);
  assert.deepEqual(persisted.rejectionMemory, rejected.rejectionMemory);
});

test("guided UI scenario contract: distinct dates avoid false R5 duplicates and preserve the 5000/3000 contrast", async () => {
  const agent = newAgent();
  const vendor = "Correction Demo Contract";
  const invoice = (ref: string, total: number, date: string): RawInvoice => ({
    vendor, invoice_number: ref, invoice_date: date, currency: "EUR", tax_id: "DEMO-AP-3000", subtotal: total, tax: 0, total,
  });
  const baseline = await agent.intake(invoice("BASE-3000", 3000, "2026-04-15"));
  await agent.approve(baseline.id);
  const overbill = await agent.intake(invoice("OVERBILL-5000", 5000, "2026-05-15"));
  await agent.amend(overbill.id, { args: { amount: 3000 }, reason: "contracted amount is EUR 3,000" });

  const rebill = await agent.intake(invoice("REBILL-5000", 5000, "2026-06-15"));
  const control = await agent.intake(invoice("CONTROL-3000", 3000, "2026-06-15"));
  assert.equal(rebill.proposed.tool, "flag_for_review");
  assert.equal(control.proposed.tool, "draft_payment");
  assert.ok(!control.findings.some((f) => f.rule === "R5" && !f.passed), "control must not collide with the baseline date");
});

test("guided amend-down stays valid from review and vendor-reply proposals via explicit audited tool override", async () => {
  const completePaymentArgs = (vendor: string) => ({ vendor, amount: 3000, currency: "EUR", pay_on: "2026-05-15" });

  // A duplicate produces flag_for_review, which has no amount argument.
  const reviewAgent = newAgent();
  const reviewVendor = "Correction Override Review";
  const base = await reviewAgent.intake({ vendor: reviewVendor, invoice_number: "SAME", date: "2026-04-15", currency: "EUR", tax_id: "T", subtotal: 3000, tax: 0, total: 3000 });
  await reviewAgent.approve(base.id);
  const reviewed = await reviewAgent.intake({ vendor: reviewVendor, invoice_number: "SAME", date: "2026-05-15", currency: "EUR", tax_id: "T", subtotal: 5000, tax: 0, total: 5000 });
  assert.equal(reviewed.proposed.tool, "flag_for_review");
  const fromReview = await reviewAgent.amend(reviewed.id, {
    tool: "draft_payment", args: completePaymentArgs(reviewVendor), confirmToolOverride: true,
    reason: "explicit reviewer override to the verified contracted amount",
  });
  assert.equal(fromReview.amendment?.proposedTool, "flag_for_review");
  assert.equal(fromReview.amendment?.amendedTool, "draft_payment");
  assert.deepEqual(fromReview.amendment?.correctionMemory, { applicable: true, stored: true });

  // Missing identifiers produce draft_vendor_reply, also without an amount argument.
  const replyAgent = newAgent();
  const replyVendor = "Correction Override Reply";
  const reply = await replyAgent.intake({ vendor: replyVendor, date: "2026-05-15", currency: "EUR", subtotal: 5000, tax: 0, total: 5000 });
  assert.equal(reply.proposed.tool, "draft_vendor_reply");
  const fromReply = await replyAgent.amend(reply.id, {
    tool: "draft_payment", args: completePaymentArgs(replyVendor), confirmToolOverride: true,
    reason: "reviewer verified missing source fields out of band and corrected the amount",
  });
  assert.equal(fromReply.amendment?.proposedTool, "draft_vendor_reply");
  assert.equal(fromReply.amendment?.amendedTool, "draft_payment");
  assert.deepEqual(fromReply.amendment?.correctionMemory, { applicable: true, stored: true });
});

test("correction-memory failure is durably surfaced and never labelled persisted", async () => {
  class CorrectionFailingStore extends InMemoryStore {
    override async remember(memory: StoredMemory): Promise<string> {
      if (memory.metadata?.["correction"] === "amended_down") throw new Error("correction store unavailable");
      return super.remember(memory);
    }
  }
  const memory = new CorrectionFailingStore();
  const agent = new AutopilotAgent(new FakeEmbedder(), memory, new InMemoryWorkItemStore(), defaultLoop(), fakeSinks());
  const vendor = "Correction Failure Co";
  const baseline = await agent.intake({ vendor, invoice_number: "CF-1", date: "2026-04-15", currency: "EUR", tax_id: "T", subtotal: 3000, tax: 0, total: 3000 });
  await agent.approve(baseline.id);
  const overbill = await agent.intake({ vendor, invoice_number: "CF-2", date: "2026-05-15", currency: "EUR", tax_id: "T", subtotal: 5000, tax: 0, total: 5000 });
  const decided = await agent.amend(overbill.id, { args: { amount: 3000 }, reason: "contract amount" });

  assert.equal(decided.status, "approved", "the already-completed sink effect remains explicit");
  assert.equal(decided.amendment?.correctionMemory?.applicable, true);
  assert.equal(decided.amendment?.correctionMemory?.stored, false);
  assert.match(decided.amendment?.correctionMemory?.error ?? "", /\[provider_unavailable; ref [0-9a-f-]+\]/);
  assert.doesNotMatch(decided.amendment?.correctionMemory?.error ?? "", /correction store unavailable/);
  assert.match(String(decided.execution?.output["memoryWarning"]), /correction memory/);
  const persisted = await agent.get(decided.id);
  assert.deepEqual(persisted.amendment?.correctionMemory, decided.amendment?.correctionMemory);
});
