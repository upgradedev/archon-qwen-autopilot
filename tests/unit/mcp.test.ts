// Unit — the MCP tool dispatch (callAutopilotTool) over a Fake-wired agent. Proves
// the AP workflow AND its human-in-the-loop gate hold when driven through the MCP
// surface, fully offline (FakeEmbedder + InMemoryStore + FakeQwenChatClient + Fake
// sinks). The integration test (mcp-transport.test.ts) exercises the same behaviour
// through a real MCP Client ↔ Server pair; this file drives the dispatch directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks, type Sinks } from "../../src/ap/sinks.js";
import { AutopilotAgent } from "../../src/agents/autopilot-agent.js";
import { callAutopilotTool } from "../../src/mcp/server.js";

// Force the offline Fake even if a maintainer has DASHSCOPE_API_KEY exported.
delete process.env.DASHSCOPE_API_KEY;

function makeAgent(): { agent: AutopilotAgent; sinks: Sinks } {
  const sinks = fakeSinks();
  const agent = new AutopilotAgent(new FakeEmbedder(), new InMemoryStore(), new InMemoryWorkItemStore(), defaultLoop(), sinks);
  return { agent, sinks };
}

// Parse the JSON text payload an ok() tool result carries.
function payload(res: any): any {
  const text = res.content[0]?.text ?? "";
  return JSON.parse(text);
}
// The text of the first content block (tool results are text in this server).
function firstText(res: any): string {
  return String(res.content[0]?.text ?? "");
}

const cleanInvoice = { vendor: "Acme", invoice_number: "A-1", tax_id: "T", subtotal: 100, tax: 20, total: 120, date: "2026-01-01" };

test("intake_invoice → PENDING with a trace, and NOTHING executes (the gate over MCP)", async () => {
  const { agent, sinks } = makeAgent();
  const res = await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice });
  assert.equal(res.isError ?? false, false);
  const item = payload(res);
  assert.equal(item.status, "pending");
  assert.ok(item.id, "the work-item id must be returned so it can be approved");
  assert.ok(item.proposed.tool, "a terminal action is proposed");
  assert.ok(Array.isArray(item.trace) && item.trace.length >= 2, "the full step trace is returned");
  assert.equal(item.execution, undefined);
  // Every sink is still empty — intake recommends, it never acts.
  assert.equal(sinks.ledger.entries().length, 0);
  assert.equal(sinks.payments.payments().length, 0);
  assert.equal(sinks.email.outbox().length, 0);
  assert.equal(sinks.reviews.escalations().length, 0);
});

test("intake → list_pending → approve round-trip through the MCP surface", async () => {
  const { agent, sinks } = makeAgent();
  const intake = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));

  const queue = payload(await callAutopilotTool(agent, "list_pending", {}));
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].id, intake.id);
  // Still nothing executed just by listing.
  assert.equal(sinks.ledger.entries().length, 0);

  const approved = payload(await callAutopilotTool(agent, "approve", { id: intake.id }));
  assert.equal(approved.status, "approved");
  assert.ok(approved.execution.ok);
  assert.equal(sinks.ledger.entries().length, 1, "approve executed the terminal skill for real");
  const after = payload(await callAutopilotTool(agent, "list_pending", {}));
  assert.equal(after.pending.length, 0, "the item left the queue");
});

test("the gate is OBSERVABLE over MCP: re-approving a decided item returns isError", async () => {
  const { agent } = makeAgent();
  const intake = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));
  await callAutopilotTool(agent, "approve", { id: intake.id });

  const again = await callAutopilotTool(agent, "approve", { id: intake.id });
  assert.equal(again.isError, true, "a decided item can never re-execute");
  const reReject = await callAutopilotTool(agent, "reject", { id: intake.id });
  assert.equal(reReject.isError, true);
  const reAmend = await callAutopilotTool(agent, "amend", { id: intake.id, args: {} });
  assert.equal(reAmend.isError, true);
});

test("an unknown id returns isError (404 → not found), not a false success", async () => {
  const { agent } = makeAgent();
  const res = await callAutopilotTool(agent, "approve", { id: "does-not-exist" });
  assert.equal(res.isError, true);
  assert.match(firstText(res), /not found/i);
});

test("amend over MCP: the amended args are EXACTLY what execute", async () => {
  const { agent, sinks } = makeAgent();
  const intake = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));
  assert.equal(intake.proposed.tool, "draft_journal_entry");
  const amended = payload(
    await callAutopilotTool(agent, "amend", { id: intake.id, args: { expense_account: "Professional Fees", amount: 120 }, reason: "reclassified" })
  );
  assert.equal(amended.status, "approved");
  assert.equal(amended.amended, true);
  const entry = sinks.ledger.entries()[0]!;
  assert.equal(entry.lines.find((l) => l.debit)!.account, "Professional Fees");
});

test("recall_vendor surfaces a vendor's remembered history (read-only, no execution)", async () => {
  const { agent, sinks } = makeAgent();
  // Intake + approve one invoice so the vendor's history is written to memory.
  const first = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));
  await callAutopilotTool(agent, "approve", { id: first.id });
  const ledgerBefore = sinks.ledger.entries().length;

  const recalled = payload(await callAutopilotTool(agent, "recall_vendor", { vendor: "Acme" }));
  assert.equal(recalled.vendor, "Acme");
  assert.ok(Array.isArray(recalled.recalled) && recalled.recalled.length >= 1, "recall returns remembered facts");
  // recall_vendor is read-only — it fires no sink.
  assert.equal(sinks.ledger.entries().length, ledgerBefore);
});

test("list_skills returns the custom-skills catalog", async () => {
  const { agent } = makeAgent();
  const cat = payload(await callAutopilotTool(agent, "list_skills", {}));
  assert.equal(cat.kind, "custom-skills");
  assert.ok(cat.skills.some((s: any) => s.name === "draft_payment" && s.gate === "human-gated"));
  assert.ok(cat.skills.some((s: any) => s.name === "recall_vendor_history" && s.gate === "autonomous"));
});

test("a bad intake payload returns isError, not a thrown crash", async () => {
  const { agent } = makeAgent();
  const res = await callAutopilotTool(agent, "intake_invoice", {});
  assert.equal(res.isError, true);
});
