import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  createExclusiveEvidenceArtifact,
  persistEvidenceArtifact,
  promotionEvidenceArtifactPath,
} from "../../eval/artifact-safety.js";
import { createQwenClient, officialEvidenceEndpoint, officialRuntimeEndpoint, resolveQwenTransportConfig } from "../../src/qwen/client.js";
import {
  meanLatencyOrNull,
  pairedCaseOrder,
  parsePromotionCli,
  promotionGate,
  PROMOTION_MODELS,
  stabilityFingerprint,
} from "../../eval/compare.js";
import { EVAL_SET } from "../../eval/dataset.js";
import { bootstrapConfig } from "../../scripts/bootstrap-db.js";
import {
  assertPinnedPromotionRuntime,
  committedProtocolState,
  PINNED_PROMOTION_RUNTIME,
} from "../../eval/protocol-provenance.js";
import { PromotionEnvironmentError } from "../../eval/promotion-environment.js";
// Keep promotion-environment portability/preflight tests in the standard unit,
// full-test and coverage commands without duplicating the long explicit file list.
import "./promotion-environment.test.js";

const require = createRequire(import.meta.url);
const { resolveRepoContainedPath } = require("../../scripts/repo-path.cjs") as {
  resolveRepoContainedPath(value: string, label?: string, options?: { mustExist?: boolean }): string;
};

test("eval artifacts reduce provider exceptions to a fixed category and allowlisted summary", () => {
  const secret = "api_key=sk-private password=hunter2 C:\\private\\provider.json";
  const result = categoricalEvalError(Object.assign(new Error(`401 Authorization failed: ${secret}`), {
    status: 401,
    stack: `Error: ${secret}\n at provider (C:\\secret\\sdk.ts:9:1)`,
  }));
  assert.deepEqual(result, {
    category: "authentication_failed",
    summary: "upstream authentication failed",
    source: "provider",
    phase: "evaluation",
    httpStatus: 401,
    attemptsObserved: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /sk-private|hunter2|private\\provider|secret\\sdk/i);
});

test("atomic evidence progress preserves parseable authoritative JSON across interrupted temp writes", async () => {
  const dir = resolve(".artifacts", `eval-artifact-atomic-${process.pid}`);
  const path = resolve(dir, "attempt.json");
  await mkdir(dir, { recursive: true });
  try {
    await createExclusiveEvidenceArtifact(path, '{"status":"running","cases":[]}\n');
    // Model the only residue a crash before rename can create: an invalid sibling.
    await writeFile(`${path}.next-interrupted`, '{"status":', "utf8");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { status: "running", cases: [] });
    await persistEvidenceArtifact(path, '{"status":"complete","cases":[1]}\n');
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { status: "complete", cases: [1] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence commands are canonical and contain no absolute checkout path", () => {
  const command = canonicalEvidenceCommand("eval/run.ts", [
    "--online", "--runs", "3", "--write", "eval/results/qwen-plus-attempt-01.json",
  ]);
  assert.equal(command, "node --import tsx eval/run.ts --online --runs 3 --write eval/results/qwen-plus-attempt-01.json");
  assert.doesNotMatch(command, /[A-Z]:\\|private_nebius/i);
  assert.throws(() => canonicalEvidenceCommand("C:\\repo\\eval\\run.ts", []), /repository-relative/);
  assert.throws(() => canonicalEvidenceCommand("eval/run.ts", ["C:\\repo\\result.json"]), /absolute paths/);
});

test("all artifact writers reject traversal, absolute, symlink, and broken-symlink escapes", async () => {
  const repoRoot = resolve(".");
  const dir = resolve(".artifacts", `repo-containment-${process.pid}`);
  const outside = resolve("..");
  const escapeLink = join(dir, "outside-link");
  const brokenLink = join(dir, "broken-link");
  await mkdir(dir, { recursive: true });
  try {
    await symlink(outside, escapeLink, process.platform === "win32" ? "junction" : "dir");

    const safeRelative = relative(repoRoot, join(dir, "safe", "artifact.json"));
    assert.equal(resolveRepoContainedPath(safeRelative, "TEST"), join(dir, "safe", "artifact.json"));
    assert.throws(() => resolveRepoContainedPath("../artifact-escape.json", "TEST"), /inside this repository/);
    assert.throws(() => resolveRepoContainedPath(join(outside, "absolute-escape.json"), "TEST"), /inside this repository/);
    assert.throws(() => resolveRepoContainedPath(join(escapeLink, "symlink-escape.json"), "TEST"), /inside this repository/);

    let brokenLinkCreated = false;
    try {
      await symlink(join(dir, "missing-target"), brokenLink, "file");
      brokenLinkCreated = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
    }
    if (brokenLinkCreated) {
      assert.throws(() => resolveRepoContainedPath(brokenLink, "TEST"), /ENOENT|not found/i);
    }

    const pythonExecutable = process.platform === "win32" ? "python" : "python3";
    for (const malicious of ["../artifact-escape.json", join(outside, "absolute-escape.json"), join(escapeLink, "symlink-escape.json")]) {
      const python = spawnSync(pythonExecutable, ["scripts/path_safety.py", "--label", "TEST", malicious], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.notEqual(python.status, 0, `Python guard unexpectedly accepted ${malicious}`);
      assert.match(python.stderr, /inside this repository/);
    }

    const captureUi = spawnSync(process.execPath, ["scripts/capture_ui.cjs", join(escapeLink, "captures")], {
      cwd: repoRoot,
      env: { ...process.env, AUTOPILOT_URL: "https://example.test" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(captureUi.status, 0);
    assert.match(captureUi.stderr, /capture output must resolve inside this repository/);

    const captureAttack = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/capture-attack.ts", "--out", join(escapeLink, "attack.json")],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 }
    );
    assert.notEqual(captureAttack.status, 0);
    assert.match(captureAttack.stderr, /--out must resolve inside this repository/);

    const [frames, video, ui, attack, demo, offlineDemo] = await Promise.all([
      readFile("scripts/make_frames.py", "utf8"),
      readFile("scripts/build_video.py", "utf8"),
      readFile("scripts/capture_ui.cjs", "utf8"),
      readFile("scripts/capture-attack.ts", "utf8"),
      readFile("demo/capture_demo.sh", "utf8"),
      readFile("scripts/demo-autopilot.ts", "utf8"),
    ]);
    assert.match(frames, /repo_contained_path\(args\.dump_narration/);
    assert.match(frames, /repo_contained_path\(\s*args\.durations/);
    assert.match(frames, /repo_contained_path\(args\.output/);
    assert.match(video, /from path_safety import repo_contained_path/);
    assert.match(ui, /resolveRepoContainedPath/);
    assert.match(attack, /resolveRepoContainedPath/);
    assert.match(demo, /repo-path\.cjs/);
    assert.match(demo, /REVIEWER_TOKEN is required/);
    assert.match(demo, /authorization: Bearer \$REVIEWER_TOKEN/);
    assert.match(demo, /curl -fsS/);
    assert.match(demo, /DEMO_RUN_ID/);
    assert.match(demo, /execution\.ok == true/);
    assert.match(demo, /status.*!= "pending"/);
    assert.match(demo, /draft_journal_entry \|\| exit 1/);
    assert.match(demo, /draft_payment \|\| exit 1/);
    assert.match(demo, /flag_for_review \|\| exit 1/);
    assert.doesNotMatch(demo, /NW-1001/);
    assert.doesNotMatch(offlineDemo, /NW-1001/);
    assert.match(offlineDemo, /Duplicate of PS-1001/);

    const cleanDemoEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !["REVIEWER_TOKEN", "DEMO_RUN_ID"].includes(key.toUpperCase()))
    );
    const noReviewer = spawnSync("bash", ["demo/capture_demo.sh"], {
      cwd: repoRoot,
      env: cleanDemoEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(noReviewer.status, 0);
    assert.match(noReviewer.stderr, /REVIEWER_TOKEN is required/);

    const invalidRunId = spawnSync("bash", [
      "-c",
      'REVIEWER_TOKEN=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr DEMO_RUN_ID="../escape" bash demo/capture_demo.sh',
    ], {
      cwd: repoRoot,
      env: cleanDemoEnv,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(invalidRunId.status, 0);
    assert.match(invalidRunId.stderr, /DEMO_RUN_ID must be/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence creation is exclusive and cannot replace a prior attempt", async () => {
  const dir = resolve(".artifacts", `eval-artifact-safety-${process.pid}`);
  const path = resolve(dir, "attempt.json");
  await mkdir(dir, { recursive: true });
  try {
    await createExclusiveEvidenceArtifact(path, "first\n");
    await assert.rejects(createExclusiveEvidenceArtifact(path, "replacement\n"), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), "first\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keyed evidence accepts only attested official Model Studio endpoints", () => {
  assert.deepEqual(officialEvidenceEndpoint("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/"), {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    region: "international",
  });
  assert.deepEqual(officialEvidenceEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"), {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    region: "china-beijing",
  });
  assert.throws(() => officialEvidenceEndpoint("https://proxy.example.test/v1"), /official Alibaba Model Studio/);
  assert.throws(() => officialEvidenceEndpoint("https://user:secret@dashscope-intl.aliyuncs.com/compatible-mode/v1"), /credential-free/);
  assert.deepEqual(
    officialRuntimeEndpoint("https://llm-example123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/"),
    {
      baseUrl: "https://llm-example123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      region: "ap-southeast-1",
      access: "workspace-dedicated",
    }
  );
  for (const endpoint of [
    "https://trial.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://coding-intl.dashscope.aliyuncs.com/v1",
    "https://proxy.example.test/v1",
  ]) {
    assert.throws(() => officialRuntimeEndpoint(endpoint), /official pay-as-you-go Alibaba Model Studio/);
  }
  for (const endpoint of [
    "https://llm-example-.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    `https://llm-${"a".repeat(60)}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`,
    "https://user:secret@llm-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://llm-example.ap-southeast-1.maas.aliyuncs.com:444/compatible-mode/v1",
    "https://llm-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat",
    "https://llm-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1?proxy=1",
  ]) {
    assert.throws(() => officialRuntimeEndpoint(endpoint));
  }
  for (const endpoint of [
    " https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1 ",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1?",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1#",
  ]) {
    assert.throws(() => officialRuntimeEndpoint(endpoint), /credential-free HTTPS/);
    assert.throws(() => officialEvidenceEndpoint(endpoint), /credential-free HTTPS/);
  }
  const prior = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => createQwenClient("test-key", "https://proxy.example.test/v1"), /official .*Alibaba Model Studio/);
    assert.doesNotThrow(() => createQwenClient("test-key", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/"));
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});

test("counterbalanced promotion gate passes non-inferiority and rejects a per-run regression", () => {
  const decision = {
    status: "complete",
    metrics: {
      rawTerminalAgreement: 1,
      proposalContractSanity: 1,
      reviewerEnrichedExecution: 1,
      meanLatencyMsIncludingSeedSetup: 1_000,
    },
    policyOverrideSources: [],
    cases: EVAL_SET.map((item) => ({ id: item.id, status: "ok", rawModelTerminalTool: item.expected })),
  };
  const vision = {
    status: "complete",
    metrics: {
      normalizedStringAccuracy: 1,
      numericAccuracy: 1,
      safeReviewRecall: 1,
      safeReviewSpecificity: 1,
      safeReviewBalancedAccuracy: 1,
      containmentRecall: 1,
      unsafeAutoClear: 0,
      meanLatencyMs: 1_000,
    },
    cases: Array.from({ length: 16 }, (_, index) => ({
      id: `v${String(index + 1).padStart(2, "0")}`,
      status: "ok",
      normalizedMisses: [],
      safeReviewPredicted: false,
    })),
  };
  const runs = ["AB", "BA", "BA", "AB"].map((order, index) => ({
    run: index + 1,
    order,
    arms: {
      baseline: { decision: structuredClone(decision), vision: structuredClone(vision) },
      candidate: { decision: structuredClone(decision), vision: structuredClone(vision) },
    },
  }));
  assert.equal(promotionGate(runs).pass, true);
  const slowCandidate = structuredClone(runs);
  slowCandidate[0]!.arms.candidate.decision.metrics.meanLatencyMsIncludingSeedSetup = 1_501;
  slowCandidate[0]!.arms.candidate.vision.metrics.meanLatencyMs = 30_001;
  const latencyGate = promotionGate(slowCandidate);
  assert.equal(latencyGate.pass, false);
  assert.ok(latencyGate.failures.some((reason) => /decision latency regressed beyond/.test(reason)));
  assert.ok(latencyGate.failures.some((reason) => /vision latency ceiling failed/.test(reason)));

  const missingMetric = structuredClone(runs);
  (missingMetric[0]!.arms.candidate.vision.metrics as Record<string, unknown>).containmentRecall = undefined;
  assert.equal(promotionGate(missingMetric).pass, false);
  assert.ok(promotionGate(missingMetric).failures.some((reason) => /missing or invalid required metric/.test(reason)));
  runs[1]!.arms.candidate.decision.metrics.rawTerminalAgreement = 0.9;
  const failed = promotionGate(runs);
  assert.equal(failed.pass, false);
  assert.ok(failed.failures.some((reason) => /decision agreement regressed/.test(reason)));
  runs[1]!.arms.candidate.decision.metrics.rawTerminalAgreement = 1;
  runs[1]!.arms.candidate.vision.metrics.safeReviewSpecificity = 0;
  runs[1]!.arms.candidate.vision.metrics.safeReviewBalancedAccuracy = 0.5;
  const unsafeReviewGate = promotionGate(runs);
  assert.equal(unsafeReviewGate.pass, false);
  assert.ok(unsafeReviewGate.failures.some((reason) => /specificity regressed/.test(reason)));
  assert.ok(unsafeReviewGate.failures.some((reason) => /specificity floor failed/.test(reason)));
  assert.ok(unsafeReviewGate.failures.some((reason) => /balanced accuracy regressed/.test(reason)));
  assert.ok(unsafeReviewGate.failures.some((reason) => /balanced-accuracy floor failed/.test(reason)));

  runs[1]!.arms.candidate.vision.metrics.safeReviewSpecificity = 1;
  runs[1]!.arms.candidate.vision.metrics.safeReviewBalancedAccuracy = 1;
  runs[1]!.arms.candidate.vision.metrics.containmentRecall = 0;
  runs[1]!.arms.candidate.vision.metrics.unsafeAutoClear = 1;
  const unsafeExtraction = promotionGate(runs);
  assert.equal(unsafeExtraction.pass, false);
  assert.ok(unsafeExtraction.failures.some((reason) => /unsafe-extraction auto-clear gate failed/.test(reason)));

  const weakButEqual = structuredClone(runs);
  for (const run of weakButEqual) {
    for (const arm of [run.arms.baseline, run.arms.candidate]) {
      arm.decision.metrics.rawTerminalAgreement = 0.5;
      arm.vision.metrics.normalizedStringAccuracy = 0.9;
      arm.vision.metrics.numericAccuracy = 0.9;
    }
  }
  const weak = promotionGate(weakButEqual);
  assert.equal(weak.pass, false, "two equally weak arms cannot pass relative non-inferiority");
  assert.ok(weak.failures.some((reason) => /absolute agreement floor/.test(reason)));
  assert.ok(weak.failures.some((reason) => /absolute floor/.test(reason)));

  const incomplete = structuredClone(weakButEqual);
  incomplete[0]!.arms.candidate.decision.status = "incomplete";
  const exhaustive = promotionGate(incomplete);
  assert.ok(exhaustive.failures.some((reason) => /both arms must be complete/.test(reason)));
  assert.ok(
    exhaustive.failures.some((reason) => /candidate decision absolute agreement floor failed/.test(reason)),
    "an incomplete arm must not suppress its independently computable floor failures"
  );
  assert.ok(
    exhaustive.failures.some((reason) => /candidate normalized vision absolute floor failed/.test(reason)),
    "gate diagnostics must remain exhaustive after a completeness failure"
  );

  const malformed = promotionGate([{}]);
  assert.equal(malformed.pass, false);
  assert.ok(malformed.failures.some((reason) => /exactly four paired runs/.test(reason)));
  assert.ok(malformed.failures.some((reason) => /both arms must be complete/.test(reason)));
  assert.ok(malformed.failures.some((reason) => /candidate decision latency ceiling failed/.test(reason)));
});

test("evaluation connection refusals retain fixed provider/phase forensics without raw diagnostics", () => {
  const result = categoricalEvalError(
    Object.assign(new Error("connect ECONNREFUSED C:\\private\\socket"), { code: "ECONNREFUSED" }),
    "decision"
  );
  assert.deepEqual(result, {
    category: "provider_unavailable",
    summary: "the upstream provider is unavailable",
    source: "provider",
    phase: "decision",
    sdkCode: "ECONNREFUSED",
    attemptsObserved: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /private|socket/i);

  const timeout = categoricalEvalError(
    Object.assign(new Error("ETIMEDOUT https://secret.example/key=private"), { code: "ETIMEDOUT" }),
    "vision"
  );
  assert.deepEqual(timeout, {
    category: "timeout",
    summary: "the operation timed out",
    source: "provider",
    phase: "vision",
    sdkCode: "ETIMEDOUT",
    attemptsObserved: null,
  });
  assert.doesNotMatch(JSON.stringify(timeout), /secret|private/i);

  const dns = categoricalEvalError(Object.assign(new Error("private host"), { code: "EAI_AGAIN" }), "vision");
  assert.equal(dns.category, "provider_unavailable");
  assert.equal(dns.summary, "the upstream provider is unavailable");
  assert.equal(dns.source, "provider");
  assert.doesNotMatch(JSON.stringify(dns), /private host/i);
});

test("latency summaries never fabricate zero for an empty conclusive subset", () => {
  assert.equal(meanLatencyOrNull([]), null);
  assert.equal(meanLatencyOrNull([125, Number.NaN]), null);
  assert.equal(meanLatencyOrNull([-1]), null);
  assert.equal(meanLatencyOrNull([125, 375]), 250);
});

test("stability fingerprints include guarded arguments, actual fields, and review reasons", () => {
  const decision = {
    status: "ok", rawModelTerminalTool: "draft_payment", finalGuardedProposal: "draft_payment",
    finalGuardedArgs: { amount: 10, currency: "EUR" }, proposalContractSane: true,
    reviewerEnrichedExecutionVerified: true, policyOverride: false, fallback: false,
  };
  assert.notEqual(
    stabilityFingerprint("decision", decision),
    stabilityFingerprint("decision", { ...decision, finalGuardedArgs: { amount: 11, currency: "EUR" } })
  );
  const vision = {
    status: "ok", fields: { total: { actual: 10, expected: 10 } }, normalizedMisses: [],
    safeReviewPredicted: false, safeReviewReasons: [], sourceFieldUncertainty: [], structuralFailures: [],
  };
  assert.notEqual(
    stabilityFingerprint("vision", vision),
    stabilityFingerprint("vision", { ...vision, fields: { total: { actual: 11, expected: 10 } } })
  );
  assert.notEqual(
    stabilityFingerprint("vision", vision),
    stabilityFingerprint("vision", { ...vision, safeReviewReasons: ["source_missing:confidence"] })
  );
});

test("paired comparison interleaves every case and balances first-call exposure within each surface", () => {
  for (const startingOrder of [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
  ] as const) {
    for (const cases of [22, 16]) {
      const first = Array.from({ length: cases }, (_, index) => pairedCaseOrder(startingOrder, index)[0]);
      assert.equal(first.filter((arm) => arm === "baseline").length, cases / 2);
      assert.equal(first.filter((arm) => arm === "candidate").length, cases / 2);
    }
  }
  const starts = [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
    ["candidate", "baseline"],
    ["baseline", "candidate"],
  ] as const;
  for (const caseIndex of [0, 1, 15, 21]) {
    const first = starts.map((start) => pairedCaseOrder(start, caseIndex)[0]);
    assert.equal(first.filter((arm) => arm === "baseline").length, 2);
    assert.equal(first.filter((arm) => arm === "candidate").length, 2);
  }
});

test("comparison CLI accepts only the preregistered distinct four-run model experiment", () => {
  const exact = [
    "--online", "--runs", "4",
    "--baseline-decision", PROMOTION_MODELS.baselineDecision,
    "--baseline-vision", PROMOTION_MODELS.baselineVision,
    "--candidate", PROMOTION_MODELS.candidate,
    "--write", "eval/results/model-promotion-ab-attempt-02.json",
  ];
  assert.deepEqual(parsePromotionCli(exact), {
    ...PROMOTION_MODELS,
    write: "eval/results/model-promotion-ab-attempt-02.json",
  });
  for (const invalid of [
    exact.map((value) => value === PROMOTION_MODELS.candidate ? PROMOTION_MODELS.baselineDecision : value),
    [...exact, "--runs", "4"],
    [...exact, "--unknown"],
    exact.map((value) => value === "eval/results/model-promotion-ab-attempt-02.json"
      ? "eval/results/model-promotion-ab-attempt-2.json"
      : value),
    exact.map((value) => value === "eval/results/model-promotion-ab-attempt-02.json"
      ? "eval/results/renamed-attempt-02.json"
      : value),
  ]) {
    assert.throws(
      () => parsePromotionCli(invalid),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_arguments_invalid"
    );
  }
});

test("promotion artifact paths require a fresh attempt-qualified file in the real results directory", async () => {
  const policy = { prefix: "model-promotion-ab", minAttempt: 2, maxAttempt: 99 };
  const valid = await promotionEvidenceArtifactPath(
    "eval/results/model-promotion-ab-attempt-02.json",
    process.cwd(),
    policy
  );
  assert.equal(valid, resolve("eval/results/model-promotion-ab-attempt-02.json"));
  await assert.rejects(
    promotionEvidenceArtifactPath(".artifacts/model-promotion-ab-attempt-99.json"),
    (error: unknown) => error instanceof PromotionEnvironmentError
      && error.code === "promotion_artifact_invalid"
  );
  await assert.rejects(
    promotionEvidenceArtifactPath("eval/results/not-qualified.json"),
    (error: unknown) => error instanceof PromotionEnvironmentError
      && error.code === "promotion_artifact_invalid"
  );
  await assert.rejects(
    promotionEvidenceArtifactPath("eval/results/model-promotion-ab-attempt-01.json"),
    (error: unknown) => error instanceof PromotionEnvironmentError
      && error.code === "promotion_artifact_exists"
  );
  for (const invalid of [
    "eval/results/model-promotion-ab-attempt-00.json",
    "eval/results/model-promotion-ab-attempt-03.json",
    "eval/results/model-promotion-ab-attempt-99.json",
    "eval/results/model-promotion-ab-attempt-100.json",
    "eval/results/model-promotion-ab-attempt-001.json",
    "eval/results/renamed-attempt-02.json",
  ]) {
    await assert.rejects(
      promotionEvidenceArtifactPath(invalid, process.cwd(), policy),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_artifact_invalid"
    );
  }
});

test("keyed evidence runtime is exact and the recorded command uses the locked tsx loader", async () => {
  assert.deepEqual(PINNED_PROMOTION_RUNTIME, {
    node: "v24.18.0",
    packageManagerManifest: "npm@11.16.0",
    tsx: "4.23.0",
    invocation: "node --import tsx",
  });
  await assert.doesNotReject(assertPinnedPromotionRuntime());
});

test("Qwen transport environment overrides remain bounded canonical integers", () => {
  assert.deepEqual(resolveQwenTransportConfig({}), { timeoutMs: 20_000, maxRetries: 2 });
  assert.deepEqual(
    resolveQwenTransportConfig({ QWEN_TIMEOUT_MS: "NaN", QWEN_MAX_RETRIES: "-9.8" }),
    { timeoutMs: 20_000, maxRetries: 0 }
  );
  assert.deepEqual(
    resolveQwenTransportConfig({ QWEN_TIMEOUT_MS: "999999", QWEN_MAX_RETRIES: "3.9" }),
    { timeoutMs: 120_000, maxRetries: 3 }
  );
});

test("committed protocol fingerprint is checkout-EOL independent and dirtiness still fails closed", async () => {
  const dir = resolve(".artifacts", `protocol-fingerprint-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.email", "protocol-test@example.invalid"]).status, 0);
    assert.equal(git(["config", "user.name", "Protocol Test"]).status, 0);
    assert.equal(git(["config", "core.autocrlf", "false"]).status, 0);
    await writeFile(join(dir, "protocol.ts"), "export const value = 1;\n", "utf8");
    assert.equal(git(["add", "protocol.ts"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "protocol fixture"]).status, 0);
    const lf = await committedProtocolState(["protocol.ts"], { cwd: dir, strict: true });
    await writeFile(join(dir, "protocol.ts"), "export const value = 1;\r\n", "utf8");
    const crlf = await committedProtocolState(["protocol.ts"], { cwd: dir });
    assert.equal(crlf.protocolSha256, lf.protocolSha256);
    assert.equal(crlf.protocolTreeClean, false);
    await assert.rejects(
      committedProtocolState(["protocol.ts"], { cwd: dir, strict: true }),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_tree_invalid"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only byte-exact attempts registered in the committed evidence ledger may remain untracked", async () => {
  const dir = resolve(".artifacts", `evidence-ledger-${process.pid}`);
  const resultPath = "eval/results/diagnostic-attempt-01.json";
  const bytes = Buffer.from('{"status":"incomplete"}\n', "utf8");
  await mkdir(join(dir, "eval", "results"), { recursive: true });
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.email", "ledger-test@example.invalid"]).status, 0);
    assert.equal(git(["config", "user.name", "Ledger Test"]).status, 0);
    await writeFile(join(dir, "protocol.ts"), "export const protocol = 1;\n", "utf8");
    await writeFile(join(dir, "eval", "results", "evidence-ledger.json"), JSON.stringify({
      schemaVersion: 1,
      attempts: [{
        path: resultPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceCommit: "1".repeat(40),
        status: "incomplete",
        classification: "environment-invalid-diagnostic",
      }],
    }));
    assert.equal(git(["add", "protocol.ts", "eval/results/evidence-ledger.json"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "ledger fixture"]).status, 0);
    await writeFile(join(dir, resultPath), bytes);
    const registered = await committedProtocolState(
      ["protocol.ts", "eval/results/evidence-ledger.json"],
      { cwd: dir, strict: true, allowResultArtifacts: true }
    );
    assert.equal(registered.protocolTreeClean, true);
    assert.deepEqual(registered.allowedDirtyResultArtifacts, [{ status: "??", path: resultPath }]);
    assert.equal(registered.evidenceLedger[0]?.sha256, createHash("sha256").update(bytes).digest("hex"));
    await writeFile(join(dir, resultPath), '{"status":"reclassified"}\n', "utf8");
    await assert.rejects(
      committedProtocolState(
        ["protocol.ts", "eval/results/evidence-ledger.json"],
        { cwd: dir, strict: true, allowResultArtifacts: true }
      ),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_tree_invalid"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("database bootstrap accepts only the dedicated autopilot runtime identity and separated admin DSN", () => {
  const password = "a".repeat(40);
  assert.deepEqual(bootstrapConfig({
    MIGRATION_DATABASE_URL: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
  }), {
    migrationUrl: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    runtimeUrl: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    appPassword: password,
    otherDatabase: "memoryagent",
  });
  assert.throws(() => bootstrapConfig({
    MIGRATION_DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/postgres`,
    DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
  }), /bootstrap\/admin role/);
  assert.throws(() => bootstrapConfig({
    MIGRATION_DATABASE_URL: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    DATABASE_URL: `postgresql://memoryagent_app:${password}@db:5432/memoryagent`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
  }), /role autopilot_app and database autopilot/);
});
