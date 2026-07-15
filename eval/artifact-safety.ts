import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  toSafeOperationalError,
  type OperationalErrorCode,
} from "../src/security/operational-error.js";
import { PromotionEnvironmentError } from "./promotion-environment.js";
import { verifiedEvidenceLedger } from "./protocol-provenance.js";

export interface CategoricalEvalError {
  category: OperationalErrorCode;
  summary: string;
  source: "provider" | "storage" | "delivery" | "runtime";
  phase: "decision" | "vision" | "evaluation";
  httpStatus?: number;
  sdkCode?: string;
  attemptsObserved: null;
}

// Provider exceptions can contain credentials, response bodies, request URLs,
// local paths, or stacks. Evaluation artifacts retain only a fixed taxonomy and
// allowlisted message; raw exception text never crosses this boundary.
export function categoricalEvalError(
  err: unknown,
  phase: CategoricalEvalError["phase"] = "evaluation"
): CategoricalEvalError {
  const safe = toSafeOperationalError(err, `evaluation-${phase}`);
  const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown };
  const rawStatus = candidate?.status ?? candidate?.statusCode;
  const httpStatus = Number.isInteger(rawStatus) && Number(rawStatus) >= 400 && Number(rawStatus) <= 599
    ? Number(rawStatus)
    : undefined;
  const knownSdkCodes = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
    "ABORT_ERR", "RATE_LIMIT_EXCEEDED", "INVALID_API_KEY",
  ]);
  const normalizedCode = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
  const sdkCode = knownSdkCodes.has(normalizedCode) ? normalizedCode : undefined;
  const providerHttpFailure = httpStatus !== undefined && httpStatus >= 500;
  const category: OperationalErrorCode = normalizedCode === "ABORT_ERR"
    ? "timeout"
    : ["ENOTFOUND", "EAI_AGAIN"].includes(normalizedCode)
      ? "provider_unavailable"
      : providerHttpFailure
        ? "provider_unavailable"
      : safe.code;
  const providerSdkError = knownSdkCodes.has(normalizedCode);
  const source = category === "storage_unavailable"
    ? "storage"
    : category === "delivery_unavailable"
      ? "delivery"
       : providerSdkError || providerHttpFailure
        || ["authentication_failed", "rate_limited", "provider_unavailable", "invalid_upstream_response"].includes(category)
        ? "provider"
        : "runtime";
  return {
    category,
    summary: category === safe.code
      ? safe.message
      : category === "timeout"
        ? "the operation timed out"
        : "the upstream provider is unavailable",
    source,
    phase,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(sdkCode === undefined ? {} : { sdkCode }),
    attemptsObserved: null,
  };
}

// Record a reproducible, repository-relative invocation instead of process.argv:
// under tsx, argv[1] is commonly an absolute checkout path. Callers supply only
// their already-parsed, allowlisted arguments.
export function canonicalEvidenceCommand(script: string, args: string[]): string {
  if (isAbsolute(script) || script.includes("\\") || script.startsWith("../") || script.includes("/../")) {
    throw new Error("evidence command script must be repository-relative");
  }
  for (const arg of args) {
    if (isAbsolute(arg) || arg.includes("\\")) {
      throw new Error("evidence command arguments must not contain absolute paths");
    }
  }
  return ["node", "--import", "tsx", script, ...args].map(commandToken).join(" ");
}

export async function promotionEvidenceArtifactPath(
  input: string,
  repoRoot = process.cwd(),
  policy: {
    prefix?: string;
    minAttempt?: number;
    maxAttempt?: number;
    requireNextAttempt?: boolean;
  } = {}
): Promise<string> {
  const root = await realpath(resolve(repoRoot));
  const target = resolve(root, input);
  const rel = relative(root, target).replace(/\\/g, "/");
  const match = /^eval\/results\/([A-Za-z0-9._-]+)-attempt-([0-9]{2})\.json$/.exec(rel);
  const minAttempt = policy.minAttempt ?? 1;
  const maxAttempt = policy.maxAttempt ?? 99;
  const requireNextAttempt = policy.requireNextAttempt ?? true;
  if (!Number.isInteger(minAttempt) || !Number.isInteger(maxAttempt)
    || minAttempt < 1 || maxAttempt > 99 || minAttempt > maxAttempt) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  if (isAbsolute(rel) || !match || (policy.prefix !== undefined && match[1] !== policy.prefix)) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  const prefix = match[1]!;
  const attempt = Number(match[2]);
  if (attempt < minAttempt || attempt > maxAttempt) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  try {
    const attempts = await verifiedEvidenceLedger(root);
    if (attempts.some((entry) => entry.path === rel)) {
      throw new PromotionEnvironmentError("promotion_artifact_exists");
    }
    const priorAttempts = attempts
      .map((entry) => typeof entry.path === "string"
        ? new RegExp(`^eval/results/${escapeRegExp(prefix)}-attempt-([0-9]{2})\\.json$`).exec(entry.path)
        : null)
      .filter((entry): entry is RegExpExecArray => entry !== null)
      .map((entry) => Number(entry[1]))
      .sort((left, right) => left - right);
    if (new Set(priorAttempts).size !== priorAttempts.length
      || priorAttempts.some((value, index) => value !== index + 1)) {
      throw new PromotionEnvironmentError("promotion_artifact_invalid");
    }
    if (requireNextAttempt && attempt !== priorAttempts.length + 1) {
      throw new PromotionEnvironmentError("promotion_artifact_invalid");
    }
  } catch (error) {
    if (error instanceof PromotionEnvironmentError) throw error;
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  const parent = await realpath(dirname(target)).catch(() => {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  });
  const parentRel = relative(root, parent);
  if (isAbsolute(parentRel) || parentRel.startsWith("..")) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  try {
    await lstat(target);
    throw new PromotionEnvironmentError("promotion_artifact_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface EvidencePublicationOptions {
  // A narrow deterministic fault-injection seam for proving that an interruption
  // before publication cannot expose a partial authoritative target.
  beforePublish?: (stagedPath: string) => Promise<void>;
}

// A previous attempt—successful or partial—is evidence and must never be
// replaced. Initial publication is a same-directory durable stage followed by an
// atomic hard-link. link(2) never replaces an existing name, so a competing writer
// receives EEXIST and the prior attempt remains byte-for-byte unchanged.
export async function createExclusiveEvidenceArtifact(
  path: string,
  content: string,
  options: EvidencePublicationOptions = {}
): Promise<void> {
  const temp = `${path}.initial-${process.pid}-${randomUUID()}`;
  let failure: unknown;
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforePublish?.(temp);
    await link(temp, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    failure = error;
  }
  try {
    await removeStagedFile(temp);
  } catch (cleanupError) {
    if (failure !== undefined) throw new AggregateError([failure, cleanupError], "evidence publication and cleanup failed");
    throw cleanupError;
  }
  if (failure !== undefined) throw failure;
}

// Progress updates are whole-file atomic replacements in the same directory.
// A crash can leave an orphan temp sibling, but never a truncated/invalid attempt
// at the authoritative path; the previous fsynced JSON remains parseable.
export async function persistEvidenceArtifact(path: string, content: string): Promise<void> {
  const temp = `${path}.next-${process.pid}-${randomUUID()}`;
  let failure: unknown;
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (err) {
    failure = err;
  }
  try {
    await removeStagedFile(temp);
  } catch (cleanupError) {
    if (failure !== undefined) throw new AggregateError([failure, cleanupError], "evidence persistence and cleanup failed");
    throw cleanupError;
  }
  if (failure !== undefined) throw failure;
}

export async function probeEvidencePublicationDirectory(path: string): Promise<{
  hardLinkPublication: "passed";
  directorySync: "passed";
  cleanup: "passed";
}> {
  const target = join(path, `.promotion-publication-probe-${process.pid}-${randomUUID()}`);
  const content = `publication-probe-${randomUUID()}\n`;
  try {
    await createExclusiveEvidenceArtifact(target, content);
    if (await readFile(target, "utf8") !== content) throw new Error("publication probe content mismatch");
  } finally {
    try {
      await unlink(target);
      await syncDirectory(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { hardLinkPublication: "passed", directorySync: "passed", cleanup: "passed" };
}

async function removeStagedFile(path: string): Promise<void> {
  try {
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, process.platform === "win32" ? "r+" : "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function commandToken(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}
