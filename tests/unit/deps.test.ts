// Unit — the default dependency wiring (deps.ts).
//
// The one place both entry points (HTTP + MCP) build the runtime graph, so its
// environment-driven sink selection must be pinned: with no env, ledger + email are the
// in-memory Fakes; with SMTP_HOST / LEDGER_JSONL_PATH set, the two REAL terminal-action
// sinks are promoted (still behind the identical human gate). This locks the Part-A
// "the agent actually executes" wiring so a refactor can't silently drop a real sink.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSinks } from "../../src/deps.js";
import { FakeEmailSink, FakeLedgerSink } from "../../src/ap/sinks.js";
import { SmtpEmailSink } from "../../src/ap/smtp-sink.js";
import { JsonlLedgerSink } from "../../src/ap/ledger-sink.js";

test("defaultSinks(): unconfigured env → in-memory Fake email + ledger sinks", () => {
  const saved = { ...process.env };
  try {
    delete process.env.SMTP_HOST;
    delete process.env.LEDGER_JSONL_PATH;
    const s = defaultSinks();
    assert.ok(s.email instanceof FakeEmailSink, "no SMTP_HOST → Fake email sink");
    assert.ok(s.ledger instanceof FakeLedgerSink, "no LEDGER_JSONL_PATH → Fake ledger sink");
  } finally {
    process.env = saved;
  }
});

test("defaultSinks(): SMTP_HOST + LEDGER_JSONL_PATH set → both REAL sinks are promoted", () => {
  const saved = { ...process.env };
  try {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.LEDGER_JSONL_PATH = "/tmp/archon-readiness-unused.jsonl"; // never written (no post() here)
    const s = defaultSinks();
    assert.ok(s.email instanceof SmtpEmailSink, "SMTP_HOST set → real SMTP email sink");
    assert.ok(s.ledger instanceof JsonlLedgerSink, "LEDGER_JSONL_PATH set → real JSONL ledger sink");
    // Payment + review sinks are always the in-memory Fakes (unchanged).
    assert.equal(typeof s.payments.record, "function");
    assert.equal(typeof s.reviews.raise, "function");
  } finally {
    process.env = saved;
  }
});

test("defaultSinks(): only SMTP_HOST set → real email, Fake ledger (each sink is independent)", () => {
  const saved = { ...process.env };
  try {
    process.env.SMTP_HOST = "smtp.example.test";
    delete process.env.LEDGER_JSONL_PATH;
    const s = defaultSinks();
    assert.ok(s.email instanceof SmtpEmailSink, "SMTP_HOST set → real email sink");
    assert.ok(s.ledger instanceof FakeLedgerSink, "no LEDGER_JSONL_PATH → Fake ledger sink");
  } finally {
    process.env = saved;
  }
});
