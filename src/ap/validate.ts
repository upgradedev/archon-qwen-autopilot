// Invoice validation — the cross-check layer.
//
// Structural, memory-free checks over a NormalizedInvoice, in the spirit of the
// Archon R1..R4 consistency rules. Duplicate detection (which needs recalled
// memory) is layered on separately in the workflow — see detectDuplicate() below,
// which takes prior invoice facts and is called after memory recall. Keeping the
// structural rules pure makes them exhaustively unit-testable with no infra.
//
//   R1  amount sanity      — a positive, finite total is present
//   R2  required fields    — vendor, vendor_ref, date, currency and tax_id are present
//   R3  tax consistency     — subtotal + tax reconciles to total (within €0.01)
//   R4  line-item integrity — line items (if any) sum to the subtotal/total
//
// detectDuplicate() is the memory-grounded R-rule: same vendor + vendor_ref, or
// same vendor + total + date, already seen → a likely duplicate payment.

import type {
  NormalizedInvoice,
  RecalledFact,
  ValidationFinding,
} from "../types.js";
import { canonicalReference, canonicalVendorKey } from "./normalize.js";

const CENT = 0.01;

export function validateInvoice(inv: NormalizedInvoice): ValidationFinding[] {
  return [ruleAmountSanity(inv), ruleRequiredFields(inv), ruleTaxConsistency(inv), ruleLineItems(inv)];
}

// R1 — a positive, finite total must be present and sane.
function ruleAmountSanity(inv: NormalizedInvoice): ValidationFinding {
  if (inv.total == null) {
    return finding("R1", false, "error", "No payable total could be determined from the invoice.");
  }
  if (!Number.isFinite(inv.total) || inv.total <= 0) {
    return finding("R1", false, "error", `Total ${inv.total} is not a positive amount.`);
  }
  return finding("R1", true, "info", `Total ${money(inv.total, inv.currency)} is a positive amount.`);
}

// R2 — the fields needed to pay a vendor safely must be present.
function ruleRequiredFields(inv: NormalizedInvoice): ValidationFinding {
  const missing: string[] = [];
  if (!inv.vendor) missing.push("vendor");
  if (!inv.vendor_ref) missing.push("vendor_ref");
  if (!inv.invoice_date) missing.push("invoice_date");
  if (inv.currency === "UNKNOWN") missing.push("currency");
  if (!inv.tax_id) missing.push("tax_id");
  if (missing.length === 0) {
    return finding("R2", true, "info", "Vendor, vendor_ref, invoice_date, currency and tax_id are all present.");
  }
  return finding(
    "R2",
    false,
    "error",
    `Missing required field(s): ${missing.join(", ")}. A clarification is needed before paying.`
  );
}

// R3 — subtotal + tax must reconcile to the stated total.
function ruleTaxConsistency(inv: NormalizedInvoice): ValidationFinding {
  if (inv.subtotal == null || inv.tax == null || inv.total == null) {
    return finding("R3", true, "warn", "Tax reconciliation skipped — subtotal/tax/total not all present.");
  }
  const expected = round2(inv.subtotal + inv.tax);
  if (Math.abs(expected - inv.total) > CENT) {
    return finding(
      "R3",
      false,
      "warn",
      `subtotal ${inv.subtotal} + tax ${inv.tax} = ${expected} does not match total ${inv.total}.`
    );
  }
  return finding("R3", true, "info", "subtotal + tax reconciles to the total.");
}

// R4 — line items (when present) must sum to the subtotal or total.
function ruleLineItems(inv: NormalizedInvoice): ValidationFinding {
  if (inv.line_items.length === 0) {
    return finding("R4", true, "info", "No line items to reconcile.");
  }
  const amounts = inv.line_items.map((l) => l.amount).filter((a): a is number => a != null);
  if (amounts.length === 0) {
    return finding("R4", false, "warn", "Line items are present but none carry a reconcilable amount; human clarification is required.");
  }
  if (amounts.length !== inv.line_items.length) {
    return finding(
      "R4",
      false,
      "warn",
      `Only ${amounts.length} of ${inv.line_items.length} line items carry a reconcilable amount; the invoice is incomplete.`
    );
  }
  const sum = round2(amounts.reduce((s, a) => s + a, 0));
  const target = inv.subtotal ?? inv.total;
  if (target == null) {
    return finding("R4", true, "warn", `Line items sum to ${sum} but there is no subtotal/total to check against.`);
  }
  if (Math.abs(sum - target) > CENT) {
    return finding(
      "R4",
      false,
      "warn",
      `Line items sum to ${sum}, which does not match subtotal/total ${target}.`
    );
  }
  return finding("R4", true, "info", `Line items sum to ${sum}, matching the subtotal/total.`);
}

// R5 (memory-grounded) — duplicate detection over recalled prior-invoice facts.
// Deterministic exact-key match (never fuzzy cosine): same vendor + vendor_ref,
// or same vendor + total + date. Cosine recall surfaces the candidates; this
// exact check decides, so the result is stable offline (with FakeEmbedder too).
export function detectDuplicate(
  inv: NormalizedInvoice,
  priorInvoices: PriorInvoice[]
): ValidationFinding {
  for (const p of priorInvoices) {
    const sameVendor = !!inv.vendor && canonicalVendorKey(p.vendor) === canonicalVendorKey(inv.vendor);
    if (!sameVendor) continue;
    if (
      inv.vendor_ref &&
      p.vendorRef &&
      canonicalReference(p.vendorRef) === canonicalReference(inv.vendor_ref)
    ) {
      return finding(
        "R5",
        false,
        "error",
        `Likely DUPLICATE: ${inv.vendor} invoice ${inv.vendor_ref} was already processed (${p.invoiceId}).`
      );
    }
    if (
      inv.total != null &&
      p.total != null &&
      Math.abs(p.total - inv.total) <= CENT &&
      (!p.currency || p.currency === inv.currency) &&
      inv.invoice_date &&
      p.date &&
      p.date === inv.invoice_date
    ) {
      return finding(
        "R5",
        false,
        "error",
        `Suspected duplicate fingerprint: ${inv.vendor} already has an invoice for ${money(inv.total, inv.currency)} ` +
          `on ${inv.invoice_date} (${p.invoiceId}). Amount/date matches require human review; this does not merge the invoices.`
      );
    }
  }
  return finding("R5", true, "info", "No duplicate of a previously processed invoice was found.");
}

// R6 (memory-grounded) — amount anomaly vs the vendor's usual amount. Flags a
// total that is well outside the recalled historical range for this vendor.
export function detectAmountAnomaly(
  inv: NormalizedInvoice,
  priorInvoices: PriorInvoice[]
): ValidationFinding {
  if (inv.total == null) return finding("R6", true, "info", "No total to compare against vendor history.");
  const amounts = priorInvoices
    .filter(
      (p) =>
        !!inv.vendor &&
        canonicalVendorKey(p.vendor) === canonicalVendorKey(inv.vendor) &&
        (!p.currency || p.currency === inv.currency) &&
        p.total != null
    )
    .map((p) => p.total!) as number[];
  if (amounts.length === 0) {
    return finding("R6", true, "info", "New vendor — no prior amount history to compare against.");
  }
  const avg = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  if (avg > 0 && inv.total > avg * 3) {
    return finding(
      "R6",
      false,
      "warn",
      `Amount ${money(inv.total, inv.currency)} is more than 3x this vendor's usual ~${money(round2(avg), inv.currency)}.`
    );
  }
  return finding("R6", true, "info", `Amount is in line with this vendor's usual ~${money(round2(avg), inv.currency)}.`);
}

// A compact prior-invoice fact reconstructed from a recalled memory's metadata.
export interface PriorInvoice {
  invoiceId: string;
  vendor: string;
  vendorRef: string | null;
  total: number | null;
  date: string | null;
  currency?: string | null;
}

// Lift PriorInvoice facts out of recalled `invoice`-kind memories' metadata.
export function priorInvoicesFromRecall(hits: Array<{ metadata: Record<string, unknown> | null; content: string }>): PriorInvoice[] {
  const out: PriorInvoice[] = [];
  for (const h of hits) {
    const m = h.metadata;
    if (!m || typeof m !== "object") continue;
    if (typeof m["invoice_id"] !== "string") continue;
    out.push({
      invoiceId: m["invoice_id"] as string,
      vendor: typeof m["vendor"] === "string" ? (m["vendor"] as string) : "",
      vendorRef: typeof m["vendor_ref"] === "string" ? (m["vendor_ref"] as string) : null,
      total: typeof m["total"] === "number" ? (m["total"] as number) : null,
      date: typeof m["invoice_date"] === "string" ? (m["invoice_date"] as string) : null,
      currency: typeof m["currency"] === "string" ? (m["currency"] as string) : null,
    });
  }
  return out;
}

// True when any finding is a hard error (blocks straight-through processing).
export function hasBlockingError(findings: ValidationFinding[]): boolean {
  return findings.some((f) => !f.passed && f.severity === "error");
}

// projection helper reused by the workflow to show grounding to a reviewer.
export function toRecalledFact(h: { kind: string; score: number; content: string }): RecalledFact {
  return { kind: h.kind, score: Math.round(h.score * 1000) / 1000, content: h.content };
}

function finding(rule: string, passed: boolean, severity: ValidationFinding["severity"], message: string): ValidationFinding {
  return { rule, passed, severity, message };
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function money(n: number, currency: string): string {
  return `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
