// The decision engine — a bounded, multi-step ReAct loop over Qwen function-calling.
//
// This replaces the old single-shot decider. Instead of one tool call per invoice,
// the loop runs a real observe → decide → act → observe cycle:
//
//   Each step, Qwen (qwen-plus) is given the invoice + every observation gathered
//   so far + the tool catalog, and chooses the NEXT tool. If it picks an AUTONOMOUS
//   read/analyze tool (recall_vendor_history, validate_invoice, check_duplicate,
//   compute_variance_vs_history, request_more_context — analysis-tools.ts) the loop
//   EXECUTES it (no side-effect), appends the result to the running trace, and
//   iterates. When it picks a TERMINAL, side-effecting action (draft_journal_entry,
//   draft_payment, draft_vendor_reply, flag_for_review — tools.ts) the loop STOPS:
//   that proposal + the full trace are handed back to be persisted as PENDING for a
//   human to approve. Nothing side-effecting ever runs inside the loop — the
//   human-in-the-loop gate stays ironclad.
//
// Loop guards keep it safe and terminating: a max-steps cap, no-progress / repeated-
// tool detection, and a deterministic fallback to flag_for_review if the step budget
// is exhausted without a terminal decision (with the reason logged on the item).
//
// There is a SINGLE loop. Offline vs. online differs only by the chat client behind
// the QwenChatClient seam: the real `openai` client to qwen-plus, or the
// deterministic FakeQwenChatClient. Either way this same code parses `tool_calls`,
// so the function-calling integration is exercised in CI.

import {
  hasQwenCreds,
  chatClient,
  type ChatMessage,
  type QwenChatClient,
} from "../qwen/client.js";
import { FakeQwenChatClient } from "./fake-chat.js";
import type { Embedder } from "../memory/embeddings.js";
import type { MemoryStore } from "../memory/store.js";
import { isTerminalTool, toolByName, toolDefs, META_FIELDS } from "./tools.js";
import {
  analysisToolDefs,
  computeEvidence,
  executeAnalysisTool,
  isAnalysisTool,
  newLoopState,
  type LoopState,
} from "./analysis-tools.js";
import type {
  LoopStopReason,
  NormalizedInvoice,
  ProposedAction,
  RecalledFact,
  ToolName,
  TraceStep,
  ValidationFinding,
} from "../types.js";

export const DEFAULT_DECIDER_MODEL = process.env.QWEN_MODEL || "qwen-plus";
// The step budget. With 5 autonomous tools, 8 leaves comfortable headroom to gather
// evidence and still reach a terminal action before the fallback trips.
export const DEFAULT_MAX_STEPS = Number(process.env.AUTOPILOT_MAX_STEPS || 8);
// How many repeated / no-progress steps to tolerate before failing over to the
// deterministic flag_for_review fallback.
const MAX_NO_PROGRESS = 2;

export interface LoopInput {
  invoice: NormalizedInvoice;
  embedder: Embedder;
  memory: MemoryStore;
  // Optional run-scoped observer, fired as each autonomous read/analyze step is
  // appended to the trace. This is what lets a caller STREAM the loop's reasoning
  // live (the SSE /intake/stream route) without changing the loop's logic — it is a
  // pure observer with no side-effect on the decision. Absent (tests, MCP, eval),
  // the loop behaves exactly as before.
  onStep?: (step: TraceStep) => void;
}

export interface LoopResult {
  proposed: ProposedAction;
  trace: TraceStep[];
  findings: ValidationFinding[];
  recalled: RecalledFact[];
  stopReason: LoopStopReason;
}

export interface LoopOptions {
  maxSteps?: number;
  // Optional structured logger for WHY the loop stopped (defaults to console.warn on
  // a fallback). Kept injectable so tests can assert the reason without stdout noise.
  onStop?: (reason: LoopStopReason, detail: string) => void;
}

const SYSTEM_PROMPT =
  "You are Archon Autopilot, a human-gated accounts-payable clerk for a small " +
  "business. You work in STEPS: each step you call exactly ONE tool. FIRST gather " +
  "evidence with the autonomous read/analyze tools — recall_vendor_history (always " +
  "first), validate_invoice, and, when the recalled facts warrant it, check_duplicate " +
  "and compute_variance_vs_history. These have NO side-effect. THEN, once you have " +
  "enough evidence, choose exactly ONE terminal action: draft_journal_entry, " +
  "draft_payment, draft_vendor_reply, or flag_for_review. Terminal actions are " +
  "HUMAN-GATED — nothing runs until a person approves, so recommend, never assume. " +
  "Never invent amounts; use the invoice figures. Decision precedence once the " +
  "evidence is in: a confirmed duplicate or an anomalous amount → flag_for_review; " +
  "missing required fields or figures that do not reconcile → draft_vendor_reply; a " +
  "clean invoice from a known, recurring vendor with an in-range amount → " +
  "draft_payment; a clean invoice from a new vendor → draft_journal_entry. Put a " +
  "short `reasoning` on every call, and add a `confidence` (0..1) on the terminal action.";

export class AutopilotLoop {
  readonly modelId: string;
  private maxSteps: number;
  private onStop?: LoopOptions["onStop"];

  constructor(
    private client: QwenChatClient = chatClient(),
    modelId: string = DEFAULT_DECIDER_MODEL,
    opts: LoopOptions = {}
  ) {
    this.modelId = modelId;
    this.maxSteps = Math.max(2, opts.maxSteps ?? DEFAULT_MAX_STEPS);
    this.onStop = opts.onStop;
  }

  async run(input: LoopInput): Promise<LoopResult> {
    const state = newLoopState(input.invoice);
    const trace: TraceStep[] = [];
    const invoiceBlock = renderInvoice(input.invoice);
    const allDefs = [...analysisToolDefs(), ...toolDefs()];
    let noProgress = 0;

    for (let step = 1; step <= this.maxSteps; step++) {
      const res = await this.client.chat.completions.create({
        model: this.modelId,
        messages: this.messages(invoiceBlock, trace, state),
        temperature: 0.1,
        max_tokens: 512,
        tools: allDefs,
        // "auto" (not "required"): DashScope's OpenAI-compatible endpoint does not
        // document "required", and an unsupported value would 500 every live call —
        // breaking the whole loop invisibly (the offline Fake ignores tool_choice,
        // so CI can't catch it). "auto" is safe: the system prompt instructs one tool
        // per step, and if the model ever answers without a tool call the no-progress
        // guard below counts it and falls back to a safe flag_for_review.
        tool_choice: "auto",
      });

      const call = res.choices?.[0]?.message?.tool_calls?.[0];
      const name = call?.function?.name ?? "";
      const parsed = call ? safeParseArgs(call.function.arguments) : {};

      // TERMINAL action → stop the loop and hand back the proposal (nothing executes).
      if (call && isTerminalTool(name) && toolByName(name)) {
        const { reasoning, confidence, args } = splitMeta(parsed);
        return {
          proposed: { tool: name as ToolName, args, reasoning, confidence, modelId: this.modelId },
          trace,
          findings: state.findings,
          recalled: state.recalled,
          stopReason: "terminal_action",
        };
      }

      // AUTONOMOUS read/analyze tool → execute it (no side-effect), record the step.
      if (call && isAnalysisTool(name)) {
        const alreadyRan = hasRun(state, name);
        const observation = await executeAnalysisTool(name, parsed, state, input);
        const reasoning = typeof parsed["reasoning"] === "string" ? (parsed["reasoning"] as string) : "";
        const traceStep = { step, tool: name, args: stripMeta(parsed), observation, reasoning };
        trace.push(traceStep);
        input.onStep?.(traceStep); // stream the step live (SSE) — pure observer, no effect on the decision
        if (alreadyRan) {
          noProgress++;
          if (noProgress >= MAX_NO_PROGRESS) {
            return this.fallback(state, trace, "no_progress_fallback",
              `the model repeated already-completed read/analyze tools ${noProgress} time(s) without proposing a terminal action`);
          }
        }
        continue;
      }

      // No parseable / unknown tool call → count it as no progress and retry a step.
      noProgress++;
      if (noProgress >= MAX_NO_PROGRESS) {
        return this.fallback(state, trace, "no_progress_fallback",
          `the decision model returned no usable tool call ${noProgress} time(s)`);
      }
    }

    // Step budget exhausted without a terminal action → deterministic safe fallback.
    return this.fallback(state, trace, "max_steps_fallback",
      `reached the ${this.maxSteps}-step cap without a terminal action`);
  }

  // The deterministic safety net: when the loop cannot reach a terminal action, we do
  // NOT guess — we escalate to a human via flag_for_review and log why it stopped.
  private fallback(state: LoopState, trace: TraceStep[], reason: LoopStopReason, detail: string): LoopResult {
    (this.onStop ?? ((r, d) => console.warn(`[AutopilotLoop] ${r}: ${d}`)))(reason, detail);
    return {
      proposed: {
        tool: "flag_for_review",
        args: {
          reason: `The autopilot loop could not reach a confident action (${detail}); routing to a human.`,
          priority: "normal",
        },
        reasoning: `Loop stopped: ${detail}.`,
        confidence: 0,
        modelId: this.modelId,
      },
      trace,
      findings: state.findings,
      recalled: state.recalled,
      stopReason: reason,
    };
  }

  private messages(invoiceBlock: string, trace: TraceStep[], state: LoopState): ChatMessage[] {
    const stepsSoFar = trace.length
      ? trace
          .map((t) => `  ${t.step}. ${t.tool}${t.reasoning ? ` — ${t.reasoning}` : ""}\n     → ${t.observation}`)
          .join("\n")
      : "  (none yet — start by recalling the vendor's history)";

    const user = [
      invoiceBlock,
      ``,
      `STEPS TAKEN SO FAR (your observations):`,
      stepsSoFar,
      ``,
      // The machine-readable evidence snapshot — the real model reads the whole trace
      // above; the deterministic offline Fake branches on this single line.
      computeEvidence(state),
      ``,
      `Choose the next tool now. Gather any remaining evidence, then choose exactly one ` +
        `terminal action (include reasoning + confidence).`,
    ].join("\n");

    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ];
  }
}

// Auto-select the loop's chat client by environment. There is one loop; only the
// client behind the seam changes (real Qwen vs. offline FakeQwenChatClient).
export function defaultLoop(client?: QwenChatClient, opts: LoopOptions = {}): AutopilotLoop {
  if (client) return new AutopilotLoop(client, DEFAULT_DECIDER_MODEL, opts);
  return new AutopilotLoop(hasQwenCreds() ? chatClient() : new FakeQwenChatClient(), DEFAULT_DECIDER_MODEL, opts);
}

// ── helpers ─────────────────────────────────────────────────────────────────────

function hasRun(state: LoopState, name: string): boolean {
  switch (name) {
    case "recall_vendor_history":
      return state.didRecall;
    case "validate_invoice":
      return state.didValidate;
    case "check_duplicate":
      return state.didCheckDuplicate;
    case "compute_variance_vs_history":
      return state.didComputeVariance;
    default:
      return false; // request_more_context may legitimately repeat (guard catches loops)
  }
}

export function renderInvoice(inv: NormalizedInvoice): string {
  return [
    `INVOICE (normalized):`,
    `  invoice_id: ${inv.invoice_id}`,
    `  vendor: ${inv.vendor ?? "(missing)"}`,
    `  vendor_ref: ${inv.vendor_ref ?? "(missing)"}`,
    `  date: ${inv.invoice_date ?? "(missing)"}`,
    `  currency: ${inv.currency}`,
    `  subtotal: ${fmt(inv.subtotal)}  tax: ${fmt(inv.tax)}  total: ${fmt(inv.total)}`,
    `  tax_id: ${inv.tax_id ?? "(missing)"}`,
    inv.notes.length ? `  normalization_notes: ${inv.notes.join("; ")}` : `  normalization_notes: none`,
  ].join("\n");
}

// Lift reasoning + confidence out of the terminal tool arguments into the
// ProposedAction envelope, so the DOMAIN args a human approves are exactly what runs.
function splitMeta(parsed: Record<string, unknown>): { reasoning: string; confidence: number; args: Record<string, unknown> } {
  const args = stripMeta(parsed);
  const reasoning = typeof parsed["reasoning"] === "string" ? (parsed["reasoning"] as string) : "";
  const confidenceRaw = parsed["confidence"];
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;
  return { reasoning, confidence, args };
}

function stripMeta(parsed: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if ((META_FIELDS as readonly string[]).includes(k)) continue;
    args[k] = v;
  }
  return args;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fmt(n: number | null): string {
  return n == null ? "(missing)" : String(n);
}
