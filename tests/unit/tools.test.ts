// Unit — the tool layer: each tool's schema is a well-formed OpenAI-compatible
// function (with the reasoning + confidence meta-fields), and each execute() stub
// produces the correct side-effect on the injected Fake sinks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, toolByName, toolDefs, META_FIELDS, assertValidToolArgs } from "../../src/ap/tools.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { normalizeInvoice } from "../../src/ap/normalize.js";

const inv = normalizeInvoice({ vendor: "Acme", invoice_number: "A-1", tax_id: "T", total: 1200, currency: "EUR" });

test("every tool exposes a valid function schema with reasoning + confidence", () => {
  assert.equal(TOOLS.length, 4);
  for (const t of TOOLS) {
    assert.equal(t.def.type, "function");
    assert.equal(t.def.function.name, t.name);
    const params = t.def.function.parameters as { properties: Record<string, unknown>; required: string[] };
    for (const meta of META_FIELDS) {
      assert.ok(meta in params.properties, `${t.name} schema should declare ${meta}`);
      assert.ok(params.required.includes(meta), `${t.name} should require ${meta}`);
    }
  }
});

test("toolDefs returns one def per tool; toolByName resolves and rejects unknowns", () => {
  assert.equal(toolDefs().length, 4);
  assert.ok(toolByName("draft_payment"));
  assert.equal(toolByName("nonexistent_tool"), undefined);
});

test("every tool executes with EMPTY args on a SPARSE invoice — the fallback defaults hold (no throw)", async () => {
  // The model may omit optional domain args; execute() must fall back to invoice-
  // derived or safe defaults rather than crash. A sparse invoice (no total, currency
  // or refs) exercises every `?? default` / `str(_, fallback)` / `num(_, inv.total ?? 0)`
  // branch — the "field absent" side the happy-path tests never take.
  const sparse = normalizeInvoice({ vendor: "" });
  for (const t of TOOLS) {
    const sinks = fakeSinks();
    const r = await t.execute({}, sparse, sinks);
    assert.equal(r.ok, true, `${t.name} should execute on a sparse invoice with empty args`);
    assert.ok(typeof r.summary === "string" && r.summary.length > 0, `${t.name} should summarize its effect`);
  }
});

test("draft_journal_entry posts a balanced debit/credit entry to the ledger", async () => {
  const sinks = fakeSinks();
  const r = await toolByName("draft_journal_entry")!.execute({ expense_account: "Office Supplies", amount: 1200 }, inv, sinks);
  assert.equal(r.ok, true);
  assert.equal(sinks.ledger.entries().length, 1);
  const entry = sinks.ledger.entries()[0]!;
  assert.equal(entry.lines.find((l) => l.debit)!.debit, 1200);
  assert.equal(entry.lines.find((l) => l.credit)!.credit, 1200);
});

test("draft_payment records a payment, falling back to the invoice total when amount is omitted", async () => {
  const sinks = fakeSinks();
  const r = await toolByName("draft_payment")!.execute({ vendor: "Acme" }, inv, sinks);
  assert.equal(r.ok, true);
  assert.equal(sinks.payments.payments().length, 1);
  assert.equal(sinks.payments.payments()[0]!.amount, 1200); // fell back to inv.total
});

test("draft_vendor_reply sends an email to the Fake outbox", async () => {
  const sinks = fakeSinks();
  await toolByName("draft_vendor_reply")!.execute({ subject: "Query", body: "Please confirm your tax id." }, inv, sinks);
  assert.equal(sinks.email.outbox().length, 1);
  assert.equal(sinks.email.outbox()[0]!.subject, "Query");
});

test("draft_vendor_reply accepts exactly one canonical mailbox and rejects recipient lists", () => {
  const base = { to: "billing@example.test", subject: "Invoice query", body: "Please confirm the missing invoice details." };
  assert.doesNotThrow(() => assertValidToolArgs("draft_vendor_reply", base, inv));
  for (const to of [
    "one@example.test,two@example.test",
    "one@example.test;two@example.test",
    "Vendor Billing <one@example.test>",
    "bad@@example.test",
    "one@localhost",
  ]) {
    assert.throws(
      () => assertValidToolArgs("draft_vendor_reply", { ...base, to }, inv),
      /exactly one canonical mailbox/i
    );
  }
});

test("flag_for_review raises an escalation and clamps an invalid priority to normal", async () => {
  const sinks = fakeSinks();
  await toolByName("flag_for_review")!.execute({ reason: "Suspected duplicate", priority: "bogus" }, inv, sinks);
  assert.equal(sinks.reviews.escalations().length, 1);
  assert.equal(sinks.reviews.escalations()[0]!.priority, "normal");
});
