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
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasDatabase } from "./db/client.js";
import { UI_HTML } from "./ui.js";
import { buildAgent, type AutopilotDeps } from "./deps.js";
import { skillCatalog } from "./skills/catalog.js";
import { ConflictError, NotFoundError } from "./agents/autopilot-agent.js";
import { DailyRateLimiter } from "./ap/rate-limit.js";
import {
  defaultExtractionClient,
  validateDocument,
  validateMagicBytes,
  MAX_DOCUMENT_BYTES,
  type ExtractionClient,
  type ExtractionResult,
} from "./qwen/vision.js";
import { scanForInjection } from "./qwen/injection-scan.js";
import { assessRelevance } from "./qwen/relevance.js";
import type { TraceStep, WorkItem } from "./types.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

// The HTTP server shares the exact dependency wiring the MCP server uses (deps.ts),
// so the two surfaces can never drift. It adds one HTTP-only concern the agent does
// not have: the daily upload rate limiter (the open demo's budget guardrail). It is
// injectable so a test can supply a limiter with a low cap + a fake clock.
export type ServerDeps = AutopilotDeps & {
  rateLimiter?: DailyRateLimiter;
  // The document vision-extractor (PDF/PNG/JPG → raw invoice). HTTP-only, like the
  // rate limiter, and injectable so tests supply the offline FakeExtractionClient.
  extractor?: ExtractionClient;
};

// Response bodies are intentionally permissive (`additionalProperties: true`).
// Fastify serializes responses against their schema and STRIPS undeclared fields,
// so a tight schema would silently drop parts of a work item. These stay open so
// nothing is stripped, while still documenting a 200 in /docs.
// The minimal shape of a @fastify/multipart file part we consume. Kept local so the
// route body does not depend on the plugin's exported types (which require the
// FastifyRequest augmentation to be in scope).
interface MultipartFile {
  filename?: string;
  mimetype?: string;
  file?: { truncated?: boolean };
  toBuffer(): Promise<Buffer>;
}

const looseObject = { type: "object", additionalProperties: true } as const;
const errorResponse = {
  type: "object",
  additionalProperties: true,
  properties: { error: { type: "string" } },
} as const;

export async function buildServer(deps: Partial<ServerDeps> = {}) {
  const app = Fastify({ logger: true });

  // Security response headers (HSTS · X-Frame-Options · X-Content-Type-Options ·
  // Referrer-Policy · …). The Content-Security-Policy default is DISABLED on
  // purpose: the approval UI (src/ui.html) and the Swagger UI both rely on inline
  // scripts/styles, which a default CSP would break. The other hardening headers
  // apply to every route.
  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
      : true,
  });

  // A single, typed error envelope for anything that throws past a route handler:
  // never leak a raw stack — always `{ error: <message> }` with a sane status.
  // Explicit `.send({ error })` responses in the routes below are unaffected (they
  // never throw); this catches the rest (e.g. the guard() rethrow path).
  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    req.log.error(err);
    const status =
      typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: err.message || "internal server error" });
  });

  // Real document uploads (POST /intake/document) arrive as multipart/form-data.
  // The fileSize limit is a hard cap enforced by the parser itself — a stream over
  // the limit is truncated and flagged, so an oversized file can never buffer fully
  // into memory (and, checked before the rate limiter, never burns the daily budget).
  await app.register(multipart, { limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 } });

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
  // tests). See src/ap/rate-limit.ts for the 20/day rationale.
  const rateLimiter = deps.rateLimiter ?? new DailyRateLimiter();

  // The document vision-extractor: real Qwen (qwen-vl-max) when a DASHSCOPE key is
  // set, else the deterministic offline FakeExtractionClient — same env-based
  // auto-selection as the loop + embedder, so CI runs the upload path with no key.
  const extractor = deps.extractor ?? defaultExtractionClient();

  // Single-use "process tickets" for the two-step review flow. POST /extract/document
  // consumes ONE daily slot (it runs the expensive vision extraction) and mints a
  // ticket; the follow-up POST /intake/stream may then present that ticket to run the
  // decision loop on the reviewed invoice WITHOUT consuming a second slot. The set is
  // instance-scoped (never a module singleton, exactly like the rate limiter) so
  // tickets never bleed across tests, and each ticket is deleted on first use — so it
  // can never multiply into a free-processing bypass of the open-demo budget guard.
  const processTickets = new Set<string>();

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
      // The loop reaches out to Qwen; a decider/embedder failure is an UPSTREAM
      // dependency error, so surface it as a clean 503 { error } rather than letting
      // it bubble to a generic 500. (The wall-clock deadline inside the loop already
      // turns a *slow* upstream into a graceful flag_for_review; this catches a
      // *failed* one.)
      try {
        return await agent.intake(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "the decision service is unavailable";
        return reply.code(503).send({ error: `the decision service is unavailable: ${msg}` });
      }
    }
  );

  // 1..5 — SAME pipeline as /intake, but STREAMED: the loop's reasoning steps are
  // emitted live as Server-Sent Events (`event: step`), then the final proposal
  // (`event: proposal`) and a close (`event: done`). This backs the UI's "watch the
  // agent work" upload view. The human gate is unchanged — the loop only proposes;
  // nothing executes here.
  app.post<{ Body: { invoice?: Record<string, unknown>; ticket?: string } }>(
    "/intake/stream",
    {
      schema: {
        summary: "Intake a vendor invoice, streaming the reasoning live (SSE)",
        description:
          "Same as POST /intake, but streams each autonomous read/analyze step as a Server-Sent " +
          "Event (`event: step`) as it happens, then `event: proposal` (the full PENDING work item) " +
          "and `event: done`. Nothing executes — it only proposes. Rate-limited like /intake, EXCEPT " +
          "when a valid single-use `ticket` (minted by POST /extract/document) is supplied — the " +
          "extraction already consumed the daily slot, so the reviewed-invoice loop does not consume " +
          "a second one.",
        tags: ["workflow"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            invoice: { type: "object", additionalProperties: true },
            ticket: { type: "string", description: "A single-use process ticket from POST /extract/document (skips the daily limiter)." },
          },
        },
        produces: ["text/event-stream"],
      },
    },
    async (req, reply) => {
      const raw = extractInvoice(req.body);
      if (!raw) return reply.code(400).send({ error: "an invoice payload is required (send { invoice: {...} })" });
      // A valid single-use ticket (from /extract/document) skips the limiter — the
      // extraction already paid the slot. Consume the ticket exactly once. Absent (or
      // unknown) ticket → the normal paste-JSON path consumes the daily budget.
      const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
      const ticketed = ticket !== "" && processTickets.delete(ticket);
      let remaining = -1;
      if (!ticketed) {
        const rl = rateLimiter.consume();
        if (!rl.allowed) return reply.code(429).send(rateLimitError(rl));
        remaining = rl.remaining;
      }

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
        send("start", { message: "processing invoice", remaining });
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

  // Upload a REAL document (PDF / PNG / JPG) → Qwen-VL vision extraction → the SAME
  // multi-step loop, streamed live (SSE). This is the "a judge uploads an actual
  // invoice file, not JSON" path. The order is strict — parse+validate the file, then
  // consume the daily budget, then extract, then loop — so a bad file returns a clean
  // 400/413 and an over-limit upload a 429, and NEITHER ever reaches the vision model
  // or burns the budget. Nothing executes: the loop only proposes (the human gate is
  // unchanged; the extracted invoice runs the identical agent.intake path as /intake).
  app.post(
    "/intake/document",
    {
      schema: {
        summary: "Upload a real invoice document (PDF/PNG/JPG), extract it with Qwen-VL, stream the loop (SSE)",
        description:
          "Accepts a multipart/form-data upload with one `file` field — a PDF, PNG, or JPG vendor " +
          "invoice. A PDF is rasterized (poppler) and the page image(s) plus any image upload are " +
          "read by a Qwen vision model (qwen-vl-max) into a structured invoice, which then runs the " +
          "same multi-step ReAct loop as /intake. Streams `event: extracting` → `event: extracted` " +
          "(the parsed invoice) → `event: step` (each live reasoning step) → `event: proposal` → " +
          "`event: done`. Rate-limited like /intake. Nothing executes — it only proposes.",
        tags: ["workflow"],
        consumes: ["multipart/form-data"],
        produces: ["text/event-stream"],
        response: { 400: errorResponse, 413: errorResponse, 429: errorResponse },
      },
    },
    async (req, reply) => {
      // Parse → validate type+size → consume ONE daily slot, in that strict order
      // (shared with /extract/document via readAndValidateUpload so the two never drift).
      const up = await readAndValidateUpload(req, rateLimiter);
      if (!up.ok) return reply.code(up.status).send(up.body);
      const { filename, mimetype, buffer, remaining } = up;

      // Take over the socket and stream: extract → the live loop → the proposal.
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
        send("start", { message: "document received", filename, remaining });
        send("extracting", { message: `Extracting document with Qwen-VL (${extractor.modelId})…`, model: extractor.modelId });
        const extracted = await extractor.extract({ buffer, filename, mimetype });
        // Advisory input-safety scan (injection detection + relevance). It does NOT
        // change the decision — the fence already neutralized any injection and the
        // human gate is unchanged; it only makes the neutralized attack VISIBLE.
        const safety = inputSafety(extracted);
        send("extracted", {
          message: "Document extracted — running the decision loop.",
          model: extracted.model,
          pages: extracted.pages,
          sourceType: extracted.sourceType,
          invoice: extracted.invoice,
          security: safety.security,
          relevance: safety.relevance,
        });
        // Surface a NEUTRALIZED prompt-injection as its own live trace event so it
        // shows in the stream. Advisory: the loop below still runs unchanged.
        if (safety.security.injectionDetected) {
          send("security", {
            message: `⚠️ This document contained ${safety.security.injectionCount} suspected injected instruction(s) — shown as data, never followed.`,
            ...safety.security,
          });
        }
        const item = await agent.intake(extracted.invoice, { onStep: (step: TraceStep) => send("step", step) });
        send("proposal", item);
        send("done", { id: item.id });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "document extraction failed" });
      } finally {
        res.end();
      }
    }
  );

  // EXTRACT-ONLY — the first half of the two-step review flow. Upload a REAL document
  // (PDF/PNG/JPG) → validate → consume ONE daily slot → Qwen-VL vision extraction →
  // return the extracted invoice JSON for the human to REVIEW. It runs NO decision
  // loop and proposes nothing. It mints a single-use `ticket`; the UI then posts the
  // reviewed invoice to POST /intake/stream WITH that ticket, which runs the loop
  // without consuming a second slot. Same strict order as /intake/document — parse +
  // validate the file, THEN consume budget, THEN extract — so a bad file is a clean
  // 400/413 that never costs a slot and never reaches the vision model.
  app.post(
    "/extract/document",
    {
      schema: {
        summary: "Upload a real invoice document (PDF/PNG/JPG) and extract it with Qwen-VL for human review (no loop)",
        description:
          "Accepts a multipart/form-data upload with one `file` field — a PDF, PNG, or JPG vendor " +
          "invoice — validates it, consumes one daily slot, runs Qwen-VL (qwen-vl-max) vision " +
          "extraction, and returns the structured invoice for review PLUS a single-use `ticket`. It " +
          "runs NO decision loop and executes nothing; the reviewed invoice is then processed via " +
          "POST /intake/stream (presenting the ticket, so it does not consume a second slot).",
        tags: ["workflow"],
        consumes: ["multipart/form-data"],
        response: { 200: looseObject, 400: errorResponse, 413: errorResponse, 429: errorResponse, 502: errorResponse },
      },
    },
    async (req, reply) => {
      // Parse → validate type+size → consume ONE daily slot, in that strict order
      // (shared with /intake/document via readAndValidateUpload so the two never drift).
      const up = await readAndValidateUpload(req, rateLimiter);
      if (!up.ok) return reply.code(up.status).send(up.body);
      const { filename, mimetype, buffer, remaining } = up;

      // Extract with Qwen-VL (or the offline fake). NO decision loop runs here.
      try {
        const extracted = await extractor.extract({ buffer, filename, mimetype });
        // Advisory input-safety scan surfaced for the human reviewer: whether the
        // document carried a (neutralized) prompt-injection, and whether it even looks
        // like an invoice. Neither changes the flow — the reviewer still decides.
        const safety = inputSafety(extracted);
        // Mint a single-use ticket so the follow-up /intake/stream skips the limiter.
        const ticket = randomUUID();
        processTickets.add(ticket);
        return {
          filename,
          model: extracted.model,
          pages: extracted.pages,
          sourceType: extracted.sourceType,
          invoice: extracted.invoice,
          ticket,
          remaining,
          security: safety.security,
          relevance: safety.relevance,
        };
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : "document extraction failed" });
      }
    }
  );

  // Serve the committed demo document so the UI's "Use sample document" button can
  // upload a REAL invoice file through the exact vision path a judge would use.
  // Read from disk once per request (small file); hidden from the OpenAPI spec.
  app.get("/sample-document", { schema: { hide: true } }, async (_req, reply) => {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const png = await readFile(join(here, "..", "demo", "sample-invoice.png"));
      return reply
        .type("image/png")
        .header("content-disposition", 'inline; filename="sample-invoice.png"')
        .send(png);
    } catch {
      return reply.code(404).send({ error: "sample document not found" });
    }
  });

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
    async () => ({ pending: (await agent.pending()).map(withReviewFlags) })
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

// The parsed-and-validated result of a document upload, or a ready-to-send error.
// Shared by BOTH multipart routes (/intake/document + /extract/document) so their
// strict order — parse the file, validate type+size, THEN consume the daily budget —
// can never drift between the two.
type UploadResult =
  | { ok: true; filename: string; mimetype: string; buffer: Buffer; remaining: number }
  | { ok: false; status: 400 | 413 | 429; body: Record<string, unknown> };

// Parse the multipart file, validate it, and consume ONE daily slot — in that exact
// order, so a bad/oversized file returns a clean 400/413 and never costs a slot, and
// an over-limit upload returns 429. The caller sends `{ error }` on !ok, else proceeds.
async function readAndValidateUpload(req: unknown, rateLimiter: DailyRateLimiter): Promise<UploadResult> {
  // 1) Parse the multipart file. A non-multipart request or a missing file part
  //    is a 400 — before anything is consumed.
  let filename = "";
  let mimetype = "";
  let buffer: Buffer;
  try {
    const part = await (req as { file: () => Promise<MultipartFile | undefined> }).file();
    if (!part) return { ok: false, status: 400, body: { error: "no file uploaded — attach one PDF, PNG, or JPG in the `file` field" } };
    filename = part.filename ?? "";
    mimetype = part.mimetype ?? "";
    buffer = await part.toBuffer();
    // The parser truncates a stream past the fileSize cap; treat that as 413.
    if (part.file?.truncated) {
      return { ok: false, status: 413, body: { error: `document too large — the limit is ${MAX_DOCUMENT_BYTES} bytes` } };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/file too large|reached size limit|FST_REQ_FILE_TOO_LARGE|maxFileSize/i.test(msg)) {
      return { ok: false, status: 413, body: { error: `document too large — the limit is ${MAX_DOCUMENT_BYTES} bytes` } };
    }
    return { ok: false, status: 400, body: { error: `could not read the upload as multipart/form-data: ${msg}` } };
  }

  // 2) Validate type + size BEFORE consuming budget (a bad file must not cost a slot).
  const v = validateDocument({ filename, mimetype, size: buffer.length });
  if (!v.ok) return { ok: false, status: v.status, body: { error: v.error } };

  // 2b) Magic-byte sniff — the real bytes must match the CLAIMED type (a `.pdf` that
  //     is actually a PNG is rejected here). Also before budget, so a disguised file
  //     never costs a slot.
  const mb = validateMagicBytes(buffer, v.ext);
  if (!mb.ok) return { ok: false, status: mb.status, body: { error: mb.error } };

  // 3) Consume the daily budget (429 when the cap is reached).
  const rl = rateLimiter.consume();
  if (!rl.allowed) return { ok: false, status: 429, body: rateLimitError(rl) };

  return { ok: true, filename, mimetype, buffer, remaining: rl.remaining };
}

// Advisory input-safety summary for an uploaded document. Runs the read-only
// prompt-injection scan + the relevance gate over the vision-extracted invoice.
// ADVISORY ONLY — NEITHER changes behavior: the decider fence has already
// neutralized any injection (it lands as fenced DATA), and an irrelevant document
// still goes to the human gate. This only SURFACES what was found, so the response,
// the live trace, and the approval UI can SHOW the neutralized attack.
function inputSafety(extracted: ExtractionResult): {
  security: {
    injectionDetected: boolean;
    injectionCount: number;
    matches: ReturnType<typeof scanForInjection>["matches"];
    neutralized: true;
  };
  relevance: { relevant: boolean; reason: string };
} {
  const scan = scanForInjection(extracted.invoice as Record<string, unknown>);
  return {
    security: {
      injectionDetected: scan.detected,
      injectionCount: scan.count,
      matches: scan.matches,
      neutralized: true, // the fence already made it inert — this block just reports it
    },
    relevance: assessRelevance(extracted.invoice),
  };
}

// The review-nudge threshold. A proposal whose model-self-reported confidence is
// below this gets a visible "review carefully" flag in /pending + the approval UI.
// This is NOT a calibrated probability — the confidence is the model's own number
// (clamped 0..1 in the loop); the flag is only a prompt to look closer before
// approving. Tunable via LOW_CONFIDENCE_THRESHOLD.
export const LOW_CONFIDENCE_THRESHOLD = Number(process.env.LOW_CONFIDENCE_THRESHOLD || 0.5);

// Attach derived, read-only review flags to a pending item for the approval surface.
// Adds `lowConfidence` (see the threshold above). Does NOT mutate the stored item or
// change any decision — advisory presentation only.
export function withReviewFlags(item: WorkItem): WorkItem & { lowConfidence: boolean } {
  const c = item.proposed?.confidence;
  const lowConfidence = typeof c === "number" && c < LOW_CONFIDENCE_THRESHOLD;
  return { ...item, lowConfidence };
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
// already-decided item → 409 (the approval gate). A malformed `:id` that reaches the
// pgvector store (the id column is a uuid) surfaces as Postgres error 22P02 —
// "invalid input syntax for type uuid" — which is a client mistake, so we return a
// clean 400 rather than leaking a 500 DB error. Anything else bubbles to the global
// error handler (a typed { error } 500).
async function guard<T>(reply: import("fastify").FastifyReply, fn: () => Promise<T>): Promise<T | void> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
    if (isInvalidUuidError(err)) {
      return reply.code(400).send({ error: "invalid work item id — expected a UUID" });
    }
    throw err;
  }
}

// True for the Postgres "invalid input syntax for type uuid" error (SQLSTATE 22P02),
// raised when a non-UUID :id reaches the uuid-typed ap_workitems.id column.
function isInvalidUuidError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    e?.code === "22P02" ||
    (typeof e?.message === "string" && /invalid input syntax for type uuid/i.test(e.message))
  );
}

/* c8 ignore start -- process bootstrap: only runs when invoked as the entrypoint (`npm start`), never under test */
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
/* c8 ignore stop */
