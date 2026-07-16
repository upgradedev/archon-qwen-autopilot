// Unit — the HTTP shell (src/server.ts) via Fastify's in-process `inject`, with
// injected in-memory dependencies (no DB, no key). Covers /health, the swagger
// surface, the permissive /intake guard, and the 404/409 mapping of the gate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer, configuredTrustProxy, reviewedInvoiceDigest, type ServerDeps } from "../../src/server.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { DailyRateLimiter } from "../../src/ap/rate-limit.js";
import {
  withReviewFlags,
  LOW_CONFIDENCE_THRESHOLD,
  EXTRACTION_REVIEW_THRESHOLD,
  buildImpactMetrics,
} from "../../src/server.js";
import type { WorkItem } from "../../src/types.js";
import { FakeExtractionClient, type ExtractionOptions, type UploadedDocument } from "../../src/qwen/vision.js";
import { BoundedDocumentRenderAdmission, TieredProviderRunAdmission } from "../../src/ap/provider-admission.js";
import { InMemoryHttpRequestRateLimiter } from "../../src/ap/http-rate-limit.js";
import {
  InMemoryProcessTicketStore,
  ProcessTicketCapacityError,
} from "../../src/ap/process-ticket-store.js";

class HoldingEmbedder extends FakeEmbedder {
  private released = false;
  private releaseResolve!: () => void;
  private readonly releasePromise = new Promise<void>((resolve) => { this.releaseResolve = resolve; });
  private started = 0;
  private listeners: Array<() => void> = [];

  override async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (!this.released) {
      this.started += 1;
      this.listeners.splice(0).forEach((listener) => listener());
      await this.releasePromise;
    }
    signal?.throwIfAborted();
    return super.embed(text, signal);
  }

  async waitForStarted(count: number): Promise<void> {
    while (this.started < count) {
      await new Promise<void>((resolve) => this.listeners.push(resolve));
    }
  }

  release(): void {
    this.released = true;
    this.releaseResolve();
  }
}

class HoldingExtractor extends FakeExtractionClient {
  private released = false;
  private releaseResolve!: () => void;
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  private readonly releasePromise = new Promise<void>((resolve) => { this.releaseResolve = resolve; });

  override async extract(doc: UploadedDocument, options: ExtractionOptions = {}) {
    this.startedResolve();
    if (!this.released) await this.releasePromise;
    options.signal?.throwIfAborted();
    return super.extract(doc, options);
  }

  release(): void {
    this.released = true;
    this.releaseResolve();
  }
}

let app: FastifyInstance;
const REVIEWER_TOKEN = "unit-test-reviewer-token-32-characters";
const AUTH = { authorization: `Bearer ${REVIEWER_TOKEN}` };

function deps(extra: Partial<ServerDeps> = {}): ServerDeps {
  return {
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks: fakeSinks(),
    extractor: new FakeExtractionClient(), // offline vision — no key, no poppler
    reviewerToken: REVIEWER_TOKEN,
    trustProxy: 1,
    ...extra,
  };
}

const sampleInvoice = { vendor: "Acme", invoice_number: "A-1", date: "2026-01-01", currency: "EUR", tax_id: "T", subtotal: 100, tax: 20, total: 120 };

test("trusted-proxy configuration defaults false and accepts only bounded IP/CIDR or 1–3 hops", () => {
  assert.equal(configuredTrustProxy({}), false);
  assert.equal(configuredTrustProxy({ TRUST_PROXY_HOPS: "1" }), 1);
  assert.deepEqual(configuredTrustProxy({ TRUST_PROXY_ADDRESSES: "127.0.0.1, 10.0.0.0/8, ::1" }), ["127.0.0.1", "10.0.0.0/8", "::1"]);
  assert.throws(() => configuredTrustProxy({ TRUST_PROXY_HOPS: "4" }), /1.*3/);
  assert.throws(() => configuredTrustProxy({ TRUST_PROXY_ADDRESSES: "proxy.example.test" }), /IP or CIDR/);
  assert.throws(() => configuredTrustProxy({ TRUST_PROXY_ADDRESSES: "127.0.0.1", TRUST_PROXY_HOPS: "1" }), /only one/);
});

test("reviewed invoice digest is recursive key-order independent and value sensitive", () => {
  assert.equal(
    reviewedInvoiceDigest({ vendor: "Acme", nested: { b: 2, a: 1 }, lines: [{ z: 3, y: 2 }] }),
    reviewedInvoiceDigest({ lines: [{ y: 2, z: 3 }], nested: { a: 1, b: 2 }, vendor: "Acme" })
  );
  assert.notEqual(reviewedInvoiceDigest({ total: 120 }), reviewedInvoiceDigest({ total: 121 }));
});

test("process-ticket claims are atomic, digest-bound, releasable, and single-use", async () => {
  const store = new InMemoryProcessTicketStore();
  const now = new Date("2026-07-15T10:00:00.000Z");
  const identity = { tier: "public" as const, bindingHash: "owner-hash", day: "2026-07-15" };
  const grant = await store.issue(identity, { now, ttlMs: 60_000, cap: 10, sourceDigest: "reviewed-a" });
  assert.match(grant.ticket, /^[0-9a-f-]{36}$/i);
  assert.match(grant.extractionId, /^[0-9a-f-]{36}$/i);
  const [a, b] = await Promise.all([
    store.claim(grant.ticket, identity, "reviewed-a", { now, staleAfterMs: 30_000 }),
    store.claim(grant.ticket, identity, "reviewed-a", { now, staleAfterMs: 30_000 }),
  ]);
  const winner = [a, b].find((result) => result.status === "claimed");
  assert.ok(winner && winner.status === "claimed");
  assert.equal([a, b].filter((result) => result.status === "claimed").length, 1);
  assert.equal([a, b].filter((result) => result.status === "busy").length, 1);
  assert.equal(await store.release(grant.ticket, winner.claimId), true);
  assert.equal(
    (await store.claim(grant.ticket, identity, "reviewed-b", { now, staleAfterMs: 30_000 })).status,
    "invalid",
    "a released entitlement remains bound to its first reviewed digest"
  );
  const retry = await store.claim(grant.ticket, identity, "reviewed-a", { now, staleAfterMs: 30_000 });
  assert.equal(retry.status, "claimed");
  assert.equal(retry.status === "claimed" && await store.complete(grant.ticket, retry.claimId, now), true);
  assert.equal(
    (await store.claim(grant.ticket, identity, "reviewed-a", { now, staleAfterMs: 30_000 })).status,
    "invalid",
    "a consumed entitlement cannot be replayed"
  );
});

test("provider admission stays fail-closed after request release until a retained SDK call settles", async () => {
  const admission = new TieredProviderRunAdmission({ public: 1, reviewer: 1 });
  const lease = admission.tryAcquire("public");
  assert.ok(lease);
  let settle!: () => void;
  const operation = new Promise<void>((resolve) => { settle = resolve; });
  lease.retainUntilSettled(operation);
  lease.release();

  assert.equal(admission.snapshot().public.active, 1);
  assert.equal(admission.tryAcquire("public"), null, "an invisible upstream call must still consume capacity");
  settle();
  await operation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admission.snapshot().public.active, 0);
  admission.tryAcquire("public")?.release();
});

test("document-memory admission stays occupied while a detached vision SDK call retains buffers", async () => {
  const admission = new BoundedDocumentRenderAdmission(1);
  const lease = admission.tryAcquire();
  assert.ok(lease);
  let settle!: () => void;
  const operation = new Promise<void>((resolve) => { settle = resolve; });
  lease.retainUntilSettled(operation);
  lease.release();

  assert.equal(admission.snapshot().active, 1);
  assert.equal(admission.tryAcquire(), null, "a detached vision call must retain the document-memory slot");
  settle();
  await operation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admission.snapshot().active, 0);
  admission.tryAcquire()?.release();
});

test("process-ticket cap pressure is scoped to an owner/tier/day identity", async () => {
  const store = new InMemoryProcessTicketStore();
  const now = new Date("2026-07-15T10:00:00.000Z");
  const ownerA = { tier: "public" as const, bindingHash: "owner-a", day: "2026-07-15" };
  const ownerB = { tier: "public" as const, bindingHash: "owner-b", day: "2026-07-15" };
  const reviewer = { tier: "reviewer" as const, bindingHash: "reviewer", day: "2026-07-15" };
  const b = await store.issue(ownerB, { now, ttlMs: 60_000, cap: 1, sourceDigest: "b" });
  const r = await store.issue(reviewer, { now, ttlMs: 60_000, cap: 1, sourceDigest: "r" });
  await store.issue(ownerA, { now, ttlMs: 60_000, cap: 1, sourceDigest: "a1" });
  await store.issue(ownerA, { now, ttlMs: 60_000, cap: 1, sourceDigest: "a2" });
  assert.equal((await store.claim(b.ticket, ownerB, "b", { now, staleAfterMs: 30_000 })).status, "claimed");
  assert.equal((await store.claim(r.ticket, reviewer, "r", { now, staleAfterMs: 30_000 })).status, "claimed");
});

test("process-ticket cap never evicts an actively claimed entitlement", async () => {
  const store = new InMemoryProcessTicketStore();
  const now = new Date("2026-07-15T10:00:00.000Z");
  const identity = { tier: "public" as const, bindingHash: "owner-a", day: "2026-07-15" };
  const first = await store.issue(identity, { now, ttlMs: 60_000, cap: 1, sourceDigest: "a1" });
  const claim = await store.claim(first.ticket, identity, "a1", { now, staleAfterMs: 30_000 });
  assert.equal(claim.status, "claimed");
  await assert.rejects(
    () => store.issue(identity, { now, ttlMs: 60_000, cap: 1, sourceDigest: "a2" }),
    ProcessTicketCapacityError
  );
  assert.equal(
    (await store.claim(first.ticket, identity, "a1", { now, staleAfterMs: 30_000 })).status,
    "busy",
    "cap pressure must preserve the original claimed entitlement"
  );
});

// The upload path now content-sniffs the leading bytes, so a fixture PNG must carry
// the real 8-byte PNG signature. The offline FakeExtractionClient ignores the bytes
// (returns the canonical Meridian invoice), so any valid-magic buffer works here.
function pngHeader(width = 1, height = 1): Buffer {
  const out = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}
const PNG_BYTES = pngHeader();

// Build a multipart/form-data body with ONE file part. Multipart parts REQUIRE
// CRLF line endings, so a bare-\n body would not parse — hence the explicit \r\n.
function multipartFile(field: string, filename: string, contentType: string, content: Buffer | string): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----archontest" + Math.random().toString(16).slice(2);
  const head =
    `--${boundary}\r\n` +
    `content-disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `content-type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(tail, "utf8")]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

before(async () => {
  delete process.env.DASHSCOPE_API_KEY; // guarantee the offline Fakes
  app = await buildServer(deps());
  await app.ready();
});

after(async () => {
  await app.close();
});

test("GET /health returns ok with embedder + decider identity (no DB, no key)", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.ok(typeof body.embedder === "string" && body.embedder.length > 0);
  assert.ok(typeof body.decider === "string" && body.decider.length > 0);
});

test("withReviewFlags flags a below-threshold confidence for review, and leaves a confident one alone", () => {
  const base = (confidence: number, extractionConfidence: number | null = null): WorkItem =>
    ({
      invoice: { extraction_confidence: extractionConfidence },
      proposed: { tool: "draft_payment", args: {}, reasoning: "", confidence, modelId: "x" },
    } as unknown as WorkItem);
  assert.ok(LOW_CONFIDENCE_THRESHOLD > 0 && LOW_CONFIDENCE_THRESHOLD <= 1);
  assert.equal(withReviewFlags(base(0.2)).lowConfidence, true, "0.2 < threshold → flagged");
  assert.equal(withReviewFlags(base(0.9)).lowConfidence, false, "0.9 ≥ threshold → not flagged");
  assert.ok(EXTRACTION_REVIEW_THRESHOLD > 0 && EXTRACTION_REVIEW_THRESHOLD <= 1);
  const weakSource = withReviewFlags(base(0.9, EXTRACTION_REVIEW_THRESHOLD / 2));
  assert.equal(weakSource.lowConfidence, false, "decision confidence stays a separate signal");
  assert.equal(weakSource.lowExtractionConfidence, true, "weak Qwen-VL read is flagged independently");
  assert.equal(weakSource.requiresCarefulReview, true);
  const inferredSource = base(0.9, 0.95);
  inferredSource.invoice.notes = ["total inferred from subtotal + tax = 120"];
  const inferred = withReviewFlags(inferredSource);
  assert.equal(inferred.lowExtractionConfidence, false);
  assert.equal(inferred.inferredPayableTotal, true);
  assert.equal(inferred.requiresCarefulReview, true);
});

test("GET /pending and exact-item lookup carry the advisory review flags", async () => {
  const intake = await app.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice: sampleInvoice } });
  const id = intake.json().id as string;
  const res = await app.inject({ method: "GET", url: "/pending", headers: AUTH });
  assert.equal(res.statusCode, 200);
  const items = res.json().pending as Array<{ id: string; lowConfidence: unknown }>;
  assert.ok(items.length >= 1);
  for (const it of items) assert.equal(typeof it.lowConfidence, "boolean", "every pending item exposes lowConfidence");

  const exact = await app.inject({ method: "GET", url: `/pending/${id}`, headers: AUTH });
  assert.equal(exact.statusCode, 200);
  assert.equal(exact.json().pending.id, id, "the canary can prove its own exact item without queue-order assumptions");
  assert.equal(typeof exact.json().pending.lowConfidence, "boolean");
  assert.equal((await app.inject({ method: "GET", url: `/pending/${id}` })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "GET", url: "/pending/00000000-0000-4000-8000-000000000000", headers: AUTH })).statusCode,
    404
  );
});

test("CORS is same-origin by default and reflects only an exact configured allowlist origin", async () => {
  const hostile = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
  assert.equal(hostile.headers["access-control-allow-origin"], undefined);

  const local = await buildServer(deps({ corsOrigins: ["https://trusted.example"] }));
  await local.ready();
  try {
    const trusted = await local.inject({ method: "GET", url: "/health", headers: { origin: "https://trusted.example" } });
    assert.equal(trusted.headers["access-control-allow-origin"], "https://trusted.example");
    const evil = await local.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
  } finally {
    await local.close();
  }
});

test("reviewer APIs fail closed: missing/wrong credentials cannot read or execute, valid Bearer can", async () => {
  const localSinks = fakeSinks();
  const local = await buildServer(deps({ sinks: localSinks }));
  await local.ready();
  try {
    const intake = await local.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice: sampleInvoice } });
    const id = intake.json().id;
    assert.equal((await local.inject({ method: "GET", url: "/pending" })).statusCode, 401);
    assert.equal(
      (await local.inject({ method: "POST", url: `/approve/${id}`, headers: { authorization: "Bearer wrong" } })).statusCode,
      401
    );
    assert.equal(localSinks.ledger.entries().length, 0, "unauthenticated callers reach no sink");
    const approved = await local.inject({ method: "POST", url: `/approve/${id}`, headers: AUTH });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().decisionIntent.by, "authenticated-reviewer");
    assert.equal(localSinks.ledger.entries().length, 1);
  } finally {
    await local.close();
  }
});

test("Bearer authentication uses bounded linear parsing and preserves valid HTTP OWS", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const valid = await local.inject({
      method: "GET",
      url: "/pending",
      headers: { authorization: `bEaReR\t${REVIEWER_TOKEN}\t` },
    });
    assert.equal(valid.statusCode, 200, "scheme matching remains case-insensitive and accepts RFC OWS");

    const missingSeparator = await local.inject({
      method: "GET",
      url: "/pending",
      headers: { authorization: `Bearer${REVIEWER_TOKEN}` },
    });
    assert.equal(missingSeparator.statusCode, 401);

    const adversarialWhitespace = await local.inject({
      method: "GET",
      url: "/pending",
      headers: { authorization: `Bearer ${" ".repeat(9_000)}not-the-reviewer-token` },
    });
    assert.equal(adversarialWhitespace.statusCode, 401, "oversized whitespace is rejected before token parsing");
  } finally {
    await local.close();
  }
});

test("reviewer APIs return 503 when REVIEWER_TOKEN is unconfigured; public health/UI remain available", async () => {
  const local = await buildServer(deps({ reviewerToken: null }));
  await local.ready();
  try {
    assert.equal((await local.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await local.inject({ method: "GET", url: "/" })).statusCode, 200);
    const denied = await local.inject({ method: "GET", url: "/pending" });
    assert.equal(denied.statusCode, 503);
    assert.equal(denied.json().error, "reviewer service unavailable");
    assert.ok(typeof denied.json().requestId === "string" && denied.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(denied.json()), /token|configured/i);

    const notReady = await local.inject({ method: "GET", url: "/ready" });
    assert.equal(notReady.statusCode, 503);
    assert.deepEqual(Object.keys(notReady.json()).sort(), ["error", "requestId"]);
    assert.equal(notReady.json().error, "service not ready");
    assert.ok(typeof notReady.json().requestId === "string" && notReady.json().requestId.length > 0);
  } finally {
    await local.close();
  }
});

test("deployment cutover gate is fail-closed, probe-only, re-closeable, and bypasses only with its exact secret", async () => {
  const gateDir = resolve(".artifacts", `server-release-gate-${process.pid}`);
  const symlinkTarget = resolve(".artifacts", `server-release-gate-target-${process.pid}`);
  const gateToken = "deployment-gate-test-token-000000000000000000000001";
  await rm(gateDir, { recursive: true, force: true });
  await rm(symlinkTarget, { force: true });
  await mkdir(gateDir, { recursive: true });
  await writeFile(resolve(gateDir, "contract"), "archon-release-gate-v1\n", "utf8");
  await writeFile(resolve(gateDir, "closed"), "closed\n", "utf8");
  const local = await buildServer(deps({ deploymentGateDir: gateDir, deploymentGateToken: gateToken }));
  await local.ready();
  try {
    assert.equal((await local.inject({ method: "GET", url: "/health" })).statusCode, 200);
    assert.equal((await local.inject({ method: "GET", url: "/health?deployment=probe" })).statusCode, 200);
    assert.equal((await local.inject({ method: "POST", url: "/health" })).statusCode, 503, "probe bypass is method-bounded");
    assert.equal((await local.inject({ method: "GET", url: "/ready" })).statusCode, 200);
    assert.equal((await local.inject({ method: "GET", url: "/pending", headers: AUTH })).statusCode, 503);
    assert.equal((await local.inject({ method: "GET", url: "/" })).statusCode, 503);
    assert.equal((await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } })).statusCode, 503);
    assert.equal((await local.inject({
      method: "GET",
      url: "/pending",
      headers: { ...AUTH, "x-archon-deployment-gate": "wrong-token" },
    })).statusCode, 503);
    assert.equal((await local.inject({
      method: "GET",
      url: "/pending",
      headers: { ...AUTH, "x-archon-deployment-gate": gateToken },
    })).statusCode, 200);

    await unlink(resolve(gateDir, "closed"));
    assert.equal((await local.inject({ method: "GET", url: "/pending", headers: AUTH })).statusCode, 200);
    await writeFile(resolve(gateDir, "contract"), "archon-release-gate-v1\nextra\n", "utf8");
    assert.equal((await local.inject({ method: "GET", url: "/pending", headers: AUTH })).statusCode, 503);
    await writeFile(resolve(gateDir, "contract"), "archon-release-gate-v1\n", "utf8");
    await writeFile(resolve(gateDir, "closed"), "closed\n", "utf8");
    assert.equal((await local.inject({ method: "GET", url: "/pending", headers: AUTH })).statusCode, 503);
    await unlink(resolve(gateDir, "closed"));
    await writeFile(resolve(gateDir, "unexpected"), "fail closed\n", "utf8");
    assert.equal((await local.inject({ method: "GET", url: "/pending", headers: AUTH })).statusCode, 503);
    if (process.platform !== "win32") {
      await unlink(resolve(gateDir, "unexpected"));
      await writeFile(symlinkTarget, "archon-release-gate-v1\n", "utf8");
      await unlink(resolve(gateDir, "contract"));
      await symlink(symlinkTarget, resolve(gateDir, "contract"), "file");
      assert.equal(
        (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).statusCode,
        503,
        "a symlinked release contract must stay fail-closed",
      );
    }
  } finally {
    await local.close();
    await rm(gateDir, { recursive: true, force: true });
    await rm(symlinkTarget, { force: true });
  }
});

test("deployment cutover gate rejects partial, relative, and weak configuration", async () => {
  await assert.rejects(() => buildServer(deps({ deploymentGateDir: resolve(".artifacts", "gate"), deploymentGateToken: null })), /configured together/);
  await assert.rejects(() => buildServer(deps({ deploymentGateDir: "relative/gate", deploymentGateToken: "x".repeat(40) })), /must be absolute/);
  await assert.rejects(() => buildServer(deps({ deploymentGateDir: resolve(".artifacts", "gate"), deploymentGateToken: "weak" })), /32–256/);
});

test("production startup fails closed when REVIEWER_TOKEN is absent from real configuration", async () => {
  const explicit = deps();
  delete (explicit as Partial<ServerDeps>).reviewerToken;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousToken = process.env.REVIEWER_TOKEN;
  process.env.NODE_ENV = "production";
  delete process.env.REVIEWER_TOKEN;
  try {
    await assert.rejects(
      () => buildServer(explicit),
      /production requires REVIEWER_TOKEN/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousToken === undefined) delete process.env.REVIEWER_TOKEN;
    else process.env.REVIEWER_TOKEN = previousToken;
  }
});

test("reviewer amendment/rejection bodies reject unknown fields and oversized audit reasons", async () => {
  const extra = await app.inject({
    method: "POST",
    url: "/reject/not-used",
    headers: AUTH,
    payload: { reason: "reviewed", unexpected: "not persisted" },
  });
  assert.equal(extra.statusCode, 400);

  const oversized = "x".repeat(1001);
  const amend = await app.inject({
    method: "POST",
    url: "/amend/not-used",
    headers: AUTH,
    payload: { reason: oversized },
  });
  const reject = await app.inject({
    method: "POST",
    url: "/reject/not-used",
    headers: AUTH,
    payload: { reason: oversized },
  });
  assert.equal(amend.statusCode, 400);
  assert.equal(reject.statusCode, 400);
});

test("GET /ready distinguishes liveness from dependency/security readiness", async () => {
  const ready = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().status, "ready");
  assert.equal(ready.json().checks.reviewerAuth.configured, true);
  assert.equal(ready.json().checks.qwen.probed, false);
  const publicDeep = await app.inject({ method: "GET", url: "/ready/deep" });
  assert.equal(publicDeep.statusCode, 401, "a public health poll can never spend Qwen budget");
  const offlineDeep = await app.inject({ method: "GET", url: "/ready/deep", headers: AUTH });
  assert.equal(offlineDeep.statusCode, 503);
  assert.equal(offlineDeep.json().qwen.probed, false);
});

test("coarse all-route HTTP guard rate-limits public polling without trusting spoofed XFF", async () => {
  let now = 0;
  const local = await buildServer(deps({
    trustProxy: false,
    httpRateLimiter: new InMemoryHttpRequestRateLimiter(() => now),
    httpRequestLimits: { public: 1, reviewer: 2, global: 10 },
  }));
  await local.ready();
  try {
    const first = await local.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.9" } });
    const second = await local.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.10" } });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429, "untrusted XFF values cannot rotate the req.ip bucket");
    assert.match(String(second.headers["retry-after"]), /^\d+$/);
    now = 60_001;
    assert.equal((await local.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally {
    await local.close();
  }
});

test("coarse HTTP limiter fully prunes excess keys and fails closed on non-finite limits", () => {
  const limiter = new InMemoryHttpRequestRateLimiter(() => 0, 60_000, 2);
  assert.equal(limiter.consume("oldest", 1).allowed, true);
  for (let index = 0; index < 254; index++) {
    assert.equal(limiter.consume(`filler-${index}`, 1).allowed, true);
  }
  assert.equal(limiter.consume("newest", 1).allowed, true); // operation 256 triggers pruning
  assert.equal(limiter.consume("filler-200", 1).allowed, true, "all excess oldest keys were evicted");

  const invalidLimit = new InMemoryHttpRequestRateLimiter(() => 0);
  assert.equal(invalidLimit.consume("client", Number.NaN).allowed, true);
  assert.equal(invalidLimit.consume("client", Number.NaN).allowed, false, "invalid limits clamp to one");
});

test("POST /intake with an empty body → 400", async () => {
  const res = await app.inject({ method: "POST", url: "/intake", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /invoice/);
});

test("public POST /intake accepts a MESSY invoice and returns an isolated preview", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/intake",
    payload: { invoice: { supplier: "Contoso", amount: "€ 2.500,00", date: "not-a-date" } },
  });
  assert.equal(res.statusCode, 200);
  const item = res.json();
  assert.equal(item.status, "preview");
  assert.equal(item.durable, false);
  assert.ok(item.proposed.tool);
  assert.ok(item.invoice.notes.length > 0); // the messiness was recorded, not rejected
});

test("approve on an unknown id → 404; approve twice → 409 (the gate over HTTP)", async () => {
  const intake = await app.inject({
    method: "POST",
    url: "/intake",
    headers: AUTH,
    payload: { invoice: { ...sampleInvoice, vendor: "Approval Twice Co", invoice_number: "APPROVE-1" } },
  });
  const id = intake.json().id;

  const missing = await app.inject({ method: "POST", url: "/approve/nope", headers: AUTH });
  assert.equal(missing.statusCode, 404);

  const first = await app.inject({ method: "POST", url: `/approve/${id}`, headers: AUTH });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, "approved");

  const second = await app.inject({ method: "POST", url: `/approve/${id}`, headers: AUTH });
  assert.equal(second.statusCode, 409);
});

test("GET /pending lists proposals awaiting a decision", async () => {
  const res = await app.inject({ method: "GET", url: "/pending", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().pending));
});

test("GET / serves the approval UI as HTML (200, text/html)", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(res.body, /<!doctype html>/i);
  assert.match(res.body, /Archon Autopilot/);
  // The page wires the real approval endpoints (not a placeholder).
  assert.match(res.body, /\/pending/);
  assert.match(res.body, /\/approve\//);
});

test("GET / includes the guided tour + one-click demo (self-explanatory for a first-time visitor)", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  // One-line header explaining what the app is.
  assert.match(res.body, /it proposes, you approve/i);
  // One-click "Load sample invoice" demo button + its realistic payload.
  assert.match(res.body, /Load sample invoice/);
  assert.match(res.body, /id="loadSample"/);
  assert.match(res.body, /Meridian Logistics/);
  // First-visit guided tour: trigger button, engine, and localStorage first-visit flag.
  assert.match(res.body, /Take the tour/);
  assert.match(res.body, /id="tourBtn"/);
  assert.match(res.body, /id="tourOverlay"/);
  assert.match(res.body, /function startTour/);
  assert.match(res.body, /localStorage/);
  // Tour highlights the multi-step trace + the human gate.
  assert.match(res.body, /How the agent decided/);
  assert.match(res.body, /Nothing executes until you approve/);
  // Clear empty-state guidance instead of a blank list.
  assert.match(res.body, /No invoices in the queue/);
});

test("GET / ships the enriched UI: upload + live process view, collapsible trace, decided tab, charts", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  // Document/invoice upload + real-time process view (streamed over SSE).
  assert.match(res.body, /Upload an invoice/i);
  assert.match(res.body, /id="fileInput"/);
  assert.match(res.body, /id="processBtn"/);
  // The file picker accepts REAL documents (PDF/PNG/JPG), read by Qwen-VL.
  assert.match(res.body, /accept="\.pdf,\.png,\.jpg,\.jpeg/);
  assert.match(res.body, /Qwen-VL/);
  assert.match(res.body, /id="sampleDoc"/); // "Use sample document" button
  // The two-step review flow: the UI posts the file to the extract-only endpoint,
  // renders it for review, then processes the reviewed invoice over the SSE stream.
  assert.match(res.body, /\/extract\/document/); // step 1: extract-only upload
  assert.match(res.body, /\/intake\/stream/); // step 2: process the reviewed invoice (SSE)
  assert.match(res.body, /id="fileName"/); // selected-filename display
  assert.match(res.body, /Choose file/); // custom file-picker button (wired change handler)
  assert.match(res.body, /id="extractReview"/); // the extracted-invoice review panel
  assert.match(res.body, /review the extracted fields, then Process/); // the demo review note
  assert.match(res.body, /pendingTicket/); // single-use ticket → process without re-consuming
  assert.match(res.body, /getReader|text\/event-stream|Processing invoice/);
  assert.match(res.body, /payable total inferred — verify source/); // document-only source guard is visible
  // The durable two-tier rate limit is surfaced without hard-coding an env-tunable cap.
  assert.match(res.body, /rate-limited per visitor and globally/);
  // Collapsible "How the agent decided" trace (chevron toggle).
  assert.match(res.body, /How the agent decided/);
  assert.match(res.body, /class: 'collapsible'|collapsible/);
  assert.match(res.body, /chevron/);
  // Decided view fed by the real /decided endpoint + a decided tab.
  assert.match(res.body, /\/decided/);
  assert.match(res.body, /data-tab="decided"/);
  // Charts (inline SVG, no CDN / no build step) — pending clean-vs-flagged + decided.
  assert.match(res.body, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg'/);
  assert.match(res.body, /Clean/);
  assert.match(res.body, /Amended/);
});

test("GET /ui serves the same approval UI (alias)", async () => {
  const res = await app.inject({ method: "GET", url: "/ui" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
});

test("GET /openapi.json documents every workflow + approval route", async () => {
  const res = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.equal(res.statusCode, 200);
  const spec = res.json();
  assert.equal(spec.openapi?.startsWith("3."), true);
  assert.equal(spec.info?.title, "Archon Autopilot API");
  for (const path of ["/health", "/ready", "/intake", "/pending", "/approve/{id}", "/amend/{id}", "/reject/{id}", "/recover/{id}"]) {
    assert.ok(spec.paths?.[path], `spec should document ${path}`);
  }
});

test("GET /docs serves the interactive Swagger UI", async () => {
  const res = await app.inject({ method: "GET", url: "/docs" });
  assert.ok([200, 301, 302].includes(res.statusCode));
  if (res.statusCode >= 300) {
    const follow = await app.inject({ method: "GET", url: res.headers.location as string });
    assert.equal(follow.statusCode, 200);
  }
});

test("GET /decided lists decided items (empty array on a fresh app)", async () => {
  const res = await app.inject({ method: "GET", url: "/decided", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().decided));
});

test("upload rate limit: a per-client cap of 20/day means the 21st upload from that client → 429 (open-demo budget guard)", async () => {
  // A dedicated app so the shared `before` app's usage does not affect the count,
  // and a pinned clock so all 21 uploads land in the same UTC day.
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(20, () => new Date("2026-07-06T09:00:00Z")) }));
  await local.ready();
  try {
    for (let i = 1; i <= 20; i++) {
      const ok = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
      assert.equal(ok.statusCode, 200, `upload #${i} should be accepted`);
    }
    const over = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(over.statusCode, 429);
    assert.match(over.json().error, /daily upload limit/i);
    assert.equal(over.json().limit, 20);
    // The streaming upload shares the same budget — also 429 once over.
    const overStream = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice } });
    assert.equal(overStream.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("rate limit is PER-CLIENT over HTTP: one client's exhausted budget does not 429 another (X-Forwarded-For)", async () => {
  // Per-client cap of 1, pinned clock. Client A exhausts its slot; client B (a
  // different X-Forwarded-For) still gets its own. This is the judging-window fix:
  // one busy visitor cannot lock the next judge out on their first upload.
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1, () => new Date("2026-07-06T09:00:00Z")) }));
  await local.ready();
  try {
    const a1 = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.1" }, payload: { invoice: sampleInvoice } });
    assert.equal(a1.statusCode, 200);
    const a2 = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.1" }, payload: { invoice: sampleInvoice } });
    assert.equal(a2.statusCode, 429, "client A is over its own cap");
    // A different client is NOT affected.
    const b1 = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.2" }, payload: { invoice: sampleInvoice } });
    assert.equal(b1.statusCode, 200, "client B has its own independent budget");
  } finally {
    await local.close();
  }
});

test("rate limit: an invalid payload is a 400 and does NOT consume budget", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // Two empty-body 400s must not exhaust the budget-of-1 …
    for (let i = 0; i < 2; i++) {
      const bad = await local.inject({ method: "POST", url: "/intake", payload: {} });
      assert.equal(bad.statusCode, 400);
    }
    // … so the one real upload still succeeds.
    const ok = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(ok.statusCode, 200);
  } finally {
    await local.close();
  }
});

test("POST /intake/document: a real PNG upload → Qwen-VL extraction → the loop → a PENDING proposal (SSE), executing nothing", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const { payload, headers } = multipartFile("file", "sample-invoice.png", "image/png", PNG_BYTES);
    const res = await local.inject({ method: "POST", url: "/intake/document", payload, headers: { ...headers, ...AUTH } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    // The stream shows extraction, then the live loop steps, then the proposal.
    assert.match(res.body, /event: extracting/);
    assert.match(res.body, /event: extracted/);
    assert.match(res.body, /Meridian Logistics/); // the fake-extracted invoice fields
    assert.match(res.body, /event: step/);
    assert.match(res.body, /recall_vendor_history/);
    assert.match(res.body, /event: proposal/);
    assert.match(res.body, /event: done/);
    // The human gate held: exactly one PENDING item, nothing executed, /decided empty.
    const pending = (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].execution, undefined);
    assert.equal(pending[0].invoice.vendor, "Meridian Logistics");
    const decided = (await local.inject({ method: "GET", url: "/decided", headers: AUTH })).json().decided;
    assert.equal(decided.length, 0);
  } finally {
    await local.close();
  }
});

test("POST /intake/document rejects an unsupported type (400) WITHOUT burning the daily budget", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // A .txt is rejected with 400 …
    const bad = multipartFile("file", "notes.txt", "text/plain", "hello");
    const badRes = await local.inject({ method: "POST", url: "/intake/document", payload: bad.payload, headers: bad.headers });
    assert.equal(badRes.statusCode, 400);
    // … and did NOT consume the budget-of-1, so a valid PNG still succeeds.
    const ok = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const okRes = await local.inject({ method: "POST", url: "/intake/document", payload: ok.payload, headers: ok.headers });
    assert.equal(okRes.statusCode, 200);
  } finally {
    await local.close();
  }
});

test("POST /intake/document shares the daily budget — the 2nd upload → 429 (open-demo guard)", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    const one = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const first = await local.inject({ method: "POST", url: "/intake/document", payload: one.payload, headers: one.headers });
    assert.equal(first.statusCode, 200);
    const two = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const over = await local.inject({ method: "POST", url: "/intake/document", payload: two.payload, headers: two.headers });
    assert.equal(over.statusCode, 429);
    assert.match(over.json().error, /daily upload limit/i);
    // The JSON intake shares the SAME exhausted budget.
    const overJson = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(overJson.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("POST /extract/document: a PNG upload → Qwen-VL extraction → invoice JSON + a ticket, running NO loop", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const { payload, headers } = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const res = await local.inject({ method: "POST", url: "/extract/document", payload, headers });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // The extracted invoice is returned for review …
    assert.equal(body.invoice.vendor, "Meridian Logistics");
    assert.equal(body.invoice.total, 6448);
    assert.equal(body.sourceType, "image");
    // … with a single-use process ticket …
    assert.ok(typeof body.ticket === "string" && body.ticket.length > 0);
    // … and NOTHING was proposed or executed: the queue is still empty.
    const pending = (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending;
    assert.equal(pending.length, 0);
  } finally {
    await local.close();
  }
});

test("POST /extract/document surfaces an extractor failure as 502 (the vision call failed)", async () => {
  const failing = {
    modelId: "boom-vision",
    async extract() { throw new Error("vision backend unavailable"); },
  };
  const local = await buildServer(deps({ extractor: failing }));
  await local.ready();
  try {
    const { payload, headers } = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const res = await local.inject({ method: "POST", url: "/extract/document", payload, headers });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "document extraction service unavailable");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /vision backend unavailable/);

    const streamed = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const streamRes = await local.inject({ method: "POST", url: "/intake/document", payload: streamed.payload, headers: streamed.headers });
    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.body, /event: error/);
    assert.match(streamRes.body, /requestId/);
    assert.doesNotMatch(streamRes.body, /vision backend unavailable/);
  } finally {
    await local.close();
  }
});

test("POST /extract/document rejects an unsupported type (400) WITHOUT burning the daily budget", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    const bad = multipartFile("file", "notes.txt", "text/plain", "hello");
    const badRes = await local.inject({ method: "POST", url: "/extract/document", payload: bad.payload, headers: bad.headers });
    assert.equal(badRes.statusCode, 400);
    // Budget-of-1 intact → a valid extract still succeeds.
    const ok = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const okRes = await local.inject({ method: "POST", url: "/extract/document", payload: ok.payload, headers: ok.headers });
    assert.equal(okRes.statusCode, 200);
  } finally {
    await local.close();
  }
});

test("two-step flow: extract consumes ONE slot, process-with-ticket consumes NONE (open-demo budget honored once)", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // Extract consumes the only slot and mints a ticket.
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({ method: "POST", url: "/extract/document", payload: up.payload, headers: up.headers });
    assert.equal(ex.statusCode, 200);
    const ticket = ex.json().ticket;
    const invoice = ex.json().invoice;
    // Processing the reviewed invoice WITH the ticket runs the loop WITHOUT a 2nd slot.
    const proc = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice, ticket } });
    assert.equal(proc.statusCode, 200);
    assert.match(proc.body, /event: proposal/);
    // Public processing is an isolated preview and never enters the durable queue.
    assert.match(proc.body, /"status":"preview"/);
    const pending = (await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending;
    assert.equal(pending.length, 0);
    // The budget is now exhausted for a NON-ticketed intake → 429.
    const over = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(over.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("a process ticket is single-use: replaying the SAME ticket consumes the daily budget the second time", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(2) }));
  await local.ready();
  try {
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({ method: "POST", url: "/extract/document", payload: up.payload, headers: up.headers });
    const ticket = ex.json().ticket; // consumed slot #1
    const invoice = ex.json().invoice;
    // First use: free (ticket valid) — budget still has 1 left.
    const first = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice, ticket } });
    assert.equal(first.statusCode, 200);
    // Replay the SAME ticket: it is spent, so this consumes slot #2 …
    const second = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice, ticket } });
    assert.equal(second.statusCode, 200);
    // … and the budget of 2 is now exhausted.
    const third = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(third.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("an unknown ticket does not skip the limiter (no free bypass)", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    // A made-up ticket must NOT grant free processing: it consumes the slot …
    const first = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice, ticket: "not-a-real-ticket" } });
    assert.equal(first.statusCode, 200);
    // … so the next intake is over budget.
    const over = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(over.statusCode, 429);
  } finally {
    await local.close();
  }
});

test("GET /sample-document serves the committed sample invoice PNG", async () => {
  const res = await app.inject({ method: "GET", url: "/sample-document" });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /image\/png/);
  // PNG magic bytes — a real, uncorrupted image (not text-normalized).
  assert.equal(res.rawPayload.subarray(0, 4).toString("latin1"), "\x89PNG");
  assert.ok(res.rawPayload.length > 1000);
});

test("GET /sample-document is bounded by isolated public/reviewer and global HTTP limits", async () => {
  const tiered = await buildServer(deps({
    trustProxy: false,
    httpRateLimiter: new InMemoryHttpRequestRateLimiter(() => 0),
    httpRequestLimits: { public: 1, reviewer: 2, global: 10 },
  }));
  await tiered.ready();
  try {
    assert.equal((await tiered.inject({ method: "GET", url: "/sample-document" })).statusCode, 200);
    const forged = await tiered.inject({
      method: "GET",
      url: "/sample-document",
      headers: { authorization: "Bearer forged-reviewer-token" },
    });
    assert.equal(forged.statusCode, 429, "invalid credentials remain in the exhausted public/IP bucket");
    assert.match(String(forged.headers["retry-after"]), /^\d+$/);

    assert.equal((await tiered.inject({ method: "GET", url: "/sample-document", headers: AUTH })).statusCode, 200);
    assert.equal((await tiered.inject({ method: "GET", url: "/sample-document", headers: AUTH })).statusCode, 200);
    const reviewerOver = await tiered.inject({ method: "GET", url: "/sample-document", headers: AUTH });
    assert.equal(reviewerOver.statusCode, 429, "valid reviewer credentials select a separate but bounded bucket");
  } finally {
    await tiered.close();
  }

  const globallyBounded = await buildServer(deps({
    httpRateLimiter: new InMemoryHttpRequestRateLimiter(() => 0),
    httpRequestLimits: { public: 10, reviewer: 10, global: 1 },
  }));
  await globallyBounded.ready();
  try {
    assert.equal((await globallyBounded.inject({ method: "GET", url: "/sample-document" })).statusCode, 200);
    const globalOver = await globallyBounded.inject({ method: "GET", url: "/sample-document", headers: AUTH });
    assert.equal(globalOver.statusCode, 429, "reviewer authentication never bypasses the global ceiling");
  } finally {
    await globallyBounded.close();
  }
});

test("GET /sample-document fails closed when its HTTP limiter cannot decide", async () => {
  const local = await buildServer(deps({
    httpRateLimiter: {
      consume() {
        throw new Error("limiter backend unavailable");
      },
    },
  }));
  await local.ready();
  try {
    const res = await local.inject({ method: "GET", url: "/sample-document" });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "internal server error");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(String(res.headers["content-type"]), /image\/png/);
  } finally {
    await local.close();
  }
});

test("security headers: helmet sets X-Frame-Options + X-Content-Type-Options on responses", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.headers["x-content-type-options"]).toLowerCase(), "nosniff");
  assert.ok(res.headers["x-frame-options"], "X-Frame-Options is set");
});

test("POST /intake sanitizes an upstream decider failure and returns a request id", async () => {
  // A loop whose run() throws models Qwen/the embedder being unreachable. The route
  // must translate that into a clean 503 { error }, not a generic 500.
  const boomLoop = {
    modelId: "boom",
    async run() { throw new Error("qwen unreachable"); },
  } as unknown as ServerDeps["loop"];
  const local = await buildServer(deps({ loop: boomLoop }));
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, "decision service unavailable");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /qwen unreachable/);

    const streamRes = await local.inject({ method: "POST", url: "/intake/stream", payload: { invoice: sampleInvoice } });
    assert.equal(streamRes.statusCode, 200);
    assert.match(streamRes.body, /event: error/);
    assert.match(streamRes.body, /requestId/);
    assert.doesNotMatch(streamRes.body, /qwen unreachable/);
  } finally {
    await local.close();
  }
});

test("global error handler: unexpected DB details stay in logs and the 500 returns only a generic error + request id", async () => {
  // A work-item store whose approve() throws a generic error exercises the guard()
  // rethrow → the global setErrorHandler, which must answer { error } (not a stack).
  const throwingStore = new InMemoryWorkItemStore();
  throwingStore.get = async () => { throw new Error("db exploded"); };
  throwingStore.claimPending = async () => { throw new Error("db exploded"); };
  const local = await buildServer(deps({ workitems: throwingStore }));
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/approve/anything", headers: AUTH });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(Object.keys(res.json()).sort(), ["error", "requestId"]);
    assert.equal(res.json().error, "internal server error");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /db exploded|at .*\(.*:\d+:\d+\)/);
  } finally {
    await local.close();
  }
});

test("approval 502 does not expose an uncertain sink failure detail", async () => {
  const localSinks = fakeSinks();
  const secret = "postgres://admin:password@private-db.internal/ap?api_key=sk-secret-value";
  let logs = "";
  localSinks.ledger.post = () => {
    throw new Error(`Authorization: Bearer top-secret-token ${secret}`);
  };
  const local = await buildServer(deps({
    sinks: localSinks,
    loggerStream: { write: (message) => { logs += message; } },
  }));
  await local.ready();
  try {
    const intake = await local.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice: sampleInvoice } });
    const res = await local.inject({ method: "POST", url: `/approve/${intake.json().id}`, headers: AUTH });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, "execution could not be confirmed; reconcile it before retrying");
    assert.ok(typeof res.json().requestId === "string" && res.json().requestId.length > 0);
    assert.doesNotMatch(JSON.stringify(res.json()), /top-secret|password|private-db|sk-secret|authorization/i);
    const pending = await local.inject({ method: "GET", url: "/pending", headers: AUTH });
    assert.equal(pending.statusCode, 200);
    const durable = JSON.stringify(pending.json());
    assert.match(durable, /storage_unavailable|authentication_failed|unexpected_failure/);
    assert.doesNotMatch(durable, /top-secret|password|private-db|sk-secret|authorization/i);
    assert.doesNotMatch(logs, /top-secret|password|private-db|sk-secret/i, "operator logs contain only safe taxonomy + reference");
    assert.match(logs, /operationalError/);
  } finally {
    await local.close();
  }
});

test("approval gate: a malformed :id that hits a uuid column (Postgres 22P02) → 400, not a 500 leak", async () => {
  // Simulate the pgvector store rejecting a non-UUID id with SQLSTATE 22P02.
  const pgLikeStore = new InMemoryWorkItemStore();
  const invalidUuid = () =>
    Promise.reject(Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: "22P02" }));
  pgLikeStore.get = invalidUuid;
  pgLikeStore.claimPending = invalidUuid;
  const local = await buildServer(deps({ workitems: pgLikeStore }));
  await local.ready();
  try {
    const probes = [
      { route: "/approve/not-a-uuid", payload: {} },
      { route: "/amend/not-a-uuid", payload: { args: {}, reason: "valid reviewer audit reason" } },
      { route: "/reject/not-a-uuid", payload: { reason: "valid reviewer audit reason" } },
    ];
    for (const { route, payload } of probes) {
      const res = await local.inject({ method: "POST", url: route, headers: AUTH, payload });
      assert.equal(res.statusCode, 400, `${route} should be 400`);
      assert.match(res.json().error, /invalid work item id/i);
    }
  } finally {
    await local.close();
  }
});

test("POST /intake/stream streams the reasoning live (SSE) then the proposal, executing nothing", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const res = await local.inject({ method: "POST", url: "/intake/stream", headers: AUTH, payload: { invoice: sampleInvoice } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    // The stream carries live step events, then the final proposal + done.
    assert.match(res.body, /event: step/);
    assert.match(res.body, /recall_vendor_history/);
    assert.match(res.body, /event: proposal/);
    assert.match(res.body, /event: done/);
    // It only PROPOSED — the item sits PENDING in the queue, nothing executed.
    const pending = await local.inject({ method: "GET", url: "/pending", headers: AUTH });
    assert.equal(pending.json().pending.length, 1);
    assert.equal(pending.json().pending[0].status, "pending");
    assert.equal(pending.json().pending[0].execution, undefined);
  } finally {
    await local.close();
  }
});

test("POST /intake/document rejects a compressed PNG pixel bomb before quota or Qwen", async () => {
  const local = await buildServer(deps({ rateLimiter: new DailyRateLimiter(1) }));
  await local.ready();
  try {
    const bomb = multipartFile("file", "bomb.png", "image/png", pngHeader(8192, 8192));
    const rejected = await local.inject({
      method: "POST", url: "/intake/document", payload: bomb.payload, headers: bomb.headers,
    });
    assert.equal(rejected.statusCode, 413);
    assert.match(rejected.json().error, /pixel safety limit|canvas/i);

    const valid = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const accepted = await local.inject({
      method: "POST", url: "/intake/document", payload: valid.payload, headers: valid.headers,
    });
    assert.equal(accepted.statusCode, 200, "preflight rejection must not consume the one daily slot");
  } finally {
    await local.close();
  }
});

test("reviewer decision bodies never coerce string booleans or numeric arguments", async () => {
  const sinks = fakeSinks();
  const local = await buildServer(deps({ sinks }));
  await local.ready();
  try {
    const intake = await local.inject({
      method: "POST", url: "/intake", headers: AUTH,
      payload: { invoice: { ...sampleInvoice, vendor: "Coercion Guard Supplies", invoice_number: "COERCE-1" } },
    });
    const id = intake.json().id as string;
    assert.equal(intake.json().proposed.tool, "draft_journal_entry");

    const stringBoolean = await local.inject({
      method: "POST", url: `/amend/${id}`, headers: AUTH,
      payload: {
        tool: "flag_for_review",
        args: { reason: "reviewer escalation", priority: "high" },
        confirmToolOverride: "true",
        reason: "explicit reviewer tool override",
      },
    });
    assert.equal(stringBoolean.statusCode, 400, "AJV must not coerce a string into reviewer authorization");

    const stringNumber = await local.inject({
      method: "POST", url: `/amend/${id}`, headers: AUTH,
      payload: { args: { amount: "90" }, reason: "reviewed amount adjustment" },
    });
    assert.equal(stringNumber.statusCode, 400, "tool validation must reject numeric strings rather than coerce them");
    assert.equal(sinks.ledger.entries().length, 0, "neither malformed decision reached a sink");
    const pending = await local.inject({ method: "GET", url: "/pending", headers: AUTH });
    assert.ok(pending.json().pending.some((item: { id: string }) => item.id === id), "proposal remains pending after both rejected bodies");
  } finally {
    await local.close();
  }
});

test("untrusted X-Forwarded-For cannot change public quota or process-ticket ownership", async () => {
  const local = await buildServer(deps({
    trustProxy: false,
    rateLimiter: new DailyRateLimiter(1, () => new Date("2026-07-06T09:00:00Z"), 10),
  }));
  await local.ready();
  try {
    const first = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.1" }, payload: { invoice: sampleInvoice } });
    assert.equal(first.statusCode, 200);
    const spoofed = await local.inject({ method: "POST", url: "/intake", headers: { "x-forwarded-for": "203.0.113.2" }, payload: { invoice: sampleInvoice } });
    assert.equal(spoofed.statusCode, 429, "forwarded IP is ignored when no trusted proxy is configured");
  } finally {
    await local.close();
  }
});

test("reviewer identity configuration fails closed on blank, control, or overlong values", async () => {
  for (const reviewerName of ["   ", "reviewer\nforged", "x".repeat(129)]) {
    await assert.rejects(() => buildServer(deps({ reviewerName })), /REVIEWER_NAME must be 1–128 printable characters/);
  }
});

test("a durable process-ticket store joins extraction and processing across server instances", async () => {
  const now = () => new Date("2026-07-15T10:00:00.000Z");
  const limiter = new DailyRateLimiter(1, now, 1);
  const ticketStore = new InMemoryProcessTicketStore();
  const a = await buildServer(deps({ rateLimiter: limiter, processTicketStore: ticketStore, processTicketNow: now }));
  const b = await buildServer(deps({ rateLimiter: limiter, processTicketStore: ticketStore, processTicketNow: now }));
  await Promise.all([a.ready(), b.ready()]);
  try {
    const ip = "203.0.113.77";
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const extracted = await a.inject({
      method: "POST", url: "/extract/document", payload: up.payload,
      headers: { ...up.headers, "x-forwarded-for": ip },
    });
    assert.equal(extracted.statusCode, 200);
    assert.equal(typeof extracted.json().ticket, "string", "the API returns an opaque string, never a Promise-shaped value");
    assert.equal(typeof extracted.json().extractionId, "string");
    const processed = await b.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice: extracted.json().invoice, ticket: extracted.json().ticket },
    });
    assert.equal(processed.statusCode, 200);
    assert.match(processed.body, /event: done/);
    const replay = await a.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice: extracted.json().invoice, ticket: extracted.json().ticket },
    });
    assert.equal(replay.statusCode, 429, "completed cross-instance ticket is consumed and ordinary quota is already spent");
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("pre-proposal failure releases a ticket only for the same reviewed-invoice digest", async () => {
  const now = () => new Date("2026-07-15T10:00:00.000Z");
  const limiter = new DailyRateLimiter(1, now, 1);
  const ticketStore = new InMemoryProcessTicketStore();
  const failingLoop = {
    modelId: "transient-failure",
    async run() { throw new Error("temporary upstream outage"); },
  } as unknown as ServerDeps["loop"];
  const first = await buildServer(deps({
    rateLimiter: limiter, processTicketStore: ticketStore, processTicketNow: now, loop: failingLoop,
  }));
  const retryServer = await buildServer(deps({ rateLimiter: limiter, processTicketStore: ticketStore, processTicketNow: now }));
  await Promise.all([first.ready(), retryServer.ready()]);
  try {
    const ip = "203.0.113.78";
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const extracted = await first.inject({
      method: "POST", url: "/extract/document", payload: up.payload,
      headers: { ...up.headers, "x-forwarded-for": ip },
    });
    const invoice = extracted.json().invoice;
    const failed = await first.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice, ticket: extracted.json().ticket },
    });
    assert.match(failed.body, /event: error/);

    const changed = await retryServer.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice: { ...invoice, total: Number(invoice.total) + 1 }, ticket: extracted.json().ticket },
    });
    assert.equal(changed.statusCode, 429, "a changed payload cannot spend the released same-digest entitlement");

    const retried = await retryServer.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice, ticket: extracted.json().ticket },
    });
    assert.equal(retried.statusCode, 200);
    assert.match(retried.body, /event: done/);
  } finally {
    await Promise.all([first.close(), retryServer.close()]);
  }
});

test("queue endpoints expose bounded pagination metadata", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    for (let i = 0; i < 3; i += 1) {
      await local.inject({
        method: "POST",
        url: "/intake",
        headers: AUTH,
        payload: { invoice: { ...sampleInvoice, vendor: `HTTP Page ${i}`, invoice_number: `HP-${i}` } },
      });
    }
    const res = await local.inject({ method: "GET", url: "/pending?limit=1&offset=1", headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().pending.length, 1);
    assert.deepEqual(res.json().page, { limit: 1, offset: 1, returned: 1, nextOffset: 2 });
    assert.equal((await local.inject({ method: "GET", url: "/pending?limit=501", headers: AUTH })).statusCode, 400);
  } finally {
    await local.close();
  }
});

test("live reference collision with changed amount returns 409 and preserves one proposal", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const invoice = { ...sampleInvoice, vendor: "HTTP Collision Co", invoice_number: "HC-1" };
    assert.equal((await local.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice } })).statusCode, 200);
    const collision = await local.inject({
      method: "POST",
      url: "/intake",
      headers: AUTH,
      payload: { invoice: { ...invoice, subtotal: 900, tax: 100, total: 1000 } },
    });
    assert.equal(collision.statusCode, 409);
    assert.match(collision.json().error, /identity collides/i);
    assert.equal((await local.inject({ method: "GET", url: "/pending", headers: AUTH })).json().pending.length, 1);
  } finally {
    await local.close();
  }
});

test("approval UI has a strict hash-based CSP with no inline-attribute escape hatch", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  const csp = String(res.headers["content-security-policy"] ?? "");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /style-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /style-src-attr 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(res.body, /<[^>]+\sstyle=/i, "UI markup has no inline style attributes");
  assert.doesNotMatch(res.body, /<[^>]+\son[a-z]+=/i, "UI markup has no inline event handlers");
});

test("structured logger redacts bearer, reviewer-token, and deployment-gate fields", async () => {
  let logs = "";
  const local = await buildServer(deps({ loggerStream: { write: (message) => { logs += message; } } }));
  await local.ready();
  try {
    const secret = "super-secret-reviewer-token-value";
    local.log.info({
      req: { headers: { authorization: `Bearer ${secret}`, "x-reviewer-token": secret, "x-archon-deployment-gate": secret } },
      request: { headers: { authorization: `Bearer ${secret}`, "x-reviewer-token": secret, "x-archon-deployment-gate": secret } },
      headers: { authorization: `Bearer ${secret}`, "x-reviewer-token": secret, "x-archon-deployment-gate": secret },
      authorization: `Bearer ${secret}`,
      reviewerToken: secret,
      token: secret,
    }, "redaction probe");
    assert.doesNotMatch(logs, new RegExp(secret));
    assert.match(logs, /\[REDACTED\]/);
  } finally {
    await local.close();
  }
});

test("4xx validation logging records only safe taxonomy, never parser/body secret detail", async () => {
  let logs = "";
  const secret = "api_key=sk-private password=hunter2 C:\\private\\invoice.json";
  const local = await buildServer(deps({ loggerStream: { write: (message) => { logs += message; } } }));
  await local.ready();
  try {
    const res = await local.inject({
      method: "POST",
      url: "/reject/not-used",
      headers: AUTH,
      payload: { reason: "valid audit reason", [secret]: secret },
    });
    assert.equal(res.statusCode, 400);
    assert.doesNotMatch(logs, /sk-private|hunter2|private\\invoice|api_key/i);
    assert.match(logs, /operationalError/);
    assert.match(logs, /request rejected/);
  } finally {
    await local.close();
  }
});

test("process ticket expires by TTL and then falls through to normal quota", async () => {
  let now = new Date("2026-07-15T10:00:00.000Z");
  const limiter = new DailyRateLimiter(1, () => now, 10);
  const local = await buildServer(deps({
    rateLimiter: limiter,
    processTicketNow: () => now,
    processTicketTtlMs: 1000,
  }));
  await local.ready();
  try {
    const ip = "203.0.113.10";
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({
      method: "POST", url: "/extract/document", payload: up.payload,
      headers: { ...up.headers, "x-forwarded-for": ip },
    });
    now = new Date(now.getTime() + 1001);
    const expired = await local.inject({
      method: "POST", url: "/intake/stream",
      headers: { "x-forwarded-for": ip },
      payload: { invoice: ex.json().invoice, ticket: ex.json().ticket },
    });
    assert.equal(expired.statusCode, 429, "expired ticket cannot bypass the already-spent quota");
  } finally {
    await local.close();
  }
});

test("process ticket cap evicts the oldest ticket while retaining the newest", async () => {
  const now = new Date("2026-07-15T10:00:00.000Z");
  const local = await buildServer(deps({
    rateLimiter: new DailyRateLimiter(2, () => now, 2),
    processTicketNow: () => now,
    processTicketCap: 1,
  }));
  await local.ready();
  try {
    const ip = "203.0.113.20";
    const extract = async () => {
      const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
      return local.inject({
        method: "POST", url: "/extract/document", payload: up.payload,
        headers: { ...up.headers, "x-forwarded-for": ip },
      });
    };
    const first = await extract();
    const second = await extract();
    const evicted = await local.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice: first.json().invoice, ticket: first.json().ticket },
    });
    assert.equal(evicted.statusCode, 429);
    const newest = await local.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice: second.json().invoice, ticket: second.json().ticket },
    });
    assert.equal(newest.statusCode, 200, "newest bounded ticket remains valid even after quota exhaustion");
  } finally {
    await local.close();
  }
});

test("process ticket is bound to its owner identity; a cross-IP attempt neither uses nor destroys it", async () => {
  const now = new Date("2026-07-15T10:00:00.000Z");
  const local = await buildServer(deps({
    rateLimiter: new DailyRateLimiter(1, () => now, 2),
    processTicketNow: () => now,
  }));
  await local.ready();
  try {
    const owner = "203.0.113.30";
    const thief = "203.0.113.31";
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({
      method: "POST", url: "/extract/document", payload: up.payload,
      headers: { ...up.headers, "x-forwarded-for": owner },
    });
    const stolen = await local.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": thief },
      payload: { invoice: ex.json().invoice, ticket: ex.json().ticket },
    });
    assert.equal(stolen.statusCode, 200, "mismatch receives only the thief's ordinary quota");
    const ownerUse = await local.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": owner },
      payload: { invoice: ex.json().invoice, ticket: ex.json().ticket },
    });
    assert.equal(ownerUse.statusCode, 200, "owner can still consume the intact ticket after global quota is full");
  } finally {
    await local.close();
  }
});

test("process tickets cannot be stockpiled across the UTC day boundary", async () => {
  let now = new Date("2026-07-15T23:59:30.000Z");
  const local = await buildServer(deps({
    rateLimiter: new DailyRateLimiter(1, () => now, 10),
    processTicketNow: () => now,
    processTicketTtlMs: 24 * 60 * 60_000,
  }));
  await local.ready();
  try {
    const ip = "203.0.113.40";
    const up = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const ex = await local.inject({
      method: "POST", url: "/extract/document", payload: up.payload,
      headers: { ...up.headers, "x-forwarded-for": ip },
    });
    now = new Date("2026-07-16T00:00:30.000Z");
    const oldDay = await local.inject({
      method: "POST", url: "/intake/stream", headers: { "x-forwarded-for": ip },
      payload: { invoice: ex.json().invoice, ticket: ex.json().ticket },
    });
    assert.equal(oldDay.statusCode, 200, "old-day ticket falls through and spends today's ordinary slot");
    const over = await local.inject({
      method: "POST", url: "/intake", headers: { "x-forwarded-for": ip }, payload: { invoice: sampleInvoice },
    });
    assert.equal(over.statusCode, 429, "the old-day ticket did not grant a free new-day process");
  } finally {
    await local.close();
  }
});

test("public intake surfaces are isolated previews and cannot exfiltrate durable vendor history", async () => {
  const SECRET = "PRIVATE approved amount EUR 987654 reference SECRET-ERP-42";
  const embedder = new FakeEmbedder();
  const memory = new InMemoryStore();
  for (const vendor of ["Confidential Vendor", "Meridian Logistics"]) {
    await memory.remember({
      kind: "insight",
      vendor,
      content: SECRET,
      metadata: { confidential: true },
      embedding: await embedder.embed(SECRET),
      embedModel: embedder.modelId,
    });
  }
  const workitems = new InMemoryWorkItemStore();
  const local = await buildServer(deps({ embedder, memory, workitems }));
  await local.ready();
  try {
    const invoice = {
      ...sampleInvoice,
      vendor: "Confidential Vendor",
      invoice_number: "PUBLIC-PROBE-1",
    };
    const publicJson = await local.inject({ method: "POST", url: "/intake", payload: { invoice } });
    assert.equal(publicJson.statusCode, 200);
    assert.equal(publicJson.json().status, "preview");
    assert.equal(publicJson.json().durable, false);
    assert.deepEqual(publicJson.json().recalled, []);
    assert.doesNotMatch(publicJson.body, /PRIVATE approved|SECRET-ERP|987654/);
    assert.doesNotMatch(publicJson.body, /"raw"\s*:/, "arbitrary raw invoice payload is never reflected");

    const publicStream = await local.inject({
      method: "POST", url: "/intake/stream", payload: { invoice: { ...invoice, invoice_number: "PUBLIC-PROBE-2" } },
    });
    assert.equal(publicStream.statusCode, 200);
    assert.match(publicStream.body, /"status":"preview"/);
    assert.doesNotMatch(publicStream.body, /PRIVATE approved|SECRET-ERP|987654/);
    assert.doesNotMatch(publicStream.body, /"raw"\s*:/);

    const upload = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const publicDocument = await local.inject({
      method: "POST", url: "/intake/document", payload: upload.payload, headers: upload.headers,
    });
    assert.equal(publicDocument.statusCode, 200);
    assert.match(publicDocument.body, /"status":"preview"/);
    assert.doesNotMatch(publicDocument.body, /PRIVATE approved|SECRET-ERP|987654/);
    assert.doesNotMatch(publicDocument.body, /"raw"\s*:/);

    const queueAfterPublic = await local.inject({ method: "GET", url: "/pending", headers: AUTH });
    assert.equal(queueAfterPublic.json().pending.length, 0, "public previews never enter the durable reviewer queue");

    const reviewer = await local.inject({
      method: "POST", url: "/intake", headers: AUTH,
      payload: { invoice: { ...invoice, invoice_number: "REVIEWER-1" } },
    });
    assert.equal(reviewer.statusCode, 200);
    assert.equal(reviewer.json().status, "pending");
    assert.match(reviewer.body, /PRIVATE approved amount EUR 987654/,
      "authenticated reviewer receives the full durable evidence view");
    const queueAfterReviewer = await local.inject({ method: "GET", url: "/pending", headers: AUTH });
    assert.equal(queueAfterReviewer.json().pending.length, 1);
  } finally {
    await local.close();
  }
});

test("authenticated reviewer reserve is isolated, bounded, and invalid credentials stay on public quota", async () => {
  const now = () => new Date("2026-07-06T09:00:00Z");
  const local = await buildServer(deps({
    rateLimiter: new DailyRateLimiter(1, now, 1),
    reviewerRateLimiter: new DailyRateLimiter(1, now, 1),
  }));
  await local.ready();
  try {
    // Spend the entire PUBLIC global budget.
    const publicUse = await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } });
    assert.equal(publicUse.statusCode, 200);

    // A forged credential must not probe or consume the protected reserve.
    const invalid = await local.inject({
      method: "POST", url: "/intake",
      headers: { authorization: "Bearer definitely-not-the-reviewer-token" },
      payload: { invoice: { ...sampleInvoice, invoice_number: "INVALID-2" } },
    });
    assert.equal(invalid.statusCode, 429);
    assert.equal(invalid.json().quota, "public");

    // The valid out-of-band credential still has one isolated slot.
    const judge = await local.inject({
      method: "POST", url: "/intake", headers: AUTH,
      payload: { invoice: { ...sampleInvoice, invoice_number: "JUDGE-1" } },
    });
    assert.equal(judge.statusCode, 200, "public exhaustion cannot starve an authenticated judge");

    // It is a reserve, never an unlimited bypass.
    const judgeOver = await local.inject({
      method: "POST", url: "/intake", headers: AUTH,
      payload: { invoice: { ...sampleInvoice, invoice_number: "JUDGE-2" } },
    });
    assert.equal(judgeOver.statusCode, 429);
    assert.equal(judgeOver.json().quota, "reviewer");
    assert.match(judgeOver.json().error, /reviewer reserve/i);
    assert.doesNotMatch(JSON.stringify(judgeOver.json()), new RegExp(REVIEWER_TOKEN));
  } finally {
    await local.close();
  }
});

test("document extraction also uses the isolated authenticated reviewer reserve", async () => {
  const now = () => new Date("2026-07-06T09:00:00Z");
  const local = await buildServer(deps({
    rateLimiter: new DailyRateLimiter(1, now, 1),
    reviewerRateLimiter: new DailyRateLimiter(1, now, 1),
  }));
  await local.ready();
  try {
    // Exhaust public capacity with JSON, then use the independent reserve for vision.
    assert.equal((await local.inject({ method: "POST", url: "/intake", payload: { invoice: sampleInvoice } })).statusCode, 200);
    const upload = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const extracted = await local.inject({ method: "POST", url: "/extract/document", headers: { ...upload.headers, ...AUTH }, payload: upload.payload });
    assert.equal(extracted.statusCode, 200);
    assert.ok(extracted.json().ticket, "the normal extract-only contract remains intact");

    const second = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const over = await local.inject({ method: "POST", url: "/intake/document", headers: { ...second.headers, ...AUTH }, payload: second.payload });
    assert.equal(over.statusCode, 429);
    assert.equal(over.json().quota, "reviewer");
  } finally {
    await local.close();
  }
});

test("provider admission isolates public and reviewer run pools and fails fast before quota", async () => {
  const embedder = new HoldingEmbedder();
  const publicLimiter = new DailyRateLimiter(20, () => new Date("2026-07-15T12:00:00Z"), 100);
  const reviewerLimiter = new DailyRateLimiter(20, () => new Date("2026-07-15T12:00:00Z"), 100);
  const local = await buildServer(deps({
    embedder,
    rateLimiter: publicLimiter,
    reviewerRateLimiter: reviewerLimiter,
    providerAdmission: new TieredProviderRunAdmission({ public: 1, reviewer: 1 }),
  }));
  await local.ready();
  try {
    const publicRun = local.inject({ method: "POST", url: "/intake", payload: { invoice: { ...sampleInvoice, invoice_number: "CAP-P1" } } });
    await embedder.waitForStarted(1);

    const publicBusy = await local.inject({ method: "POST", url: "/intake", payload: { invoice: { ...sampleInvoice, invoice_number: "CAP-P2" } } });
    assert.equal(publicBusy.statusCode, 503);
    assert.equal(publicBusy.headers["retry-after"], "5");
    assert.equal(publicBusy.json().error, "provider workflow capacity is temporarily busy");

    const reviewerRun = local.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice: { ...sampleInvoice, invoice_number: "CAP-R1" } } });
    await embedder.waitForStarted(2);
    const reviewerBusy = await local.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice: { ...sampleInvoice, invoice_number: "CAP-R2" } } });
    assert.equal(reviewerBusy.statusCode, 503, "the isolated reviewer pool is also bounded");

    embedder.release();
    assert.equal((await publicRun).statusCode, 200);
    assert.equal((await reviewerRun).statusCode, 200, "public saturation never consumes reviewer reserve");

    // Only admitted calls consumed quota: the two fail-fast busy calls did not.
    const publicThird = await local.inject({ method: "POST", url: "/intake", payload: { invoice: { ...sampleInvoice, invoice_number: "CAP-P3" } } });
    assert.equal(publicThird.statusCode, 200);
  } finally {
    embedder.release();
    await local.close();
  }
});

test("provider admission releases capacity after an upstream failure", async () => {
  class FailOnceEmbedder extends FakeEmbedder {
    private fail = true;
    override async embed(text: string, signal?: AbortSignal): Promise<number[]> {
      if (this.fail) {
        this.fail = false;
        throw new Error("provider unavailable");
      }
      return super.embed(text, signal);
    }
  }
  const local = await buildServer(deps({
    embedder: new FailOnceEmbedder(),
    providerAdmission: new TieredProviderRunAdmission({ public: 1, reviewer: 1 }),
  }));
  await local.ready();
  try {
    const failed = await local.inject({ method: "POST", url: "/intake", payload: { invoice: { ...sampleInvoice, invoice_number: "FAIL-1" } } });
    assert.equal(failed.statusCode, 503);
    const recovered = await local.inject({ method: "POST", url: "/intake", payload: { invoice: { ...sampleInvoice, invoice_number: "FAIL-2" } } });
    assert.equal(recovered.statusCode, 200, "the failed workflow released its only public lease");
  } finally {
    await local.close();
  }
});

test("document render admission is shared across public and reviewer tiers and releases after settlement", async () => {
  const extractor = new HoldingExtractor();
  const now = () => new Date("2026-07-15T12:00:00Z");
  const local = await buildServer(deps({
    extractor,
    rateLimiter: new DailyRateLimiter(2, now, 10),
    reviewerRateLimiter: new DailyRateLimiter(1, now, 10),
    providerAdmission: new TieredProviderRunAdmission({ public: 1, reviewer: 1 }),
    documentAdmission: new BoundedDocumentRenderAdmission(1),
  }));
  await local.ready();
  try {
    const firstUpload = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const first = local.inject({
      method: "POST",
      url: "/extract/document",
      headers: firstUpload.headers,
      payload: firstUpload.payload,
    });
    await extractor.started;
    const busyUpload = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const busy = await local.inject({
      method: "POST",
      url: "/extract/document",
      headers: { ...busyUpload.headers, ...AUTH },
      payload: busyUpload.payload,
    });
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.headers["retry-after"], "5");
    extractor.release();
    assert.equal((await first).statusCode, 200);

    const retryUpload = multipartFile("file", "invoice.png", "image/png", PNG_BYTES);
    const retry = await local.inject({
      method: "POST",
      url: "/extract/document",
      headers: { ...retryUpload.headers, ...AUTH },
      payload: retryUpload.payload,
    });
    assert.equal(retry.statusCode, 200, "busy attempt did not spend the single reviewer quota slot");
  } finally {
    extractor.release();
    await local.close();
  }
});

test("GET / includes the real correction-learning guided scenario and measured evidence panel", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Correction-learning challenge/);
  assert.match(res.body, /id="learnBaseline"/);
  assert.match(res.body, /id="learnAmend"/);
  assert.match(res.body, /id="learnTest"/);
  assert.match(res.body, /OVERBILL-5000/);
  assert.match(res.body, /REBILL-5000/);
  assert.match(res.body, /CONTROL-3000/);
  assert.match(res.body, /\/impact-metrics/);
});

test("workflow telemetry and /impact-metrics report measured steps/catches/touches without ROI claims", async () => {
  const local = await buildServer(deps());
  await local.ready();
  try {
    const intake = await local.inject({ method: "POST", url: "/intake", headers: AUTH, payload: { invoice: sampleInvoice } });
    const item = intake.json();
    assert.equal(item.status, "pending");
    assert.ok(item.telemetry.intakeToProposalMs >= 0);
    assert.ok(item.telemetry.modelCalls >= 1);
    assert.ok(item.telemetry.readAnalyzeSteps >= 2);
    assert.equal(item.telemetry.humanTouches, 0);

    const before = await local.inject({ method: "GET", url: "/impact-metrics", headers: AUTH });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().proposals.total, 1);
    assert.equal(before.json().humanGate.touches, 0);
    assert.match(before.json().disclaimer, /no production time-and-motion study/i);

    await local.inject({ method: "POST", url: `/reject/${item.id}`, headers: AUTH, payload: { reason: "unit test" } });
    const after = await local.inject({ method: "GET", url: "/impact-metrics", headers: AUTH });
    assert.equal(after.json().humanGate.touches, 1);
    assert.equal(after.json().humanGate.rejected, 1);
  } finally {
    await local.close();
  }
});

test("buildImpactMetrics remains compatible with legacy work items that predate telemetry", () => {
  const legacy = {
    id: "legacy", status: "rejected", invoice: {}, findings: [], recalled: [], proposed: {},
    trace: [{ step: 1, tool: "recall_vendor_history", args: {}, observation: "", reasoning: "" }],
    stopReason: "terminal_action", createdAt: "2026-01-01T00:00:00Z", decidedAt: "2026-01-01T00:01:00Z",
  } as unknown as WorkItem;
  const metrics = buildImpactMetrics([legacy]);
  assert.equal(metrics.proposals.total, 1);
  assert.equal(metrics.orchestration.averageReadAnalyzeSteps, 1);
  assert.equal(metrics.humanGate.touches, 1);
});
