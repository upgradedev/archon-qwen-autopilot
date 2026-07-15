import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  createExclusiveEvidenceArtifact,
  persistEvidenceArtifact,
} from "../../eval/artifact-safety.js";
import { createQwenClient, officialEvidenceEndpoint, officialRuntimeEndpoint } from "../../src/qwen/client.js";
import { promotionGate } from "../../eval/compare.js";
import { EVAL_SET } from "../../eval/dataset.js";
import { bootstrapConfig } from "../../scripts/bootstrap-db.js";

const require = createRequire(import.meta.url);
const { resolveRepoContainedPath } = require("../../scripts/repo-path.cjs") as {
  resolveRepoContainedPath(value: string, label?: string, options?: { mustExist?: boolean }): string;
};

test("eval artifacts reduce provider exceptions to a fixed category and allowlisted summary", () => {
  const secret = "api_key=sk-private password=hunter2 C:\\private\\provider.json";
  const result = categoricalEvalError(Object.assign(new Error(`401 Authorization failed: ${secret}`), {
    stack: `Error: ${secret}\n at provider (C:\\secret\\sdk.ts:9:1)`,
  }));
  assert.deepEqual(result, {
    category: "authentication_failed",
    summary: "upstream authentication failed",
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
  assert.equal(command, "node eval/run.ts --online --runs 3 --write eval/results/qwen-plus-attempt-01.json");
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
    metrics: { rawTerminalAgreement: 1, proposalContractSanity: 1, reviewerEnrichedExecution: 1 },
    policyOverrideSources: [],
    cases: EVAL_SET.map((item) => ({ id: item.id, status: "ok", rawModelTerminalTool: item.expected })),
  };
  const vision = {
    status: "complete",
    metrics: { normalizedStringAccuracy: 1, numericAccuracy: 1, safeReviewRecall: 1 },
    cases: [{ id: "v01", status: "ok", normalizedMisses: [], safeReviewPredicted: false }],
  };
  const runs = ["AB", "BA", "AB"].map((order, index) => ({
    run: index + 1,
    order,
    arms: {
      baseline: { decision: structuredClone(decision), vision: structuredClone(vision) },
      candidate: { decision: structuredClone(decision), vision: structuredClone(vision) },
    },
  }));
  assert.equal(promotionGate(runs).pass, true);
  runs[1]!.arms.candidate.decision.metrics.rawTerminalAgreement = 0.9;
  const failed = promotionGate(runs);
  assert.equal(failed.pass, false);
  assert.ok(failed.failures.some((reason) => /decision agreement regressed/.test(reason)));

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
