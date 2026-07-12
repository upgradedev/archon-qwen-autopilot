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
//     unchanged human gate); absent → the in-memory Fake email sink. Ledger / payment
//     / review sinks are always the in-memory Fakes.

import { defaultEmbedder, type Embedder } from "./memory/embeddings.js";
import { InMemoryStore, PgVectorStore, type MemoryStore } from "./memory/store.js";
import { InMemoryWorkItemStore, PgWorkItemStore, type WorkItemStore } from "./ap/workitem-store.js";
import { defaultLoop, type AutopilotLoop } from "./ap/loop.js";
import { fakeSinks, type Sinks } from "./ap/sinks.js";
import { SmtpEmailSink } from "./ap/smtp-sink.js";
import { hasDatabase } from "./db/client.js";
import { AutopilotAgent } from "./agents/autopilot-agent.js";

// The default sink bundle: in-memory Fakes for ledger / payment / reviews, plus a
// REAL SMTP email sink when SMTP_HOST is configured (otherwise the Fake email sink).
// Only the email sink varies — the human gate in front of every sink is identical.
export function defaultSinks(): Sinks {
  const sinks = fakeSinks();
  const smtp = SmtpEmailSink.fromEnv();
  if (smtp) sinks.email = smtp;
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
  return {
    embedder: deps.embedder ?? defaultEmbedder(),
    memory: deps.memory ?? (hasDatabase() ? new PgVectorStore() : new InMemoryStore()),
    workitems: deps.workitems ?? (hasDatabase() ? new PgWorkItemStore() : new InMemoryWorkItemStore()),
    loop: deps.loop ?? defaultLoop(),
    sinks: deps.sinks ?? defaultSinks(),
  };
}

// Build the AutopilotAgent both surfaces share, from resolved (or injected) deps.
export function buildAgent(deps: Partial<AutopilotDeps> = {}): { agent: AutopilotAgent; deps: AutopilotDeps } {
  const resolved = resolveDeps(deps);
  const agent = new AutopilotAgent(resolved.embedder, resolved.memory, resolved.workitems, resolved.loop, resolved.sinks);
  return { agent, deps: resolved };
}
