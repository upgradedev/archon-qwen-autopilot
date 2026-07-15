// Unit — the AUTONOMOUS read/analyze tool tier (analysis-tools.ts). These are the
// tools the loop runs INSIDE its cycle with no side-effect: recall surfaces raw
// vendor FACTS (not verdicts), validate owns R1–R4, check_duplicate owns R5, and
// compute_variance owns R6. We drive each directly (no LLM) and assert it produces
// the right findings + evidence, and that the memory-grounded checks refuse to run
// before a recall has loaded the vendor history.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEvidence,
  executeAnalysisTool,
  newLoopState,
} from "../../src/ap/analysis-tools.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore, type RecallHit, type RecallOptions } from "../../src/memory/store.js";
import { remember } from "../../src/memory/memory.js";
import { normalizeInvoice } from "../../src/ap/normalize.js";

function deps() {
  return { embedder: new FakeEmbedder(), memory: new InMemoryStore() };
}

class CorrectionOutsideSemanticRecallStore extends InMemoryStore {
  override async recall(queryVec: number[], opts: RecallOptions = {}): Promise<RecallHit[]> {
    const hits = await super.recall(queryVec, { ...opts, limit: 50 });
    return hits
      .filter((hit) => hit.metadata?.["correction"] === undefined)
      .slice(0, opts.limit ?? 5);
  }
}

// Seed a prior-invoice memory exactly as the agent writes it (metadata shape the
// duplicate/variance checks read back).
async function seedPrior(d: ReturnType<typeof deps>, meta: Record<string, unknown>) {
  await remember(d.embedder, d.memory, {
    kind: "invoice",
    vendor: meta["vendor"] as string,
    sourceRef: meta["invoice_id"] as string,
    content: `Invoice ${meta["vendor_ref"]} from ${meta["vendor"]} for EUR ${meta["total"]}.`,
    metadata: { processing_status: "approved", currency: "EUR", ...meta },
  });
}

test("recall_vendor_history on a NEW vendor surfaces no history and marks the vendor unknown", async () => {
  const d = deps();
  const state = newLoopState(normalizeInvoice({ vendor: "Fresh", invoice_number: "F-1", tax_id: "T", total: 100 }));
  const obs = await executeAnalysisTool("recall_vendor_history", {}, state, d);
  assert.match(obs, /new/i);
  assert.equal(state.didRecall, true);
  assert.equal(state.knownVendor, false);
});

test("validate_invoice produces R1–R4 and flags missing required fields", async () => {
  const d = deps();
  const state = newLoopState(normalizeInvoice({ vendor: "X", subtotal: 100, tax: 20, total: 120 })); // no vendor_ref / tax_id
  const obs = await executeAnalysisTool("validate_invoice", {}, state, d);
  assert.equal(state.didValidate, true);
  assert.equal(state.missingFields, true);
  assert.ok(state.findings.some((f) => f.rule === "R2" && !f.passed));
  assert.match(obs, /R2/);
});

test("check_duplicate refuses to run before recall, then confirms R5 once history is loaded", async () => {
  const d = deps();
  const inv = normalizeInvoice({ vendor: "Dup", invoice_number: "D-1", tax_id: "T", total: 500, date: "2026-01-01", currency: "EUR" });
  const state = newLoopState(inv);

  const early = await executeAnalysisTool("check_duplicate", {}, state, d);
  assert.match(early, /recall_vendor_history first/);
  assert.equal(state.didCheckDuplicate, false);

  await seedPrior(d, { invoice_id: "prior-1", vendor: "Dup", vendor_ref: "D-1", total: 500, invoice_date: "2026-01-01" });
  await executeAnalysisTool("recall_vendor_history", {}, state, d);
  assert.equal(state.refMatch, true); // a FACT surfaced by recall

  const obs = await executeAnalysisTool("check_duplicate", {}, state, d);
  assert.equal(state.duplicate, true);
  assert.ok(state.findings.some((f) => f.rule === "R5" && !f.passed));
  assert.match(obs, /DUPLICATE/i);
});

test("compute_variance_vs_history flags an amount many times the vendor average (R6)", async () => {
  const d = deps();
  const inv = normalizeInvoice({ vendor: "Spiker", invoice_number: "S-3", tax_id: "T", total: 5000, date: "2026-03-01", currency: "EUR" });
  const state = newLoopState(inv);
  await seedPrior(d, { invoice_id: "s-1", vendor: "Spiker", vendor_ref: "S-1", total: 200, invoice_date: "2026-01-01" });
  await seedPrior(d, { invoice_id: "s-2", vendor: "Spiker", vendor_ref: "S-2", total: 220, invoice_date: "2026-02-01" });
  await executeAnalysisTool("recall_vendor_history", {}, state, d);
  assert.ok(state.amountRatio != null && state.amountRatio > 3); // a FACT

  await executeAnalysisTool("compute_variance_vs_history", {}, state, d);
  assert.equal(state.anomaly, true);
  assert.ok(state.findings.some((f) => f.rule === "R6" && !f.passed));
});

test("computeEvidence renders a machine-readable snapshot the Fake can branch on", async () => {
  const d = deps();
  const state = newLoopState(normalizeInvoice({ vendor: "X", subtotal: 100, tax: 20, total: 120 }));
  await executeAnalysisTool("recall_vendor_history", {}, state, d);
  await executeAnalysisTool("validate_invoice", {}, state, d);
  const ev = computeEvidence(state);
  assert.match(ev, /^EVIDENCE: /);
  assert.match(ev, /recalled=true/);
  assert.match(ev, /validated=true/);
  assert.match(ev, /missing_fields=true/); // no vendor_ref / tax_id
});

test("recall surfaces a prior human AMEND-DOWN correction and flags a re-bill materially above it", async () => {
  const d = deps();
  // A prior invoice for the vendor (so it is 'known') + the amend-down correction memory.
  await seedPrior(d, { invoice_id: "gx-1", vendor: "Globex", vendor_ref: "GX-1", total: 5000, invoice_date: "2026-01-01" });
  await remember(d.embedder, d.memory, {
    kind: "insight",
    vendor: "Globex",
    sourceRef: "gx-1",
    content: "Human CORRECTION for Globex: amended down from EUR 5000 to EUR 3000.",
    metadata: { correction: "amended_down", vendor: "Globex", tool: "draft_payment", corrected_amount: 3000, corrected_currency: "EUR", billed_amount: 5000, invoice_id: "gx-1" },
  });
  // The invoice under decision re-bills 5000 (above the corrected 3000).
  const state = newLoopState(normalizeInvoice({ vendor: "Globex", invoice_number: "GX-2", tax_id: "T", total: 5000, date: "2026-03-01", currency: "EUR" }));
  const obs = await executeAnalysisTool("recall_vendor_history", {}, state, d);

  assert.equal(state.correctedAmount, 3000);
  assert.equal(state.priorCorrection, true);
  assert.equal(state.rebillsCorrected, true);
  assert.match(obs, /corrected this vendor's amount DOWN to 3000/i);
  assert.match(computeEvidence(state), /prior_correction=true rebills_corrected=true/);
});

test("recall surfaces a prior REJECTION, and a re-bill AT the corrected amount does NOT trip the escalation", async () => {
  const d = deps();
  await seedPrior(d, { invoice_id: "gx-1", vendor: "Globex", vendor_ref: "GX-1", total: 5000, invoice_date: "2026-01-01" });
  await remember(d.embedder, d.memory, {
    kind: "insight",
    vendor: "Globex",
    sourceRef: "gx-1",
    content: "A proposed draft_payment for Globex was REJECTED by a human: not recognised.",
    metadata: { correction: "rejected", vendor: "Globex", tool: "draft_payment", invoice_id: "gx-1", reason: "not recognised" },
  });
  await remember(d.embedder, d.memory, {
    kind: "insight",
    vendor: "Globex",
    sourceRef: "gx-1",
    content: "Human CORRECTION for Globex: amended down to EUR 3000.",
    metadata: { correction: "amended_down", vendor: "Globex", tool: "draft_payment", corrected_amount: 3000, corrected_currency: "EUR", billed_amount: 5000, invoice_id: "gx-1" },
  });
  // This invoice bills the CORRECTED 3000 — compliant, so no re-bill escalation.
  const state = newLoopState(normalizeInvoice({ vendor: "Globex", invoice_number: "GX-2", tax_id: "T", total: 3000, date: "2026-03-01", currency: "EUR" }));
  const obs = await executeAnalysisTool("recall_vendor_history", {}, state, d);

  assert.equal(state.priorRejection, true);
  assert.equal(state.correctedAmount, 3000);
  assert.equal(state.rebillsCorrected, false); // 3000 is NOT materially above the corrected 3000
  assert.match(obs, /REJECTED by a human/i);
  assert.match(computeEvidence(state), /prior_correction=true rebills_corrected=false/);
});

test("exact processed duplicate remains visible outside the bounded history window", async () => {
  const d = deps();
  await seedPrior(d, {
    invoice_id: "exact-old",
    vendor: "Long History Vendor",
    vendor_ref: "OLD-REF",
    total: 500,
    invoice_date: "2026-01-01",
  });
  // Model a vendor whose exact match is outside the bounded R6 window. The
  // dedicated indexed lookup still scans the full business-key index.
  d.memory.invoiceHistory = async () => [];
  const state = newLoopState(normalizeInvoice({
    vendor: "Long History Vendor",
    invoice_number: "OLD-REF",
    tax_id: "T",
    total: 999,
    date: "2026-07-01",
    currency: "EUR",
  }));
  await executeAnalysisTool("recall_vendor_history", {}, state, d);
  assert.equal(state.refMatch, true);
  await executeAnalysisTool("check_duplicate", {}, state, d);
  assert.equal(state.duplicate, true);
});

test("UNKNOWN currency history cannot form an amount/date duplicate or variance ratio", async () => {
  const d = deps();
  await remember(d.embedder, d.memory, {
    kind: "invoice",
    vendor: "Currencyless Vendor",
    content: "legacy currencyless invoice",
    metadata: {
      processing_status: "approved",
      invoice_id: "legacy-1",
      vendor: "Currencyless Vendor",
      vendor_ref: "LEGACY-1",
      total: 100,
      invoice_date: "2026-01-01",
      currency: "UNKNOWN",
    },
  });
  const state = newLoopState(normalizeInvoice({
    vendor: "Currencyless Vendor",
    invoice_number: "NEW-2",
    tax_id: "T",
    total: 100,
    date: "2026-01-01",
  }));
  await executeAnalysisTool("recall_vendor_history", {}, state, d);
  assert.equal(state.amountDateMatch, false);
  assert.equal(state.amountRatio, null);
  await executeAnalysisTool("check_duplicate", {}, state, d);
  assert.equal(state.duplicate, false);
});

test("correction policy uses deterministic history even when correction is absent from semantic top-k", async () => {
  const d = { embedder: new FakeEmbedder(), memory: new CorrectionOutsideSemanticRecallStore() };
  await seedPrior(d, { invoice_id: "det-1", vendor: "Deterministic Co", vendor_ref: "DET-1", total: 5000, invoice_date: "2026-01-01" });
  await remember(d.embedder, d.memory, {
    kind: "insight",
    vendor: "Deterministic Co",
    content: "Human correction intentionally excluded from semantic results.",
    metadata: {
      correction: "amended_down",
      vendor: "Deterministic Co",
      corrected_amount: 3000,
      corrected_currency: "EUR",
    },
  });
  const state = newLoopState(normalizeInvoice({
    vendor: "Deterministic Co",
    invoice_number: "DET-2",
    tax_id: "T",
    total: 5000,
    date: "2026-02-01",
    currency: "EUR",
  }));
  await executeAnalysisTool("recall_vendor_history", {}, state, d);

  assert.ok(state.recalled.every((fact) => !/correction/i.test(fact.content)));
  assert.equal(state.correctedAmount, 3000);
  assert.equal(state.rebillsCorrected, true);
});

test("amount baselines and amend-down corrections never cross currency boundaries", async () => {
  const d = deps();
  await seedPrior(d, {
    invoice_id: "fx-1",
    vendor: "FX Safe Co",
    vendor_ref: "FX-USD",
    total: 10,
    invoice_date: "2026-01-01",
    currency: "USD",
  });
  await remember(d.embedder, d.memory, {
    kind: "insight",
    vendor: "FX Safe Co",
    content: "USD correction must not govern a EUR invoice.",
    metadata: {
      correction: "amended_down",
      vendor: "FX Safe Co",
      corrected_amount: 5,
      corrected_currency: "USD",
    },
  });
  const state = newLoopState(normalizeInvoice({
    vendor: "FX Safe Co",
    invoice_number: "FX-EUR",
    tax_id: "T",
    total: 1000,
    date: "2026-02-01",
    currency: "EUR",
  }));
  await executeAnalysisTool("recall_vendor_history", {}, state, d);

  assert.equal(state.knownVendor, true);
  assert.equal(state.amountRatio, null, "USD amounts cannot create a EUR variance ratio");
  assert.equal(state.correctedAmount, null, "USD correction cannot govern a EUR invoice");
  assert.equal(state.rebillsCorrected, false);
});

test("request_more_context is a benign no-side-effect read", async () => {
  const d = deps();
  const state = newLoopState(normalizeInvoice({ vendor: "X", invoice_number: "1", tax_id: "T", total: 1 }));
  const obs = await executeAnalysisTool("request_more_context", { question: "Which cost centre?" }, state, d);
  assert.match(obs, /Which cost centre/);
});
