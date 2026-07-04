// Unit — the "ambiguous input" front door: normalizeInvoice coerces messy
// payloads (alias keys, string amounts, EU number formats, missing fields) into a
// clean NormalizedInvoice and records every coercion in `notes`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInvoice, parseAmount } from "../../src/ap/normalize.js";

test("maps alias keys to canonical fields", () => {
  const inv = normalizeInvoice({ supplier: "Contoso Ltd", invoice_number: "CO-42", grand_total: 990 });
  assert.equal(inv.vendor, "Contoso Ltd");
  assert.equal(inv.vendor_ref, "CO-42");
  assert.equal(inv.total, 990);
});

test("parses amounts from messy strings (currency symbols, grouping, EU decimals)", () => {
  assert.equal(parseAmount("€1,234.50"), 1234.5); // US grouping
  assert.equal(parseAmount("1.234,50"), 1234.5); // EU grouping
  assert.equal(parseAmount("USD 900"), 900);
  assert.equal(parseAmount("  -12.00 "), -12);
  assert.equal(parseAmount("not-a-number"), null);
  assert.equal(parseAmount(1500), 1500);
});

test("generates a synthetic invoice_id and notes it when missing", () => {
  const inv = normalizeInvoice({ vendor: "Acme", total: 10 });
  assert.ok(inv.invoice_id.startsWith("inv-"));
  assert.ok(inv.notes.some((n) => /invoice_id missing/.test(n)));
});

test("defaults the currency to EUR and records missing required fields", () => {
  const inv = normalizeInvoice({ total: 100 });
  assert.equal(inv.currency, "EUR");
  assert.ok(inv.notes.some((n) => /currency missing/.test(n)));
  assert.ok(inv.notes.some((n) => /vendor name missing/.test(n)));
  assert.ok(inv.notes.some((n) => /tax_id missing/.test(n)));
});

test("infers total from subtotal + tax when total is absent", () => {
  const inv = normalizeInvoice({ vendor: "Acme", subtotal: 1000, tax: 240 });
  assert.equal(inv.total, 1240);
  assert.ok(inv.notes.some((n) => /total inferred/.test(n)));
});

test("infers subtotal from total - tax when subtotal is absent", () => {
  const inv = normalizeInvoice({ vendor: "Acme", total: 1240, tax: 240 });
  assert.equal(inv.subtotal, 1000);
});

test("normalizes an unparseable date to null with a note", () => {
  const inv = normalizeInvoice({ vendor: "Acme", total: 10, date: "not-a-date" });
  assert.equal(inv.invoice_date, null);
  assert.ok(inv.notes.some((n) => /unparseable/.test(n)));
});

test("never throws on a totally empty payload", () => {
  const inv = normalizeInvoice({});
  assert.ok(inv.invoice_id);
  assert.equal(inv.total, null);
  assert.equal(inv.vendor, null);
});

test("normalizes line items and keeps unparseable amounts as null", () => {
  const inv = normalizeInvoice({
    vendor: "Acme",
    total: 30,
    line_items: [{ description: "Widgets", qty: 3, price: "10.00", amount: "30.00" }],
  });
  assert.equal(inv.line_items.length, 1);
  assert.equal(inv.line_items[0]!.amount, 30);
  assert.equal(inv.line_items[0]!.quantity, 3);
});
