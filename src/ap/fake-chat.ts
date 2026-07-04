// FakeQwenChatClient — the offline stand-in for Qwen function-calling.
//
// It sits at the SAME seam as the real OpenAI-compatible client (QwenChatClient),
// so the decider's real `tool_calls → ProposedAction` parse path is exercised in
// CI with no key. It returns a canned assistant message carrying a `tool_calls`
// entry — the exact shape qwen-plus returns — choosing an action by reading the
// deterministic `SIGNALS:` line the decider embeds in the prompt. Same decider
// code runs offline and online; only the client behind this interface changes.

import type {
  ChatCreateArgs,
  ChatResponse,
  QwenChatClient,
  ToolCall,
} from "../qwen/client.js";

interface Signals {
  duplicate: boolean;
  missing_fields: boolean;
  reconcile_issue: boolean;
  anomaly: boolean;
  known_vendor: boolean;
}

export class FakeQwenChatClient implements QwenChatClient {
  chat = {
    completions: {
      create: async (args: ChatCreateArgs): Promise<ChatResponse> => {
        const prompt = args.messages.map((m) => m.content).join("\n");
        const s = parseSignals(prompt);
        const call = chooseToolCall(s);
        return { choices: [{ message: { content: null, tool_calls: [call] } }] };
      },
    },
  };
}

// Map the decision signals to exactly one tool call — the deterministic policy
// the FakeDecider path encodes (the real model learns a richer version of this):
//   duplicate OR amount anomaly            → flag_for_review
//   missing fields OR reconcile mismatch    → draft_vendor_reply
//   clean + known (recurring) vendor        → draft_payment
//   clean + new vendor                      → draft_journal_entry
function chooseToolCall(s: Signals): ToolCall {
  if (s.duplicate) {
    return toolCall("flag_for_review", {
      reason: "Suspected duplicate of a previously processed invoice for this vendor.",
      priority: "high",
      reasoning: "Recalled memory shows a matching prior invoice; paying again would double-pay the vendor.",
      confidence: 0.9,
    });
  }
  if (s.anomaly) {
    return toolCall("flag_for_review", {
      reason: "Amount is well outside this vendor's usual range.",
      priority: "normal",
      reasoning: "The total is several times the vendor's historical average, so a human should confirm before posting.",
      confidence: 0.72,
    });
  }
  if (s.missing_fields || s.reconcile_issue) {
    return toolCall("draft_vendor_reply", {
      subject: "Clarification needed before we can process your invoice",
      body: "Some required details are missing or do not reconcile. Please confirm the vendor reference, tax id, and that subtotal plus tax equals the total.",
      reasoning: "The invoice cannot be safely paid until the vendor corrects the missing or inconsistent fields.",
      confidence: 0.8,
    });
  }
  if (s.known_vendor) {
    // amount is intentionally omitted — execute() falls back to the invoice total,
    // exactly as the real model would fill it from the invoice figures.
    return toolCall("draft_payment", {
      reasoning: "Clean invoice from a recurring, previously-approved vendor with an in-range amount — ready to schedule payment.",
      confidence: 0.86,
    });
  }
  return toolCall("draft_journal_entry", {
    expense_account: "Uncategorised Expense",
    reasoning: "Clean, validated invoice from a new vendor — accrue the liability now; payment can follow once the vendor is established.",
    confidence: 0.78,
  });
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `fake-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function parseSignals(prompt: string): Signals {
  const line = prompt.split("\n").find((l) => l.trim().startsWith("SIGNALS:")) ?? "";
  const flag = (k: string): boolean => new RegExp(`${k}=true`).test(line);
  return {
    duplicate: flag("duplicate"),
    missing_fields: flag("missing_fields"),
    reconcile_issue: flag("reconcile_issue"),
    anomaly: flag("anomaly"),
    known_vendor: flag("known_vendor"),
  };
}
