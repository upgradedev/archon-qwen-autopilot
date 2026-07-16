#!/usr/bin/env node

// Rebuild the canonical Devpost thumbnail from its authored SVG and losslessly
// remove metadata-bearing JPEG segments from the public architecture raster.
// The locked Playwright dependency supplies the exact Chromium revision; no
// external image, font file, or network request is used by the SVG.

import assert from "node:assert/strict";
import { open, readFile, rename, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const THUMBNAIL_SVG = join(ROOT, "demo", "thumbnail.svg");
const THUMBNAIL_PNG = join(ROOT, "demo", "thumbnail.png");
const ARCHITECTURE_JPG = join(ROOT, "demo", "final-media", "judge-architecture.jpg");
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("usage: node scripts/render-submission-assets.mjs --write|--check");
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_METADATA_MARKERS = new Set([
  0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xeb, 0xec, 0xed, 0xef, 0xfe,
]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectPng(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), "thumbnail output is not a PNG");
  assert.equal(bytes.readUInt32BE(16), 1500, "thumbnail width drifted");
  assert.equal(bytes.readUInt32BE(20), 1000, "thumbnail height drifted");

  const forbidden = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "iCCP", "tIME"]);
  let offset = 8;
  let sawEnd = false;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, "truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length, `truncated PNG ${type} chunk`);
    assert.ok(!forbidden.has(type), `thumbnail contains metadata chunk ${type}`);
    offset = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  assert.ok(sawEnd && offset === bytes.length, "PNG has missing IEND or trailing bytes");
}

function inspectJpegHeader(bytes) {
  assert.ok(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8, "architecture is not JPEG");
  const metadataMarkers = [];
  let width;
  let height;
  let offset = 2;
  let sosOffset;
  let scanOffset;

  while (offset < bytes.length) {
    const markerStart = offset;
    assert.equal(bytes[offset], 0xff, `invalid JPEG marker at byte ${offset}`);
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    assert.ok(offset < bytes.length, "truncated JPEG marker");
    const marker = bytes[offset++];
    assert.notEqual(marker, 0x00, "unexpected stuffed marker before JPEG scan");

    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    assert.ok(offset + 2 <= bytes.length, "truncated JPEG segment length");
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2, "invalid JPEG segment length");
    const segmentEnd = offset + length;
    assert.ok(segmentEnd <= bytes.length, "truncated JPEG segment");

    if (JPEG_METADATA_MARKERS.has(marker)) metadataMarkers.push(marker);
    if (JPEG_SOF_MARKERS.has(marker)) {
      assert.ok(length >= 7, "truncated JPEG frame header");
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
    }
    if (marker === 0xda) {
      sosOffset = markerStart;
      scanOffset = segmentEnd;
      break;
    }
    offset = segmentEnd;
  }

  assert.ok(sosOffset !== undefined && scanOffset !== undefined, "JPEG has no start-of-scan segment");
  assert.equal(width, 1600, "architecture JPEG width drifted");
  assert.equal(height, 900, "architecture JPEG height drifted");
  return { metadataMarkers, sosOffset, scanOffset };
}

function assertNoPostScanMetadata(bytes, scanOffset) {
  for (let offset = scanOffset; offset + 1 < bytes.length; offset += 1) {
    if (bytes[offset] !== 0xff) continue;
    let next = offset + 1;
    while (next < bytes.length && bytes[next] === 0xff) next += 1;
    if (next >= bytes.length) break;
    const marker = bytes[next];
    if (marker === 0x00 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = next;
      continue;
    }
    assert.ok(!JPEG_METADATA_MARKERS.has(marker), "metadata marker appears after JPEG scan data");
  }
}

function stripJpegMetadata(bytes) {
  const original = inspectJpegHeader(bytes);
  assertNoPostScanMetadata(bytes, original.scanOffset);

  const chunks = [bytes.subarray(0, 2)];
  const removed = [];
  let offset = 2;
  while (offset < original.sosOffset) {
    const markerStart = offset;
    assert.equal(bytes[offset], 0xff, `invalid JPEG marker at byte ${offset}`);
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    assert.ok(marker !== 0x00 && marker !== 0xd9 && marker !== 0xda, "unexpected JPEG marker before scan");
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(markerStart, offset));
      continue;
    }
    const length = bytes.readUInt16BE(offset);
    const segmentEnd = offset + length;
    assert.ok(length >= 2 && segmentEnd <= bytes.length, "invalid JPEG segment while stripping metadata");
    if (JPEG_METADATA_MARKERS.has(marker)) removed.push(marker);
    else chunks.push(bytes.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  chunks.push(bytes.subarray(original.sosOffset));

  const sanitized = Buffer.concat(chunks);
  const checked = inspectJpegHeader(sanitized);
  assert.deepEqual(checked.metadataMarkers, [], "sanitized JPEG still has metadata-bearing header segments");
  assertNoPostScanMetadata(sanitized, checked.scanOffset);
  assert.ok(
    sanitized.subarray(checked.sosOffset).equals(bytes.subarray(original.sosOffset)),
    "JPEG entropy-coded image data changed while stripping metadata",
  );
  return { sanitized, removed };
}

async function renderThumbnail() {
  const svg = await readFile(THUMBNAIL_SVG, "utf8");
  assert.match(svg, /<svg\b[^>]*\bwidth="1500"[^>]*\bheight="1000"[^>]*\bviewBox="0 0 1500 1000"/i);
  assert.match(svg, /Qwen proposes\. Human decides\./);
  assert.doesNotMatch(svg, /human-controlled money/i);
  assert.doesNotMatch(svg, /<(?:image|script|foreignObject)\b/i);
  assert.doesNotMatch(svg, /\b(?:href|xlink:href)\s*=|url\(\s*['"]?https?:/i);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
    const unexpectedRequests = [];
    page.on("request", (request) => unexpectedRequests.push(request.url()));
    await page.route("**/*", (route) => route.abort("blockedbyclient"));
    await page.setContent(
      `<style>html,body{margin:0;width:1500px;height:1000px;overflow:hidden;background:#000}svg{display:block}</style>${svg}`,
      { waitUntil: "load" },
    );
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(unexpectedRequests, [], "thumbnail render attempted an external request");
    const png = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    inspectPng(png);
    return { png, browserVersion: browser.version() };
  } finally {
    await browser.close();
  }
}

async function replaceAtomically(path, bytes) {
  const temporary = `${path}.next-${process.pid}`;
  await rm(temporary, { force: true });
  let handle;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

const [{ png, browserVersion }, currentPng, currentJpeg] = await Promise.all([
  renderThumbnail(),
  readFile(THUMBNAIL_PNG),
  readFile(ARCHITECTURE_JPG),
]);
inspectPng(currentPng);
const { sanitized: sanitizedJpeg, removed } = stripJpegMetadata(currentJpeg);

if (mode === "--write") {
  if (!png.equals(currentPng)) await replaceAtomically(THUMBNAIL_PNG, png);
  if (!sanitizedJpeg.equals(currentJpeg)) await replaceAtomically(ARCHITECTURE_JPG, sanitizedJpeg);
  console.log(
    `submission assets written: thumbnail 1500x1000 via Chromium ${browserVersion}; `
    + `architecture 1600x900; removed JPEG markers=${removed.map((marker) => `0x${marker.toString(16)}`).join(",") || "none"}`,
  );
} else {
  assert.ok(png.equals(currentPng), "demo/thumbnail.png is not the canonical raster of demo/thumbnail.svg");
  assert.ok(sanitizedJpeg.equals(currentJpeg), "judge-architecture.jpg still contains removable metadata");
  console.log(`submission assets canonical: thumbnail and metadata-free architecture (Chromium ${browserVersion})`);
}
