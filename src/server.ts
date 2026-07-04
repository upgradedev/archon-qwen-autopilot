// HTTP backend for Archon Autopilot — the autonomous accounts-payable agent.
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
import { defaultEmbedder, type Embedder } from "./memory/embeddings.js";
import { InMemoryStore, PgVectorStore, type MemoryStore } from "./memory/store.js";
import { InMemoryWorkItemStore, PgWorkItemStore, type WorkItemStore } from "./ap/workitem-store.js";
import { defaultDecider, QwenDecider } from "./ap/decider.js";
import { fakeSinks, type Sinks } from "./ap/sinks.js";
import { hasDatabase } from "./db/client.js";
import {
  AutopilotAgent,
  ConflictError,
  NotFoundError,
} from "./agents/autopilot-agent.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export interface ServerDeps {
  embedder: Embedder;
  memory: MemoryStore;
  workitems: WorkItemStore;
  decider: QwenDecider;
  sinks: Sinks;
}

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
          "HTTP API for Archon Autopilot — an autonomous accounts-payable agent. It " +
          "ingests a messy vendor invoice, validates it, recalls the vendor's history " +
          "from a persistent pgvector memory (the Track-1 MemoryAgent foundation), and " +
          "uses Qwen function-calling to PROPOSE one AP action. Every proposal waits " +
          "behind a human approval gate: approve to execute for real, amend to edit " +
          "then execute, or reject to discard. On approval the outcome is written back " +
          "to memory so the agent gets smarter over time.",
        version: pkg.version,
      },
      tags: [
        { name: "health", description: "Liveness probe" },
        { name: "workflow", description: "Intake an invoice and run the decision loop" },
        { name: "approval", description: "The human-in-the-loop approval gate" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // Wire dependencies. Defaults: real embedder/decider auto-select Qwen vs Fakes
  // by env; the stores use pgvector when DATABASE_URL is set, else in-memory.
  const embedder = deps.embedder ?? defaultEmbedder();
  const memory = deps.memory ?? (hasDatabase() ? new PgVectorStore() : new InMemoryStore());
  const workitems = deps.workitems ?? (hasDatabase() ? new PgWorkItemStore() : new InMemoryWorkItemStore());
  const decider = deps.decider ?? defaultDecider();
  const sinks = deps.sinks ?? fakeSinks();
  const agent = new AutopilotAgent(embedder, memory, workitems, decider, sinks);

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
      decider: decider.modelId,
      store: hasDatabase() ? "pgvector" : "in-memory",
    })
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
          "Normalizes + validates it, recalls the vendor's history from memory, then uses Qwen " +
          "function-calling to propose ONE action. Returns the PENDING work item — nothing executes yet.",
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
      const body = req.body ?? {};
      // Accept either { invoice: {...} } or a bare invoice object.
      const raw = body.invoice && typeof body.invoice === "object" ? body.invoice : body;
      if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
        return reply.code(400).send({ error: "an invoice payload is required (send { invoice: {...} })" });
      }
      const item = await agent.intake(raw as Record<string, unknown>);
      return item;
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
