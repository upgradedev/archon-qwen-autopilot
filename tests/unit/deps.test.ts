// Unit — the default dependency wiring (deps.ts).
//
// The one place both entry points (HTTP + MCP) build the runtime graph, so its
// environment-driven sink selection must be pinned: with no env, ledger + email are the
// in-memory Fakes; with SMTP_HOST / LEDGER_JSONL_PATH set, the two REAL terminal-action
// sinks are promoted (still behind the identical human gate). This locks the Part-A
// "the agent actually executes" wiring so a refactor can't silently drop a real sink.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSinks, resolveDeps } from "../../src/deps.js";
import { FakeEmailSink, FakeLedgerSink } from "../../src/ap/sinks.js";
import { SmtpEmailSink } from "../../src/ap/smtp-sink.js";
import { JsonlLedgerSink } from "../../src/ap/ledger-sink.js";
import { resolveDatabasePoolConfig } from "../../src/db/client.js";

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
    process.env.SMTP_FROM = "ap@example.test";
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
    process.env.SMTP_FROM = "ap@example.test";
    delete process.env.LEDGER_JSONL_PATH;
    const s = defaultSinks();
    assert.ok(s.email instanceof SmtpEmailSink, "SMTP_HOST set → real email sink");
    assert.ok(s.ledger instanceof FakeLedgerSink, "no LEDGER_JSONL_PATH → Fake ledger sink");
  } finally {
    process.env = saved;
  }
});

test("production fails closed instead of silently selecting Fake Qwen or in-memory stores", () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.ALLOW_FAKE_QWEN;
    delete process.env.ALLOW_IN_MEMORY_STORE;
    assert.throws(() => resolveDeps(), /production requires DASHSCOPE_API_KEY/);

    process.env.ALLOW_FAKE_QWEN = "true";
    assert.throws(() => resolveDeps(), /production requires DATABASE_URL/);

    process.env.ALLOW_IN_MEMORY_STORE = "true";
    const resolved = resolveDeps();
    assert.match(resolved.embedder.modelId, /fake/i);
  } finally {
    process.env = saved;
  }
});

test("PostgreSQL pool limits are canonical, bounded, and server timeout never exceeds the client", () => {
  assert.deepEqual(resolveDatabasePoolConfig({}), {
    max: 5,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
  assert.deepEqual(resolveDatabasePoolConfig({
    PGPOOL_MAX: "10",
    PG_CONNECT_TIMEOUT_MS: "5000",
    PG_QUERY_TIMEOUT_MS: "60000",
    PG_STATEMENT_TIMEOUT_MS: "45000",
  }), {
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 60_000,
    statement_timeout: 45_000,
  });
  for (const invalid of ["-1", "1.5", "01", "NaN", " 5", "5 ", "999999999999999999999"]) {
    assert.throws(() => resolveDatabasePoolConfig({ PGPOOL_MAX: invalid }), /PGPOOL_MAX/);
  }
  assert.throws(() => resolveDatabasePoolConfig({ PG_CONNECT_TIMEOUT_MS: "99" }), /PG_CONNECT_TIMEOUT_MS/);
  assert.throws(() => resolveDatabasePoolConfig({ PG_QUERY_TIMEOUT_MS: "1000", PG_STATEMENT_TIMEOUT_MS: "1001" }), /must not exceed/);
});
