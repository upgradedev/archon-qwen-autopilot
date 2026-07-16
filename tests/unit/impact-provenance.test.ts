import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCommittedReplayEvidenceInputs,
  assertLockedImpactRuntime,
  captureReplaySourceIdentityAtCleanHead,
  LOCKED_NODE_VERSION,
  REPLAY_EVIDENCE_INPUT_PATHS,
  REPLAY_SOURCE_PATHS,
  verifyReplaySourceIdentity,
} from "../../impact/provenance.mjs";

interface SourceCollection {
  sourceCommit: string;
  sourceIdentity: { gitTree: string; replaySourcePaths: string[] };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Impact Test",
      GIT_AUTHOR_EMAIL: "impact@example.test",
      GIT_COMMITTER_NAME: "Impact Test",
      GIT_COMMITTER_EMAIL: "impact@example.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeReplayClosure(root: string, suffix = "v1"): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "eval"), { recursive: true });
  mkdirSync(join(root, "impact"), { recursive: true });
  writeFileSync(join(root, "src", "core.ts"), `export const core = ${JSON.stringify(suffix)};\n`);
  writeFileSync(join(root, "eval", "lib.ts"), `export const runner = ${JSON.stringify(suffix)};\n`);
  writeFileSync(join(root, "eval", "dataset.ts"), "export const cases = [];\n");
  writeFileSync(join(root, "eval", "artifact-safety.ts"), "export const safe = true;\n");
  writeFileSync(join(root, "eval", "promotion-environment.ts"), "export class PromotionEnvironmentError extends Error {}\n");
  writeFileSync(join(root, "eval", "protocol-provenance.ts"), "export const provenance = true;\n");
  writeFileSync(join(root, "impact", "analyze.mjs"), "export const analyzer = true;\n");
  writeFileSync(join(root, "impact", "provenance.mjs"), "export const provenance = true;\n");
  writeFileSync(join(root, "impact", "protocol.json"), "{}\n");
  writeFileSync(join(root, "impact", "cases.json"), "{}\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
}

function sourceFixture(): { root: string; collection: SourceCollection } {
  const root = mkdtempSync(join(tmpdir(), "archon-impact-source-"));
  git(root, ["init", "--quiet"]);
  writeReplayClosure(root);
  writeFileSync(join(root, "impact", "raw-observations.json"), "{}\n");
  writeFileSync(join(root, ".gitignore"), "*.shadow\n");
  git(root, ["add", "--", ".gitignore", ...REPLAY_SOURCE_PATHS, ...REPLAY_EVIDENCE_INPUT_PATHS]);
  git(root, ["commit", "--quiet", "-m", "frozen replay source"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const gitTree = git(root, ["rev-parse", `${sourceCommit}^{tree}`]);
  return {
    root,
    collection: {
      sourceCommit,
      sourceIdentity: { gitTree, replaySourcePaths: [...REPLAY_SOURCE_PATHS] },
    },
  };
}

test("impact runtime identity rejects every non-canonical Node release", () => {
  assert.doesNotThrow(() => assertLockedImpactRuntime(LOCKED_NODE_VERSION));
  assert.throws(
    () => assertLockedImpactRuntime("v20.20.2"),
    /requires exact Node\.js 24\.18\.0; current runtime is v20\.20\.2/,
  );
});

test("impact replay closure includes every local module and runtime manifest loaded by the analyzer", () => {
  assert.deepEqual(REPLAY_SOURCE_PATHS, [
    "src",
    "eval/lib.ts",
    "eval/dataset.ts",
    "eval/artifact-safety.ts",
    "eval/promotion-environment.ts",
    "eval/protocol-provenance.ts",
    "impact/analyze.mjs",
    "impact/provenance.mjs",
    "impact/protocol.json",
    "impact/cases.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
  ]);
});

test("impact source refresh captures only a completely clean committed HEAD", () => {
  const fixture = sourceFixture();
  try {
    assert.doesNotThrow(() => assertCommittedReplayEvidenceInputs({ repoRoot: fixture.root }));
    const identity = captureReplaySourceIdentityAtCleanHead({ repoRoot: fixture.root });
    assert.equal(identity.gitCommit, fixture.collection.sourceCommit);
    assert.equal(identity.gitTree, fixture.collection.sourceIdentity.gitTree);
    writeFileSync(join(fixture.root, "uncommitted-note.txt"), "not commit A\n");
    assert.throws(
      () => captureReplaySourceIdentityAtCleanHead({ repoRoot: fixture.root }),
      /completely clean committed HEAD \(commit A\)/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact checks reject a dirty or uncommitted raw evidence input", () => {
  const fixture = sourceFixture();
  try {
    writeFileSync(join(fixture.root, "impact", "raw-observations.json"), "{\"changed\":true}\n");
    assert.throws(
      () => assertCommittedReplayEvidenceInputs({ repoRoot: fixture.root }),
      /must match committed HEAD exactly/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact source identity allows a later evidence-only commit", () => {
  const fixture = sourceFixture();
  try {
    mkdirSync(join(fixture.root, "impact"), { recursive: true });
    writeFileSync(join(fixture.root, "impact", "RESULTS.md"), "derived evidence\n");
    git(fixture.root, ["add", "impact/RESULTS.md"]);
    git(fixture.root, ["commit", "--quiet", "-m", "add derived evidence"]);
    const identity = verifyReplaySourceIdentity(fixture.collection, { repoRoot: fixture.root });
    assert.equal(identity.sourceCommitIsAncestor, true);
    assert.equal(identity.currentHeadSourceClosureMatches, true);
    assert.equal(identity.worktreeSourceClosureClean, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact source identity rejects a non-ancestor HEAD", () => {
  const fixture = sourceFixture();
  try {
    const tree = git(fixture.root, ["rev-parse", "HEAD^{tree}"]);
    const unrelated = git(fixture.root, ["commit-tree", tree, "-m", "unrelated root"]);
    git(fixture.root, ["reset", "--quiet", "--hard", unrelated]);
    assert.throws(
      () => verifyReplaySourceIdentity(fixture.collection, { repoRoot: fixture.root }),
      /sourceCommit is not an ancestor/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact source identity rejects dirty replay-source state", () => {
  const fixture = sourceFixture();
  try {
    writeFileSync(join(fixture.root, "src", "untracked.ts"), "export const hidden = true;\n");
    assert.throws(
      () => verifyReplaySourceIdentity(fixture.collection, { repoRoot: fixture.root }),
      /staged, unstaged, or untracked changes/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact source identity rejects ignored files inside the replay closure", () => {
  const fixture = sourceFixture();
  try {
    writeFileSync(join(fixture.root, "src", "loader.shadow"), "ignored but source-visible\n");
    assert.throws(
      () => verifyReplaySourceIdentity(fixture.collection, { repoRoot: fixture.root }),
      /ignored or untracked file/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact source identity rejects committed replay-source drift", () => {
  const fixture = sourceFixture();
  try {
    writeReplayClosure(fixture.root, "v2");
    git(fixture.root, ["add", "src/core.ts", "eval/lib.ts"]);
    git(fixture.root, ["commit", "--quiet", "-m", "drift replay source"]);
    assert.throws(
      () => verifyReplaySourceIdentity(fixture.collection, { repoRoot: fixture.root }),
      /changed the replay-source closure/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("impact source identity rejects a forged tree binding", () => {
  const fixture = sourceFixture();
  try {
    const forged = structuredClone(fixture.collection);
    forged.sourceIdentity.gitTree = "0".repeat(40);
    assert.throws(
      () => verifyReplaySourceIdentity(forged, { repoRoot: fixture.root }),
      /Git tree does not match sourceCommit/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
