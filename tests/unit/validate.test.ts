// Unit — the cross-check layer: R1..R4 structural rules plus the memory-grounded
// R5 (duplicate) and R6 (amount anomaly) checks. Duplicate detection is EXACT-key
// (vendor + ref, or vendor + total + date), never fuzzy — so it is stable offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInvoice } from "../../src/ap/normalize.js";
import {
  detectAmountAnomaly,
  detectDuplicate,
  hasBlockingError,
  priorInvoicesFromRecall,
  validateInvoice,
  type PriorInvoice,
} from "../../src/ap/validate.js";

function find(findings: ReturnType<typeof validateInvoice>, rule: string) {
  return findings.find((f) => f.rule === rule)!;
}

test("R1 fails on a missing or non-positive total", () => {
  assert.equal(find(validateInvoice(normalizeInvoice({ vendor: "A" })), "R1").passed, false);
  assert.equal(find(validateInvoice(normalizeInvoice({ vendor: "A", total: -5 })), "R1").passed, false);
  assert.equal(find(validateInvoice(normalizeInvoice({ vendor: "A", total: 100 })), "R1").passed, true);
});

test("R2 fails when vendor / vendor_ref / tax_id are missing", () => {
  const missing = validateInvoice(normalizeInvoice({ total: 100 }));
  assert.equal(find(missing, "R2").passed, false);
  assert.equal(find(missing, "R2").severity, "error");

  const complete = validateInvoice(
    normalizeInvoice({ vendor: "Acme", invoice_number: "A-1", tax_id: "TX-1", total: 100 })
  );
  assert.equal(find(complete, "R2").passed, true);
});

test("R3 fails when subtotal + tax does not reconcile to total", () => {
  const bad = validateInvoice(normalizeInvoice({ vendor: "A", subtotal: 1000, tax: 200, total: 1300 }));
  assert.equal(find(bad, "R3").passed, false);
  const good = validateInvoice(normalizeInvoice({ vendor: "A", subtotal: 1000, tax: 200, total: 1200 }));
  assert.equal(find(good, "R3").passed, true);
});

test("R4 fails when line items do not sum to the subtotal/total", () => {
  const bad = validateInvoice(
    normalizeInvoice({ vendor: "A", total: 100, line_items: [{ description: "x", amount: 40 }, { description: "y", amount: 30 }] })
  );
  assert.equal(find(bad, "R4").passed, false);
  const good = validateInvoice(
    normalizeInvoice({ vendor: "A", total: 100, line_items: [{ description: "x", amount: 60 }, { description: "y", amount: 40 }] })
  );
  assert.equal(find(good, "R4").passed, true);
});

test("hasBlockingError is true only when a hard error is present", () => {
  assert.equal(hasBlockingError(validateInvoice(normalizeInvoice({ total: 100 }))), true); // R2 error
  assert.equal(
    hasBlockingError(validateInvoice(normalizeInvoice({ vendor: "A", invoice_number: "1", tax_id: "T", subtotal: 80, tax: 20, total: 100 }))),
    false
  );
});

const priors: PriorInvoice[] = [
  { invoiceId: "inv-1", vendor: "Northwind", vendorRef: "NW-1001", total: 1200, date: "2026-02-03" },
];

test("R5 flags a duplicate by same vendor + vendor_ref", () => {
  const inv = normalizeInvoice({ vendor: "Northwind", invoice_number: "NW-1001", tax_id: "T", total: 1200, date: "2026-05-01" });
  const f = detectDuplicate(inv, priors);
  assert.equal(f.passed, false);
  assert.match(f.message, /DUPLICATE/);
});

test("R5 flags a duplicate by same vendor + total + date even with a different ref", () => {
  const inv = normalizeInvoice({ vendor: "Northwind", invoice_number: "NW-9999", tax_id: "T", total: 1200, date: "2026-02-03" });
  assert.equal(detectDuplicate(inv, priors).passed, false);
});

test("R5 does not flag a genuinely new invoice from the same vendor", () => {
  const inv = normalizeInvoice({ vendor: "Northwind", invoice_number: "NW-1002", tax_id: "T", total: 1320, date: "2026-03-03" });
  assert.equal(detectDuplicate(inv, priors).passed, true);
});

test("R5 never matches a re-read of the same invoice_id against itself", () => {
  const self: PriorInvoice[] = [{ invoiceId: "inv-x", vendor: "Acme", vendorRef: "A-1", total: 50, date: "2026-01-01" }];
  const inv = normalizeInvoice({ id: "inv-x", vendor: "Acme", invoice_number: "A-1", tax_id: "T", total: 50, date: "2026-01-01" });
  assert.equal(detectDuplicate(inv, self).passed, true);
});

test("R6 flags an amount well above the vendor's usual, but not an in-range one", () => {
  const anomalous = normalizeInvoice({ vendor: "Northwind", invoice_number: "NW-2", tax_id: "T", total: 9000, date: "2026-06-01" });
  assert.equal(detectAmountAnomaly(anomalous, priors).passed, false);
  const normal = normalizeInvoice({ vendor: "Northwind", invoice_number: "NW-3", tax_id: "T", total: 1300, date: "2026-06-01" });
  assert.equal(detectAmountAnomaly(normal, priors).passed, true);
});

test("R6 does not flag a brand-new vendor (no history)", () => {
  const inv = normalizeInvoice({ vendor: "Brand New Co", total: 99999 });
  assert.equal(detectAmountAnomaly(inv, priors).passed, true);
});

test("priorInvoicesFromRecall lifts invoice facts out of recalled memory metadata", () => {
  const priorsFromRecall = priorInvoicesFromRecall([
    { content: "x", metadata: { invoice_id: "inv-7", vendor: "Acme", vendor_ref: "A-7", total: 500, invoice_date: "2026-01-01" } },
    { content: "y", metadata: null },
    { content: "z", metadata: { note: "not an invoice" } },
  ]);
  assert.equal(priorsFromRecall.length, 1);
  assert.equal(priorsFromRecall[0]!.invoiceId, "inv-7");
});
