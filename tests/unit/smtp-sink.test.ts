// Unit — the ONE real terminal-action sink (SmtpEmailSink).
//
// Proves the two things the human-in-the-loop guarantee rests on:
//   1. When a human approves, the real transport is invoked with EXACTLY the approved
//      args (and, after an amend, the AMENDED args) — nothing else.
//   2. Without a human approval no email is sent; and with no transport configured the
//      sink cleanly SIMULATES (records + logs, sends nothing) so the offline path is
//      safe. A delivery failure PROPAGATES so a failed send is never silent.
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

test("REAL mode delivers over the transport with exactly the given message", async () => {
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

test("a delivery failure PROPAGATES (never silently swallowed) but the intent is still recorded", async () => {
  const transport: MailTransport = {
    async sendMail() {
      throw new Error("SMTP 550 mailbox unavailable");
    },
  };
  const sink = new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger });
  await assert.rejects(() => sink.send({ to: "v@x.test", subject: "s", body: "b" }), /550 mailbox unavailable/);
  assert.equal(sink.outbox().length, 1, "the approved intent is recorded even though delivery failed");
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

    // Bare host only → the port/from/secure/auth defaults path is taken (no throw).
    const bare = SmtpEmailSink.fromEnv({ SMTP_HOST: "smtp.bare.test" } as NodeJS.ProcessEnv);
    assert.ok(bare && bare.live, "a bare SMTP_HOST still yields a live sink via defaults");
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

test("approve() → the real sink is invoked ONCE with exactly the PROPOSED args", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_MISSING_TAXID);
  assert.equal(transport.sent.length, 0, "still nothing before approval");

  await agent.approve(item.id);
  assert.equal(transport.sent.length, 1, "approval delivered exactly one real email");
  assert.equal(transport.sent[0]!.from, "ap@acme.test");
  assert.equal(transport.sent[0]!.subject, item.proposed.args["subject"], "the approved subject is what was sent");
  assert.equal(transport.sent[0]!.text, item.proposed.args["body"], "the approved body is what was sent");
});

test("amend() then approve → the real sink sends the AMENDED args, not the original", async () => {
  const transport = recordingTransport();
  const agent = agentWith(new SmtpEmailSink({ from: "ap@acme.test", transport, logger: quietLogger }));

  const item = await agent.intake(CLEAN_MISSING_TAXID);
  const editedBody = "Human-edited: please also confirm the correct VAT so subtotal + tax = total.";
  await agent.amend(item.id, { args: { body: editedBody }, by: "reviewer@acme.test", reason: "clarify the reconciliation gap" });

  assert.equal(transport.sent.length, 1, "the amend-approve delivered exactly one email");
  assert.equal(transport.sent[0]!.text, editedBody, "what the human approved (the amended body) is exactly what was sent");
});
