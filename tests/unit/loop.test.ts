// Unit — the bounded multi-step ReAct loop (AutopilotLoop). The loop drives Qwen
// function-calling in a genuine observe→decide→act cycle: it runs autonomous
// read/analyze tools (no side-effect) until the model chooses ONE terminal action,
// with guards (max-steps + no-progress) that fall back to a safe flag_for_review.
// We drive it three ways:
//   1. the offline FakeQwenChatClient (the exact seam CI uses), asserting the
//      multi-step trajectory + terminal choice per branch,
//   2. a canned client, asserting the tool-call PARSE path (args JSON parsed,
//      reasoning/confidence lifted out of the domain args — the HITL guarantee), and
//   3. pathological clients, asserting the loop-guard fallbacks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AutopilotLoop, defaultLoop } from "../../src/ap/loop.js";
import { FakeQwenChatClient } from "../../src/ap/fake-chat.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { AutopilotAgent } from "../../src/agents/autopilot-agent.js";
import { normalizeInvoice } from "../../src/ap/normalize.js";
import type {
  ChatCreateArgs,
  ChatResponse,
  QwenChatClient,
  ToolCall,
} from "../../src/qwen/client.js";
import type { LoopStopReason } from "../../src/types.js";

delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes

function loopDeps() {
  return { embedder: new FakeEmbedder(), memory: new InMemoryStore() };
}

// A client that returns a fixed sequence of tool calls, one per step.
function scriptedClient(calls: ToolCall[]): QwenChatClient {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (_args: ChatCreateArgs): Promise<ChatResponse> => {
          const call = calls[Math.min(i, calls.length - 1)]!;
          i++;
          return { choices: [{ message: { content: null, tool_calls: [call] } }] };
        },
      },
    },
  };
}
function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { function: { name, arguments: JSON.stringify(args) } };
}

test("clean new vendor: the loop recalls + validates (≥2 autonomous steps), then proposes draft_journal_entry", async () => {
  const loop = new AutopilotLoop(new FakeQwenChatClient());
  const invoice = normalizeInvoice({ vendor: "NewCo", invoice_number: "N-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 });
  const res = await loop.run({ invoice, ...loopDeps() });

  assert.equal(res.stopReason, "terminal_action");
  assert.equal(res.proposed.tool, "draft_journal_entry");
  assert.ok(res.proposed.confidence > 0);
  // The trace is a real multi-step record, recall FIRST.
  assert.ok(res.trace.length >= 2, `expected ≥2 autonomous steps, got ${res.trace.length}`);
  assert.equal(res.trace[0]!.tool, "recall_vendor_history");
  assert.ok(res.trace.some((t) => t.tool === "validate_invoice"));
  // Structural findings were produced BY the validate step and carried out.
  assert.ok(res.findings.some((f) => f.rule === "R1"));
});

test("onStep streams each autonomous step live, once per trace step, before the terminal action", async () => {
  const streamed: string[] = [];
  const loop = new AutopilotLoop(new FakeQwenChatClient());
  const invoice = normalizeInvoice({ vendor: "StreamCo", invoice_number: "S-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 });
  const res = await loop.run({ invoice, ...loopDeps(), onStep: (s) => streamed.push(s.tool) });

  // The observer fired exactly once per persisted trace step, in order — this is the
  // SSE stream's contract. It is a pure observer: the decision is unchanged.
  assert.equal(streamed.length, res.trace.length);
  assert.deepEqual(streamed, res.trace.map((t) => t.tool));
  assert.equal(streamed[0], "recall_vendor_history");
  assert.equal(res.stopReason, "terminal_action");
});

test("known/recurring vendor: the loop computes variance before proposing draft_payment", async () => {
  // Seed the vendor's history through a full intake so it lands in memory.
  const memory = new InMemoryStore();
  const embedder = new FakeEmbedder();
  const agent = new AutopilotAgent(embedder, memory, new InMemoryWorkItemStore(), defaultLoop(), fakeSinks());
  await agent.intake({ vendor: "KnownCo", invoice_number: "K-1", tax_id: "T", subtotal: 100, tax: 20, total: 120, date: "2026-01-01" });
  await agent.approve((await agent.pending())[0]!.id);

  const item = await agent.intake({ vendor: "KnownCo", invoice_number: "K-2", tax_id: "T", subtotal: 110, tax: 22, total: 132, date: "2026-02-01" });
  assert.equal(item.proposed.tool, "draft_payment");
  assert.ok(item.trace.some((t) => t.tool === "compute_variance_vs_history"));
  assert.equal(item.stopReason, "terminal_action");
});

test("suspected duplicate: the loop confirms via check_duplicate, then flags for review", async () => {
  const memory = new InMemoryStore();
  const embedder = new FakeEmbedder();
  const agent = new AutopilotAgent(embedder, memory, new InMemoryWorkItemStore(), defaultLoop(), fakeSinks());
  const dup = { vendor: "Dup", invoice_number: "D-1", tax_id: "T", subtotal: 400, tax: 100, total: 500, date: "2026-01-01" };
  const first = await agent.intake(dup);
  await agent.approve(first.id);

  const second = await agent.intake({ ...dup });
  assert.equal(second.proposed.tool, "flag_for_review");
  assert.ok(second.trace.some((t) => t.tool === "check_duplicate"));
  assert.ok(second.findings.some((f) => f.rule === "R5" && !f.passed));
});

test("missing required fields → draft_vendor_reply", async () => {
  const loop = new AutopilotLoop(new FakeQwenChatClient());
  const invoice = normalizeInvoice({ supplier: "MessyCo", subtotal: 2000, tax: 300, total: 3000 }); // no vendor_ref / tax_id + reconcile fail
  const res = await loop.run({ invoice, ...loopDeps() });
  assert.equal(res.proposed.tool, "draft_vendor_reply");
});

test("parse path: a terminal tool_call is parsed and reasoning/confidence are lifted out of the domain args", async () => {
  const client = scriptedClient([
    toolCall("draft_journal_entry", { expense_account: "Office Supplies", amount: 120, reasoning: "clean invoice", confidence: 0.91 }),
  ]);
  const loop = new AutopilotLoop(client);
  const invoice = normalizeInvoice({ vendor: "A", invoice_number: "1", tax_id: "T", total: 120 });
  const res = await loop.run({ invoice, ...loopDeps() });
  assert.equal(res.proposed.tool, "draft_journal_entry");
  assert.equal(res.proposed.reasoning, "clean invoice");
  assert.equal(res.proposed.confidence, 0.91);
  // The domain args a human will approve must NOT contain the meta-fields.
  assert.deepEqual(res.proposed.args, { expense_account: "Office Supplies", amount: 120 });
  assert.equal(res.stopReason, "terminal_action");
});

test("parse path: terminal confidence is clamped to [0,1]", async () => {
  const client = scriptedClient([toolCall("flag_for_review", { reason: "x", confidence: 5 })]);
  const loop = new AutopilotLoop(client);
  const invoice = normalizeInvoice({ vendor: "A", invoice_number: "1", tax_id: "T", total: 1 });
  const res = await loop.run({ invoice, ...loopDeps() });
  assert.equal(res.proposed.confidence, 1);
});

test("loop guard: max-steps cap falls back to a safe flag_for_review", async () => {
  const reasons: LoopStopReason[] = [];
  // maxSteps=2 is too small for a clean new vendor (recall + validate + terminal = 3),
  // so the loop exhausts the budget without a terminal action → deterministic fallback.
  const loop = new AutopilotLoop(new FakeQwenChatClient(), "qwen-plus", { maxSteps: 2, onStop: (r) => reasons.push(r) });
  const invoice = normalizeInvoice({ vendor: "NewCo", invoice_number: "N-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 });
  const res = await loop.run({ invoice, ...loopDeps() });
  assert.equal(res.stopReason, "max_steps_fallback");
  assert.equal(res.proposed.tool, "flag_for_review");
  assert.equal(res.proposed.confidence, 0);
  assert.ok(res.trace.length <= 2);
  assert.deepEqual(reasons, ["max_steps_fallback"]);
});

test("loop guard: a model that never terminates (repeats a read) falls back on no-progress", async () => {
  const reasons: LoopStopReason[] = [];
  const stuck = scriptedClient([toolCall("recall_vendor_history", { reasoning: "again and again" })]);
  const loop = new AutopilotLoop(stuck, "qwen-plus", { onStop: (r) => reasons.push(r) });
  const invoice = normalizeInvoice({ vendor: "A", invoice_number: "1", tax_id: "T", total: 1 });
  const res = await loop.run({ invoice, ...loopDeps() });
  assert.equal(res.stopReason, "no_progress_fallback");
  assert.equal(res.proposed.tool, "flag_for_review");
  assert.equal(reasons[0], "no_progress_fallback");
});

test("loop guard: an unparseable/no tool call also falls back safely", async () => {
  const reasons: LoopStopReason[] = [];
  const noCall: QwenChatClient = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "I'm not sure." } }] }) } },
  };
  const loop = new AutopilotLoop(noCall, "qwen-plus", { onStop: (r) => reasons.push(r) });
  const invoice = normalizeInvoice({ vendor: "A", invoice_number: "1", tax_id: "T", total: 1 });
  const res = await loop.run({ invoice, ...loopDeps() });
  assert.equal(res.stopReason, "no_progress_fallback");
  assert.equal(res.proposed.tool, "flag_for_review");
});
