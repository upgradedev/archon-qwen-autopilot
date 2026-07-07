// Relevance gate for an uploaded document — "is this actually a financial /
// invoice-type document, or did someone upload a random image?"
//
// Derived purely from the EXISTING structured vision extraction — no extra model
// call, no key, no network — so it runs offline in CI exactly like the extractor's
// own Fake. The reasoning: an invoice the vision model actually read yields the core
// financial signals (a monetary amount plus a vendor or an invoice number); a random
// photo / irrelevant file yields none of them, or the model reports very low
// confidence. When the signals are absent we mark it not-relevant WITH a reason, so
// the human sees "this doesn't look like an invoice" — but we never hard-reject; the
// person still decides.
//
// Positioning: universal financial-document terms only (vendor, invoice number,
// amount, total) — no locale, language, or national-scheme reference.

import type { RawInvoice } from "../types.js";

export interface RelevanceResult {
  relevant: boolean;
  reason: string; // always populated — explains the verdict either way
}

// Below this extractor-reported confidence we treat the read as untrustworthy even
// if a few fields came back — the model itself is signalling it did not really read
// an invoice. Overridable so the threshold is not a magic literal.
const MIN_CONFIDENCE = Number(process.env.RELEVANCE_MIN_CONFIDENCE || 0.3);

// Assess whether the extracted invoice looks like a genuine financial document.
// Pure + deterministic. Only reads the structured extraction — cheap by design.
export function assessRelevance(invoice: RawInvoice): RelevanceResult {
  const hasVendor = isPresentString(invoice["vendor"]);
  const hasRef = isPresentString(invoice["invoice_number"]);
  const hasAmount =
    isMoneyLike(invoice["total"]) || isMoneyLike(invoice["subtotal"]) || isMoneyLike(invoice["amount"]);
  const confidence = asFiniteNumber(invoice["confidence"]);

  // Nothing an invoice must have came back → almost certainly not an invoice.
  if (!hasVendor && !hasRef && !hasAmount) {
    return {
      relevant: false,
      reason: "no invoice fields were extracted (no vendor, invoice number, or amount) — this does not look like a financial document",
    };
  }

  // The extractor itself signalled it barely read anything.
  if (confidence != null && confidence < MIN_CONFIDENCE) {
    return {
      relevant: false,
      reason: `the extractor reported very low confidence (${confidence}) that this is a readable invoice`,
    };
  }

  // Some identity came back but no money figure at all — an invoice always states an
  // amount, so treat a total-less, subtotal-less document as not invoice-shaped.
  if (!hasAmount) {
    return {
      relevant: false,
      reason: "no invoice amount (total or subtotal) was detected — an invoice should state an amount payable",
    };
  }

  return { relevant: true, reason: "invoice fields detected (amount plus a vendor or invoice number)" };
}

function isPresentString(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : typeof v === "number" && Number.isFinite(v);
}

// An amount is "money-like" if it is a finite non-zero number, or a string that
// contains at least one digit (the normalizer parses "€1,234.50" later — here we only
// need to know a figure was present).
function isMoneyLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  if (typeof v === "string") return /\d/.test(v);
  return false;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
