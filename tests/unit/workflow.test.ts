// Unit — the workflow state machine + approval gate on the AutopilotAgent, fully
// offline (FakeEmbedder + InMemoryStore + FakeQwenChatClient + Fake sinks). This
// is where the Track-4 "recommend, never auto-execute" contract is enforced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultDecider } from "../../src/ap/decider.js";
import { fakeSinks, type Sinks } from "../../src/ap/sinks.js";
import { AutopilotAgent, ConflictError, NotFoundError } from "../../src/agents/autopilot-agent.js";

function makeAgent(): { agent: AutopilotAgent; sinks: Sinks; memory: InMemoryStore } {
  const memory = new InMemoryStore();
  const sinks = fakeSinks();
  const agent = new AutopilotAgent(new FakeEmbedder(), memory, new InMemoryWorkItemStore(), defaultDecider(), sinks);
  return { agent, sinks, memory };
}

const cleanInvoice = { vendor: "Acme", invoice_number: "A-1", tax_id: "T", subtotal: 100, tax: 20, total: 120, date: "2026-01-01" };

test("intake produces a PENDING work item and executes NOTHING (the gate)", async () => {
  const { agent, sinks } = makeAgent();
  const item = await agent.intake(cleanInvoice);
  assert.equal(item.status, "pending");
  assert.ok(item.proposed.tool);
  assert.equal(item.execution, undefined);
  // No side-effect has fired yet — the proposal only recommends.
  assert.equal(sinks.ledger.entries().length, 0);
  assert.equal(sinks.payments.payments().length, 0);
  const queue = await agent.pending();
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.id, item.id);
});

test("approve executes the tool and moves the item to approved", async () => {
  const { agent, sinks } = makeAgent();
  const item = await agent.intake(cleanInvoice);
  const approved = await agent.approve(item.id);
  assert.equal(approved.status, "approved");
  assert.ok(approved.execution?.ok);
  assert.equal(sinks.ledger.entries().length, 1); // journal entry executed for real
  assert.equal((await agent.pending()).length, 0); // left the queue
});

test("approve writes the outcome BACK to memory (the agent gets smarter)", async () => {
  const { agent, memory } = makeAgent();
  const before = await memory.count();
  const item = await agent.intake(cleanInvoice);
  await agent.approve(item.id);
  const after = await memory.count();
  // intake wrote the invoice memory; approve wrote an action memory on top.
  assert.ok(after > before + 1);
  const hits = await memory.recall(await new FakeEmbedder().embed("Acme approved action"), { kind: "action" });
  assert.ok(hits.length >= 1);
});

test("the approval gate: a decided item cannot be acted on again (409 → ConflictError)", async () => {
  const { agent } = makeAgent();
  const item = await agent.intake(cleanInvoice);
  await agent.approve(item.id);
  await assert.rejects(() => agent.approve(item.id), ConflictError);
  await assert.rejects(() => agent.reject(item.id), ConflictError);
  await assert.rejects(() => agent.amend(item.id, {}), ConflictError);
});

test("an unknown work item id raises NotFoundError (404)", async () => {
  const { agent } = makeAgent();
  await assert.rejects(() => agent.approve("does-not-exist"), NotFoundError);
  await assert.rejects(() => agent.get("does-not-exist"), NotFoundError);
});

test("reject discards the proposal — nothing executes — and remembers the rejection", async () => {
  const { agent, sinks, memory } = makeAgent();
  const item = await agent.intake(cleanInvoice);
  const rejected = await agent.reject(item.id, "Not authorised this quarter.");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.decisionReason, "Not authorised this quarter.");
  assert.equal(sinks.ledger.entries().length, 0);
  const hits = await memory.recall(await new FakeEmbedder().embed("rejected by a human"), { kind: "insight" });
  assert.ok(hits.length >= 1);
});

test("amend edits ONLY the domain args, and the amended args are EXACTLY what execute", async () => {
  const { agent, sinks } = makeAgent();
  const item = await agent.intake(cleanInvoice); // proposes draft_journal_entry for a clean new vendor
  assert.equal(item.proposed.tool, "draft_journal_entry");
  const amended = await agent.amend(item.id, { args: { expense_account: "Professional Fees", amount: 120 }, reason: "reclassified account" });
  assert.equal(amended.status, "approved");
  assert.equal(amended.amended, true);
  assert.equal(amended.decisionReason, "reclassified account");
  // The ledger reflects the AMENDED account — the human approved exactly what ran.
  const entry = sinks.ledger.entries()[0]!;
  assert.equal(entry.lines.find((l) => l.debit)!.account, "Professional Fees");
});

test("memory-grounded duplicate detection across two intakes → flag_for_review", async () => {
  const { agent } = makeAgent();
  const first = await agent.intake(cleanInvoice);
  await agent.approve(first.id);
  // Same vendor + same vendor_ref, different work item → recalled as a duplicate.
  const second = await agent.intake({ ...cleanInvoice });
  assert.equal(second.proposed.tool, "flag_for_review");
  assert.ok(second.findings.some((f) => f.rule === "R5" && !f.passed));
});
