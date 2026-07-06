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
  FAKE_EXTRACTED_INVOICE,
  defaultExtractionClient,
  DEFAULT_VISION_MODEL,
  MAX_DOCUMENT_BYTES,
} from "../../src/qwen/vision.js";

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
