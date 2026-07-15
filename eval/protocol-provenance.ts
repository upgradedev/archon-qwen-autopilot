import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { PromotionEnvironmentError } from "./promotion-environment.js";

const exec = promisify(execFile);
export const PINNED_PROMOTION_RUNTIME = Object.freeze({
  node: "v24.18.0",
  packageManagerManifest: "npm@11.16.0",
  tsx: "4.23.0",
  invocation: "node --import tsx",
});

export async function assertPinnedPromotionRuntime(cwd = process.cwd()): Promise<void> {
  try {
    if (process.version !== PINNED_PROMOTION_RUNTIME.node) throw new Error("node mismatch");
    const root = await realpath(resolve(cwd));
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      engines?: { node?: string; npm?: string };
      packageManager?: string;
    };
    const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
    const tsxPath = await realpath(resolve(root, "node_modules", "tsx", "package.json"));
    const rel = relative(root, tsxPath);
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("tsx escaped repository");
    const installedTsx = JSON.parse(await readFile(tsxPath, "utf8")) as { version?: string };
    if (
      packageJson.engines?.node !== PINNED_PROMOTION_RUNTIME.node.slice(1)
      || packageJson.engines?.npm !== PINNED_PROMOTION_RUNTIME.packageManagerManifest.slice(4)
      || packageJson.packageManager !== PINNED_PROMOTION_RUNTIME.packageManagerManifest
      || lock.packages?.["node_modules/tsx"]?.version !== PINNED_PROMOTION_RUNTIME.tsx
      || installedTsx.version !== PINNED_PROMOTION_RUNTIME.tsx
    ) throw new Error("runtime lock mismatch");
  } catch {
    throw new PromotionEnvironmentError("promotion_runtime_invalid");
  }
}

export interface ProtocolDirtyPath {
  status: string;
  path: string;
}

export interface CommittedProtocolState {
  files: string[];
  gitCommit: string | null;
  originMainGitCommit: string | null;
  expectedReleaseGitCommit: string | null;
  headMatchesExpectedRelease: boolean | null;
  headMatchesOriginMain: boolean | null;
  gitClean: boolean | null;
  protocolTreeClean: boolean | null;
  protocolSha256: string | null;
  protocolBlobs: Record<string, string>;
  allowedDirtyResultArtifacts: ProtocolDirtyPath[];
  disallowedDirtyPaths: ProtocolDirtyPath[];
  evidenceLedger: EvidenceLedgerAttempt[];
}

export interface EvidenceLedgerAttempt {
  path: string;
  sha256: string;
  sourceCommit: string;
  status: "incomplete" | "complete" | "promotion-pass" | "promotion-fail";
  classification: "environment-invalid-diagnostic" | "model-promotion-evidence";
}

export interface CommittedProtocolOptions {
  cwd?: string;
  strict?: boolean;
  allowResultArtifacts?: boolean;
  activeResultPath?: string;
  expectedReleaseGitCommit?: string;
  requireHeadMatchesOriginMain?: boolean;
}

function canonicalFiles(files: readonly string[]): string[] {
  const normalized = files.map((file) => file.replace(/\\/g, "/"));
  if (normalized.some((file) => !file || file.startsWith("/") || /^[A-Za-z]:\//.test(file)
    || file.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error("protocol file list must use canonical repository-relative paths");
  }
  const unique = [...new Set(normalized)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (unique.length !== normalized.length) throw new Error("protocol file list contains a duplicate");
  return unique;
}

function statusEntries(value: string): ProtocolDirtyPath[] {
  return value.split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/"),
  }));
}

function unavailable(files: string[], disallowedDirtyPaths: ProtocolDirtyPath[] = []): CommittedProtocolState {
  return {
    files,
    gitCommit: null,
    originMainGitCommit: null,
    expectedReleaseGitCommit: null,
    headMatchesExpectedRelease: null,
    headMatchesOriginMain: null,
    gitClean: null,
    protocolTreeClean: disallowedDirtyPaths.length > 0 ? false : null,
    protocolSha256: null,
    protocolBlobs: {},
    allowedDirtyResultArtifacts: [],
    disallowedDirtyPaths,
    evidenceLedger: [],
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

async function committedRegularFile(cwd: string, path: string): Promise<{ working: Buffer; committed: Buffer }> {
  const absolute = resolve(cwd, path);
  const info = await lstat(absolute);
  const real = await realpath(absolute);
  if (!info.isFile() || info.isSymbolicLink() || relative(cwd, real).replace(/\\/g, "/") !== path) {
    throw new Error("invalid committed evidence file");
  }
  const tree = (await exec("git", ["ls-tree", "HEAD", "--", path], { cwd })).stdout.trim();
  if (!/^100644 blob [0-9a-f]{40,64}\t/.test(tree)) throw new Error("evidence file is not a HEAD regular blob");
  const shown = await exec("git", ["show", `HEAD:${path}`], {
    cwd,
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024,
  } as Parameters<typeof exec>[2]) as unknown as { stdout: Buffer };
  const working = await readFile(real);
  const committed = Buffer.from(shown.stdout);
  if (!working.equals(committed)) throw new Error("working evidence differs from HEAD");
  return { working, committed };
}

export async function verifiedEvidenceLedger(cwd: string): Promise<EvidenceLedgerAttempt[]> {
  const ledgerRel = "eval/results/evidence-ledger.json";
  const ledgerPath = resolve(cwd, "eval", "results", "evidence-ledger.json");
  const ledgerInfo = await lstat(ledgerPath);
  const ledgerReal = await realpath(ledgerPath);
  if (!ledgerInfo.isFile() || ledgerInfo.isSymbolicLink()
    || relative(cwd, ledgerReal).replace(/\\/g, "/") !== "eval/results/evidence-ledger.json") {
    throw new Error("invalid evidence ledger");
  }
  const { committed: ledgerBytes } = await committedRegularFile(cwd, ledgerRel);
  const parsed = JSON.parse(ledgerBytes.toString("utf8")) as {
    schemaVersion?: unknown;
    attempts?: unknown;
  };
  if (!parsed || typeof parsed !== "object"
    || !hasExactKeys(parsed as Record<string, unknown>, ["schemaVersion", "attempts"])
    || parsed.schemaVersion !== 1 || !Array.isArray(parsed.attempts)) throw new Error("invalid evidence ledger");
  const attempts = parsed.attempts as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const nextByPrefix = new Map<string, number>();
  for (const item of attempts) {
    const path = typeof item.path === "string" ? item.path : "";
    const match = /^eval\/results\/([A-Za-z0-9._-]+)-attempt-([0-9]{2})\.json$/.exec(path);
    const attemptNumber = Number(match?.[2]);
    if (
      !hasExactKeys(item, ["path", "sha256", "sourceCommit", "status", "classification"])
      || !match
      || attemptNumber < 1
      || attemptNumber > 99
      || seen.has(path)
      || typeof item.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(item.sha256)
      || typeof item.sourceCommit !== "string"
      || !/^[0-9a-f]{40,64}$/.test(item.sourceCommit)
      || !["incomplete", "complete", "promotion-pass", "promotion-fail"].includes(String(item.status))
      || !["environment-invalid-diagnostic", "model-promotion-evidence"].includes(String(item.classification))
    ) throw new Error("invalid evidence ledger entry");
    const prefix = match[1]!;
    const expectedAttempt = nextByPrefix.get(prefix) ?? 1;
    if (attemptNumber !== expectedAttempt) throw new Error("non-contiguous evidence ledger");
    nextByPrefix.set(prefix, expectedAttempt + 1);
    seen.add(path);

    const { committed: bytes } = await committedRegularFile(cwd, path);
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) {
      throw new Error("evidence ledger artifact hash mismatch");
    }
    const artifact = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const provenance = artifact.provenance as Record<string, unknown> | undefined;
    if (artifact.status !== item.status || provenance?.gitCommit !== item.sourceCommit) {
      throw new Error("evidence ledger artifact provenance mismatch");
    }
    await exec("git", ["merge-base", "--is-ancestor", String(item.sourceCommit), "HEAD"], { cwd });
  }
  return attempts as unknown as EvidenceLedgerAttempt[];
}

// The protocol identity is derived from committed Git blob IDs rather than working-
// tree bytes. The same commit therefore has the same fingerprint on LF and CRLF
// checkouts, while strict keyed runs still reject any uncommitted protocol input.
export async function committedProtocolState(
  inputFiles: readonly string[],
  options: CommittedProtocolOptions = {}
): Promise<CommittedProtocolState> {
  const files = canonicalFiles(inputFiles);
  const cwd = options.cwd ?? process.cwd();
  try {
    const root = await realpath(resolve(cwd));
    const gitTopLevel = await realpath((await exec(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: root }
    )).stdout.trim());
    if (relative(root, gitTopLevel) !== "" || relative(gitTopLevel, root) !== "") {
      throw new Error("promotion protocol must run from the repository root");
    }
    const gitCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(gitCommit)) throw new Error("invalid commit identity");
    const expectedReleaseGitCommit = options.expectedReleaseGitCommit ?? null;
    if (expectedReleaseGitCommit !== null && !/^[0-9a-f]{40,64}$/.test(expectedReleaseGitCommit)) {
      throw new Error("invalid expected release identity");
    }
    const headMatchesExpectedRelease = expectedReleaseGitCommit === null
      ? null
      : gitCommit === expectedReleaseGitCommit;
    if (options.strict && headMatchesExpectedRelease === false) {
      throw new Error("HEAD does not match the expected release");
    }
    let originMainGitCommit: string | null = null;
    try {
      const value = (await exec("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: root })).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error("invalid origin/main identity");
      originMainGitCommit = value;
    } catch {
      if (options.requireHeadMatchesOriginMain) throw new Error("origin/main identity unavailable");
    }
    const headMatchesOriginMain = originMainGitCommit === null ? null : gitCommit === originMainGitCommit;
    if (options.requireHeadMatchesOriginMain && headMatchesOriginMain !== true) {
      throw new Error("HEAD does not match origin/main");
    }
    const dirty = statusEntries((await exec(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 }
    )).stdout);
    const ledger = options.allowResultArtifacts ? await verifiedEvidenceLedger(root) : [];
    const allowedDirtyResultArtifacts: ProtocolDirtyPath[] = [];
    if (options.activeResultPath !== undefined) {
      const normalizedActive = options.activeResultPath.replace(/\\/g, "/");
      const activeAbsolute = resolve(root, normalizedActive);
      const activeRelative = relative(root, activeAbsolute).replace(/\\/g, "/");
      if (activeRelative !== normalizedActive || isAbsolute(activeRelative) || activeRelative.startsWith("..")
        || !/^eval\/results\/[A-Za-z0-9._-]+-attempt-[0-9]{2}\.json$/.test(activeRelative)) {
        throw new Error("invalid active result path");
      }
      const activeEntry = dirty.find((entry) => entry.status === "??" && entry.path === activeRelative);
      if (!activeEntry) throw new Error("active result is not the sole untracked result");
      const info = await lstat(activeAbsolute);
      const activeReal = await realpath(activeAbsolute);
      if (!info.isFile() || info.isSymbolicLink()
        || relative(root, activeReal).replace(/\\/g, "/") !== activeRelative) {
        throw new Error("invalid active result artifact");
      }
      allowedDirtyResultArtifacts.push(activeEntry);
    }
    const allowed = new Set(allowedDirtyResultArtifacts.map((entry) => `${entry.status}\0${entry.path}`));
    const disallowedDirtyPaths = dirty.filter((entry) => !allowed.has(`${entry.status}\0${entry.path}`));
    if (options.strict && disallowedDirtyPaths.length > 0) {
      throw new Error("dirty protocol tree");
    }

    const digest = createHash("sha256").update("archon-committed-protocol-v2\n");
    const protocolBlobs: Record<string, string> = {};
    for (const file of files) {
      await exec("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root });
      const blob = (await exec("git", ["rev-parse", `HEAD:${file}`], { cwd: root })).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error("invalid protocol blob identity");
      protocolBlobs[file] = blob;
      digest.update(file).update("\0").update(blob).update("\n");
    }
    return {
      files,
      gitCommit,
      originMainGitCommit,
      expectedReleaseGitCommit,
      headMatchesExpectedRelease,
      headMatchesOriginMain,
      gitClean: dirty.length === 0,
      protocolTreeClean: disallowedDirtyPaths.length === 0,
      protocolSha256: digest.digest("hex"),
      protocolBlobs,
      allowedDirtyResultArtifacts,
      disallowedDirtyPaths,
      evidenceLedger: ledger,
    };
  } catch {
    if (options.strict) {
      throw new PromotionEnvironmentError("promotion_protocol_tree_invalid");
    }
    return unavailable(files);
  }
}
