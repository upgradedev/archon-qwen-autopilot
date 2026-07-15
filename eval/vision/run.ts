// Original synthetic document-extraction benchmark for qwen-vl-max.
// `--check` validates the 16 committed fixtures without network/spend.
// `--online --runs 3 --write ...` records every attempt, error and miss.

import { readFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { hasQwenCreds, officialEvidenceEndpoint, QWEN_MAX_RETRIES, QWEN_REQUEST_TIMEOUT_MS, requiresNonThinkingJsonOrTools, type OfficialEvidenceEndpoint } from "../../src/qwen/client.js";
import { QwenVisionExtractionClient, DEFAULT_VISION_MODEL, MAX_PDF_PAGES, MAX_DOCUMENT_BYTES, VISION_TIMEOUT_MS, POPPLER_TIMEOUT_MS } from "../../src/qwen/vision.js";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  createExclusiveEvidenceArtifact,
  persistEvidenceArtifact,
  promotionEvidenceArtifactPath,
} from "../artifact-safety.js";
import {
  applyPromotionEnvironment,
  finalizePromotionEnvironment,
  preflightPromotionEnvironment,
  PROMOTION_PARAMETER_LOCK,
  PromotionEnvironmentError,
  promotionEnvironmentDiagnostic,
  type PromotionEnvironmentAttestation,
} from "../promotion-environment.js";
import { fixtureMime, loadFrozenVisionSet, numericWithinCent, type VisionFixtureCase } from "./fixtures.js";
import { evaluateVisionSafeReview } from "./safe-review.js";
import {
  assertPinnedPromotionRuntime,
  committedProtocolState,
  PINNED_PROMOTION_RUNTIME,
  type CommittedProtocolState,
} from "../protocol-provenance.js";

const PROTOCOL_FILES = [
  "eval/vision/manifest.json", "eval/vision/fixtures.sha256", "eval/vision/generate_fixtures.py",
  "eval/vision/run.ts", "eval/vision/fixtures.ts", "eval/vision/safe-review.ts",
  "eval/promotion-environment.ts", "eval/promotion-poppler.lock.json",
  "eval/results/evidence-ledger.json",
  "eval/protocol-provenance.ts", "eval/artifact-safety.ts", "src/qwen/vision.ts",
  "src/ap/loop.ts", "src/ap/analysis-tools.ts", "src/ap/tools.ts", "src/ap/fake-chat.ts",
  "src/ap/normalize.ts", "src/ap/validate.ts", "src/ap/extraction-confidence.ts",
  "src/ap/currency.ts", "src/ap/finance-policy.ts", "src/memory/embeddings.ts",
  "src/memory/memory.ts", "src/memory/store.ts", "src/db/client.ts",
  "src/qwen/client.ts", "src/security/operational-error.ts", "src/types.ts",
  "package.json", "package-lock.json",
] as const;

async function provenance(
  fixtureSetSha256: string,
  commandArgs: string[],
  endpoint: OfficialEvidenceEndpoint | null,
  environment: PromotionEnvironmentAttestation | null,
  protocol: CommittedProtocolState
) {
  const pkg = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {version:string;dependencies?:Record<string,string>};
  return {
    fixtureSetSha256, protocolSha256: protocol.protocolSha256, files: protocol.files,
    gitCommit: protocol.gitCommit, gitClean: protocol.gitClean,
    protocolTreeClean: protocol.protocolTreeClean,
    allowedDirtyResultArtifacts: protocol.allowedDirtyResultArtifacts,
    priorEvidence: protocol.evidenceLedger,
    disallowedDirtyPaths: protocol.disallowedDirtyPaths,
    command: canonicalEvidenceCommand("eval/vision/run.ts", commandArgs),
    runtime: PINNED_PROMOTION_RUNTIME,
    packageVersion: pkg.version, openaiSdk: pkg.dependencies?.openai, providerEndpoint: endpoint,
    promotionEnvironment: environment,
    parameters: {
      visionModelId: DEFAULT_VISION_MODEL,
      temperature: 0.1,
      responseFormat: requiresNonThinkingJsonOrTools(DEFAULT_VISION_MODEL) ? "json_object" : "omitted",
      enableThinking: requiresNonThinkingJsonOrTools(DEFAULT_VISION_MODEL) ? false : "provider-default",
      maxTokens: requiresNonThinkingJsonOrTools(DEFAULT_VISION_MODEL) ? "omitted" : 2048,
      maxPdfPages: MAX_PDF_PAGES,
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
      providerRequestTimeoutMs: QWEN_REQUEST_TIMEOUT_MS,
      providerMaxRetries: QWEN_MAX_RETRIES,
      providerMaxAttempts: QWEN_MAX_RETRIES + 1,
      visionTimeoutMs: VISION_TIMEOUT_MS,
      popplerTimeoutMs: POPPLER_TIMEOUT_MS,
      promotionParameterLock: PROMOTION_PARAMETER_LOCK,
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
  return String(expected).trim().toLowerCase() === String(actual ?? "").trim().toLowerCase();
}
function numeric(expected: number | null, actual: unknown): boolean {
  return numericWithinCent(expected, actual);
}

async function runCase(c: VisionFixtureCase, extractor: QwenVisionExtractionClient, root: string) {
  const started = performance.now();
  try {
    const path = resolve(root, c.filename);
    const buffer = await readFile(path);
    const result = await extractor.extract({ buffer, filename: path, mimetype: fixtureMime(path) });
    const got = result.invoice;
    const strings = ["vendor", "invoice_number", "invoice_date", "tax_id", "currency"] as const;
    const numbers = ["subtotal", "tax", "total"] as const;
    const fieldResults = Object.fromEntries([
      ...strings.map((f) => [f, { expected: c.groundTruth[f], actual: got[f] ?? null, strictExact: exact(c.groundTruth[f], got[f]), normalizedExact: normalizedExact(c.groundTruth[f], got[f]) }]),
      ...numbers.map((f) => [f, { expected: c.groundTruth[f], actual: got[f] ?? null, numericWithinCent: numeric(c.groundTruth[f], got[f]) }]),
    ]) as Record<string, { expected: unknown; actual: unknown; strictExact?: boolean; normalizedExact?: boolean; numericWithinCent?: boolean }>;
    const review = evaluateVisionSafeReview(got);
    const misses = Object.entries(fieldResults)
      .filter(([, v]) => !(v.numericWithinCent ?? v.normalizedExact))
      .map(([field]) => field);
    const unsafeExtraction = review.reasons.length > 0 || misses.length > 0;
    return {
      id: c.id, status: "ok", variant: c.variant, latencyMs: Math.round((performance.now() - started) * 100) / 100,
      pages: result.pages, model: result.model, fields: fieldResults,
      strictStringCorrect: strings.filter((f) => fieldResults[f]?.strictExact === true).length,
      normalizedStringCorrect: strings.filter((f) => fieldResults[f]?.normalizedExact === true).length,
      numericCorrect: numbers.filter((f) => fieldResults[f]?.numericWithinCent === true).length,
      safeReviewExpected: c.safeReviewExpected, safeReviewPredicted: review.predicted,
      safeReviewCorrect: c.safeReviewExpected === review.predicted, safeReviewReasons: review.reasons,
      sourceFieldUncertainty: review.sourceFieldUncertainty,
      structuralFailures: review.structuralFailures,
      unsafeExtraction,
      unsafeAutoClear: unsafeExtraction && !review.predicted,
      misses,
    };
  } catch (err) {
    return {
      id: c.id,
      status: "error",
      variant: c.variant,
      groundTruth: c.groundTruth,
      safeReviewExpected: c.safeReviewExpected,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      error: categoricalEvalError(err, "vision"),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const online = args.includes("--online");
  const nAt = args.indexOf("--runs"), runs = nAt >= 0 ? Number(args[nAt + 1]) : 0;
  const wAt = args.indexOf("--write");
  let target: string | null = null;
  if (online) {
    const allowed = new Set(["--online", "--runs", "--write"]);
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (!allowed.has(flag) || seen.has(flag)) {
        throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
      }
      seen.add(flag);
      if (flag !== "--online") {
        if (!args[index + 1] || args[index + 1]!.startsWith("--")) {
          throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
        }
        index += 1;
      }
    }
    if (args[nAt + 1] !== "3" || ![...allowed].every((flag) => seen.has(flag)) || wAt < 0 || !args[wAt + 1]) {
      throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
    }
    target = await promotionEvidenceArtifactPath(args[wAt + 1]!, process.cwd(), {
      prefix: "qwen-vl-max",
      minAttempt: 1,
      maxAttempt: 99,
      requireNextAttempt: true,
    });
    await assertPinnedPromotionRuntime();
  } else if (!(args.length === 0 || (args.length === 1 && args[0] === "--check"))) {
    throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  }
  const commandArgs = online
    ? ["--online", "--runs", String(runs), "--write", relative(process.cwd(), target!).replace(/\\/g, "/")]
    : args.includes("--check") ? ["--check"] : [];
  if (online && !hasQwenCreds()) throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  const vision = await loadFrozenVisionSet();
  const fixtureSetSha256 = vision.fixtureSetSha256;
  console.log(`Vision fixtures verified: ${vision.manifest.cases.length} original PDF/PNG/JPG documents · sha256:${fixtureSetSha256}`);
  let endpoint: OfficialEvidenceEndpoint | null = null;
  if (online) {
    try {
      endpoint = officialEvidenceEndpoint();
    } catch {
      throw new PromotionEnvironmentError("promotion_endpoint_invalid");
    }
  }
  const protocol = await committedProtocolState(PROTOCOL_FILES, {
    strict: online,
    allowResultArtifacts: online,
  });
  const environment = online
    ? await preflightPromotionEnvironment({ pdfFixtures: vision.pdfFixtures })
    : null;
  if (environment) applyPromotionEnvironment(environment);
  const prov = await provenance(fixtureSetSha256, commandArgs, endpoint, environment?.attestation ?? null, protocol);
  console.log(`Vision protocol sha256:${prov.protocolSha256 ?? "unavailable"} · git ${prov.gitCommit ?? "unknown"} · ${prov.protocolTreeClean === true ? "inputs clean (registered result artifacts allowed)" : "dirty/unavailable"}`);
  if (!online) return;
  if (prov.protocolTreeClean !== true || !prov.gitCommit) throw new Error("online vision evidence requires committed, unchanged protocol inputs and no dirty paths outside eval/results/*.json");
  const evidenceTarget = target!;
  const artifact: Record<string, unknown> = {
    schemaVersion: 2, status: "running", evaluation: "archon-qwen-vl-invoice-extraction", generatedAt: new Date().toISOString(),
    model: DEFAULT_VISION_MODEL, fixtureSet: { cases: vision.manifest.cases.length, sha256: fixtureSetSha256, provenance: vision.manifest.license, role: "frozen developer-authored synthetic set; not expert-labelled or representative of real-world invoice traffic" },
    provenance: prov,
    repetitions: runs, metricDefinitions: {
      strictStringAccuracy: "case-sensitive exact match on vendor/reference/date/tax-id/currency",
      normalizedStringAccuracy: "trimmed case-insensitive match",
      numericAccuracy: "absolute error <= 0.01",
      safeReviewRecall: "evaluation-only review flags from raw source-field uncertainty, low extraction confidence, or failed AP structural validation",
      safeReviewSpecificity: "non-review fixtures left unflagged by the evaluation-only review diagnostic",
      safeReviewBalancedAccuracy: "mean of evaluation-only safe-review recall and specificity",
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
    for (const c of vision.manifest.cases) {
      cases.push(await runCase(c, extractor, vision.root));
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
    for (const def of vision.manifest.cases) {
      const result = byId.get(def.id) as Record<string, unknown> | undefined;
      const predicted = result?.status === "ok" ? Boolean(result.safeReviewPredicted) : !def.safeReviewExpected;
      if (def.safeReviewExpected && predicted) tp++;
      else if (def.safeReviewExpected) fn++;
      else if (predicted) fp++;
      else tn++;
    }
    const unsafe = ok.filter((result) => result.unsafeExtraction === true).length;
    const unsafeAutoClear = ok.filter((result) => result.unsafeAutoClear === true).length;
    runList[run - 1] = {
      run, status: errors ? "incomplete" : "complete", completion: { ok: ok.length, errors, total: cases.length },
      metrics: {
        strictStringAccuracy: strict / (vision.manifest.cases.length * 5),
        normalizedStringAccuracy: normalized / (vision.manifest.cases.length * 5),
        numericAccuracy: nums / (vision.manifest.cases.length * 3),
        safeReview: { tp, tn, fp, fn, recall: tp / Math.max(1, tp + fn), specificity: tn / Math.max(1, tn + fp), balancedAccuracy: 0.5 * (tp / Math.max(1, tp + fn) + tn / Math.max(1, tn + fp)) },
        containment: { unsafe, unsafeAutoClear, recall: unsafe === 0 ? 1 : (unsafe - unsafeAutoClear) / unsafe },
      },
      cases,
    };
    await persist();
  }
  let environmentDiagnostic: ReturnType<typeof promotionEnvironmentDiagnostic> | null = null;
  try {
    prov.promotionEnvironment = await finalizePromotionEnvironment(environment!);
  } catch (error) {
    const fixed = error instanceof PromotionEnvironmentError
      ? error
      : new PromotionEnvironmentError("promotion_temp_cleanup_failed");
    environmentDiagnostic = promotionEnvironmentDiagnostic(fixed);
    artifact.promotionEnvironmentDiagnostic = environmentDiagnostic;
  }
  artifact.status = !environmentDiagnostic
    && (runList as Array<{status:string}>).every((r) => r.status === "complete")
    ? "complete"
    : "incomplete";
  const completeRuns = runList as Array<{status:string;metrics?:Record<string, unknown>;cases?:Array<Record<string, unknown>>}>;
  const metric = (key: string) => completeRuns.map((r) => Number(r.metrics?.[key] ?? 0));
  const safeMetric = (key: string) => completeRuns.map((r) => {
    const safe = r.metrics?.["safeReview"] as Record<string, unknown> | undefined;
    return Number(safe?.[key] ?? 0);
  });
  const containmentMetric = (key: string) => completeRuns.map((r) => {
    const containment = r.metrics?.["containment"] as Record<string, unknown> | undefined;
    return Number(containment?.[key] ?? 0);
  });
  const summarize = (values: number[]) => ({ perRun: values, mean: values.reduce((s, n) => s + n, 0) / Math.max(1, values.length), min: Math.min(...values), max: Math.max(...values) });
  const stabilityCases = vision.manifest.cases.map((def) => {
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
    containmentRecall: summarize(containmentMetric("recall")),
    unsafeAutoClear: summarize(containmentMetric("unsafeAutoClear")),
    unstableCaseIds: stabilityCases.filter((c) => !c.stable).map((c) => c.id),
    perCaseStability: stabilityCases,
  };
  artifact.completedAt = new Date().toISOString();
  await persist();
  console.log(`Vision artifact: ${relative(process.cwd(), evidenceTarget)} · status ${artifact.status}`);
  if (artifact.status !== "complete") process.exitCode = 2;
}

main().catch((err) => {
  const safe = err instanceof PromotionEnvironmentError
    ? promotionEnvironmentDiagnostic(err)
    : categoricalEvalError(err);
  console.error(`Vision evaluation failed: ${JSON.stringify(safe)}`);
  process.exit(1);
});
