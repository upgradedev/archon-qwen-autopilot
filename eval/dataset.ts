// Decision-quality eval dataset — labelled AP scenarios with the tool a human
// accounts-payable clerk would deem correct (BUSINESS ground truth).
//
// This is the labelled set that turns "the agent proposes actions" into a
// MEASURED number: for each scenario we drive the REAL decider path (normalize →
// validate R1..R6 → recall vendor history → Qwen function-calling) and check
// whether the proposed tool matches `expected`.
//
// LABELLING DISCIPLINE (the thing that keeps this eval honest, not circular):
// every `expected` is set by asking "what should an AP clerk do here?" — it is
// NEVER traced from the offline FakeQwen policy in `fake-chat.ts`. The intake
// pipeline (messy-input normalization, structural validation, memory-grounded
// duplicate/anomaly detection) is real, non-trivial logic; the eval grades that
// whole path against a semantic label. Only the final signals→tool mapping is
// deterministic under the offline Fake — so the offline number is a
// POLICY/REGRESSION guard, and the real DECISION-QUALITY number is the live
// qwen-plus run (which chooses freely against these same labels). See EVAL.md.
//
// `seed` invoices are intaken first (through the same pipeline) so that later
// invoices from the same vendor are RECALLED from persistent memory — that is how
// "recurring vendor", "suspected duplicate", and "amount anomaly" become real,
// memory-grounded situations rather than hand-set flags.
//
// Positioning: universal financial terms only. Vendor names are generic; `tax_id`
// / `tax` are generic accounting fields, not tied to any national scheme.

import type { RawInvoice, ToolName } from "../src/types.js";

export type EvalCategory =
  | "clean_new_vendor"
  | "clean_recurring_vendor"
  | "missing_fields"
  | "unreconciled"
  | "suspected_duplicate"
  | "amount_anomaly"
  | "ambiguous_messy"
  | "precedence";

export interface EvalScenario {
  id: string;
  category: EvalCategory;
  label: string; // what a human reviewer sees; the business situation in one line
  seed?: RawInvoice[]; // prior invoices intaken first (establish vendor history / duplicates)
  invoice: RawInvoice; // the invoice under decision
  expected: ToolName; // the tool a human AP clerk would deem correct (BUSINESS ground truth)
  // Set when the deterministic offline policy is KNOWN to miss this scenario, with
  // the reason. The eval still grades it against the business-correct label and
  // reports the miss honestly (a real limitation, surfaced — not hidden).
  knownLimitation?: string;
}

export const EVAL_SET: EvalScenario[] = [
  // ── Clean, new vendor → draft a journal-entry accrual ───────────────────────
  {
    id: "s01",
    category: "clean_new_vendor",
    label: "Clean invoice from a brand-new vendor, all fields present and reconciling",
    invoice: { vendor: "Northwind Supplies", invoice_number: "NW-1001", date: "2026-02-03", subtotal: 1000, tax: 200, total: 1200, tax_id: "TX-8842", currency: "EUR" },
    expected: "draft_journal_entry",
  },
  {
    id: "s02",
    category: "clean_new_vendor",
    label: "Clean invoice from a different new vendor, professional-fees expense",
    invoice: { vendor: "Meridian Consulting", invoice_number: "MC-77", date: "2026-02-10", subtotal: 4000, tax: 800, total: 4800, tax_id: "TX-5510", currency: "EUR" },
    expected: "draft_journal_entry",
  },
  {
    id: "s03",
    category: "ambiguous_messy",
    label: "Messy-but-clean new vendor: alias keys + EU-formatted string amount normalize to a clean invoice",
    invoice: { supplier: "Contoso Ltd", reference: "CO-42", issued: "2026-02-14", net: "1.000,00", vat: "200,00", amount_due: "€ 1.200,00", tax_number: "TX-9001", ccy: "eur" },
    expected: "draft_journal_entry",
  },
  {
    id: "s04",
    category: "ambiguous_messy",
    label: "Messy new vendor via alternate aliases (payee/number), foreign-currency string amount, no subtotal/tax to reconcile",
    invoice: { payee: "Globex Corp", number: "GX-900", date: "2026-02-20", amount: "USD 900", registration: "TX-3120" },
    expected: "draft_journal_entry",
  },

  // ── Clean, recurring (known) vendor → schedule a payment ────────────────────
  {
    id: "s05",
    category: "clean_recurring_vendor",
    label: "Second clean invoice from a now-known vendor, amount in line with history",
    seed: [{ vendor: "Northwind Supplies", invoice_number: "NW-1001", date: "2026-02-03", subtotal: 1000, tax: 200, total: 1200, tax_id: "TX-8842", currency: "EUR" }],
    invoice: { vendor: "Northwind Supplies", invoice_number: "NW-1002", date: "2026-03-03", subtotal: 1100, tax: 220, total: 1320, tax_id: "TX-8842", currency: "EUR" },
    expected: "draft_payment",
  },
  {
    id: "s06",
    category: "clean_recurring_vendor",
    label: "Third invoice from a vendor seen twice before, clean and in-range",
    seed: [
      { vendor: "Aperture Labs", invoice_number: "AP-01", date: "2026-01-05", subtotal: 500, tax: 100, total: 600, tax_id: "TX-4400", currency: "EUR" },
      { vendor: "Aperture Labs", invoice_number: "AP-02", date: "2026-02-05", subtotal: 550, tax: 110, total: 660, tax_id: "TX-4400", currency: "EUR" },
    ],
    invoice: { vendor: "Aperture Labs", invoice_number: "AP-03", date: "2026-03-05", subtotal: 520, tax: 104, total: 624, tax_id: "TX-4400", currency: "EUR" },
    expected: "draft_payment",
  },
  {
    id: "s07",
    category: "clean_recurring_vendor",
    label: "Recurring vendor, this month's invoice arrives messy but normalizes clean and in-range",
    seed: [{ vendor: "Umbrella Freight", invoice_number: "UF-100", date: "2026-01-11", subtotal: 2000, tax: 400, total: 2400, tax_id: "TX-7700", currency: "EUR" }],
    invoice: { supplier: "Umbrella Freight", reference: "UF-101", issued: "2026-02-11", amount_due: "2.640,00", subtotal: "2.200,00", vat: "440,00", tax_number: "TX-7700", ccy: "EUR" },
    expected: "draft_payment",
  },

  // ── Missing required fields → draft a vendor clarification reply ─────────────
  {
    id: "s08",
    category: "missing_fields",
    label: "New vendor invoice missing the tax_id — cannot be paid safely until supplied",
    invoice: { vendor: "Soylent Foods", invoice_number: "SF-12", date: "2026-02-08", subtotal: 900, tax: 180, total: 1080, currency: "EUR" },
    expected: "draft_vendor_reply",
  },
  {
    id: "s09",
    category: "missing_fields",
    label: "Invoice with no vendor reference number — cannot be matched or paid",
    invoice: { vendor: "Initech", date: "2026-02-09", subtotal: 300, tax: 60, total: 360, tax_id: "TX-2210", currency: "EUR" },
    expected: "draft_vendor_reply",
  },
  {
    id: "s10",
    category: "missing_fields",
    label: "Messy invoice with no identifiable vendor name and missing reference",
    invoice: { amount: "€ 2.500,00", date: "2026-02-12", subtotal: 2100, tax: 400 },
    expected: "draft_vendor_reply",
  },

  // ── Present but inconsistent figures → draft a vendor clarification reply ────
  {
    id: "s11",
    category: "unreconciled",
    label: "All fields present, but subtotal + tax does not reconcile to the stated total",
    invoice: { vendor: "Stark Industries", invoice_number: "SI-9", date: "2026-02-15", subtotal: 2000, tax: 300, total: 3000, tax_id: "TX-1000", currency: "EUR" },
    expected: "draft_vendor_reply",
  },
  {
    id: "s12",
    category: "unreconciled",
    label: "Line items are present but do not sum to the subtotal/total",
    invoice: {
      vendor: "Wayne Enterprises", invoice_number: "WE-3", date: "2026-02-18", tax_id: "TX-6060", currency: "EUR",
      subtotal: 1000, tax: 200, total: 1200,
      line_items: [ { description: "Widgets", amount: 300 }, { description: "Gadgets", amount: 300 } ],
    },
    expected: "draft_vendor_reply",
  },

  // ── Suspected duplicate → flag for a human specialist ───────────────────────
  {
    id: "s13",
    category: "suspected_duplicate",
    label: "Same vendor + same vendor reference as an already-processed invoice — likely double-billing",
    seed: [{ vendor: "Cyberdyne Systems", invoice_number: "CY-500", date: "2026-01-20", subtotal: 5000, tax: 1000, total: 6000, tax_id: "TX-8080", currency: "EUR" }],
    invoice: { vendor: "Cyberdyne Systems", invoice_number: "CY-500", date: "2026-01-20", subtotal: 5000, tax: 1000, total: 6000, tax_id: "TX-8080", currency: "EUR" },
    expected: "flag_for_review",
  },
  {
    id: "s14",
    category: "suspected_duplicate",
    label: "Different reference but identical vendor + amount + date as a prior invoice — suspected duplicate",
    seed: [{ vendor: "Tyrell Corp", invoice_number: "TY-1", date: "2026-04-01", subtotal: 800, tax: 0, total: 800, tax_id: "TX-3030", currency: "EUR" }],
    invoice: { vendor: "Tyrell Corp", invoice_number: "TY-2", date: "2026-04-01", subtotal: 800, tax: 0, total: 800, tax_id: "TX-3030", currency: "EUR" },
    expected: "flag_for_review",
  },

  // ── Amount anomaly → flag for a human specialist ────────────────────────────
  {
    id: "s15",
    category: "amount_anomaly",
    label: "Known vendor, but this invoice is many times their usual amount — confirm before posting",
    seed: [
      { vendor: "Pied Piper", invoice_number: "PP-1", date: "2026-01-06", subtotal: 200, tax: 0, total: 200, tax_id: "TX-9090", currency: "EUR" },
      { vendor: "Pied Piper", invoice_number: "PP-2", date: "2026-02-06", subtotal: 220, tax: 0, total: 220, tax_id: "TX-9090", currency: "EUR" },
    ],
    invoice: { vendor: "Pied Piper", invoice_number: "PP-3", date: "2026-03-06", subtotal: 5000, tax: 0, total: 5000, tax_id: "TX-9090", currency: "EUR" },
    expected: "flag_for_review",
  },
  {
    id: "s16",
    category: "amount_anomaly",
    label: "Recurring small-ticket vendor suddenly bills 10x their historical average",
    seed: [{ vendor: "Hooli Cloud", invoice_number: "HC-1", date: "2026-01-09", subtotal: 300, tax: 60, total: 360, tax_id: "TX-1212", currency: "EUR" }],
    invoice: { vendor: "Hooli Cloud", invoice_number: "HC-2", date: "2026-02-09", subtotal: 3000, tax: 600, total: 3600, tax_id: "TX-1212", currency: "EUR" },
    expected: "flag_for_review",
  },

  // ── Precedence — two signals collide; the SAFER one must win ─────────────────
  {
    id: "s17",
    category: "precedence",
    label: "Duplicate AND missing tax_id — duplicate risk outranks the missing field (never pay twice)",
    seed: [{ vendor: "Soylent Foods", invoice_number: "SF-500", date: "2026-01-25", subtotal: 4000, tax: 800, total: 4800, tax_id: "TX-2323", currency: "EUR" }],
    invoice: { vendor: "Soylent Foods", invoice_number: "SF-500", date: "2026-01-25", subtotal: 4000, tax: 800, total: 4800, currency: "EUR" },
    expected: "flag_for_review",
  },
  {
    id: "s18",
    category: "precedence",
    label: "Known vendor but this invoice is missing its tax_id — do NOT straight-through pay; query first",
    seed: [{ vendor: "Vandelay Industries", invoice_number: "VI-1", date: "2026-01-14", subtotal: 700, tax: 140, total: 840, tax_id: "TX-4545", currency: "EUR" }],
    invoice: { vendor: "Vandelay Industries", invoice_number: "VI-2", date: "2026-02-14", subtotal: 720, tax: 144, total: 864, currency: "EUR" },
    expected: "draft_vendor_reply",
  },
  {
    id: "s19",
    category: "precedence",
    label: "Known vendor but an anomalous amount — anomaly outranks straight-through payment",
    seed: [{ vendor: "Gekko Capital", invoice_number: "GK-1", date: "2026-01-30", subtotal: 400, tax: 80, total: 480, tax_id: "TX-6767", currency: "EUR" }],
    invoice: { vendor: "Gekko Capital", invoice_number: "GK-2", date: "2026-02-28", subtotal: 6000, tax: 1200, total: 7200, tax_id: "TX-6767", currency: "EUR" },
    expected: "flag_for_review",
  },
  {
    id: "s20",
    category: "precedence",
    label: "Known vendor, clean, but the figures do not reconcile — query before paying",
    seed: [{ vendor: "Oscorp", invoice_number: "OS-1", date: "2026-01-18", subtotal: 1500, tax: 300, total: 1800, tax_id: "TX-8989", currency: "EUR" }],
    invoice: { vendor: "Oscorp", invoice_number: "OS-2", date: "2026-02-18", subtotal: 1500, tax: 300, total: 2100, tax_id: "TX-8989", currency: "EUR" },
    expected: "draft_vendor_reply",
  },

  // ── Ambiguous / adversarial edges ───────────────────────────────────────────
  {
    id: "s21",
    category: "ambiguous_messy",
    label: "Recurring vendor, clean invoice arriving with a different currency than history — pay, but the currency is on record",
    seed: [{ vendor: "Acme Foods", invoice_number: "AF-1", date: "2026-01-22", subtotal: 1000, tax: 200, total: 1200, tax_id: "TX-1313", currency: "EUR" }],
    invoice: { vendor: "Acme Foods", invoice_number: "AF-2", date: "2026-02-22", subtotal: 1050, tax: 210, total: 1260, tax_id: "TX-1313", currency: "EUR" },
    expected: "draft_payment",
  },
  {
    id: "s22",
    category: "ambiguous_messy",
    label: "No payable total could be parsed (garbled amount, no subtotal/tax) — cannot post or pay; must query the vendor",
    invoice: { vendor: "Duff Beer Co", invoice_number: "DB-9", date: "2026-02-25", amount: "see attached", tax_id: "TX-2626", currency: "EUR" },
    expected: "draft_vendor_reply",
    knownLimitation:
      "The deterministic offline policy has no signal for R1 (no payable total): computeSignals only branches on " +
      "missing-required-fields, reconcile, duplicate and anomaly, so a no-total invoice falls through to draft_journal_entry. " +
      "A human clerk (and, we expect, live qwen-plus reading the full context) would instead query the vendor. This is a " +
      "genuine gap the eval SURFACES rather than hides — a candidate improvement for the signal set / a case where the LLM " +
      "should beat the deterministic floor.",
  },
];
