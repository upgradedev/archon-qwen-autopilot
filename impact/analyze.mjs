import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCommittedReplayEvidenceInputs,
  assertLockedImpactRuntime,
  canonicalImpactTextSha256,
  captureReplaySourceIdentityAtCleanHead,
  LOCKED_NODE_LABEL,
  verifyReplaySourceIdentity,
} from "./provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FILES = {
  protocol: join(HERE, "protocol.json"),
  cases: join(HERE, "cases.json"),
  raw: join(HERE, "raw-observations.json"),
  analysis: fileURLToPath(import.meta.url),
  provenance: join(HERE, "provenance.mjs"),
  evalDataset: join(ROOT, "eval", "dataset.ts"),
  evalLib: join(ROOT, "eval", "lib.ts"),
  evalArtifactSafety: join(ROOT, "eval", "artifact-safety.ts"),
  evalPromotionEnvironment: join(ROOT, "eval", "promotion-environment.ts"),
  evalProtocolProvenance: join(ROOT, "eval", "protocol-provenance.ts"),
  packageJson: join(ROOT, "package.json"),
  packageLock: join(ROOT, "package-lock.json"),
  tsconfig: join(ROOT, "tsconfig.json"),
  resultsJson: join(HERE, "results.json"),
  resultsMarkdown: join(HERE, "RESULTS.md"),
};
const ACTIONS = new Set([
  "draft_journal_entry",
  "draft_payment",
  "draft_vendor_reply",
  "flag_for_review",
]);
const BOUNDS = ["low", "base", "high"];
const REQUIRED_PROHIBITIONS = [
  "roi",
  "labor savings",
  "headcount reduction",
  "production throughput",
  "production error reduction",
  "human accuracy improvement",
  "causal impact",
  "population generalization",
  "statistical significance",
];
let EVAL_SET;
let runScenario;

function fail(message) {
  throw new Error(message);
}

function invariant(condition, message) {
  if (!condition) fail(message);
}

async function loadVerifiedReplayModules() {
  const [datasetModule, runnerModule] = await Promise.all([
    import("../eval/dataset.ts"),
    import("../eval/lib.ts"),
  ]);
  invariant(Array.isArray(datasetModule.EVAL_SET), "verified eval dataset module has no EVAL_SET");
  invariant(typeof runnerModule.runScenario === "function", "verified eval runner module has no runScenario");
  EVAL_SET = datasetModule.EVAL_SET;
  runScenario = runnerModule.runScenario;
}

function readText(path) {
  invariant(existsSync(path), "missing required input: " + path);
  return readFileSync(path, "utf8");
}

function readJson(path) {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("invalid JSON in " + path + ": " + String(error));
  }
}

function round1(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values) {
  invariant(values.length > 0, "cannot compute a median for an empty array");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : round1((sorted[middle - 1] + sorted[middle]) / 2);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateWeight(arm, taskId, weight) {
  invariant(weight && typeof weight === "object", arm + "." + taskId + " has no weight object");
  invariant(typeof weight.description === "string" && weight.description.trim(), arm + "." + taskId + " has no description");
  invariant(Number.isInteger(weight.humanTouches) && weight.humanTouches >= 0, arm + "." + taskId + " has invalid humanTouches");
  invariant(weight.seconds && typeof weight.seconds === "object", arm + "." + taskId + " has no seconds object");
  for (const bound of BOUNDS) {
    invariant(Number.isFinite(weight.seconds[bound]) && weight.seconds[bound] >= 0, arm + "." + taskId + " has invalid " + bound + " seconds");
  }
  invariant(
    weight.seconds.low <= weight.seconds.base && weight.seconds.base <= weight.seconds.high,
    arm + "." + taskId + " must satisfy low <= base <= high",
  );
}

function deriveArm(protocol, arm, tasks, caseId) {
  invariant(Array.isArray(tasks) && tasks.length > 0, caseId + "." + arm + " has no humanTasks");
  invariant(new Set(tasks).size === tasks.length, caseId + "." + arm + " repeats a task");
  const catalog = protocol.taskWeights[arm];
  invariant(catalog && typeof catalog === "object", "protocol has no " + arm + " task catalog");
  const selected = tasks.map((taskId) => {
    invariant(typeof taskId === "string" && catalog[taskId], caseId + "." + arm + " uses undeclared task " + String(taskId));
    return catalog[taskId];
  });
  return {
    low: sum(selected.map((weight) => weight.seconds.low)),
    base: sum(selected.map((weight) => weight.seconds.base)),
    high: sum(selected.map((weight) => weight.seconds.high)),
    touches: sum(selected.map((weight) => weight.humanTouches)),
  };
}

function validateInputs(protocol, casesFile, raw, rawText) {
  invariant(protocol.schemaVersion === 1, "unsupported protocol schemaVersion");
  invariant(protocol.protocolId === "autopilot-synthetic-impact-v1", "unexpected protocolId");
  invariant(protocol.registration?.status === "repository-local analysis-plan freeze", "registration boundary drifted");
  invariant(protocol.registration?.notClaimed?.includes("not an external"), "registration must reject prospective/external overclaiming");
  invariant(protocol.analysisPlan?.descriptiveOnly === true, "analysis must remain descriptive-only");
  invariant(protocol.analysisPlan?.missingData?.includes("fail closed"), "missing-data policy must fail closed");
  invariant(protocol.caseSet?.exclusionsAfterFreeze === "None. Missing, malformed, or duplicate observations fail analysis; no case is dropped or imputed.", "post-freeze exclusion rule drifted");

  for (const arm of ["manual", "assisted"]) {
    invariant(protocol.arms?.[arm], "protocol arm missing: " + arm);
    const weights = protocol.taskWeights?.[arm];
    invariant(weights && Object.keys(weights).length > 0, "task catalog missing: " + arm);
    for (const [taskId, weight] of Object.entries(weights)) validateWeight(arm, taskId, weight);
  }

  const prohibitions = new Set((protocol.prohibitedClaims ?? []).map((claim) => String(claim).toLowerCase()));
  for (const claim of REQUIRED_PROHIBITIONS) invariant(prohibitions.has(claim), "missing prohibited claim boundary: " + claim);

  invariant(casesFile.schemaVersion === 1 && casesFile.protocolId === protocol.protocolId, "cases/protocol schema mismatch");
  invariant(Array.isArray(casesFile.cases), "cases.json has no cases array");
  invariant(EVAL_SET.length === protocol.caseSet.sourceDatasetSize, "source eval-set size drifted");
  invariant(casesFile.source?.datasetScenarioCount === EVAL_SET.length, "cases source-set size drifted");

  const caseIds = casesFile.cases.map((item) => item.id);
  invariant(caseIds.length === protocol.caseSet.size, "case count differs from frozen protocol");
  invariant(new Set(caseIds).size === caseIds.length, "duplicate case id");
  invariant(sameJson(caseIds, protocol.caseSet.caseIds), "case order or membership differs from frozen protocol");

  const sourceCases = EVAL_SET
    .filter((scenario) => new Set(protocol.caseSet.caseIds).has(scenario.id))
    .map((scenario) => ({
      id: scenario.id,
      category: scenario.category,
      label: scenario.label,
      seed: scenario.seed ?? [],
      invoice: scenario.invoice,
      expectedAction: scenario.expected,
    }));
  invariant(sameJson(casesFile.cases, sourceCases), "cases.json is not an exact projection of the selected live eval/dataset.ts scenarios");

  for (const item of casesFile.cases) {
    invariant(typeof item.id === "string" && item.id, "case id is empty");
    invariant(typeof item.category === "string" && item.category, item.id + " category is empty");
    invariant(typeof item.label === "string" && item.label, item.id + " label is empty");
    invariant(Array.isArray(item.seed), item.id + " seed must be an array");
    invariant(item.invoice && typeof item.invoice === "object", item.id + " invoice is missing");
    invariant(ACTIONS.has(item.expectedAction), item.id + " expectedAction is invalid");
  }

  invariant(raw.schemaVersion === 1 && raw.protocolId === protocol.protocolId, "raw/protocol schema mismatch");
  invariant(raw.observationKind === "synthetic workflow-model records", "raw observation kind must stay explicitly synthetic");
  invariant(raw.collection?.mode === "offline" && raw.collection?.networkUsed === false, "raw replay must be offline");
  invariant(raw.collection?.modelSeam === "FakeQwenChatClient", "raw replay model seam drifted");
  invariant(raw.collection?.runtime === LOCKED_NODE_LABEL, "raw replay runtime is not the locked runtime");
  invariant(/^[0-9a-f]{40}$/.test(raw.collection?.sourceCommit ?? ""), "raw replay sourceCommit is not a full SHA");
  invariant(Array.isArray(raw.observations), "raw observations array missing");
  invariant(raw.observations.length === caseIds.length, "raw observation denominator differs from fixed case set");
  invariant(sameJson(raw.observations.map((row) => row.caseId), caseIds), "raw observations are missing, duplicated, added, or reordered");
  invariant(!/"(?:seconds|touches|duration|latencyMs)"\s*:/.test(rawText), "raw observations must contain task sequences, not precomputed time/touch outcomes");

  const caseById = new Map(casesFile.cases.map((item) => [item.id, item]));
  for (const observation of raw.observations) {
    const item = caseById.get(observation.caseId);
    invariant(item, "observation references unknown case " + observation.caseId);
    invariant(ACTIONS.has(observation.manual?.action), observation.caseId + " manual action is invalid");
    invariant(typeof observation.manual?.decisionBasis === "string" && observation.manual.decisionBasis.trim(), observation.caseId + " manual decision basis is missing");
    invariant(ACTIONS.has(observation.assisted?.action), observation.caseId + " assisted action is invalid");
    deriveArm(protocol, "manual", observation.manual.humanTasks, observation.caseId);
    deriveArm(protocol, "assisted", observation.assisted.humanTasks, observation.caseId);

    const replay = observation.assisted.replay;
    invariant(replay && typeof replay === "object", observation.caseId + " assisted replay is missing");
    invariant(replay.reportedModelId === "qwen-plus", observation.caseId + " replay model id drifted");
    invariant(ACTIONS.has(replay.rawModelAction), observation.caseId + " raw model action is invalid");
    invariant(replay.stopReason === "terminal_action", observation.caseId + " replay did not terminate normally");
    invariant(Number.isInteger(replay.readAnalyzeSteps) && replay.readAnalyzeSteps >= 2, observation.caseId + " replay is not multi-step");
    invariant(Array.isArray(replay.traceTools) && replay.traceTools.length >= 2, observation.caseId + " replay trace is missing");
    invariant(
      replay.traceTools.filter((tool) => tool !== "proposal_argument_guard").length === replay.readAnalyzeSteps,
      observation.caseId + " trace/readAnalyzeSteps mismatch",
    );
    invariant(typeof replay.policyOverride === "boolean", observation.caseId + " policyOverride is not boolean");
    invariant(replay.rawModelAction === observation.assisted.action, observation.caseId + " raw/final action differs; this v1 record requires equality");
  }
}

async function validateFrozenReplay(protocol, raw) {
  const scenarioById = new Map(EVAL_SET.map((scenario) => [scenario.id, scenario]));
  const observationById = new Map(raw.observations.map((row) => [row.caseId, row]));
  const comparedFields = [
    "action",
    "reportedModelId",
    "rawModelAction",
    "stopReason",
    "readAnalyzeSteps",
    "traceTools",
    "policyOverride",
  ];
  let matching = 0;

  for (const caseId of protocol.caseSet.caseIds) {
    const scenario = scenarioById.get(caseId);
    const observation = observationById.get(caseId);
    invariant(scenario, "replay scenario missing from eval/dataset.ts: " + caseId);
    invariant(observation, "frozen replay observation missing: " + caseId);

    const replayed = await runScenario(scenario, "offline");
    const actual = {
      action: replayed.proposed,
      reportedModelId: replayed.modelId,
      rawModelAction: replayed.rawModelProposed,
      stopReason: replayed.stopReason,
      readAnalyzeSteps: replayed.steps,
      traceTools: replayed.traceTools,
      policyOverride: replayed.policyOverride,
    };
    const frozen = {
      action: observation.assisted.action,
      reportedModelId: observation.assisted.replay.reportedModelId,
      rawModelAction: observation.assisted.replay.rawModelAction,
      stopReason: observation.assisted.replay.stopReason,
      readAnalyzeSteps: observation.assisted.replay.readAnalyzeSteps,
      traceTools: observation.assisted.replay.traceTools,
      policyOverride: observation.assisted.replay.policyOverride,
    };
    for (const field of comparedFields) {
      invariant(
        sameJson(actual[field], frozen[field]),
        caseId + " replay drift for " + field + ": frozen=" + JSON.stringify(frozen[field]) + ", actual=" + JSON.stringify(actual[field]),
      );
    }
    matching += 1;
  }

  return {
    runner: "eval/lib.ts runScenario(scenario, offline)",
    modelSeam: "FakeQwenChatClient",
    networkUsed: false,
    casesReplayed: protocol.caseSet.caseIds.length,
    casesMatchingFrozenRaw: matching,
    comparedFields,
    excludedField: "latencyMs (nondeterministic local test timing; not an impact endpoint)",
  };
}

function analyze(protocol, casesFile, raw, texts, replayValidation, sourceIdentity) {
  const observationById = new Map(raw.observations.map((row) => [row.caseId, row]));
  const rows = casesFile.cases.map((item) => {
    const observation = observationById.get(item.id);
    const manual = deriveArm(protocol, "manual", observation.manual.humanTasks, item.id);
    const assisted = deriveArm(protocol, "assisted", observation.assisted.humanTasks, item.id);
    return {
      caseId: item.id,
      category: item.category,
      expectedAction: item.expectedAction,
      actions: {
        manual: observation.manual.action,
        assisted: observation.assisted.action,
        manualPolicyLabelMismatch: observation.manual.action !== item.expectedAction,
        assistedPolicyLabelMismatch: observation.assisted.action !== item.expectedAction,
      },
      modeledActiveReviewSeconds: {
        manual: { low: manual.low, base: manual.base, high: manual.high },
        assisted: { low: assisted.low, base: assisted.base, high: assisted.high },
        pairedBaseDelta: manual.base - assisted.base,
        adverseWeightDelta: manual.low - assisted.high,
        favorableWeightDelta: manual.high - assisted.low,
      },
      modeledHumanTouches: {
        manual: manual.touches,
        assisted: assisted.touches,
        pairedDelta: manual.touches - assisted.touches,
      },
      assistedReplay: {
        rawModelAction: observation.assisted.replay.rawModelAction,
        stopReason: observation.assisted.replay.stopReason,
        readAnalyzeSteps: observation.assisted.replay.readAnalyzeSteps,
        traceTools: observation.assisted.replay.traceTools,
        policyOverride: observation.assisted.replay.policyOverride,
      },
    };
  });

  const manualBase = rows.map((row) => row.modeledActiveReviewSeconds.manual.base);
  const assistedBase = rows.map((row) => row.modeledActiveReviewSeconds.assisted.base);
  const baseDeltas = rows.map((row) => row.modeledActiveReviewSeconds.pairedBaseDelta);
  const adverseDeltas = rows.map((row) => row.modeledActiveReviewSeconds.adverseWeightDelta);
  const favorableDeltas = rows.map((row) => row.modeledActiveReviewSeconds.favorableWeightDelta);
  const manualTouches = rows.map((row) => row.modeledHumanTouches.manual);
  const assistedTouches = rows.map((row) => row.modeledHumanTouches.assisted);
  const touchDeltas = rows.map((row) => row.modeledHumanTouches.pairedDelta);
  const manualBaseTotal = sum(manualBase);
  const assistedBaseTotal = sum(assistedBase);
  const manualTouchTotal = sum(manualTouches);
  const assistedTouchTotal = sum(assistedTouches);
  const manualMismatches = rows.filter((row) => row.actions.manualPolicyLabelMismatch).length;
  const assistedMismatches = rows.filter((row) => row.actions.assistedPolicyLabelMismatch).length;

  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const categoryBreakdown = categories.map((category) => {
    const group = rows.filter((row) => row.category === category);
    return {
      category,
      n: group.length,
      manualPolicyLabelMismatches: group.filter((row) => row.actions.manualPolicyLabelMismatch).length,
      assistedPolicyLabelMismatches: group.filter((row) => row.actions.assistedPolicyLabelMismatch).length,
      manualBaseSecondsTotal: sum(group.map((row) => row.modeledActiveReviewSeconds.manual.base)),
      assistedBaseSecondsTotal: sum(group.map((row) => row.modeledActiveReviewSeconds.assisted.base)),
      pairedBaseSecondsDeltaTotal: sum(group.map((row) => row.modeledActiveReviewSeconds.pairedBaseDelta)),
      pairedHumanTouchDeltaTotal: sum(group.map((row) => row.modeledHumanTouches.pairedDelta)),
    };
  });

  return {
    schemaVersion: 1,
    protocolId: protocol.protocolId,
    studyType: "fixed synthetic workflow-model comparison",
    registration: protocol.registration,
    sourceReplay: {
      sourceCommit: raw.collection.sourceCommit,
      runtime: raw.collection.runtime,
      agentRunner: raw.collection.agentRunner,
      mode: raw.collection.mode,
      modelSeam: raw.collection.modelSeam,
      networkUsed: raw.collection.networkUsed,
      sourceIdentity,
    },
    rawReplayValidation: replayValidation,
    inputSha256: {
      protocolJson: canonicalImpactTextSha256(texts.protocol, "impact/protocol.json"),
      casesJson: canonicalImpactTextSha256(texts.cases, "impact/cases.json"),
      rawObservationsJson: canonicalImpactTextSha256(texts.raw, "impact/raw-observations.json"),
      analysisScript: canonicalImpactTextSha256(texts.analysis, "impact/analyze.mjs"),
      provenanceScript: canonicalImpactTextSha256(texts.provenance, "impact/provenance.mjs"),
      evalDataset: canonicalImpactTextSha256(texts.evalDataset, "eval/dataset.ts"),
      evalLib: canonicalImpactTextSha256(texts.evalLib, "eval/lib.ts"),
      evalArtifactSafety: canonicalImpactTextSha256(texts.evalArtifactSafety, "eval/artifact-safety.ts"),
      evalPromotionEnvironment: canonicalImpactTextSha256(texts.evalPromotionEnvironment, "eval/promotion-environment.ts"),
      evalProtocolProvenance: canonicalImpactTextSha256(texts.evalProtocolProvenance, "eval/protocol-provenance.ts"),
      packageJson: canonicalImpactTextSha256(texts.packageJson, "package.json"),
      packageLock: canonicalImpactTextSha256(texts.packageLock, "package-lock.json"),
      tsconfig: canonicalImpactTextSha256(texts.tsconfig, "tsconfig.json"),
    },
    denominator: rows.length,
    labelAuthority: casesFile.source.labelAuthority,
    endpoints: protocol.endpoints,
    aggregate: {
      policyLabelMismatch: {
        manual: { count: manualMismatches, denominator: rows.length, ratePct: round1((manualMismatches / rows.length) * 100) },
        assisted: { count: assistedMismatches, denominator: rows.length, ratePct: round1((assistedMismatches / rows.length) * 100) },
        pairedCountDelta: manualMismatches - assistedMismatches,
      },
      modeledActiveReviewSeconds: {
        base: {
          manualTotal: manualBaseTotal,
          assistedTotal: assistedBaseTotal,
          pairedDeltaTotal: manualBaseTotal - assistedBaseTotal,
          manualMean: round1(manualBaseTotal / rows.length),
          assistedMean: round1(assistedBaseTotal / rows.length),
          pairedMeanDelta: round1(sum(baseDeltas) / rows.length),
          manualMedian: median(manualBase),
          assistedMedian: median(assistedBase),
          pairedMedianDelta: median(baseDeltas),
          withinModelReductionPct: round1(((manualBaseTotal - assistedBaseTotal) / manualBaseTotal) * 100),
        },
        sensitivity: {
          adverseWeights: {
            definition: "manual low minus assisted high",
            pairedDeltaTotal: sum(adverseDeltas),
            pairedMeanDelta: round1(sum(adverseDeltas) / rows.length),
            casesWithPositiveDelta: adverseDeltas.filter((value) => value > 0).length,
            casesAtOrBelowZero: adverseDeltas.filter((value) => value <= 0).length,
          },
          favorableWeights: {
            definition: "manual high minus assisted low",
            pairedDeltaTotal: sum(favorableDeltas),
            pairedMeanDelta: round1(sum(favorableDeltas) / rows.length),
            casesWithPositiveDelta: favorableDeltas.filter((value) => value > 0).length,
            casesAtOrBelowZero: favorableDeltas.filter((value) => value <= 0).length,
          },
          interpretation: "These are assumption bounds over authored task weights, not confidence intervals.",
        },
      },
      modeledHumanTouches: {
        manualTotal: manualTouchTotal,
        assistedTotal: assistedTouchTotal,
        pairedDeltaTotal: manualTouchTotal - assistedTouchTotal,
        manualMean: round1(manualTouchTotal / rows.length),
        assistedMean: round1(assistedTouchTotal / rows.length),
        pairedMeanDelta: round1(sum(touchDeltas) / rows.length),
        manualMedian: median(manualTouches),
        assistedMedian: median(assistedTouches),
        pairedMedianDelta: median(touchDeltas),
        withinModelReductionPct: round1(((manualTouchTotal - assistedTouchTotal) / manualTouchTotal) * 100),
      },
      assistedReplay: {
        finalActionsMatchingDeveloperLabels: rows.length - assistedMismatches,
        rawModelActionsMatchingDeveloperLabels: rows.filter((row) => row.assistedReplay.rawModelAction === row.expectedAction).length,
        policyOverrideCount: rows.filter((row) => row.assistedReplay.policyOverride).length,
        meanReadAnalyzeSteps: round1(sum(rows.map((row) => row.assistedReplay.readAnalyzeSteps)) / rows.length),
      },
    },
    categoryBreakdown,
    rows,
    claimBoundary: {
      permitted: "Within this authored 12-case workflow model, the assisted arm uses fewer modeled base active-review seconds and human checkpoints while both arms match the developer policy labels.",
      notPermitted: protocol.prohibitedClaims,
      caveat: "No humans were timed, no production invoices were sampled, task weights are assumptions, and labels are not independent expert ground truth.",
    },
  };
}

function renderMarkdown(result, protocol) {
  const base = result.aggregate.modeledActiveReviewSeconds.base;
  const sensitivity = result.aggregate.modeledActiveReviewSeconds.sensitivity;
  const touches = result.aggregate.modeledHumanTouches;
  const mismatches = result.aggregate.policyLabelMismatch;
  const lines = [
    "# Synthetic impact study — generated results",
    "",
    "> Deterministically generated by impact/analyze.mjs. Do not edit this file by hand.",
    "",
    "## Scope boundary",
    "",
    "This is a fixed **synthetic workflow-model comparison**, not a human study, field trial, production benchmark, time-and-motion study, or ROI analysis. The manual time and touch values are sums of public task assumptions; only the Autopilot action/trace records come from deterministic offline replay.",
    "",
    "The repository-local analysis plan was frozen before these derived files were generated, but after the underlying developer fixtures and deterministic outcomes existed. It is **not** an external, prospective, outcome-blind preregistration.",
    "",
    "## Fixed design",
    "",
    "- Protocol: " + result.protocolId,
    "- Denominator: " + result.denominator + " paired authored cases; no exclusions or imputation",
    "- Labels: " + result.labelAuthority,
    "- Assisted replay: " + result.sourceReplay.mode + " / " + result.sourceReplay.modelSeam + " / " + result.sourceReplay.runtime,
    "- Frozen source identity: commit " + result.sourceReplay.sourceIdentity.gitCommit + " / tree " + result.sourceReplay.sourceIdentity.gitTree + "; canonical replay-source closure unchanged and clean",
    "- Raw replay validation: " + result.rawReplayValidation.casesMatchingFrozenRaw + "/" + result.rawReplayValidation.casesReplayed + " cases re-executed through eval/lib.ts runScenario and matched every frozen action/trace field",
    "- Input hashing: SHA-256 over LF-canonical UTF-8 text; CRLF and LF checkouts bind identically, while a lone carriage return fails closed",
    "- Endpoints: modeled active-review seconds, modeled human touches, and developer-policy-label mismatches",
    "- Analysis: descriptive paired summaries only; no inferential statistics",
    "",
    "## Descriptive results",
    "",
    "| Endpoint | Manual checklist model | Autopilot-assisted model | Paired difference (manual − assisted) |",
    "|---|---:|---:|---:|",
    "| Base modeled active-review seconds, total | " + base.manualTotal + " | " + base.assistedTotal + " | " + base.pairedDeltaTotal + " |",
    "| Base modeled active-review seconds, mean/case | " + base.manualMean + " | " + base.assistedMean + " | " + base.pairedMeanDelta + " |",
    "| Base modeled active-review seconds, median/case | " + base.manualMedian + " | " + base.assistedMedian + " | " + base.pairedMedianDelta + " |",
    "| Modeled human touches, total | " + touches.manualTotal + " | " + touches.assistedTotal + " | " + touches.pairedDeltaTotal + " |",
    "| Modeled human touches, mean/case | " + touches.manualMean + " | " + touches.assistedMean + " | " + touches.pairedMeanDelta + " |",
    "| Developer-policy-label mismatches | " + mismatches.manual.count + "/" + mismatches.manual.denominator + " | " + mismatches.assisted.count + "/" + mismatches.assisted.denominator + " | " + mismatches.pairedCountDelta + " |",
    "",
    "Within this task model, the base active-review assumptions are " + base.withinModelReductionPct + "% lower and modeled human checkpoints are " + touches.withinModelReductionPct + "% lower in the assisted arm. Those percentages describe only these authored tasks and weights.",
    "",
    "## Weight sensitivity",
    "",
    "- Adverse declared weights (manual low minus assisted high): " + sensitivity.adverseWeights.pairedDeltaTotal + " seconds total, " + sensitivity.adverseWeights.pairedMeanDelta + " seconds/case; positive on " + sensitivity.adverseWeights.casesWithPositiveDelta + "/" + result.denominator + " cases and at/below zero on " + sensitivity.adverseWeights.casesAtOrBelowZero + "/" + result.denominator + ".",
    "- Favorable declared weights (manual high minus assisted low): " + sensitivity.favorableWeights.pairedDeltaTotal + " seconds total, " + sensitivity.favorableWeights.pairedMeanDelta + " seconds/case.",
    "- These are authored assumption bounds, not confidence intervals and not measured human variability.",
    "",
    "## Per-case raw derivations",
    "",
    "| Case | Category | Expected | Manual action | Assisted action | Base seconds M/A | Touches M/A | Mismatch M/A |",
    "|---|---|---|---|---|---:|---:|---:|",
  ];
  for (const row of result.rows) {
    lines.push(
      "| " + row.caseId +
      " | " + row.category +
      " | " + row.expectedAction +
      " | " + row.actions.manual +
      " | " + row.actions.assisted +
      " | " + row.modeledActiveReviewSeconds.manual.base + "/" + row.modeledActiveReviewSeconds.assisted.base +
      " | " + row.modeledHumanTouches.manual + "/" + row.modeledHumanTouches.assisted +
      " | " + Number(row.actions.manualPolicyLabelMismatch) + "/" + Number(row.actions.assistedPolicyLabelMismatch) + " |",
    );
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    "**Permitted conclusion:** " + result.claimBoundary.permitted,
    "",
    "The equal mismatch counts do not establish error reduction. Because both arms and labels are developer-authored and the set is tuned/synthetic, they establish only self-consistency on this fixed policy fixture.",
    "",
    "**Do not extrapolate:** " + protocol.prohibitedClaims.join("; ") + ".",
    "",
    "Key limitations:",
    "",
    ...protocol.assumptions.map((assumption) => "- " + assumption),
    "",
    "## Reproduce",
    "",
    "From the repository root:",
    "",
    "    npm run impact:check",
    "",
    "To run only the 12-case agent-to-raw action/trace replay comparison:",
    "",
    "    npm run impact:check-raw",
    "",
    "To regenerate derived outputs only after the committed raw/source identity is already valid:",
    "",
    "    npm run impact:write",
    "",
    "After any replay source or protocol change, first commit the complete clean source as commit A, then run:",
    "",
    "    npm run impact:refresh-source",
    "",
    "Review and commit only the refreshed raw/results as the evidence-only descendant commit B. The refresh command refuses a dirty or uncommitted commit A.",
    "",
    "The check revalidates the fixed denominator, exact projection from eval/dataset.ts, task catalogs, raw replay shape, policy boundaries, LF-canonical input hashes, and byte-for-byte generated outputs.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  invariant(
    args.length === 1 && ["--check", "--check-raw", "--write", "--refresh-source"].includes(args[0]),
    "usage: node --import tsx impact/analyze.mjs --check|--check-raw|--write|--refresh-source",
  );
  assertLockedImpactRuntime();
  const mode = args[0];
  const refreshIdentity = mode === "--refresh-source"
    ? captureReplaySourceIdentityAtCleanHead({ repoRoot: ROOT })
    : null;
  assertCommittedReplayEvidenceInputs({ repoRoot: ROOT });
  let rawText = readText(FILES.raw);
  const raw = JSON.parse(rawText);
  if (refreshIdentity) {
    invariant(raw.collection && typeof raw.collection === "object", "raw collection metadata is missing");
    raw.collection.sourceCommit = refreshIdentity.gitCommit;
    raw.collection.sourceIdentity = {
      gitTree: refreshIdentity.gitTree,
      replaySourcePaths: [...refreshIdentity.replaySourcePaths],
    };
    rawText = JSON.stringify(raw, null, 2) + "\n";
  }
  const sourceIdentity = verifyReplaySourceIdentity(raw.collection, { repoRoot: ROOT });
  if (refreshIdentity) {
    invariant(sourceIdentity.gitCommit === refreshIdentity.gitCommit, "refreshed source commit changed before replay");
    invariant(sourceIdentity.gitTree === refreshIdentity.gitTree, "refreshed source tree changed before replay");
  }

  // No replay implementation module is evaluated until the exact runtime,
  // committed raw input, and complete local source closure have passed.
  await loadVerifiedReplayModules();
  const texts = {
    protocol: readText(FILES.protocol),
    cases: readText(FILES.cases),
    raw: rawText,
    analysis: readText(FILES.analysis),
    provenance: readText(FILES.provenance),
    evalDataset: readText(FILES.evalDataset),
    evalLib: readText(FILES.evalLib),
    evalArtifactSafety: readText(FILES.evalArtifactSafety),
    evalPromotionEnvironment: readText(FILES.evalPromotionEnvironment),
    evalProtocolProvenance: readText(FILES.evalProtocolProvenance),
    packageJson: readText(FILES.packageJson),
    packageLock: readText(FILES.packageLock),
    tsconfig: readText(FILES.tsconfig),
  };
  const protocol = JSON.parse(texts.protocol);
  const casesFile = JSON.parse(texts.cases);
  validateInputs(protocol, casesFile, raw, texts.raw);
  const replayValidation = await validateFrozenReplay(protocol, raw);
  if (mode === "--check-raw") {
    console.log(
      "impact-study raw replay: PASS (" +
      replayValidation.casesMatchingFrozenRaw + "/" + replayValidation.casesReplayed +
      " cases; " + replayValidation.comparedFields.length + " action/trace fields matched)",
    );
    return;
  }
  const result = analyze(protocol, casesFile, raw, texts, replayValidation, sourceIdentity);
  const jsonOutput = JSON.stringify(result, null, 2) + "\n";
  const markdownOutput = renderMarkdown(result, protocol);

  if (mode === "--refresh-source") {
    const stableIdentity = captureReplaySourceIdentityAtCleanHead({ repoRoot: ROOT });
    invariant(stableIdentity.gitCommit === sourceIdentity.gitCommit, "HEAD changed during source refresh replay");
    invariant(stableIdentity.gitTree === sourceIdentity.gitTree, "HEAD tree changed during source refresh replay");
    writeFileSync(FILES.raw, texts.raw);
    writeFileSync(FILES.resultsJson, jsonOutput);
    writeFileSync(FILES.resultsMarkdown, markdownOutput);
    console.log(
      "impact-study source refresh: PASS (commit " + sourceIdentity.gitCommit + "; " +
      result.denominator + " fixed synthetic cases)",
    );
    return;
  }

  if (mode === "--write") {
    writeFileSync(FILES.resultsJson, jsonOutput);
    writeFileSync(FILES.resultsMarkdown, markdownOutput);
    console.log("impact-study write: PASS (" + result.denominator + " fixed synthetic cases)");
    return;
  }

  for (const [path, expected] of [
    [FILES.resultsJson, jsonOutput],
    [FILES.resultsMarkdown, markdownOutput],
  ]) {
    invariant(existsSync(path), "generated artifact missing: " + path + "; run npm run impact:write");
    invariant(readFileSync(path, "utf8") === expected, "generated artifact drifted: " + path + "; review inputs and run npm run impact:write");
  }
  console.log("impact-study check: PASS (" + result.denominator + " fixed synthetic cases; outputs byte-identical)");
}

try {
  await main();
} catch (error) {
  console.error("impact-study: FAIL: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
