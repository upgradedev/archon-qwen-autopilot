// Offline end-to-end demo of the Archon Autopilot AP loop — no key, no database.
//
//   npm run demo
//
// Drives four invoices through intake → multi-step ReAct loop → human gate →
// execute, using the in-memory stores + FakeQwenChatClient + Fake sinks, so it runs
// anywhere with zero credentials and zero spend. For each invoice it prints the
// autonomous read/analyze step TRACE (recall → validate → check/variance) the agent
// took before proposing a terminal action, then the four decision branches (journal
// entry, payment for a recurring vendor, vendor reply for a messy invoice, and a
// flagged duplicate) and the human approving / rejecting each proposal.

import { FakeEmbedder } from "../src/memory/embeddings.js";
import { InMemoryStore } from "../src/memory/store.js";
import { InMemoryWorkItemStore } from "../src/ap/workitem-store.js";
import { defaultLoop } from "../src/ap/loop.js";
import { fakeSinks } from "../src/ap/sinks.js";
import { AutopilotAgent } from "../src/agents/autopilot-agent.js";
import type { RawInvoice } from "../src/types.js";
import { safeOperationalSummary } from "../src/security/operational-error.js";

async function main() {
  const sinks = fakeSinks();
  const agent = new AutopilotAgent(
    new FakeEmbedder(),
    new InMemoryStore(),
    new InMemoryWorkItemStore(),
    defaultLoop(), // FakeQwenChatClient (no DASHSCOPE_API_KEY)
    sinks
  );

  const invoices: Array<{ label: string; raw: RawInvoice }> = [
    {
      label: "Clean invoice from a NEW vendor → draft_journal_entry",
      raw: { vendor: "Pinecrest Services", invoice_number: "PS-1001", date: "2026-02-03", subtotal: 1000, tax: 200, total: 1200, tax_id: "TX-8842", currency: "EUR" },
    },
    {
      label: "Second clean invoice from the SAME (now known) vendor → draft_payment",
      raw: { vendor: "Pinecrest Services", invoice_number: "PS-1002", date: "2026-03-03", subtotal: 1100, tax: 220, total: 1320, tax_id: "TX-8842", currency: "EUR" },
    },
    {
      label: "Messy invoice, missing tax_id + reconcile mismatch → draft_vendor_reply",
      raw: { supplier: "Harborline Consulting", amount: "€ 2.500,00", date: "not-a-date", subtotal: 2000, tax: 300 },
    },
    {
      label: "Duplicate of PS-1001 → flag_for_review",
      raw: { vendor: "Pinecrest Services", invoice_number: "PS-1001", date: "2026-02-03", subtotal: 1000, tax: 200, total: 1200, tax_id: "TX-8842", currency: "EUR" },
    },
  ];

  for (const { label, raw } of invoices) {
    console.log("\n" + "─".repeat(78));
    console.log("INTAKE:", label);
    const item = await agent.intake(raw);
    console.log(`  loop trace (${item.trace.length} autonomous step${item.trace.length === 1 ? "" : "s"}, no side-effect):`);
    for (const t of item.trace) {
      console.log(`    ${t.step}. ${t.tool} → ${t.observation}`);
    }
    console.log(`  proposed: ${item.proposed.tool} (confidence ${item.proposed.confidence}, stop: ${item.stopReason})`);
    console.log(`  reasoning: ${item.proposed.reasoning}`);
    console.log(`  findings: ${item.findings.filter((f) => !f.passed).map((f) => f.rule).join(", ") || "all pass"}`);

    if (item.proposed.tool === "flag_for_review") {
      const rejected = await agent.reject(item.id, "Confirmed duplicate — do not pay twice.");
      console.log(`  HUMAN → rejected (${rejected.decisionReason})`);
    } else if (item.proposed.tool === "draft_vendor_reply") {
      const approved = await agent.amend(
        item.id,
        {
          args: { to: "verified.vendor@example.test" },
          reason: "Verified vendor mailbox for the offline demonstration",
        },
        "demo-reviewer"
      );
      console.log(`  HUMAN → verified recipient, amended, and approved. executed: ${approved.execution?.summary}`);
    } else {
      const approved = await agent.approve(item.id);
      console.log(`  HUMAN → approved. executed: ${approved.execution?.summary}`);
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log("SIDE-EFFECTS (Fake sinks):");
  console.log("  ledger entries:", sinks.ledger.entries().length);
  console.log("  payments:", sinks.payments.payments().length);
  console.log("  vendor emails:", sinks.email.outbox().length);
  console.log("  review escalations:", sinks.reviews.escalations().length);
}

main().catch((err) => {
  console.error(`Demo failed: ${safeOperationalSummary(err, "offline-demo")}`);
  process.exit(1);
});
