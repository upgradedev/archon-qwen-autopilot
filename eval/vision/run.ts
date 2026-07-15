// Original synthetic document-extraction benchmark for qwen-vl-max.
// `--check` validates the 16 committed fixtures without network/spend.
// `--online --runs 3 --write ...` records every attempt, error and miss.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasQwenCreds, officialEvidenceEndpoint, requiresNonThinkingJsonOrTools, type OfficialEvidenceEndpoint } from "../../src/qwen/client.js";
import { QwenVisionExtractionClient, DEFAULT_VISION_MODEL, MAX_PDF_PAGES, MAX_DOCUMENT_BYTES, VISION_TIMEOUT_MS, POPPLER_TIMEOUT_MS, validateDocument, validateMagicBytes } from "../../src/qwen/vision.js";
import { normalizeInvoice } from "../../src/ap/normalize.js";
import { validateInvoice } from "../../src/ap/validate.js";
import { hasLowExtractionConfidence } from "../../src/ap/extraction-confidence.js";
import { canonicalEvidenceCommand, categoricalEvalError, createExclusiveEvidenceArtifact, persistEvidenceArtifact } from "../artifact-safety.js";

interface GroundTruth {
  vendor: string | null; invoice_number: string | null; invoice_date: string | null;
  tax_id: string | null; currency: string | null; subtotal: number | null; tax: number | null; total: number | null;
}
interface VisionCase { id: string; filename: string; variant: string; safeReviewExpected: boolean; groundTruth: GroundTruth }
interface Manifest { schemaVersion: number; license: string; cases: VisionCase[] }

const ROOT = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const manifest = JSON.parse(await readFile(resolve(ROOT, "manifest.json"), "utf8")) as Manifest;

function sha(buf: Buffer | string): string { return createHash("sha256").update(buf).digest("hex"); }
function mime(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : "image/jpeg";
}

async function verifyFixtures(): Promise<string> {
  if (manifest.cases.length < 12 || manifest.cases.length > 20) throw new Error("vision manifest must contain 12–20 cases");
  const lock = (await readFile(resolve(ROOT, "fixtures.sha256"), "utf8")).trim().split(/\r?\n/);
  const expected = new Map(lock.map((line) => { const [hash, ...parts] = line.trim().split(/\s+/); return [parts.join(" "), hash]; }));
  for (const c of manifest.cases) {
    const path = resolve(ROOT, c.filename);
    const rel = relative(ROOT, path).replace(/\\/g, "/");
    if (isAbsolute(relative(ROOT, path)) || relative(ROOT, path).startsWith("..")) throw new Error(`${c.id}: fixture escapes benchmark directory`);
    const bytes = await readFile(path);
    if (sha(bytes) !== expected.get(rel)) throw new Error(`${c.id}: fixture hash mismatch for ${rel}`);
    const v = validateDocument({ filename: path, mimetype: mime(path), size: bytes.length });
    if (!v.ok) throw new Error(`${c.id}: ${v.error}`);
    const mb = validateMagicBytes(bytes, v.ext);
    if (!mb.ok) throw new Error(`${c.id}: ${mb.error}`);
  }
  const manifestBytes = await readFile(resolve(ROOT, "manifest.json"));
  if (sha(manifestBytes) !== expected.get("manifest.json")) throw new Error("vision manifest hash mismatch");
  return sha(`${lock.join("\n")}\n`);
}

async function provenance(fixtureSetSha256: string, commandArgs: string[], endpoint: OfficialEvidenceEndpoint | null) {
  const files = [
    "eval/vision/manifest.json", "eval/vision/fixtures.sha256", "eval/vision/generate_fixtures.py",
    "eval/vision/run.ts", "eval/artifact-safety.ts", "src/qwen/vision.ts", "src/ap/normalize.ts", "src/ap/validate.ts",
    "src/ap/extraction-confidence.ts", "src/ap/currency.ts", "src/ap/finance-policy.ts",
    "src/qwen/client.ts", "src/types.ts", "package-lock.json",
  ];
  const h = createHash("sha256");
  for (const file of files) h.update(file).update(await readFile(resolve(process.cwd(), file)));
  let commit: string | null = null, clean: boolean | null = null, protocolTreeClean: boolean | null = null;
  let allowedDirtyResultArtifacts: Array<{ status: string; path: string }> = [];
  let disallowedDirtyPaths: Array<{ status: string; path: string }> = [];
  try {
    commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
    for (const file of files) {
      await exec("git", ["ls-files", "--error-unmatch", "--", file], { cwd: process.cwd() });
      await exec("git", ["diff", "--quiet", "HEAD", "--", file], { cwd: process.cwd() });
    }
    const statusText = (await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: process.cwd() })).stdout;
    const dirty = statusText.split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, "") }));
    allowedDirtyResultArtifacts = dirty.filter(
      (entry) => !entry.status.includes("D") && !entry.status.includes("R") && /^eval\/results\/[A-Za-z0-9._-]+\.json$/.test(entry.path)
    );
    const allowed = new Set(allowedDirtyResultArtifacts.map((entry) => `${entry.status}\0${entry.path}`));
    disallowedDirtyPaths = dirty.filter((entry) => !allowed.has(`${entry.status}\0${entry.path}`));
    clean = dirty.length === 0;
    protocolTreeClean = disallowedDirtyPaths.length === 0;
  } catch { /* preserve null rather than invent provenance */ }
  const pkg = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {version:string;dependencies?:Record<string,string>};
  return {
    fixtureSetSha256, protocolSha256: h.digest("hex"), files, gitCommit: commit, gitClean: clean,
    protocolTreeClean, allowedDirtyResultArtifacts, disallowedDirtyPaths,
    command: canonicalEvidenceCommand("eval/vision/run.ts", commandArgs), node: process.version,
    packageVersion: pkg.version, openaiSdk: pkg.dependencies?.openai, providerEndpoint: endpoint,
    parameters: {
      visionModelId: DEFAULT_VISION_MODEL,
      temperature: 0.1,
      responseFormat: requiresNonThinkingJsonOrTools(DEFAULT_VISION_MODEL) ? "json_object" : "omitted",
      enableThinking: requiresNonThinkingJsonOrTools(DEFAULT_VISION_MODEL) ? false : "provider-default",
      maxTokens: requiresNonThinkingJsonOrTools(DEFAULT_VISION_MODEL) ? "omitted" : 2048,
      maxPdfPages: MAX_PDF_PAGES,
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
      visionTimeoutMs: VISION_TIMEOUT_MS,
      popplerTimeoutMs: POPPLER_TIMEOUT_MS,
      errorPolicy: "errors stay in fixed denominators and mark a run incomplete",
    },
  };
}

function exact(expected: unknown, actual: unknown): boolean {
  if (expected == null) return actual == null || actual === "";
  return String(expected).trim() === String(actual ?? "").trim();
}
function normalizedExact(expected: unknown, actual: unknown): boolean {
  if (expected == null) return actual == null || actual === "";
  return String(expected).trim().toLocaleLowerCase() === String(actual ?? "").trim().toLocaleLowerCase();
}
function numeric(expected: number | null, actual: unknown): boolean {
  if (expected == null) return actual == null;
  const got = typeof actual === "number" ? actual : Number(actual);
  return Number.isFinite(got) && Math.abs(got - expected) <= 0.01;
}

function safeReview(invoice: Record<string, unknown>): { predicted: boolean; reasons: string[] } {
  const normalized = normalizeInvoice(invoice);
  const failed = validateInvoice(normalized).filter((f) => !f.passed).map((f) => f.rule);
  const low = hasLowExtractionConfidence(normalized.extraction_confidence);
  return { predicted: low || failed.length > 0, reasons: [...(low ? ["low_extraction_confidence"] : []), ...failed] };
}

async function runCase(c: VisionCase, extractor: QwenVisionExtractionClient) {
  const started = performance.now();
  try {
    const path = resolve(ROOT, c.filename);
    const buffer = await readFile(path);
    const result = await extractor.extract({ buffer, filename: path, mimetype: mime(path) });
    const got = result.invoice;
    const strings = ["vendor", "invoice_number", "invoice_date", "tax_id", "currency"] as const;
    const numbers = ["subtotal", "tax", "total"] as const;
    const fieldResults = Object.fromEntries([
      ...strings.map((f) => [f, { expected: c.groundTruth[f], actual: got[f] ?? null, strictExact: exact(c.groundTruth[f], got[f]), normalizedExact: normalizedExact(c.groundTruth[f], got[f]) }]),
      ...numbers.map((f) => [f, { expected: c.groundTruth[f], actual: got[f] ?? null, numericWithinCent: numeric(c.groundTruth[f], got[f]) }]),
    ]) as Record<string, { expected: unknown; actual: unknown; strictExact?: boolean; normalizedExact?: boolean; numericWithinCent?: boolean }>;
    const review = safeReview(got);
    return {
      id: c.id, status: "ok", variant: c.variant, latencyMs: Math.round((performance.now() - started) * 100) / 100,
      pages: result.pages, model: result.model, fields: fieldResults,
      strictStringCorrect: strings.filter((f) => fieldResults[f]?.strictExact === true).length,
      normalizedStringCorrect: strings.filter((f) => fieldResults[f]?.normalizedExact === true).length,
      numericCorrect: numbers.filter((f) => fieldResults[f]?.numericWithinCent === true).length,
      safeReviewExpected: c.safeReviewExpected, safeReviewPredicted: review.predicted,
      safeReviewCorrect: c.safeReviewExpected === review.predicted, safeReviewReasons: review.reasons,
      misses: Object.entries(fieldResults).filter(([, v]) => !(v.strictExact ?? v.numericWithinCent)).map(([field]) => field),
    };
  } catch (err) {
    return { id: c.id, status: "error", variant: c.variant, latencyMs: Math.round((performance.now() - started) * 100) / 100, error: categoricalEvalError(err) };
  }
}

function safePath(input: string): string {
  const target = resolve(input), rel = relative(process.cwd(), target);
  if (isAbsolute(rel) || rel.startsWith("..") || !rel) throw new Error("--write must stay inside this repository");
  return target;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const online = args.includes("--online");
  const nAt = args.indexOf("--runs"), runs = nAt >= 0 ? Number(args[nAt + 1]) : 0;
  const wAt = args.indexOf("--write");
  let target: string | null = null;
  if (online) {
    if (!Number.isInteger(runs) || runs < 3 || runs > 10) throw new Error("online vision evidence requires --runs 3 (up to 10)");
    if (wAt < 0 || !args[wAt + 1]) throw new Error("online vision evidence requires --write <repo-contained.json>");
    target = safePath(args[wAt + 1]!);
  }
  const commandArgs = online
    ? ["--online", "--runs", String(runs), "--write", relative(process.cwd(), target!).replace(/\\/g, "/")]
    : args.includes("--check") ? ["--check"] : [];
  const fixtureSetSha256 = await verifyFixtures();
  console.log(`Vision fixtures verified: ${manifest.cases.length} original PDF/PNG/JPG documents · sha256:${fixtureSetSha256}`);
  const endpoint = online ? officialEvidenceEndpoint() : null;
  const prov = await provenance(fixtureSetSha256, commandArgs, endpoint);
  console.log(`Vision protocol sha256:${prov.protocolSha256} · git ${prov.gitCommit ?? "unknown"} · ${prov.protocolTreeClean === true ? "inputs clean (result artifacts allowed)" : "dirty/unavailable"}`);
  if (!online) return;
  if (!hasQwenCreds()) throw new Error("--online requires DASHSCOPE_API_KEY; no vision score was generated");
  if (prov.protocolTreeClean !== true || !prov.gitCommit) throw new Error("online vision evidence requires committed, unchanged protocol inputs and no dirty paths outside eval/results/*.json");
  const evidenceTarget = target!;
  const artifact: Record<string, unknown> = {
    schemaVersion: 1, status: "running", evaluation: "archon-qwen-vl-invoice-extraction", generatedAt: new Date().toISOString(),
    model: DEFAULT_VISION_MODEL, fixtureSet: { cases: manifest.cases.length, sha256: fixtureSetSha256, provenance: manifest.license, role: "frozen developer-authored synthetic set; not expert-labelled or representative of real-world invoice traffic" },
    provenance: prov,
    repetitions: runs, metricDefinitions: {
      strictStringAccuracy: "case-sensitive exact match on vendor/reference/date/tax-id/currency",
      normalizedStringAccuracy: "trimmed case-insensitive match",
      numericAccuracy: "absolute error <= 0.01",
      safeReviewRecall: "review expected cases surfaced by low extraction confidence or failed AP structural validation",
      latency: "wall clock including local PDF rasterization and one provider extraction request",
    },
    cost: { estimatedUsd: null, note: "Provider token/billing usage is not exposed by the extraction seam; no monetary cost is fabricated." },
    runs: [],
  };
  await mkdir(dirname(evidenceTarget), { recursive: true });
  const persist = () => persistEvidenceArtifact(evidenceTarget, `${JSON.stringify(artifact, null, 2)}\n`);
  await createExclusiveEvidenceArtifact(evidenceTarget, `${JSON.stringify(artifact, null, 2)}\n`);
  const runList = artifact.runs as unknown[];
  for (let run = 1; run <= runs; run++) {
    const extractor = new QwenVisionExtractionClient();
    const cases = [];
    for (const c of manifest.cases) {
      cases.push(await runCase(c, extractor));
      runList[run - 1] = { run, status: "running", cases };
      await persist();
    }
    const ok = cases.filter((c) => c.status === "ok") as Array<Record<string, unknown>>;
    const errors = cases.length - ok.length;
    const strict = ok.reduce((s, c) => s + Number(c.strictStringCorrect), 0);
    const normalized = ok.reduce((s, c) => s + Number(c.normalizedStringCorrect), 0);
    const nums = ok.reduce((s, c) => s + Number(c.numericCorrect), 0);
    const byId = new Map(cases.map((c) => [c.id, c]));
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (const def of manifest.cases) {
      const result = byId.get(def.id) as Record<string, unknown> | undefined;
      const predicted = result?.status === "ok" ? Boolean(result.safeReviewPredicted) : !def.safeReviewExpected;
      if (def.safeReviewExpected && predicted) tp++;
      else if (def.safeReviewExpected) fn++;
      else if (predicted) fp++;
      else tn++;
    }
    runList[run - 1] = {
      run, status: errors ? "incomplete" : "complete", completion: { ok: ok.length, errors, total: cases.length },
      metrics: {
        strictStringAccuracy: strict / (manifest.cases.length * 5),
        normalizedStringAccuracy: normalized / (manifest.cases.length * 5),
        numericAccuracy: nums / (manifest.cases.length * 3),
        safeReview: { tp, tn, fp, fn, recall: tp / Math.max(1, tp + fn), specificity: tn / Math.max(1, tn + fp), balancedAccuracy: 0.5 * (tp / Math.max(1, tp + fn) + tn / Math.max(1, tn + fp)) },
      },
      cases,
    };
    await persist();
  }
  artifact.status = (runList as Array<{status:string}>).every((r) => r.status === "complete") ? "complete" : "incomplete";
  const completeRuns = runList as Array<{status:string;metrics?:Record<string, unknown>;cases?:Array<Record<string, unknown>>}>;
  const metric = (key: string) => completeRuns.map((r) => Number(r.metrics?.[key] ?? 0));
  const safeMetric = (key: string) => completeRuns.map((r) => {
    const safe = r.metrics?.["safeReview"] as Record<string, unknown> | undefined;
    return Number(safe?.[key] ?? 0);
  });
  const summarize = (values: number[]) => ({ perRun: values, mean: values.reduce((s, n) => s + n, 0) / Math.max(1, values.length), min: Math.min(...values), max: Math.max(...values) });
  const stabilityCases = manifest.cases.map((def) => {
    const outcomes = completeRuns.map((r) => {
      const c = r.cases?.find((x) => x.id === def.id);
      return c?.status === "ok" ? JSON.stringify({ misses: c.misses, review: c.safeReviewPredicted }) : "ERROR";
    });
    return { id: def.id, stable: new Set(outcomes).size === 1, outcomes };
  });
  artifact.aggregate = {
    unit: "16 repeated synthetic cases per run; repetitions are not independent new samples",
    strictStringAccuracy: summarize(metric("strictStringAccuracy")),
    normalizedStringAccuracy: summarize(metric("normalizedStringAccuracy")),
    numericAccuracy: summarize(metric("numericAccuracy")),
    safeReviewRecall: summarize(safeMetric("recall")),
    safeReviewSpecificity: summarize(safeMetric("specificity")),
    safeReviewBalancedAccuracy: summarize(safeMetric("balancedAccuracy")),
    unstableCaseIds: stabilityCases.filter((c) => !c.stable).map((c) => c.id),
    perCaseStability: stabilityCases,
  };
  artifact.completedAt = new Date().toISOString();
  await persist();
  console.log(`Vision artifact: ${relative(process.cwd(), evidenceTarget)} · status ${artifact.status}`);
  if (artifact.status !== "complete") process.exitCode = 2;
}

main().catch((err) => { console.error(`Vision evaluation failed: ${JSON.stringify(categoricalEvalError(err))}`); process.exit(1); });
