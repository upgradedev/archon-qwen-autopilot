// Unit — the SECOND real terminal-action sink (JsonlLedgerSink).
//
// Proves the same guarantees the SMTP sink proves, for the ledger:
//   1. When a human approves, the real transport is appended with EXACTLY the approved
//      journal entry (and, after an amend, the AMENDED entry) — nothing else.
//   2. Without a human approval nothing is written; with no transport configured the
//      sink cleanly SIMULATES (records + logs, writes nothing) so the offline path is
//      safe. A write failure PROPAGATES so a failed append is never silent.
//   3. The REAL fs transport is exercised for real against a temp file — an append is
//      cheap (no network), so we verify durable, one-object-per-line JSONL on disk.
//
// The transport is a mock (LedgerTransport seam) except in the fs test — the same seam
// the real file appender plugs into via JsonlLedgerSink.fromEnv().

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLedgerSink, createJsonlTransport, type LedgerTransport } from "../../src/ap/ledger-sink.js";
import type { LedgerEntry } from "../../src/ap/sinks.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { AutopilotAgent } from "../../src/agents/autopilot-agent.js";
import type { RawInvoice } from "../../src/types.js";

delete process.env.DASHSCOPE_API_KEY; // deterministic offline Fakes for the decider

// A recording mock transport — captures every appended line so a test can assert the
// EXACT entry the real fs transport would have written.
function recordingTransport(): LedgerTransport & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    append(line: string) {
      lines.push(line);
    },
  };
}

const quietLogger = { log() {}, warn() {} };

const SAMPLE: Omit<LedgerEntry, "postedAt"> = {
  ref: "INV-1",
  currency: "EUR",
  narrative: "Accrual for Acme invoice INV-1",
  lines: [
    { account: "Office Supplies", debit: 120 },
    { account: "Accounts Payable", credit: 120 },
  ],
};

test("SIMULATE mode (no transport) records to entries() and writes nothing", () => {
  const logs: string[] = [];
  const sink = new JsonlLedgerSink({ logger: { log: (m: string) => logs.push(m), warn() {} } });
  assert.equal(sink.live, false, "no transport → not live (simulate mode)");

  const row = sink.post(SAMPLE);
  assert.equal(row.ref, "INV-1");
  assert.ok(row.postedAt, "the entry is stamped with a postedAt time");
  assert.equal(sink.entries().length, 1, "the intent is recorded for inspection");
  assert.ok(logs.some((l) => /SIMULATED/.test(l)), "simulate mode announces it wrote nothing");
});

test("REAL mode appends over the transport with exactly the given entry (one JSON line)", () => {
  const transport = recordingTransport();
  const sink = new JsonlLedgerSink({ transport, logger: quietLogger });
  assert.equal(sink.live, true, "a wired transport → live");

  const row = sink.post(SAMPLE);
  assert.equal(transport.lines.length, 1, "the real transport was appended to once");
  const written = JSON.parse(transport.lines[0]!) as LedgerEntry;
  assert.deepEqual(written, row, "exactly the recorded entry is what was serialized to the ledger");
  assert.equal(transport.lines[0]!.includes("\n"), false, "the line is a single JSON object with no embedded newline");
});

test("a write failure PROPAGATES (never silently swallowed) but the intent is still recorded", () => {
  const transport: LedgerTransport = {
    append() {
      throw new Error("ENOSPC no space left on device");
    },
  };
  const sink = new JsonlLedgerSink({ transport, logger: quietLogger });
  assert.throws(() => sink.post(SAMPLE), /ENOSPC/);
  assert.equal(sink.entries().length, 1, "the approved intent is recorded even though the append failed");
});

test("REAL fs transport (fromEnv/createJsonlTransport): durable append-only JSONL on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-"));
  const path = join(dir, "nested", "ledger.jsonl"); // nested → also exercises mkdir -p
  try {
    // fromEnv builds the same fs transport; drive it through a quiet-logger sink so the
    // real-fs assertions below carry no stdout noise (fromEnv's null/live is tested separately).
    assert.ok(JsonlLedgerSink.fromEnv({ LEDGER_JSONL_PATH: path } as NodeJS.ProcessEnv), "LEDGER_JSONL_PATH set → a sink is built");
    const sink = new JsonlLedgerSink({ transport: createJsonlTransport(path), logger: quietLogger });
    assert.equal(sink.live, true, "the fs-transport sink is live");

    sink.post(SAMPLE);
    sink.post({ ...SAMPLE, ref: "INV-2" });

    const raw = readFileSync(path, "utf8");
    const parsed = raw.trim().split("\n").map((l) => JSON.parse(l) as LedgerEntry);
    assert.equal(parsed.length, 2, "two approved entries → two durable JSONL lines");
    assert.deepEqual(parsed.map((p) => p.ref), ["INV-1", "INV-2"], "entries are appended in order, one per line");
    assert.ok(parsed[0]!.postedAt && parsed[1]!.postedAt, "each persisted entry carries its postedAt stamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fromEnv: no LEDGER_JSONL_PATH → null (caller falls back to the Fake ledger sink)", () => {
  const saved = { ...process.env };
  try {
    delete process.env.LEDGER_JSONL_PATH;
    assert.equal(JsonlLedgerSink.fromEnv(), null, "unconfigured → null, so deps uses the Fake ledger sink");

    const sink = JsonlLedgerSink.fromEnv({ LEDGER_JSONL_PATH: "  " } as NodeJS.ProcessEnv);
    assert.equal(sink, null, "a blank/whitespace path is treated as unconfigured");
  } finally {
    process.env = saved;
  }
});

test("createJsonlTransport is append-only: a second transport to the same path does not truncate", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-"));
  const path = join(dir, "ledger.jsonl");
  try {
    createJsonlTransport(path).append(JSON.stringify({ ref: "A" }));
    // A brand-new transport (as a process restart would build) must APPEND, not overwrite.
    createJsonlTransport(path).append(JSON.stringify({ ref: "B" }));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l).ref), ["A", "B"], "append-only across transports");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fs ledger idempotency survives a sink/process restart for the same work-item ref", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-restart-"));
  const path = join(dir, "ledger.jsonl");
  try {
    const first = new JsonlLedgerSink({ transport: createJsonlTransport(path), logger: quietLogger });
    first.post(SAMPLE);

    // A fresh sink + transport models a process restart (empty RAM dedupe set).
    const restarted = new JsonlLedgerSink({ transport: createJsonlTransport(path), logger: quietLogger });
    restarted.post(SAMPLE);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "restart retry did not append a second durable effect");
    assert.equal(JSON.parse(lines[0]!).ref, SAMPLE.ref);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed marker deduplicates after the original row ages beyond the bounded tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-old-tail-"));
  const path = join(dir, "ledger.jsonl");
  const previous = process.env.LEDGER_DEDUPE_SCAN_BYTES;
  process.env.LEDGER_DEDUPE_SCAN_BYTES = String(64 * 1024);
  try {
    new JsonlLedgerSink({ transport: createJsonlTransport(path), logger: quietLogger }).post(SAMPLE);
    const filler = createJsonlTransport(path);
    for (let i = 0; i < 90; i++) filler.append(JSON.stringify({ ref: `FILL-${i}`, pad: "x".repeat(1024) }));

    new JsonlLedgerSink({ transport: createJsonlTransport(path), logger: quietLogger }).post(SAMPLE);
    const contents = readFileSync(path, "utf8");
    assert.ok(Buffer.byteLength(contents) > 64 * 1024, "fixture pushes the first row outside the bounded tail");
    const rows = contents.trim().split("\n").map((line) => JSON.parse(line) as { ref: string });
    assert.equal(rows.filter((row) => row.ref === SAMPLE.ref).length, 1, "committed marker prevents an old-row duplicate without an unbounded scan");
  } finally {
    if (previous === undefined) delete process.env.LEDGER_DEDUPE_SCAN_BYTES;
    else process.env.LEDGER_DEDUPE_SCAN_BYTES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markerless legacy row beginning exactly at the bounded-tail start is retained and committed", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-tail-boundary-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const previous = process.env.LEDGER_DEDUPE_SCAN_BYTES;
  const scanBytes = 64 * 1024;
  process.env.LEDGER_DEDUPE_SCAN_BYTES = String(scanBytes);
  try {
    const prefix = `${JSON.stringify({ ref: "PREFIX" })}\n`;
    const target = `${JSON.stringify({ ref: SAMPLE.ref, legacy: true })}\n`;
    const emptyFiller = `${JSON.stringify({ ref: "TAIL", pad: "" })}\n`;
    const filler = `${JSON.stringify({
      ref: "TAIL",
      pad: "x".repeat(scanBytes - Buffer.byteLength(target) - Buffer.byteLength(emptyFiller)),
    })}\n`;
    const exactTail = target + filler;
    assert.equal(Buffer.byteLength(exactTail), scanBytes, "target starts at the exact configured tail boundary");
    writeFileSync(path, prefix + exactTail, "utf8");
    const before = readFileSync(path);

    const appended = createJsonlTransport(path).appendOnce!(SAMPLE.ref, JSON.stringify(SAMPLE));
    assert.equal(appended, false, "the boundary row is recognized as the existing effect");
    assert.deepEqual(readFileSync(path), before, "boundary recovery appends no duplicate row");
    assert.deepEqual(
      JSON.parse(readFileSync(marker, "utf8")),
      { schemaVersion: 1, state: "committed", ref: SAMPLE.ref },
      "the markerless row is re-durabilized before its committed marker is created",
    );
  } finally {
    if (previous === undefined) delete process.env.LEDGER_DEDUPE_SCAN_BYTES;
    else process.env.LEDGER_DEDUPE_SCAN_BYTES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy row that crosses the bounded-tail start remains an excluded first fragment", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-tail-fragment-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const previous = process.env.LEDGER_DEDUPE_SCAN_BYTES;
  const scanBytes = 64 * 1024;
  process.env.LEDGER_DEDUPE_SCAN_BYTES = String(scanBytes);
  try {
    const crossingRow = `${JSON.stringify({ ref: SAMPLE.ref, pad: "x".repeat(scanBytes) })}\n`;
    const completeTailRow = `${JSON.stringify({ ref: "TAIL" })}\n`;
    writeFileSync(path, crossingRow + completeTailRow, "utf8");
    const initialSize = readFileSync(path).length;
    const tailStart = initialSize - scanBytes;
    assert.ok(
      tailStart > 0 && tailStart < Buffer.byteLength(crossingRow),
      "configured tail starts strictly inside the oversized first row",
    );

    const appended = createJsonlTransport(path).appendOnce!(SAMPLE.ref, JSON.stringify(SAMPLE));
    assert.equal(appended, true, "a row beginning outside the bounded evidence window is not treated as confirmation");
    const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { ref: string });
    assert.equal(rows.filter((row) => row.ref === SAMPLE.ref).length, 2, "the excluded fragment did not cause false deduplication");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "committed", "the new complete append owns the marker");
  } finally {
    if (previous === undefined) delete process.env.LEDGER_DEDUPE_SCAN_BYTES;
    else process.env.LEDGER_DEDUPE_SCAN_BYTES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reserved marker without a confirmed row stays fail-closed after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-reserved-"));
  const path = join(dir, "ledger.jsonl");
  const markerDir = `${path}.refs`;
  const marker = join(markerDir, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, state: "reserved", ref: SAMPLE.ref })}\n`, "utf8");
    const transport = createJsonlTransport(path);
    assert.throws(
      () => transport.appendOnce!(SAMPLE.ref, JSON.stringify(SAMPLE)),
      /reservation exists without a confirmed row/,
    );
    assert.equal(existsSync(path), false, "uncertain reservation never opens a duplicate append path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash after durable append but before promotion self-heals reserved → committed", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-promote-"));
  const path = join(dir, "ledger.jsonl");
  const markerDir = `${path}.refs`;
  const marker = join(markerDir, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  try {
    const transport = createJsonlTransport(path);
    transport.append(JSON.stringify(SAMPLE));
    writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, state: "reserved", ref: SAMPLE.ref })}\n`, "utf8");

    assert.equal(transport.appendOnce!(SAMPLE.ref, JSON.stringify(SAMPLE)), false);
    const state = JSON.parse(readFileSync(marker, "utf8")) as { state: string; ref: string };
    assert.deepEqual(state, { schemaVersion: 1, state: "committed", ref: SAMPLE.ref });
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1, "confirmed crash state is deduped, not appended again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const fault of [
  {
    name: "short",
    write(fd: number, buffer: Buffer): number {
      // Strong boundary case: the JSON object reaches disk, but its required JSONL
      // newline does not. That unterminated row is not proof of a completed append.
      return writeSync(fd, buffer.subarray(0, buffer.length - 1));
    },
  },
  {
    name: "zero",
    write(): number {
      return 0;
    },
  },
] as const) {
  test(`${fault.name} ledger write stays reserved and a restart retry remains fail-closed`, () => {
    const dir = mkdtempSync(join(tmpdir(), `archon-ledger-${fault.name}-write-`));
    const path = join(dir, "ledger.jsonl");
    const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
    const serialized = JSON.stringify(SAMPLE);
    try {
      const faulted = createJsonlTransport(path, { writeSync: fault.write });
      assert.throws(
        () => faulted.appendOnce!(SAMPLE.ref, serialized),
        /ledger append was incomplete; explicit reconciliation is required/,
      );
      assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "failed write never promotes its marker");

      const partialLedger = readFileSync(path);
      assert.equal(
        partialLedger.length,
        fault.name === "short" ? Buffer.byteLength(serialized) : 0,
        "fault injector produced the intended incomplete ledger state",
      );

      const restarted = createJsonlTransport(path);
      assert.throws(
        () => restarted.appendOnce!(SAMPLE.ref, serialized),
        /reservation exists without a confirmed row/,
        "an ambiguous write never reopens a duplicate append path",
      );
      assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "retry cannot promote ambiguous evidence");
      assert.deepEqual(readFileSync(path), partialLedger, "retry leaves the partial ledger untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("full write plus fsync failure is re-durabilized before reserved → committed recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-fsync-failure-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const serialized = JSON.stringify(SAMPLE);
  let injectedFsyncCalls = 0;
  const injectedFailure = /injected ledger fsync failure/;
  try {
    const faulted = createJsonlTransport(path, {
      fsyncSync() {
        injectedFsyncCalls += 1;
        throw new Error("injected ledger fsync failure");
      },
    });

    assert.throws(() => faulted.appendOnce!(SAMPLE.ref, serialized), injectedFailure);
    assert.equal(injectedFsyncCalls, 1, "the complete O_APPEND write reached its first durability barrier");
    const completeRow = readFileSync(path);
    assert.equal(completeRow.toString("utf8"), `${serialized}\n`, "the fault occurs after a full newline-complete write");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "failed fsync cannot promote the marker");

    assert.throws(
      () => faulted.appendOnce!(SAMPLE.ref, serialized),
      injectedFailure,
      "recovery also requires a successful durability barrier before promotion",
    );
    assert.equal(injectedFsyncCalls, 2, "recovery fsyncs the already-open ledger descriptor");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "failed recovery fsync remains fail-closed");
    assert.deepEqual(readFileSync(path), completeRow, "failed recovery never appends a duplicate row");

    const restarted = createJsonlTransport(path);
    assert.equal(restarted.appendOnce!(SAMPLE.ref, serialized), false, "durable recovery recognizes the existing effect");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "committed", "promotion follows successful re-durabilization");
    assert.deepEqual(readFileSync(path), completeRow, "successful recovery still appends no duplicate row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncate during recovery fsync cannot promote a previously parsed ledger row", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-recovery-truncate-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const serialized = JSON.stringify(SAMPLE);
  try {
    const interrupted = createJsonlTransport(path, {
      fsyncSync() {
        throw new Error("injected initial fsync failure");
      },
    });
    assert.throws(() => interrupted.appendOnce!(SAMPLE.ref, serialized), /injected initial fsync failure/);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved");

    const recovery = createJsonlTransport(path, {
      fsyncSync(fd) {
        ftruncateSync(fd, 0);
        fsyncSync(fd);
      },
    });
    assert.throws(
      () => recovery.appendOnce!(SAMPLE.ref, serialized),
      /ledger changed while checking its idempotency tail/,
      "post-fsync same-descriptor revalidation catches the truncated evidence",
    );
    assert.equal(readFileSync(path).length, 0, "the injector removed the row after it was parsed");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "ambiguous recovery cannot promote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-size overwrite during recovery fsync cannot promote stale parsed bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-recovery-overwrite-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const serialized = JSON.stringify(SAMPLE);
  try {
    const interrupted = createJsonlTransport(path, {
      fsyncSync() {
        throw new Error("injected initial fsync failure");
      },
    });
    assert.throws(() => interrupted.appendOnce!(SAMPLE.ref, serialized), /injected initial fsync failure/);
    const originalLength = readFileSync(path).length;

    const recovery = createJsonlTransport(path, {
      fsyncSync(fd) {
        const replacement = Buffer.alloc(originalLength, 0x78);
        assert.equal(writeSync(fd, replacement, 0, replacement.length, 0), replacement.length);
        fsyncSync(fd);
      },
    });
    assert.throws(
      () => recovery.appendOnce!(SAMPLE.ref, serialized),
      /ledger changed while checking its idempotency tail/,
      "post-fsync byte revalidation catches an overwrite even when inode and size are unchanged",
    );
    assert.equal(readFileSync(path).length, originalLength, "the adversarial overwrite preserved the original file size");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "stale parsed bytes cannot promote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unlink during recovery fsync cannot promote a row from an unreachable descriptor", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-recovery-unlink-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const serialized = JSON.stringify(SAMPLE);
  try {
    const interrupted = createJsonlTransport(path, {
      fsyncSync() {
        throw new Error("injected initial fsync failure");
      },
    });
    assert.throws(() => interrupted.appendOnce!(SAMPLE.ref, serialized), /injected initial fsync failure/);

    const recovery = createJsonlTransport(path, {
      fsyncSync(fd) {
        fsyncSync(fd);
        unlinkSync(path);
      },
    });
    assert.throws(
      () => recovery.appendOnce!(SAMPLE.ref, serialized),
      /ledger changed while checking its idempotency tail/,
      "path resolution must still reach the parsed descriptor after the barrier",
    );
    assert.equal(existsSync(path), false, "the parsed descriptor was unlinked during recovery");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "an unreachable ledger cannot promote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a concurrent append during recovery fsync preserves valid dedupe evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "archon-ledger-recovery-append-"));
  const path = join(dir, "ledger.jsonl");
  const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
  const serialized = JSON.stringify(SAMPLE);
  const concurrentRow = `${JSON.stringify({ ref: "CONCURRENT" })}\n`;
  try {
    const interrupted = createJsonlTransport(path, {
      fsyncSync() {
        throw new Error("injected initial fsync failure");
      },
    });
    assert.throws(() => interrupted.appendOnce!(SAMPLE.ref, serialized), /injected initial fsync failure/);

    const recovery = createJsonlTransport(path, {
      fsyncSync(fd) {
        writeFileSync(path, concurrentRow, { encoding: "utf8", flag: "a" });
        fsyncSync(fd);
      },
    });
    assert.equal(recovery.appendOnce!(SAMPLE.ref, serialized), false, "growth does not invalidate unchanged evidence bytes");
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "committed");
    assert.equal(
      readFileSync(path, "utf8"),
      `${serialized}\n${concurrentRow}`,
      "recovery preserves both the confirmed effect and the concurrent append",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "path replacement during recovery fsync cannot promote a row from the detached ledger inode",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "archon-ledger-recovery-replace-"));
    const path = join(dir, "ledger.jsonl");
    const detached = join(dir, "ledger.detached.jsonl");
    const marker = join(`${path}.refs`, createHash("sha256").update(SAMPLE.ref, "utf8").digest("hex"));
    const serialized = JSON.stringify(SAMPLE);
    try {
      const interrupted = createJsonlTransport(path, {
        fsyncSync() {
          throw new Error("injected initial fsync failure");
        },
      });
      assert.throws(() => interrupted.appendOnce!(SAMPLE.ref, serialized), /injected initial fsync failure/);
      const original = readFileSync(path);

      const recovery = createJsonlTransport(path, {
        fsyncSync(fd) {
          fsyncSync(fd);
          renameSync(path, detached);
          writeFileSync(path, original);
        },
      });
      assert.throws(
        () => recovery.appendOnce!(SAMPLE.ref, serialized),
        /ledger changed while checking its idempotency tail/,
        "byte-identical replacement still fails the path-to-descriptor identity check",
      );
      assert.deepEqual(readFileSync(detached), original, "the parsed row remains on the now-detached inode");
      assert.deepEqual(readFileSync(path), original, "the replacement deliberately carries identical bytes");
      assert.equal(JSON.parse(readFileSync(marker, "utf8")).state, "reserved", "path swap cannot promote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── The end-to-end HITL guarantee through the AGENT, using the real ledger sink ──────

const CLEAN_KNOWN_VENDOR: RawInvoice = {
  // A clean, reconciling invoice for a NEW vendor → the honest decision is
  // draft_journal_entry (accrue), which routes through the ledger sink.
  vendor: "Acme Supplies",
  invoice_number: "AC-100",
  tax_id: "TX-900",
  subtotal: 100,
  tax: 20,
  total: 120,
  currency: "EUR",
  date: "2026-03-01",
};

function agentWith(sink: JsonlLedgerSink): AutopilotAgent {
  const sinks = fakeSinks();
  sinks.ledger = sink;
  return new AutopilotAgent(new FakeEmbedder(), new InMemoryStore(), new InMemoryWorkItemStore(), defaultLoop(), sinks);
}

test("no approval → the real ledger sink is NEVER written (intake alone posts nothing)", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new JsonlLedgerSink({ transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_KNOWN_VENDOR);
  assert.equal(item.status, "pending", "intake only proposes — it never executes");
  assert.equal(item.proposed.tool, "draft_journal_entry");
  assert.equal(transport.lines.length, 0, "no entry was written without a human approval");
});

test("approve() → the real ledger sink is appended ONCE with a balanced entry for the invoice", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new JsonlLedgerSink({ transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_KNOWN_VENDOR);
  assert.equal(transport.lines.length, 0, "still nothing before approval");

  await agent.approve(item.id);
  assert.equal(transport.lines.length, 1, "approval wrote exactly one real ledger entry");
  const written = JSON.parse(transport.lines[0]!) as LedgerEntry;
  assert.equal(written.ref, item.id, "the persisted entry uses the server work-item idempotency key");
  const debit = written.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credit = written.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  assert.equal(debit, credit, "the persisted double-entry balances");
});
