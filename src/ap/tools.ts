// The AP tool set — the actions Qwen may choose, and how each one executes.
//
// Each tool has two faces:
//   1. A `ToolDef` (OpenAI-compatible function schema) handed to Qwen so the
//      model can CHOOSE it and fill in the arguments via function-calling.
//   2. An `execute()` stub that performs the real side-effect (posting a journal
//      entry, recording a payment, sending a vendor reply, escalating a review)
//      through the injected Sinks — run ONLY after a human approves.
//
// Every tool's argument schema also carries two meta-fields, `reasoning` and
// `confidence`, which the model self-reports per action. The decider lifts these
// out of the arguments into the ProposedAction envelope, so the DOMAIN args a
// human approves are exactly the args that execute (the HITL guarantee).

import type { ToolDef } from "../qwen/client.js";
import type { ExecutionResult, NormalizedInvoice, ToolName } from "../types.js";
import type { Sinks } from "./sinks.js";

export interface ToolSpec {
  name: ToolName;
  def: ToolDef;
  // Perform the real side-effect. `inv` is the invoice under decision; `args` are
  // the human-approved DOMAIN arguments (reasoning/confidence already stripped).
  // Async because a terminal action may perform real I/O (the SMTP email sink); the
  // ledger / payment / review sinks resolve synchronously.
  execute(args: Record<string, unknown>, inv: NormalizedInvoice, sinks: Sinks): Promise<ExecutionResult>;
}

// Shared meta-fields injected into every tool schema (self-reported by the model).
const META_PROPS = {
  reasoning: {
    type: "string",
    description: "One or two sentences explaining WHY this action fits the invoice, the validation findings, and the recalled vendor history.",
  },
  confidence: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Your confidence (0..1) that this is the correct action. Lower it when fields are missing, amounts look anomalous, or a duplicate is suspected.",
  },
} as const;

function fn(name: ToolName, description: string, props: Record<string, unknown>, required: string[]): ToolDef {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { ...props, ...META_PROPS },
        required: [...required, "reasoning", "confidence"],
      },
    },
  };
}

function num(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}
function str(s: unknown, fallback = ""): string {
  return typeof s === "string" ? s : fallback;
}

// ── The four tools ────────────────────────────────────────────────────────────

const draftJournalEntry: ToolSpec = {
  name: "draft_journal_entry",
  def: fn(
    "draft_journal_entry",
    "Draft a double-entry accrual for a clean, validated invoice: debit the expense account, credit accounts payable. Use for a well-formed invoice whose fields validate and whose amount is in line with the vendor's history.",
    {
      expense_account: { type: "string", description: "The expense account to debit, e.g. 'Office Supplies' or 'Professional Fees'." },
      amount: { type: "number", description: "The gross amount to accrue (the invoice total)." },
      memo: { type: "string", description: "Short narrative for the journal entry." },
    },
    ["expense_account", "amount"]
  ),
  async execute(args, inv, sinks) {
    const amount = num(args["amount"], inv.total ?? 0);
    const account = str(args["expense_account"], "Uncategorised Expense");
    const entry = sinks.ledger.post({
      ref: inv.invoice_id,
      narrative: str(args["memo"], `Accrual for ${inv.vendor ?? "vendor"} invoice ${inv.vendor_ref ?? inv.invoice_id}`),
      lines: [
        { account, debit: amount },
        { account: "Accounts Payable", credit: amount },
      ],
    });
    return {
      tool: "draft_journal_entry",
      ok: true,
      summary: `Posted journal entry ${entry.ref}: debit ${account} ${amount}, credit Accounts Payable ${amount}.`,
      output: { entry },
    };
  },
};

const draftPayment: ToolSpec = {
  name: "draft_payment",
  def: fn(
    "draft_payment",
    "Schedule a payment to the vendor. Use for a clean, validated invoice from a KNOWN, previously-approved vendor whose amount matches its history — the straight-through case where paying is the right next step.",
    {
      vendor: { type: "string", description: "The payee vendor name." },
      amount: { type: "number", description: "The amount to pay (the invoice total)." },
      currency: { type: "string", description: "ISO currency code, e.g. EUR." },
      pay_on: { type: "string", description: "Optional ISO date to schedule the payment for." },
    },
    ["vendor", "amount"]
  ),
  async execute(args, inv, sinks) {
    const payment = sinks.payments.record({
      ref: inv.invoice_id,
      vendor: str(args["vendor"], inv.vendor ?? "unknown vendor"),
      amount: num(args["amount"], inv.total ?? 0),
      currency: str(args["currency"], inv.currency),
      scheduledFor: typeof args["pay_on"] === "string" ? (args["pay_on"] as string) : null,
    });
    return {
      tool: "draft_payment",
      ok: true,
      summary: `Recorded payment of ${payment.currency} ${payment.amount} to ${payment.vendor} (ref ${payment.ref}).`,
      output: { payment },
    };
  },
};

const draftVendorReply: ToolSpec = {
  name: "draft_vendor_reply",
  def: fn(
    "draft_vendor_reply",
    "Draft a reply to the vendor asking for a correction or clarification. Use when required fields are missing or the invoice does not reconcile — you cannot safely pay until the vendor responds.",
    {
      to: { type: "string", description: "Recipient — the vendor's billing contact (a name/address is fine)." },
      subject: { type: "string", description: "Email subject line." },
      body: { type: "string", description: "The clarification request, citing exactly what is missing or inconsistent." },
    },
    ["subject", "body"]
  ),
  async execute(args, inv, sinks) {
    const email = await sinks.email.send({
      to: str(args["to"], inv.vendor ?? "vendor billing"),
      subject: str(args["subject"], `Query on invoice ${inv.vendor_ref ?? inv.invoice_id}`),
      body: str(args["body"], "We need a clarification before we can process this invoice."),
    });
    return {
      tool: "draft_vendor_reply",
      ok: true,
      summary: `Sent a clarification request to ${email.to} re: "${email.subject}".`,
      output: { email },
    };
  },
};

const flagForReview: ToolSpec = {
  name: "flag_for_review",
  def: fn(
    "flag_for_review",
    "Escalate the invoice to a human specialist. Use for a suspected duplicate payment, an anomalous amount, or anything that needs judgement beyond the standard rules.",
    {
      reason: { type: "string", description: "Why this needs human review (e.g. suspected duplicate, amount anomaly)." },
      priority: { type: "string", enum: ["low", "normal", "high"], description: "Escalation priority." },
    },
    ["reason"]
  ),
  async execute(args, inv, sinks) {
    const priorityRaw = str(args["priority"], "normal");
    const priority = (["low", "normal", "high"].includes(priorityRaw) ? priorityRaw : "normal") as
      | "low"
      | "normal"
      | "high";
    const escalation = sinks.reviews.raise({
      ref: inv.invoice_id,
      reason: str(args["reason"], "Flagged for human review."),
      priority,
    });
    return {
      tool: "flag_for_review",
      ok: true,
      summary: `Escalated ${escalation.ref} for review (${escalation.priority}): ${escalation.reason}`,
      output: { escalation },
    };
  },
};

export const TOOLS: ToolSpec[] = [draftJournalEntry, draftPayment, draftVendorReply, flagForReview];

const BY_NAME = new Map<ToolName, ToolSpec>(TOOLS.map((t) => [t.name, t]));

export function toolByName(name: string): ToolSpec | undefined {
  return BY_NAME.get(name as ToolName);
}

// These are the TERMINAL, side-effecting actions. When the multi-step loop's model
// chooses one of these it STOPS: the proposal is persisted as PENDING and NOTHING
// executes until a human approves it. The autonomous read/analyze tools (see
// analysis-tools.ts) run inside the loop with no side-effect and never end it.
export const TERMINAL_TOOL_NAMES: readonly ToolName[] = TOOLS.map((t) => t.name);

export function isTerminalTool(name: string): boolean {
  return BY_NAME.has(name as ToolName);
}

// The terminal-action `tools[]` schemas handed to Qwen for function-calling. The
// loop concatenates these with the autonomous analysis-tool defs (analysis-tools.ts)
// so the model can pick either a read/analyze step or a terminal action each turn.
export function toolDefs(): ToolDef[] {
  return TOOLS.map((t) => t.def);
}

// The meta-field names lifted out of tool arguments into the ProposedAction
// envelope, so a human approves only the DOMAIN args (and the same args execute).
export const META_FIELDS = ["reasoning", "confidence"] as const;
