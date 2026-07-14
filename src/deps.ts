// Shared dependency wiring — the ONE place the runtime dependency graph is built.
//
// Both entry points (the HTTP server in server.ts and the MCP server in
// mcp/server.ts) drive the SAME AutopilotAgent, so they MUST wire it the same way
// or they would drift (e.g. one on pgvector, the other in-memory). This helper is
// the single source of truth for that default wiring, and every dependency stays
// injectable so the whole agent runs offline with Fakes in tests.
//
// Auto-selection by environment (identical for HTTP and MCP):
//   • DASHSCOPE_API_KEY set → real Qwen (qwen-plus decider + text-embedding-v4);
//     absent → deterministic offline Fakes.
//   • DATABASE_URL set → pgvector stores; absent → in-memory stores.
//   • SMTP_HOST set → the vendor-reply email sink delivers over REAL SMTP (behind the
//     unchanged human gate); absent → the in-memory Fake email sink.
//   • LEDGER_JSONL_PATH set → the journal-entry sink appends approved accruals to a
//     REAL durable JSONL ledger file (behind the same human gate); absent → the
//     in-memory Fake ledger sink. Payment / review sinks are always the in-memory Fakes.

import { defaultEmbedder, type Embedder } from "./memory/embeddings.js";
import { InMemoryStore, PgVectorStore, type MemoryStore } from "./memory/store.js";
import { InMemoryWorkItemStore, PgWorkItemStore, type WorkItemStore } from "./ap/workitem-store.js";
import { defaultLoop, type AutopilotLoop } from "./ap/loop.js";
import { fakeSinks, type Sinks } from "./ap/sinks.js";
import { SmtpEmailSink } from "./ap/smtp-sink.js";
import { JsonlLedgerSink } from "./ap/ledger-sink.js";
import { hasDatabase } from "./db/client.js";
import { AutopilotAgent } from "./agents/autopilot-agent.js";
import { hasQwenCreds } from "./qwen/client.js";

// The default sink bundle: in-memory Fakes for payment / reviews, plus TWO real sinks
// when configured — a REAL SMTP email sink (SMTP_HOST) and a REAL durable JSONL ledger
// sink (LEDGER_JSONL_PATH). Each falls back to its in-memory Fake when unconfigured, and
// the human gate in front of every sink is identical whether it is real or a Fake.
export function defaultSinks(): Sinks {
  const sinks = fakeSinks();
  const smtp = SmtpEmailSink.fromEnv();
  if (smtp) sinks.email = smtp;
  const ledger = JsonlLedgerSink.fromEnv();
  if (ledger) sinks.ledger = ledger;
  return sinks;
}

export interface AutopilotDeps {
  embedder: Embedder;
  memory: MemoryStore;
  workitems: WorkItemStore;
  loop: AutopilotLoop;
  sinks: Sinks;
}

// Resolve the full dependency set, filling any not explicitly injected with the
// environment-selected default. Callers (HTTP + MCP) pass overrides in tests.
export function resolveDeps(deps: Partial<AutopilotDeps> = {}): AutopilotDeps {
  const production = process.env.NODE_ENV === "production";
  const allowFakeQwen = envFlag("ALLOW_FAKE_QWEN");
  const allowMemoryStore = envFlag("ALLOW_IN_MEMORY_STORE");
  if (
    production &&
    !allowFakeQwen &&
    !hasQwenCreds() &&
    (!deps.embedder || !deps.loop)
  ) {
    throw new Error(
      "production requires DASHSCOPE_API_KEY for the Qwen embedder/decider; " +
        "set ALLOW_FAKE_QWEN=true only for an explicitly non-production demonstration"
    );
  }
  if (
    production &&
    !allowMemoryStore &&
    !hasDatabase() &&
    (!deps.memory || !deps.workitems)
  ) {
    throw new Error(
      "production requires DATABASE_URL for durable memory/work items; " +
        "set ALLOW_IN_MEMORY_STORE=true only for an explicitly ephemeral demonstration"
    );
  }
  return {
    embedder: deps.embedder ?? defaultEmbedder(),
    memory: deps.memory ?? (hasDatabase() ? new PgVectorStore() : new InMemoryStore()),
    workitems: deps.workitems ?? (hasDatabase() ? new PgWorkItemStore() : new InMemoryWorkItemStore()),
    loop: deps.loop ?? defaultLoop(),
    sinks: deps.sinks ?? defaultSinks(),
  };
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

// Build the AutopilotAgent both surfaces share, from resolved (or injected) deps.
export function buildAgent(deps: Partial<AutopilotDeps> = {}): { agent: AutopilotAgent; deps: AutopilotDeps } {
  const resolved = resolveDeps(deps);
  const agent = new AutopilotAgent(resolved.embedder, resolved.memory, resolved.workitems, resolved.loop, resolved.sinks);
  return { agent, deps: resolved };
}
