// Domain types for the Archon Autopilot accounts-payable (AP) workflow.
//
// The autopilot ingests an incoming vendor invoice (structured, but treated as
// possibly messy/ambiguous — real emails and PDFs are), normalizes it, then runs a
// bounded multi-step ReAct loop: Qwen (via function-calling) repeatedly chooses the
// next AUTONOMOUS read/analyze tool (recall vendor history, validate, check for a
// duplicate, compute the amount variance) — each executed with no side-effect — and
// finally chooses ONE terminal, side-effecting action. That terminal action is
// persisted as a PENDING proposal — never auto-executed — behind a human approval
// gate, together with the full step trace of how it decided.
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

// ── Agent trace (the multi-step ReAct loop's record of HOW it decided) ─────────

// One step of the bounded observe→decide→act loop. Autonomous read/analyze tools
// (recall_vendor_history / check_duplicate / validate_invoice /
// compute_variance_vs_history / request_more_context) each produce a TraceStep;
// they run INSIDE the loop with NO external side-effect, so the agent genuinely
// reasons over several observations before proposing a terminal, human-gated
// action. The ordered list is persisted on the work item and surfaced in
// /pending + the approval UI, so a human sees HOW the agent decided — not just
// the final action.
export interface TraceStep {
  step: number; // 1-based position in the loop
  tool: string; // the autonomous tool the model chose this step
  args: Record<string, unknown>; // the (domain) arguments it passed
  observation: string; // what the read/analyze tool returned (the "observe")
  reasoning: string; // the model's self-reported reason for this step
}

// Why the loop stopped — surfaced on the work item for transparency + debugging.
export type LoopStopReason =
  | "terminal_action" // the model chose a side-effecting tool → PENDING for approval
  | "max_steps_fallback" // the step budget was exhausted → deterministic flag_for_review
  | "no_progress_fallback"; // the model looped without progress → deterministic flag_for_review

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

// The amend audit trail — when a human edits a proposal before approving, we keep
// BOTH the args the agent originally proposed AND the args the human approved, so
// the decided view can show the exact prev → new diff. `amendedArgs` is what
// actually executed (approved-args == executed-args stays true). Rides inside the
// WorkItem JSONB — no schema migration, same as the trace.
export interface Amendment {
  proposedArgs: Record<string, unknown>; // what Qwen originally proposed
  amendedArgs: Record<string, unknown>; // the merged args the human approved + ran
  amendedBy?: string; // optional operator identity
  reason?: string; // optional human note on why it was amended
}

export interface WorkItem {
  id: string;
  status: WorkItemStatus;
  invoice: NormalizedInvoice;
  findings: ValidationFinding[];
  recalled: RecalledFact[];
  proposed: ProposedAction;
  // The ordered autonomous steps the loop took before proposing `proposed`. Each
  // is a no-side-effect read/analyze observation, so a human can audit the
  // reasoning path. Persisted inside the ap_workitems JSONB item (no new column).
  trace: TraceStep[];
  stopReason: LoopStopReason; // why the loop stopped (terminal vs. a guard fallback)
  execution?: ExecutionResult; // set once approved + executed
  amended?: boolean; // true when a human edited the args before approving
  amendment?: Amendment; // the prev → new audit trail, present iff `amended`
  decisionReason?: string; // human-supplied note on reject / amend
  createdAt: string;
  decidedAt?: string;
}
