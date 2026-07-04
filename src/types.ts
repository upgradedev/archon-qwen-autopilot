// Domain types for the Archon Autopilot accounts-payable (AP) workflow.
//
// The autopilot ingests an incoming vendor invoice (structured, but treated as
// possibly messy/ambiguous — real emails and PDFs are), normalizes it, validates
// it, recalls the vendor's history from persistent memory, then asks Qwen (via
// function-calling) to CHOOSE one AP action. The chosen action is persisted as a
// PENDING proposal — never auto-executed — behind a human approval gate.
//
// Positioning: universal financial-intelligence terms only. `tax_id` / `tax`
// are generic accounting fields, not tied to any national authority or scheme.

// ── Invoice (raw + normalized) ────────────────────────────────────────────────

// The raw invoice payload as received — arbitrary keys, possibly missing or
// mistyped fields. The normalizer maps this into a NormalizedInvoice + notes.
export type RawInvoice = Record<string, unknown>;

export interface LineItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
}

export interface NormalizedInvoice {
  invoice_id: string; // generated if the payload omits one
  vendor: string | null; // vendor / supplier name
  vendor_ref: string | null; // vendor's own invoice number
  invoice_date: string | null; // ISO date if parseable
  currency: string; // ISO currency code, defaults to EUR
  subtotal: number | null; // pre-tax amount
  tax: number | null; // tax amount (generic — not tied to any scheme)
  tax_id: string | null; // vendor tax registration id (generic)
  total: number | null; // gross amount payable
  line_items: LineItem[];
  // Human-readable notes about what the normalizer had to coerce or infer,
  // surfaced so a reviewer sees exactly how messy the input was.
  notes: string[];
  raw: RawInvoice;
}

// ── Validation ────────────────────────────────────────────────────────────────

export type Severity = "info" | "warn" | "error";

export interface ValidationFinding {
  rule: string; // R1..R4 rule id
  passed: boolean;
  severity: Severity;
  message: string;
}

// ── Proposed action (the output of Qwen function-calling) ──────────────────────

export type ToolName =
  | "draft_journal_entry"
  | "draft_payment"
  | "draft_vendor_reply"
  | "flag_for_review";

// The model chose exactly one tool. `args` are the DOMAIN arguments only (the
// meta fields `reasoning` + `confidence` are lifted out of the tool arguments
// into the envelope below), so the human approves EXACTLY the args that will run.
export interface ProposedAction {
  tool: ToolName;
  args: Record<string, unknown>;
  reasoning: string;
  confidence: number; // 0..1 self-reported by the model
  modelId: string; // which decider produced it (real Qwen model id or fake tag)
}

// ── Work item (a unit of AP work moving through the HITL gate) ──────────────────

export type WorkItemStatus = "pending" | "approved" | "rejected";

// A short projection of a recalled memory, attached to the work item so a
// reviewer sees exactly what history the decision was grounded in.
export interface RecalledFact {
  kind: string;
  score: number;
  content: string;
}

// The result of actually executing a tool once a human approves it.
export interface ExecutionResult {
  tool: ToolName;
  ok: boolean;
  summary: string;
  output: Record<string, unknown>;
}

export interface WorkItem {
  id: string;
  status: WorkItemStatus;
  invoice: NormalizedInvoice;
  findings: ValidationFinding[];
  recalled: RecalledFact[];
  proposed: ProposedAction;
  execution?: ExecutionResult; // set once approved + executed
  amended?: boolean; // true when a human edited the args before approving
  decisionReason?: string; // human-supplied note on reject / amend
  createdAt: string;
  decidedAt?: string;
}
