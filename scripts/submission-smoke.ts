// Operator-only post-deploy canary. It exercises the actual deployed Qwen-VL
// extraction and Qwen tool loop, proves the result stops at PENDING, then rejects
// the canary through the authenticated gate. No credential or raw document data is
// printed or persisted. Run only against the final deployed revision.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplePath = resolve(ROOT, "demo/sample-invoice.png");

if (process.argv.includes("--check")) {
  const bytes = await readFile(samplePath);
  if (bytes.length < 8 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("submission smoke sample must be a valid PNG fixture");
  }
  validateSmokeConfig("https://submission.example.test", "x".repeat(32), false);
  for (const [candidateBase, candidateToken] of [
    ["http://submission.example.test", "x".repeat(32)],
    ["https://user:secret@submission.example.test", "x".repeat(32)],
    ["https://submission.example.test", "too-short"],
  ] as const) {
    let rejected = false;
    try { validateSmokeConfig(candidateBase, candidateToken, false); } catch { rejected = true; }
    if (!rejected) throw new Error("submission smoke static configuration guard did not fail closed");
  }
  validateSmokeConfig("http://localhost:9000", "x".repeat(32), true);
  validateSmokeConfig("http://127.0.0.1:9000", "x".repeat(32), true);
  validateSmokeConfig("http://[::1]:9000", "x".repeat(32), true);
  for (const cleartextExternal of [
    "http://submission.example.test",
    "http://localhost.example.test",
    "http://127.0.0.2",
  ]) {
    let rejected = false;
    try { validateSmokeConfig(cleartextExternal, "x".repeat(32), true); } catch { rejected = true; }
    if (!rejected) throw new Error("ALLOW_HTTP_LOCAL_SMOKE must never authorize cleartext credentials to a non-loopback host");
  }
  console.log("Submission smoke static contract: PASS (zero network; HTTPS, credential, token, and PNG guards verified)");
  process.exit(0);
}

const { base, token, parsedBase } = validateSmokeConfig(
  process.env.SUBMISSION_BASE_URL ?? "",
  process.env.REVIEWER_TOKEN ?? "",
  process.env.ALLOW_HTTP_LOCAL_SMOKE === "true"
);

const auth = { authorization: `Bearer ${token}` };
let canaryId: string | null = null;

async function json<T extends Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* sanitized error below */ }
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${String(body.error ?? "unexpected response")}`);
  return body as T;
}

try {
  const started = performance.now();
  const health = await json<{status:unknown;decider:unknown;embedder:unknown;store:unknown}>("/health");
  if (health.status !== "ok" || String(health.decider).startsWith("fake-") || String(health.embedder).startsWith("fake-")) {
    throw new Error("deployed health does not identify a live decider and embedder");
  }
  const ready = await json<{status:unknown}>("/ready");
  if (ready.status !== "ready") throw new Error("deployed service is not ready");

  const bytes = await readFile(samplePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), "sample-invoice.png");
  const extracted = await json<{
    model: unknown; pages: unknown; invoice: Record<string, unknown>;
  }>("/extract/document", { method: "POST", headers: auth, body: form });
  if (String(extracted.model).startsWith("fake-") || !extracted.invoice || !extracted.invoice.vendor) {
    throw new Error("deployed extraction did not return live-model invoice fields");
  }

  // Unique identity avoids reusing a pre-existing live proposal while retaining
  // the actual vision-extracted financial fields for the decision canary.
  const stamp = Date.now().toString(36).toUpperCase();
  const invoice = {
    ...extracted.invoice,
    vendor: `Submission Canary ${stamp}`,
    invoice_number: `CANARY-${stamp}`,
    invoice_date: new Date().toISOString().slice(0, 10),
  };
  const pending = await json<{
    id: unknown; status: unknown; proposed: Record<string, unknown>;
    trace: Array<Record<string, unknown>>; telemetry?: Record<string, unknown>;
  }>("/intake", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ invoice }),
  });
  if (typeof pending.id !== "string" || pending.status !== "pending") throw new Error("decision canary did not stop at PENDING");
  if (!pending.proposed || String(pending.proposed.modelId).startsWith("fake-")) throw new Error("decision canary did not identify a live model/policy result");
  if (!Array.isArray(pending.trace) || pending.trace.length < 2) throw new Error("decision canary did not gather a multi-step trace");
  canaryId = pending.id;

  console.log(JSON.stringify({
    status: "PASS",
    host: parsedBase.host,
    health: { decider: health.decider, embedder: health.embedder, store: health.store },
    vision: { model: extracted.model, pages: extracted.pages },
    decision: {
      status: pending.status,
      proposedTool: pending.proposed.tool,
      proposedBy: pending.proposed.modelId,
      traceTools: pending.trace.map((step) => step.tool),
      policyOverride: pending.telemetry?.policyOverride ?? null,
    },
    wallClockMs: Math.round((performance.now() - started) * 100) / 100,
    cleanup: "rejecting canary",
  }, null, 2));
} finally {
  if (canaryId) {
    await json(`/reject/${encodeURIComponent(canaryId)}`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reason: "post-deploy submission canary cleanup" }),
    });
    console.log("Canary cleanup: rejected through the authenticated human gate.");
  }
}

function validateSmokeConfig(
  rawBase: string,
  rawToken: string,
  allowHttpLocal: boolean
): { base: string; token: string; parsedBase: URL } {
  const base = rawBase.trim().replace(/\/+$/, "");
  const token = rawToken.trim();
  if (!base) throw new Error("SUBMISSION_BASE_URL is required");
  const parsedBase = new URL(base);
  if (parsedBase.username || parsedBase.password) throw new Error("do not place credentials in SUBMISSION_BASE_URL");
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(parsedBase.hostname.toLowerCase());
  if (parsedBase.protocol !== "https:" && !(allowHttpLocal && parsedBase.protocol === "http:" && loopback)) {
    throw new Error("submission smoke requires HTTPS; ALLOW_HTTP_LOCAL_SMOKE permits HTTP only on localhost/127.0.0.1/[::1]");
  }
  if (token.length < 32) throw new Error("REVIEWER_TOKEN must contain at least 32 characters; it is never printed");
  return { base, token, parsedBase };
}
