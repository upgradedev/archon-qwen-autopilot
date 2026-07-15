import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateDocument,
  validateImageDimensions,
  validateMagicBytes,
} from "../../src/qwen/vision.js";

export interface VisionGroundTruth {
  vendor: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  tax_id: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
}

export interface VisionFixtureCase {
  id: string;
  filename: string;
  variant: string;
  safeReviewExpected: boolean;
  groundTruth: VisionGroundTruth;
}

export interface VisionFixtureManifest {
  schemaVersion: number;
  license: string;
  cases: VisionFixtureCase[];
}

export interface FrozenVisionSet {
  root: string;
  manifest: VisionFixtureManifest;
  fixtureSetSha256: string;
  fixtureBytesSha256: string;
  canonicalLockText: string;
  pdfFixtures: Array<{ id: string; path: string }>;
  fixtureBytesById: ReadonlyMap<string, Buffer>;
}

const DEFAULT_ROOT = dirname(fileURLToPath(import.meta.url));
const SHA256 = /^[0-9a-f]{64}$/;
const TEXT_FIELDS = ["vendor", "invoice_number", "invoice_date", "tax_id", "currency"] as const;
const NUMBER_FIELDS = ["subtotal", "tax", "total"] as const;
const FROZEN_PDF_IDS = ["v03", "v09", "v11", "v13", "v14"] as const;

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function safeFixturePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("vision fixture lock contains an absolute or empty path");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("vision fixture lock contains a non-canonical path");
  }
  return normalized;
}

// The lock identity is independent of checkout EOLs, whitespace and entry order.
// Individual binary fixture hashes remain byte-exact; only the text lock syntax and
// JSON manifest line endings are canonicalized for Windows/Linux reproducibility.
export function canonicalizeFixtureLock(value: string): string {
  const entries = canonicalText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9A-Fa-f]{64})\s+(.+)$/.exec(line);
      if (!match) throw new Error("vision fixture lock contains a malformed entry");
      return { hash: match[1]!.toLowerCase(), path: safeFixturePath(match[2]!.trim()) };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!SHA256.test(entry.hash) || paths.has(entry.path)) {
      throw new Error("vision fixture lock contains a duplicate or malformed entry");
    }
    paths.add(entry.path);
  }
  return `${entries.map((entry) => `${entry.hash}  ${entry.path}`).join("\n")}\n`;
}

export function fixtureSetHash(lockText: string): string {
  return sha(canonicalizeFixtureLock(lockText));
}

export function fixtureMime(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : "image/jpeg";
}

export function numericWithinCent(expected: number | null, actual: unknown): boolean {
  if (expected == null) return actual == null || actual === "";
  let value: number;
  if (typeof actual === "number" && Number.isFinite(actual)) value = actual;
  else if (typeof actual === "string" && actual.trim()
    && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(actual.trim())) value = Number(actual.trim());
  else return false;
  return Number.isFinite(value) && Math.abs(value - expected) <= 0.01;
}

export async function loadFrozenVisionSet(root = DEFAULT_ROOT): Promise<FrozenVisionSet> {
  const rootReal = await realpath(resolve(root));
  const manifestText = canonicalText(await readFile(resolve(rootReal, "manifest.json"), "utf8"));
  const manifest = JSON.parse(manifestText) as VisionFixtureManifest;
  if (manifest.schemaVersion !== 1 || typeof manifest.license !== "string" || !manifest.license.trim()
    || !Array.isArray(manifest.cases) || manifest.cases.length !== 16) {
    throw new Error("vision manifest must match the frozen v1 16-case contract");
  }

  const canonicalLockText = canonicalizeFixtureLock(
    await readFile(resolve(rootReal, "fixtures.sha256"), "utf8")
  );
  const expected = new Map(
    canonicalLockText.trimEnd().split("\n").map((line) => {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line)!;
      return [match[2]!, match[1]!] as const;
    })
  );
  if (sha(Buffer.from(manifestText, "utf8")) !== expected.get("manifest.json")) {
    throw new Error("vision manifest hash mismatch");
  }

  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const pdfFixtures: Array<{ id: string; path: string }> = [];
  const fixtureBytesById = new Map<string, Buffer>();
  const fixtureBytesDigest = createHash("sha256").update("archon-frozen-vision-bytes-v1\n");
  for (const item of manifest.cases) {
    if (!item || typeof item !== "object" || typeof item.filename !== "string"
      || typeof item.variant !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(item.variant)
      || typeof item.safeReviewExpected !== "boolean" || !item.groundTruth || typeof item.groundTruth !== "object") {
      throw new Error("vision manifest contains a malformed case");
    }
    const groundTruthKeys = Object.keys(item.groundTruth).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const expectedKeys = [...TEXT_FIELDS, ...NUMBER_FIELDS].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (JSON.stringify(groundTruthKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error("vision manifest ground truth has an unexpected field set");
    }
    for (const field of TEXT_FIELDS) {
      const value = item.groundTruth[field];
      if (value !== null && (typeof value !== "string" || !value.trim())) {
        throw new Error("vision manifest contains malformed string ground truth");
      }
    }
    for (const field of NUMBER_FIELDS) {
      const value = item.groundTruth[field];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error("vision manifest contains malformed numeric ground truth");
      }
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(item.id) || seenIds.has(item.id)) {
      throw new Error("vision manifest contains a duplicate or malformed case id");
    }
    seenIds.add(item.id);
    const lockedPath = safeFixturePath(item.filename);
    if (seenFiles.has(lockedPath)) throw new Error("vision manifest contains a duplicate fixture path");
    seenFiles.add(lockedPath);
    const path = resolve(rootReal, lockedPath);
    const rel = relative(rootReal, path);
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`${item.id}: fixture escapes eval/vision`);
    const pathReal = await realpath(path);
    const realRel = relative(rootReal, pathReal);
    if (isAbsolute(realRel) || realRel.startsWith("..")) throw new Error(`${item.id}: fixture resolves outside eval/vision`);
    const bytes = await readFile(pathReal);
    const byteSha256 = sha(bytes);
    if (byteSha256 !== expected.get(lockedPath)) throw new Error(`${item.id}: fixture hash mismatch`);
    const validated = validateDocument({ filename: pathReal, mimetype: fixtureMime(pathReal), size: bytes.length });
    if (!validated.ok) throw new Error(`${item.id}: frozen fixture validation failed`);
    const magic = validateMagicBytes(bytes, validated.ext);
    if (!magic.ok) throw new Error(`${item.id}: frozen fixture content mismatch`);
    const dimensions = validateImageDimensions(bytes, validated.ext);
    if (!dimensions.ok) throw new Error(`${item.id}: frozen fixture dimensions invalid`);
    fixtureBytesById.set(item.id, Buffer.from(bytes));
    fixtureBytesDigest.update(item.id).update("\0").update(lockedPath).update("\0").update(byteSha256).update("\n");
    if (validated.isPdf) pdfFixtures.push({ id: item.id, path: pathReal });
  }
  if (manifest.cases.filter((item) => item.safeReviewExpected).length !== 4) {
    throw new Error("vision manifest must retain exactly four safe-review-positive cases");
  }
  if (JSON.stringify(pdfFixtures.map((item) => item.id)) !== JSON.stringify(FROZEN_PDF_IDS)) {
    throw new Error("vision manifest must retain the five frozen PDF cases");
  }
  if (expected.size !== manifest.cases.length + 1 || !expected.has("manifest.json")) {
    throw new Error("vision fixture lock and manifest do not describe the same frozen set");
  }
  for (const lockedPath of expected.keys()) {
    if (lockedPath !== "manifest.json" && !seenFiles.has(lockedPath)) {
      throw new Error("vision fixture lock contains an unreferenced fixture");
    }
  }

  return {
    root: rootReal,
    manifest,
    fixtureSetSha256: sha(canonicalLockText),
    fixtureBytesSha256: fixtureBytesDigest.digest("hex"),
    canonicalLockText,
    pdfFixtures,
    fixtureBytesById,
  };
}
