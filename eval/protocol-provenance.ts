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
  gitClean: boolean | null;
  protocolTreeClean: boolean | null;
  protocolSha256: string | null;
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
    gitClean: null,
    protocolTreeClean: disallowedDirtyPaths.length > 0 ? false : null,
    protocolSha256: null,
    allowedDirtyResultArtifacts: [],
    disallowedDirtyPaths,
    evidenceLedger: [],
  };
}

async function evidenceLedger(cwd: string): Promise<EvidenceLedgerAttempt[]> {
  const parsed = JSON.parse(await readFile(resolve(cwd, "eval", "results", "evidence-ledger.json"), "utf8")) as {
    schemaVersion?: unknown;
    attempts?: unknown;
  };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.attempts)) throw new Error("invalid evidence ledger");
  const attempts = parsed.attempts as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const nextByPrefix = new Map<string, number>();
  for (const item of attempts) {
    const path = typeof item.path === "string" ? item.path : "";
    const match = /^eval\/results\/([A-Za-z0-9._-]+)-attempt-([0-9]{2})\.json$/.exec(path);
    const attemptNumber = Number(match?.[2]);
    if (
      !match
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
    const dirty = statusEntries((await exec(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 }
    )).stdout);
    const ledger = options.allowResultArtifacts ? await evidenceLedger(root) : [];
    const registeredHashes = new Map(ledger.map((item) => [item.path, item.sha256]));
    const allowedDirtyResultArtifacts: ProtocolDirtyPath[] = [];
    if (options.allowResultArtifacts) {
      for (const entry of dirty) {
        const expected = entry.status === "??" ? registeredHashes.get(entry.path) : undefined;
        if (!expected) continue;
        const artifactPath = resolve(root, entry.path);
        const info = await lstat(artifactPath);
        if (!info.isFile()) continue;
        const artifactReal = await realpath(artifactPath);
        const artifactRel = relative(root, artifactReal);
        if (isAbsolute(artifactRel) || artifactRel.startsWith("..")) continue;
        const actual = createHash("sha256").update(await readFile(artifactReal)).digest("hex");
        if (actual === expected) allowedDirtyResultArtifacts.push(entry);
      }
    }
    const allowed = new Set(allowedDirtyResultArtifacts.map((entry) => `${entry.status}\0${entry.path}`));
    const disallowedDirtyPaths = dirty.filter((entry) => !allowed.has(`${entry.status}\0${entry.path}`));
    if (options.strict && disallowedDirtyPaths.length > 0) {
      throw new Error("dirty protocol tree");
    }

    const digest = createHash("sha256").update("archon-committed-protocol-v1\n");
    for (const file of files) {
      await exec("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root });
      const blob = (await exec("git", ["rev-parse", `HEAD:${file}`], { cwd: root })).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error("invalid protocol blob identity");
      digest.update(file).update("\0").update(blob).update("\n");
    }
    return {
      files,
      gitCommit,
      gitClean: dirty.length === 0,
      protocolTreeClean: disallowedDirtyPaths.length === 0,
      protocolSha256: digest.digest("hex"),
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
