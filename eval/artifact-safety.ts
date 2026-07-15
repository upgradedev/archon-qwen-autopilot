import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  toSafeOperationalError,
  type OperationalErrorCode,
} from "../src/security/operational-error.js";
import { PromotionEnvironmentError } from "./promotion-environment.js";

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
  const category: OperationalErrorCode = normalizedCode === "ABORT_ERR"
    ? "timeout"
    : ["ENOTFOUND", "EAI_AGAIN"].includes(normalizedCode)
      ? "provider_unavailable"
      : safe.code;
  const providerSdkError = knownSdkCodes.has(normalizedCode);
  const source = category === "storage_unavailable"
    ? "storage"
    : category === "delivery_unavailable"
      ? "delivery"
      : providerSdkError
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
    const ledgerPath = await realpath(resolve(root, "eval", "results", "evidence-ledger.json"));
    if (relative(root, ledgerPath).replace(/\\/g, "/") !== "eval/results/evidence-ledger.json") {
      throw new PromotionEnvironmentError("promotion_artifact_invalid");
    }
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      schemaVersion?: unknown;
      attempts?: Array<{ path?: unknown }>;
    };
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.attempts)) {
      throw new PromotionEnvironmentError("promotion_artifact_invalid");
    }
    if (ledger.attempts.some((entry) => entry.path === rel)) {
      throw new PromotionEnvironmentError("promotion_artifact_exists");
    }
    const priorAttempts = ledger.attempts
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

// A previous attempt—successful or partial—is evidence and must never be
// replaced. Only the creating process may update the path after this exclusive
// first write; a retry must select a fresh, attempt-qualified filename.
export async function createExclusiveEvidenceArtifact(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

// Progress updates are whole-file atomic replacements in the same directory.
// A crash can leave an orphan temp sibling, but never a truncated/invalid attempt
// at the authoritative path; the previous fsynced JSON remains parseable.
export async function persistEvidenceArtifact(path: string, content: string): Promise<void> {
  const temp = `${path}.next-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (err) {
    // Windows/filesystems may not expose directory fsync. File fsync + same-dir
    // atomic rename still preserves parseable content; POSIX fsync errors surface.
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) return;
    throw err;
  }
}

function commandToken(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}
