// The decision agent — Qwen function-calling turns evidence into a proposed action.
//
// Given the normalized invoice, the validation findings, and the vendor history
// recalled from persistent memory, the decider asks a Qwen chat model to CHOOSE
// exactly one AP tool and fill in its arguments. The model's tool call + parsed
// arguments + self-reported reasoning + confidence become a ProposedAction —
// which is persisted as PENDING and NEVER executed here. Execution happens only
// after a human approves it (see workflow.ts).
//
// There is a SINGLE decider. Offline vs. online differs only by which chat client
// sits behind the QwenChatClient seam: the real `openai` client to qwen-plus, or
// the deterministic FakeQwenChatClient. Either way this same code parses the
// `tool_calls` response — so the function-calling integration is tested in CI.

import {
  hasQwenCreds,
  chatClient,
  type QwenChatClient,
} from "../qwen/client.js";
import { FakeQwenChatClient } from "./fake-chat.js";
import type {
  NormalizedInvoice,
  ProposedAction,
  RecalledFact,
  ToolName,
  ValidationFinding,
} from "../types.js";
import { META_FIELDS, toolByName, toolDefs } from "./tools.js";

export const DEFAULT_DECIDER_MODEL = process.env.QWEN_MODEL || "qwen-plus";

export interface DecisionInput {
  invoice: NormalizedInvoice;
  findings: ValidationFinding[];
  recalled: RecalledFact[];
  knownVendor: boolean;
}

const SYSTEM_PROMPT =
  "You are Archon Autopilot, a human-gated accounts-payable clerk for a small " +
  "business. For each incoming vendor invoice you are given the normalized " +
  "invoice, the automated validation findings, and the vendor's history recalled " +
  "from your persistent memory. You MUST choose exactly ONE tool to act on the " +
  "invoice and fill in its arguments. Never invent amounts — use the invoice " +
  "figures. Prefer draft_journal_entry or draft_payment ONLY for a clean, " +
  "validated invoice; draft_vendor_reply when required fields are missing or the " +
  "invoice does not reconcile; flag_for_review for a suspected duplicate or an " +
  "anomalous amount. Always include a short `reasoning` and a `confidence` (0..1) " +
  "in the tool arguments. You recommend the action — a human approves it before " +
  "anything actually happens.";

export class QwenDecider {
  readonly modelId: string;
  constructor(
    private client: QwenChatClient = chatClient(),
    modelId: string = DEFAULT_DECIDER_MODEL
  ) {
    this.modelId = modelId;
  }

  async decide(input: DecisionInput): Promise<ProposedAction> {
    const res = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      temperature: 0.1,
      max_tokens: 512,
      tools: toolDefs(),
      tool_choice: "auto",
    });

    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    // Defensive fallback: if the model somehow returned no tool call, escalate to
    // a human rather than guessing — the safe default for an autopilot.
    if (!call || !toolByName(call.function.name)) {
      return {
        tool: "flag_for_review",
        args: { reason: "The decision model did not return a valid action; routing to a human.", priority: "normal" },
        reasoning: "No parseable tool call was returned by the decision model.",
        confidence: 0,
        modelId: this.modelId,
      };
    }

    const parsed = safeParseArgs(call.function.arguments);
    const { reasoning, confidence, args } = splitMeta(parsed);
    return {
      tool: call.function.name as ToolName,
      args,
      reasoning,
      confidence,
      modelId: this.modelId,
    };
  }
}

// Auto-select the decider's chat client by environment. There is one decider;
// only the client behind the seam changes (real Qwen vs. offline FakeQwenChatClient).
export function defaultDecider(client?: QwenChatClient): QwenDecider {
  if (client) return new QwenDecider(client);
  return new QwenDecider(hasQwenCreds() ? chatClient() : new FakeQwenChatClient());
}

// ── Prompt construction ───────────────────────────────────────────────────────

export function buildUserPrompt(input: DecisionInput): string {
  const { invoice: inv, findings, recalled, knownVendor } = input;
  const signals = computeSignals(findings, knownVendor);
  const findingLines = findings
    .map((f) => `  - ${f.rule} ${f.passed ? "PASS" : "FAIL"} [${f.severity}] ${f.message}`)
    .join("\n");
  const recallLines = recalled.length
    ? recalled.map((r) => `  - (${r.kind}, similarity ${r.score}) ${r.content}`).join("\n")
    : "  - (no prior memory for this vendor — first time seen)";

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
    ``,
    `VALIDATION FINDINGS:`,
    findingLines,
    ``,
    `RECALLED VENDOR HISTORY (from persistent memory):`,
    recallLines,
    ``,
    // Deterministic decision signals — the real model reads the whole context;
    // the offline FakeQwenChatClient branches on this single machine-readable line.
    `SIGNALS: duplicate=${signals.duplicate} missing_fields=${signals.missing_fields} reconcile_issue=${signals.reconcile_issue} anomaly=${signals.anomaly} known_vendor=${signals.known_vendor}`,
    ``,
    `Choose exactly one tool now and fill in its arguments (include reasoning + confidence).`,
  ].join("\n");
}

export interface DecisionSignals {
  duplicate: boolean;
  missing_fields: boolean;
  reconcile_issue: boolean;
  anomaly: boolean;
  known_vendor: boolean;
}

export function computeSignals(findings: ValidationFinding[], knownVendor: boolean): DecisionSignals {
  const failed = (rule: string) => findings.some((f) => f.rule === rule && !f.passed);
  return {
    duplicate: failed("R5"),
    missing_fields: failed("R2"),
    reconcile_issue: failed("R3") || failed("R4"),
    anomaly: failed("R6"),
    known_vendor: knownVendor,
  };
}

function splitMeta(parsed: Record<string, unknown>): { reasoning: string; confidence: number; args: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if ((META_FIELDS as readonly string[]).includes(k)) continue;
    args[k] = v;
  }
  const reasoning = typeof parsed["reasoning"] === "string" ? (parsed["reasoning"] as string) : "";
  const confidenceRaw = parsed["confidence"];
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;
  return { reasoning, confidence, args };
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
