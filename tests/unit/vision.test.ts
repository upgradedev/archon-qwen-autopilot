// Unit — the document vision-extraction seam (src/qwen/vision.ts).
//
// Covers the two halves that must hold with NO key and NO network:
//   • validateDocument — the pre-budget gate: accepts PDF/PNG/JPG, rejects everything
//     else (400), an empty file (400), a size/type mismatch (400), and an oversize
//     upload (413). This is what guarantees a bad file never burns the daily budget.
//   • FakeExtractionClient — the deterministic offline extractor: returns a fixed
//     canonical invoice (the one printed on demo/sample-invoice.png) for any upload,
//     so the whole document → loop slice runs in CI. defaultExtractionClient() must
//     select it when DASHSCOPE_API_KEY is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDocument,
  FakeExtractionClient,
  QwenVisionExtractionClient,
  FAKE_EXTRACTED_INVOICE,
  defaultExtractionClient,
  DEFAULT_VISION_MODEL,
  MAX_DOCUMENT_BYTES,
  type VisionChat,
} from "../../src/qwen/vision.js";

// A fake OpenAI-compatible vision chat that returns a canned completion string — lets
// us exercise QwenVisionExtractionClient.extract() (JSON-clean + toRawInvoice) offline,
// with no key and no network. `capture` records the request so we can assert the
// multi-part (image_url + text) content is what the model receives.
function fakeVisionChat(content: string, capture?: (args: unknown) => void): VisionChat {
  return {
    chat: {
      completions: {
        async create(args) {
          capture?.(args);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

test("validateDocument accepts a PNG, a JPG, and a PDF", () => {
  const png = validateDocument({ filename: "invoice.png", mimetype: "image/png", size: 100 });
  assert.equal(png.ok, true);
  const jpg = validateDocument({ filename: "invoice.JPG", mimetype: "image/jpeg", size: 100 });
  assert.equal(jpg.ok, true);
  const pdf = validateDocument({ filename: "invoice.pdf", mimetype: "application/pdf", size: 100 });
  assert.equal(pdf.ok, true);
  if (pdf.ok) assert.equal(pdf.isPdf, true);
});

test("validateDocument tolerates a generic octet-stream content-type (browsers send it)", () => {
  const r = validateDocument({ filename: "invoice.png", mimetype: "application/octet-stream", size: 100 });
  assert.equal(r.ok, true);
});

test("validateDocument rejects an unsupported type → 400", () => {
  const r = validateDocument({ filename: "notes.txt", mimetype: "text/plain", size: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.match(r.error, /PDF, PNG, or JPG/);
  }
});

test("validateDocument rejects a content-type that contradicts the extension → 400", () => {
  const r = validateDocument({ filename: "invoice.png", mimetype: "application/pdf", size: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("validateDocument rejects an empty file → 400", () => {
  const r = validateDocument({ filename: "invoice.png", mimetype: "image/png", size: 0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test("validateDocument rejects an oversize file → 413", () => {
  const r = validateDocument({ filename: "invoice.png", mimetype: "image/png", size: MAX_DOCUMENT_BYTES + 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 413);
});

test("FakeExtractionClient returns the fixed canonical invoice for any upload (no key, no poppler)", async () => {
  const fake = new FakeExtractionClient();
  const out = await fake.extract({ buffer: Buffer.from("ignored"), filename: "invoice.png", mimetype: "image/png" });
  assert.equal(out.invoice.vendor, "Meridian Logistics");
  assert.equal(out.invoice.invoice_number, "ML-2026-0417");
  assert.equal(out.invoice.total, 6448);
  assert.equal(out.pages, 1);
  assert.equal(out.sourceType, "image");
  assert.equal(out.model, "fake-vision");
});

test("FakeExtractionClient reports sourceType 'pdf' for a PDF upload and never mutates the fixture", async () => {
  const fake = new FakeExtractionClient();
  const out = await fake.extract({ buffer: Buffer.from("%PDF-1.4"), filename: "invoice.pdf", mimetype: "application/pdf" });
  assert.equal(out.sourceType, "pdf");
  // Mutating the returned invoice must not poison the shared fixture (deep clone).
  (out.invoice as Record<string, unknown>).total = 0;
  assert.equal(FAKE_EXTRACTED_INVOICE.total, 6448);
});

test("defaultExtractionClient uses the offline fake when no DASHSCOPE key is set", () => {
  const prev = process.env.DASHSCOPE_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  try {
    const c = defaultExtractionClient();
    assert.ok(c instanceof FakeExtractionClient);
    assert.equal(c.modelId, "fake-vision");
  } finally {
    if (prev !== undefined) process.env.DASHSCOPE_API_KEY = prev;
  }
});

test("the default vision model is qwen-vl-max (VISION_MODEL overridable)", () => {
  // Absent an override, the flagship DashScope vision model.
  assert.ok(DEFAULT_VISION_MODEL === "qwen-vl-max" || DEFAULT_VISION_MODEL === process.env.VISION_MODEL);
});

test("QwenVisionExtractionClient.extract maps a model completion (image path) → canonical RawInvoice, offline via an injected chat", async () => {
  let seen: any;
  const chat = fakeVisionChat(
    // Markdown-fenced JSON with mixed types — exercises cleanJson + toRawInvoice
    // (string amounts pass through for the normalizer; a numeric total is kept).
    "```json\n" +
      JSON.stringify({
        vendor: "Northwind Freight",
        invoice_number: "NW-77",
        invoice_date: "2026-05-01",
        tax_id: "TAX-9",
        currency: "EUR",
        subtotal: "€1,000.00",
        tax: 240,
        total: 1240,
        line_items: [{ description: "Haulage", quantity: 1, unit_price: 1000, amount: 1000 }],
        confidence: 0.9,
      }) +
      "\n```",
    (a) => (seen = a)
  );
  const client = new QwenVisionExtractionClient("qwen-vl-max", chat);
  const out = await client.extract({ buffer: Buffer.from("img"), filename: "invoice.png", mimetype: "image/png" });
  assert.equal(out.model, "qwen-vl-max");
  assert.equal(out.sourceType, "image");
  assert.equal(out.pages, 1);
  assert.equal(out.invoice.vendor, "Northwind Freight");
  assert.equal(out.invoice.invoice_number, "NW-77");
  assert.equal(out.invoice.total, 1240);
  assert.equal(out.invoice.subtotal, "€1,000.00"); // string amount preserved for the normalizer
  assert.ok(Array.isArray(out.invoice.line_items));
  // The request carried the image as a data URL plus the extraction text prompt.
  const content = seen.messages[1].content;
  assert.equal(content[0].type, "image_url");
  assert.match(content[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(content[content.length - 1].type, "text");
});

test("QwenVisionExtractionClient.extract tolerates a non-JSON / empty completion → an empty invoice (no throw)", async () => {
  const client = new QwenVisionExtractionClient("qwen-vl-max", fakeVisionChat("sorry, I could not read it"));
  const out = await client.extract({ buffer: Buffer.from("img"), filename: "invoice.jpg", mimetype: "image/jpeg" });
  assert.deepEqual(out.invoice, {}); // safeParseJson → {} → toRawInvoice → {}
  assert.equal(out.sourceType, "image");
});

test("QwenVisionExtractionClient PDF path surfaces a clear 'poppler not installed' error when the binary is missing", async () => {
  // Point poppler at a guaranteed-nonexistent binary so the PDF rasterization path
  // (renderPdfToImages → pdftoppm spawn ENOENT → wrapPopplerError) runs deterministically
  // offline, with no key and no real poppler. The vision model is never reached.
  const prev = process.env.POPPLER_PDFTOPPM;
  process.env.POPPLER_PDFTOPPM = "pdftoppm-does-not-exist-xyz";
  try {
    const client = new QwenVisionExtractionClient("qwen-vl-max", fakeVisionChat("{}"));
    await assert.rejects(
      () => client.extract({ buffer: Buffer.from("%PDF-1.4 fake"), filename: "invoice.pdf", mimetype: "application/pdf" }),
      /poppler|pdftoppm/i
    );
  } finally {
    if (prev === undefined) delete process.env.POPPLER_PDFTOPPM;
    else process.env.POPPLER_PDFTOPPM = prev;
  }
});
