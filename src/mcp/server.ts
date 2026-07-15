// MCP server — the Model Context Protocol surface over the Archon Autopilot agent.
//
// This exposes the human-gated AP agent to any standard MCP client (an IDE, an
// orchestrator, another agent) as a set of MCP TOOLS. It is a thin WRAPPER: every
// tool delegates to the SAME injectable AutopilotAgent the HTTP routes drive
// (built via resolveDeps/buildAgent in deps.ts), so there is exactly one decision
// loop, one memory, one approval queue — MCP and HTTP are two faces of one agent,
// never two copies of the logic.
//
// The tools expose ONLY the proposal/read side of the AP workflow:
//   intake_invoice — run the multi-step ReAct loop → a PENDING proposal + the full
//                    redacted trace-tool/count summary. NOTHING executes; the full
//                    item persists behind the authenticated HTTP reviewer boundary.
//   list_pending   — a read-only view of the human approval queue.
//   recall_vendor  — read-only recall of a vendor's history from persistent memory.
//   list_skills    — introspect the custom Qwen skill catalog (both tiers).
//
// SECURITY INVARIANT: approve/amend/reject/execute are deliberately ABSENT from
// both tools/list and the dispatcher below. An MCP client is commonly itself an
// LLM agent; treating stdio as proof of a human would collapse the advertised
// human gate. Decisions therefore remain exclusive to the authenticated reviewer
// HTTP/UI surface, which records the reviewer identity and atomically claims the
// work item. Guessing a decision tool name returns an MCP error and fires no sink.
//
// Transport: primary is stdio (this file's main()). The server is built by
// buildMcpServer(deps) so tests drive it offline over an in-memory transport with
// the Fakes — no network, no key. stdout is owned by the JSON-RPC transport, so
// this module logs ONLY to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { buildAgent, type AutopilotDeps } from "../deps.js";
import { skillCatalog } from "../skills/catalog.js";
import { AutopilotAgent, ConflictError } from "../agents/autopilot-agent.js";
import type { RawInvoice, WorkItem } from "../types.js";
import { safeOperationalSummary } from "../security/operational-error.js";
import {
  DailyRateLimiter,
  PostgresDailyRateLimiter,
  type UploadRateLimiter,
} from "../ap/rate-limit.js";
import {
  defaultProviderRunAdmission,
  type ProviderRunAdmission,
} from "../ap/provider-admission.js";
import { hasDatabase } from "../db/client.js";
import { hasQwenCreds } from "../qwen/client.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

export interface McpControls {
  // MCP is uncredentialed stdio, so it always uses the public provider pool.
  providerAdmission?: ProviderRunAdmission;
  // Durable Postgres namespace in production; bounded process-local fallback in
  // offline mode. Injectable for deterministic saturation/quota tests.
  rateLimiter?: UploadRateLimiter;
  budgetKey?: string;
  // Operator-only configuration, never a tool argument. Default responses are
  // deliberately redacted; set MCP_FULL_REVIEWER_EVIDENCE=true only when the
  // spawning OS principal is authorized for the full AP evidence set.
  fullReviewerEvidence?: boolean;
}

export type McpServerDeps = Partial<AutopilotDeps> & McpControls;

interface ResolvedMcpControls {
  providerAdmission: ProviderRunAdmission;
  rateLimiter: UploadRateLimiter;
  budgetKey: string;
  fullReviewerEvidence: boolean;
}

const MCP_PROCESS_DAILY_LIMITER = new DailyRateLimiter(
  boundedEnvLimit("MCP_DAILY_LIMIT", 200),
  () => new Date(),
  boundedEnvLimit("MCP_GLOBAL_DAILY_LIMIT", 1_000)
);

// ── The MCP tool catalog (JSON-Schema, no Zod) ────────────────────────────────
// These describe the AGENT-SAFE surface (intake / queue-read / recall / introspect),
// distinct from the custom Qwen SKILLS the agent chooses internally (see
// skills/catalog.ts + the list_skills tool below).
const MCP_TOOLS: Tool[] = [
  {
    name: "intake_invoice",
    description:
      "Ingest a vendor invoice and run the bounded multi-step ReAct loop (recall vendor " +
      "history → validate → check duplicate → compute variance, as the evidence warrants) " +
      "until qwen-plus proposes ONE terminal action. Returns a least-privilege proposal summary by default; " +
      "full invoice evidence remains on the authenticated reviewer surface. The proposal is persisted as a " +
      "PENDING work item — NOTHING executes here. A human must use the separately " +
      "authenticated reviewer HTTP/UI surface to approve, amend, or reject it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        invoice: {
          type: "object",
          additionalProperties: true,
          description:
            "The incoming vendor invoice (structured JSON; fields may be missing/ambiguous — " +
            "it is normalized on intake).",
        },
      },
      required: ["invoice"],
    },
  },
  {
    name: "list_pending",
    description:
      "List the human approval queue — the proposed actions awaiting a decision (oldest " +
      "first). Returns a redacted operational summary by default; full evidence is available " +
      "only on the authenticated reviewer HTTP/UI surface. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size (default 50)." },
        offset: { type: "integer", minimum: 0, maximum: 1_000_000, description: "Bounded page offset." },
      },
    },
  },
  {
    name: "recall_vendor",
    description:
      "Recall a vendor's history from persistent memory. Default output reports only match " +
      "types/scores/timestamps and withholds content/metadata; full evidence requires an " +
      "operator-side MCP opt-in. Read-only: it decides nothing and touches no sink.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: { type: "string", description: "The vendor name to recall history for." },
        limit: { type: "number", description: "Max facts to return (default 8)." },
      },
      required: ["vendor"],
    },
  },
  {
    name: "list_skills",
    description:
      "Introspect the agent's custom Qwen skill catalog: every OpenAI-compatible function " +
      "schema the qwen-plus decider chooses from, annotated with tier (autonomous vs " +
      "terminal), gate (autonomous vs human-gated), the R1–R6 rule it owns, and its " +
      "parameters. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

// Wrap a JSON-serializable payload as a text tool result (the MCP content contract).
function ok(payload: unknown): CallToolResult {
  const text = JSON.stringify(payload, null, 2);
  const maxBytes = boundedEnvRange("MCP_MAX_RESPONSE_BYTES", 512 * 1024, 16 * 1024, 4 * 1024 * 1024);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return fail(`MCP response exceeds the ${maxBytes}-byte cap; request a smaller page or use the authenticated reviewer UI.`);
  }
  return { content: [{ type: "text", text }] };
}

// Map an invalid/forbidden MCP call to an explicit protocol error result.
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Dispatch one tool call against the agent. Extracted from the server wiring so it
// is unit-testable in isolation and shared by the stdio + in-memory transports.
export async function callAutopilotTool(
  agent: AutopilotAgent,
  name: string,
  args: Record<string, unknown>,
  controls: McpControls = {}
): Promise<CallToolResult> {
  const boundedInputError = validateBoundedMcpInput(args);
  if (boundedInputError) return fail(boundedInputError);
  const guarded = resolveMcpControls(controls);
  try {
    switch (name) {
      case "intake_invoice": {
        const invoice = args.invoice;
        if (!invoice || typeof invoice !== "object") {
          return fail("intake_invoice requires an { invoice: {...} } object.");
        }
        const lease = guarded.providerAdmission.tryAcquire("public");
        if (!lease) return fail("provider workflow capacity is temporarily busy; retry shortly.");
        try {
          const budget = await guarded.rateLimiter.consume(guarded.budgetKey);
          if (!budget.allowed) return fail("MCP provider budget is exhausted for this UTC day.");
          const item = await agent.intake(invoice as RawInvoice, {
            retainProviderCallUntilSettled: lease.retainUntilSettled,
          });
          return ok(guarded.fullReviewerEvidence ? item : mcpWorkItemProjection(item));
        } finally {
          lease.release();
        }
      }
      case "list_pending": {
        const limit = boundedInteger(args.limit, 50, 1, 100);
        const offset = boundedInteger(args.offset, 0, 0, 1_000_000);
        if (limit == null || offset == null) {
          return fail("list_pending limit/offset must be integers within the advertised bounds.");
        }
        const pending = await agent.pending(limit, offset);
        return ok({
          pending: guarded.fullReviewerEvidence ? pending : pending.map(mcpWorkItemProjection),
          page: {
            limit,
            offset,
            returned: pending.length,
            nextOffset: pending.length === limit ? offset + pending.length : null,
          },
        });
      }
      case "recall_vendor": {
        const vendor = String(args.vendor ?? "");
        if (!vendor.trim() || vendor.length > 200) {
          return fail("recall_vendor requires a non-empty vendor of at most 200 characters.");
        }
        const limit = boundedInteger(args.limit, 8, 1, 50);
        if (limit == null) return fail("recall_vendor limit must be an integer from 1 to 50.");
        const lease = guarded.providerAdmission.tryAcquire("public");
        if (!lease) return fail("provider workflow capacity is temporarily busy; retry shortly.");
        try {
          const budget = await guarded.rateLimiter.consume(guarded.budgetKey);
          if (!budget.allowed) return fail("MCP provider budget is exhausted for this UTC day.");
          const recalled = await agent.recallVendor(vendor, limit);
          return ok({
            vendor,
            recalled: guarded.fullReviewerEvidence ? recalled : recalled.map(mcpRecallProjection),
            evidence: guarded.fullReviewerEvidence
              ? "full-reviewer-evidence"
              : "redacted; use the authenticated reviewer HTTP/UI surface for content and metadata",
          });
        } finally {
          lease.release();
        }
      }
      case "list_skills":
        return ok(skillCatalog());
      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ConflictError) return fail(`conflict: ${err.message}`);
    return fail(`error: ${safeOperationalSummary(err, "mcp-tool")}`);
  }
}

function mcpWorkItemProjection(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id,
    status: item.status,
    createdAt: item.createdAt,
    proposed: {
      tool: item.proposed.tool,
      confidence: item.proposed.confidence,
      requiresReviewerInput: item.proposed.requiresReviewerInput ?? [],
    },
    findingSummary: item.findings.reduce<Record<string, number>>((summary, finding) => {
      summary[finding.severity] = (summary[finding.severity] ?? 0) + 1;
      return summary;
    }, {}),
    traceSummary: {
      steps: item.trace.length,
      tools: [...new Set(item.trace.map((step) => step.tool))],
      stopReason: item.stopReason,
    },
    durable: true,
    evidence: "redacted; full invoice, rationale, arguments, observations, and recalled facts require authenticated reviewer HTTP/UI access",
  };
}

function mcpRecallProjection(hit: { kind: string; score: number }): Record<string, unknown> {
  return {
    kind: hit.kind,
    score: hit.score,
  };
}

function resolveMcpControls(controls: McpControls): ResolvedMcpControls {
  const perClient = boundedEnvLimit("MCP_DAILY_LIMIT", 200);
  const global = boundedEnvLimit("MCP_GLOBAL_DAILY_LIMIT", 1_000);
  return {
    providerAdmission: controls.providerAdmission ?? defaultProviderRunAdmission(),
    rateLimiter:
      controls.rateLimiter ??
      (hasDatabase()
        ? new PostgresDailyRateLimiter(perClient, () => new Date(), global, "mcp")
        : MCP_PROCESS_DAILY_LIMITER),
    budgetKey: controls.budgetKey?.trim() || process.env.MCP_TENANT_ID?.trim() || "stdio",
    fullReviewerEvidence:
      controls.fullReviewerEvidence ?? /^(1|true|yes|on)$/i.test(process.env.MCP_FULL_REVIEWER_EVIDENCE?.trim() ?? ""),
  };
}

function boundedEnvLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(1_000_000, Math.trunc(parsed))) : fallback;
}

function boundedEnvRange(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

function assertMcpBootstrapConfiguration(deps: McpServerDeps): void {
  if (hasQwenCreds() && !hasDatabase()) {
    throw new Error("real-Qwen MCP requires DATABASE_URL for a durable cross-process budget");
  }
  if (process.env.NODE_ENV !== "production") return;
  if (!/^(1|true|yes|on)$/i.test(process.env.ENABLE_MCP_STDIO?.trim() ?? "")) {
    throw new Error("production MCP stdio requires explicit ENABLE_MCP_STDIO=true");
  }
  if (process.env.FC_FUNCTION_NAME || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error("MCP stdio is disabled in request-scoped serverless runtimes");
  }
  const tenant = deps.budgetKey?.trim() || process.env.MCP_TENANT_ID?.trim() || "";
  if (!tenant || tenant.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(tenant)) {
    throw new Error("production MCP stdio requires a 1–128 character MCP_TENANT_ID");
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

// stdio clients bypass Fastify's JSON body cap. Bound the recursively structured
// input before normalization/provider work so a local or orchestrated MCP client
// cannot force unbounded depth, node count, or retained strings.
function validateBoundedMcpInput(value: unknown): string | null {
  const MAX_DEPTH = 12;
  const MAX_NODES = 2_000;
  const MAX_STRING = 20_000;
  const MAX_KEYS = 512;
  let nodes = 0;
  let keys = 0;
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES) return `MCP input exceeds the ${MAX_NODES}-node limit.`;
    if (current.depth > MAX_DEPTH) return `MCP input exceeds the maximum nesting depth of ${MAX_DEPTH}.`;
    if (typeof current.value === "string" && current.value.length > MAX_STRING) {
      return `MCP input contains a string longer than ${MAX_STRING} characters.`;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value as object)) return "MCP input must be an acyclic JSON value.";
    seen.add(current.value as object);
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      keys += 1;
      if (keys > MAX_KEYS) return `MCP input exceeds the ${MAX_KEYS}-field limit.`;
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        return `MCP input contains the forbidden field ${JSON.stringify(key)}.`;
      }
      if (key.length > 200) return "MCP input contains an overlong field name.";
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return null;
}

// Build the MCP Server wired to an AutopilotAgent. Dependencies are injectable
// (deps.ts resolves the same env-selected defaults the HTTP server uses), so tests
// pass Fakes and drive this over an in-memory transport with no key and no DB.
export function buildMcpServer(deps: McpServerDeps = {}): { server: Server; agent: AutopilotAgent } {
  assertMcpBootstrapConfiguration(deps);
  const { agent } = buildAgent(deps);
  const controls = resolveMcpControls(deps);

  const server = new Server(
    { name: "archon-qwen-autopilot", version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return callAutopilotTool(agent, name, (args ?? {}) as Record<string, unknown>, controls);
  });

  return { server, agent };
}

// ── stdio entrypoint — the standard MCP transport ─────────────────────────────
// A client SPAWNS this process and speaks JSON-RPC over stdin/stdout. The default
// deps auto-select real Qwen + pgvector when DASHSCOPE_API_KEY / DATABASE_URL are
// set, else the offline Fakes. Logs go to stderr — stdout is the transport.
async function main(): Promise<void> {
  const { server } = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("archon-qwen-autopilot MCP server ready on stdio\n");
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`MCP server failed: ${safeOperationalSummary(err, "mcp-bootstrap")}\n`);
    process.exit(1);
  });
}
