// Unit — the ONE real terminal-action sink (SmtpEmailSink).
//
// Proves the two things the human-in-the-loop guarantee rests on:
//   1. When a human approves, the real transport is invoked with EXACTLY the approved
//      args (and, after an amend, the AMENDED args) — nothing else.
//   2. Without a human approval no email is sent; and with no transport configured the
//      sink cleanly SIMULATES (records + logs, sends nothing) so the offline path is
//      safe. A transport-submission failure PROPAGATES and is never silent.
//
// The transport is a mock (MailTransport seam) — no network, no SMTP server. This is
// the same seam a real nodemailer transport plugs into via SmtpEmailSink.fromEnv().

import { test } from "node:test";
import assert from "node:assert/strict";
import { SmtpEmailSink, type MailTransport } from "../../src/ap/smtp-sink.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks } from "../../src/ap/sinks.js";
import { AutopilotAgent } from "../../src/agents/autopilot-agent.js";
import type { RawInvoice } from "../../src/types.js";

delete process.env.DASHSCOPE_API_KEY; // deterministic offline Fakes for the decider

// A recording mock transport — captures every sendMail call so a test can assert the
// EXACT message the real SMTP transport would have been handed.
function recordingTransport(): MailTransport & { sent: Array<Record<string, string>> } {
  const sent: Array<Record<string, string>> = [];
  return {
    sent,
    async sendMail(message) {
      sent.push({ ...message });
      return { messageId: `mock-${sent.length}` };
    },
  };
}

const quietLogger = { log() {}, warn() {} };

test("SIMULATE mode (no transport) records to the outbox and sends nothing", async () => {
  const logs: string[] = [];
  const sink = new SmtpEmailSink({ from: "ap@acme.test", logger: { log: (m: string) => logs.push(m), warn() {} } });
  assert.equal(sink.live, false, "no transport → not live (simulate mode)");

  const rec = await sink.send({ to: "vendor@x.test", subject: "Q", body: "please confirm" });
  assert.equal(rec.subject, "Q");
  assert.equal(sink.outbox().length, 1, "the intent is recorded for inspection");
  assert.ok(logs.some((l) => /SIMULATED/.test(l)), "simulate mode announces it sent nothing");
});

test("REAL mode submits to the transport with exactly the given message; acceptance does not claim recipient delivery", async () => {
  const transport = recordingTransport();
  const sink = new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger });
  assert.equal(sink.live, true, "a wired transport → live");

  await sink.send({ to: "vendor@x.test", subject: "Missing tax id", body: "Please send your tax id." });
  assert.equal(transport.sent.length, 1, "the real transport was invoked once");
  assert.deepEqual(transport.sent[0], {
    from: "ap@acme.test",
    to: "vendor@x.test",
    subject: "Missing tax id",
    text: "Please send your tax id.",
  });
});

test("REAL mode tolerates a transport that returns no messageId (still records + resolves)", async () => {
  const transport: MailTransport = { async sendMail() { return {}; } }; // no messageId
  const sink = new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger });
  const rec = await sink.send({ to: "v@x.test", subject: "s", body: "b" });
  assert.equal(rec.subject, "s");
  assert.equal(sink.outbox().length, 1);
});

test("a transport submission failure PROPAGATES (never silently swallowed) but the intent is still recorded", async () => {
  const transport: MailTransport = {
    async sendMail() {
      throw new Error("SMTP 550 mailbox unavailable");
    },
  };
  const sink = new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger });
  await assert.rejects(() => sink.send({ to: "v@x.test", subject: "s", body: "b" }), /550 mailbox unavailable/);
  assert.equal(sink.outbox().length, 1, "the approved intent is recorded even though SMTP submission failed");
});

test("fromEnv: no SMTP_HOST → null (caller falls back to the Fake); SMTP_HOST set → a live sink", () => {
  const saved = { ...process.env };
  try {
    delete process.env.SMTP_HOST;
    assert.equal(SmtpEmailSink.fromEnv(), null, "unconfigured → null, so deps uses the Fake email sink");

    const sink = SmtpEmailSink.fromEnv({
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "587",
      SMTP_USER: "ap@acme.test",
      SMTP_PASS: "secret",
      SMTP_FROM: "billing@acme.test",
    } as NodeJS.ProcessEnv);
    assert.ok(sink, "SMTP_HOST set → a sink is built");
    assert.equal(sink!.live, true, "the env-built sink carries a real transport");

    assert.throws(
      () => SmtpEmailSink.fromEnv({ SMTP_HOST: "smtp.bare.test" } as NodeJS.ProcessEnv),
      /SMTP_FROM.*SMTP_USER fallback/i,
      "a bare host must fail closed instead of constructing a live sink with a blank From"
    );
    for (const invalid of [
      { SMTP_HOST: "smtp.example.test", SMTP_FROM: "ap@example.test", SMTP_PORT: "NaN" },
      { SMTP_HOST: "smtp.example.test", SMTP_FROM: "ap@example.test", SMTP_PORT: "70000" },
      { SMTP_HOST: "smtp.example.test", SMTP_FROM: "ap@example.test", SMTP_USER: "ap@example.test" },
      { SMTP_HOST: "smtp.example.test", SMTP_FROM: "ap@example.test", SMTP_PASS: "secret" },
      { SMTP_HOST: "smtp.example.test", SMTP_FROM: "ap@example.test", SMTP_SECURE: "sometimes" },
      { SMTP_CONNECTION_TIMEOUT_MS: "5000" },
    ]) {
      assert.throws(() => SmtpEmailSink.fromEnv(invalid as NodeJS.ProcessEnv), /invalid SMTP configuration/i);
    }

    assert.throws(
      () => new SmtpEmailSink({ from: "safe@example.test\r\nBcc: hidden@example.test" }),
      /safe non-empty header value/i,
      "direct construction cannot inject SMTP headers through From"
    );
  } finally {
    process.env = saved;
  }
});

// ── The end-to-end HITL guarantee through the AGENT, using the real sink ──────────

const CLEAN_MISSING_TAXID: RawInvoice = {
  // Missing tax_id + a subtotal/tax/total that do not reconcile → the honest decision
  // for a new vendor is draft_vendor_reply, which routes through the email sink.
  vendor: "Northwind Traders",
  invoice_number: "NW-42",
  subtotal: 100,
  tax: 20,
  total: 200,
};

function agentWith(sink: SmtpEmailSink): AutopilotAgent {
  const sinks = fakeSinks();
  sinks.email = sink;
  return new AutopilotAgent(new FakeEmbedder(), new InMemoryStore(), new InMemoryWorkItemStore(), defaultLoop(), sinks);
}

test("no approval → the real sink is NEVER invoked (intake alone sends nothing)", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_MISSING_TAXID);
  assert.equal(item.status, "pending", "intake only proposes — it never executes");
  assert.equal(item.proposed.tool, "draft_vendor_reply");
  assert.equal(transport.sent.length, 0, "no email left the building without a human approval");
});

test("plain approve cannot send a model-selected recipient", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_MISSING_TAXID);
  assert.equal(transport.sent.length, 0, "still nothing before approval");

  await assert.rejects(() => agent.approve(item.id), /to must be a non-empty string/i);
  assert.equal(transport.sent.length, 0, "a verified reviewer recipient is required before transport submission");
});

test("amend() then approve → the real sink submits the AMENDED args, not the original", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_MISSING_TAXID);
  const editedBody = "Human-edited: please also confirm the correct VAT so subtotal + tax = total.";
  await agent.amend(item.id, {
    args: { to: "verified-vendor@example.test", body: editedBody },
    by: "reviewer@acme.test",
    reason: "verified recipient and clarified the reconciliation gap",
  });

  assert.equal(transport.sent.length, 1, "the amend-approve invoked the SMTP transport exactly once");
  assert.equal(transport.sent[0]!.to, "verified-vendor@example.test");
  assert.equal(transport.sent[0]!.text, editedBody, "the transport receives exactly the human-approved amended body");
});
