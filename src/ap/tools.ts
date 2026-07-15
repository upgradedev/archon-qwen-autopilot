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
import { isSupportedCurrency } from "./currency.js";
import { isBoundedPositiveAmount, MAX_FINANCIAL_AMOUNT } from "./finance-policy.js";
import type { Sinks } from "./sinks.js";

export interface ToolSpec {
  name: ToolName;
  def: ToolDef;
  // Perform the real side-effect. `inv` is the invoice under decision; `args` are
  // the human-approved DOMAIN arguments (reasoning/confidence already stripped).
  // Async because a terminal action may perform real I/O (the SMTP email sink); the
  // ledger / payment / review sinks resolve synchronously.
  execute(
    args: Record<string, unknown>,
    inv: NormalizedInvoice,
    sinks: Sinks,
    executionKey?: string
  ): Promise<ExecutionResult>;
}

export class InvalidToolArgsError extends Error {}

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
      currency: { type: "string", description: "ISO currency code for every debit and credit in this entry." },
      memo: { type: "string", description: "Short narrative for the journal entry." },
    },
    ["expense_account", "amount", "currency"]
  ),
  async execute(args, inv, sinks, executionKey = inv.invoice_id) {
    const amount = num(args["amount"], inv.total ?? 0);
    const account = str(args["expense_account"], "Uncategorised Expense");
    const entry = sinks.ledger.post({
      ref: executionKey,
      currency: str(args["currency"], inv.currency),
      narrative: str(args["memo"], `Accrual for ${inv.vendor ?? "vendor"} invoice ${inv.vendor_ref ?? inv.invoice_id}`),
      lines: [
        { account, debit: amount },
        { account: "Accounts Payable", credit: amount },
      ],
    });
    return {
      tool: "draft_journal_entry",
      ok: true,
      summary: `Posted ${entry.currency} journal entry ${entry.ref}: debit ${account} ${amount}, credit Accounts Payable ${amount}.`,
      output: { entry },
    };
  },
};

const draftPayment: ToolSpec = {
  name: "draft_payment",
  def: fn(
    "draft_payment",
    "Propose a simulated scheduled-payment adapter record. Use for a clean, validated invoice from a KNOWN, previously-approved vendor whose amount matches its history. No bank rail is connected.",
    {
      vendor: { type: "string", description: "The payee vendor name." },
      amount: { type: "number", description: "The amount to pay (the invoice total)." },
      currency: { type: "string", description: "ISO currency code, e.g. EUR." },
      pay_on: { type: "string", description: "Optional ISO date to schedule the payment for." },
    },
    ["vendor", "amount", "currency"]
  ),
  async execute(args, inv, sinks, executionKey = inv.invoice_id) {
    const payment = sinks.payments.record({
      ref: executionKey,
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
      subject: { type: "string", description: "Email subject line." },
      body: { type: "string", description: "The clarification request, citing exactly what is missing or inconsistent." },
    },
    ["subject", "body"]
  ),
  async execute(args, inv, sinks, executionKey = inv.invoice_id) {
    const email = await sinks.email.send({
      ref: executionKey,
      to: str(args["to"], inv.vendor ?? "vendor billing"),
      subject: str(args["subject"], `Query on invoice ${inv.vendor_ref ?? inv.invoice_id}`),
      body: str(args["body"], "We need a clarification before we can process this invoice."),
    });
    return {
      tool: "draft_vendor_reply",
      ok: true,
      summary: `Submitted a clarification request to the configured email sink for ${email.to} re: "${email.subject}".`,
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
  async execute(args, inv, sinks, executionKey = inv.invoice_id) {
    const priorityRaw = str(args["priority"], "normal");
    const priority = (["low", "normal", "high"].includes(priorityRaw) ? priorityRaw : "normal") as
      | "low"
      | "normal"
      | "high";
    const escalation = sinks.reviews.raise({
      ref: executionKey,
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

// Runtime validation at the reviewer boundary. Function schemas guide Qwen, but
// they are not a security control; no terminal sink sees malformed, negative,
// unbounded, header-injected, or tool-inappropriate arguments.
export function assertValidToolArgs(
  tool: ToolName,
  args: Record<string, unknown>,
  _invoice: NormalizedInvoice
): void {
  const allowed: Record<ToolName, readonly string[]> = {
    draft_journal_entry: ["expense_account", "amount", "currency", "memo"],
    draft_payment: ["vendor", "amount", "currency", "pay_on"],
    draft_vendor_reply: ["to", "subject", "body"],
    flag_for_review: ["reason", "priority"],
  };
  if (!Object.prototype.hasOwnProperty.call(allowed, tool)) {
    throw new InvalidToolArgsError(`unknown terminal tool "${String(tool)}"`);
  }
  for (const key of Object.keys(args)) {
    if (!allowed[tool].includes(key)) {
      throw new InvalidToolArgsError(`${tool}: unsupported argument "${key}"`);
    }
  }
  switch (tool) {
    case "draft_journal_entry":
      requireText(args, "expense_account", 120);
      requireAmount(args, "amount");
      requireIsoCurrency(args, "draft_journal_entry");
      optionalText(args, "memo", 2000);
      return;
    case "draft_payment":
      requireText(args, "vendor", 200);
      requireAmount(args, "amount");
      requireIsoCurrency(args, "draft_payment");
      optionalText(args, "pay_on", 10);
      if (args["pay_on"] !== undefined && !isIsoDate(String(args["pay_on"]))) {
        throw new InvalidToolArgsError("draft_payment: pay_on must be an ISO date (YYYY-MM-DD)");
      }
      return;
    case "draft_vendor_reply":
      // No verified vendor email exists in the normalized source. The proposal
      // argument guard strips any model-supplied destination, so sending requires
      // an authenticated reviewer amendment that explicitly supplies `to`.
      requireText(args, "to", 320);
      requireText(args, "subject", 300);
      requireText(args, "body", 10_000);
      for (const field of ["to", "subject"] as const) {
        if (typeof args[field] === "string" && /[\r\n\0]/.test(args[field])) {
          throw new InvalidToolArgsError(`draft_vendor_reply: ${field} contains forbidden header controls`);
        }
      }
      if (!isSingleMailbox(String(args["to"]))) {
        throw new InvalidToolArgsError(
          "draft_vendor_reply: to must be exactly one canonical mailbox (no display name or recipient list)"
        );
      }
      return;
    case "flag_for_review":
      requireText(args, "reason", 2000);
      optionalText(args, "priority", 6);
      if (args["priority"] !== undefined && !["low", "normal", "high"].includes(String(args["priority"]))) {
        throw new InvalidToolArgsError("flag_for_review: priority must be low, normal, or high");
      }
  }
}

function isSingleMailbox(value: string): boolean {
  if (value.length > 254 || /[\s,;<>"\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local = "", domain = ""] = parts;
  if (
    local.length < 1 ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) return false;
  if (domain.length < 3 || domain.length > 253 || !domain.includes(".")) return false;
  return domain.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  );
}

function requireIsoCurrency(args: Record<string, unknown>, tool: ToolName): void {
  requireText(args, "currency", 3);
  const code = String(args["currency"]).toUpperCase();
  if (!isSupportedCurrency(code)) {
    throw new InvalidToolArgsError(`${tool}: currency must be a supported ISO 4217 code`);
  }
}

function requireAmount(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (!isBoundedPositiveAmount(value)) {
    throw new InvalidToolArgsError(`${key} must be a finite positive number no greater than ${MAX_FINANCIAL_AMOUNT}`);
  }
}

function requireText(args: Record<string, unknown>, key: string, max: number): void {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new InvalidToolArgsError(`${key} must be a non-empty string of at most ${max} characters`);
  }
}

function optionalText(args: Record<string, unknown>, key: string, max: number): void {
  if (args[key] === undefined) return;
  const value = args[key];
  if (typeof value !== "string" || value.length > max) {
    throw new InvalidToolArgsError(`${key} must be a string of at most ${max} characters`);
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
