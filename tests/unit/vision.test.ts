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
  validateImageDimensions,
  FakeExtractionClient,
  QwenVisionExtractionClient,
  FAKE_EXTRACTED_INVOICE,
  defaultExtractionClient,
  DEFAULT_VISION_MODEL,
  MAX_DOCUMENT_BYTES,
  MAX_PDF_PAGES,
  MAX_PDF_RENDER_DIMENSION,
  MAX_PDF_RENDERED_BYTES,
  POPPLER_STDERR_MAX_BYTES,
  assertRenderedPdfBudget,
  pdfRenderArgs,
  type VisionChat,
} from "../../src/qwen/vision.js";
import { SOTA_CANDIDATE_MODEL } from "../../src/qwen/client.js";

function pngHeader(width: number, height: number): Buffer {
  const out = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}
const PNG_BYTES = pngHeader(1, 1);

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
  assert.equal(out.invoice.confidence, 0.9, "Qwen-VL confidence reaches the review/relevance layer");
  assert.ok(Array.isArray(out.invoice.line_items));
  // The request carried the image as a data URL plus the extraction text prompt.
  const content = seen.messages[1].content;
  assert.equal(content[0].type, "image_url");
  assert.match(content[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(content[content.length - 1].type, "text");
});

test("image header preflight accepts bounded PNG/JPEG and rejects malformed or pixel-bomb canvases", () => {
  assert.equal(validateImageDimensions(pngHeader(1200, 1600), ".png").ok, true);
  const bomb = validateImageDimensions(pngHeader(8192, 8192), ".png");
  assert.equal(bomb.ok, false);
  if (!bomb.ok) assert.equal(bomb.status, 413);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0xb0, 0x06, 0x40, 0x03, 0x01, 0x11, 0x00]);
  assert.equal(validateImageDimensions(jpeg, ".jpg").ok, true);
  assert.equal(validateImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), ".jpg").ok, false);
});

test("PDF rasterization arguments cap pages and longest-side pixels", () => {
  const args = pdfRenderArgs("input.pdf", "page");
  assert.deepEqual(args, [
    "-png", "-scale-to", String(MAX_PDF_RENDER_DIMENSION),
    "-l", String(MAX_PDF_PAGES + 1), "input.pdf", "page",
  ]);
  assert.ok(MAX_PDF_RENDER_DIMENSION >= 512 && MAX_PDF_RENDER_DIMENSION <= 4096);
  assert.ok(POPPLER_STDERR_MAX_BYTES >= 1024 && POPPLER_STDERR_MAX_BYTES <= 65_536);
});

test("PDF rendered-output byte budget rejects oversized page sets before reads/base64", () => {
  assert.doesNotThrow(() => assertRenderedPdfBudget([1, MAX_PDF_RENDERED_BYTES - 1]));
  assert.throws(() => assertRenderedPdfBudget([MAX_PDF_RENDERED_BYTES, 1]), /output budget/i);
  assert.throws(() => assertRenderedPdfBudget([-1]), /invalid rendered PDF output size/i);
});

test("versioned qwen3.7 candidate uses the exact non-thinking JSON contract without max_tokens", async () => {
  let captured: Record<string, unknown> | undefined;
  const client = new QwenVisionExtractionClient(
    SOTA_CANDIDATE_MODEL,
    fakeVisionChat(JSON.stringify({ vendor: "Candidate Vision", invoice_number: "CV-1", invoice_date: "2026-01-01", tax_id: "T", currency: "EUR", subtotal: 100, tax: 20, total: 120, confidence: 0.9 }), (args) => { captured = args as Record<string, unknown>; })
  );
  await client.extract({ buffer: PNG_BYTES, filename: "invoice.png", mimetype: "image/png" });
  assert.deepEqual(captured?.response_format, { type: "json_object" });
  assert.equal(captured?.enable_thinking, false);
  assert.equal("extra_body" in (captured ?? {}), false, "Python-only extra_body must never be sent by Node");
  assert.equal(Object.prototype.hasOwnProperty.call(captured ?? {}, "max_tokens"), false);
});

test("QwenVisionExtractionClient.extract treats missing/invalid confidence as untrusted", async () => {
  const client = new QwenVisionExtractionClient("qwen-vl-max", fakeVisionChat("sorry, I could not read it"));
  const out = await client.extract({ buffer: Buffer.from("img"), filename: "invoice.jpg", mimetype: "image/jpeg" });
  assert.deepEqual(out.invoice, { confidence: 0 });
  assert.equal(out.sourceType, "image");

  const missing = new QwenVisionExtractionClient(
    "qwen-vl-max",
    fakeVisionChat(JSON.stringify({ vendor: "Looks Complete", total: 100, currency: "EUR" }))
  );
  const missingOut = await missing.extract({ buffer: Buffer.from("img"), filename: "invoice.jpg", mimetype: "image/jpeg" });
  assert.equal(missingOut.invoice.confidence, 0);

  const invalid = new QwenVisionExtractionClient(
    "qwen-vl-max",
    fakeVisionChat(JSON.stringify({ vendor: "Looks Complete", total: 100, confidence: 7 }))
  );
  const invalidOut = await invalid.extract({ buffer: Buffer.from("img"), filename: "invoice.jpg", mimetype: "image/jpeg" });
  assert.equal(invalidOut.invoice.confidence, 0);
});

test("Qwen-VL caller abort returns promptly while admission retains an SDK call until settlement", async () => {
  let active = 0;
  const retained: Promise<unknown>[] = [];
  let sawAbortResolve!: () => void;
  const sawAbort = new Promise<void>((resolve) => { sawAbortResolve = resolve; });
  let settleResolve!: () => void;
  const settle = new Promise<void>((resolve) => { settleResolve = resolve; });
  const chat: VisionChat = {
    chat: {
      completions: {
        create: async (_args, options) => {
          active += 1;
          try {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                sawAbortResolve();
                void settle.then(() => reject(options.signal?.reason ?? new Error("aborted")));
              }, { once: true });
            });
            throw new Error("unreachable");
          } finally {
            active -= 1;
          }
        },
      },
    },
  };
  const aborter = new AbortController();
  const extraction = new QwenVisionExtractionClient("qwen-vl-max", chat).extract(
    { buffer: PNG_BYTES, filename: "invoice.png", mimetype: "image/png" },
    { signal: aborter.signal, retainProviderCallUntilSettled: (operation) => retained.push(operation) }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  aborter.abort(new Error("client disconnected"));
  await sawAbort;
  await assert.rejects(extraction, /client disconnected/);
  assert.equal(active, 1, "the SDK call remains active after the response boundary returns");
  assert.equal(retained.length, 1, "the live SDK promise transfers to admission ownership");
  settleResolve();
  await assert.rejects(retained[0]!, /client disconnected/);
  assert.equal(active, 0);
});

test("Qwen-VL hard deadline returns even when the SDK ignores AbortSignal", async () => {
  let settle!: () => void;
  let signalSeen: AbortSignal | undefined;
  const chat: VisionChat = {
    chat: {
      completions: {
        create: (_args, options) => {
          signalSeen = options?.signal;
          return new Promise((resolve) => {
            settle = () => resolve({ choices: [{ message: { content: "{}" } }] });
          });
        },
      },
    },
  };
  const retained: Promise<unknown>[] = [];
  const started = Date.now();
  const extraction = new QwenVisionExtractionClient("qwen-vl-max", chat).extract(
    { buffer: PNG_BYTES, filename: "invoice.png", mimetype: "image/png" },
    { deadlineMs: 20, retainProviderCallUntilSettled: (operation) => retained.push(operation) }
  );

  await assert.rejects(extraction, /timed out after 20ms/);
  assert.ok(Date.now() - started < 500, "the local vision deadline cannot depend on SDK cancellation");
  assert.equal(signalSeen?.aborted, true);
  assert.equal(retained.length, 1);
  settle();
  await retained[0];
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
