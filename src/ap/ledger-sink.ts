// JsonlLedgerSink — the SECOND real terminal-action sink.
//
// The first real sink is SmtpEmailSink (smtp-sink.ts): once a human approves a
// `draft_vendor_reply`, the configured SMTP transport accepts the message (not proof
// of recipient delivery). This one is its ledger twin: once a human approves a
// `draft_journal_entry`, the approved double-entry accrual is
// appended — durably, one JSON object per line — to a real JSONL ledger file on disk.
// Nothing else about the human-in-the-loop gate changes: `post()` is only ever reached
// from the `draft_journal_entry` tool's `execute()`, which only runs from
// `AutopilotAgent`'s `approve()` / `amend()` chokepoint. The model can never reach this
// code; a person must approve first, and the EXACT approved entry is what gets written.
//
// Two modes, chosen by environment, so it is safe everywhere (identical shape to the
// SMTP sink so the two real sinks read the same):
//   • REAL     — `LEDGER_JSONL_PATH` is set → a file-append transport is built and the
//                entry is actually written to disk. A write error PROPAGATES (it is not
//                swallowed), so a failed append leaves the work item `executing` for
//                explicit reconciliation; it is never automatically retried.
//   • SIMULATE — no transport (no path / CI / tests without a mock) → the entry is
//                recorded to the inspectable in-memory list and logged as "simulated",
//                and NOTHING is written. This is the clean no-op the offline path relies
//                on (identical to the in-memory FakeLedgerSink's observable behaviour).
//
// The transport is an injectable seam (`LedgerTransport`) so tests drive it with a mock
// and never touch the filesystem, while the real fsync-backed append is isolated in
// one factory. Unlike SMTP (which needs a network + a mock), a file append
// is cheap to exercise for real, so the fs transport is unit-tested against a temp file.
//
// `LedgerSink.post` is synchronous by contract (a durable append is a synchronous,
// fsync-backed write); a Postgres-backed ledger would drop in behind this same
// `LedgerTransport` seam. A write failure throws synchronously and therefore still
// propagates through the async tool `execute()` exactly like the SMTP delivery failure.

import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { LedgerEntry, LedgerSink } from "./sinks.js";

// The minimal transport contract the sink needs — append one already-serialized line.
// Kept narrow on purpose: the sink depends on this, not on the filesystem. A real fs
// appender satisfies it directly and a test supplies a tiny recording mock.
export interface LedgerTransport {
  append(line: string): void;
  // Durable transports can atomically reserve a work-item ref before append.
  // false means that ref is already present and no second line was written.
  appendOnce?(ref: string, line: string): boolean;
}

export interface LedgerSinkOptions {
  // The transport to append through. Absent → SIMULATE mode (record + log, no write).
  transport?: LedgerTransport;
  // Injectable logger (defaults to console) so tests can assert the simulate/append log
  // lines without stdout noise.
  logger?: Pick<typeof console, "log" | "warn">;
}

export class JsonlLedgerSink implements LedgerSink {
  private rows: LedgerEntry[] = [];
  private completedRefs = new Set<string>();
  private readonly transport?: LedgerTransport;
  private readonly logger: Pick<typeof console, "log" | "warn">;

  constructor(opts: LedgerSinkOptions = {}) {
    this.transport = opts.transport;
    this.logger = opts.logger ?? console;
  }

  // True when a real transport is wired — i.e. an approval will actually write to disk.
  get live(): boolean {
    return this.transport !== undefined;
  }

  post(entry: Omit<LedgerEntry, "postedAt">): LedgerEntry {
    if (this.completedRefs.has(entry.ref)) {
      return this.rows.find((r) => r.ref === entry.ref)!;
    }
    const row: LedgerEntry = { ...entry, postedAt: new Date().toISOString() };
    // Record the intent FIRST so `entries()` reflects what a human approved even if the
    // append below throws (the caller sees the failure and can retry) — same ordering
    // guarantee as SmtpEmailSink.
    this.rows.push(row);

    if (!this.transport) {
      // SIMULATE — no path/transport. Nothing is written; the in-memory list holds it.
      this.logger.log(
        `[JsonlLedgerSink] SIMULATED (no LEDGER_JSONL_PATH configured) — would append entry ${row.ref} (${row.lines.length} lines)`
      );
      this.completedRefs.add(row.ref);
      return row;
    }

    // REAL append. The fs transport persists an exclusive idempotency marker keyed
    // by the server work-item UUID, so a new process cannot append the same effect
    // after restart. Custom transports without appendOnce retain the narrow legacy
    // append seam and should provide their own idempotency in production.
    const serialized = JSON.stringify(row);
    const appended = this.transport.appendOnce
      ? this.transport.appendOnce(row.ref, serialized)
      : (this.transport.append(serialized), true);
    this.completedRefs.add(row.ref);
    this.logger.log(
      appended
        ? `[JsonlLedgerSink] appended entry ${row.ref} to the JSONL ledger (${row.lines.length} lines)`
        : `[JsonlLedgerSink] deduplicated already-persisted entry ${row.ref}`
    );
    return row;
  }

  entries(): LedgerEntry[] {
    return this.rows;
  }

  // Build the env-configured sink, or `null` when the ledger path is not set (so the
  // caller falls back to the in-memory FakeLedgerSink). The real file-append transport
  // is created only when LEDGER_JSONL_PATH is present.
  //   LEDGER_JSONL_PATH — absolute or relative path to the append-only JSONL ledger file.
  static fromEnv(env: NodeJS.ProcessEnv = process.env): JsonlLedgerSink | null {
    const path = env.LEDGER_JSONL_PATH?.trim();
    if (!path) return null;
    return new JsonlLedgerSink({ transport: createJsonlTransport(path) });
  }
}

// The single real-fs seam: turn a file path into an append-only JSONL transport. Each
// call writes and fsyncs one line (`<json>\n`), so the ledger is durable and
// crash-safe (append-only, no read-modify-write). `appendOnce` adds a sidecar directory
// of exclusive, SHA-256-named two-phase markers and a bounded legacy-tail scan. A
// durable `reserved` marker is created before append and atomically promoted to
// `committed` only after the ledger append is fsynced. Any append/promote failure
// leaves an explicitly uncertain reservation rather than risking a duplicate retry.
export function createJsonlTransport(
  path: string,
  options: {
    writeSync?: (fd: number, buffer: Buffer) => number;
    fsyncSync?: (fd: number) => void;
  } = {},
): LedgerTransport {
  let ensuredDir = false;
  const markerDir = `${path}.refs`;
  const scanBytes = boundedEnvInt("LEDGER_DEDUPE_SCAN_BYTES", 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);
  const appendWriteSync = options.writeSync ?? writeSync;
  const ledgerFsyncSync = options.fsyncSync ?? fsyncSync;
  const ensureDirs = () => {
    if (ensuredDir) return;
    durableMkdir(dirname(path));
    durableMkdir(markerDir);
    ensuredDir = true;
  };
  return {
    append(line: string): void {
      ensureDirs();
      durableAppend(path, line, appendWriteSync, ledgerFsyncSync);
    },
    appendOnce(ref: string, line: string): boolean {
      ensureDirs();
      const marker = join(markerDir, createHash("sha256").update(ref, "utf8").digest("hex"));

      // A committed marker is authoritative even after its row ages out of the
      // bounded tail. Reserved/legacy markers need row confirmation and otherwise
      // remain fail-closed for explicit reconciliation.
      const existing = readMarkerIfExists(marker, ref);
      if (existing === "committed") return false;
      if (existing) {
        if (tailContainsDurableRef(path, ref, scanBytes, ledgerFsyncSync)) {
          writeCommittedMarker(marker, ref);
          return false;
        }
        throw new Error(`ledger idempotency reservation exists without a confirmed row for ref ${ref}`);
      }

      // Migration path for rows written before sidecar markers existed.
      if (tailContainsDurableRef(path, ref, scanBytes, ledgerFsyncSync)) {
        try {
          createMarker(marker, ref, "committed");
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          return settleExistingMarker(marker, path, ref, scanBytes, ledgerFsyncSync);
        }
        return false;
      }

      try {
        createMarker(marker, ref, "reserved");
      } catch (err) {
        if (isAlreadyExists(err)) {
          return settleExistingMarker(marker, path, ref, scanBytes, ledgerFsyncSync);
        }
        throw err;
      }

      // Once append starts, every failure is ambiguous (write may have reached the
      // file before fsync failed). Preserve `reserved`; never reopen a duplicate path.
      durableAppend(path, line, appendWriteSync, ledgerFsyncSync);
      writeCommittedMarker(marker, ref);
      return true;
    },
  };
}

type MarkerState = "reserved" | "committed" | "legacy";
interface LedgerMarker { schemaVersion: 1; state: Exclude<MarkerState, "legacy">; ref: string }

function markerJson(ref: string, state: LedgerMarker["state"]): string {
  return `${JSON.stringify({ schemaVersion: 1, state, ref } satisfies LedgerMarker)}\n`;
}

function createMarker(path: string, ref: string, state: LedgerMarker["state"]): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, markerJson(ref, state), "utf8");
    fsyncSync(fd);
    fsyncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readMarkerIfExists(path: string, ref: string): MarkerState | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  if (raw.trim() === ref) return "legacy";
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerMarker>;
    if (parsed.schemaVersion === 1 && parsed.ref === ref && (parsed.state === "reserved" || parsed.state === "committed")) {
      return parsed.state;
    }
  } catch {
    // Fixed error below deliberately excludes marker contents.
  }
  throw new Error(`ledger idempotency marker is invalid or bound to another ref`);
}

function settleExistingMarker(
  marker: string,
  ledger: string,
  ref: string,
  scanBytes: number,
  ledgerFsyncSync: (fd: number) => void,
): false {
  const state = readMarkerIfExists(marker, ref);
  if (state === "committed") return false;
  if (state && tailContainsDurableRef(ledger, ref, scanBytes, ledgerFsyncSync)) {
    writeCommittedMarker(marker, ref);
    return false;
  }
  throw new Error(`ledger idempotency reservation exists without a confirmed row for ref ${ref}`);
}

function writeCommittedMarker(path: string, ref: string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, markerJson(ref, "committed"), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } catch (err) {
    try { unlinkSync(temp); } catch { /* best-effort removal of an unpublished temp */ }
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function tailContainsDurableRef(
  path: string,
  ref: string,
  maxBytes: number,
  ledgerFsyncSync: (fd: number) => void,
): boolean {
  let fd: number;
  try {
    // Recovery needs a writable descriptor because fsync on a read-only descriptor
    // is not portable (and fails on Windows). The same r+ descriptor is used for the
    // bounded read and the durability barrier; it never writes or truncates bytes.
    fd = openSync(path, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
  try {
    // Size and content must come from the same opened file. A separate stat(path)
    // followed by open(path) would let a concurrent rename/symlink swap make the
    // bounded dedupe decision against a different ledger inode (TOCTOU).
    const opened = fstatSync(fd, { bigint: true });
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("ledger is too large for a safe bounded idempotency-tail offset");
    }
    const size = Number(opened.size);
    if (size === 0) return false;
    const start = Math.max(0, size - maxBytes);
    // Bounded read plus one look-behind byte: old ledgers cannot turn a retry check
    // into unbounded memory use, while start-1 tells us whether `start` is exactly a
    // JSONL row boundary or falls inside a row that must be discarded.
    const lookBehind = start > 0 ? 1 : 0;
    const readStart = start - lookBehind;
    const length = size - readStart;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(fd, buffer, bytesRead, length - bytesRead, readStart + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    // A concurrent truncation makes the dedupe state ambiguous. Never turn that
    // ambiguity into a false negative that could authorize a duplicate append.
    if (bytesRead !== length) {
      throw new Error("ledger changed while checking its idempotency tail");
    }

    const startsAtRowBoundary = lookBehind === 0 || buffer[0] === 0x0a;
    let text = buffer.subarray(lookBehind).toString("utf8");
    if (!startsAtRowBoundary) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    // Only newline-terminated JSONL records prove a completed append. In particular,
    // a short write that happens to contain the full JSON object but not its trailing
    // newline must leave a reserved marker fail-closed for explicit reconciliation.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return false;
    text = text.slice(0, lastNewline);
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      let parsed: { ref?: unknown };
      try {
        parsed = JSON.parse(raw) as { ref?: unknown };
      } catch {
        // A malformed historical row is not proof that this ref completed.
        continue;
      }
      if (parsed.ref === ref) {
        // A row left behind by a failed/crashed append is only evidence after its
        // data and directory entry are durable again. Use this already-open fd so
        // recovery cannot fsync a different file selected by a later path lookup.
        // Durability failures deliberately propagate and keep the marker reserved.
        ledgerFsyncSync(fd);
        fsyncDirectory(dirname(path));
        // The barrier is an externally observable scheduling point: another writer
        // can truncate/overwrite this inode or replace `path` while fsync is in
        // progress. Revalidate the exact bounded bytes through the same descriptor,
        // then prove that the configured path still resolves to that descriptor's
        // identity. Growth is allowed (another append is harmless); changes to the
        // evidence range, truncation, unlink, or replacement remain fail-closed.
        assertRecoverySnapshotStillCurrent(fd, path, opened, size, readStart, buffer);
        return true;
      }
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

type BigIntFileIdentity = { dev: bigint; ino: bigint };

function assertRecoverySnapshotStillCurrent(
  fd: number,
  path: string,
  opened: BigIntFileIdentity,
  originalSize: number,
  readStart: number,
  expected: Buffer,
): void {
  const minimumSize = BigInt(originalSize);
  const beforeRead = fstatSync(fd, { bigint: true });
  if (!sameFileIdentity(opened, beforeRead) || beforeRead.size < minimumSize) {
    throwLedgerChanged();
  }

  // Keep recovery memory bounded by the configured tail plus one small scratch
  // buffer; do not allocate a second max-tail-sized snapshot for verification.
  const scratch = Buffer.alloc(Math.min(expected.length, 64 * 1024));
  let verified = 0;
  while (verified < expected.length) {
    const wanted = Math.min(scratch.length, expected.length - verified);
    const count = readSync(fd, scratch, 0, wanted, readStart + verified);
    if (
      count !== wanted
      || !scratch.subarray(0, count).equals(expected.subarray(verified, verified + count))
    ) {
      throwLedgerChanged();
    }
    verified += count;
  }

  const afterRead = fstatSync(fd, { bigint: true });
  if (!sameFileIdentity(opened, afterRead) || afterRead.size < minimumSize) {
    throwLedgerChanged();
  }

  let byPath: BigIntFileIdentity;
  try {
    byPath = statSync(path, { bigint: true });
  } catch {
    throwLedgerChanged();
  }
  if (!sameFileIdentity(opened, byPath)) {
    throwLedgerChanged();
  }
}

function sameFileIdentity(left: BigIntFileIdentity, right: BigIntFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function throwLedgerChanged(): never {
  throw new Error("ledger changed while checking its idempotency tail");
}

function durableAppend(
  path: string,
  line: string,
  appendWriteSync: (fd: number, buffer: Buffer) => number,
  ledgerFsyncSync: (fd: number) => void,
): void {
  // Encode exactly once, then issue exactly one O_APPEND write. Retrying a short
  // write could interleave JSONL fragments across processes, so any non-total result
  // is ambiguous and must keep appendOnce's durable marker in `reserved` state.
  const buffer = Buffer.from(`${line}\n`, "utf8");
  const fd = openSync(path, "a", 0o600);
  try {
    const bytesWritten = appendWriteSync(fd, buffer);
    if (bytesWritten !== buffer.length) {
      throw new Error("ledger append was incomplete; explicit reconciliation is required");
    }
    ledgerFsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Persist creation of a new ledger file, not only its data blocks. This is the
  // directory half of the usual durable-file protocol on POSIX filesystems.
  fsyncDirectory(dirname(path));
}

/**
 * Recursively create a directory and durably publish every newly-created path
 * component on POSIX. Windows does not expose portable directory fsync semantics;
 * the target Alibaba/Linux container executes the full protocol.
 */
function durableMkdir(path: string): void {
  const absolute = resolve(path);
  const firstCreated = mkdirSync(absolute, { recursive: true });
  if (!firstCreated || process.platform === "win32") return;

  const first = resolve(firstCreated);
  fsyncDirectory(dirname(first));
  const suffix = relative(first, absolute);
  let current = first;
  fsyncDirectory(current);
  if (!suffix) return;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    fsyncDirectory(current);
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isAlreadyExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
