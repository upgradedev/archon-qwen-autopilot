// Counterbalanced, same-attempt model-promotion evidence.
// One immutable artifact contains AP decision + document-vision results for both
// arms in AB/BA/BA/AB order. Errors remain in fixed denominators; no retry overwrites
// an earlier attempt and no model is silently substituted.

import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EVAL_SET } from "./dataset.js";
import { assertFrozenDataset } from "./hash.js";
import { runScenario } from "./lib.js";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  createExclusiveEvidenceArtifact,
  persistEvidenceArtifact,
  promotionEvidenceArtifactPath,
} from "./artifact-safety.js";
import {
  hasQwenCreds,
  officialEvidenceEndpoint,
  QWEN_MAX_RETRIES,
  QWEN_REQUEST_TIMEOUT_MS,
  requiresNonThinkingJsonOrTools,
} from "../src/qwen/client.js";
import { DEFAULT_EMBED_MODEL, EMBED_DIM } from "../src/memory/embeddings.js";
import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  POPPLER_TIMEOUT_MS,
  QwenVisionExtractionClient,
  VISION_TIMEOUT_MS,
} from "../src/qwen/vision.js";
import {
  applyPromotionEnvironment,
  finalizePromotionEnvironment,
  preflightPromotionEnvironment,
  PROMOTION_PARAMETER_LOCK,
  PromotionEnvironmentError,
  promotionEnvironmentDiagnostic,
  type PromotionEnvironmentAttestation,
} from "./promotion-environment.js";
import {
  fixtureMime,
  loadFrozenVisionSet,
  numericWithinCent,
  type FrozenVisionSet,
} from "./vision/fixtures.js";
import { evaluateVisionSafeReview } from "./vision/safe-review.js";
import {
  assertPinnedPromotionRuntime,
  committedProtocolState,
  PINNED_PROMOTION_RUNTIME,
  type CommittedProtocolState,
} from "./protocol-provenance.js";

export type ArmName = "baseline" | "candidate";

export function pairedCaseOrder(
  startingOrder: readonly [ArmName, ArmName],
  caseIndex: number
): [ArmName, ArmName] {
  return caseIndex % 2 === 0
    ? [startingOrder[0], startingOrder[1]]
    : [startingOrder[1], startingOrder[0]];
}

export const PROMOTION_PROTOCOL_FILES = [
  "eval/compare.ts", "eval/artifact-safety.ts", "eval/promotion-environment.ts",
  "eval/promotion-preflight.ts",
  "eval/promotion-poppler.lock.json", "eval/protocol-provenance.ts",
  "eval/results/evidence-ledger.json",
  "eval/dataset.ts", "eval/dataset.sha256", "eval/hash.ts", "eval/lib.ts",
  "eval/vision/manifest.json", "eval/vision/fixtures.sha256", "eval/vision/generate_fixtures.py",
  "eval/vision/fixtures.ts", "eval/vision/safe-review.ts",
  "src/agents/autopilot-agent.ts", "src/ap/loop.ts", "src/ap/analysis-tools.ts", "src/ap/tools.ts",
  "src/ap/fake-chat.ts", "src/ap/workitem-store.ts", "src/ap/sinks.ts", "src/ap/normalize.ts",
  "src/ap/validate.ts", "src/ap/currency.ts", "src/ap/finance-policy.ts", "src/ap/extraction-confidence.ts",
  "src/db/client.ts",
  "src/memory/embeddings.ts", "src/memory/memory.ts", "src/memory/store.ts", "src/qwen/client.ts",
  "src/qwen/vision.ts", "src/qwen/injection-scan.ts", "src/security/operational-error.ts", "src/types.ts",
  "package.json", "package-lock.json",
] as const;

export const PROMOTION_ARTIFACT_POLICY = Object.freeze({
  prefix: "model-promotion-ab",
  minAttempt: 2,
  maxAttempt: 99,
  requireNextAttempt: true,
});

// Preregistered absolute floors prevent two equally weak arms from passing a
// purely relative non-inferiority comparison. These are evaluated on every run.
export const PROMOTION_ABSOLUTE_GATES = Object.freeze({
  decision: Object.freeze({
    rawTerminalAgreement: 20 / 22,
    proposalContractSanity: 1,
    reviewerEnrichedExecution: 1,
    maxMeanLatencyMsIncludingSeedSetup: 30_000,
    maxUnstableCases: 0,
  }),
  vision: Object.freeze({
    normalizedStringAccuracy: 0.95,
    numericAccuracy: 0.95,
    safeReviewRecall: 1,
    safeReviewSpecificity: 11 / 12,
    safeReviewBalancedAccuracy: 23 / 24,
    containmentRecall: 1,
    maxUnsafeAutoClear: 0,
    maxMeanLatencyMs: 30_000,
    maxUnstableCases: 1,
  }),
});

export const PROMOTION_RELATIVE_GATES = Object.freeze({
  decision: Object.freeze({ maxMeanLatencyRatioVsBaseline: 1.5 }),
  vision: Object.freeze({ maxMeanLatencyRatioVsBaseline: 1.5 }),
});

interface Cli {
  baselineDecision: string; baselineVision: string; candidate: string; write: string;
}

export const PROMOTION_MODELS = Object.freeze({
  baselineDecision: "qwen-plus",
  baselineVision: "qwen-vl-max",
  candidate: "qwen3.7-plus-2026-05-26",
});

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parsePromotionCli(argv: string[]): Cli {
  const valueFlags = new Set(["--runs", "--baseline-decision", "--baseline-vision", "--candidate", "--write"]);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token !== "--online" && !valueFlags.has(token)) {
      throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
    }
    if (seen.has(token)) throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
    seen.add(token);
    if (valueFlags.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
      index += 1;
    }
  }
  if (!["--online", ...valueFlags].every((flag) => seen.has(flag))) {
    throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  }
  const cli: Cli = {
    baselineDecision: argAfter(argv, "--baseline-decision")!,
    baselineVision: argAfter(argv, "--baseline-vision")!,
    candidate: argAfter(argv, "--candidate")!,
    write: argAfter(argv, "--write")!,
  };
  if (
    argAfter(argv, "--runs") !== "4"
    || cli.baselineDecision !== PROMOTION_MODELS.baselineDecision
    || cli.baselineVision !== PROMOTION_MODELS.baselineVision
    || cli.candidate !== PROMOTION_MODELS.candidate
    || new Set([cli.baselineDecision, cli.baselineVision, cli.candidate]).size !== 3
    || !/^eval\/results\/model-promotion-ab-attempt-[0-9]{2}\.json$/.test(cli.write)
  ) throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  return cli;
}

async function provenance(
  cli: Cli,
  target: string,
  datasetSha256: string,
  fixtureSha256: string,
  environment: PromotionEnvironmentAttestation,
  protocol: CommittedProtocolState,
  endpoint: ReturnType<typeof officialEvidenceEndpoint>
) {
  const commandArgs = [
    "--online", "--runs", "4",
    "--baseline-decision", cli.baselineDecision,
    "--baseline-vision", cli.baselineVision,
    "--candidate", cli.candidate,
    "--write", relative(process.cwd(), target).replace(/\\/g, "/"),
  ];
  return {
    gitCommit: protocol.gitCommit,
    gitClean: protocol.gitClean,
    protocolTreeClean: protocol.protocolTreeClean,
    protocolSha256: protocol.protocolSha256,
    files: protocol.files,
    allowedDirtyResultArtifacts: protocol.allowedDirtyResultArtifacts,
    priorEvidence: protocol.evidenceLedger,
    datasetSha256,
    fixtureSetSha256: fixtureSha256,
    providerEndpoint: endpoint,
    command: canonicalEvidenceCommand("eval/compare.ts", commandArgs),
    runtime: PINNED_PROMOTION_RUNTIME,
    promotionEnvironment: environment,
    parameters: {
      order: ["AB", "BA", "BA", "AB"],
      pairing: "case-interleaved; starting arm alternates by case within every even-sized surface",
      repetitions: 4,
      embeddingModelId: DEFAULT_EMBED_MODEL,
      embeddingDimensions: EMBED_DIM,
      providerRequests: {
        timeoutMs: QWEN_REQUEST_TIMEOUT_MS,
        maxRetries: QWEN_MAX_RETRIES,
        maxAttempts: QWEN_MAX_RETRIES + 1,
      },
      decision: { temperature: 0.1, maxTokens: 512, toolChoice: "auto" },
      vision: {
        temperature: 0.1,
        timeoutMs: VISION_TIMEOUT_MS,
        popplerTimeoutMs: POPPLER_TIMEOUT_MS,
        maxPdfPages: MAX_PDF_PAGES,
        maxDocumentBytes: MAX_DOCUMENT_BYTES,
        maxImageDimension: MAX_IMAGE_DIMENSION,
        maxImagePixels: MAX_IMAGE_PIXELS,
      },
      candidateEnableThinking: requiresNonThinkingJsonOrTools(cli.candidate) ? false : "provider-default",
      absoluteCandidateGates: PROMOTION_ABSOLUTE_GATES,
      relativeNonInferiorityGates: PROMOTION_RELATIVE_GATES,
      preregisteredModels: PROMOTION_MODELS,
      promotionParameterLock: PROMOTION_PARAMETER_LOCK,
      failurePolicy: "errors and inconclusive outputs stay in fixed denominators and fail promotion",
    },
  };
}

async function decisionCase(model: string, scenario: (typeof EVAL_SET)[number]): Promise<Record<string, unknown>> {
  const started = performance.now();
  try {
    const row = await runScenario(scenario, "online", { decisionModelId: model, embeddingModelId: DEFAULT_EMBED_MODEL });
    return {
        id: scenario.id,
        status: row.conclusive ? "ok" : "inconclusive",
        expected: scenario.expected,
        rawModelTerminalTool: row.rawModelProposed,
        rawModelAgreesWithLabel: row.modelCorrect,
        finalGuardedProposal: row.proposed,
        finalGuardedArgs: row.finalGuardedArgs,
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
    };
  } catch (err) {
    return {
      id: scenario.id,
      status: "error",
      expected: scenario.expected,
      latencyMsIncludingSeedSetup: Math.round((performance.now() - started) * 100) / 100,
      error: categoricalEvalError(err, "decision"),
    };
  }
}

function summarizeDecision(cases: Array<Record<string, unknown>>) {
  const ok = cases.filter((item) => item.status === "ok");
  const allLatency = cases.map((item) => Number(item.latencyMsIncludingSeedSetup));
  const conclusiveLatency = ok.map((item) => Number(item.latencyMsIncludingSeedSetup));
  const rate = (field: string) => cases.filter((item) => item[field] === true).length / EVAL_SET.length;
  return {
    status: ok.length === EVAL_SET.length ? "complete" : "incomplete",
    completion: {
      conclusive: ok.length,
      inconclusive: cases.filter((item) => item.status === "inconclusive").length,
      errors: cases.filter((item) => item.status === "error").length,
      total: EVAL_SET.length,
    },
    metrics: {
      rawTerminalAgreement: rate("rawModelAgreesWithLabel"),
      proposalContractSanity: rate("proposalContractSane"),
      reviewerEnrichedExecution: rate("reviewerEnrichedExecutionVerified"),
      meanLatencyMsIncludingSeedSetup: meanLatencyOrNull(allLatency),
      meanConclusiveLatencyMsIncludingSeedSetup: meanLatencyOrNull(conclusiveLatency),
    },
    policyOverrideSources: [...new Set(cases.filter((item) => item.policyOverride === true).map((item) => String(item.policyOverrideSource ?? "unknown")))].sort(),
    cases,
  };
}

export function meanLatencyOrNull(values: readonly number[]): number | null {
  return values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0)
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function equalText(expected: unknown, actual: unknown): boolean {
  if (expected == null) return actual == null || actual === "";
  return String(expected).trim().toLowerCase() === String(actual ?? "").trim().toLowerCase();
}
function equalNumber(expected: number | null, actual: unknown): boolean {
  return numericWithinCent(expected, actual);
}

async function visionCase(
  extractor: QwenVisionExtractionClient,
  definition: FrozenVisionSet["manifest"]["cases"][number],
  vision: FrozenVisionSet
): Promise<Record<string, unknown>> {
  const started = performance.now();
  try {
      const path = resolve(vision.root, definition.filename);
      const result = await extractor.extract({ buffer: await readFile(path), filename: path, mimetype: fixtureMime(path) });
      const invoice = result.invoice as Record<string, unknown>;
      const strings = ["vendor", "invoice_number", "invoice_date", "tax_id", "currency"] as const;
      const numbers = ["subtotal", "tax", "total"] as const;
      const normalizedStringCorrect = strings.filter((field) => equalText(definition.groundTruth[field], invoice[field])).length;
      const numericCorrect = numbers.filter((field) => equalNumber(definition.groundTruth[field], invoice[field])).length;
      const review = evaluateVisionSafeReview(invoice);
      const normalizedMisses = [
        ...strings.filter((field) => !equalText(definition.groundTruth[field], invoice[field])),
        ...numbers.filter((field) => !equalNumber(definition.groundTruth[field], invoice[field])),
      ];
      const unsafeExtraction = review.reasons.length > 0 || normalizedMisses.length > 0;
      const fields = Object.fromEntries([
        ...strings.map((field) => [field, {
          expected: definition.groundTruth[field],
          actual: invoice[field] ?? null,
          normalizedExact: equalText(definition.groundTruth[field], invoice[field]),
        }]),
        ...numbers.map((field) => [field, {
          expected: definition.groundTruth[field],
          actual: invoice[field] ?? null,
          numericWithinCent: equalNumber(definition.groundTruth[field], invoice[field]),
        }]),
      ]);
      return {
        id: definition.id,
        variant: definition.variant,
        status: "ok",
        normalizedStringCorrect,
        numericCorrect,
        safeReviewExpected: definition.safeReviewExpected,
        safeReviewPredicted: review.predicted,
        safeReviewCorrect: definition.safeReviewExpected === review.predicted,
        safeReviewReasons: review.reasons,
        sourceFieldUncertainty: review.sourceFieldUncertainty,
        structuralFailures: review.structuralFailures,
        unsafeExtraction,
        unsafeAutoClear: unsafeExtraction && !review.predicted,
        fields,
        normalizedMisses,
        pages: result.pages,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
      };
  } catch (err) {
    return {
      id: definition.id,
      status: "error",
      variant: definition.variant,
      groundTruth: definition.groundTruth,
      safeReviewExpected: definition.safeReviewExpected,
      error: categoricalEvalError(err, "vision"),
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }
}

function summarizeVision(cases: Array<Record<string, unknown>>, vision: FrozenVisionSet) {
  const ok = cases.filter((item) => item.status === "ok");
  const expectedReview = vision.manifest.cases.filter((item) => item.safeReviewExpected).length;
  const truePositive = cases.filter((item) => item.status === "ok" && item.safeReviewExpected === true && item.safeReviewPredicted === true).length;
  const expectedNoReview = vision.manifest.cases.length - expectedReview;
  const trueNegative = cases.filter((item) => item.status === "ok" && item.safeReviewExpected === false && item.safeReviewPredicted === false).length;
  const recall = truePositive / Math.max(1, expectedReview);
  const specificity = trueNegative / Math.max(1, expectedNoReview);
  const falseNegative = expectedReview - truePositive;
  const falsePositive = expectedNoReview - trueNegative;
  const unsafe = cases.filter((item) => item.status === "ok" && item.unsafeExtraction === true).length;
  const unsafeAutoClear = cases.filter((item) => item.status === "ok" && item.unsafeAutoClear === true).length;
  return {
    status: ok.length === vision.manifest.cases.length ? "complete" : "incomplete",
    completion: { ok: ok.length, errors: cases.length - ok.length, total: vision.manifest.cases.length },
    metrics: {
      normalizedStringAccuracy: cases.reduce((sum, item) => sum + Number(item.normalizedStringCorrect ?? 0), 0) / (vision.manifest.cases.length * 5),
      numericAccuracy: cases.reduce((sum, item) => sum + Number(item.numericCorrect ?? 0), 0) / (vision.manifest.cases.length * 3),
      safeReviewRecall: recall,
      safeReviewSpecificity: specificity,
      safeReviewBalancedAccuracy: (recall + specificity) / 2,
      safeReviewConfusion: { tp: truePositive, tn: trueNegative, fp: falsePositive, fn: falseNegative },
      containmentRecall: unsafe === 0 ? 1 : (unsafe - unsafeAutoClear) / unsafe,
      unsafeAutoClear,
      meanLatencyMs: meanLatencyOrNull(cases.map((item) => Number(item.latencyMs))),
    },
    cases,
  };
}

export function promotionGate(runs: Array<Record<string, any>>) {
  const failures: string[] = [];
  const expectedOrder = ["AB", "BA", "BA", "AB"];
  if (runs.length !== expectedOrder.length) failures.push("promotion requires exactly four paired runs");
  const finiteRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const finiteLatency = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  const decisionIds = EVAL_SET.map((item) => item.id);
  const visionIds = Array.from({ length: 16 }, (_, index) => `v${String(index + 1).padStart(2, "0")}`);
  const completeCaseContract = (cases: unknown, expectedIds: readonly string[]) => {
    if (!Array.isArray(cases) || cases.length !== expectedIds.length) return false;
    return cases.every((item, index) => item && typeof item === "object"
      && item.id === expectedIds[index] && item.status === "ok");
  };
  const emptyArm = () => ({
    decision: { status: "missing", metrics: {}, policyOverrideSources: [], cases: [] },
    vision: { status: "missing", metrics: {}, cases: [] },
  });
  const checkedRuns = Math.max(runs.length, expectedOrder.length);
  for (let index = 0; index < checkedRuns; index++) {
    const run = runs[index] ?? { run: index + 1, order: null, arms: {} };
    const runNumber = index + 1;
    if (run.run !== runNumber || run.order !== expectedOrder[index]) {
      failures.push(`run ${run.run ?? runNumber}: preregistered run order/identity mismatch`);
    }
    const a = run.arms?.baseline ?? emptyArm();
    const b = run.arms?.candidate ?? emptyArm();
    for (const [armName, arm] of [["baseline", a], ["candidate", b]] as const) {
      const decisionMetrics = arm.decision?.metrics ?? {};
      const visionMetrics = arm.vision?.metrics ?? {};
      const decisionRates = [
        decisionMetrics.rawTerminalAgreement,
        decisionMetrics.proposalContractSanity,
        decisionMetrics.reviewerEnrichedExecution,
      ];
      const visionRates = [
        visionMetrics.normalizedStringAccuracy,
        visionMetrics.numericAccuracy,
        visionMetrics.safeReviewRecall,
        visionMetrics.safeReviewSpecificity,
        visionMetrics.safeReviewBalancedAccuracy,
        visionMetrics.containmentRecall,
      ];
      if (decisionRates.some((value) => !finiteRate(value)) || visionRates.some((value) => !finiteRate(value))) {
        failures.push(`run ${runNumber}: ${armName} contains a missing or invalid required metric`);
      }
      if (!finiteLatency(decisionMetrics.meanLatencyMsIncludingSeedSetup)
        || !finiteLatency(visionMetrics.meanLatencyMs)) {
        failures.push(`run ${runNumber}: ${armName} contains a missing or invalid error-inclusive latency metric`);
      }
      if (!Number.isInteger(visionMetrics.unsafeAutoClear)
        || visionMetrics.unsafeAutoClear < 0 || visionMetrics.unsafeAutoClear > 16) {
        failures.push(`run ${runNumber}: ${armName} contains an invalid unsafe-auto-clear count`);
      }
      if (!completeCaseContract(arm.decision?.cases, decisionIds)
        || !completeCaseContract(arm.vision?.cases, visionIds)) {
        failures.push(`run ${runNumber}: ${armName} case identity/status contract does not match the frozen protocol`);
      }
      if (!Array.isArray(arm.decision?.policyOverrideSources)
        || arm.decision.policyOverrideSources.some((source: unknown) => typeof source !== "string")) {
        failures.push(`run ${runNumber}: ${armName} policy-override accounting is invalid`);
      }
    }
    const am = a.decision?.metrics ?? {};
    const bm = b.decision?.metrics ?? {};
    const av = a.vision?.metrics ?? {};
    const bv = b.vision?.metrics ?? {};
    if (a.decision?.status !== "complete" || b.decision?.status !== "complete"
      || a.vision?.status !== "complete" || b.vision?.status !== "complete") {
      failures.push(`run ${runNumber}: both arms must be complete`);
    }
    if (finiteRate(bm.rawTerminalAgreement) && finiteRate(am.rawTerminalAgreement)
      && bm.rawTerminalAgreement < am.rawTerminalAgreement) failures.push(`run ${runNumber}: decision agreement regressed`);
    if (!finiteRate(bm.rawTerminalAgreement)
      || bm.rawTerminalAgreement < PROMOTION_ABSOLUTE_GATES.decision.rawTerminalAgreement) failures.push(`run ${runNumber}: candidate decision absolute agreement floor failed`);
    if (bm.proposalContractSanity !== PROMOTION_ABSOLUTE_GATES.decision.proposalContractSanity
      || bm.reviewerEnrichedExecution !== PROMOTION_ABSOLUTE_GATES.decision.reviewerEnrichedExecution) failures.push(`run ${runNumber}: candidate proposal contract gate failed`);
    const baselineOverrides = Array.isArray(a.decision?.policyOverrideSources) ? a.decision.policyOverrideSources : [];
    const candidateOverrides = Array.isArray(b.decision?.policyOverrideSources) ? b.decision.policyOverrideSources : [];
    if (candidateOverrides.some((source: unknown) => typeof source !== "string" || !baselineOverrides.includes(source))) failures.push(`run ${runNumber}: new candidate policy-override class`);
    if (finiteRate(bv.normalizedStringAccuracy) && finiteRate(av.normalizedStringAccuracy)
      && bv.normalizedStringAccuracy < av.normalizedStringAccuracy) failures.push(`run ${runNumber}: normalized vision accuracy regressed`);
    if (finiteRate(bv.numericAccuracy) && finiteRate(av.numericAccuracy)
      && bv.numericAccuracy < av.numericAccuracy) failures.push(`run ${runNumber}: numeric vision accuracy regressed`);
    if (finiteRate(bv.safeReviewRecall) && finiteRate(av.safeReviewRecall)
      && bv.safeReviewRecall < av.safeReviewRecall) failures.push(`run ${runNumber}: safe-review recall regressed`);
    if (finiteRate(bv.safeReviewSpecificity) && finiteRate(av.safeReviewSpecificity)
      && bv.safeReviewSpecificity < av.safeReviewSpecificity) failures.push(`run ${runNumber}: safe-review specificity regressed`);
    if (finiteRate(bv.safeReviewBalancedAccuracy) && finiteRate(av.safeReviewBalancedAccuracy)
      && bv.safeReviewBalancedAccuracy < av.safeReviewBalancedAccuracy) failures.push(`run ${runNumber}: safe-review balanced accuracy regressed`);
    if (finiteRate(bv.containmentRecall) && finiteRate(av.containmentRecall)
      && bv.containmentRecall < av.containmentRecall) failures.push(`run ${runNumber}: unsafe-extraction containment regressed`);
    if (!finiteRate(bv.normalizedStringAccuracy)
      || bv.normalizedStringAccuracy < PROMOTION_ABSOLUTE_GATES.vision.normalizedStringAccuracy) failures.push(`run ${runNumber}: candidate normalized vision absolute floor failed`);
    if (!finiteRate(bv.numericAccuracy)
      || bv.numericAccuracy < PROMOTION_ABSOLUTE_GATES.vision.numericAccuracy) failures.push(`run ${runNumber}: candidate numeric vision absolute floor failed`);
    if (!finiteRate(bv.safeReviewRecall)
      || bv.safeReviewRecall < PROMOTION_ABSOLUTE_GATES.vision.safeReviewRecall) failures.push(`run ${runNumber}: candidate safe-review absolute floor failed`);
    if (!finiteRate(bv.safeReviewSpecificity)
      || bv.safeReviewSpecificity < PROMOTION_ABSOLUTE_GATES.vision.safeReviewSpecificity) failures.push(`run ${runNumber}: candidate safe-review specificity floor failed`);
    if (!finiteRate(bv.safeReviewBalancedAccuracy)
      || bv.safeReviewBalancedAccuracy < PROMOTION_ABSOLUTE_GATES.vision.safeReviewBalancedAccuracy) failures.push(`run ${runNumber}: candidate safe-review balanced-accuracy floor failed`);
    if (!finiteRate(bv.containmentRecall)
      || bv.containmentRecall < PROMOTION_ABSOLUTE_GATES.vision.containmentRecall
      || !Number.isInteger(bv.unsafeAutoClear)
      || bv.unsafeAutoClear > PROMOTION_ABSOLUTE_GATES.vision.maxUnsafeAutoClear) {
      failures.push(`run ${runNumber}: candidate unsafe-extraction auto-clear gate failed`);
    }
    if (!finiteLatency(bm.meanLatencyMsIncludingSeedSetup)
      || bm.meanLatencyMsIncludingSeedSetup > PROMOTION_ABSOLUTE_GATES.decision.maxMeanLatencyMsIncludingSeedSetup) {
      failures.push(`run ${runNumber}: candidate decision latency ceiling failed`);
    }
    if (finiteLatency(bm.meanLatencyMsIncludingSeedSetup) && finiteLatency(am.meanLatencyMsIncludingSeedSetup)
      && bm.meanLatencyMsIncludingSeedSetup > am.meanLatencyMsIncludingSeedSetup
        * PROMOTION_RELATIVE_GATES.decision.maxMeanLatencyRatioVsBaseline) {
      failures.push(`run ${runNumber}: candidate decision latency regressed beyond the preregistered ratio`);
    }
    if (!finiteLatency(bv.meanLatencyMs)
      || bv.meanLatencyMs > PROMOTION_ABSOLUTE_GATES.vision.maxMeanLatencyMs) {
      failures.push(`run ${runNumber}: candidate vision latency ceiling failed`);
    }
    if (finiteLatency(bv.meanLatencyMs) && finiteLatency(av.meanLatencyMs)
      && bv.meanLatencyMs > av.meanLatencyMs
        * PROMOTION_RELATIVE_GATES.vision.maxMeanLatencyRatioVsBaseline) {
      failures.push(`run ${runNumber}: candidate vision latency regressed beyond the preregistered ratio`);
    }
  }
  const unstable = (arm: ArmName, surface: "decision" | "vision") => {
    const ids = surface === "decision" ? decisionIds : visionIds;
    return ids.filter((id: string) => {
      const outcomes = runs.map((run) => {
        const cases = run.arms?.[arm]?.[surface]?.cases;
        const item = Array.isArray(cases) ? cases.find((entry: any) => entry.id === id) : undefined;
        return stabilityFingerprint(surface, item);
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function stabilityFingerprint(surface: "decision" | "vision", item: Record<string, any> | undefined): string {
  if (!item) return "MISSING";
  return canonicalJson(surface === "decision" ? {
    status: item.status,
    rawModelTerminalTool: item.rawModelTerminalTool ?? null,
    finalGuardedProposal: item.finalGuardedProposal ?? null,
    finalGuardedArgs: item.finalGuardedArgs ?? null,
    proposalContractSane: item.proposalContractSane ?? false,
    reviewerEnrichedExecutionVerified: item.reviewerEnrichedExecutionVerified ?? false,
    policyOverride: item.policyOverride ?? false,
    policyOverrideSource: item.policyOverrideSource ?? null,
    fallback: item.fallback ?? false,
    error: item.error ?? null,
  } : {
    status: item.status,
    fields: item.fields ?? null,
    normalizedMisses: item.normalizedMisses ?? null,
    safeReviewPredicted: item.safeReviewPredicted ?? null,
    safeReviewReasons: item.safeReviewReasons ?? null,
    sourceFieldUncertainty: item.sourceFieldUncertainty ?? null,
    structuralFailures: item.structuralFailures ?? null,
    unsafeExtraction: item.unsafeExtraction ?? null,
    unsafeAutoClear: item.unsafeAutoClear ?? null,
    error: item.error ?? null,
  });
}

async function main(): Promise<void> {
  const cli = parsePromotionCli(process.argv.slice(2));
  if (!hasQwenCreds()) throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  await assertPinnedPromotionRuntime();
  const target = await promotionEvidenceArtifactPath(cli.write, process.cwd(), PROMOTION_ARTIFACT_POLICY);
  const datasetSha256 = await assertFrozenDataset();
  const vision = await loadFrozenVisionSet();
  if (EVAL_SET.length % 2 !== 0 || vision.manifest.cases.length % 2 !== 0) {
    throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  }
  let endpoint: ReturnType<typeof officialEvidenceEndpoint>;
  try {
    endpoint = officialEvidenceEndpoint();
  } catch {
    throw new PromotionEnvironmentError("promotion_endpoint_invalid");
  }
  const protocol = await committedProtocolState(PROMOTION_PROTOCOL_FILES, { strict: true, allowResultArtifacts: true });
  const environment = await preflightPromotionEnvironment({ pdfFixtures: vision.pdfFixtures });
  applyPromotionEnvironment(environment);
  const prov = await provenance(cli, target, datasetSha256, vision.fixtureSetSha256, environment.attestation, protocol, endpoint);
  const models = {
    baseline: { decision: cli.baselineDecision, vision: cli.baselineVision, embedding: DEFAULT_EMBED_MODEL },
    candidate: { decision: cli.candidate, vision: cli.candidate, embedding: DEFAULT_EMBED_MODEL },
  };
  const runs: Array<Record<string, unknown>> = [];
  const artifact: Record<string, unknown> = {
    schemaVersion: 2,
    status: "running",
    evaluation: "archon-counterbalanced-model-promotion",
    generatedAt: new Date().toISOString(),
    models,
    order: ["AB", "BA", "BA", "AB"],
    pairing: "case-interleaved-alternating-first-arm",
    dataset: { scenarios: EVAL_SET.length, sha256: datasetSha256, role: "frozen tuned developer-labelled AP regression set; not held-out or expert-adjudicated" },
    visionFixtureSet: { cases: vision.manifest.cases.length, sha256: vision.fixtureSetSha256, provenance: vision.manifest.license, role: "frozen original synthetic set; not representative production traffic" },
    provenance: prov,
    runs,
  };
  await mkdir(dirname(target), { recursive: true });
  await createExclusiveEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
  const persist = () => persistEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
  const order: Array<[ArmName, ArmName]> = [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
    ["candidate", "baseline"],
    ["baseline", "candidate"],
  ];
  for (let index = 0; index < order.length; index++) {
    const startingOrder = order[index]!;
    const run: Record<string, any> = {
      run: index + 1,
      order: startingOrder.map((arm) => arm === "baseline" ? "A" : "B").join(""),
      pairing: "case-interleaved-alternating-first-arm",
      status: "running",
      arms: {},
    };
    for (const arm of ["baseline", "candidate"] as const) {
      run.arms[arm] = {
        models: models[arm],
        decision: { status: "running", cases: [] },
        vision: { status: "pending", cases: [] },
      };
    }
    runs[index] = run;
    await persist();

    const decisionCases: Record<ArmName, Array<Record<string, unknown>>> = { baseline: [], candidate: [] };
    for (let caseIndex = 0; caseIndex < EVAL_SET.length; caseIndex++) {
      const scenario = EVAL_SET[caseIndex]!;
      const pairOrder = pairedCaseOrder(startingOrder, caseIndex);
      const pairLabel = pairOrder.map((arm) => arm === "baseline" ? "A" : "B").join("");
      for (let position = 0; position < pairOrder.length; position++) {
        const arm = pairOrder[position]!;
        decisionCases[arm].push({
          ...await decisionCase(models[arm].decision, scenario),
          pairedOrder: pairLabel,
          pairedPosition: position + 1,
        });
      }
      for (const arm of ["baseline", "candidate"] as const) {
        run.arms[arm].decision = summarizeDecision(decisionCases[arm]);
      }
      await persist();
    }

    const extractors = {
      baseline: new QwenVisionExtractionClient(models.baseline.vision),
      candidate: new QwenVisionExtractionClient(models.candidate.vision),
    };
    const visionCases: Record<ArmName, Array<Record<string, unknown>>> = { baseline: [], candidate: [] };
    for (let caseIndex = 0; caseIndex < vision.manifest.cases.length; caseIndex++) {
      const definition = vision.manifest.cases[caseIndex]!;
      const pairOrder = pairedCaseOrder(startingOrder, caseIndex);
      const pairLabel = pairOrder.map((arm) => arm === "baseline" ? "A" : "B").join("");
      for (let position = 0; position < pairOrder.length; position++) {
        const arm = pairOrder[position]!;
        visionCases[arm].push({
          ...await visionCase(extractors[arm], definition, vision),
          pairedOrder: pairLabel,
          pairedPosition: position + 1,
        });
      }
      for (const arm of ["baseline", "candidate"] as const) {
        run.arms[arm].vision = summarizeVision(visionCases[arm], vision);
      }
      await persist();
    }
    run.status = Object.values(run.arms).every((value: any) => value.decision.status === "complete" && value.vision.status === "complete") ? "complete" : "incomplete";
    await persist();
  }
  let environmentDiagnostic: ReturnType<typeof promotionEnvironmentDiagnostic> | null = null;
  try {
    prov.promotionEnvironment = await finalizePromotionEnvironment(environment);
  } catch (error) {
    const fixed = error instanceof PromotionEnvironmentError
      ? error
      : new PromotionEnvironmentError("promotion_temp_cleanup_failed");
    environmentDiagnostic = promotionEnvironmentDiagnostic(fixed);
  }
  const promotion = promotionGate(runs as Array<Record<string, any>>);
  if (environmentDiagnostic) {
    promotion.failures.push(`promotion environment finalization failed: ${environmentDiagnostic.code}`);
    promotion.pass = false;
    artifact.promotionEnvironmentDiagnostic = environmentDiagnostic;
  }
  artifact.promotion = promotion;
  artifact.status = environmentDiagnostic || !runs.every((run: any) => run.status === "complete")
    ? "incomplete"
    : (promotion.pass ? "promotion-pass" : "promotion-fail");
  artifact.completedAt = new Date().toISOString();
  await persist();
  console.log(`Counterbalanced A/B artifact: ${relative(process.cwd(), target)} · ${artifact.status}`);
  if (!promotion.pass || artifact.status === "incomplete") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    const safe = err instanceof PromotionEnvironmentError
      ? promotionEnvironmentDiagnostic(err)
      : categoricalEvalError(err);
    console.error(`Counterbalanced comparison failed: ${JSON.stringify(safe)}`);
    process.exit(1);
  });
}
