// Counterbalanced, same-attempt model-promotion evidence.
// One immutable artifact contains AP decision + document-vision results for both
// arms in AB/BA/BA/AB order. Errors remain in fixed denominators; no retry overwrites
// an earlier attempt and no model is silently substituted.

import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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
  cleanupPromotionEnvironment,
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
  "eval/promotion-preflight.ts", "eval/promotion-recovery.ts",
  "eval/promotion-poppler.lock.json", "eval/protocol-provenance.ts",
  "eval/results/evidence-ledger.json", "eval/results/model-promotion-ab-attempt-01.json",
  "eval/dataset.ts", "eval/dataset.sha256", "eval/hash.ts", "eval/lib.ts",
  "eval/vision/manifest.json", "eval/vision/fixtures.sha256", "eval/vision/generate_fixtures.py",
  "eval/vision/fixtures.ts", "eval/vision/safe-review.ts",
  "src/agents/autopilot-agent.ts", "src/ap/loop.ts", "src/ap/analysis-tools.ts", "src/ap/tools.ts",
  "src/ap/fake-chat.ts", "src/ap/workitem-store.ts", "src/ap/sinks.ts", "src/ap/normalize.ts",
  "src/ap/validate.ts", "src/ap/currency.ts", "src/ap/finance-policy.ts", "src/ap/extraction-confidence.ts",
  "src/db/client.ts",
  "src/memory/embeddings.ts", "src/memory/memory.ts", "src/memory/store.ts", "src/qwen/client.ts",
  "src/qwen/vision.ts", "src/qwen/injection-scan.ts", "src/security/operational-error.ts", "src/types.ts",
  ".gitattributes", "tsconfig.json", "package.json", "package-lock.json",
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
    finalGuardedAgreement: 1,
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

// The authoritative root is ledger-acceptable from its first publication. A hard
// process interruption can therefore freeze any progress snapshot without leaving
// a non-registerable `running` attempt. Nested run/surface state carries progress;
// only the normal finalization path may publish a terminal promotion decision.
export const PROMOTION_PROGRESS_ROOT_STATUS = "incomplete" as const;
const PROMOTION_TERMINAL_ROOT_STATUSES = new Set(["promotion-pass", "promotion-fail"]);

export function assertPromotionRootStatusForPersistence(
  status: unknown,
  terminalPublicationAuthorized = false
): void {
  const valid = terminalPublicationAuthorized
    ? PROMOTION_TERMINAL_ROOT_STATUSES.has(String(status)) || status === PROMOTION_PROGRESS_ROOT_STATUS
    : status === PROMOTION_PROGRESS_ROOT_STATUS;
  if (!valid) throw new PromotionEnvironmentError("promotion_artifact_invalid");
}

export const PROMOTION_MATERIAL_BENEFIT_GATES = Object.freeze({
  aggregateCorrectFieldGain: 4,
  aggregateLatencyWinRatio: 0.9,
  otherSurfaceMaxLatencyRatio: 1,
});

interface Cli {
  baselineDecision: string; baselineVision: string; candidate: string; write: string;
  expectedRelease: string;
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
  const valueFlags = new Set(["--runs", "--baseline-decision", "--baseline-vision", "--candidate", "--write", "--expected-release"]);
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
    expectedRelease: argAfter(argv, "--expected-release")!,
  };
  if (
    argAfter(argv, "--runs") !== "4"
    || cli.baselineDecision !== PROMOTION_MODELS.baselineDecision
    || cli.baselineVision !== PROMOTION_MODELS.baselineVision
    || cli.candidate !== PROMOTION_MODELS.candidate
    || new Set([cli.baselineDecision, cli.baselineVision, cli.candidate]).size !== 3
    || !/^eval\/results\/model-promotion-ab-attempt-[0-9]{2}\.json$/.test(cli.write)
    || !/^[0-9a-f]{40,64}$/.test(cli.expectedRelease)
  ) throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  return cli;
}

export function assertPromotionCredential(value = process.env.DASHSCOPE_API_KEY): void {
  if (typeof value !== "string"
    || value !== value.trim()
    || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
    || !/^sk-(?!sp-)[A-Za-z0-9_-]{16,252}$/.test(value)) {
    throw new PromotionEnvironmentError("promotion_credentials_invalid");
  }
}

export interface PromotionReleaseSnapshot {
  observedAt: string;
  gitCommit: string | null;
  originMainGitCommit: string | null;
  expectedReleaseGitCommit: string | null;
  protocolSha256: string | null;
  protocolBlobs: Record<string, string>;
  datasetSha256: string;
  fixtureSetSha256: string;
  fixtureBytesSha256: string;
  poppler: {
    sha256: string;
    bundleFiles: number;
    bundleSha256: string;
  };
}

export function promotionReleaseSnapshot(
  protocol: CommittedProtocolState,
  datasetSha256: string,
  vision: FrozenVisionSet,
  environment: PromotionEnvironmentAttestation
): PromotionReleaseSnapshot {
  return {
    observedAt: new Date().toISOString(),
    gitCommit: protocol.gitCommit,
    originMainGitCommit: protocol.originMainGitCommit,
    expectedReleaseGitCommit: protocol.expectedReleaseGitCommit,
    protocolSha256: protocol.protocolSha256,
    protocolBlobs: { ...protocol.protocolBlobs },
    datasetSha256,
    fixtureSetSha256: vision.fixtureSetSha256,
    fixtureBytesSha256: vision.fixtureBytesSha256,
    poppler: {
      sha256: environment.poppler.sha256,
      bundleFiles: environment.poppler.bundleFiles,
      bundleSha256: environment.poppler.bundleSha256,
    },
  };
}

export function comparePromotionReleaseSnapshots(
  start: PromotionReleaseSnapshot,
  end: PromotionReleaseSnapshot
): { status: "passed" | "drift"; mismatches: string[] } {
  const mismatches: string[] = [];
  if (end.gitCommit !== start.gitCommit) mismatches.push("head");
  if (end.originMainGitCommit !== start.originMainGitCommit) mismatches.push("origin-main");
  if (end.expectedReleaseGitCommit !== start.expectedReleaseGitCommit) mismatches.push("expected-release");
  if (end.protocolSha256 !== start.protocolSha256
    || canonicalJson(end.protocolBlobs) !== canonicalJson(start.protocolBlobs)) mismatches.push("protocol-blobs");
  if (end.datasetSha256 !== start.datasetSha256) mismatches.push("dataset");
  if (end.fixtureSetSha256 !== start.fixtureSetSha256
    || end.fixtureBytesSha256 !== start.fixtureBytesSha256) mismatches.push("fixtures");
  if (canonicalJson(end.poppler) !== canonicalJson(start.poppler)) mismatches.push("poppler");
  return { status: mismatches.length === 0 ? "passed" : "drift", mismatches };
}

async function provenance(
  cli: Cli,
  target: string,
  datasetSha256: string,
  vision: FrozenVisionSet,
  environment: PromotionEnvironmentAttestation,
  protocol: CommittedProtocolState,
  endpoint: ReturnType<typeof officialEvidenceEndpoint>
) {
  const commandArgs = [
    "--online", "--runs", "4",
    "--baseline-decision", cli.baselineDecision,
    "--baseline-vision", cli.baselineVision,
    "--candidate", cli.candidate,
    "--expected-release", cli.expectedRelease,
    "--write", relative(process.cwd(), target).replace(/\\/g, "/"),
  ];
  return {
    gitCommit: protocol.gitCommit,
    originMainGitCommit: protocol.originMainGitCommit,
    expectedReleaseGitCommit: protocol.expectedReleaseGitCommit,
    headMatchesExpectedRelease: protocol.headMatchesExpectedRelease,
    headMatchesOriginMain: protocol.headMatchesOriginMain,
    gitClean: protocol.gitClean,
    protocolTreeClean: protocol.protocolTreeClean,
    protocolSha256: protocol.protocolSha256,
    protocolBlobs: protocol.protocolBlobs,
    files: protocol.files,
    allowedDirtyResultArtifacts: protocol.allowedDirtyResultArtifacts,
    priorEvidence: protocol.evidenceLedger,
    datasetSha256,
    fixtureSetSha256: vision.fixtureSetSha256,
    fixtureBytesSha256: vision.fixtureBytesSha256,
    providerEndpoint: endpoint,
    command: canonicalEvidenceCommand("eval/compare.ts", commandArgs),
    runtime: PINNED_PROMOTION_RUNTIME,
    promotionEnvironment: environment,
    releaseAttestation: {
      expectedReleaseGitCommit: cli.expectedRelease,
      status: "pending" as "pending" | "passed" | "drift",
      start: promotionReleaseSnapshot(protocol, datasetSha256, vision, environment),
      end: null as PromotionReleaseSnapshot | Record<string, unknown> | null,
      mismatches: [] as string[],
    },
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
      materialBenefitGates: PROMOTION_MATERIAL_BENEFIT_GATES,
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
        finalGuardedAgreesWithLabel: row.correct,
        finalGuardedArgs: row.finalGuardedArgs,
        proposalContractSane: row.argSane,
        rawProposalArgsExecutable: row.rawArgsExecutable,
        reviewerEnrichedExecutionVerified: row.reviewerEnrichedExecutionVerified,
        policyOverride: row.policyOverride,
        policyOverrideSource: row.policyOverrideSource,
        argumentGuardApplied: row.policyOverride && row.policyOverrideSource === "proposal_argument_guard",
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

const TERMINAL_CASE_STATUSES = new Set(["ok", "inconclusive", "error"]);

export function summarizeDecision(cases: Array<Record<string, unknown>>) {
  const ok = cases.filter((item) => item.status === "ok");
  const allLatency = cases.map((item) => Number(item.latencyMsIncludingSeedSetup));
  const conclusiveLatency = ok.map((item) => Number(item.latencyMsIncludingSeedSetup));
  const rate = (field: string) => cases.filter((item) => item[field] === true).length / EVAL_SET.length;
  const policyOverrideCount = cases.filter((item) => item.policyOverride === true).length;
  const argumentGuardCount = cases.filter((item) => item.argumentGuardApplied === true).length;
  const scheduleComplete = cases.length === EVAL_SET.length
    && cases.every((item) => TERMINAL_CASE_STATUSES.has(String(item.status)));
  return {
    status: scheduleComplete ? "complete" : "incomplete",
    qualityStatus: ok.length === EVAL_SET.length ? "all-ok" : scheduleComplete ? "has-failures" : "incomplete",
    completion: {
      conclusive: ok.length,
      inconclusive: cases.filter((item) => item.status === "inconclusive").length,
      errors: cases.filter((item) => item.status === "error").length,
      total: EVAL_SET.length,
    },
    metrics: {
      rawTerminalAgreement: rate("rawModelAgreesWithLabel"),
      finalGuardedAgreement: rate("finalGuardedAgreesWithLabel"),
      proposalContractSanity: rate("proposalContractSane"),
      rawProposalArgsExecutable: rate("rawProposalArgsExecutable"),
      reviewerEnrichedExecution: rate("reviewerEnrichedExecutionVerified"),
      argumentGuardCount,
      argumentGuardIncidence: argumentGuardCount / EVAL_SET.length,
      policyOverrideCount,
      policyOverrideRate: policyOverrideCount / EVAL_SET.length,
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
      const snapshot = vision.fixtureBytesById.get(definition.id);
      if (!snapshot) throw new Error("frozen fixture snapshot unavailable");
      const result = await extractor.extract({ buffer: Buffer.from(snapshot), filename: path, mimetype: fixtureMime(path) });
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

export function summarizeVision(cases: Array<Record<string, unknown>>, visionCaseCount = 16) {
  const ok = cases.filter((item) => item.status === "ok");
  const expectedReview = 4;
  const truePositive = cases.filter((item) => item.status === "ok" && item.safeReviewExpected === true && item.safeReviewPredicted === true).length;
  const expectedNoReview = visionCaseCount - expectedReview;
  const trueNegative = cases.filter((item) => item.status === "ok" && item.safeReviewExpected === false && item.safeReviewPredicted === false).length;
  const recall = truePositive / Math.max(1, expectedReview);
  const specificity = trueNegative / Math.max(1, expectedNoReview);
  const falseNegative = expectedReview - truePositive;
  const falsePositive = expectedNoReview - trueNegative;
  const unsafe = cases.filter((item) => item.status === "ok" && item.unsafeExtraction === true).length;
  const unsafeAutoClear = cases.filter((item) => item.status === "ok" && item.unsafeAutoClear === true).length;
  const scheduleComplete = cases.length === visionCaseCount
    && cases.every((item) => TERMINAL_CASE_STATUSES.has(String(item.status)));
  const count = (field: "normalizedStringCorrect" | "numericCorrect", max: number) => cases.reduce((sum, item) => {
    const value = item[field];
    return sum + (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max ? Number(value) : 0);
  }, 0);
  return {
    status: scheduleComplete ? "complete" : "incomplete",
    qualityStatus: ok.length === visionCaseCount ? "all-ok" : scheduleComplete ? "has-failures" : "incomplete",
    completion: {
      ok: ok.length,
      inconclusive: cases.filter((item) => item.status === "inconclusive").length,
      errors: cases.filter((item) => item.status === "error").length,
      total: visionCaseCount,
    },
    metrics: {
      normalizedStringAccuracy: count("normalizedStringCorrect", 5) / (visionCaseCount * 5),
      numericAccuracy: count("numericCorrect", 3) / (visionCaseCount * 3),
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

const PROMOTION_RUN_ORDER = ["AB", "BA", "BA", "AB"] as const;
const PROMOTION_VISION_IDS = Array.from({ length: 16 }, (_, index) => `v${String(index + 1).padStart(2, "0")}`);
const PROMOTION_SAFE_REVIEW_IDS = new Set(["v09", "v10", "v11", "v16"]);

function finiteRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteLatency(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function decisionCaseContract(cases: unknown): boolean {
  if (!Array.isArray(cases) || cases.length !== EVAL_SET.length) return false;
  return cases.every((item, index) => {
    const expected = EVAL_SET[index]!;
    if (!item || typeof item !== "object" || item.id !== expected.id || item.expected !== expected.expected
      || !TERMINAL_CASE_STATUSES.has(String(item.status)) || !finiteLatency(item.latencyMsIncludingSeedSetup)) return false;
    if (item.status !== "ok") return true;
    return [
      item.rawModelAgreesWithLabel,
      item.finalGuardedAgreesWithLabel,
      item.proposalContractSane,
      item.rawProposalArgsExecutable,
      item.reviewerEnrichedExecutionVerified,
      item.policyOverride,
      item.argumentGuardApplied,
    ].every((value) => typeof value === "boolean");
  });
}

function visionCaseContract(cases: unknown): boolean {
  if (!Array.isArray(cases) || cases.length !== PROMOTION_VISION_IDS.length) return false;
  return cases.every((item, index) => {
    const id = PROMOTION_VISION_IDS[index]!;
    if (!item || typeof item !== "object" || item.id !== id
      || item.safeReviewExpected !== PROMOTION_SAFE_REVIEW_IDS.has(id)
      || !TERMINAL_CASE_STATUSES.has(String(item.status)) || !finiteLatency(item.latencyMs)) return false;
    if (item.status !== "ok") return true;
    return Number.isInteger(item.normalizedStringCorrect) && item.normalizedStringCorrect >= 0 && item.normalizedStringCorrect <= 5
      && Number.isInteger(item.numericCorrect) && item.numericCorrect >= 0 && item.numericCorrect <= 3
      && typeof item.safeReviewPredicted === "boolean"
      && typeof item.unsafeExtraction === "boolean"
      && typeof item.unsafeAutoClear === "boolean";
  });
}

function aggregateEnvelope(summary: Record<string, any>, surface: "decision" | "vision") {
  return surface === "decision" ? {
    status: summary.status,
    qualityStatus: summary.qualityStatus,
    completion: summary.completion,
    metrics: summary.metrics,
    policyOverrideSources: summary.policyOverrideSources,
  } : {
    status: summary.status,
    qualityStatus: summary.qualityStatus,
    completion: summary.completion,
    metrics: summary.metrics,
  };
}

export function scheduledExperimentComplete(runs: Array<Record<string, any>>): boolean {
  return runs.length === PROMOTION_RUN_ORDER.length && runs.every((run, index) =>
    run?.run === index + 1 && run?.order === PROMOTION_RUN_ORDER[index]
    && decisionCaseContract(run?.arms?.baseline?.decision?.cases)
    && decisionCaseContract(run?.arms?.candidate?.decision?.cases)
    && visionCaseContract(run?.arms?.baseline?.vision?.cases)
    && visionCaseContract(run?.arms?.candidate?.vision?.cases)
  );
}

export function terminalPromotionArtifactStatus(
  runs: Array<Record<string, any>>,
  promotionPass: boolean,
  blockingAttestationFailure: boolean
): "incomplete" | "promotion-pass" | "promotion-fail" {
  if (blockingAttestationFailure || !scheduledExperimentComplete(runs)) return "incomplete";
  return promotionPass ? "promotion-pass" : "promotion-fail";
}

export function promotionGate(runs: Array<Record<string, any>>) {
  const technicalFailures: string[] = [];
  const evaluated: Array<Record<ArmName, { decision: any; vision: any }>> = [];
  if (runs.length !== PROMOTION_RUN_ORDER.length) technicalFailures.push("promotion requires exactly four paired runs");
  const checkedRuns = Math.max(runs.length, PROMOTION_RUN_ORDER.length);
  for (let index = 0; index < checkedRuns; index++) {
    const run = runs[index] ?? { run: index + 1, order: null, arms: {} };
    const runNumber = index + 1;
    if (run.run !== runNumber || run.order !== PROMOTION_RUN_ORDER[index]) {
      technicalFailures.push(`run ${run.run ?? runNumber}: preregistered run order/identity mismatch`);
    }
    const recomputed = {} as Record<ArmName, { decision: any; vision: any }>;
    for (const armName of ["baseline", "candidate"] as const) {
      const arm = run.arms?.[armName] ?? {};
      const decisionCases = Array.isArray(arm.decision?.cases) ? arm.decision.cases : [];
      const visionCases = Array.isArray(arm.vision?.cases) ? arm.vision.cases : [];
      const decision = summarizeDecision(decisionCases);
      const vision = summarizeVision(visionCases);
      recomputed[armName] = { decision, vision };
      if (!decisionCaseContract(arm.decision?.cases) || !visionCaseContract(arm.vision?.cases)) {
        technicalFailures.push(`run ${runNumber}: ${armName} case identity/schedule contract does not match the frozen protocol`);
      }
      if (canonicalJson(aggregateEnvelope(arm.decision ?? {}, "decision"))
        !== canonicalJson(aggregateEnvelope(decision, "decision"))) {
        technicalFailures.push(`run ${runNumber}: ${armName} decision aggregates do not recompute from cases`);
      }
      if (canonicalJson(aggregateEnvelope(arm.vision ?? {}, "vision"))
        !== canonicalJson(aggregateEnvelope(vision, "vision"))) {
        technicalFailures.push(`run ${runNumber}: ${armName} vision aggregates do not recompute from cases`);
      }
      if (decision.qualityStatus !== "all-ok" || vision.qualityStatus !== "all-ok") {
        technicalFailures.push(`run ${runNumber}: ${armName} quality requires every scheduled model output to be ok`);
      }
      const dm = decision.metrics;
      const vm = vision.metrics;
      for (const value of [
        dm.rawTerminalAgreement, dm.finalGuardedAgreement, dm.proposalContractSanity,
        dm.rawProposalArgsExecutable, dm.reviewerEnrichedExecution, dm.argumentGuardIncidence,
        dm.policyOverrideRate, vm.normalizedStringAccuracy, vm.numericAccuracy,
        vm.safeReviewRecall, vm.safeReviewSpecificity, vm.safeReviewBalancedAccuracy,
        vm.containmentRecall,
      ]) {
        if (!finiteRate(value)) technicalFailures.push(`run ${runNumber}: ${armName} contains a missing or invalid required metric`);
      }
      if (!finiteLatency(dm.meanLatencyMsIncludingSeedSetup) || !finiteLatency(vm.meanLatencyMs)) {
        technicalFailures.push(`run ${runNumber}: ${armName} contains a missing or invalid error-inclusive latency metric`);
      }
    }
    evaluated[index] = recomputed;
    const a = recomputed.baseline;
    const b = recomputed.candidate;
    const am = a.decision.metrics;
    const bm = b.decision.metrics;
    const av = a.vision.metrics;
    const bv = b.vision.metrics;
    if (bm.rawTerminalAgreement < am.rawTerminalAgreement) technicalFailures.push(`run ${runNumber}: decision agreement regressed`);
    if (bm.finalGuardedAgreement < am.finalGuardedAgreement) technicalFailures.push(`run ${runNumber}: final guarded agreement regressed`);
    if (bm.rawProposalArgsExecutable < am.rawProposalArgsExecutable) technicalFailures.push(`run ${runNumber}: raw proposal executability regressed`);
    if (bm.argumentGuardIncidence > am.argumentGuardIncidence) technicalFailures.push(`run ${runNumber}: argument-guard incidence regressed`);
    if (bm.policyOverrideCount > am.policyOverrideCount || bm.policyOverrideRate > am.policyOverrideRate) {
      technicalFailures.push(`run ${runNumber}: candidate policy-override count/rate regressed`);
    }
    if (bm.rawTerminalAgreement < PROMOTION_ABSOLUTE_GATES.decision.rawTerminalAgreement) technicalFailures.push(`run ${runNumber}: candidate decision absolute agreement floor failed`);
    if (bm.finalGuardedAgreement !== PROMOTION_ABSOLUTE_GATES.decision.finalGuardedAgreement) technicalFailures.push(`run ${runNumber}: candidate final guarded agreement must be 100%`);
    if (bm.proposalContractSanity !== PROMOTION_ABSOLUTE_GATES.decision.proposalContractSanity
      || bm.reviewerEnrichedExecution !== PROMOTION_ABSOLUTE_GATES.decision.reviewerEnrichedExecution) technicalFailures.push(`run ${runNumber}: candidate proposal contract gate failed`);
    const baselineSources = a.decision.policyOverrideSources;
    if (b.decision.policyOverrideSources.some((source: string) => !baselineSources.includes(source))) {
      technicalFailures.push(`run ${runNumber}: new candidate policy-override class`);
    }
    for (const [name, candidate, baseline] of [
      ["normalized vision accuracy", bv.normalizedStringAccuracy, av.normalizedStringAccuracy],
      ["numeric vision accuracy", bv.numericAccuracy, av.numericAccuracy],
      ["safe-review recall", bv.safeReviewRecall, av.safeReviewRecall],
      ["safe-review specificity", bv.safeReviewSpecificity, av.safeReviewSpecificity],
      ["safe-review balanced accuracy", bv.safeReviewBalancedAccuracy, av.safeReviewBalancedAccuracy],
      ["unsafe-extraction containment", bv.containmentRecall, av.containmentRecall],
    ] as const) {
      if (candidate < baseline) technicalFailures.push(`run ${runNumber}: ${name} regressed`);
    }
    if (bv.normalizedStringAccuracy < PROMOTION_ABSOLUTE_GATES.vision.normalizedStringAccuracy) technicalFailures.push(`run ${runNumber}: candidate normalized vision absolute floor failed`);
    if (bv.numericAccuracy < PROMOTION_ABSOLUTE_GATES.vision.numericAccuracy) technicalFailures.push(`run ${runNumber}: candidate numeric vision absolute floor failed`);
    if (bv.safeReviewRecall < PROMOTION_ABSOLUTE_GATES.vision.safeReviewRecall) technicalFailures.push(`run ${runNumber}: candidate safe-review absolute floor failed`);
    if (bv.safeReviewSpecificity < PROMOTION_ABSOLUTE_GATES.vision.safeReviewSpecificity) technicalFailures.push(`run ${runNumber}: candidate safe-review specificity floor failed`);
    if (bv.safeReviewBalancedAccuracy < PROMOTION_ABSOLUTE_GATES.vision.safeReviewBalancedAccuracy) technicalFailures.push(`run ${runNumber}: candidate safe-review balanced-accuracy floor failed`);
    if (bv.containmentRecall < PROMOTION_ABSOLUTE_GATES.vision.containmentRecall
      || bv.unsafeAutoClear > PROMOTION_ABSOLUTE_GATES.vision.maxUnsafeAutoClear) technicalFailures.push(`run ${runNumber}: candidate unsafe-extraction auto-clear gate failed`);
    if (!finiteLatency(bm.meanLatencyMsIncludingSeedSetup)
      || bm.meanLatencyMsIncludingSeedSetup > PROMOTION_ABSOLUTE_GATES.decision.maxMeanLatencyMsIncludingSeedSetup) technicalFailures.push(`run ${runNumber}: candidate decision latency ceiling failed`);
    if (finiteLatency(bm.meanLatencyMsIncludingSeedSetup) && finiteLatency(am.meanLatencyMsIncludingSeedSetup)
      && bm.meanLatencyMsIncludingSeedSetup > am.meanLatencyMsIncludingSeedSetup * PROMOTION_RELATIVE_GATES.decision.maxMeanLatencyRatioVsBaseline) technicalFailures.push(`run ${runNumber}: candidate decision latency regressed beyond the preregistered ratio`);
    if (!finiteLatency(bv.meanLatencyMs) || bv.meanLatencyMs > PROMOTION_ABSOLUTE_GATES.vision.maxMeanLatencyMs) technicalFailures.push(`run ${runNumber}: candidate vision latency ceiling failed`);
    if (finiteLatency(bv.meanLatencyMs) && finiteLatency(av.meanLatencyMs)
      && bv.meanLatencyMs > av.meanLatencyMs * PROMOTION_RELATIVE_GATES.vision.maxMeanLatencyRatioVsBaseline) technicalFailures.push(`run ${runNumber}: candidate vision latency regressed beyond the preregistered ratio`);
  }

  const unstable = (arm: ArmName, surface: "decision" | "vision") => {
    const ids = surface === "decision" ? EVAL_SET.map((item) => item.id) : PROMOTION_VISION_IDS;
    return ids.filter((id) => new Set(runs.map((run) => {
      const cases = run.arms?.[arm]?.[surface]?.cases;
      const item = Array.isArray(cases) ? cases.find((entry: any) => entry.id === id) : undefined;
      return stabilityFingerprint(surface, item);
    })).size > 1);
  };
  const stability = {
    baseline: { decision: unstable("baseline", "decision"), vision: unstable("baseline", "vision") },
    candidate: { decision: unstable("candidate", "decision"), vision: unstable("candidate", "vision") },
  };
  if (stability.candidate.decision.length > stability.baseline.decision.length) technicalFailures.push("candidate decision stability regressed");
  if (stability.candidate.vision.length > stability.baseline.vision.length) technicalFailures.push("candidate vision stability regressed");
  if (stability.candidate.decision.length > PROMOTION_ABSOLUTE_GATES.decision.maxUnstableCases) technicalFailures.push("candidate decision absolute stability ceiling failed");
  if (stability.candidate.vision.length > PROMOTION_ABSOLUTE_GATES.vision.maxUnstableCases) technicalFailures.push("candidate vision absolute stability ceiling failed");

  const casesFor = (arm: ArmName, surface: "decision" | "vision") => runs.flatMap((run) => {
    const cases = run.arms?.[arm]?.[surface]?.cases;
    return Array.isArray(cases) ? cases : [];
  });
  const correctFields = (arm: ArmName) => casesFor(arm, "decision").filter((item) => item.finalGuardedAgreesWithLabel === true).length
    + casesFor(arm, "vision").reduce((sum, item) => sum
      + (Number.isInteger(item.normalizedStringCorrect) ? Number(item.normalizedStringCorrect) : 0)
      + (Number.isInteger(item.numericCorrect) ? Number(item.numericCorrect) : 0), 0);
  const latencyRatio = (surface: "decision" | "vision") => {
    const field = surface === "decision" ? "latencyMsIncludingSeedSetup" : "latencyMs";
    const baseline = meanLatencyOrNull(casesFor("baseline", surface).map((item) => Number(item[field])));
    const candidate = meanLatencyOrNull(casesFor("candidate", surface).map((item) => Number(item[field])));
    return finiteLatency(baseline) && finiteLatency(candidate) ? candidate / baseline : null;
  };
  const baselineCorrectFields = correctFields("baseline");
  const candidateCorrectFields = correctFields("candidate");
  const aggregateCorrectFieldGain = candidateCorrectFields - baselineCorrectFields;
  const decisionLatencyRatio = latencyRatio("decision");
  const visionLatencyRatio = latencyRatio("vision");
  const stable = stability.candidate.decision.length <= stability.baseline.decision.length
    && stability.candidate.vision.length <= stability.baseline.vision.length
    && stability.candidate.decision.length <= PROMOTION_ABSOLUTE_GATES.decision.maxUnstableCases
    && stability.candidate.vision.length <= PROMOTION_ABSOLUTE_GATES.vision.maxUnstableCases;
  const qualityGain = stable && aggregateCorrectFieldGain >= PROMOTION_MATERIAL_BENEFIT_GATES.aggregateCorrectFieldGain;
  const decisionLatencyWin = aggregateCorrectFieldGain >= 0
    && decisionLatencyRatio !== null && decisionLatencyRatio <= PROMOTION_MATERIAL_BENEFIT_GATES.aggregateLatencyWinRatio
    && visionLatencyRatio !== null && visionLatencyRatio <= PROMOTION_MATERIAL_BENEFIT_GATES.otherSurfaceMaxLatencyRatio;
  const visionLatencyWin = aggregateCorrectFieldGain >= 0
    && visionLatencyRatio !== null && visionLatencyRatio <= PROMOTION_MATERIAL_BENEFIT_GATES.aggregateLatencyWinRatio
    && decisionLatencyRatio !== null && decisionLatencyRatio <= PROMOTION_MATERIAL_BENEFIT_GATES.otherSurfaceMaxLatencyRatio;
  const materialBenefit = {
    pass: qualityGain || decisionLatencyWin || visionLatencyWin,
    route: qualityGain ? "aggregate-quality-gain" : decisionLatencyWin ? "decision-latency-win" : visionLatencyWin ? "vision-latency-win" : null,
    thresholds: PROMOTION_MATERIAL_BENEFIT_GATES,
    observed: {
      baselineCorrectFields,
      candidateCorrectFields,
      aggregateCorrectFieldGain,
      decisionLatencyRatioVsBaseline: decisionLatencyRatio,
      visionLatencyRatioVsBaseline: visionLatencyRatio,
    },
  };
  const technicalNonInferiority = { pass: technicalFailures.length === 0, failures: technicalFailures };
  const failures = [...technicalFailures];
  if (!materialBenefit.pass) failures.push("candidate demonstrated no preregistered material benefit");
  return {
    pass: technicalNonInferiority.pass && materialBenefit.pass,
    failures,
    technicalNonInferiority,
    materialBenefit,
    stability,
  };
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
  assertPromotionCredential();
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
  const protocol = await committedProtocolState(PROMOTION_PROTOCOL_FILES, {
    strict: true,
    allowResultArtifacts: true,
    expectedReleaseGitCommit: cli.expectedRelease,
    requireHeadMatchesOriginMain: true,
  });
  const environment = await preflightPromotionEnvironment({ pdfFixtures: vision.pdfFixtures });
  const restoreEnvironment = applyPromotionEnvironment(environment);
  let environmentFinalized = false;
  let artifactCreated = false;
  let artifact: Record<string, unknown> | null = null;
  let persist: (() => Promise<void>) | null = null;
  try {
    const prov = await provenance(cli, target, datasetSha256, vision, environment.attestation, protocol, endpoint);
    const models = {
    baseline: { decision: cli.baselineDecision, vision: cli.baselineVision, embedding: DEFAULT_EMBED_MODEL },
    candidate: { decision: cli.candidate, vision: cli.candidate, embedding: DEFAULT_EMBED_MODEL },
  };
    const runs: Array<Record<string, unknown>> = [];
    artifact = {
    schemaVersion: 2,
    status: PROMOTION_PROGRESS_ROOT_STATUS,
    evaluation: "archon-counterbalanced-model-promotion",
    generatedAt: new Date().toISOString(),
    models,
    order: ["AB", "BA", "BA", "AB"],
    pairing: "case-interleaved-alternating-first-arm",
    dataset: { scenarios: EVAL_SET.length, sha256: datasetSha256, role: "frozen tuned developer-labelled AP regression set; not held-out or expert-adjudicated" },
    visionFixtureSet: { cases: vision.manifest.cases.length, sha256: vision.fixtureSetSha256, fixtureBytesSha256: vision.fixtureBytesSha256, provenance: vision.manifest.license, role: "frozen original synthetic set; not representative production traffic" },
    provenance: prov,
    runs,
  };
    let terminalPublicationAuthorized = false;
    persist = () => {
      assertPromotionRootStatusForPersistence(artifact?.status, terminalPublicationAuthorized);
      return persistEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
    };
    const order: Array<[ArmName, ArmName]> = [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
    ["candidate", "baseline"],
    ["baseline", "candidate"],
  ];
    await mkdir(dirname(target), { recursive: true });
    await createExclusiveEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
    artifactCreated = true;
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
          run.arms[arm].vision = summarizeVision(visionCases[arm]);
        }
        await persist();
      }
      run.status = Object.values(run.arms).every((value: any) => value.decision.status === "complete" && value.vision.status === "complete") ? "complete" : "incomplete";
      await persist();
    }

    const releaseMismatches: string[] = [];
    let finalEnvironment: PromotionEnvironmentAttestation | null = null;
    try {
      finalEnvironment = await finalizePromotionEnvironment(environment);
      environmentFinalized = true;
      prov.promotionEnvironment = finalEnvironment;
    } catch (error) {
      const fixed = error instanceof PromotionEnvironmentError
        ? error
        : new PromotionEnvironmentError("promotion_temp_cleanup_failed");
      artifact.promotionEnvironmentDiagnostic = promotionEnvironmentDiagnostic(fixed);
      releaseMismatches.push("poppler-or-cleanup");
    }
    const activeResultPath = relative(process.cwd(), target).replace(/\\/g, "/");
    const endProtocol = await committedProtocolState(PROMOTION_PROTOCOL_FILES, {
      allowResultArtifacts: true,
      activeResultPath,
      expectedReleaseGitCommit: cli.expectedRelease,
      requireHeadMatchesOriginMain: true,
    });
    if (endProtocol.protocolTreeClean !== true) releaseMismatches.push("protocol-tree");
    if (endProtocol.headMatchesExpectedRelease !== true) releaseMismatches.push("expected-release");
    let endDatasetSha256: string | null = null;
    let endVision: FrozenVisionSet | null = null;
    try { endDatasetSha256 = await assertFrozenDataset(); } catch { releaseMismatches.push("dataset"); }
    try { endVision = await loadFrozenVisionSet(); } catch { releaseMismatches.push("fixtures"); }
    if (finalEnvironment && endDatasetSha256 && endVision && endProtocol.protocolSha256) {
      const endSnapshot = promotionReleaseSnapshot(endProtocol, endDatasetSha256, endVision, finalEnvironment);
      prov.releaseAttestation.end = endSnapshot;
      const comparison = comparePromotionReleaseSnapshots(prov.releaseAttestation.start, endSnapshot);
      releaseMismatches.push(...comparison.mismatches);
    } else {
      prov.releaseAttestation.end = {
        observedAt: new Date().toISOString(),
        status: "unavailable",
        gitCommit: endProtocol.gitCommit,
        originMainGitCommit: endProtocol.originMainGitCommit,
        protocolSha256: endProtocol.protocolSha256,
      };
      releaseMismatches.push("end-attestation-unavailable");
    }
    prov.releaseAttestation.mismatches = [...new Set(releaseMismatches)].sort();
    prov.releaseAttestation.status = prov.releaseAttestation.mismatches.length === 0 ? "passed" : "drift";

    const promotion = promotionGate(runs as Array<Record<string, any>>);
    if (prov.releaseAttestation.status !== "passed") {
      promotion.failures.push("same-release final attestation failed");
      promotion.pass = false;
    }
    artifact.promotion = promotion;
    artifact.status = terminalPromotionArtifactStatus(
      runs as Array<Record<string, any>>,
      promotion.pass,
      prov.releaseAttestation.status !== "passed"
    );
    artifact.completedAt = new Date().toISOString();
    terminalPublicationAuthorized = true;
    await persist();
    console.log(`Counterbalanced A/B artifact: ${relative(process.cwd(), target)} · ${artifact.status}`);
    if (!promotion.pass) process.exitCode = 2;
  } catch (error) {
    if (artifactCreated && artifact && persist) {
      artifact.status = PROMOTION_PROGRESS_ROOT_STATUS;
      artifact.completedAt = new Date().toISOString();
      artifact.executionDiagnostic = error instanceof PromotionEnvironmentError
        ? promotionEnvironmentDiagnostic(error)
        : categoricalEvalError(error);
      await persist().catch(() => {});
    }
    throw error;
  } finally {
    restoreEnvironment();
    if (!environmentFinalized) {
      await cleanupPromotionEnvironment(environment).catch(() => {
        throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
      });
    }
  }
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
