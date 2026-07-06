// HTTP backend for Archon Autopilot — the human-gated accounts-payable agent.
//
// This is the service that runs ON ALIBABA CLOUD (Function Compute custom
// container, or ECS / Container Service). It is a thin HTTP shell around the
// AutopilotAgent, exposing the AP workflow and its human-in-the-loop gate:
//
//   GET  /health         — liveness probe (no DB / no key needed)
//   POST /intake         — an incoming vendor invoice → validate + recall +
//                          Qwen-decide → a PENDING proposed action (no execution)
//   GET  /pending        — the human approval queue
//   POST /approve/:id    — a human approves → the tool executes for real
//   POST /amend/:id      — a human edits the args, then approves → the amended
//                          args are what execute
//   POST /reject/:id     — a human discards the proposal → nothing executes
//
// Dependencies are injectable via buildServer(deps) so the whole loop runs
// offline (in-memory stores + FakeQwenChatClient) in CI, and against real Qwen +
// a pgvector database in production, unchanged. Absent a DATABASE_URL the server
// falls back to in-memory stores; absent a DASHSCOPE_API_KEY it uses the Fakes.

import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { hasDatabase } from "./db/client.js";
import { UI_HTML } from "./ui.js";
import { buildAgent, type AutopilotDeps } from "./deps.js";
import { skillCatalog } from "./skills/catalog.js";
import { ConflictError, NotFoundError } from "./agents/autopilot-agent.js";
import { DailyRateLimiter } from "./ap/rate-limit.js";
import type { TraceStep } from "./types.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// The HTTP server shares the exact dependency wiring the MCP server uses (deps.ts),
// so the two surfaces can never drift. It adds one HTTP-only concern the agent does
// not have: the daily upload rate limiter (the open demo's budget guardrail). It is
// injectable so a test can supply a limiter with a low cap + a fake clock.
export type ServerDeps = AutopilotDeps & { rateLimiter?: DailyRateLimiter };

// Response bodies are intentionally permissive (`additionalProperties: true`).
// Fastify serializes responses against their schema and STRIPS undeclared fields,
// so a tight schema would silently drop parts of a work item. These stay open so
// nothing is stripped, while still documenting a 200 in /docs.
const looseObject = { type: "object", additionalProperties: true } as const;
const errorResponse = {
  type: "object",
  additionalProperties: true,
  properties: { error: { type: "string" } },
} as const;

export async function buildServer(deps: Partial<ServerDeps> = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : true,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Archon Autopilot API",
        description:
          "HTTP API for Archon Autopilot — a human-gated accounts-payable agent. It " +
          "ingests a messy vendor invoice and runs a bounded MULTI-STEP ReAct loop " +
          "(Qwen function-calling): the agent autonomously recalls the vendor's history " +
          "from a persistent pgvector memory (the Track-1 MemoryAgent foundation), " +
          "validates, checks for a duplicate, and computes the amount variance — each a " +
          "read/analyze step with no side-effect — before proposing ONE terminal AP " +
          "action. Nothing executes until a human approves: every terminal action waits " +
          "behind a human approval gate — approve to execute the exact proposed args for " +
          "real, amend to edit then execute, or reject to discard. The full step trace is " +
          "persisted so a human can see HOW the agent decided. On approval the outcome is " +
          "written back to memory so the next decision for that vendor is better grounded. " +
          "The execution sinks are simulated in-memory adapters (interfaces ready for real " +
          "ledger / SMTP / payment adapters); the loop and the read/analyze tools + memory " +
          "grounding are real.",
        version: pkg.version,
      },
      tags: [
        { name: "health", description: "Liveness probe" },
        { name: "workflow", description: "Intake an invoice and run the decision loop" },
        { name: "approval", description: "The human-in-the-loop approval gate" },
        { name: "skills", description: "Introspect the custom Qwen skill catalog" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // The human approval UI — a single static page served by this same backend.
  // It drives the queue (/pending) and the gate (/approve · /amend · /reject)
  // from the browser, same-origin. Hidden from the OpenAPI spec (it is a page,
  // not an API route). Both `/` and `/ui` serve it.
  const serveUi = async (_req: unknown, reply: import("fastify").FastifyReply) =>
    reply.type("text/html").send(UI_HTML);
  app.get("/", { schema: { hide: true } }, serveUi);
  app.get("/ui", { schema: { hide: true } }, serveUi);

  // Wire dependencies via the SHARED resolver (deps.ts) — the same one the MCP
  // server uses, so both surfaces drive an identically-wired AutopilotAgent.
  // Defaults: real embedder/loop auto-select Qwen vs Fakes by env; the stores use
  // pgvector when DATABASE_URL is set, else in-memory.
  const { agent, deps: resolved } = buildAgent(deps);
  const { embedder, loop } = resolved;

  // The open demo's budget guardrail: invoice uploads are capped per UTC day. Built
  // per server instance (never a module singleton, so counts never bleed across
  // tests). See src/ap/rate-limit.ts for the 10/day rationale.
  const rateLimiter = deps.rateLimiter ?? new DailyRateLimiter();

  app.get(
    "/health",
    {
      schema: {
        summary: "Liveness probe",
        description: "Reports liveness plus the live embedder + decision model ids. No DB, no key.",
        tags: ["health"],
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              status: { type: "string" },
              embedder: { type: "string" },
              decider: { type: "string" },
              store: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok",
      embedder: embedder.modelId,
      decider: loop.modelId,
      store: hasDatabase() ? "pgvector" : "in-memory",
    })
  );

  // Introspect the custom Qwen skill catalog — the SAME function schemas the
  // qwen-plus decider chooses from, annotated with tier / gate / rule. Mirrors the
  // MCP list_skills tool, so the skill set is introspectable over HTTP too.
  app.get(
    "/skills",
    {
      schema: {
        summary: "The custom Qwen skill catalog",
        description:
          "Lists every custom Qwen skill (OpenAI-compatible function schema) the decider can " +
          "choose from — autonomous read/analyze skills (side-effect-free, run inside the loop) " +
          "and terminal skills (human-gated) — each annotated with tier, gate, the R1–R6 rule it " +
          "owns, and its parameters. Read-only.",
        tags: ["skills"],
        response: { 200: looseObject },
      },
    },
    async () => skillCatalog()
  );

  // 1..5 — intake → validate → recall → Qwen-decide → PENDING (no execution).
  // The body schema is deliberately permissive: real invoices are messy, so
  // validation belongs in the pipeline (normalize + R1..R6), not the HTTP schema.
  app.post<{ Body: { invoice?: Record<string, unknown> } }>(
    "/intake",
    {
      schema: {
        summary: "Intake a vendor invoice",
        description:
          "Accepts an incoming vendor invoice (structured JSON, fields may be missing/ambiguous). " +
          "Normalizes it, then runs the multi-step ReAct loop (recall history → validate → check " +
          "duplicate → compute variance, as needed) before Qwen proposes ONE terminal action. " +
          "Returns the PENDING work item — including the full step trace — and nothing executes yet.",
        tags: ["workflow"],
        body: {
          type: "object",
          additionalProperties: true,
          description: "Either { invoice: {...} } or the raw invoice object itself.",
          properties: { invoice: { type: "object", additionalProperties: true } },
        },
        response: { 200: looseObject, 400: errorResponse },
      },
    },
    async (req, reply) => {
      // Order matters: validate the payload FIRST (a 400 must not burn budget), then
      // check-and-consume the daily limiter (429 when the cap is reached), then run
      // the loop. So an invalid or over-limit upload never reaches the agent.
      const raw = extractInvoice(req.body);
      if (!raw) return reply.code(400).send({ error: "an invoice payload is required (send { invoice: {...} })" });
      const rl = rateLimiter.consume();
      if (!rl.allowed) return reply.code(429).send(rateLimitError(rl));
      return agent.intake(raw);
    }
  );

  // 1..5 — SAME pipeline as /intake, but STREAMED: the loop's reasoning steps are
  // emitted live as Server-Sent Events (`event: step`), then the final proposal
  // (`event: proposal`) and a close (`event: done`). This backs the UI's "watch the
  // agent work" upload view. The human gate is unchanged — the loop only proposes;
  // nothing executes here.
  app.post<{ Body: { invoice?: Record<string, unknown> } }>(
    "/intake/stream",
    {
      schema: {
        summary: "Intake a vendor invoice, streaming the reasoning live (SSE)",
        description:
          "Same as POST /intake, but streams each autonomous read/analyze step as a Server-Sent " +
          "Event (`event: step`) as it happens, then `event: proposal` (the full PENDING work item) " +
          "and `event: done`. Nothing executes — it only proposes. Rate-limited like /intake.",
        tags: ["workflow"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: { invoice: { type: "object", additionalProperties: true } },
        },
        produces: ["text/event-stream"],
      },
    },
    async (req, reply) => {
      const raw = extractInvoice(req.body);
      if (!raw) return reply.code(400).send({ error: "an invoice payload is required (send { invoice: {...} })" });
      const rl = rateLimiter.consume();
      if (!rl.allowed) return reply.code(429).send(rateLimitError(rl));

      // Take over the raw socket and speak text/event-stream by hand.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      try {
        send("start", { message: "processing invoice", remaining: rl.remaining });
        const item = await agent.intake(raw, { onStep: (step: TraceStep) => send("step", step) });
        send("proposal", item);
        send("done", { id: item.id });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "intake failed" });
      } finally {
        res.end();
      }
    }
  );

  app.get(
    "/pending",
    {
      schema: {
        summary: "The approval queue",
        description: "Lists the proposed actions awaiting a human decision (oldest first).",
        tags: ["approval"],
        response: { 200: looseObject },
      },
    },
    async () => ({ pending: await agent.pending() })
  );

  app.get(
    "/decided",
    {
      schema: {
        summary: "The decided history",
        description:
          "Lists every work item a human has already decided — approved, amended, or rejected — " +
          "most-recently-decided first, each with its outcome, decision timestamp, and (for an " +
          "amended item) the prev → new amend audit trail. Read-only: decided items never re-execute.",
        tags: ["approval"],
        response: { 200: looseObject },
      },
    },
    async () => ({ decided: await agent.decided() })
  );

  app.post<{ Params: { id: string } }>(
    "/approve/:id",
    {
      schema: {
        summary: "Approve a proposed action",
        description: "A human approves the proposal → the chosen tool executes for real and the outcome is written back to memory.",
        tags: ["approval"],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) => guard(reply, () => agent.approve(req.params.id))
  );

  app.post<{ Params: { id: string }; Body: { args?: Record<string, unknown>; reason?: string } }>(
    "/amend/:id",
    {
      schema: {
        summary: "Amend then approve a proposed action",
        description:
          "A human edits the proposed DOMAIN arguments and approves → the amended args are EXACTLY what execute. " +
          "Body: { args: { ...edited fields }, reason?: string }.",
        tags: ["approval"],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            args: { type: "object", additionalProperties: true, description: "Edited domain arguments, merged onto the proposal." },
            reason: { type: "string", description: "Why the proposal was amended." },
          },
        },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) => guard(reply, () => agent.amend(req.params.id, req.body ?? {}))
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/reject/:id",
    {
      schema: {
        summary: "Reject a proposed action",
        description: "A human discards the proposal → nothing executes. The rejection is remembered.",
        tags: ["approval"],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: true,
          properties: { reason: { type: "string", description: "Why the proposal was rejected." } },
        },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) => guard(reply, () => agent.reject(req.params.id, req.body?.reason))
  );

  return app;
}

// Accept either { invoice: {...} } or a bare invoice object; return the invoice
// record, or null when there is no usable payload (→ 400). Shared by /intake +
// /intake/stream so both validate identically.
function extractInvoice(body: unknown): Record<string, unknown> | null {
  const b = (body ?? {}) as { invoice?: unknown };
  const raw = b.invoice && typeof b.invoice === "object" ? b.invoice : b;
  if (!raw || typeof raw !== "object" || Object.keys(raw as object).length === 0) return null;
  return raw as Record<string, unknown>;
}

// The 429 body for an over-limit upload — states the cap explicitly so the caller
// (and the UI) can show a clear "come back tomorrow" message.
function rateLimitError(rl: { limit: number; day: string }): { error: string; limit: number; day: string } {
  return {
    error: `daily upload limit reached (${rl.limit}/day, UTC). This is an open demo — the cap protects the Qwen API budget. Resets at 00:00 UTC.`,
    limit: rl.limit,
    day: rl.day,
  };
}

// Map the agent's domain errors to HTTP status codes: unknown id → 404, an
// already-decided item → 409 (the approval gate). Anything else bubbles to
// Fastify's default 500.
async function guard<T>(reply: import("fastify").FastifyReply, fn: () => Promise<T>): Promise<T | void> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
    throw err;
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 9000);
  buildServer()
    .then((app) => app.listen({ host: "0.0.0.0", port }))
    .then((addr) => console.log(`archon-qwen-autopilot listening on ${addr}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
