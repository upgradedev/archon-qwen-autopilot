// Frozen-dataset integrity check. The hash binds online/offline result artifacts to
// the exact semantic labels and inputs they graded, rather than to a mutable filename.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { EVAL_SET } from "./dataset.js";
import { safeOperationalSummary } from "../src/security/operational-error.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function datasetSha256(): string {
  return createHash("sha256").update(canonicalJson(EVAL_SET), "utf8").digest("hex");
}

export async function expectedDatasetSha256(): Promise<string> {
  const path = fileURLToPath(new URL("./dataset.sha256", import.meta.url));
  return (await readFile(path, "utf8")).trim().split(/\s+/)[0] ?? "";
}

export async function assertFrozenDataset(): Promise<string> {
  const actual = datasetSha256();
  const expected = await expectedDatasetSha256();
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
    throw new Error(
      `frozen eval dataset hash mismatch: expected ${expected || "<missing>"}, actual ${actual}. ` +
        `Review label/input changes, then deliberately update eval/dataset.sha256.`
    );
  }
  return actual;
}

async function main(): Promise<void> {
  const hash = datasetSha256();
  if (process.argv.includes("--print")) {
    console.log(hash);
    return;
  }
  await assertFrozenDataset();
  console.log(`Frozen dataset verified: ${EVAL_SET.length} scenarios · sha256:${hash}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    console.error(`Dataset verification failed: ${safeOperationalSummary(err, "eval-dataset")}`);
    process.exit(1);
  });
}
