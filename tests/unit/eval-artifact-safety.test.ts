import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  cleanupPromotionEvidenceStagingRemnants,
  createExclusiveEvidenceArtifact,
  persistEvidenceArtifact,
  probeEvidencePublicationDirectory,
  promotionEvidenceArtifactPath,
} from "../../eval/artifact-safety.js";
import { createQwenClient, officialEvidenceEndpoint, officialRuntimeEndpoint, resolveQwenTransportConfig } from "../../src/qwen/client.js";
import {
  assertPromotionCredential,
  assertPromotionRootStatusForPersistence,
  comparePromotionReleaseSnapshots,
  meanLatencyOrNull,
  pairedCaseOrder,
  parsePromotionCli,
  PROMOTION_ARTIFACT_POLICY,
  PROMOTION_PROGRESS_ROOT_STATUS,
  promotionGate,
  PROMOTION_MODELS,
  scheduledExperimentComplete,
  stabilityFingerprint,
  summarizeDecision,
  summarizeVision,
  terminalPromotionArtifactStatus,
} from "../../eval/compare.js";
import { parsePromotionRecoveryCli, recoverPromotionAttempt } from "../../eval/promotion-recovery.js";
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

test("promotion progress root is always ledger-acceptable and terminal publication needs explicit finalization", () => {
  assert.equal(PROMOTION_PROGRESS_ROOT_STATUS, "incomplete");
  assert.doesNotThrow(() => assertPromotionRootStatusForPersistence("incomplete"));
  for (const forbidden of ["running", "complete", "promotion-pass", "promotion-fail", null]) {
    assert.throws(
      () => assertPromotionRootStatusForPersistence(forbidden),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_artifact_invalid"
    );
  }
  assert.doesNotThrow(() => assertPromotionRootStatusForPersistence("promotion-pass", true));
  assert.doesNotThrow(() => assertPromotionRootStatusForPersistence("promotion-fail", true));
});

test("hard-interrupted promotion progress remains immutable, ledgerable, and advances to the next attempt", async () => {
  const dir = resolve(".artifacts", `promotion-interruption-ledger-${process.pid}`);
  const results = join(dir, "eval", "results");
  const attempt01Path = "eval/results/model-promotion-ab-attempt-01.json";
  const attempt02Path = "eval/results/model-promotion-ab-attempt-02.json";
  const attempt03Path = "eval/results/model-promotion-ab-attempt-03.json";
  const attempt02 = join(dir, attempt02Path);
  const fixedUuid = "11111111-2222-4333-8444-555555555555";
  const orphanInitial = `${attempt02}.initial-123-${fixedUuid}`;
  const orphanNext = `${attempt02}.next-456-${fixedUuid}`;
  const probeTarget = join(results, `.promotion-publication-probe-321-${fixedUuid}`);
  const probeStage = `${probeTarget}.initial-654-${fixedUuid}`;
  const unrelated = `${attempt02}.next-interrupted`;
  await mkdir(results, { recursive: true });
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.email", "interruption-test@example.invalid"]).status, 0);
    assert.equal(git(["config", "user.name", "Interruption Test"]).status, 0);
    assert.equal(git(["config", "core.autocrlf", "false"]).status, 0);
    await writeFile(join(dir, "protocol.ts"), "export const protocol = 1;\n", "utf8");
    assert.equal(git(["add", "protocol.ts"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "source release"]).status, 0);
    const firstSource = git(["rev-parse", "HEAD"]).stdout.trim();
    const attempt01Bytes = Buffer.from(JSON.stringify({
      status: "incomplete",
      provenance: { gitCommit: firstSource },
      promotion: { pass: false },
    }, null, 2) + "\n");
    await writeFile(join(dir, attempt01Path), attempt01Bytes);
    await writeFile(join(results, "evidence-ledger.json"), JSON.stringify({
      schemaVersion: 1,
      attempts: [{
        path: attempt01Path,
        sha256: createHash("sha256").update(attempt01Bytes).digest("hex"),
        sourceCommit: firstSource,
        status: "incomplete",
        classification: "environment-invalid-diagnostic",
      }],
    }, null, 2) + "\n");
    assert.equal(git(["add", attempt01Path, "eval/results/evidence-ledger.json"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "register first attempt"]).status, 0);
    const secondSource = git(["rev-parse", "HEAD"]).stdout.trim();

    const progress = {
      schemaVersion: 2,
      status: PROMOTION_PROGRESS_ROOT_STATUS,
      provenance: { gitCommit: secondSource },
      runs: [{
        run: 1,
        status: "running",
        arms: { baseline: { decision: { status: "running", cases: [] }, vision: { status: "pending", cases: [] } } },
      }],
    };
    await createExclusiveEvidenceArtifact(attempt02, `${JSON.stringify(progress, null, 2)}\n`);
    progress.runs[0]!.arms.baseline.decision.cases.push({ id: "d01", status: "ok" } as never);
    await persistEvidenceArtifact(attempt02, `${JSON.stringify(progress, null, 2)}\n`);
    const frozenBytes = await readFile(attempt02);
    await writeFile(orphanInitial, "non-authoritative initial stage\n", "utf8");
    await writeFile(orphanNext, '{"status":', "utf8");
    await writeFile(probeTarget, "non-authoritative publication probe\n", "utf8");
    await writeFile(probeStage, "non-authoritative publication probe stage\n", "utf8");
    await writeFile(unrelated, "must remain\n", "utf8");

    const recovery = await recoverPromotionAttempt(attempt02Path, dir);
    assert.equal(recovery.providerCalls, 0);
    assert.equal(recovery.artifact.authoritative, "present-unregistered");
    assert.equal(recovery.artifact.rootStatus, "incomplete");
    assert.equal(recovery.recovery.sameAttemptReusable, false);
    assert.equal(recovery.recovery.requiredAction, "register-immutable-artifact-before-next-attempt");
    assert.equal(recovery.recovery.nextAttemptPath, attempt03Path);
    assert.deepEqual(recovery.staging.removed, [
      relative(dir, orphanInitial).replace(/\\/g, "/"),
      relative(dir, orphanNext).replace(/\\/g, "/"),
      relative(dir, probeTarget).replace(/\\/g, "/"),
      relative(dir, probeStage).replace(/\\/g, "/"),
    ].sort());
    assert.ok((await readFile(attempt02)).equals(frozenBytes), "recovery must not alter authoritative bytes");
    assert.equal(await readFile(unrelated, "utf8"), "must remain\n");

    const ledgerPath = join(results, "evidence-ledger.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.attempts.push({
      path: attempt02Path,
      sha256: createHash("sha256").update(frozenBytes).digest("hex"),
      sourceCommit: secondSource,
      status: "incomplete",
      classification: "model-promotion-evidence",
    });
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
    assert.equal(git(["add", attempt02Path, "eval/results/evidence-ledger.json"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "register interrupted attempt"]).status, 0);

    await assert.rejects(
      promotionEvidenceArtifactPath(attempt02Path, dir, PROMOTION_ARTIFACT_POLICY),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_artifact_exists"
    );
    assert.equal(
      await promotionEvidenceArtifactPath(attempt03Path, dir, PROMOTION_ARTIFACT_POLICY),
      join(dir, attempt03Path)
    );
    const registeredRecovery = await recoverPromotionAttempt(attempt02Path, dir);
    assert.equal(registeredRecovery.artifact.authoritative, "present-registered");
    assert.equal(registeredRecovery.recovery.requiredAction, "use-next-attempt");
    assert.equal(registeredRecovery.recovery.nextAttemptPath, attempt03Path);

    const strandedPriorStage = `${attempt02}.next-789-${fixedUuid}`;
    await writeFile(strandedPriorStage, "old non-authoritative stage\n", "utf8");
    const nextRecovery = await recoverPromotionAttempt(attempt03Path, dir);
    assert.equal(nextRecovery.artifact.authoritative, "absent");
    assert.equal(nextRecovery.recovery.sameAttemptReusable, true);
    assert.deepEqual(nextRecovery.staging.removed, [relative(dir, strandedPriorStage).replace(/\\/g, "/")]);
    await assert.rejects(access(strandedPriorStage), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promotion recovery CLI and staging cleanup reject broad or escaped deletion targets", async () => {
  assert.equal(parsePromotionRecoveryCli(["--write", "eval/results/model-promotion-ab-attempt-02.json"]),
    "eval/results/model-promotion-ab-attempt-02.json");
  for (const argv of [[], ["--write", "../attempt-02.json"], ["--write", "eval/results/model-promotion-ab-attempt-01.json"], ["--write", "eval/results/model-promotion-ab-attempt-02.json", "--force"]]) {
    assert.throws(() => parsePromotionRecoveryCli(argv), PromotionEnvironmentError);
  }
  await assert.rejects(
    cleanupPromotionEvidenceStagingRemnants("../model-promotion-ab-attempt-02.json"),
    (error: unknown) => error instanceof PromotionEnvironmentError
      && error.code === "promotion_artifact_invalid"
  );
});

test("initial evidence publication exposes only complete bytes and cleans interrupted stages", async () => {
  const dir = resolve(".artifacts", `eval-artifact-initial-${process.pid}`);
  const path = resolve(dir, "attempt.json");
  await mkdir(dir, { recursive: true });
  try {
    await assert.rejects(
      createExclusiveEvidenceArtifact(path, '{"status":"running"}\n', {
        beforePublish: async (staged) => {
          await assert.rejects(access(path), { code: "ENOENT" });
          assert.equal(await readFile(staged, "utf8"), '{"status":"running"}\n');
          throw new Error("simulated pre-publication interruption");
        },
      }),
      /simulated pre-publication interruption/
    );
    await assert.rejects(access(path), { code: "ENOENT" });
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".initial-")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("successful initial evidence publication exposes exactly the complete staged bytes", async () => {
  const dir = resolve(".artifacts", `eval-artifact-success-${process.pid}`);
  const path = resolve(dir, "attempt.json");
  await mkdir(dir, { recursive: true });
  try {
    await createExclusiveEvidenceArtifact(path, '{"status":"complete"}\n', {
      beforePublish: async (staged) => {
        assert.equal(await readFile(staged, "utf8"), '{"status":"complete"}\n');
      },
    });
    assert.equal(await readFile(path, "utf8"), '{"status":"complete"}\n');
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".initial-")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hard-link publication is race-safe, probes the real filesystem, and never replaces an existing target", async () => {
  const dir = resolve(".artifacts", `eval-artifact-race-${process.pid}`);
  const path = resolve(dir, "attempt.json");
  await mkdir(dir, { recursive: true });
  try {
    const settled = await Promise.allSettled([
      createExclusiveEvidenceArtifact(path, "writer-a\n"),
      createExclusiveEvidenceArtifact(path, "writer-b\n"),
    ]);
    assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    assert.equal((rejected?.reason as NodeJS.ErrnoException).code, "EEXIST");
    assert.ok(["writer-a\n", "writer-b\n"].includes(await readFile(path, "utf8")));
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".initial-")), []);
    await assert.rejects(createExclusiveEvidenceArtifact(path, "replacement\n"), { code: "EEXIST" });
    assert.ok(["writer-a\n", "writer-b\n"].includes(await readFile(path, "utf8")));

    const probe = await probeEvidencePublicationDirectory(dir);
    assert.deepEqual(probe, { hardLinkPublication: "passed", directorySync: "passed", cleanup: "passed" });
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes("publication-probe")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed progress replacement preserves the authoritative target and removes next siblings", async () => {
  const dir = resolve(".artifacts", `eval-artifact-persist-failure-${process.pid}`);
  const targetDirectory = resolve(dir, "authoritative.json");
  await mkdir(targetDirectory, { recursive: true });
  try {
    await writeFile(resolve(targetDirectory, "sentinel"), "unchanged\n", "utf8");
    await assert.rejects(persistEvidenceArtifact(targetDirectory, '{"replacement":true}\n'));
    assert.equal(await readFile(resolve(targetDirectory, "sentinel"), "utf8"), "unchanged\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.includes(".next-")), []);
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
    assert.match(video, /caption_only = strict_env_flag\("CAPTION_ONLY"\)/);
    assert.match(video, /CAPTION_ONLY_BEATS\s*=\s*\([\s\S]*"01-stakes"[\s\S]*"09-close"/);
    assert.match(
      video,
      /if caption_only:[\s\S]{0,500}caption_only_timing\(beats\)[\s\S]{0,500}build_caption_only_silence/,
      "caption-only mode must choose fixed timings and local silence",
    );
    assert.match(
      video,
      /if caption_only:[\s\S]{0,900}else:\s+engine, seg_mp3s = synth_all/,
      "TTS synthesis must remain exclusively in the narrated branch",
    );
    assert.match(video, /anullsrc=channel_layout=stereo:sample_rate=48000/);
    assert.match(video, /"tts": False/);
    assert.match(video, /"third_party_music": False/);
    assert.match(video, /verify_caption_only_media\(render_output, total\)/);
    assert.match(video, /publish_exclusive\(\[/);
    assert.match(video, /refusing to overwrite existing final artifact/);
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
    // Windows resolves `bash` through the WSL launcher in this environment. A cold
    // distro startup can exceed ten seconds before the script reaches its first
    // guard, so give the process enough startup headroom without masking hangs.
    const bashGuardTimeoutMs = process.platform === "win32" ? 30_000 : 10_000;
    const noReviewer = spawnSync("bash", ["demo/capture_demo.sh"], {
      cwd: repoRoot,
      env: cleanDemoEnv,
      encoding: "utf8",
      timeout: bashGuardTimeoutMs,
    });
    assert.equal(noReviewer.error, undefined, `bash token-guard probe failed to run: ${noReviewer.error?.message}`);
    assert.notEqual(noReviewer.status, 0);
    assert.match(noReviewer.stderr, /REVIEWER_TOKEN is required/);

    const invalidRunId = spawnSync("bash", [
      "-c",
      'REVIEWER_TOKEN=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr DEMO_RUN_ID="../escape" bash demo/capture_demo.sh',
    ], {
      cwd: repoRoot,
      env: cleanDemoEnv,
      encoding: "utf8",
      timeout: bashGuardTimeoutMs,
    });
    assert.equal(invalidRunId.error, undefined, `bash run-id guard probe failed to run: ${invalidRunId.error?.message}`);
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

test("promotion separates technical non-inferiority from a preregistered material win and recomputes every aggregate", () => {
  const reviewIds = new Set(["v09", "v10", "v11", "v16"]);
  const decisionCases = (options: { finalMiss?: boolean; overrides?: number; latency?: number; errors?: boolean } = {}) =>
    EVAL_SET.map((item, index) => options.errors ? {
      id: item.id, status: "error", expected: item.expected,
      latencyMsIncludingSeedSetup: options.latency ?? 1_000,
      error: { category: "provider_unavailable" },
    } : {
      id: item.id, status: "ok", expected: item.expected,
      rawModelTerminalTool: item.expected, rawModelAgreesWithLabel: true,
      finalGuardedProposal: options.finalMiss && index === 0 ? "flag_for_review" : item.expected,
      finalGuardedAgreesWithLabel: !(options.finalMiss && index === 0),
      finalGuardedArgs: {}, proposalContractSane: true, rawProposalArgsExecutable: true,
      reviewerEnrichedExecutionVerified: true,
      policyOverride: index < (options.overrides ?? 0),
      policyOverrideSource: index < (options.overrides ?? 0) ? "proposal_policy_guard" : null,
      argumentGuardApplied: false, fallback: false,
      latencyMsIncludingSeedSetup: options.latency ?? 1_000,
    });
  const visionCases = (latency = 1_000) => Array.from({ length: 16 }, (_, index) => {
    const id = `v${String(index + 1).padStart(2, "0")}`;
    const expected = reviewIds.has(id);
    return {
      id, status: "ok", safeReviewExpected: expected, safeReviewPredicted: expected,
      normalizedStringCorrect: 5, numericCorrect: 3, unsafeExtraction: false,
      unsafeAutoClear: false, normalizedMisses: [], latencyMs: latency,
    };
  });
  const arm = (decision: Array<Record<string, unknown>>, vision: Array<Record<string, unknown>>) => ({
    decision: summarizeDecision(decision),
    vision: summarizeVision(vision),
  });
  const passingRuns = ["AB", "BA", "BA", "AB"].map((order, index) => ({
    run: index + 1,
    order,
    arms: {
      baseline: arm(decisionCases({ finalMiss: true }), visionCases()),
      candidate: arm(decisionCases(), visionCases()),
    },
  }));
  const passing = promotionGate(passingRuns);
  assert.equal(passing.pass, true);
  assert.equal(passing.technicalNonInferiority.pass, true);
  assert.equal(passing.materialBenefit.route, "aggregate-quality-gain");
  assert.equal(passing.materialBenefit.observed.aggregateCorrectFieldGain, 4);

  const tied = structuredClone(passingRuns);
  for (const run of tied) run.arms.baseline = structuredClone(run.arms.candidate);
  const noBenefit = promotionGate(tied);
  assert.equal(noBenefit.technicalNonInferiority.pass, true);
  assert.equal(noBenefit.materialBenefit.pass, false);
  assert.equal(noBenefit.pass, false, "a quality/latency tie is not a promotion win");

  const forged = structuredClone(passingRuns);
  forged[0]!.arms.candidate.decision.metrics.finalGuardedAgreement = 0;
  const forgedGate = promotionGate(forged);
  assert.equal(forgedGate.pass, false);
  assert.ok(forgedGate.failures.some((reason) => /aggregates do not recompute/.test(reason)));

  const rawCorrectFinalWrong = structuredClone(passingRuns);
  rawCorrectFinalWrong[0]!.arms.candidate = arm(decisionCases({ finalMiss: true }), visionCases());
  const finalGuard = promotionGate(rawCorrectFinalWrong);
  assert.equal(finalGuard.pass, false);
  assert.ok(finalGuard.failures.some((reason) => /final guarded agreement must be 100%/.test(reason)));

  const sameClassMoreOverrides = structuredClone(passingRuns);
  sameClassMoreOverrides[0]!.arms.baseline = arm(decisionCases({ overrides: 1, finalMiss: true }), visionCases());
  sameClassMoreOverrides[0]!.arms.candidate = arm(decisionCases({ overrides: 2 }), visionCases());
  const overrideGate = promotionGate(sameClassMoreOverrides);
  assert.equal(overrideGate.pass, false);
  assert.ok(overrideGate.failures.some((reason) => /override count\/rate regressed/.test(reason)));

  const slow = structuredClone(passingRuns);
  slow[0]!.arms.candidate = arm(decisionCases({ latency: 1_501 }), visionCases(30_001));
  const slowGate = promotionGate(slow);
  assert.equal(slowGate.pass, false);
  assert.ok(slowGate.failures.some((reason) => /decision latency regressed beyond/.test(reason)));
  assert.ok(slowGate.failures.some((reason) => /vision latency ceiling failed/.test(reason)));
});

test("completed fixed-denominator provider failures close promotion-fail while missing schedule remains incomplete", () => {
  const reviewIds = new Set(["v09", "v10", "v11", "v16"]);
  const decisionErrors = EVAL_SET.map((item) => ({
    id: item.id, status: "error", expected: item.expected, latencyMsIncludingSeedSetup: 100,
    error: { category: "provider_unavailable" },
  }));
  const visionErrors = Array.from({ length: 16 }, (_, index) => {
    const id = `v${String(index + 1).padStart(2, "0")}`;
    return { id, status: "error", safeReviewExpected: reviewIds.has(id), latencyMs: 100, error: { category: "provider_unavailable" } };
  });
  const failedArm = { decision: summarizeDecision(decisionErrors), vision: summarizeVision(visionErrors) };
  const runs = ["AB", "BA", "BA", "AB"].map((order, index) => ({
    run: index + 1, order,
    arms: { baseline: structuredClone(failedArm), candidate: structuredClone(failedArm) },
  }));
  const gate = promotionGate(runs);
  assert.equal(scheduledExperimentComplete(runs), true);
  assert.equal(gate.pass, false);
  assert.equal(terminalPromotionArtifactStatus(runs, gate.pass, false), "promotion-fail");
  assert.equal(terminalPromotionArtifactStatus(runs, gate.pass, true), "incomplete");

  const missing = structuredClone(runs);
  missing[0]!.arms.candidate.decision.cases.pop();
  missing[0]!.arms.candidate.decision = summarizeDecision(missing[0]!.arms.candidate.decision.cases);
  assert.equal(scheduledExperimentComplete(missing), false);
  assert.equal(terminalPromotionArtifactStatus(missing, false, false), "incomplete");
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

  const serverFailure = categoricalEvalError(
    Object.assign(new Error("500 body contained private upstream diagnostics"), { statusCode: 503 }),
    "decision"
  );
  assert.deepEqual(serverFailure, {
    category: "provider_unavailable",
    summary: "the upstream provider is unavailable",
    source: "provider",
    phase: "decision",
    httpStatus: 503,
    attemptsObserved: null,
  });
  assert.doesNotMatch(JSON.stringify(serverFailure), /private upstream/i);
});

test("promotion credentials reject malformed, whitespace, control, plan, and temporary tokens without disclosure", () => {
  assert.doesNotThrow(() => assertPromotionCredential(`sk-${"a".repeat(24)}`));
  assert.doesNotThrow(() => assertPromotionCredential(`sk-ws${"A9_".repeat(8)}`));
  for (const secret of [
    ` sk-${"a".repeat(24)}`,
    `sk-${"a".repeat(24)}\n`,
    `sk-${"a".repeat(8)}\u0000${"b".repeat(16)}`,
    `sk-sp-${"a".repeat(24)}`,
    `st-${"a".repeat(24)}`,
    "sk-short",
    `sk-${"a".repeat(253)}`,
  ]) {
    assert.throws(
      () => assertPromotionCredential(secret),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_credentials_invalid"
        && !error.message.includes(secret)
    );
  }
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
  const expectedRelease = "a".repeat(40);
  const exact = [
    "--online", "--runs", "4",
    "--baseline-decision", PROMOTION_MODELS.baselineDecision,
    "--baseline-vision", PROMOTION_MODELS.baselineVision,
    "--candidate", PROMOTION_MODELS.candidate,
    "--expected-release", expectedRelease,
    "--write", "eval/results/model-promotion-ab-attempt-02.json",
  ];
  assert.deepEqual(parsePromotionCli(exact), {
    ...PROMOTION_MODELS,
    expectedRelease,
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
    exact.map((value) => value === expectedRelease ? "HEAD" : value),
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

test("same-release attestation detects head, protocol-blob, fixture, and origin-main drift", () => {
  const start = {
    observedAt: "2026-07-16T00:00:00.000Z",
    gitCommit: "1".repeat(40),
    originMainGitCommit: "1".repeat(40),
    expectedReleaseGitCommit: "1".repeat(40),
    protocolSha256: "2".repeat(64),
    protocolBlobs: { "eval/compare.ts": "3".repeat(40) },
    datasetSha256: "4".repeat(64),
    fixtureSetSha256: "5".repeat(64),
    fixtureBytesSha256: "6".repeat(64),
    poppler: { sha256: "7".repeat(64), bundleFiles: 178, bundleSha256: "8".repeat(64) },
  };
  assert.deepEqual(comparePromotionReleaseSnapshots(start, { ...start, observedAt: "later" }), {
    status: "passed", mismatches: [],
  });
  const head = comparePromotionReleaseSnapshots(start, { ...start, gitCommit: "9".repeat(40) });
  assert.deepEqual(head.mismatches, ["head"]);
  const protocol = comparePromotionReleaseSnapshots(start, {
    ...start, protocolBlobs: { "eval/compare.ts": "a".repeat(40) },
  });
  assert.deepEqual(protocol.mismatches, ["protocol-blobs"]);
  const fixture = comparePromotionReleaseSnapshots(start, { ...start, fixtureBytesSha256: "b".repeat(64) });
  assert.deepEqual(fixture.mismatches, ["fixtures"]);
  const origin = comparePromotionReleaseSnapshots(start, { ...start, originMainGitCommit: "c".repeat(40) });
  assert.deepEqual(origin.mismatches, ["origin-main"]);
});

test("expected-release and origin/main binding reject a changed or clean unpushed HEAD", async () => {
  const dir = resolve(".artifacts", `expected-release-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.email", "release-test@example.invalid"]).status, 0);
    assert.equal(git(["config", "user.name", "Release Test"]).status, 0);
    await writeFile(join(dir, "protocol.ts"), "export const release = 1;\n", "utf8");
    assert.equal(git(["add", "protocol.ts"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "release one"]).status, 0);
    const release = git(["rev-parse", "HEAD"]).stdout.trim();
    assert.equal(git(["update-ref", "refs/remotes/origin/main", release]).status, 0);
    const start = await committedProtocolState(["protocol.ts"], {
      cwd: dir, strict: true, expectedReleaseGitCommit: release, requireHeadMatchesOriginMain: true,
    });
    assert.equal(start.headMatchesExpectedRelease, true);
    assert.equal(start.headMatchesOriginMain, true);
    await writeFile(join(dir, "next.ts"), "export const next = 2;\n", "utf8");
    assert.equal(git(["add", "next.ts"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "release two"]).status, 0);
    const unpushed = git(["rev-parse", "HEAD"]).stdout.trim();
    await assert.rejects(
      committedProtocolState(["protocol.ts"], { cwd: dir, strict: true, expectedReleaseGitCommit: release }),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_tree_invalid"
    );
    const cleanButUnpushed = await committedProtocolState(["protocol.ts"], {
      cwd: dir, strict: true, expectedReleaseGitCommit: unpushed,
    });
    assert.equal(cleanButUnpushed.headMatchesExpectedRelease, true);
    assert.equal(cleanButUnpushed.headMatchesOriginMain, false);
    await assert.rejects(
      committedProtocolState(["protocol.ts"], {
        cwd: dir,
        strict: true,
        expectedReleaseGitCommit: unpushed,
        requireHeadMatchesOriginMain: true,
      }),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_tree_invalid"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evidence ledger requires committed regular byte-exact artifacts with matching status and provenance", async () => {
  const dir = resolve(".artifacts", `evidence-ledger-${process.pid}`);
  const resultPath = "eval/results/diagnostic-attempt-01.json";
  await mkdir(join(dir, "eval", "results"), { recursive: true });
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(git(["init", "--quiet"]).status, 0);
    assert.equal(git(["config", "user.email", "ledger-test@example.invalid"]).status, 0);
    assert.equal(git(["config", "user.name", "Ledger Test"]).status, 0);
    await writeFile(join(dir, "protocol.ts"), "export const protocol = 1;\n", "utf8");
    assert.equal(git(["add", "protocol.ts"]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "source release"]).status, 0);
    const sourceCommit = git(["rev-parse", "HEAD"]).stdout.trim();
    const bytes = Buffer.from(JSON.stringify({
      status: "incomplete",
      provenance: { gitCommit: sourceCommit },
      promotion: { pass: false },
    }, null, 2) + "\n", "utf8");
    await writeFile(join(dir, resultPath), bytes);
    await writeFile(join(dir, "eval", "results", "evidence-ledger.json"), JSON.stringify({
      schemaVersion: 1,
      attempts: [{
        path: resultPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceCommit,
        status: "incomplete",
        classification: "environment-invalid-diagnostic",
      }],
    }, null, 2) + "\n");
    assert.equal(git(["add", "protocol.ts", "eval/results/evidence-ledger.json", resultPath]).status, 0);
    assert.equal(git(["commit", "--quiet", "-m", "ledger fixture"]).status, 0);
    const registered = await committedProtocolState(
      ["protocol.ts", "eval/results/evidence-ledger.json", resultPath],
      { cwd: dir, strict: true, allowResultArtifacts: true }
    );
    assert.equal(registered.protocolTreeClean, true);
    assert.deepEqual(registered.allowedDirtyResultArtifacts, []);
    assert.equal(registered.evidenceLedger[0]?.sha256, createHash("sha256").update(bytes).digest("hex"));

    await writeFile(join(dir, resultPath), bytes.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
    await assert.rejects(
      committedProtocolState(
        ["protocol.ts", "eval/results/evidence-ledger.json", resultPath],
        { cwd: dir, strict: true, allowResultArtifacts: true }
      ),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_tree_invalid"
    );
    await writeFile(join(dir, resultPath), bytes);

    const activeResultPath = "eval/results/diagnostic-attempt-02.json";
    await writeFile(join(dir, activeResultPath), '{"status":"running"}\n', "utf8");
    const active = await committedProtocolState(
      ["protocol.ts", "eval/results/evidence-ledger.json", resultPath],
      { cwd: dir, strict: true, allowResultArtifacts: true, activeResultPath }
    );
    assert.deepEqual(active.allowedDirtyResultArtifacts, [{ status: "??", path: activeResultPath }]);
    await writeFile(join(dir, "unknown.txt"), "dirty\n", "utf8");
    await assert.rejects(
      committedProtocolState(
        ["protocol.ts", "eval/results/evidence-ledger.json", resultPath],
        { cwd: dir, strict: true, allowResultArtifacts: true, activeResultPath }
      ),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_protocol_tree_invalid"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("immutable attempt 01 is a committed LF-normalized byte-exact ledger artifact", async () => {
  const path = "eval/results/model-promotion-ab-attempt-01.json";
  const expected = "cdc2be2760e85feecb173083355c5b7f10f6f928852ddca4f052ac518b809588";
  const working = await readFile(path);
  assert.equal(createHash("sha256").update(working).digest("hex"), expected);
  assert.equal(working.includes(Buffer.from("\r\n")), false);
  const committed = spawnSync("git", ["show", `HEAD:${path}`], { cwd: resolve("."), encoding: null });
  assert.equal(committed.status, 0);
  assert.equal(createHash("sha256").update(committed.stdout).digest("hex"), expected);
  assert.ok(working.equals(committed.stdout));
  const attrs = spawnSync("git", ["check-attr", "text", "eol", "--", path], {
    cwd: resolve("."), encoding: "utf8",
  });
  assert.equal(attrs.status, 0);
  assert.match(attrs.stdout, /text: set/);
  assert.match(attrs.stdout, /eol: lf/);
});

test("database bootstrap accepts only the dedicated autopilot runtime identity and separated admin DSN", () => {
  const password = "a".repeat(40);
  assert.deepEqual(bootstrapConfig({
    MIGRATION_DATABASE_URL: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
    BOOTSTRAP_APPLY_SCHEMA: "0",
  }), {
    migrationUrl: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    runtimeUrl: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    appPassword: password,
    otherDatabase: "memoryagent",
    applySchema: false,
  });
  assert.throws(() => bootstrapConfig({
    MIGRATION_DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/postgres`,
    DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
    BOOTSTRAP_APPLY_SCHEMA: "0",
  }), /bootstrap\/admin role/);
  assert.throws(() => bootstrapConfig({
    MIGRATION_DATABASE_URL: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    DATABASE_URL: `postgresql://memoryagent_app:${password}@db:5432/memoryagent`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
    BOOTSTRAP_APPLY_SCHEMA: "0",
  }), /role autopilot_app and database autopilot/);
  assert.throws(() => bootstrapConfig({
    MIGRATION_DATABASE_URL: "postgresql://bootstrap:admin-secret@db:5432/postgres",
    DATABASE_URL: `postgresql://autopilot_app:${password}@db:5432/autopilot`,
    AUTOPILOT_APP_DB_PASSWORD: password,
    MEMORY_DATABASE_NAME: "memoryagent",
    BOOTSTRAP_APPLY_SCHEMA: "auto",
  }), /explicitly set to 0.*or 1/);
});
