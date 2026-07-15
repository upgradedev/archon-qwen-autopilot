// Unit — the MCP tool dispatch (callAutopilotTool) over a Fake-wired agent. Proves
// the AP workflow AND its human-in-the-loop gate hold when driven through the MCP
// surface, fully offline (FakeEmbedder + InMemoryStore + FakeQwenChatClient + Fake
// sinks). The integration test (mcp-transport.test.ts) exercises the same behaviour
// through a real MCP Client ↔ Server pair; this file drives the dispatch directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { remember } from "../../src/memory/memory.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks, type Sinks } from "../../src/ap/sinks.js";
import { AutopilotAgent } from "../../src/agents/autopilot-agent.js";
import { callAutopilotTool } from "../../src/mcp/server.js";
import { DailyRateLimiter } from "../../src/ap/rate-limit.js";
import { TieredProviderRunAdmission } from "../../src/ap/provider-admission.js";

// Force the offline Fake even if a maintainer has DASHSCOPE_API_KEY exported.
delete process.env.DASHSCOPE_API_KEY;

function makeAgent(): { agent: AutopilotAgent; sinks: Sinks; embedder: FakeEmbedder; memory: InMemoryStore } {
  const sinks = fakeSinks();
  const embedder = new FakeEmbedder();
  const memory = new InMemoryStore();
  const agent = new AutopilotAgent(embedder, memory, new InMemoryWorkItemStore(), defaultLoop(), sinks);
  return { agent, sinks, embedder, memory };
}

// Parse the JSON text payload an ok() tool result carries.
function payload(res: any): any {
  const text = res.content[0]?.text ?? "";
  return JSON.parse(text);
}
// The text of the first content block (tool results are text in this server).
function firstText(res: any): string {
  return String(res.content[0]?.text ?? "");
}

const cleanInvoice = { vendor: "Acme", invoice_number: "A-1", tax_id: "T", subtotal: 100, tax: 20, total: 120, date: "2026-01-01", currency: "EUR" };

class HoldingEmbedder extends FakeEmbedder {
  private releaseResolve!: () => void;
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.releaseResolve = resolve; });

  override async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    this.startedResolve();
    await this.released;
    return super.embed(text, signal);
  }

  release(): void { this.releaseResolve(); }
}

test("intake_invoice → PENDING with a trace, and NOTHING executes (the gate over MCP)", async () => {
  const { agent, sinks } = makeAgent();
  const res = await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice });
  assert.equal(res.isError ?? false, false);
  const item = payload(res);
  assert.equal(item.status, "pending");
  assert.ok(item.id, "the work-item id must be returned so it can be approved");
  assert.ok(item.proposed.tool, "a terminal action is proposed");
  assert.ok(item.traceSummary.steps >= 2, "the redacted projection still reports the measured step count");
  assert.equal(item.invoice, undefined, "MCP does not disclose invoice PII by default");
  assert.equal(item.proposed.args, undefined, "MCP does not disclose executable arguments by default");
  assert.equal(item.execution, undefined);
  // Every sink is still empty — intake recommends, it never acts.
  assert.equal(sinks.ledger.entries().length, 0);
  assert.equal(sinks.payments.payments().length, 0);
  assert.equal(sinks.email.outbox().length, 0);
  assert.equal(sinks.reviews.escalations().length, 0);
});

test("intake → list_pending stays proposal-only; MCP cannot approve", async () => {
  const { agent, sinks } = makeAgent();
  const intake = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));

  const queue = payload(await callAutopilotTool(agent, "list_pending", {}));
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].id, intake.id);
  // Still nothing executed just by listing.
  assert.equal(sinks.ledger.entries().length, 0);

  const forbidden = await callAutopilotTool(agent, "approve", { id: intake.id });
  assert.equal(forbidden.isError, true);
  assert.match(firstText(forbidden), /unknown tool: approve/i);
  assert.equal(sinks.ledger.entries().length, 0, "an MCP client cannot fire a sink");
  const after = payload(await callAutopilotTool(agent, "list_pending", {}));
  assert.equal(after.pending.length, 1, "the item remains for the authenticated human reviewer");
});

test("approve/amend/reject are all absent from the MCP dispatcher", async () => {
  const { agent, sinks } = makeAgent();
  const intake = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));
  for (const name of ["approve", "amend", "reject"]) {
    const result = await callAutopilotTool(agent, name, { id: intake.id, args: {} });
    assert.equal(result.isError, true, `${name} must not be callable over MCP`);
    assert.match(firstText(result), new RegExp(`unknown tool: ${name}`, "i"));
  }
  assert.equal(sinks.ledger.entries().length, 0);
  assert.equal(sinks.payments.payments().length, 0);
  assert.equal(sinks.email.outbox().length, 0);
});

test("an unknown or guessed execution tool returns isError, not a false success", async () => {
  const { agent } = makeAgent();
  const res = await callAutopilotTool(agent, "execute_payment", { id: "does-not-exist" });
  assert.equal(res.isError, true);
  assert.match(firstText(res), /unknown tool/i);
});

test("forged amendment args cannot reach a sink over MCP", async () => {
  const { agent, sinks } = makeAgent();
  const intake = payload(await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }));
  assert.equal(intake.proposed.tool, "draft_journal_entry");
  const amended = await callAutopilotTool(agent, "amend", {
    id: intake.id,
    args: { expense_account: "Professional Fees", amount: 120 },
    reason: "reclassified",
  });
  assert.equal(amended.isError, true);
  assert.equal(sinks.ledger.entries().length, 0);
});

test("recall_vendor surfaces a vendor's remembered history (read-only, no execution)", async () => {
  const { agent, sinks, embedder, memory } = makeAgent();
  await remember(embedder, memory, {
    kind: "vendor",
    vendor: "Acme",
    content: "Acme is an established supplier with monthly professional-services invoices.",
  });
  const ledgerBefore = sinks.ledger.entries().length;

  const recalled = payload(await callAutopilotTool(agent, "recall_vendor", { vendor: "Acme" }));
  assert.equal(recalled.vendor, "Acme");
  assert.ok(Array.isArray(recalled.recalled) && recalled.recalled.length >= 1, "recall returns remembered facts");
  assert.equal(recalled.recalled[0].content, undefined, "memory content is withheld from default MCP clients");
  // recall_vendor is read-only — it fires no sink.
  assert.equal(sinks.ledger.entries().length, ledgerBefore);
});

test("list_skills returns the custom-skills catalog", async () => {
  const { agent } = makeAgent();
  const cat = payload(await callAutopilotTool(agent, "list_skills", {}));
  assert.equal(cat.kind, "custom-skills");
  assert.ok(cat.skills.some((s: any) => s.name === "draft_payment" && s.gate === "human-gated"));
  assert.ok(cat.skills.some((s: any) => s.name === "recall_vendor_history" && s.gate === "autonomous"));
});

test("a bad intake payload returns isError, not a thrown crash", async () => {
  const { agent } = makeAgent();
  const res = await callAutopilotTool(agent, "intake_invoice", {});
  assert.equal(res.isError, true);
});

test("MCP projections withhold confidential invoice, rationale, trace observations, and memory content by default", async () => {
  const { agent, embedder, memory } = makeAgent();
  const secret = "PRIVATE ERP evidence amount 987654 tax-id SECRET-TAX-99";
  await remember(embedder, memory, { kind: "insight", vendor: "Acme", content: secret });
  const intake = await callAutopilotTool(agent, "intake_invoice", {
    invoice: { ...cleanInvoice, tax_id: "SECRET-TAX-99" },
  });
  const serialized = firstText(intake);
  assert.doesNotMatch(serialized, /PRIVATE ERP|987654|SECRET-TAX-99/);
  assert.doesNotMatch(serialized, /"invoice"\s*:|"args"\s*:|"reasoning"\s*:|"observation"\s*:/);
  const queue = firstText(await callAutopilotTool(agent, "list_pending", {}));
  assert.doesNotMatch(queue, /PRIVATE ERP|987654|SECRET-TAX-99|"invoice"\s*:|"args"\s*:/);
  const recall = firstText(await callAutopilotTool(agent, "recall_vendor", { vendor: "Acme" }));
  assert.doesNotMatch(recall, /PRIVATE ERP|987654|SECRET-TAX-99|"content"\s*:|"metadata"\s*:/);
});

test("full MCP reviewer evidence requires an explicit operator-side opt-in", async () => {
  const { agent } = makeAgent();
  const res = payload(await callAutopilotTool(
    agent,
    "intake_invoice",
    { invoice: { ...cleanInvoice, vendor: "Explicit Evidence Co", invoice_number: "EE-1" } },
    { fullReviewerEvidence: true }
  ));
  assert.equal(res.invoice.tax_id, "T");
  assert.ok(Array.isArray(res.trace));
  assert.ok(res.proposed.args);
});

test("MCP provider work has a bounded daily budget", async () => {
  const { agent } = makeAgent();
  const controls = {
    rateLimiter: new DailyRateLimiter(1, () => new Date("2026-07-15T12:00:00Z"), 1),
    providerAdmission: new TieredProviderRunAdmission({ public: 1, reviewer: 1 }),
  };
  const first = await callAutopilotTool(agent, "recall_vendor", { vendor: "Acme" }, controls);
  assert.equal(first.isError ?? false, false);
  const over = await callAutopilotTool(agent, "intake_invoice", { invoice: cleanInvoice }, controls);
  assert.equal(over.isError, true);
  assert.match(firstText(over), /budget is exhausted/i);
  assert.equal((await agent.pending()).length, 0, "over-budget intake never reaches the agent");
});

test("MCP shares zero-wait provider admission and releases the lease after settlement", async () => {
  const embedder = new HoldingEmbedder();
  const agent = new AutopilotAgent(embedder, new InMemoryStore(), new InMemoryWorkItemStore(), defaultLoop(), fakeSinks());
  const controls = {
    rateLimiter: new DailyRateLimiter(3, () => new Date("2026-07-15T12:00:00Z"), 3),
    providerAdmission: new TieredProviderRunAdmission({ public: 1, reviewer: 1 }),
  };
  const first = callAutopilotTool(agent, "intake_invoice", {
    invoice: { ...cleanInvoice, vendor: "Holding One", invoice_number: "H-1" },
  }, controls);
  await embedder.started;
  const busy = await callAutopilotTool(agent, "intake_invoice", {
    invoice: { ...cleanInvoice, vendor: "Holding Two", invoice_number: "H-2" },
  }, controls);
  assert.equal(busy.isError, true);
  assert.match(firstText(busy), /capacity is temporarily busy/i);
  embedder.release();
  assert.equal((await first).isError ?? false, false);
  const after = await callAutopilotTool(agent, "intake_invoice", {
    invoice: { ...cleanInvoice, vendor: "Holding Three", invoice_number: "H-3" },
  }, controls);
  assert.equal(after.isError ?? false, false, "settled work releases process capacity");
});

test("MCP queue reads are bounded and paginated", async () => {
  const { agent } = makeAgent();
  for (let i = 0; i < 3; i += 1) {
    await callAutopilotTool(agent, "intake_invoice", {
      invoice: { ...cleanInvoice, vendor: `Page Vendor ${i}`, invoice_number: `PAGE-${i}` },
    });
  }
  const page = payload(await callAutopilotTool(agent, "list_pending", { limit: 1, offset: 1 }));
  assert.equal(page.pending.length, 1);
  assert.deepEqual(page.page, { limit: 1, offset: 1, returned: 1, nextOffset: 2 });
  const invalid = await callAutopilotTool(agent, "list_pending", { limit: 101 });
  assert.equal(invalid.isError, true);
});

test("MCP rejects deeply nested and oversized structured input before agent work", async () => {
  const { agent } = makeAgent();
  let nested: Record<string, unknown> = { value: "leaf" };
  for (let i = 0; i < 14; i += 1) nested = { child: nested };
  const deep = await callAutopilotTool(agent, "intake_invoice", { invoice: nested });
  assert.equal(deep.isError, true);
  assert.match(firstText(deep), /nesting depth/i);
  const long = await callAutopilotTool(agent, "recall_vendor", { vendor: "x".repeat(20_001) });
  assert.equal(long.isError, true);
  assert.match(firstText(long), /longer than/i);
  assert.equal((await agent.pending()).length, 0);
});
