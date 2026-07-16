import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(HERE, "..");
const SHA1_RE = /^[0-9a-f]{40}$/;

export const LOCKED_NODE_VERSION = "v24.18.0";
export const LOCKED_NODE_LABEL = "Node.js 24.18.0";
export const REPLAY_SOURCE_PATHS = Object.freeze([
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
export const REPLAY_EVIDENCE_INPUT_PATHS = Object.freeze([
  "impact/raw-observations.json",
]);

function fail(message) {
  throw new Error(message);
}

function runGit(repoRoot, args, { encoding = "utf8", acceptedStatuses = [0] } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) fail("Git source-identity command failed to start");
  if (!acceptedStatuses.includes(result.status)) {
    fail("Git source-identity command failed: git " + args[0]);
  }
  return result;
}

function gitText(repoRoot, args) {
  return String(runGit(repoRoot, args).stdout).trim();
}

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCommittedRegularClosure(repoRoot, revision, paths, label) {
  const listing = runGit(
    repoRoot,
    ["ls-tree", "-r", "-z", revision, "--", ...paths],
    { encoding: null },
  ).stdout;
  const entries = new Set();
  for (const record of Buffer.from(listing).toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const header = tab >= 0 ? record.slice(0, tab) : "";
    const path = tab >= 0 ? record.slice(tab + 1) : "";
    if (!/^100644 blob [0-9a-f]{40}$/.test(header) || !path || entries.has(path)) {
      fail(`${label} must contain only unique committed regular-file blobs`);
    }
    entries.add(path);
  }
  for (const path of paths) {
    const present = path === "src"
      ? [...entries].some((entry) => entry.startsWith("src/"))
      : entries.has(path);
    if (!present) fail(`${label} is not fully committed at ${revision}: ${path}`);
  }
}

function assertIndexFlagsClean(repoRoot, paths, label) {
  const indexState = gitText(repoRoot, ["ls-files", "-v", "--", ...paths]);
  for (const line of indexState.split(/\r?\n/).filter(Boolean)) {
    if (/^[a-zS] /.test(line)) fail(`${label} contains assume-unchanged or skip-worktree index state`);
  }
}

function assertReplaySourceWorktreeClean(repoRoot) {
  const worktreeState = runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...REPLAY_SOURCE_PATHS],
    { encoding: null },
  ).stdout;
  if (worktreeState.length !== 0) fail("replay-source closure has staged, unstaged, or untracked changes");

  // `git status` intentionally honors ignore rules. Source identity does not:
  // an ignored file can still shadow or influence a module loader, so enumerate
  // every other file without `--exclude-standard` and reject it too.
  const allUntracked = gitText(repoRoot, ["ls-files", "--others", "--", ...REPLAY_SOURCE_PATHS]);
  if (allUntracked) fail("replay-source closure contains an ignored or untracked file");
  assertIndexFlagsClean(repoRoot, REPLAY_SOURCE_PATHS, "replay-source closure");
}

export function assertLockedImpactRuntime(actualVersion = process.version) {
  if (actualVersion !== LOCKED_NODE_VERSION) {
    fail(`impact replay requires exact ${LOCKED_NODE_LABEL}; current runtime is ${actualVersion}`);
  }
}

export function canonicalImpactText(text, label = "impact text input") {
  if (typeof text !== "string") fail(`${label} must be a UTF-8 text string`);
  const canonical = text.replace(/\r\n/g, "\n");
  if (canonical.includes("\r")) fail(`${label} contains an unsupported lone carriage return`);
  return canonical;
}

export function canonicalImpactTextSha256(text, label) {
  return createHash("sha256")
    .update(canonicalImpactText(text, label), "utf8")
    .digest("hex");
}

export function assertCommittedReplayEvidenceInputs(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPOSITORY_ROOT);
  const head = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!SHA1_RE.test(head)) fail("current HEAD is not a full Git commit id");
  assertCommittedRegularClosure(
    repoRoot,
    head,
    REPLAY_EVIDENCE_INPUT_PATHS,
    "replay evidence input closure",
  );
  const state = runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...REPLAY_EVIDENCE_INPUT_PATHS],
    { encoding: null },
  ).stdout;
  if (state.length !== 0) fail("replay evidence inputs must match committed HEAD exactly");
  const untracked = gitText(repoRoot, ["ls-files", "--others", "--", ...REPLAY_EVIDENCE_INPUT_PATHS]);
  if (untracked) fail("replay evidence inputs must be committed regular files");
  assertIndexFlagsClean(repoRoot, REPLAY_EVIDENCE_INPUT_PATHS, "replay evidence input closure");
}

export function captureReplaySourceIdentityAtCleanHead(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPOSITORY_ROOT);
  const repositoryState = runGit(
    repoRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: null },
  ).stdout;
  if (repositoryState.length !== 0) {
    fail("impact source refresh requires a completely clean committed HEAD (commit A)");
  }
  const head = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!SHA1_RE.test(head)) fail("current HEAD is not a full Git commit id");
  const tree = gitText(repoRoot, ["rev-parse", "--verify", `${head}^{tree}`]);
  if (!SHA1_RE.test(tree)) fail("current HEAD tree is not a full Git tree id");
  assertCommittedRegularClosure(repoRoot, head, REPLAY_SOURCE_PATHS, "replay-source closure");
  assertReplaySourceWorktreeClean(repoRoot);
  return Object.freeze({
    gitCommit: head,
    gitTree: tree,
    replaySourcePaths: [...REPLAY_SOURCE_PATHS],
    sourceCommitIsAncestor: true,
    currentHeadSourceClosureMatches: true,
    worktreeSourceClosureClean: true,
    indexFlagsClean: true,
  });
}

export function verifyReplaySourceIdentity(collection, options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPOSITORY_ROOT);
  const sourceCommit = String(collection?.sourceCommit ?? "");
  const sourceTree = String(collection?.sourceIdentity?.gitTree ?? "");
  const sourcePaths = collection?.sourceIdentity?.replaySourcePaths;

  if (!SHA1_RE.test(sourceCommit)) fail("raw replay sourceCommit is not a full lowercase Git SHA");
  if (!SHA1_RE.test(sourceTree)) fail("raw replay sourceIdentity.gitTree is not a full lowercase Git tree id");
  if (!Array.isArray(sourcePaths) || !sameArray(sourcePaths, REPLAY_SOURCE_PATHS)) {
    fail("raw replay source path closure differs from the canonical replay-source set");
  }

  const resolvedCommit = gitText(repoRoot, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]);
  if (resolvedCommit !== sourceCommit) fail("raw replay sourceCommit does not resolve to the exact recorded Git commit");
  const resolvedTree = gitText(repoRoot, ["rev-parse", "--verify", `${sourceCommit}^{tree}`]);
  if (resolvedTree !== sourceTree) fail("raw replay source Git tree does not match sourceCommit");

  const head = gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!SHA1_RE.test(head)) fail("current HEAD is not a full Git commit id");
  const ancestry = runGit(
    repoRoot,
    ["merge-base", "--is-ancestor", sourceCommit, head],
    { acceptedStatuses: [0, 1] },
  );
  if (ancestry.status !== 0) fail("raw replay sourceCommit is not an ancestor of current HEAD");

  const committedClosure = runGit(
    repoRoot,
    ["diff", "--no-ext-diff", "--quiet", sourceCommit, head, "--", ...REPLAY_SOURCE_PATHS],
    { acceptedStatuses: [0, 1] },
  );
  if (committedClosure.status !== 0) {
    fail("current HEAD changed the replay-source closure after the frozen sourceCommit");
  }
  assertCommittedRegularClosure(repoRoot, head, REPLAY_SOURCE_PATHS, "replay-source closure");
  assertReplaySourceWorktreeClean(repoRoot);

  return Object.freeze({
    gitCommit: sourceCommit,
    gitTree: sourceTree,
    replaySourcePaths: [...REPLAY_SOURCE_PATHS],
    sourceCommitIsAncestor: true,
    currentHeadSourceClosureMatches: true,
    worktreeSourceClosureClean: true,
    indexFlagsClean: true,
  });
}
