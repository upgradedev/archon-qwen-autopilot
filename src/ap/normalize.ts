// Invoice normalizer — the "ambiguous input" front door.
//
// Real invoices arrive as messy JSON: alternate key spellings, amounts as
// strings with currency symbols and thousands separators, missing fields, and
// line items that may or may not sum to the stated total. This module coerces a
// RawInvoice into a NormalizedInvoice with nullable fields, filling gaps where it
// safely can and recording every coercion/inference in `notes` so a reviewer sees
// exactly how messy the source was. It never throws — a totally empty payload
// still yields a NormalizedInvoice (with an id) that validation can flag.

import { randomUUID } from "node:crypto";
import type { LineItem, NormalizedInvoice, RawInvoice } from "../types.js";

// Accepted aliases for each canonical field. First present, non-empty wins.
const ALIASES: Record<string, string[]> = {
  invoice_id: ["invoice_id", "id", "invoiceId"],
  vendor: ["vendor", "supplier", "vendor_name", "supplier_name", "from", "payee"],
  vendor_ref: ["vendor_ref", "invoice_number", "invoiceNo", "invoice_no", "number", "ref", "reference"],
  invoice_date: ["invoice_date", "date", "issued", "issue_date", "issued_at"],
  currency: ["currency", "ccy"],
  subtotal: ["subtotal", "net", "net_amount", "amount_excl_tax", "pre_tax"],
  tax: ["tax", "tax_amount", "vat", "vat_amount", "tax_total"],
  tax_id: ["tax_id", "tax_number", "tax_reg", "vendor_tax_id", "registration"],
  total: ["total", "amount", "grand_total", "amount_due", "gross", "total_amount"],
};

export function normalizeInvoice(raw: RawInvoice): NormalizedInvoice {
  const notes: string[] = [];
  const src = raw ?? {};

  const invoiceId = pickString(src, ALIASES.invoice_id!);
  const invoice_id = invoiceId ?? `inv-${randomUUID().slice(0, 8)}`;
  if (!invoiceId) notes.push("invoice_id missing — generated a synthetic id");

  const vendor = pickString(src, ALIASES.vendor!);
  if (!vendor) notes.push("vendor name missing");

  const vendor_ref = pickString(src, ALIASES.vendor_ref!);
  if (!vendor_ref) notes.push("vendor invoice number (vendor_ref) missing");

  const invoice_date = normalizeDate(pickString(src, ALIASES.invoice_date!), notes);

  let currency = pickString(src, ALIASES.currency!);
  if (!currency) {
    currency = "EUR";
    notes.push("currency missing — defaulted to EUR");
  } else {
    currency = currency.toUpperCase();
  }

  const subtotal = pickAmount(src, ALIASES.subtotal!, "subtotal", notes);
  const tax = pickAmount(src, ALIASES.tax!, "tax", notes);
  const tax_id = pickString(src, ALIASES.tax_id!);
  if (!tax_id) notes.push("vendor tax_id missing");
  let total = pickAmount(src, ALIASES.total!, "total", notes);

  const line_items = normalizeLineItems(src["line_items"] ?? src["lines"] ?? src["items"], notes);

  // If total is absent but subtotal + tax are present, infer it (and note it).
  if (total == null && subtotal != null && tax != null) {
    total = round2(subtotal + tax);
    notes.push(`total inferred from subtotal + tax = ${total}`);
  }
  // If subtotal is absent but total + tax are present, infer it.
  let sub = subtotal;
  if (sub == null && total != null && tax != null) {
    sub = round2(total - tax);
    notes.push(`subtotal inferred from total - tax = ${sub}`);
  }

  return {
    invoice_id,
    vendor,
    vendor_ref,
    invoice_date,
    currency,
    subtotal: sub,
    tax,
    tax_id,
    total,
    line_items,
    notes,
    raw: src,
  };
}

function pickString(src: RawInvoice, keys: string[]): string | null {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

// Parse an amount that may arrive as a number, or a string like "€1,234.50",
// "1.234,50" (EU grouping), or "USD 900". Returns null when unparseable.
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.replace(/[^\d.,-]/g, "").trim();
  if (s === "" || s === "-") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Comma is the decimal separator (EU style): strip dots, comma → dot.
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Dot is the decimal separator (or no decimals): strip grouping commas.
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pickAmount(
  src: RawInvoice,
  keys: string[],
  label: string,
  notes: string[]
): number | null {
  for (const k of keys) {
    if (!(k in src)) continue;
    const raw = src[k];
    const n = parseAmount(raw);
    if (n != null) {
      if (typeof raw === "string") notes.push(`${label} "${raw}" parsed as ${n}`);
      return round2(n);
    }
    if (raw != null && raw !== "") notes.push(`${label} value ${JSON.stringify(raw)} was unparseable`);
  }
  return null;
}

function normalizeDate(value: string | null, notes: string[]): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    notes.push(`invoice_date "${value}" was unparseable`);
    return null;
  }
  return new Date(t).toISOString().slice(0, 10);
}

function normalizeLineItems(value: unknown, notes: string[]): LineItem[] {
  if (!Array.isArray(value)) return [];
  const items: LineItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry == null) continue;
    const e = entry as Record<string, unknown>;
    items.push({
      description: pickString(e, ["description", "desc", "name", "item"]) ?? "(no description)",
      quantity: parseAmount(e["quantity"] ?? e["qty"]),
      unit_price: parseAmount(e["unit_price"] ?? e["price"] ?? e["rate"]),
      amount: parseAmount(e["amount"] ?? e["total"] ?? e["line_total"]),
    });
  }
  if (items.length === 0 && value.length > 0) {
    notes.push("line_items present but none were parseable");
  }
  return items;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
