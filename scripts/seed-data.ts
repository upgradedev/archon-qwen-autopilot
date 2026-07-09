import { buildAgent } from "../src/deps.js";

async function main() {
  const { agent, deps } = buildAgent();
  const { memory, workitems } = deps;

  console.log("Clearing previous autopilot data...");
  await memory.clear();
  await workitems.clear();

  console.log("Seeding Meridian Logistics historical approved invoice...");
  const item1 = await agent.intake({
    vendor: "Meridian Logistics",
    invoice_number: "ML-2026-0417",
    invoice_date: "2026-06-30",
    currency: "EUR",
    tax_id: "TAX-ML-88231",
    subtotal: 5200,
    tax: 1248,
    total: 6448,
    line_items: [
      { description: "Freight and warehousing — June", quantity: 1, unit_price: 5200, amount: 5200 }
    ]
  });
  await agent.approve(item1.id);
  console.log(`Approved Meridian Logistics ${item1.id}.`);

  console.log("Seeding Northwind Supplies historical approved invoice...");
  const item2 = await agent.intake({
    vendor: "Northwind Supplies",
    invoice_number: "NW-1001",
    invoice_date: "2026-02-03",
    currency: "EUR",
    tax_id: "TX-8842",
    subtotal: 1000,
    tax: 200,
    total: 1200,
    line_items: [
      { description: "Office supplies", quantity: 1, unit_price: 1000, amount: 1000 }
    ]
  });
  await agent.approve(item2.id);
  console.log(`Approved Northwind Supplies ${item2.id}.`);

  console.log("Seeding Northwind Supplies clean pending invoice...");
  const item3 = await agent.intake({
    vendor: "Northwind Supplies",
    invoice_number: "NW-1002",
    invoice_date: "2026-03-03",
    currency: "EUR",
    tax_id: "TX-8842",
    subtotal: 1100,
    tax: 220,
    total: 1320,
    line_items: [
      { description: "Office supplies batch 2", quantity: 1, unit_price: 1100, amount: 1100 }
    ]
  });
  console.log(`Queued pending Northwind Supplies NW-1002: ${item3.id}`);

  console.log("Seeding Contoso Ltd messy pending invoice...");
  const item4 = await agent.intake({
    vendor: "Contoso Ltd",
    invoice_number: "CNT-9901",
    invoice_date: "2026-07-01",
    currency: "EUR",
    subtotal: 2000,
    tax: 300,
    total: 2500, // intentional mismatch: 2000 + 300 != 2500, and missing tax_id!
    line_items: [
      { description: "Consulting fees", quantity: 1, unit_price: 2000, amount: 2000 }
    ]
  });
  console.log(`Queued pending Contoso Ltd CNT-9901: ${item4.id}`);

  console.log("Autopilot database seeding complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Autopilot seeding failed:", err);
  process.exit(1);
});
