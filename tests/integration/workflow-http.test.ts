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
import { defaultLoop } from "../../src/ap/loop.js";
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
    loop: defaultLoop(),
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
  // The multi-step loop ran: ≥2 autonomous read/analyze steps before the terminal
  // action, and the ordered trace is persisted on the work item.
  assert.ok(item.trace.length >= 2, `expected ≥2 autonomous steps, got ${item.trace.length}`);
  assert.equal(item.trace[0].tool, "recall_vendor_history");
  assert.equal(item.stopReason, "terminal_action");
  // No side-effect fired during the loop (the autonomous tools never touch a sink).
  assert.equal(sinks.ledger.entries().length, 0);
  assert.equal(sinks.payments.payments().length, 0);
  assert.equal(sinks.email.outbox().length, 0);
  assert.equal(sinks.reviews.escalations().length, 0);

  // 2. It appears in the approval queue — WITH its full step trace (so a human can
  //    see HOW the agent decided, not just the final action).
  const pending = await app.inject({ method: "GET", url: "/pending" });
  assert.equal(pending.json().pending.length, 1);
  assert.equal(pending.json().pending[0].id, item.id);
  assert.ok(Array.isArray(pending.json().pending[0].trace));
  assert.equal(pending.json().pending[0].trace.length, item.trace.length);

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

test("amend audit trail: BOTH the proposed args and the amended args are persisted (prev → new)", async () => {
  const intake = await app.inject({
    method: "POST",
    url: "/intake",
    payload: { invoice: { vendor: "Wonka", invoice_number: "WK-1", tax_id: "TX-3", subtotal: 700, tax: 140, total: 840, date: "2026-05-01" } },
  });
  const id = intake.json().id;
  const proposedArgs = intake.json().proposed.args;

  const amend = await app.inject({
    method: "POST",
    url: `/amend/${id}`,
    payload: { args: { expense_account: "Consulting", amount: 840 }, reason: "reclassify", by: "clerk@demo" },
  });
  const item = amend.json();
  assert.equal(item.status, "approved");
  assert.equal(item.amended, true);
  // The audit trail keeps the ORIGINAL proposal AND the human's amended args.
  assert.ok(item.amendment, "amendment audit must be present");
  assert.deepEqual(item.amendment.proposedArgs, proposedArgs); // prev preserved, not overwritten
  assert.equal(item.amendment.amendedArgs.expense_account, "Consulting"); // new
  assert.equal(item.amendment.amendedBy, "clerk@demo");
  assert.equal(item.amendment.reason, "reclassify");
  // The amended args are exactly what the approved proposal now carries (== what ran).
  assert.equal(item.proposed.args.expense_account, "Consulting");
});

test("GET /decided returns approved/amended/rejected items with outcome + timestamp; pending excludes them", async () => {
  // Fresh, isolated app so this test owns its decided history deterministically.
  const local = await buildServer({
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks: fakeSinks(),
  });
  await local.ready();
  try {
    const a = await local.inject({ method: "POST", url: "/intake", payload: { invoice: { vendor: "Aperture", invoice_number: "AP-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 } } });
    const b = await local.inject({ method: "POST", url: "/intake", payload: { invoice: { vendor: "Black Mesa", invoice_number: "BM-1", tax_id: "T", subtotal: 200, tax: 40, total: 240 } } });
    await local.inject({ method: "POST", url: `/approve/${a.json().id}` });
    await local.inject({ method: "POST", url: `/reject/${b.json().id}`, payload: { reason: "not ours" } });

    const decided = (await local.inject({ method: "GET", url: "/decided" })).json().decided;
    assert.equal(decided.length, 2);
    const statuses = decided.map((d: { status: string }) => d.status).sort();
    assert.deepEqual(statuses, ["approved", "rejected"]);
    for (const d of decided) {
      assert.ok(d.decidedAt, "each decided item carries a decision timestamp");
    }
    // Decided items are gone from the pending queue.
    assert.equal((await local.inject({ method: "GET", url: "/pending" })).json().pending.length, 0);
  } finally {
    await local.close();
  }
});

test("gate invariant through the STREAM path: /intake/stream proposes only; approve executes exactly once; re-approve 409", async () => {
  const local = await buildServer({
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks,
  });
  await local.ready();
  try {
    const ledgerBefore = sinks.ledger.entries().length;
    const stream = await local.inject({
      method: "POST",
      url: "/intake/stream",
      payload: { invoice: { vendor: "Cyberdyne", invoice_number: "CY-1", tax_id: "T", subtotal: 100, tax: 20, total: 120 } },
    });
    assert.equal(stream.statusCode, 200);
    // Nothing side-effecting fired during the streamed loop.
    assert.equal(sinks.ledger.entries().length, ledgerBefore);

    const pending = (await local.inject({ method: "GET", url: "/pending" })).json().pending;
    assert.equal(pending.length, 1);
    const id = pending[0].id;

    const approve = await local.inject({ method: "POST", url: `/approve/${id}` });
    assert.equal(approve.statusCode, 200);
    assert.equal(sinks.ledger.entries().length, ledgerBefore + 1); // executed exactly once

    // It now shows in /decided and can NEVER re-execute (the gate).
    assert.ok((await local.inject({ method: "GET", url: "/decided" })).json().decided.some((d: { id: string }) => d.id === id));
    const reapprove = await local.inject({ method: "POST", url: `/approve/${id}` });
    assert.equal(reapprove.statusCode, 409);
    assert.equal(sinks.ledger.entries().length, ledgerBefore + 1); // still exactly once — no double-execute
  } finally {
    await local.close();
  }
});
