// Integration — the MCP surface end to end through a REAL MCP Client ↔ Server pair
// over an in-memory transport. This proves the full protocol wiring (tool
// registration, the ListTools + CallTool JSON-RPC round-trip, the content/isError
// contract) — not just the handler functions — while staying fully offline (Fakes,
// no key, no DB, no network). It is the headline "round-trip through the MCP
// surface" test the deliverable calls for, and it asserts the gate holds over MCP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { FakeEmbedder } from "../../src/memory/embeddings.js";
import { InMemoryStore } from "../../src/memory/store.js";
import { InMemoryWorkItemStore } from "../../src/ap/workitem-store.js";
import { defaultLoop } from "../../src/ap/loop.js";
import { fakeSinks, type Sinks } from "../../src/ap/sinks.js";

delete process.env.DASHSCOPE_API_KEY;

// Stand up a linked Client ↔ Server pair over an in-memory transport, wired to the
// offline Fakes. Returns the client + the sinks (so a test can prove nothing fired).
async function connect(): Promise<{ client: Client; sinks: Sinks; close: () => Promise<void> }> {
  const sinks = fakeSinks();
  const { server } = buildMcpServer({
    embedder: new FakeEmbedder(),
    memory: new InMemoryStore(),
    workitems: new InMemoryWorkItemStore(),
    loop: defaultLoop(),
    sinks,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, sinks, close: async () => { await client.close(); await server.close(); } };
}

function payload(res: any): any {
  return JSON.parse(res.content[0].text);
}

const cleanInvoice = { vendor: "Acme", invoice_number: "A-1", tax_id: "T", subtotal: 100, tax: 20, total: 120, date: "2026-01-01", currency: "EUR" };

test("MCP client can list the agent-driving tools", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["intake_invoice", "list_pending", "list_skills", "recall_vendor"]);
    // Every tool advertises an object input schema (the JSON-Schema contract).
    for (const t of tools) assert.equal((t.inputSchema as any).type, "object");
  } finally {
    await close();
  }
});

test("intake → pending round-trip over MCP remains proposal-only", async () => {
  const { client, sinks, close } = await connect();
  try {
    const intake = payload(await client.callTool({ name: "intake_invoice", arguments: { invoice: cleanInvoice } }));
    assert.equal(intake.status, "pending");
    assert.ok(intake.id);
    assert.ok(intake.trace.length >= 2);
    // The sinks are empty — intake executed nothing across the wire.
    assert.equal(sinks.ledger.entries().length, 0);

    const queue = payload(await client.callTool({ name: "list_pending", arguments: {} }));
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.pending[0].id, intake.id);

    // Even a client that guesses the old decision-tool name cannot reach it.
    const forbidden: any = await client.callTool({ name: "approve", arguments: { id: intake.id } });
    assert.equal(forbidden.isError, true);
    assert.equal(sinks.ledger.entries().length, 0);
    const stillPending = payload(await client.callTool({ name: "list_pending", arguments: {} }));
    assert.equal(stillPending.pending.length, 1);
  } finally {
    await close();
  }
});

test("list_skills over MCP returns the custom-skills catalog", async () => {
  const { client, close } = await connect();
  try {
    const cat = payload(await client.callTool({ name: "list_skills", arguments: {} }));
    assert.equal(cat.kind, "custom-skills");
    assert.ok(cat.count >= 8);
  } finally {
    await close();
  }
});
