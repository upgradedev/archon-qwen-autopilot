// Frozen AP system/model policy-agreement evaluation.
// Offline is an explicit tuned regression policy. Online records the raw Qwen
// terminal choice separately from any deterministic safety override, catches
// every case error, and persists progress after each case.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { hasQwenCreds, officialEvidenceEndpoint, QWEN_MAX_RETRIES, QWEN_REQUEST_TIMEOUT_MS, requiresNonThinkingJsonOrTools, type OfficialEvidenceEndpoint } from "../src/qwen/client.js";
import { DEFAULT_DECIDER_MODEL, DEFAULT_MAX_STEPS, DEFAULT_RUN_DEADLINE_MS } from "../src/ap/loop.js";
import { DEFAULT_EMBED_MODEL, EMBED_DIM } from "../src/memory/embeddings.js";
import { EVAL_SET } from "./dataset.js";
import { assertFrozenDataset } from "./hash.js";
import { runScenario, summarizeRows, type EvalMode, type EvalRow, type EvalSummary } from "./lib.js";
import { canonicalEvidenceCommand, categoricalEvalError, createExclusiveEvidenceArtifact, persistEvidenceArtifact, type CategoricalEvalError } from "./artifact-safety.js";

const exec = promisify(execFile);
const GATE_ACCURACY = 0.9;

interface Cli { mode: EvalMode; runs: number; gate: boolean; write?: string }
interface CaseError { id: string; category: string; expected: string; status: "error"; error: CategoricalEvalError }

function parseCli(argv: string[]): Cli {
  const online = argv.includes("--online");
  const after = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const runs = after("--runs") == null ? 1 : Number(after("--runs"));
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be an integer from 1 to 10");
  if (online && runs < 3) throw new Error("online evidence requires at least 3 repeated runs (--runs 3); repetitions are not independent samples");
  if (online && !hasQwenCreds()) throw new Error("--online requires DASHSCOPE_API_KEY; no score was generated");
  if (online && !after("--write")) throw new Error("online evidence requires --write <repo-contained.json>");
  if (!online && argv.includes("--write")) throw new Error("offline regression output is not written as online evidence");
  return { mode: online ? "online" : "offline", runs, gate: argv.includes("--gate"), write: after("--write") };
}

function safeArtifactPath(input: string): string {
  const target = resolve(input), rel = relative(process.cwd(), target);
  if (isAbsolute(rel) || rel.startsWith("..") || !rel) throw new Error("--write must name a file inside this repository");
  return target;
}

function group(rows: EvalRow[], field: "category" | "expected", modelOutcome: boolean) {
  const out: Record<string, { correct: number; total: number; accuracy: number }> = {};
  const byId = new Map(rows.map((row) => [row.scenario.id, row]));
  for (const scenario of EVAL_SET) {
    const row = byId.get(scenario.id);
    const key = field === "category" ? scenario.category : scenario.expected;
    const cell = out[key] ?? { correct: 0, total: 0, accuracy: 0 };
    cell.total++;
    if (row && (modelOutcome ? row.modelCorrect : row.correct)) cell.correct++;
    cell.accuracy = cell.correct / cell.total;
    out[key] = cell;
  }
  return out;
}

function sanitizeRow(r: EvalRow) {
  return {
    id: r.scenario.id, status: r.conclusive ? "ok" : "inconclusive", category: r.scenario.category,
    expected: r.scenario.expected, rawModelTerminalTool: r.rawModelProposed,
    finalGuardedProposal: r.proposed, modelAgreesWithLabel: r.modelCorrect,
    systemAgreesWithLabel: r.correct, policyOverride: r.policyOverride,
    policyOverrideSource: r.policyOverrideSource, policyOverrideReason: r.policyOverrideReason,
    fallback: r.fallback,
    proposalContractSane: r.argSane,
    rawArgsExecutable: r.rawArgsExecutable,
    reviewerEnrichmentRequired: r.reviewerEnrichmentRequired,
    reviewerEnrichedExecutionVerified: r.reviewerEnrichedExecutionVerified,
    readAnalyzeSteps: r.steps, successfulDecisionModelCalls: r.modelCalls,
    setupDecisionModelCalls: r.setupDecisionModelCalls, finalDecisionModelCalls: r.finalDecisionModelCalls,
    setupPromptTokens: r.setupPromptTokens, setupCompletionTokens: r.setupCompletionTokens,
    successfulEmbeddingCalls: r.embeddingCalls, decisionPromptTokens: r.promptTokens,
    decisionCompletionTokens: r.completionTokens, embeddingTokens: r.embeddingTokens,
    scenarioWallClockMsIncludingSeedSetup: r.latencyMs, stopReason: r.stopReason,
    modelId: r.modelId, traceTools: r.traceTools,
  };
}

function sanitizedRun(index: number, summary: EvalSummary, errors: CaseError[], startedAt: string, finishedAt: string, online: boolean) {
  const modelCorrect = summary.rows.filter((r) => r.modelCorrect).length;
  const inconclusive = summary.rows.filter((r) => !r.conclusive).length;
  const complete = errors.length === 0 && inconclusive === 0 && summary.n === EVAL_SET.length;
  return {
    run: index, status: complete ? "complete" : "incomplete", startedAt, finishedAt,
    completion: { conclusive: summary.n - inconclusive, inconclusive, errors: errors.length, expected: EVAL_SET.length },
    primaryAccuracy: online ? modelCorrect / EVAL_SET.length : summary.correct / EVAL_SET.length,
    primaryCorrect: online ? modelCorrect : summary.correct,
    primaryDenominator: EVAL_SET.length,
    primaryMetric: online ? "raw Qwen terminal-tool agreement with developer label; fallbacks/errors count incorrect" : "final system-policy agreement with developer label",
    finalSystemAgreement: { correct: summary.correct, total: EVAL_SET.length, rate: summary.correct / EVAL_SET.length },
    rawModelAgreement: { correct: modelCorrect, total: EVAL_SET.length, rate: modelCorrect / EVAL_SET.length },
    proposalContractSanity: { correct: summary.argSane, total: EVAL_SET.length, rate: summary.argSane / EVAL_SET.length },
    rawArgumentExecutability: {
      executable: summary.rawArgsExecutable,
      total: EVAL_SET.length,
      rate: summary.rawArgsExecutable / EVAL_SET.length,
      note: "Clarification drafts intentionally omit `to`; they are non-executable until a reviewer supplies a verified recipient.",
    },
    reviewerEnrichedExecution: {
      verified: summary.reviewerEnrichedExecutionVerified,
      total: EVAL_SET.length,
      rate: summary.reviewerEnrichedExecutionVerified / EVAL_SET.length,
    },
    autonomy: { averageReadAnalyzeSteps: summary.avgSteps, minimumReadAnalyzeSteps: summary.minSteps, multiStepCases: summary.multiStep, completedCases: summary.n },
    latency: { ...summary.latencyMs, definition: "scenario wall clock including seed/history setup; not single-invoice production latency" },
    usage: {
      successfulDecisionModelCalls: summary.rows.reduce((s, r) => s + r.modelCalls, 0),
      successfulEmbeddingCalls: summary.rows.reduce((s, r) => s + r.embeddingCalls, 0),
      decisionPromptTokens: nullableSum(summary.rows.map((r) => r.promptTokens)),
      decisionCompletionTokens: nullableSum(summary.rows.map((r) => r.completionTokens)),
      embeddingTokens: nullableSum(summary.rows.map((r) => r.embeddingTokens)),
      note: "Successful response counts exclude provider-SDK transparent retry attempts.",
    },
    catches: { duplicate: summary.rows.filter((r) => r.duplicateCaught).length, anomaly: summary.rows.filter((r) => r.anomalyCaught).length },
    byCategory: group(summary.rows, "category", online), byExpectedTool: group(summary.rows, "expected", online),
    misses: summary.rows.filter((r) => online ? !r.modelCorrect : !r.correct).map(sanitizeRow),
    errors, cases: [...summary.rows.map(sanitizeRow), ...errors],
  };
}

function nullableSum(values: Array<number | null>): number | null {
  return values.every((v) => v != null) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null;
}

async function protocolProvenance(datasetHash: string, cli: Cli, target: string | null, endpoint: OfficialEvidenceEndpoint | null) {
  const files = [
    "eval/dataset.ts", "eval/dataset.sha256", "eval/hash.ts", "eval/lib.ts", "eval/artifact-safety.ts", "eval/run.ts",
    "src/agents/autopilot-agent.ts", "src/ap/loop.ts", "src/ap/analysis-tools.ts", "src/ap/tools.ts",
    "src/ap/fake-chat.ts", "src/ap/workitem-store.ts", "src/ap/sinks.ts", "src/ap/normalize.ts",
    "src/ap/validate.ts", "src/ap/currency.ts", "src/ap/finance-policy.ts", "src/ap/extraction-confidence.ts",
    "src/memory/embeddings.ts", "src/memory/memory.ts", "src/memory/store.ts",
    "src/qwen/client.ts", "src/qwen/injection-scan.ts", "src/security/operational-error.ts",
    "src/types.ts", "package-lock.json",
  ];
  const h = createHash("sha256");
  for (const file of files) h.update(file).update(await readFile(resolve(file)));
  let commit: string | null = null, clean: boolean | null = null;
  let protocolTreeClean: boolean | null = null;
  let allowedDirtyResultArtifacts: Array<{ status: string; path: string }> = [];
  let disallowedDirtyPaths: Array<{ status: string; path: string }> = [];
  try {
    commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
    for (const file of files) {
      await exec("git", ["ls-files", "--error-unmatch", "--", file], { cwd: process.cwd() });
      await exec("git", ["diff", "--quiet", "HEAD", "--", file], { cwd: process.cwd() });
    }
    const statusText = (await exec(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: process.cwd() }
    )).stdout;
    const dirty = statusText.split(/\r?\n/).filter(Boolean).map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).replace(/^"|"$/g, ""),
    }));
    allowedDirtyResultArtifacts = dirty.filter(
      (entry) => !entry.status.includes("D") && !entry.status.includes("R") && /^eval\/results\/[A-Za-z0-9._-]+\.json$/.test(entry.path)
    );
    const allowed = new Set(allowedDirtyResultArtifacts.map((entry) => `${entry.status}\0${entry.path}`));
    disallowedDirtyPaths = dirty.filter((entry) => !allowed.has(`${entry.status}\0${entry.path}`));
    clean = dirty.length === 0;
    protocolTreeClean = disallowedDirtyPaths.length === 0;
  } catch { /* artifact still records null provenance instead of inventing it */ }
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string; dependencies?: Record<string, string> };
  const commandArgs = [
    ...(cli.mode === "online" ? ["--online"] : []),
    ...(cli.runs !== 1 || cli.mode === "online" ? ["--runs", String(cli.runs)] : []),
    ...(target ? ["--write", relative(process.cwd(), target).replace(/\\/g, "/")] : []),
    ...(cli.gate ? ["--gate"] : []),
  ];
  return {
    datasetSha256: datasetHash, protocolSha256: h.digest("hex"), files, gitCommit: commit, gitClean: clean,
    protocolTreeClean, allowedDirtyResultArtifacts, disallowedDirtyPaths,
    command: canonicalEvidenceCommand("eval/run.ts", commandArgs), node: process.version,
    packageVersion: pkg.version, openaiSdk: pkg.dependencies?.openai, providerEndpoint: endpoint,
    parameters: {
      deciderModelId: DEFAULT_DECIDER_MODEL,
      embeddingModelId: DEFAULT_EMBED_MODEL,
      temperature: 0.1,
      maxTokensPerDecisionCall: 512,
      toolChoice: "auto",
      enableThinking: requiresNonThinkingJsonOrTools(DEFAULT_DECIDER_MODEL) ? false : "provider-default",
      embeddingDimensions: EMBED_DIM,
      maxSteps: DEFAULT_MAX_STEPS,
      runDeadlineMs: DEFAULT_RUN_DEADLINE_MS,
      requestTimeoutMs: QWEN_REQUEST_TIMEOUT_MS,
      sdkMaxRetries: QWEN_MAX_RETRIES,
      failurePolicy: "errors and fallbacks count incorrect; no case is silently excluded",
    },
  };
}

function stability(runs: Array<ReturnType<typeof sanitizedRun>>) {
  const cases = EVAL_SET.map((s) => {
    const outcomes = runs.map((r) => {
      const c = r.cases.find((x: {id:string}) => x.id === s.id) as Record<string, unknown> | undefined;
      return c?.status === "error" ? "ERROR" : String(c?.rawModelTerminalTool ?? "INCONCLUSIVE");
    });
    return { id: s.id, outcomes, stable: new Set(outcomes).size === 1 };
  });
  return { perCase: cases, unstableCaseIds: cases.filter((c) => !c.stable).map((c) => c.id) };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const datasetHash = await assertFrozenDataset();
  const target = cli.write ? safeArtifactPath(cli.write) : null;
  const endpoint = cli.mode === "online" ? officialEvidenceEndpoint() : null;
  const provenance = await protocolProvenance(datasetHash, cli, target, endpoint);
  if (cli.mode === "online" && (provenance.protocolTreeClean !== true || !provenance.gitCommit)) {
    throw new Error("online AP evidence requires committed, unchanged protocol inputs and no dirty paths outside eval/results/*.json");
  }
  const runs: Array<ReturnType<typeof sanitizedRun>> = [];
  const artifact: Record<string, unknown> = {
    schemaVersion: 2, status: cli.mode === "online" ? "running" : "not_written", evaluation: "archon-autopilot-ap-policy-agreement",
    generatedAt: new Date().toISOString(), mode: cli.mode, models: { decider: DEFAULT_DECIDER_MODEL, embedder: DEFAULT_EMBED_MODEL },
    dataset: { scenarios: EVAL_SET.length, sha256: datasetHash, role: "frozen tuned development/regression set", labels: "developer-labelled under the documented conservative AP policy; not expert-adjudicated, held-out, or a human study" },
    provenance, repetitions: cli.runs, runs,
  };
  if (target) {
    await mkdir(dirname(target), { recursive: true });
    await createExclusiveEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  const persist = async () => { if (target) await persistEvidenceArtifact(target, `${JSON.stringify(artifact, null, 2)}\n`); };

  console.log(`\nArchon Autopilot — ${cli.mode === "online" ? "raw Qwen + guarded system" : "deterministic system regression"} evaluation`);
  console.log(`Dataset: ${EVAL_SET.length} frozen tuned developer-labelled cases · sha256:${datasetHash}`);
  console.log(`Protocol: sha256:${provenance.protocolSha256} · git ${provenance.gitCommit ?? "unknown"} · ${provenance.protocolTreeClean === true ? "inputs clean (result artifacts allowed)" : "dirty/unavailable"}`);
  for (let i = 1; i <= cli.runs; i++) {
    const startedAt = new Date().toISOString(), rows: EvalRow[] = [], errors: CaseError[] = [];
    for (const scenario of EVAL_SET) {
      try { rows.push(await runScenario(scenario, cli.mode)); }
      catch (err) { errors.push({ id: scenario.id, category: scenario.category, expected: scenario.expected, status: "error", error: categoricalEvalError(err) }); }
      const partial = sanitizedRun(i, summarizeRows(rows), errors, startedAt, new Date().toISOString(), cli.mode === "online");
      runs[i - 1] = partial; await persist();
    }
    const run = runs[i - 1]!;
    console.log(`Run ${i}: primary ${run.primaryCorrect}/${run.primaryDenominator} (${(run.primaryAccuracy * 100).toFixed(1)}%) · status ${run.status}`);
    if (cli.gate && (
      run.status !== "complete" ||
      run.primaryAccuracy < GATE_ACCURACY ||
      run.proposalContractSanity.correct !== EVAL_SET.length ||
      run.reviewerEnrichedExecution.verified !== EVAL_SET.length ||
      run.autonomy.multiStepCases !== EVAL_SET.length
    )) throw new Error(`offline gate failed on run ${i}: require complete, ≥${GATE_ACCURACY * 100}% agreement, 100% policy-safe proposal contracts, verified reviewer-enriched execution, and every case multi-step`);
  }
  const accuracies = runs.map((r) => r.primaryAccuracy);
  artifact.aggregate = { unit: `${EVAL_SET.length} repeated cases per run (repetitions are not independent new samples)`, perRunAccuracies: accuracies, mean: accuracies.reduce((s, n) => s + n, 0) / accuracies.length, min: Math.min(...accuracies), max: Math.max(...accuracies), stability: stability(runs) };
  artifact.cost = costEvidence(runs);
  artifact.status = runs.every((r) => r.status === "complete") ? "complete" : "incomplete";
  artifact.completedAt = new Date().toISOString();
  await persist();
  if (cli.gate) console.log(`Offline regression gate passed: every case conclusive/multi-step, ≥ ${GATE_ACCURACY * 100}% policy agreement, policy-safe proposal contracts, and verified reviewer enrichment where required`);
  if (target) console.log(`Sanitized artifact: ${relative(process.cwd(), target)} · ${artifact.status}`);
  if (target && artifact.status !== "complete") process.exitCode = 2;
}

function costEvidence(runs: Array<ReturnType<typeof sanitizedRun>>) {
  const inputRate = Number(process.env.QWEN_INPUT_USD_PER_MILLION_TOKENS);
  const outputRate = Number(process.env.QWEN_OUTPUT_USD_PER_MILLION_TOKENS);
  const embedRate = Number(process.env.QWEN_EMBED_USD_PER_MILLION_TOKENS);
  const source = process.env.QWEN_PRICING_SOURCE;
  const runCosts = runs.map((r) => {
    const u = r.usage;
    if (![inputRate, outputRate, embedRate].every(Number.isFinite) || !source || u.decisionPromptTokens == null || u.decisionCompletionTokens == null || u.embeddingTokens == null) return null;
    return (u.decisionPromptTokens * inputRate + u.decisionCompletionTokens * outputRate + u.embeddingTokens * embedRate) / 1_000_000;
  });
  return runCosts.every((n) => n != null)
    ? { estimatedUsdPerRun: runCosts, pricingSnapshot: { inputRate, outputRate, embedRate, source }, note: "Estimate from captured tokens and caller-supplied dated pricing source." }
    : { estimatedUsdPerRun: null, pricingSnapshot: null, note: "Token usage remains in each run. Monetary cost is null unless all three rates plus QWEN_PRICING_SOURCE are supplied; no price is fabricated." };
}

main().catch((err) => { console.error(`Evaluation failed: ${JSON.stringify(categoricalEvalError(err))}`); process.exit(1); });
