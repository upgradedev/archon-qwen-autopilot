// Counterbalanced, same-attempt model-promotion evidence.
// One immutable artifact contains AP decision + document-vision results for both
// arms in AB/BA/AB order. Errors remain in fixed denominators; no retry overwrites
// an earlier attempt and no model is silently substituted.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EVAL_SET } from "./dataset.js";
import { assertFrozenDataset } from "./hash.js";
import { runScenario } from "./lib.js";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  createExclusiveEvidenceArtifact,
  persistEvidenceArtifact,
} from "./artifact-safety.js";
import {
  hasQwenCreds,
  officialEvidenceEndpoint,
  requiresNonThinkingJsonOrTools,
} from "../src/qwen/client.js";
import { DEFAULT_EMBED_MODEL, EMBED_DIM } from "../src/memory/embeddings.js";
import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  QwenVisionExtractionClient,
  validateDocument,
  validateImageDimensions,
  validateMagicBytes,
} from "../src/qwen/vision.js";
import { normalizeInvoice } from "../src/ap/normalize.js";
import { validateInvoice } from "../src/ap/validate.js";
import { hasLowExtractionConfidence } from "../src/ap/extraction-confidence.js";

const exec = promisify(execFile);
const VISION_ROOT = resolve("eval/vision");
type ArmName = "baseline" | "candidate";

// Preregistered absolute floors prevent two equally weak arms from passing a
// purely relative non-inferiority comparison. These are evaluated on every run.
export const PROMOTION_ABSOLUTE_GATES = Object.freeze({
  decision: Object.freeze({
    rawTerminalAgreement: 20 / 22,
    proposalContractSanity: 1,
    reviewerEnrichedExecution: 1,
    maxUnstableCases: 0,
  }),
  vision: Object.freeze({
    normalizedStringAccuracy: 0.95,
    numericAccuracy: 0.95,
    safeReviewRecall: 1,
    maxUnstableCases: 1,
  }),
});

interface GroundTruth {
  vendor: string | null; invoice_number: string | null; invoice_date: string | null;
  tax_id: string | null; currency: string | null; subtotal: number | null;
  tax: number | null; total: number | null;
}
interface VisionCase {
  id: string; filename: string; variant: string; safeReviewExpected: boolean; groundTruth: GroundTruth;
}
interface VisionManifest { schemaVersion: number; license: string; cases: VisionCase[] }
interface Cli {
  baselineDecision: string; baselineVision: string; candidate: string; write: string;
}

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function modelId(value: string | undefined, flag: string): string {
  if (!value || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(`${flag} requires a bounded model id`);
  return value;
}

function parseCli(argv: string[]): Cli {
  if (!argv.includes("--online")) throw new Error("comparison evidence requires --online");
  if (!hasQwenCreds()) throw new Error("comparison evidence requires DASHSCOPE_API_KEY");
  const runs = Number(argAfter(argv, "--runs") ?? 3);
  if (runs !== 3) throw new Error("counterbalanced promotion protocol requires exactly --runs 3 (AB/BA/AB)");
  const write = argAfter(argv, "--write");
  if (!write) throw new Error("comparison evidence requires --write eval/results/<attempt>.json");
  return {
    baselineDecision: modelId(argAfter(argv, "--baseline-decision"), "--baseline-decision"),
    baselineVision: modelId(argAfter(argv, "--baseline-vision"), "--baseline-vision"),
    candidate: modelId(argAfter(argv, "--candidate"), "--candidate"),
    write,
  };
}

function artifactPath(input: string): string {
  const target = resolve(input);
  const rel = relative(process.cwd(), target).replace(/\\/g, "/");
  if (isAbsolute(rel) || rel.startsWith("..") || !/^eval\/results\/[A-Za-z0-9._-]+\.json$/.test(rel)) {
    throw new Error("--write must be an attempt-qualified JSON path under eval/results");
  }
  return target;
}

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mime(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : "image/jpeg";
}

async function frozenVisionSet(): Promise<{ manifest: VisionManifest; sha256: string }> {
  const manifestBytes = await readFile(resolve(VISION_ROOT, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as VisionManifest;
  if (manifest.cases.length < 12 || manifest.cases.length > 20) throw new Error("vision case count is outside the frozen protocol");
  const lockText = (await readFile(resolve(VISION_ROOT, "fixtures.sha256"), "utf8")).trim();
  const expected = new Map(lockText.split(/\r?\n/).map((line) => {
    const [hash, ...parts] = line.trim().split(/\s+/);
    return [parts.join(" "), hash];
  }));
  if (sha(manifestBytes) !== expected.get("manifest.json")) throw new Error("vision manifest hash mismatch");
  for (const item of manifest.cases) {
    const path = resolve(VISION_ROOT, item.filename);
    const rel = relative(VISION_ROOT, path).replace(/\\/g, "/");
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`${item.id}: fixture escapes eval/vision`);
    const bytes = await readFile(path);
    if (sha(bytes) !== expected.get(rel)) throw new Error(`${item.id}: fixture hash mismatch`);
    const validated = validateDocument({ filename: path, mimetype: mime(path), size: bytes.length });
    if (!validated.ok) throw new Error(`${item.id}: frozen fixture validation failed`);
    const magic = validateMagicBytes(bytes, validated.ext);
    if (!magic.ok) throw new Error(`${item.id}: frozen fixture content mismatch`);
    const dimensions = validateImageDimensions(bytes, validated.ext);
    if (!dimensions.ok) throw new Error(`${item.id}: frozen fixture dimensions invalid`);
  }
  return { manifest, sha256: sha(`${lockText}\n`) };
}

async function provenance(cli: Cli, target: string, datasetSha256: string, fixtureSha256: string) {
  const files = [
    "eval/compare.ts", "eval/artifact-safety.ts", "eval/dataset.ts", "eval/dataset.sha256", "eval/hash.ts", "eval/lib.ts",
    "eval/vision/manifest.json", "eval/vision/fixtures.sha256", "eval/vision/generate_fixtures.py",
    "src/agents/autopilot-agent.ts", "src/ap/loop.ts", "src/ap/analysis-tools.ts", "src/ap/tools.ts",
    "src/ap/fake-chat.ts", "src/ap/workitem-store.ts", "src/ap/sinks.ts", "src/ap/normalize.ts",
    "src/ap/validate.ts", "src/ap/currency.ts", "src/ap/finance-policy.ts", "src/ap/extraction-confidence.ts",
    "src/memory/embeddings.ts", "src/memory/memory.ts", "src/memory/store.ts", "src/qwen/client.ts",
    "src/qwen/vision.ts", "src/qwen/injection-scan.ts", "src/security/operational-error.ts", "src/types.ts", "package-lock.json",
  ];
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update(await readFile(resolve(file)));
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
  for (const file of files) {
    await exec("git", ["ls-files", "--error-unmatch", "--", file], { cwd: process.cwd() });
    await exec("git", ["diff", "--quiet", "HEAD", "--", file], { cwd: process.cwd() });
  }
  const dirty = (await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: process.cwd() })).stdout
    .split(/\r?\n/).filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, "") }));
  const disallowed = dirty.filter((entry) =>
    entry.status.includes("D") || entry.status.includes("R") || !/^eval\/results\/[A-Za-z0-9._-]+\.json$/.test(entry.path)
  );
  if (disallowed.length > 0) throw new Error("comparison evidence requires a committed protocol tree; only prior eval/results JSON attempts may be dirty");
  const commandArgs = [
    "--online", "--runs", "3",
    "--baseline-decision", cli.baselineDecision,
    "--baseline-vision", cli.baselineVision,
    "--candidate", cli.candidate,
    "--write", relative(process.cwd(), target).replace(/\\/g, "/"),
  ];
  return {
    gitCommit: commit,
    protocolTreeClean: true,
    protocolSha256: digest.digest("hex"),
    files,
    datasetSha256,
    fixtureSetSha256: fixtureSha256,
    providerEndpoint: officialEvidenceEndpoint(),
    command: canonicalEvidenceCommand("eval/compare.ts", commandArgs),
    node: process.version,
    parameters: {
      order: ["AB", "BA", "AB"],
      repetitions: 3,
      embeddingModelId: DEFAULT_EMBED_MODEL,
      embeddingDimensions: EMBED_DIM,
      decision: { temperature: 0.1, maxTokens: 512, toolChoice: "auto" },
      vision: { temperature: 0.1, maxPdfPages: MAX_PDF_PAGES, maxDocumentBytes: MAX_DOCUMENT_BYTES, maxImageDimension: MAX_IMAGE_DIMENSION, maxImagePixels: MAX_IMAGE_PIXELS },
      candidateEnableThinking: requiresNonThinkingJsonOrTools(cli.candidate) ? false : "provider-default",
      absoluteCandidateGates: PROMOTION_ABSOLUTE_GATES,
      failurePolicy: "errors and inconclusive outputs stay in fixed denominators and fail promotion",
    },
  };
}

async function decisionArm(model: string) {
  const cases: Array<Record<string, unknown>> = [];
  for (const scenario of EVAL_SET) {
    try {
      const row = await runScenario(scenario, "online", { decisionModelId: model, embeddingModelId: DEFAULT_EMBED_MODEL });
      cases.push({
        id: scenario.id,
        status: row.conclusive ? "ok" : "inconclusive",
        expected: scenario.expected,
        rawModelTerminalTool: row.rawModelProposed,
        rawModelAgreesWithLabel: row.modelCorrect,
        finalGuardedProposal: row.proposed,
        proposalContractSane: row.argSane,
        reviewerEnrichedExecutionVerified: row.reviewerEnrichedExecutionVerified,
        policyOverride: row.policyOverride,
        policyOverrideSource: row.policyOverrideSource,
        fallback: row.fallback,
        latencyMsIncludingSeedSetup: row.latencyMs,
        modelCalls: row.modelCalls,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        embeddingCalls: row.embeddingCalls,
        embeddingTokens: row.embeddingTokens,
      });
    } catch (err) {
      cases.push({ id: scenario.id, status: "error", expected: scenario.expected, error: categoricalEvalError(err) });
    }
  }
  const ok = cases.filter((item) => item.status === "ok");
  const rate = (field: string) => cases.filter((item) => item[field] === true).length / EVAL_SET.length;
  return {
    status: ok.length === EVAL_SET.length ? "complete" : "incomplete",
    completion: { conclusive: ok.length, total: EVAL_SET.length },
    metrics: {
      rawTerminalAgreement: rate("rawModelAgreesWithLabel"),
      proposalContractSanity: rate("proposalContractSane"),
      reviewerEnrichedExecution: rate("reviewerEnrichedExecutionVerified"),
      meanLatencyMsIncludingSeedSetup: cases.reduce((sum, item) => sum + Number(item.latencyMsIncludingSeedSetup ?? 0), 0) / EVAL_SET.length,
    },
    policyOverrideSources: [...new Set(cases.filter((item) => item.policyOverride === true).map((item) => String(item.policyOverrideSource ?? "unknown")))].sort(),
    cases,
  };
}

function equalText(expected: unknown, actual: unknown): boolean {
  if (expected == null) return actual == null || actual === "";
  return String(expected).trim().toLocaleLowerCase() === String(actual ?? "").trim().toLocaleLowerCase();
}
function equalNumber(expected: number | null, actual: unknown): boolean {
  if (expected == null) return actual == null;
  const value = typeof actual === "number" ? actual : Number(actual);
  return Number.isFinite(value) && Math.abs(value - expected) <= 0.01;
}

async function visionArm(model: string, manifest: VisionManifest) {
  const extractor = new QwenVisionExtractionClient(model);
  const cases: Array<Record<string, unknown>> = [];
  for (const definition of manifest.cases) {
    const started = performance.now();
    try {
      const path = resolve(VISION_ROOT, definition.filename);
      const result = await extractor.extract({ buffer: await readFile(path), filename: path, mimetype: mime(path) });
      const invoice = result.invoice as Record<string, unknown>;
      const strings = ["vendor", "invoice_number", "invoice_date", "tax_id", "currency"] as const;
      const numbers = ["subtotal", "tax", "total"] as const;
      const normalizedStringCorrect = strings.filter((field) => equalText(definition.groundTruth[field], invoice[field])).length;
      const numericCorrect = numbers.filter((field) => equalNumber(definition.groundTruth[field], invoice[field])).length;
      const normalized = normalizeInvoice(invoice);
      const structuralFailures = validateInvoice(normalized).filter((finding) => !finding.passed).map((finding) => finding.rule);
      const safeReviewPredicted = hasLowExtractionConfidence(normalized.extraction_confidence) || structuralFailures.length > 0;
      cases.push({
        id: definition.id,
        status: "ok",
        normalizedStringCorrect,
        numericCorrect,
        safeReviewExpected: definition.safeReviewExpected,
        safeReviewPredicted,
        normalizedMisses: [
          ...strings.filter((field) => !equalText(definition.groundTruth[field], invoice[field])),
          ...numbers.filter((field) => !equalNumber(definition.groundTruth[field], invoice[field])),
        ],
        pages: result.pages,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      });
    } catch (err) {
      cases.push({ id: definition.id, status: "error", error: categoricalEvalError(err), latencyMs: Math.round((performance.now() - started) * 100) / 100 });
    }
  }
  const ok = cases.filter((item) => item.status === "ok");
  const expectedReview = manifest.cases.filter((item) => item.safeReviewExpected).length;
  const truePositive = cases.filter((item) => item.status === "ok" && item.safeReviewExpected === true && item.safeReviewPredicted === true).length;
  return {
    status: ok.length === manifest.cases.length ? "complete" : "incomplete",
    completion: { ok: ok.length, total: manifest.cases.length },
    metrics: {
      normalizedStringAccuracy: cases.reduce((sum, item) => sum + Number(item.normalizedStringCorrect ?? 0), 0) / (manifest.cases.length * 5),
      numericAccuracy: cases.reduce((sum, item) => sum + Number(item.numericCorrect ?? 0), 0) / (manifest.cases.length * 3),
      safeReviewRecall: truePositive / Math.max(1, expectedReview),
      meanLatencyMs: cases.reduce((sum, item) => sum + Number(item.latencyMs ?? 0), 0) / manifest.cases.length,
    },
    cases,
  };
}

export function promotionGate(runs: Array<Record<string, any>>) {
  const failures: string[] = [];
  for (const run of runs) {
    const a = run.arms.baseline;
    const b = run.arms.candidate;
    if (a.decision.status !== "complete" || b.decision.status !== "complete" || a.vision.status !== "complete" || b.vision.status !== "complete") {
      failures.push(`run ${run.run}: both arms must be complete`);
      continue;
    }
    if (b.decision.metrics.rawTerminalAgreement < a.decision.metrics.rawTerminalAgreement) failures.push(`run ${run.run}: decision agreement regressed`);
    if (b.decision.metrics.rawTerminalAgreement < PROMOTION_ABSOLUTE_GATES.decision.rawTerminalAgreement) failures.push(`run ${run.run}: candidate decision absolute agreement floor failed`);
    if (b.decision.metrics.proposalContractSanity !== PROMOTION_ABSOLUTE_GATES.decision.proposalContractSanity
      || b.decision.metrics.reviewerEnrichedExecution !== PROMOTION_ABSOLUTE_GATES.decision.reviewerEnrichedExecution) failures.push(`run ${run.run}: candidate proposal contract gate failed`);
    if (b.decision.policyOverrideSources.some((source: string) => !a.decision.policyOverrideSources.includes(source))) failures.push(`run ${run.run}: new candidate policy-override class`);
    if (b.vision.metrics.normalizedStringAccuracy < a.vision.metrics.normalizedStringAccuracy) failures.push(`run ${run.run}: normalized vision accuracy regressed`);
    if (b.vision.metrics.numericAccuracy < a.vision.metrics.numericAccuracy) failures.push(`run ${run.run}: numeric vision accuracy regressed`);
    if (b.vision.metrics.safeReviewRecall < a.vision.metrics.safeReviewRecall) failures.push(`run ${run.run}: safe-review recall regressed`);
    if (b.vision.metrics.normalizedStringAccuracy < PROMOTION_ABSOLUTE_GATES.vision.normalizedStringAccuracy) failures.push(`run ${run.run}: candidate normalized vision absolute floor failed`);
    if (b.vision.metrics.numericAccuracy < PROMOTION_ABSOLUTE_GATES.vision.numericAccuracy) failures.push(`run ${run.run}: candidate numeric vision absolute floor failed`);
    if (b.vision.metrics.safeReviewRecall < PROMOTION_ABSOLUTE_GATES.vision.safeReviewRecall) failures.push(`run ${run.run}: candidate safe-review absolute floor failed`);
  }
  const unstable = (arm: ArmName, surface: "decision" | "vision") => {
    const ids = surface === "decision" ? EVAL_SET.map((item) => item.id) : (runs[0]?.arms[arm].vision.cases ?? []).map((item: any) => item.id);
    return ids.filter((id: string) => {
      const outcomes = runs.map((run) => {
        const item = run.arms[arm][surface].cases.find((entry: any) => entry.id === id);
        return surface === "decision"
          ? `${item?.status}:${item?.rawModelTerminalTool ?? ""}`
          : `${item?.status}:${JSON.stringify(item?.normalizedMisses ?? [])}:${item?.safeReviewPredicted ?? ""}`;
      });
      return new Set(outcomes).size > 1;
    });
  };
  const stability = {
    baseline: { decision: unstable("baseline", "decision"), vision: unstable("baseline", "vision") },
    candidate: { decision: unstable("candidate", "decision"), vision: unstable("candidate", "vision") },
  };
  if (stability.candidate.decision.length > stability.baseline.decision.length) failures.push("candidate decision stability regressed");
  if (stability.candidate.vision.length > stability.baseline.vision.length) failures.push("candidate vision stability regressed");
  if (stability.candidate.decision.length > PROMOTION_ABSOLUTE_GATES.decision.maxUnstableCases) failures.push("candidate decision absolute stability ceiling failed");
  if (stability.candidate.vision.length > PROMOTION_ABSOLUTE_GATES.vision.maxUnstableCases) failures.push("candidate vision absolute stability ceiling failed");
  return { pass: failures.length === 0, failures, stability };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const target = artifactPath(cli.write);
  const datasetSha256 = await assertFrozenDataset();
  const vision = await frozenVisionSet();
  const prov = await provenance(cli, target, datasetSha256, vision.sha256);
  const models = {
    baseline: { decision: cli.baselineDecision, vision: cli.baselineVision, embedding: DEFAULT_EMBED_MODEL },
    candidate: { decision: cli.candidate, vision: cli.candidate, embedding: DEFAULT_EMBED_MODEL },
  };
  const runs: Array<Record<string, unknown>> = [];
  const artifact: Record<string, unknown> = {
    schemaVersion: 1,
    status: "running",
    evaluation: "archon-counterbalanced-model-promotion",
    generatedAt: new Date().toISOString(),
    models,
    order: ["AB", "BA", "AB"],
    dataset: { scenarios: EVAL_SET.length, sha256: datasetSha256, role: "frozen tuned developer-labelled AP regression set; not held-out or expert-adjudicated" },
    visionFixtureSet: { cases: vision.manifest.cases.length, sha256: vision.sha256, provenance: vision.manifest.license, role: "frozen original synthetic set; not representative production traffic" },
    provenance: prov,
    runs,
  };
  await mkdir(dirname(target), { recursive: true });
  await createExclusiveEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
  const persist = () => persistEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
  const order: ArmName[][] = [["baseline", "candidate"], ["candidate", "baseline"], ["baseline", "candidate"]];
  for (let index = 0; index < order.length; index++) {
    const run: Record<string, any> = { run: index + 1, order: order[index]!.map((arm) => arm === "baseline" ? "A" : "B").join(""), status: "running", arms: {} };
    runs[index] = run;
    await persist();
    for (const arm of order[index]!) {
      const ids = models[arm];
      run.arms[arm] = {
        models: ids,
        decision: await decisionArm(ids.decision),
      };
      await persist();
      run.arms[arm].vision = await visionArm(ids.vision, vision.manifest);
      await persist();
    }
    run.status = Object.values(run.arms).every((value: any) => value.decision.status === "complete" && value.vision.status === "complete") ? "complete" : "incomplete";
    await persist();
  }
  const promotion = promotionGate(runs as Array<Record<string, any>>);
  artifact.promotion = promotion;
  artifact.status = runs.every((run: any) => run.status === "complete") ? (promotion.pass ? "promotion-pass" : "promotion-fail") : "incomplete";
  artifact.completedAt = new Date().toISOString();
  await persist();
  console.log(`Counterbalanced A/B artifact: ${relative(process.cwd(), target)} · ${artifact.status}`);
  if (!promotion.pass || artifact.status === "incomplete") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`Counterbalanced comparison failed: ${JSON.stringify(categoricalEvalError(err))}`);
    process.exit(1);
  });
}
