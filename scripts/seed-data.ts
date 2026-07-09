import { PgVectorStore } from "../src/memory/store.js";
import { defaultEmbedder } from "../src/memory/embeddings.js";
import { remember } from "../src/memory/memory.js";

async function main() {
  const embedder = defaultEmbedder();
  const store = new PgVectorStore();

  console.log("Seeding Meridian Logistics sample invoice...");
  
  // Seed the invoice memory
  await remember(embedder, store, {
    kind: "invoice",
    vendor: "Meridian Logistics",
    sourceRef: "inv-sample-seed-1",
    content: "Invoice ML-2026-0417 from Meridian Logistics for EUR 6448.00 dated 2026-06-30.",
    metadata: {
      invoice_id: "inv-sample-seed-1",
      vendor: "Meridian Logistics",
      vendor_ref: "ML-2026-0417",
      total: 6448,
      invoice_date: "2026-06-30",
    },
    importance: 0.5
  });

  console.log("Successfully seeded Meridian Logistics invoice.");
  process.exit(0);
}

main().catch(err => {
  console.error("Seed failed:", err);
  process.exit(1);
});
