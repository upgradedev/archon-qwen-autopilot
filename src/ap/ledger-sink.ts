// JsonlLedgerSink — the SECOND real terminal-action sink.
//
// The first real sink is SmtpEmailSink (smtp-sink.ts): once a human approves a
// `draft_vendor_reply`, a real email is delivered. This one is its ledger twin: once
// a human approves a `draft_journal_entry`, the approved double-entry accrual is
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
//                swallowed), so a failed append surfaces at the approval call and the
//                work item stays pending for retry instead of being silently lost.
//   • SIMULATE — no transport (no path / CI / tests without a mock) → the entry is
//                recorded to the inspectable in-memory list and logged as "simulated",
//                and NOTHING is written. This is the clean no-op the offline path relies
//                on (identical to the in-memory FakeLedgerSink's observable behaviour).
//
// The transport is an injectable seam (`LedgerTransport`) so tests drive it with a mock
// and never touch the filesystem, while the single real-fs line (`appendFileSync`) is
// isolated in one factory. Unlike SMTP (which needs a network + a mock), a file append
// is cheap to exercise for real, so the fs transport is unit-tested against a temp file.
//
// `LedgerSink.post` is synchronous by contract (a durable append is a synchronous,
// fsync-backed write); a Postgres-backed ledger would drop in behind this same
// `LedgerTransport` seam. A write failure throws synchronously and therefore still
// propagates through the async tool `execute()` exactly like the SMTP delivery failure.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry, LedgerSink } from "./sinks.js";

// The minimal transport contract the sink needs — append one already-serialized line.
// Kept narrow on purpose: the sink depends on this, not on the filesystem. A real fs
// appender satisfies it directly and a test supplies a tiny recording mock.
export interface LedgerTransport {
  append(line: string): void;
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
      return row;
    }

    // REAL append. NOT swallowed: a failure propagates to the tool execute() → approve()
    // so the work item stays pending rather than being marked approved with no entry written.
    this.transport.append(JSON.stringify(row));
    this.logger.log(`[JsonlLedgerSink] appended entry ${row.ref} to the JSONL ledger (${row.lines.length} lines)`);
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
// call writes one line (`<json>\n`) with `appendFileSync`, so the ledger is durable and
// crash-safe (append-only, no read-modify-write). The parent directory is created once
// on first append if missing. Exercised for real in the unit test against a temp file.
export function createJsonlTransport(path: string): LedgerTransport {
  let ensuredDir = false;
  return {
    append(line: string): void {
      if (!ensuredDir) {
        mkdirSync(dirname(path), { recursive: true });
        ensuredDir = true;
      }
      appendFileSync(path, line + "\n", "utf8");
    },
  };
}
