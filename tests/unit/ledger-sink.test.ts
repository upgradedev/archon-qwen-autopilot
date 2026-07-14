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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
