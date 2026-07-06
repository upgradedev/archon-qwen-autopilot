// MCP server — the Model Context Protocol surface over the Archon Autopilot agent.
//
// This exposes the human-gated AP agent to any standard MCP client (an IDE, an
// orchestrator, another agent) as a set of MCP TOOLS. It is a thin WRAPPER: every
// tool delegates to the SAME injectable AutopilotAgent the HTTP routes drive
// (built via resolveDeps/buildAgent in deps.ts), so there is exactly one decision
// loop, one memory, one approval queue — MCP and HTTP are two faces of one agent,
// never two copies of the logic.
//
// The tools mirror the AP workflow and its human-in-the-loop gate:
//   intake_invoice — run the multi-step ReAct loop → a PENDING proposal + the full
//                    step trace. NOTHING executes; the item persists for approval.
//   list_pending   — the approval queue.
//   approve        — a human approves an item → its terminal skill executes for real.
//   amend          — a human edits the proposed args, then approves → the amended
//                    args are EXACTLY what execute.
//   reject         — a human discards the proposal → nothing executes.
//   recall_vendor  — read-only recall of a vendor's history from persistent memory.
//   list_skills    — introspect the custom Qwen skill catalog (both tiers).
//
// THE GATE IS IRONCLAD OVER MCP TOO. approve/amend/reject call the agent's
// requirePending guard, so: intake never executes anything; approving requires an
// explicit approve call naming the id; and a decided item can never re-execute —
// a second approve/amend/reject returns an MCP error result (isError), it does not
// silently "succeed". None of that gate logic is re-implemented here; it is reused.
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
import {
  AutopilotAgent,
  ConflictError,
  NotFoundError,
} from "../agents/autopilot-agent.js";
import type { RawInvoice } from "../types.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

// ── The MCP tool catalog (JSON-Schema, no Zod) ────────────────────────────────
// These describe the AGENT-DRIVING surface (intake / gate / recall / introspect),
// distinct from the custom Qwen SKILLS the agent chooses internally (see
// skills/catalog.ts + the list_skills tool below).
const MCP_TOOLS: Tool[] = [
  {
    name: "intake_invoice",
    description:
      "Ingest a vendor invoice and run the bounded multi-step ReAct loop (recall vendor " +
      "history → validate → check duplicate → compute variance, as the evidence warrants) " +
      "until qwen-plus proposes ONE terminal action. Returns the proposed action, its " +
      "confidence + reasoning, and the FULL step trace. The proposal is persisted as a " +
      "PENDING work item — NOTHING executes until a human approves it. Use the returned id " +
      "with approve / amend / reject.",
    inputSchema: {
      type: "object",
      additionalProperties: true,
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
      "first), each with its full reasoning trace. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "approve",
    description:
      "Approve a PENDING proposal by id → its terminal skill executes for real (simulated " +
      "adapter) and the outcome is written back to memory. The human-in-the-loop gate: an " +
      "unknown id errors, and an already-decided item errors (it can never re-execute).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", description: "The work-item id to approve." } },
      required: ["id"],
    },
  },
  {
    name: "amend",
    description:
      "Edit a PENDING proposal's DOMAIN arguments and approve in one step → the amended " +
      "args are EXACTLY what execute. Same gate as approve (unknown/decided id errors).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "The work-item id to amend + approve." },
        args: {
          type: "object",
          additionalProperties: true,
          description: "Edited domain arguments, merged onto the proposal before execution.",
        },
        reason: { type: "string", description: "Why the proposal was amended." },
      },
      required: ["id"],
    },
  },
  {
    name: "reject",
    description:
      "Reject a PENDING proposal by id → nothing executes; the rejection is remembered. " +
      "Same gate (unknown/decided id errors).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "The work-item id to reject." },
        reason: { type: "string", description: "Why the proposal was rejected." },
      },
      required: ["id"],
    },
  },
  {
    name: "recall_vendor",
    description:
      "Recall a vendor's history from persistent memory — prior invoices, executed actions, " +
      "and insights — the same memory-grounding the loop uses, exposed on its own. Read-only: " +
      "it decides nothing and touches no sink.",
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
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

// Map an agent domain error to an MCP ERROR result — so the gate is OBSERVABLE
// over MCP: a decided item's re-approval returns isError, never a false success.
function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Dispatch one tool call against the agent. Extracted from the server wiring so it
// is unit-testable in isolation and shared by the stdio + in-memory transports.
export async function callAutopilotTool(
  agent: AutopilotAgent,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "intake_invoice": {
        const invoice = args.invoice;
        if (!invoice || typeof invoice !== "object") {
          return fail("intake_invoice requires an { invoice: {...} } object.");
        }
        const item = await agent.intake(invoice as RawInvoice);
        // Surface the whole PENDING item: the id (needed to approve), the proposed
        // terminal action + confidence + reasoning, the full step trace, and the
        // status (always "pending" — nothing executed).
        return ok(item);
      }
      case "list_pending":
        return ok({ pending: await agent.pending() });
      case "approve":
        return ok(await agent.approve(String(args.id ?? "")));
      case "amend":
        return ok(
          await agent.amend(String(args.id ?? ""), {
            args: (args.args as Record<string, unknown> | undefined) ?? {},
            reason: typeof args.reason === "string" ? args.reason : undefined,
          })
        );
      case "reject":
        return ok(
          await agent.reject(
            String(args.id ?? ""),
            typeof args.reason === "string" ? args.reason : undefined
          )
        );
      case "recall_vendor": {
        const vendor = String(args.vendor ?? "");
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return ok({ vendor, recalled: await agent.recallVendor(vendor, limit) });
      }
      case "list_skills":
        return ok(skillCatalog());
      default:
        return fail(`unknown tool: ${name}`);
    }
  } catch (err) {
    // The approval gate, surfaced as MCP error results (not thrown): a missing id
    // (NotFoundError) and an already-decided item (ConflictError) both come back
    // isError, so an MCP client cannot mistake a blocked re-execution for success.
    if (err instanceof NotFoundError) return fail(`not found: ${err.message}`);
    if (err instanceof ConflictError) return fail(`conflict: ${err.message}`);
    return fail(`error: ${(err as Error).message}`);
  }
}

// Build the MCP Server wired to an AutopilotAgent. Dependencies are injectable
// (deps.ts resolves the same env-selected defaults the HTTP server uses), so tests
// pass Fakes and drive this over an in-memory transport with no key and no DB.
export function buildMcpServer(deps: Partial<AutopilotDeps> = {}): { server: Server; agent: AutopilotAgent } {
  const { agent } = buildAgent(deps);

  const server = new Server(
    { name: "archon-qwen-autopilot", version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return callAutopilotTool(agent, name, (args ?? {}) as Record<string, unknown>);
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
    process.stderr.write(`MCP server failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
