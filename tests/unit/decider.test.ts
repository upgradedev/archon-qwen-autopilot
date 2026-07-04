// Unit — Qwen function-calling decision. The SINGLE QwenDecider parses a
// `tool_calls` response into a ProposedAction. We drive it two ways:
//   1. the offline FakeQwenChatClient (the exact seam CI uses), asserting each
//      decision branch, and
//   2. a hand-crafted canned client, asserting the tool-call PARSE path — args
//      JSON is parsed, and the reasoning/confidence meta-fields are lifted out of
//      the domain args (the HITL integrity guarantee: humans approve pure args).

import { test } from "node:test";
import assert from "node:assert/strict";
import { QwenDecider, computeSignals, buildUserPrompt } from "../../src/ap/decider.js";
import { FakeQwenChatClient } from "../../src/ap/fake-chat.js";
import { normalizeInvoice } from "../../src/ap/normalize.js";
import {
  detectAmountAnomaly,
  detectDuplicate,
  priorInvoicesFromRecall,
  validateInvoice,
  type PriorInvoice,
} from "../../src/ap/validate.js";
import type {
  ChatCreateArgs,
  ChatResponse,
  QwenChatClient,
  ToolCall,
} from "../../src/qwen/client.js";
import type { DecisionInput } from "../../src/ap/decider.js";

function decisionInput(raw: Record<string, unknown>, priors: PriorInvoice[] = [], knownVendor = false): DecisionInput {
  const invoice = normalizeInvoice(raw);
  const findings = validateInvoice(invoice);
  findings.push(detectDuplicate(invoice, priors));
  findings.push(detectAmountAnomaly(invoice, priors));
  return { invoice, findings, recalled: [], knownVendor };
}

// A canned client that returns a preset tool_calls response — lets us assert the
// decider's PARSE path directly, independent of the fake's branching policy.
function cannedClient(call: ToolCall): QwenChatClient {
  return {
    chat: {
      completions: {
        create: async (_args: ChatCreateArgs): Promise<ChatResponse> => ({
          choices: [{ message: { content: null, tool_calls: [call] } }],
        }),
      },
    },
  };
}

test("clean invoice from a new vendor → draft_journal_entry", async () => {
  const d = new QwenDecider(new FakeQwenChatClient());
  const action = await d.decide(decisionInput({ vendor: "NewCo", invoice_number: "N-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 }));
  assert.equal(action.tool, "draft_journal_entry");
  assert.ok(action.confidence > 0);
});

test("clean invoice from a known/recurring vendor → draft_payment", async () => {
  const d = new QwenDecider(new FakeQwenChatClient());
  const action = await d.decide(decisionInput({ vendor: "KnownCo", invoice_number: "K-2", tax_id: "T", subtotal: 100, tax: 20, total: 120 }, [], true));
  assert.equal(action.tool, "draft_payment");
});

test("missing fields / reconcile mismatch → draft_vendor_reply", async () => {
  const d = new QwenDecider(new FakeQwenChatClient());
  const action = await d.decide(decisionInput({ supplier: "MessyCo", subtotal: 2000, tax: 300, total: 3000 }));
  assert.equal(action.tool, "draft_vendor_reply");
});

test("suspected duplicate → flag_for_review", async () => {
  const priors: PriorInvoice[] = [{ invoiceId: "inv-1", vendor: "Dup", vendorRef: "D-1", total: 500, date: "2026-01-01" }];
  const d = new QwenDecider(new FakeQwenChatClient());
  const action = await d.decide(decisionInput({ vendor: "Dup", invoice_number: "D-1", tax_id: "T", total: 500, date: "2026-02-01" }, priors, true));
  assert.equal(action.tool, "flag_for_review");
});

test("parse path: JSON args are parsed and reasoning/confidence are lifted out of domain args", async () => {
  const call: ToolCall = {
    function: {
      name: "draft_journal_entry",
      arguments: JSON.stringify({ expense_account: "Office Supplies", amount: 120, reasoning: "clean invoice", confidence: 0.91 }),
    },
  };
  const d = new QwenDecider(cannedClient(call));
  const action = await d.decide(decisionInput({ vendor: "A", invoice_number: "1", tax_id: "T", total: 120 }));
  assert.equal(action.tool, "draft_journal_entry");
  assert.equal(action.reasoning, "clean invoice");
  assert.equal(action.confidence, 0.91);
  // The domain args a human will approve must NOT contain the meta-fields.
  assert.deepEqual(action.args, { expense_account: "Office Supplies", amount: 120 });
});

test("parse path: confidence is clamped to [0,1] and defaults when absent/invalid", async () => {
  const call: ToolCall = {
    function: { name: "flag_for_review", arguments: JSON.stringify({ reason: "x", confidence: 5 }) },
  };
  const d = new QwenDecider(cannedClient(call));
  const action = await d.decide(decisionInput({ vendor: "A", invoice_number: "1", tax_id: "T", total: 1 }));
  assert.equal(action.confidence, 1);
});

test("fallback: no tool call → safe flag_for_review with confidence 0", async () => {
  const noCall: QwenChatClient = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "I'm not sure." } }] }) } },
  };
  const d = new QwenDecider(noCall);
  const action = await d.decide(decisionInput({ vendor: "A", invoice_number: "1", tax_id: "T", total: 1 }));
  assert.equal(action.tool, "flag_for_review");
  assert.equal(action.confidence, 0);
});

test("computeSignals maps failed rules to decision signals", () => {
  const priors: PriorInvoice[] = [{ invoiceId: "inv-1", vendor: "Dup", vendorRef: "D-1", total: 500, date: "2026-01-01" }];
  const inv = normalizeInvoice({ vendor: "Dup", invoice_number: "D-1", tax_id: "T", total: 500, date: "2026-02-01" });
  const findings = validateInvoice(inv);
  findings.push(detectDuplicate(inv, priors));
  const s = computeSignals(findings, true);
  assert.equal(s.duplicate, true);
  assert.equal(s.known_vendor, true);
});

test("buildUserPrompt embeds a machine-readable SIGNALS line", () => {
  const input = decisionInput({ total: 100 }); // missing vendor/ref/tax_id → R2 fails
  const prompt = buildUserPrompt(input);
  assert.match(prompt, /SIGNALS: duplicate=\w+ missing_fields=true/);
});
