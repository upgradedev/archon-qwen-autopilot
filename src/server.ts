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

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isIP } from "node:net";
import { hasDatabase, query } from "./db/client.js";
import { UI_HTML } from "./ui.js";
import { buildAgent, type AutopilotDeps } from "./deps.js";
import { skillCatalog } from "./skills/catalog.js";
import {
  AutopilotAgent,
  ConflictError,
  ExecutionUncertainError,
  NotFoundError,
} from "./agents/autopilot-agent.js";
import { InvalidToolArgsError } from "./ap/tools.js";
import {
  DailyRateLimiter,
  PostgresDailyRateLimiter,
  DEFAULT_REVIEWER_DAILY_UPLOAD_LIMIT,
  DEFAULT_REVIEWER_GLOBAL_DAILY_UPLOAD_LIMIT,
  type RateLimitResult,
  type UploadRateLimiter,
} from "./ap/rate-limit.js";
import {
  defaultExtractionClient,
  validateDocument,
  validateMagicBytes,
  validateImageDimensions,
  DocumentPageLimitError,
  MAX_PDF_PAGES,
  MAX_DOCUMENT_BYTES,
  type ExtractionClient,
  type ExtractionResult,
} from "./qwen/vision.js";
import { scanForInjection } from "./qwen/injection-scan.js";
import { assessRelevance } from "./qwen/relevance.js";
import {
  EXTRACTION_REVIEW_THRESHOLD,
  hasInferredPayableTotal,
  hasLowExtractionConfidence,
} from "./ap/extraction-confidence.js";
import { hasQwenCreds } from "./qwen/client.js";
import { InMemoryStore } from "./memory/store.js";
import { InMemoryWorkItemStore } from "./ap/workitem-store.js";
import { fakeSinks } from "./ap/sinks.js";
import type { ToolName, TraceStep, WorkItem } from "./types.js";
import { safeOperationalSummary, toSafeOperationalError } from "./security/operational-error.js";
import {
  defaultProviderRunAdmission,
  defaultDocumentRenderAdmission,
  type DocumentRenderAdmission,
  type DocumentRenderLease,
  type ProviderRunAdmission,
  type ProviderRunLease,
} from "./ap/provider-admission.js";
import {
  InMemoryProcessTicketStore,
  PgProcessTicketStore,
  ProcessTicketCapacityError,
  type ProcessTicketStore,
} from "./ap/process-ticket-store.js";
import {
  InMemoryHttpRequestRateLimiter,
  type HttpRequestRateLimiter,
} from "./ap/http-rate-limit.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers['x-reviewer-token']",
  "request.headers.authorization",
  "request.headers['x-reviewer-token']",
  "headers.authorization",
  "headers['x-reviewer-token']",
  "req.headers['x-archon-deployment-gate']",
  "request.headers['x-archon-deployment-gate']",
  "headers['x-archon-deployment-gate']",
  "authorization",
  "reviewerToken",
  "reviewer_token",
  "token",
] as const;

function inlineTagHashes(html: string, tag: "style" | "script"): string[] {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...html.matchAll(regex)].map(
    // HTML parsing normalizes CRLF/CR to LF before the browser verifies an inline
    // CSP hash. Normalize here too, otherwise the Windows checkout serves valid
    // markup whose hash was calculated over different bytes and the whole UI script
    // is silently blocked.
    (match) =>
      `'sha256-${createHash("sha256")
        .update((match[1] ?? "").replace(/\r\n?/g, "\n"), "utf8")
        .digest("base64")}'`
  );
}

// Hash-based policy keeps the self-contained single-file UI while rejecting any
// injected inline script/style or event-handler attribute. Swagger remains on its
// separate /docs surface and is unaffected by this route-specific policy.
export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${inlineTagHashes(UI_HTML, "script").join(" ")}`,
  "script-src-attr 'none'",
  `style-src 'self' ${inlineTagHashes(UI_HTML, "style").join(" ")}`,
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

// The HTTP server shares the exact dependency wiring the MCP server uses (deps.ts),
// so the two surfaces can never drift. It adds one HTTP-only concern the agent does
// not have: the daily upload rate limiter (the open demo's budget guardrail). It is
// injectable so a test can supply a limiter with a low cap + a fake clock.
export type ServerDeps = AutopilotDeps & {
  // Test/in-process override. Production resolves the same bounded shape from
  // TRUST_PROXY_ADDRESSES or TRUST_PROXY_HOPS; false is the secure default.
  trustProxy?: TrustProxySetting;
  rateLimiter?: UploadRateLimiter;
  // Separate bounded capacity for a caller presenting the valid reviewer token.
  // Public traffic can never consume it; it is not an unlimited bypass.
  reviewerRateLimiter?: UploadRateLimiter;
  // Process-wide, zero-wait Qwen workflow capacity. Public and reviewer pools are
  // isolated; tests may inject a small deterministic pool.
  providerAdmission?: ProviderRunAdmission;
  // Aggregate document extraction/render capacity shared across both provider
  // tiers, bounding worst-case Poppler/base64 memory per process.
  documentAdmission?: DocumentRenderAdmission;
  // The document vision-extractor (PDF/PNG/JPG → raw invoice). HTTP-only, like the
  // rate limiter, and injectable so tests supply the offline FakeExtractionClient.
  extractor?: ExtractionClient;
  // HTTP reviewer boundary. Undefined reads the environment; null/empty means
  // deliberately unconfigured and therefore fail-closed (503 on reviewer APIs).
  reviewerToken?: string | null;
  reviewerName?: string;
  corsOrigins?: string[];
  // Bounded one-shot ticket controls for upload→review→process. Injectable clock
  // and limits make expiry/cap behavior deterministic in tests.
  processTicketNow?: () => Date;
  processTicketTtlMs?: number;
  processTicketClaimTtlMs?: number;
  processTicketCap?: number;
  processTicketStore?: ProcessTicketStore;
  // Optional test log destination; production uses stdout with the same redaction.
  loggerStream?: { write(msg: string): void };
  // Coarse all-route abuse guard. Durable daily quotas still meter provider spend.
  httpRateLimiter?: HttpRequestRateLimiter;
  httpRequestLimits?: { public: number; reviewer: number; global: number };
  // Production cutovers mount a root-owned, read-only release-gate directory.
  // Tests inject a contained fixture. The bypass is used only by the deployment
  // smoke while every ordinary business route remains fail-closed.
  deploymentGateDir?: string | null;
  deploymentGateToken?: string | null;
};

export type TrustProxySetting = false | number | string[];

export function configuredTrustProxy(env: NodeJS.ProcessEnv = process.env): TrustProxySetting {
  const addresses = env.TRUST_PROXY_ADDRESSES?.trim() ?? "";
  const hops = env.TRUST_PROXY_HOPS?.trim() ?? "";
  if (addresses && hops) throw new Error("configure only one of TRUST_PROXY_ADDRESSES or TRUST_PROXY_HOPS");
  if (hops) {
    if (!/^[1-3]$/.test(hops)) throw new Error("TRUST_PROXY_HOPS must be an integer from 1 to 3");
    return Number(hops);
  }
  if (!addresses) return false;
  const entries = addresses.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry) || entries.length > 16 || entries.some((entry) => !validProxyAddress(entry))) {
    throw new Error("TRUST_PROXY_ADDRESSES must contain 1–16 comma-separated IP or CIDR values");
  }
  return entries;
}

function validProxyAddress(value: string): boolean {
  if (isIP(value)) return true;
  const slash = value.lastIndexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  const version = isIP(address);
  if (!version || !/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (version === 4 ? 32 : 128);
}

type QuotaTier = "public" | "reviewer";
interface BudgetIdentity {
  tier: QuotaTier;
  binding: string;
  day: string;
}

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
const queuePageQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      anyOf: [
        { type: "integer", minimum: 1, maximum: 500 },
        { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$" },
      ],
      default: "100",
    },
    offset: {
      anyOf: [
        { type: "integer", minimum: 0, maximum: 1_000_000 },
        { type: "string", pattern: "^(?:0|[1-9][0-9]{0,5}|1000000)$" },
      ],
      default: "0",
    },
  },
} as const;
const errorResponse = {
  type: "object",
  additionalProperties: true,
  properties: { error: { type: "string" }, requestId: { type: "string" } },
} as const;

function queuePage(query: { limit?: number | string; offset?: number | string }): { limit: number; offset: number } {
  const parsedLimit = Number(query.limit ?? 100);
  const parsedOffset = Number(query.offset ?? 0);
  return {
    limit: Math.max(1, Math.min(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 100, 500)),
    offset: Math.max(0, Math.min(Number.isFinite(parsedOffset) ? Math.trunc(parsedOffset) : 0, 1_000_000)),
  };
}

function pageEnvelope(
  page: { limit: number; offset: number },
  returned: number
): { limit: number; offset: number; returned: number; nextOffset: number | null } {
  return {
    ...page,
    returned,
    nextOffset: returned === page.limit ? page.offset + returned : null,
  };
}

const DEPLOYMENT_GATE_CONTRACT = "archon-release-gate-v1\n";
const DEPLOYMENT_GATE_HEADER = "x-archon-deployment-gate";
const DEPLOYMENT_GATE_PROBE_PATHS = new Set(["/health", "/ready", "/ready/deep"]);

async function deploymentGateOpen(directory: string): Promise<boolean> {
  let contract: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // One directory read gives a fail-closed view: exactly the attested contract
    // file means open; the closed marker or any unexpected entry means closed.
    // Re-check every request so rollback can re-close a candidate before the old
    // release is exposed again.
    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== "contract") return false;
    const contractPath = join(directory, "contract");
    // Open once and perform both the type check and content read through that
    // immutable descriptor. O_NOFOLLOW rejects a swapped symlink on the Linux
    // production runtime; descriptor-relative fstat/read removes the check/use
    // race even if the directory entry is replaced after open().
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    contract = await open(contractPath, fsConstants.O_RDONLY | noFollow);
    const metadata = await contract.stat();
    if (!metadata.isFile()) return false;
    return await contract.readFile({ encoding: "utf8" }) === DEPLOYMENT_GATE_CONTRACT;
  } catch {
    return false;
  } finally {
    await contract?.close().catch(() => {});
  }
}

function deploymentGateHeader(req: FastifyRequest): string | null {
  const value = req.headers[DEPLOYMENT_GATE_HEADER];
  return typeof value === "string" && value.length <= 256 ? value : null;
}

export async function buildServer(deps: Partial<ServerDeps> = {}) {
  const maxJsonBytes = boundedEnvInt("MAX_JSON_BODY_BYTES", 256 * 1024, 16 * 1024, 1024 * 1024);
  const trustProxy = deps.trustProxy === undefined ? configuredTrustProxy() : deps.trustProxy;
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
      redact: { paths: [...LOGGER_REDACT_PATHS], censor: "[REDACTED]" },
      ...(deps.loggerStream ? { stream: deps.loggerStream } : {}),
    },
    bodyLimit: maxJsonBytes,
    trustProxy,
    // Strict request schemas must reject unknown reviewer-control fields rather
    // than Fastify/Ajv silently deleting them before the handler sees the body.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  const deploymentGateDir = (
    deps.deploymentGateDir === undefined
      ? process.env.DEPLOYMENT_GATE_DIR
      : deps.deploymentGateDir
  )?.trim() || null;
  const deploymentGateToken = (
    deps.deploymentGateToken === undefined
      ? process.env.DEPLOYMENT_GATE_TOKEN
      : deps.deploymentGateToken
  )?.trim() || null;
  if (Boolean(deploymentGateDir) !== Boolean(deploymentGateToken)) {
    throw new Error("deployment gate directory and token must be configured together");
  }
  if (deploymentGateDir && !isAbsolute(deploymentGateDir)) {
    throw new Error("deployment gate directory must be absolute");
  }
  if (deploymentGateToken && (
    deploymentGateToken.length < 32
    || deploymentGateToken.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/.test(deploymentGateToken)
  )) {
    throw new Error("deployment gate token must be 32–256 printable characters");
  }

  app.addHook("onRequest", async (req, reply) => {
    if (!deploymentGateDir || !deploymentGateToken) return;
    const path = req.url.split("?", 1)[0] ?? "";
    if ((req.method === "GET" || req.method === "HEAD") && DEPLOYMENT_GATE_PROBE_PATHS.has(path)) {
      return;
    }
    if (await deploymentGateOpen(deploymentGateDir)) return;
    const supplied = deploymentGateHeader(req);
    if (supplied && safeTokenEqual(supplied, deploymentGateToken)) return;
    reply.header("cache-control", "no-store");
    reply.header("retry-after", "1");
    return reply.code(503).send({ error: "release gate closed", requestId: String(req.id) });
  });

  // Security response headers (HSTS · X-Frame-Options · X-Content-Type-Options ·
  // Referrer-Policy · …). Global Helmet CSP stays disabled because generated
  // Swagger assets have a different inline shape; the approval UI receives the
  // strict hash-based UI_CONTENT_SECURITY_POLICY below. Other headers apply globally.
  await app.register(helmet, { contentSecurityPolicy: false });

  const configuredOrigins = (
    deps.corsOrigins ??
    (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "").split(",")
  )
    .map((s) => s.trim())
    .filter(Boolean);
  if (configuredOrigins.includes("*")) {
    throw new Error("CORS_ORIGINS must list exact trusted origins; wildcard '*' is not allowed");
  }
  const allowedOrigins = new Set(configuredOrigins);
  await app.register(cors, {
    // With no allowlist we emit no cross-origin permission. Same-origin browser
    // traffic continues to work and needs no CORS response header.
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
    credentials: false,
  });

  const reviewerToken =
    deps.reviewerToken === undefined
      ? process.env.REVIEWER_TOKEN?.trim() || null
      : deps.reviewerToken?.trim() || null;
  if (process.env.NODE_ENV === "production" && deps.reviewerToken === undefined && !reviewerToken) {
    throw new Error("production requires REVIEWER_TOKEN; refusing to start an unprotected approval queue");
  }
  if (process.env.NODE_ENV === "production" && reviewerToken && reviewerToken.length < 32) {
    throw new Error("REVIEWER_TOKEN must contain at least 32 characters in production");
  }
  const reviewerNameSource =
    deps.reviewerName !== undefined ? deps.reviewerName : process.env.REVIEWER_NAME;
  const reviewerName = (reviewerNameSource === undefined ? "authenticated-reviewer" : reviewerNameSource).trim();
  if (!reviewerName || reviewerName.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(reviewerName)) {
    throw new Error("REVIEWER_NAME must be 1–128 printable characters");
  }
  const suppliedReviewerToken = (req: FastifyRequest): string | null =>
    bearerToken(req.headers.authorization) || headerToken(req.headers["x-reviewer-token"]);
  const hasValidReviewerToken = (req: FastifyRequest): boolean => {
    const supplied = suppliedReviewerToken(req);
    return Boolean(reviewerToken && supplied && safeTokenEqual(supplied, reviewerToken));
  };
  const reviewerAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerToken) {
      sendServerError(req, reply, 503, "reviewer service unavailable");
      return;
    }
    const supplied = suppliedReviewerToken(req);
    if (!supplied || !safeTokenEqual(supplied, reviewerToken)) {
      reply.header("www-authenticate", 'Bearer realm="archon-reviewer"');
      reply.code(401).send({ error: "valid reviewer credentials are required" });
    }
  };

  // A single, typed error envelope for anything that throws past a route handler.
  // Client errors may retain their actionable message; every 5xx is deliberately
  // generic and carries only a request id. Detailed causes stay in server logs.
  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    const status =
      typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      sendServerError(req, reply, status, genericServerMessage(status), err);
      return;
    }
    req.log.warn(
      { operationalError: toSafeOperationalError(err, "client-request"), status, requestId: req.id },
      "request rejected"
    );
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
          "from a persistent vendor-evidence store in pgvector, " +
          "validates, checks for a duplicate, and computes the amount variance — each a " +
          "read/analyze step with no side-effect — before proposing ONE terminal AP " +
          "action. Nothing executes until a human approves: every terminal action waits " +
          "behind a human approval gate — approve to execute the exact proposed args for " +
          "real, amend to edit then execute, or reject to discard. The tool/observation trace and concise rationale are " +
          "persisted so a human can see HOW the agent decided. On approval the outcome is " +
          "written back to memory so the next decision for that vendor is better grounded. " +
          "The vendor-reply sink delivers over real SMTP when configured; the journal " +
          "sink appends to a JSONL ledger when configured; payment/review remain " +
          "simulated adapters. Reviewer APIs require a Bearer token, and every " +
          "execution is atomically claimed before a sink can run. The loop and memory " +
          "grounding are real.",
        version: pkg.version,
      },
      tags: [
        { name: "health", description: "Liveness probe" },
        { name: "workflow", description: "Intake an invoice and run the decision loop" },
        { name: "approval", description: "The human-in-the-loop approval gate" },
        { name: "skills", description: "Introspect the custom Qwen skill catalog" },
      ],
      components: {
        securitySchemes: {
          reviewerBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "opaque reviewer token",
            description: "REVIEWER_TOKEN supplied to judges out-of-band.",
          },
        },
      },
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
    reply
      .header("content-security-policy", UI_CONTENT_SECURITY_POLICY)
      .type("text/html")
      .send(UI_HTML);
  app.get("/", { schema: { hide: true } }, serveUi);
  app.get("/ui", { schema: { hide: true } }, serveUi);

  // Wire dependencies via the SHARED resolver (deps.ts) — the same one the MCP
  // server uses, so both surfaces drive an identically-wired AutopilotAgent.
  // Defaults: real embedder/loop auto-select Qwen vs Fakes by env; the stores use
  // pgvector when DATABASE_URL is set, else in-memory.
  const { agent, deps: resolved } = buildAgent(deps);
  const { embedder, loop } = resolved;
  // Public/invalid-credential requests are deliberately per-request previews:
  // empty ephemeral memory + work-item stores and fake sinks. They can exercise
  // the real Qwen loop, but cannot probe persistent vendor history, reuse another
  // visitor's pending item, or create a durable proposal. A valid reviewer token
  // selects the durable main agent and receives the full evidence-bearing item.
  const intakeAgent = (req: FastifyRequest): { agent: AutopilotAgent; fullEvidence: boolean } => {
    if (hasValidReviewerToken(req)) return { agent, fullEvidence: true };
    return {
      agent: new AutopilotAgent(
        embedder,
        new InMemoryStore(),
        new InMemoryWorkItemStore(),
        loop,
        fakeSinks()
      ),
      fullEvidence: false,
    };
  };

  const httpLimiter = deps.httpRateLimiter ?? new InMemoryHttpRequestRateLimiter();
  const httpLimits = deps.httpRequestLimits ?? {
    public: boundedEnvInt("HTTP_REQUESTS_PER_MINUTE", 600, 30, 10_000),
    reviewer: boundedEnvInt("REVIEWER_HTTP_REQUESTS_PER_MINUTE", 1_200, 30, 20_000),
    global: boundedEnvInt("HTTP_GLOBAL_REQUESTS_PER_MINUTE", 5_000, 100, 100_000),
  };
  app.addHook("onRequest", async (req, reply) => {
    const global = httpLimiter.consume("global", httpLimits.global);
    const tier = hasValidReviewerToken(req) ? "reviewer" : "public";
    const client = httpLimiter.consume(`${tier}:${req.ip}`, httpLimits[tier]);
    if (global.allowed && client.allowed) return;
    const retry = Math.max(global.retryAfterSeconds, client.retryAfterSeconds);
    reply.header("retry-after", String(retry));
    reply.code(429).send({ error: "request rate limit exceeded; retry later", requestId: String(req.id) });
  });

  // The open demo's budget guardrail: invoice uploads are capped per UTC day. Built
  // per server instance (never a module singleton, so counts never bleed across
  // tests). See src/ap/rate-limit.ts for the 20/day rationale.
  const rateLimiter =
    deps.rateLimiter ?? (hasDatabase() ? new PostgresDailyRateLimiter() : new DailyRateLimiter());
  const reviewerRateLimiter =
    deps.reviewerRateLimiter ??
    (hasDatabase()
      ? new PostgresDailyRateLimiter(
          DEFAULT_REVIEWER_DAILY_UPLOAD_LIMIT,
          () => new Date(),
          DEFAULT_REVIEWER_GLOBAL_DAILY_UPLOAD_LIMIT,
          "reviewer"
        )
      : new DailyRateLimiter(DEFAULT_REVIEWER_DAILY_UPLOAD_LIMIT, () => new Date(), DEFAULT_REVIEWER_GLOBAL_DAILY_UPLOAD_LIMIT));
  const reviewerQuotaKey = reviewerToken
    ? `reviewer:${createHash("sha256").update(reviewerToken, "utf8").digest("hex")}`
    : "reviewer:unconfigured";
  const processTicketNow = deps.processTicketNow ?? (() => new Date());
  const processTicketTtlMs = boundedInt(
    deps.processTicketTtlMs,
    boundedEnvInt("PROCESS_TICKET_TTL_MS", 10 * 60_000, 1000, 24 * 60 * 60_000),
    1000,
    24 * 60 * 60_000
  );
  const processTicketCap = boundedInt(
    deps.processTicketCap,
    boundedEnvInt("PROCESS_TICKET_CAP", 2000, 1, 10_000),
    1,
    10_000
  );
  const processTicketClaimTtlMs = boundedInt(
    deps.processTicketClaimTtlMs,
    boundedEnvInt("PROCESS_TICKET_CLAIM_TTL_MS", 5 * 60_000, 1000, 24 * 60 * 60_000),
    1000,
    24 * 60 * 60_000
  );
  const processTicketStore =
    deps.processTicketStore ??
    (hasDatabase() ? new PgProcessTicketStore() : new InMemoryProcessTicketStore());
  const budgetIdentityForRequest = (req: FastifyRequest): BudgetIdentity =>
    hasValidReviewerToken(req)
      ? { tier: "reviewer", binding: reviewerQuotaKey, day: utcDay(processTicketNow()) }
      : { tier: "public", binding: clientKey(req), day: utcDay(processTicketNow()) };
  const consumeUploadBudget = async (
    req: FastifyRequest
  ): Promise<{ rl: RateLimitResult; tier: QuotaTier; binding: string }> => {
    if (hasValidReviewerToken(req)) {
      return { rl: await reviewerRateLimiter.consume(reviewerQuotaKey), tier: "reviewer", binding: reviewerQuotaKey };
    }
    // Missing or invalid credentials receive no hint and consume the ordinary
    // public bucket. This prevents reserve probing and cost-bypass attempts.
    const binding = clientKey(req);
    return { rl: await rateLimiter.consume(binding), tier: "public", binding };
  };

  // The document vision-extractor: real Qwen (qwen-vl-max) when a DASHSCOPE key is
  // set, else the deterministic offline FakeExtractionClient — same env-based
  // auto-selection as the loop + embedder, so CI runs the upload path with no key.
  const extractor = deps.extractor ?? defaultExtractionClient();
  const providerAdmission = deps.providerAdmission ?? defaultProviderRunAdmission();
  const documentAdmission = deps.documentAdmission ?? defaultDocumentRenderAdmission();
  const tryAcquireProviderRun = (req: FastifyRequest): ProviderRunLease | null =>
    providerAdmission.tryAcquire(hasValidReviewerToken(req) ? "reviewer" : "public");
  const tryAcquireDocumentRender = (): DocumentRenderLease | null => documentAdmission.tryAcquire();

  // Process tickets survive replicas/cold starts when Postgres is configured.
  // Raw IP/token-derived owner keys never enter this table: only SHA-256 bindings.
  // The canonical extraction digest is fixed at issue. Only that unchanged JSON
  // can claim the free follow-up; a human edit is a normal quota-bearing intake.
  // A transient failure before proposal persistence releases the same-source lease;
  // success atomically consumes it.
  const processTicketIdentity = (identity: BudgetIdentity) => ({
    tier: identity.tier,
    bindingHash: createHash("sha256").update(identity.binding, "utf8").digest("hex"),
    day: identity.day,
  });
  const mintProcessTicket = async (
    identity: BudgetIdentity,
    sourceInvoice: Record<string, unknown>
  ) =>
    processTicketStore.issue(processTicketIdentity(identity), {
      now: processTicketNow(),
      ttlMs: processTicketTtlMs,
      cap: processTicketCap,
      sourceDigest: reviewedInvoiceDigest(sourceInvoice),
    });
  const claimProcessTicket = async (
    ticket: string,
    req: FastifyRequest,
    invoice: Record<string, unknown>
  ) => {
    if (!ticket) return { status: "invalid" as const };
    return processTicketStore.claim(
      ticket,
      processTicketIdentity(budgetIdentityForRequest(req)),
      reviewedInvoiceDigest(invoice),
      { now: processTicketNow(), staleAfterMs: processTicketClaimTtlMs }
    );
  };

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

  // Readiness is intentionally different from /health: it verifies the configured
  // database, reviewer security boundary, and configured provider identity. It is
  // intentionally network-free: public health polling must never become an
  // unmetered provider-spend/DoS path. Authenticated `/ready/deep` owns the live probe.
  app.get(
    "/ready",
    {
      schema: {
        summary: "Dependency and security readiness",
        description:
          "Checks reviewer auth, the configured database and Qwen configuration without making a " +
          "provider call. Use authenticated, metered GET /ready/deep for a live embedding probe.",
        tags: ["health"],
        response: { 200: looseObject, 503: looseObject },
      },
    },
    async (req, reply) => {
      const requireDatabase = envFlag("READY_REQUIRE_DATABASE", process.env.NODE_ENV === "production");
      const requireQwen = envFlag("READY_REQUIRE_QWEN", process.env.NODE_ENV === "production");
      const checks: Record<string, unknown> = {
        reviewerAuth: { ok: Boolean(reviewerToken), configured: Boolean(reviewerToken) },
      };
      let ok = Boolean(reviewerToken);

      if (hasDatabase()) {
        try {
          await query("SELECT 1 AS ready");
          checks.database = { ok: true, mode: "postgres", probed: true };
        } catch (err) {
          ok = false;
          checks.database = { ok: false, mode: "postgres", probed: true, error: safeError(err) };
        }
      } else {
        const dbOk = !requireDatabase;
        ok = ok && dbOk;
        checks.database = { ok: dbOk, mode: "in-memory", probed: false, required: requireDatabase };
      }

      // Vector spaces from different embedding models are never queried together.
      // A model switch with old rows is therefore explicit operational state, not
      // silent recall drift. Production fails readiness until rows are re-embedded;
      // a bounded rolling migration must be deliberately enabled by the operator.
      try {
        const stats = await resolved.memory.embeddingModelStats(embedder.modelId);
        const migrationAllowed = envFlag("ALLOW_EMBED_MODEL_MIGRATION", false);
        const modelCompatible = stats.other === 0 || migrationAllowed;
        ok = ok && modelCompatible;
        checks.memoryEmbeddingModel = {
          ok: modelCompatible,
          currentModel: embedder.modelId,
          currentRows: stats.current,
          incompatibleRows: stats.other,
          models: stats.models,
          migrationAllowed,
          policy: "semantic recall filters by exact embed_model",
        };
      } catch (err) {
        ok = false;
        checks.memoryEmbeddingModel = {
          ok: false,
          currentModel: embedder.modelId,
          error: safeError(err),
        };
      }

      const qwenConfigured = hasQwenCreds();
      const providerOk = qwenConfigured || !requireQwen;
      ok = ok && providerOk;
      checks.qwen = {
        ok: providerOk,
        configured: qwenConfigured,
        probed: false,
        mode: qwenConfigured ? "configured-not-probed" : "offline-fake",
        required: requireQwen,
        model: embedder.modelId,
      };

      if (!ok) {
        return sendServerError(req, reply, 503, "service not ready", { checks });
      }
      return reply.code(200).send({ status: "ready", checks });
    }
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
          "With a valid reviewer credential, persists and returns a durable PENDING work item with full evidence. " +
          "Without one, returns an isolated non-durable preview with redacted trace and no queue/history access. Nothing executes.",
        tags: ["workflow"],
        body: {
          type: "object",
          additionalProperties: true,
          description: "Either { invoice: {...} } or the raw invoice object itself.",
          properties: { invoice: { type: "object", additionalProperties: true } },
        },
        response: { 200: looseObject, 400: errorResponse, 409: errorResponse, 503: errorResponse },
      },
    },
    async (req, reply) => {
      // Order matters: validate the payload FIRST (a 400 must not burn budget), then
      // check-and-consume the daily limiter (429 when the cap is reached), then run
      // the loop. So an invalid or over-limit upload never reaches the agent.
      const raw = extractInvoice(req.body);
      if (!raw) return reply.code(400).send({ error: "an invoice payload is required (send { invoice: {...} })" });
      const lease = tryAcquireProviderRun(req);
      if (!lease) return sendProviderBusy(req, reply);
      // The loop reaches out to Qwen; a decider/embedder failure is an UPSTREAM
      // dependency error, so surface it as a clean 503 { error } rather than letting
      // it bubble to a generic 500. (The wall-clock deadline inside the loop already
      // turns a *slow* upstream into a graceful flag_for_review; this catches a
      // *failed* one.)
      try {
        const budget = await consumeUploadBudget(req);
        if (!budget.rl.allowed) return reply.code(429).send(rateLimitError(budget.rl, budget.tier));
        const selected = intakeAgent(req);
        const item = await selected.agent.intake(raw, {
          retainProviderCallUntilSettled: lease.retainUntilSettled,
        });
        return selected.fullEvidence ? reviewerProposalView(item) : publicProposalView(item);
      } catch (err) {
        if (err instanceof ConflictError) {
          return reply.code(409).send({ error: err.message, requestId: String(req.id) });
        }
        return sendServerError(req, reply, 503, "decision service unavailable", err);
      } finally {
        lease.release();
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
          "Event (`event: step`) as it happens, then `event: proposal`: durable PENDING/full evidence for a " +
          "valid reviewer credential, otherwise an isolated non-durable redacted preview, " +
          "and `event: done`. Nothing executes — it only proposes. Rate-limited like /intake, EXCEPT " +
          "when a valid single-use `ticket` (minted by POST /extract/document) accompanies the exact, " +
          "unchanged extracted JSON — extraction already consumed the daily slot, so that loop does " +
          "not consume a second one. Edited/replaced JSON follows the ordinary quota path.",
        tags: ["workflow"],
        body: {
          type: "object",
          additionalProperties: true,
          properties: {
            invoice: { type: "object", additionalProperties: true },
            ticket: { type: "string", description: "A single-use, owner/source-bound ticket from POST /extract/document (skips the limiter only for unchanged extracted JSON)." },
          },
        },
        produces: ["text/event-stream"],
      },
    },
    async (req, reply) => {
      const raw = extractInvoice(req.body);
      if (!raw) return reply.code(400).send({ error: "an invoice payload is required (send { invoice: {...} })" });
      // Capacity is checked before consuming a one-shot ticket or daily quota.
      // A busy retry therefore loses neither entitlement nor budget.
      const lease = tryAcquireProviderRun(req);
      if (!lease) return sendProviderBusy(req, reply);
      try {
        const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
        let ticketClaim: { ticket: string; claimId: string } | null = null;
        if (ticket) {
          let claimed;
          try {
            claimed = await claimProcessTicket(ticket, req, raw);
          } catch (err) {
            return sendServerError(req, reply, 503, "process entitlement service unavailable", err);
          }
          if (claimed.status === "busy") {
            reply.header("retry-after", "5");
            return reply.code(409).send({
              error: "this reviewed invoice is already being processed; retry shortly",
              requestId: String(req.id),
            });
          }
          if (claimed.status === "claimed") ticketClaim = { ticket, claimId: claimed.claimId };
        }
        let remaining = -1;
        if (!ticketClaim) {
          const budget = await consumeUploadBudget(req);
          if (!budget.rl.allowed) return reply.code(429).send(rateLimitError(budget.rl, budget.tier));
          remaining = budget.rl.remaining;
        }

        // Take over the raw socket only after admission/quota, so busy is a normal
        // 503 response with Retry-After instead of a malformed SSE session.
        reply.hijack();
        const res = reply.raw;
        const cancellation = responseCancellation(res);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (event: string, data: unknown) =>
          !res.destroyed && !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        let proposalPersisted = false;
        try {
          send("start", { message: "processing invoice", remaining });
          const selected = intakeAgent(req);
          const item = await selected.agent.intake(raw, {
            signal: cancellation.signal,
            retainProviderCallUntilSettled: lease.retainUntilSettled,
            onStep: (step: TraceStep) => send("step", selected.fullEvidence ? step : publicTraceStep(step)),
          });
          proposalPersisted = true;
          if (ticketClaim) {
            try {
              const completed = await processTicketStore.complete(
                ticketClaim.ticket,
                ticketClaim.claimId,
                processTicketNow()
              );
              if (!completed) {
                req.log.error(
                  { requestId: req.id, operationalError: { category: "conflict", operation: "process-ticket-complete" } },
                  "process ticket completion lost its claim"
                );
              }
            } catch (err) {
              // The proposal already exists. Never report the decision as failed or
              // release its entitlement; the stale claim remains fail-closed and a
              // same-digest retry will converge on the existing live work item.
              req.log.error(
                { requestId: req.id, operationalError: toSafeOperationalError(err, "process-ticket-complete") },
                "process ticket completion failed after proposal persistence"
              );
            }
          }
          send("proposal", selected.fullEvidence ? reviewerProposalView(item) : publicProposalView(item));
          send("done", { id: item.id });
        } catch (err) {
          req.log.error(
            { operationalError: toSafeOperationalError(err, "streamed-intake"), requestId: req.id },
            "streamed intake failed"
          );
          if (!cancellation.signal.aborted) send("error", {
            error: err instanceof ConflictError ? err.message : "intake failed",
            requestId: String(req.id),
          });
        } finally {
          if (ticketClaim && !proposalPersisted) {
            try {
              await processTicketStore.release(ticketClaim.ticket, ticketClaim.claimId);
            } catch (err) {
              req.log.error(
                { requestId: req.id, operationalError: toSafeOperationalError(err, "process-ticket-release") },
                "process ticket release failed"
              );
            }
          }
          cancellation.cleanup();
          if (!res.destroyed && !res.writableEnded) res.end();
        }
      } finally {
        lease.release();
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
          "read by the configured Qwen vision model into a structured invoice, which then runs the " +
          "same multi-step ReAct loop as /intake. Streams `event: extracting` → `event: extracted` " +
          "(the parsed invoice) → `event: step` (each live reasoning step) → `event: proposal` → " +
          "`event: done`. Rate-limited like /intake. Nothing executes — it only proposes.",
        tags: ["workflow"],
        consumes: ["multipart/form-data"],
        produces: ["text/event-stream"],
        response: { 400: errorResponse, 413: errorResponse, 429: errorResponse, 503: errorResponse },
      },
    },
    async (req, reply) => {
      // Parse → validate type+size → consume ONE daily slot, in that strict order
      // (shared with /extract/document via readAndValidateUpload so the two never drift).
      const up = await readAndValidateUpload(
        req,
        consumeUploadBudget,
        tryAcquireProviderRun,
        tryAcquireDocumentRender
      );
      if (!up.ok) {
        if (up.status === 503) reply.header("retry-after", "5");
        return reply.code(up.status).send(up.body);
      }
      const { filename, mimetype, buffer, remaining, lease, documentLease } = up;

      // Take over the socket and stream: extract → the live loop → the proposal.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event: string, data: unknown) =>
        !res.destroyed && !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const cancellation = responseCancellation(res);
      const retainExtractionUntilSettled = (operation: Promise<unknown>) => {
        lease.retainUntilSettled(operation);
        documentLease.retainUntilSettled(operation);
      };
      try {
        send("start", { message: "document received", filename, remaining });
        send("extracting", { message: `Extracting document with Qwen-VL (${extractor.modelId})…`, model: extractor.modelId });
        const extracted = await extractor.extract(
          { buffer, filename, mimetype },
          { signal: cancellation.signal, retainProviderCallUntilSettled: retainExtractionUntilSettled }
        );
        documentLease.release();
        // Advisory input-safety scan (injection detection + relevance). It does NOT
        // change the decision: the fence labels untrusted data, while tool separation
        // and the authenticated human gate block autonomous execution. The scan only
        // makes recognized attack text VISIBLE.
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
        // Surface a recognized prompt-injection as its own live trace event. This is
        // advisory: the loop still runs and the human execution gate is unchanged.
        if (safety.security.injectionDetected) {
          send("security", {
            message: `⚠️ This document contained ${safety.security.injectionCount} suspected injected instruction(s) — labeled as untrusted data; autonomous execution remains blocked by the human gate.`,
            ...safety.security,
          });
        }
        const selected = intakeAgent(req);
        const item = await selected.agent.intake(extracted.invoice, {
          signal: cancellation.signal,
          retainProviderCallUntilSettled: lease.retainUntilSettled,
          onStep: (step: TraceStep) => send("step", selected.fullEvidence ? step : publicTraceStep(step)),
        });
        send("proposal", selected.fullEvidence ? reviewerProposalView(item) : publicProposalView(item));
        send("done", { id: item.id });
      } catch (err) {
        req.log.error(
          { operationalError: toSafeOperationalError(err, "streamed-document"), requestId: req.id },
          "streamed document processing failed"
        );
        if (!cancellation.signal.aborted) {
          send("error", err instanceof DocumentPageLimitError
            ? { error: `PDF exceeds the ${MAX_PDF_PAGES}-page limit; no partial extraction was used`, requestId: String(req.id) }
            : { error: "document processing failed", requestId: String(req.id) });
        }
      } finally {
        cancellation.cleanup();
        if (!res.destroyed && !res.writableEnded) res.end();
        documentLease.release();
        lease.release();
      }
    }
  );

  // EXTRACT-ONLY — the first half of the two-step review flow. Upload a REAL document
  // (PDF/PNG/JPG) → validate → consume ONE daily slot → Qwen-VL vision extraction →
  // return the extracted invoice JSON for the human to REVIEW. It runs NO decision
  // loop and proposes nothing. It mints a single-use `ticket`; the UI then posts the
  // unchanged extracted invoice to POST /intake/stream WITH that ticket, which runs
  // the loop without consuming a second slot. Any edit uses ordinary intake quota.
  // Same strict order as /intake/document — parse +
  // validate the file, THEN consume budget, THEN extract — so a bad file is a clean
  // 400/413 that never costs a slot and never reaches the vision model.
  app.post(
    "/extract/document",
    {
      schema: {
        summary: "Upload a real invoice document (PDF/PNG/JPG) and extract it with Qwen-VL for human review (no loop)",
        description:
          "Accepts a multipart/form-data upload with one `file` field — a PDF, PNG, or JPG vendor " +
          "invoice — validates it, consumes one daily slot, runs the configured Qwen vision " +
          "extraction, and returns the structured invoice for review PLUS a single-use `ticket`. It " +
          "runs NO decision loop and executes nothing; the unchanged extracted JSON can then be " +
          "processed via POST /intake/stream with the ticket without consuming a second slot. " +
          "Edited/replaced JSON is allowed but follows the ordinary intake quota path.",
        tags: ["workflow"],
        consumes: ["multipart/form-data"],
        response: { 200: looseObject, 400: errorResponse, 413: errorResponse, 429: errorResponse, 502: errorResponse, 503: errorResponse },
      },
    },
    async (req, reply) => {
      // Parse → validate type+size → consume ONE daily slot, in that strict order
      // (shared with /intake/document via readAndValidateUpload so the two never drift).
      const up = await readAndValidateUpload(
        req,
        consumeUploadBudget,
        tryAcquireProviderRun,
        tryAcquireDocumentRender
      );
      if (!up.ok) {
        if (up.status === 503) reply.header("retry-after", "5");
        return reply.code(up.status).send(up.body);
      }
      const { filename, mimetype, buffer, remaining, lease, documentLease } = up;
      const cancellation = responseCancellation(reply.raw);
      const retainExtractionUntilSettled = (operation: Promise<unknown>) => {
        lease.retainUntilSettled(operation);
        documentLease.retainUntilSettled(operation);
      };

      // Extract with Qwen-VL (or the offline fake). NO decision loop runs here.
      try {
        const extracted = await extractor.extract(
          { buffer, filename, mimetype },
          { signal: cancellation.signal, retainProviderCallUntilSettled: retainExtractionUntilSettled }
        );
        // Advisory input-safety scan surfaced for the human reviewer: whether the
        // document carried a recognized prompt-injection pattern, and whether it looks
        // like an invoice. Neither changes the flow — the reviewer still decides.
        const safety = inputSafety(extracted);
        // Mint a single-use, source-digest-bound ticket. Only the unchanged
        // extraction skips the follow-up limiter; edits are ordinary intake.
        const grant = await mintProcessTicket(up.budget, extracted.invoice);
        return {
          filename,
          model: extracted.model,
          pages: extracted.pages,
          sourceType: extracted.sourceType,
          invoice: extracted.invoice,
          ticket: grant.ticket,
          extractionId: grant.extractionId,
          remaining,
          security: safety.security,
          relevance: safety.relevance,
        };
      } catch (err) {
        if (err instanceof ProcessTicketCapacityError) {
          reply.header("retry-after", "5");
          return reply.code(503).send({
            error: "reviewed-invoice processing capacity is temporarily busy; retry shortly",
            requestId: String(req.id),
          });
        }
        if (err instanceof DocumentPageLimitError) {
          return reply.code(413).send({
            error: `PDF exceeds the ${MAX_PDF_PAGES}-page limit; no partial extraction was used`,
            requestId: String(req.id),
          });
        }
        return sendServerError(req, reply, 502, "document extraction service unavailable", err);
      } finally {
        cancellation.cleanup();
        documentLease.release();
        lease.release();
      }
    }
  );

  // Serve the committed demo document so the UI's "Use sample document" button can
  // upload a REAL invoice file through the exact vision path a judge would use.
  // Load this immutable asset once while constructing the server. The all-route
  // per-IP/tier + global limiter above still protects the endpoint, while a request
  // flood can no longer amplify filesystem work. A missing asset remains a bounded
  // 404 instead of preventing health/readiness from starting.
  const sampleDocument = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "demo", "sample-invoice.png")
  ).catch(() => null);
  app.get("/sample-document", { schema: { hide: true } }, (_req, reply) => {
    if (!sampleDocument) return reply.code(404).send({ error: "sample document not found" });
    return reply
      .type("image/png")
      .header("content-disposition", 'inline; filename="sample-invoice.png"')
      .send(sampleDocument);
  });

  app.get<{ Querystring: { limit?: number | string; offset?: number | string } }>(
    "/pending",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "The approval queue",
        description: "Lists the proposed actions awaiting a human decision (oldest first).",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        querystring: queuePageQuerySchema,
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const page = queuePage(req.query);
      const pending = (await agent.pending(page.limit, page.offset)).map(withReviewFlags);
      return { pending, page: pageEnvelope(page, pending.length) };
    }
  );

  app.get<{ Params: { id: string } }>(
    "/pending/:id",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Read one exact pending proposal",
        description: "Returns one proposal only while it remains pending; used by reviewers and exact release canaries without queue-order assumptions.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["id"] },
        response: { 200: looseObject, 404: errorResponse },
      },
    },
    (req, reply) => guard(reply, async () => {
      const item = await agent.get(req.params.id);
      if (item.status !== "pending") throw new NotFoundError(`pending work item ${req.params.id} not found`);
      return { pending: withReviewFlags(item) };
    })
  );

  app.get(
    "/ready/deep",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Authenticated, metered live Qwen readiness probe",
        description:
          "Makes one real embedding call only after reviewer authentication, provider admission and " +
          "the reviewer daily quota. Public polling can never trigger this probe.",
        tags: ["health"],
        security: [{ reviewerBearer: [] }],
        response: { 200: looseObject, 401: errorResponse, 429: errorResponse, 503: looseObject },
      },
    },
    async (req, reply) => {
      if (!hasQwenCreds()) {
        return reply.code(503).send({
          status: "not-ready",
          qwen: { ok: false, configured: false, probed: false, model: embedder.modelId },
        });
      }
      const lease = tryAcquireProviderRun(req);
      if (!lease) return sendProviderBusy(req, reply);
      try {
        const budget = await consumeUploadBudget(req);
        if (!budget.rl.allowed) return reply.code(429).send(rateLimitError(budget.rl, budget.tier));
        const vector = await embedder.embed("archon authenticated readiness probe");
        const ok = vector.length === embedder.dim;
        return reply.code(ok ? 200 : 503).send({
          status: ok ? "ready" : "not-ready",
          qwen: { ok, configured: true, probed: true, model: embedder.modelId, dimensions: vector.length },
          remaining: budget.rl.remaining,
        });
      } catch (err) {
        return sendServerError(req, reply, 503, "Qwen readiness probe failed", err);
      } finally {
        lease.release();
      }
    }
  );

  app.get<{ Querystring: { limit?: number | string; offset?: number | string } }>(
    "/decided",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "The decided history",
        description:
          "Lists every work item a human has already decided — approved, amended, or rejected — " +
          "most-recently-decided first, each with its outcome, decision timestamp, and (for an " +
          "amended item) the prev → new amend audit trail. Read-only: decided items never re-execute.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        querystring: queuePageQuerySchema,
        response: { 200: looseObject },
      },
    },
    async (req) => {
      const page = queuePage(req.query);
      const decided = await agent.decided(page.limit, page.offset);
      return { decided, page: pageEnvelope(page, decided.length) };
    }
  );

  app.get(
    "/impact-metrics",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Measured AP workflow evidence",
        description:
          "Aggregates machine-measured proposal latency, tool steps, safety catches, and human decisions. " +
          "It does not claim labor savings, ROI, or production error reduction.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        response: { 200: looseObject },
      },
    },
    async () => buildImpactMetrics(
      [...(await agent.pending(500, 0)), ...(await agent.decided(500, 0))],
      "bounded operational window: up to 500 oldest live and 500 most-recent decided work items"
    )
  );

  app.post<{ Params: { id: string } }>(
    "/approve/:id",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Approve a proposed action",
        description: "A human approves the proposal → the chosen tool executes for real and the outcome is written back to memory.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) => guard(reply, () => agent.approve(req.params.id, reviewerName))
  );

  app.post<{
    Params: { id: string };
    Body: {
      args?: Record<string, unknown>;
      tool?: ToolName;
      confirmToolOverride?: boolean;
      reason?: string;
    };
  }>(
    "/amend/:id",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Amend then approve a proposed action",
        description:
          "A human edits the proposed DOMAIN arguments and approves → the amended args are EXACTLY what execute. " +
          "Every amendment requires an audit reason; a tool override additionally requires confirmToolOverride=true.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            args: { type: "object", additionalProperties: true, description: "Edited domain arguments, merged onto the proposal." },
            tool: {
              type: "string",
              enum: ["draft_journal_entry", "draft_payment", "draft_vendor_reply", "flag_for_review"],
              description: "Reviewer-authorized replacement tool. Requires explicit confirmation and reason.",
            },
            confirmToolOverride: { type: "boolean" },
            reason: { type: "string", minLength: 1, maxLength: 1000, description: "Required audit reason for the amendment." },
          },
          required: ["reason"],
        },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) =>
      guard(reply, () =>
        agent.amend(req.params.id, { ...(req.body ?? {}) }, reviewerName)
      )
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/reject/:id",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Reject a proposed action",
        description: "A human discards the proposal → nothing executes. The rejection is remembered.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: "string", minLength: 1, maxLength: 1000, description: "Required audit reason for rejection." } },
          required: ["reason"],
        },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) => guard(reply, () => agent.reject(req.params.id, req.body?.reason, reviewerName))
  );

  app.post<{
    Params: { id: string };
    Body: { action: "retry" | "mark_completed"; reason: string };
  }>(
    "/recover/:id",
    {
      preHandler: reviewerAuth,
      schema: {
        summary: "Reconcile an uncertain execution",
        description:
          "For an item left in executing after a sink failure: retry only after verifying no side effect " +
          "completed, or mark_completed after verifying it did. Never auto-retries.",
        tags: ["approval"],
        security: [{ reviewerBearer: [] }],
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action", "reason"],
          properties: {
            action: { type: "string", enum: ["retry", "mark_completed"] },
            reason: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
        response: { 200: looseObject, 404: errorResponse, 409: errorResponse },
      },
    },
    (req, reply) => guard(reply, () => agent.recover(req.params.id, req.body.action, req.body.reason, reviewerName))
  );

  return app;
}

// Public requests run in an isolated one-shot agent and receive this deliberately
// reduced preview. It contains only normalized data derived from their own request
// and the resulting proposal; persistent recall, raw input junk, detailed evidence
// observations, and durable queue semantics are reviewer-only.
export function publicProposalView(item: WorkItem): Record<string, unknown> {
  const { raw: _raw, ...invoice } = item.invoice;
  return {
    id: item.id,
    status: "preview",
    durable: false,
    visibility: "isolated-public-preview",
    invoice,
    findings: item.findings,
    recalled: [],
    proposed: {
      ...item.proposed,
      reasoning: "Generated from this request in an isolated public preview; authenticate as a reviewer for the evidence trace.",
    },
    trace: item.trace.map(publicTraceStep),
    stopReason: item.stopReason,
    telemetry: item.telemetry,
    inputSecurity: item.inputSecurity,
    createdAt: item.createdAt,
  };
}

function reviewerProposalView(item: WorkItem): WorkItem & { durable: true; visibility: "reviewer-durable" } {
  return { ...item, durable: true, visibility: "reviewer-durable" };
}

function publicTraceStep(step: TraceStep): TraceStep {
  return {
    step: step.step,
    tool: step.tool,
    args: {},
    observation: "Read/analyze step completed inside an isolated public preview; evidence details require reviewer authentication.",
    reasoning: "Isolated preview step completed.",
  };
}

// The parsed-and-validated result of a document upload, or a ready-to-send error.
// Shared by BOTH multipart routes (/intake/document + /extract/document) so their
// strict order — parse the file, validate type+size, THEN consume the daily budget —
// can never drift between the two.
type UploadResult =
  | {
      ok: true;
      filename: string;
      mimetype: string;
      buffer: Buffer;
      remaining: number;
      budget: BudgetIdentity;
      lease: ProviderRunLease;
      documentLease: DocumentRenderLease;
    }
  | { ok: false; status: 400 | 413 | 429 | 503; body: Record<string, unknown> };

// Parse the multipart file, validate it, and consume ONE daily slot — in that exact
// order, so a bad/oversized file returns a clean 400/413 and never costs a slot, and
// an over-limit upload returns 429. The caller sends `{ error }` on !ok, else proceeds.
async function readAndValidateUpload(
  req: FastifyRequest,
  consumeBudget: (
    req: FastifyRequest
  ) => Promise<{ rl: RateLimitResult; tier: QuotaTier; binding: string }>,
  acquireProviderRun: (req: FastifyRequest) => ProviderRunLease | null,
  acquireDocumentRender: () => DocumentRenderLease | null
): Promise<UploadResult> {
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
    // Parser internals may contain filesystem paths, dependency details, or input
    // fragments. Keep the client envelope stable; the global request id is enough
    // for operators to correlate diagnostics.
    return { ok: false, status: 400, body: { error: "could not read the upload as valid multipart/form-data" } };
  }

  // 2) Validate type + size BEFORE consuming budget (a bad file must not cost a slot).
  const v = validateDocument({ filename, mimetype, size: buffer.length });
  if (!v.ok) return { ok: false, status: v.status, body: { error: v.error } };

  // 2b) Magic-byte sniff — the real bytes must match the CLAIMED type (a `.pdf` that
  //     is actually a PNG is rejected here). Also before budget, so a disguised file
  //     never costs a slot.
  const mb = validateMagicBytes(buffer, v.ext);
  if (!mb.ok) return { ok: false, status: mb.status, body: { error: mb.error } };

  // 2c) Parse bounded PNG/JPEG headers without decoding. A tiny compressed pixel
  // bomb is rejected before provider/render admission and before quota.
  const dimensions = validateImageDimensions(buffer, v.ext);
  if (!dimensions.ok) {
    return { ok: false, status: dimensions.status, body: { error: dimensions.error } };
  }

  // 3) Zero-wait provider admission comes before daily quota. Busy traffic neither
  // spends a slot nor reaches poppler/Qwen. The caller holds this lease across the
  // full vision/decision workflow and releases it in a finally block.
  const lease = acquireProviderRun(req);
  if (!lease) {
    return {
      ok: false,
      status: 503,
      body: { error: "provider workflow capacity is temporarily busy", requestId: String(req.id) },
    };
  }

  // Aggregate Poppler/base64 memory is shared across public + reviewer pools.
  // Acquire this independent zero-wait lease before charging quota.
  const documentLease = acquireDocumentRender();
  if (!documentLease) {
    lease.release();
    return {
      ok: false,
      status: 503,
      body: { error: "document processing capacity is temporarily busy", requestId: String(req.id) },
    };
  }

  // 4) Consume the daily budget (429 when the cap is reached), keyed by the client.
  let budget: { rl: RateLimitResult; tier: QuotaTier; binding: string };
  try {
    budget = await consumeBudget(req);
  } catch (err) {
    documentLease.release();
    lease.release();
    throw err;
  }
  if (!budget.rl.allowed) {
    documentLease.release();
    lease.release();
    return { ok: false, status: 429, body: rateLimitError(budget.rl, budget.tier) };
  }

  return {
    ok: true,
    filename,
    mimetype,
    buffer,
    remaining: budget.rl.remaining,
    budget: { tier: budget.tier, binding: budget.binding, day: budget.rl.day },
    lease,
    documentLease,
  };
}

// Advisory input-safety summary for an uploaded document. Runs the read-only
// prompt-injection scan + the relevance gate over the vision-extracted invoice.
// ADVISORY ONLY — NEITHER changes behavior. The fence labels document text as
// untrusted DATA; structural tool separation and the authenticated human gate block
// autonomous execution. An irrelevant document still goes to the human gate. This
// only SURFACES recognized patterns without claiming universal model-level immunity.
function inputSafety(extracted: ExtractionResult): {
  security: {
    injectionDetected: boolean;
    injectionCount: number;
    matches: ReturnType<typeof scanForInjection>["matches"];
    autonomousExecutionBlocked: true;
  };
  relevance: { relevant: boolean; reason: string };
} {
  const scan = scanForInjection(extracted.invoice as Record<string, unknown>);
  return {
    security: {
      injectionDetected: scan.detected,
      injectionCount: scan.count,
      matches: scan.matches,
      autonomousExecutionBlocked: true, // structural tool separation + human gate
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
export function withReviewFlags(item: WorkItem): WorkItem & {
  lowConfidence: boolean;
  lowExtractionConfidence: boolean;
  inferredPayableTotal: boolean;
  requiresCarefulReview: boolean;
} {
  const c = item.proposed?.confidence;
  const lowConfidence = typeof c === "number" && c < LOW_CONFIDENCE_THRESHOLD;
  const lowExtractionConfidence = hasLowExtractionConfidence(item.invoice.extraction_confidence);
  const inferredPayableTotal = hasInferredPayableTotal(
    item.invoice.extraction_confidence,
    item.invoice.notes ?? []
  );
  return {
    ...item,
    lowConfidence,
    lowExtractionConfidence,
    inferredPayableTotal,
    requiresCarefulReview: lowConfidence || lowExtractionConfidence || inferredPayableTotal,
  };
}

export function buildImpactMetrics(
  items: WorkItem[],
  scope = "machine-measured work items supplied to this bounded aggregation"
) {
  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null;
  };
  const proposalMs = items.map((i) => i.telemetry?.intakeToProposalMs).filter((n): n is number => typeof n === "number");
  const readSteps = items.map((i) => i.telemetry?.readAnalyzeSteps ?? i.trace.filter((s) =>
    ["recall_vendor_history", "validate_invoice", "check_duplicate", "compute_variance_vs_history", "request_more_context"].includes(s.tool)
  ).length);
  const decided = items.filter((i) => i.status === "approved" || i.status === "rejected");
  return {
    generatedAt: new Date().toISOString(),
    scope,
    proposals: { total: items.length, pending: items.filter((i) => i.status === "pending" || i.status === "executing").length, decided: decided.length },
    timeToProposalMs: { measured: proposalMs.length, p50: percentile(proposalMs, 0.5), p95: percentile(proposalMs, 0.95) },
    orchestration: {
      averageReadAnalyzeSteps: readSteps.length ? readSteps.reduce((s, n) => s + n, 0) / readSteps.length : 0,
      successfulDecisionModelCalls: items.reduce((s, i) => s + (i.telemetry?.modelCalls ?? 0), 0),
    },
    catches: {
      duplicate: items.filter((i) => i.telemetry?.duplicateCaught || i.findings.some((f) => f.rule === "R5" && !f.passed)).length,
      anomaly: items.filter((i) => i.telemetry?.anomalyCaught || i.findings.some((f) => f.rule === "R6" && !f.passed)).length,
      structural: items.filter((i) => i.telemetry?.structuralBlock || i.findings.some((f) => ["R1", "R2", "R3", "R4", "SOURCE_CONFIDENCE", "SOURCE_PAYABLE_TOTAL"].includes(f.rule) && !f.passed)).length,
    },
    humanGate: {
      touches: items.reduce((s, i) => s + (i.telemetry?.humanTouches ?? (i.decidedAt ? 1 : 0)), 0),
      approved: decided.filter((i) => i.status === "approved" && !i.amended).length,
      amended: decided.filter((i) => i.status === "approved" && i.amended).length,
      rejected: decided.filter((i) => i.status === "rejected").length,
    },
    disclaimer: "Operational instrumentation only; no production time-and-motion study, ROI estimate, or human error study has been performed.",
  };
}

export { EXTRACTION_REVIEW_THRESHOLD };

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
// (and the UI) can show a clear "come back tomorrow" message. The message reflects
// WHICH tier was hit: the caller's own per-client cap (the common case) vs the global
// backstop across all clients (only under heavy shared load).
function rateLimitError(rl: {
  limit: number;
  day: string;
  scope?: "ip" | "global";
  globalLimit?: number;
}, tier: "public" | "reviewer" = "public"): { error: string; limit: number; day: string; scope: "ip" | "global"; quota: "public" | "reviewer" } {
  const scope = rl.scope ?? "ip";
  const error = tier === "reviewer"
    ? `the authenticated reviewer reserve was reached (${scope === "global" ? (rl.globalLimit ?? rl.limit) : rl.limit}/day, UTC). ` +
      `The reserve is isolated from public traffic but remains bounded to protect the Qwen API budget. Resets at 00:00 UTC.`
    : scope === "global"
      ? `the demo's global daily upload limit was reached (${rl.globalLimit ?? rl.limit}/day across all visitors, UTC). ` +
        `This is an open demo — the cap protects the Qwen API budget. Resets at 00:00 UTC.`
      : `your daily upload limit was reached (${rl.limit}/day, UTC). This is an open demo — the cap ` +
        `protects the Qwen API budget. Resets at 00:00 UTC.`;
  return { error, limit: rl.limit, day: rl.day, scope, quota: tier };
}

// Per-client quota/ticket ownership uses only Fastify's resolved IP. Fastify ignores
// forwarding headers by default and considers them only when the operator explicitly
// configures the bounded trusted-proxy boundary above. The global quota remains the
// hard public workflow-entitlement backstop.
function clientKey(req: unknown): string {
  const r = req as { ip?: unknown };
  return typeof r.ip === "string" && r.ip ? r.ip : "_shared";
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
    if (err instanceof InvalidToolArgsError) return reply.code(400).send({ error: err.message });
    if (err instanceof ExecutionUncertainError) {
      return sendServerError(
        reply.request,
        reply,
        502,
        "execution could not be confirmed; reconcile it before retrying",
        err
      );
    }
    if (isInvalidUuidError(err)) {
      return reply.code(400).send({ error: "invalid work item id — expected a UUID" });
    }
    throw err;
  }
}

const MAX_AUTHORIZATION_HEADER_CHARS = 8 * 1024;

function isHttpOptionalWhitespace(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code === 0x20 || code === 0x09; // RFC 9110 OWS: SP / HTAB only.
}

function bearerToken(value: string | undefined): string | null {
  if (!value || value.length > MAX_AUTHORIZATION_HEADER_CHARS) return null;

  // Parse in one bounded pass instead of applying overlapping `\s+` / `.+`
  // repetitions to attacker-controlled header bytes. Leading/trailing OWS and
  // case-insensitive Bearer remain compatible with normal HTTP field semantics.
  let cursor = 0;
  while (cursor < value.length && isHttpOptionalWhitespace(value, cursor)) cursor += 1;
  if (value.slice(cursor, cursor + 6).toLowerCase() !== "bearer") return null;
  cursor += 6;
  if (cursor >= value.length || !isHttpOptionalWhitespace(value, cursor)) return null;
  while (cursor < value.length && isHttpOptionalWhitespace(value, cursor)) cursor += 1;

  let end = value.length;
  while (end > cursor && isHttpOptionalWhitespace(value, end - 1)) end -= 1;
  return end > cursor ? value.slice(cursor, end) : null;
}

function headerToken(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0].trim() || null : null;
}

function safeTokenEqual(supplied: string, expected: string): boolean {
  const left = createHash("sha256").update(supplied, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

function responseCancellation(res: import("node:http").ServerResponse): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      const error = new Error("client disconnected");
      error.name = "AbortError";
      controller.abort(error);
    }
  };
  res.once("close", onClose);
  return {
    signal: controller.signal,
    cleanup: () => res.removeListener("close", onClose),
  };
}

function sendProviderBusy(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .header("retry-after", "5")
    .code(503)
    .send({
      error: "provider workflow capacity is temporarily busy",
      requestId: String(req.id),
    });
}

function sendServerError(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  message: string,
  detail?: unknown
): FastifyReply {
  const requestId = String(req.id);
  req.log.error(
    { operationalError: toSafeOperationalError(detail, "http-request"), requestId, status },
    message
  );
  return reply.code(status).send({ error: message, requestId });
}

function genericServerMessage(status: number): string {
  if (status === 502) return "upstream service error";
  if (status === 503) return "service unavailable";
  if (status === 504) return "upstream service timeout";
  return "internal server error";
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value!)));
}

// Key-order-independent digest of the exact extracted/submitted JSON. Arrays
// retain order; object keys are sorted recursively. This binds a process ticket
// to one source without persisting its sensitive values in the ticket table.
export function reviewedInvoiceDigest(invoice: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(invoice), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("reviewed invoice contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const pairs = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const child = (value as Record<string, unknown>)[key];
        return child === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(child)}`];
      });
    return `{${pairs.join(",")}}`;
  }
  throw new Error("reviewed invoice must be JSON-serializable");
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeError(err: unknown): string {
  return safeOperationalSummary(err, "readiness-check");
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
      console.error(`HTTP server failed: ${safeOperationalSummary(err, "http-bootstrap")}`);
      process.exit(1);
    });
}
/* c8 ignore stop */
