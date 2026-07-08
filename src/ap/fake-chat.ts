// FakeQwenChatClient — the offline stand-in for Qwen function-calling in the loop.
//
// It sits at the SAME seam as the real OpenAI-compatible client (QwenChatClient),
// so the loop's real `tool_calls → next step` parse path is exercised in CI with no
// key. Each turn it returns a canned assistant message carrying ONE `tool_calls`
// entry — the exact shape qwen-plus returns — choosing the NEXT tool by reading the
// deterministic `EVIDENCE:` line the loop embeds in the step prompt (analysis-tools.ts
// builds it from what has been observed so far). The SAME loop code runs offline and
// online; only the client behind this interface changes.
//
// The policy below is deliberately multi-step: it always recalls history and
// validates before deciding, runs check_duplicate / compute_variance to CONFIRM a
// candidate before acting on it, and only then chooses a terminal action. So even
// offline the loop takes ≥2 autonomous read/analyze steps before any human-gated
// action — the real qwen-plus learns a richer version of the same discipline.

import type {
  ChatCreateArgs,
  ChatResponse,
  QwenChatClient,
  ToolCall,
} from "../qwen/client.js";

interface Evidence {
  recalled: boolean;
  validated: boolean;
  dup_checked: boolean;
  variance_computed: boolean;
  known_vendor: boolean;
  dup_candidate: boolean;
  anomaly_candidate: boolean;
  duplicate: boolean;
  missing_fields: boolean;
  reconcile_issue: boolean;
  anomaly: boolean;
  no_total: boolean;
  prior_correction: boolean;
  rebills_corrected: boolean;
}

export class FakeQwenChatClient implements QwenChatClient {
  chat = {
    completions: {
      create: async (args: ChatCreateArgs): Promise<ChatResponse> => {
        const prompt = args.messages.map((m) => m.content).join("\n");
        const e = parseEvidence(prompt);
        const call = chooseNextTool(e);
        return { choices: [{ message: { content: null, tool_calls: [call] } }] };
      },
    },
  };
}

// The deterministic ReAct policy: gather evidence first, confirm candidates, then
// pick the safest terminal action. Precedence mirrors an AP clerk's safety order —
// a confirmed duplicate/anomaly beats everything; missing/unreconciled fields block
// payment; a known in-range vendor is paid; a clean new vendor is accrued.
function chooseNextTool(e: Evidence): ToolCall {
  // 1) Always establish the vendor's history first.
  if (!e.recalled) {
    return analysis("recall_vendor_history", "Establish this vendor's history before deciding anything.");
  }
  // 2) A prior invoice looks like a match → CONFIRM the duplicate before acting.
  if (e.dup_candidate && !e.dup_checked) {
    return analysis("check_duplicate", "Recall surfaced a matching prior invoice — confirm whether this is a duplicate (R5).");
  }
  if (e.duplicate) {
    return terminal("flag_for_review", {
      reason: "Confirmed likely duplicate of a previously processed invoice for this vendor.",
      priority: "high",
      reasoning: "Duplicate risk outranks every other signal — paying again would double-pay the vendor.",
      confidence: 0.9,
    });
  }
  // 3) Run the structural checks R1–R4 before judging the amount or acting.
  if (!e.validated) {
    return analysis("validate_invoice", "Run the structural cross-checks R1–R4 before deciding.");
  }
  // 4) The amount looks unusual → CONFIRM the anomaly before acting.
  if (e.anomaly_candidate && !e.variance_computed) {
    return analysis("compute_variance_vs_history", "The amount is well above the vendor's usual — measure the variance (R6).");
  }
  if (e.anomaly) {
    return terminal("flag_for_review", {
      reason: "Amount is well outside this vendor's usual range.",
      priority: "normal",
      reasoning: "The confirmed variance is several times the vendor's historical average — a human should confirm before posting.",
      confidence: 0.72,
    });
  }
  // 4b) LEARNED FROM CORRECTIONS — the approval gate as a training signal. A human
  //     previously corrected this vendor's amount DOWN, and this invoice re-bills
  //     materially above that corrected amount. Re-billing an amount a human already
  //     corrected down is a genuine error a clerk catches, so escalate rather than
  //     straight-through pay — the gate's own past feedback outranks payment.
  if (e.rebills_corrected) {
    return terminal("flag_for_review", {
      reason: "This invoice re-bills an amount a human previously corrected DOWN for this vendor — escalate rather than auto-pay.",
      priority: "high",
      reasoning: "A prior human amend-down for this vendor is on record and this invoice bills materially above the corrected amount; a person should confirm before it is paid.",
      confidence: 0.7,
    });
  }
  // 5) Missing required fields or figures that do not reconcile → query the vendor.
  if (e.missing_fields || e.reconcile_issue) {
    return terminal("draft_vendor_reply", {
      subject: "Clarification needed before we can process your invoice",
      body: "Some required details are missing or do not reconcile. Please confirm the vendor reference, tax id, and that subtotal plus tax equals the total.",
      reasoning: "The invoice cannot be safely paid until the vendor corrects the missing or inconsistent fields.",
      confidence: 0.8,
    });
  }
  // 6) Clean invoice from a known, recurring vendor → confirm it is in range, then pay.
  if (e.known_vendor && !e.variance_computed) {
    return analysis("compute_variance_vs_history", "Known vendor — confirm the amount is in line with history before scheduling payment.");
  }
  if (e.known_vendor) {
    // amount is intentionally omitted — execute() falls back to the invoice total,
    // exactly as the real model would fill it from the invoice figures.
    return terminal("draft_payment", {
      reasoning: "Clean invoice from a recurring, previously-approved vendor with an in-range amount — ready to schedule payment.",
      confidence: 0.86,
    });
  }
  // 7) Clean invoice from a new vendor → accrue the liability.
  return terminal("draft_journal_entry", {
    expense_account: "Uncategorised Expense",
    reasoning: "Clean, validated invoice from a new vendor — accrue the liability now; payment can follow once the vendor is established.",
    confidence: 0.78,
  });
}

function analysis(name: string, reasoning: string): ToolCall {
  return toolCall(name, { reasoning });
}
function terminal(name: string, args: Record<string, unknown>): ToolCall {
  return toolCall(name, args);
}
function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `fake-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function parseEvidence(prompt: string): Evidence {
  // Read the LAST EVIDENCE line (the most recent step's snapshot).
  const lines = prompt.split("\n").filter((l) => l.trim().startsWith("EVIDENCE:"));
  const line = lines.length ? lines[lines.length - 1]! : "";
  const flag = (k: string): boolean => new RegExp(`\\b${k}=true\\b`).test(line);
  return {
    recalled: flag("recalled"),
    validated: flag("validated"),
    dup_checked: flag("dup_checked"),
    variance_computed: flag("variance_computed"),
    known_vendor: flag("known_vendor"),
    dup_candidate: flag("dup_candidate"),
    anomaly_candidate: flag("anomaly_candidate"),
    duplicate: flag("duplicate"),
    missing_fields: flag("missing_fields"),
    reconcile_issue: flag("reconcile_issue"),
    anomaly: flag("anomaly"),
    no_total: flag("no_total"),
    prior_correction: flag("prior_correction"),
    rebills_corrected: flag("rebills_corrected"),
  };
}
