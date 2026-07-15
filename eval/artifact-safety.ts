import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
  toSafeOperationalError,
  type OperationalErrorCode,
} from "../src/security/operational-error.js";

export interface CategoricalEvalError {
  category: OperationalErrorCode;
  summary: string;
}

// Provider exceptions can contain credentials, response bodies, request URLs,
// local paths, or stacks. Evaluation artifacts retain only a fixed taxonomy and
// allowlisted message; raw exception text never crosses this boundary.
export function categoricalEvalError(err: unknown): CategoricalEvalError {
  const safe = toSafeOperationalError(err, "evaluation");
  return { category: safe.code, summary: safe.message };
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
  return ["node", script, ...args].map(commandToken).join(" ");
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
