// Integration — the MANDATORY offline end-to-end slice: drive the full AP loop
// over HTTP (intake → pending → approve → executed) with injected in-memory
// stores + FakeQwenChatClient + Fake sinks. No database, no key — so this runs on
// a bare clone in CI. It proves the whole vertical slice, including the HITL gate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerDeps } from "../../src/server.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultDecider } from "../../src/ap/decider.js";
import { fakeSinks, type Sinks } from "../../src/ap/sinks.js";

let app: FastifyInstance;
let sinks: Sinks;

before(async () => {
  delete process.env.DASHSCOPE_API_KEY;
  sinks = fakeSinks();
  const deps: ServerDeps = {
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    decider: defaultDecider(),
    sinks,
  };
  app = await buildServer(deps);
  await app.ready();
});

after(async () => {
  await app.close();
});

test("intake → pending → approve → executed, end to end over HTTP", async () => {
  // 1. Intake a clean invoice from a new vendor.
  const intake = await app.inject({
    method: "POST",
    url: "/intake",
    payload: { invoice: { vendor: "Globex", invoice_number: "GX-100", tax_id: "TX-1", subtotal: 500, tax: 100, total: 600, date: "2026-04-01" } },
  });
  assert.equal(intake.statusCode, 200);
  const item = intake.json();
  assert.equal(item.status, "pending");
  assert.equal(item.proposed.tool, "draft_journal_entry");
  assert.equal(item.execution, undefined); // nothing executed at intake

  // 2. It appears in the approval queue.
  const pending = await app.inject({ method: "GET", url: "/pending" });
  assert.equal(pending.json().pending.length, 1);
  assert.equal(pending.json().pending[0].id, item.id);

  // 3. A human approves → the tool executes for real.
  const approve = await app.inject({ method: "POST", url: `/approve/${item.id}` });
  assert.equal(approve.statusCode, 200);
  const approved = approve.json();
  assert.equal(approved.status, "approved");
  assert.ok(approved.execution.ok);
  assert.equal(sinks.ledger.entries().length, 1); // the real side-effect fired

  // 4. The queue is now empty.
  const after = await app.inject({ method: "GET", url: "/pending" });
  assert.equal(after.json().pending.length, 0);
});

test("amend over HTTP: the human's edited args are exactly what execute", async () => {
  const intake = await app.inject({
    method: "POST",
    url: "/intake",
    payload: { invoice: { vendor: "Initech", invoice_number: "IT-7", tax_id: "TX-9", subtotal: 800, tax: 160, total: 960, date: "2026-04-02" } },
  });
  const id = intake.json().id;

  const amend = await app.inject({
    method: "POST",
    url: `/amend/${id}`,
    payload: { args: { expense_account: "Software Licenses", amount: 960 }, reason: "reclassify to licenses" },
  });
  assert.equal(amend.statusCode, 200);
  const item = amend.json();
  assert.equal(item.status, "approved");
  assert.equal(item.amended, true);
  const entry = sinks.ledger.entries().at(-1)!;
  assert.equal(entry.lines.find((l) => l.debit)!.account, "Software Licenses");
});

test("memory grounds the next decision: a re-sent invoice is flagged as a duplicate", async () => {
  const payload = { invoice: { vendor: "Umbrella", invoice_number: "UM-1", tax_id: "TX-2", subtotal: 300, tax: 60, total: 360, date: "2026-04-03" } };
  const first = await app.inject({ method: "POST", url: "/intake", payload });
  await app.inject({ method: "POST", url: `/approve/${first.json().id}` });

  const second = await app.inject({ method: "POST", url: "/intake", payload });
  const item = second.json();
  assert.equal(item.proposed.tool, "flag_for_review");
  assert.ok(item.findings.some((f: { rule: string; passed: boolean }) => f.rule === "R5" && !f.passed));

  // Rejecting the duplicate discards it — no escalation is auto-actioned beyond the flag.
  const reject = await app.inject({ method: "POST", url: `/reject/${item.id}`, payload: { reason: "duplicate" } });
  assert.equal(reject.json().status, "rejected");
});
