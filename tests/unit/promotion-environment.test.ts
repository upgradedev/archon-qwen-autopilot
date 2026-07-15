import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPromotionEnvironment,
  assertPromotionParameterLock,
  finalizePromotionEnvironment,
  preflightPromotionEnvironment,
  PromotionEnvironmentError,
  type PromotionCommandRunner,
} from "../../eval/promotion-environment.js";
import {
  canonicalizeFixtureLock,
  fixtureSetHash,
  loadFrozenVisionSet,
  numericWithinCent,
} from "../../eval/vision/fixtures.js";
import { evaluateVisionSafeReview } from "../../eval/vision/safe-review.js";
import { POPPLER_TIMEOUT_MS } from "../../src/qwen/vision.js";

const ROOT = resolve(".");

test("fixture-set identity is identical for LF and CRLF lock checkouts", async () => {
  const lock = await readFile("eval/vision/fixtures.sha256", "utf8");
  const lf = lock.replace(/\r\n?/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(canonicalizeFixtureLock(lf), canonicalizeFixtureLock(crlf));
  assert.equal(fixtureSetHash(lf), fixtureSetHash(crlf));
  const frozen = await loadFrozenVisionSet();
  assert.equal(frozen.fixtureSetSha256, fixtureSetHash(lock));
  assert.equal(frozen.fixtureSetSha256, "f18ce2ee21b6f38a7245a4d5b3e78fb8e232fba181e9e147bd51e00a96faf70c");
  assert.deepEqual(frozen.pdfFixtures.map((fixture) => fixture.id), ["v03", "v09", "v11", "v13", "v14"]);
});

test("expected numeric zero cannot be satisfied by null, blank, or boolean coercion", () => {
  for (const invalid of [null, undefined, "", "   ", false, true, "0x0", "zero"]) {
    assert.equal(numericWithinCent(0, invalid), false);
  }
  assert.equal(numericWithinCent(0, 0), true);
  assert.equal(numericWithinCent(0, "0.00"), true);
});

test("promotion preflight attests a contained binary, rasters every frozen PDF, and cleans repo temp", async () => {
  const frozen = await loadFrozenVisionSet();
  const testRoot = resolve(".artifacts", `promotion-environment-test-${process.pid}`);
  const binary = join(testRoot, "poppler", "bin", process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm");
  const binaryBytes = Buffer.from("offline-test-poppler-binary", "utf8");
  await mkdir(dirname(binary), { recursive: true });
  await mkdir(join(testRoot, "eval"), { recursive: true });
  await writeFile(binary, binaryBytes);
  const bundleSha256 = createHash("sha256")
    .update("archon-poppler-bundle-v1\n")
    .update(`bin/${basename(binary)}`).update("\0")
    .update(createHash("sha256").update(binaryBytes).digest("hex")).update("\n")
    .digest("hex");
  await writeFile(join(testRoot, "eval", "promotion-poppler.lock.json"), JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    basename: basename(binary),
    version: "26.05.0",
    packageSpec: "poppler=26.05.0=offline_test",
    sha256: createHash("sha256").update(binaryBytes).digest("hex"),
    bundleFiles: 1,
    bundleSha256,
  }));
  const pdfFixtures = [];
  await mkdir(join(testRoot, "fixtures"));
  for (const fixture of frozen.pdfFixtures) {
    const target = join(testRoot, "fixtures", `${fixture.id}.pdf`);
    await copyFile(fixture.path, target);
    pdfFixtures.push({ id: fixture.id, path: target });
  }
  const rasterTempDirectories: string[] = [];
  let rasterCalls = 0;
  const runner: PromotionCommandRunner = {
    async run(executable, args, timeoutMs, environment) {
      assert.equal(executable, await realpath(binary));
      assert.equal(timeoutMs, POPPLER_TIMEOUT_MS);
      assert.match(environment.TMPDIR!, /\.artifacts/i);
      assert.equal(environment.TEMP, environment.TMPDIR);
      assert.equal(environment.TMP, environment.TMPDIR);
      if (args.length === 1 && args[0] === "-v") {
        return { stdout: "", stderr: "pdftoppm version 26.05.0\n" };
      }
      rasterCalls += 1;
      const outPrefix = args.at(-1)!;
      rasterTempDirectories.push(dirname(outPrefix));
      await copyFile("eval/vision/assets/v01-classic-eur.png", `${outPrefix}-1.png`);
      return { stdout: "", stderr: "" };
    },
  };
  const prior = { poppler: process.env.POPPLER_PDFTOPPM, tmpdir: process.env.TMPDIR, temp: process.env.TEMP, tmp: process.env.TMP };
  try {
    const environment = await preflightPromotionEnvironment({
      repoRoot: testRoot,
      popplerLocator: relative(testRoot, binary),
      pdfFixtures,
      runner,
    });
    assert.equal(rasterCalls, frozen.pdfFixtures.length);
    assert.deepEqual(environment.attestation, {
      status: "passed",
      poppler: {
        platform: process.platform,
        architecture: process.arch,
        basename: basename(binary),
        version: "26.05.0",
        packageSpec: "poppler=26.05.0=offline_test",
        sha256: createHash("sha256").update(binaryBytes).digest("hex"),
        bundleFiles: 1,
        bundleSha256,
      },
      frozenPdfRaster: {
        caseIds: ["v03", "v09", "v11", "v13", "v14"],
        cases: 5,
        renderedPages: 5,
        maxPagesPerDocument: 3,
      },
      temporaryFiles: {
        repositoryDirectory: ".artifacts",
        preflightCleanup: "completed-before-provider-calls",
        liveRunCleanup: "pending",
      },
    });
    assert.doesNotMatch(JSON.stringify(environment.attestation), /[A-Za-z]:\\|promotion-environment-test/i);
    for (const dir of rasterTempDirectories) assert.equal(existsSync(dir), false, `${dir} must be cleaned`);
    applyPromotionEnvironment(environment);
    assert.equal(process.env.POPPLER_PDFTOPPM, environment.executablePath);
    assert.equal(process.env.TMPDIR, environment.temporaryRoot);
    assert.equal(process.env.TEMP, environment.temporaryRoot);
    assert.equal(process.env.TMP, environment.temporaryRoot);
    assert.equal(resolve(tmpdir()), environment.temporaryRoot);
    assert.deepEqual(await finalizePromotionEnvironment(environment), {
      ...environment.attestation,
      temporaryFiles: {
        repositoryDirectory: ".artifacts",
        preflightCleanup: "completed-before-provider-calls",
        liveRunCleanup: "completed-after-provider-calls",
      },
    });
    assert.equal(existsSync(environment.temporaryRoot), false);

    const dirtyEnvironment = await preflightPromotionEnvironment({
      repoRoot: testRoot,
      popplerLocator: relative(testRoot, binary),
      pdfFixtures,
      runner,
    });
    await writeFile(join(dirtyEnvironment.temporaryRoot, "unexpected-rendered-page.png"), "sensitive-test-page");
    await assert.rejects(
      finalizePromotionEnvironment(dirtyEnvironment),
      (error: unknown) => error instanceof PromotionEnvironmentError
        && error.code === "promotion_temp_cleanup_failed"
    );
    assert.equal(
      existsSync(dirtyEnvironment.temporaryRoot),
      false,
      "failed attestation must still remove repository-contained rendered pages"
    );

    await writeFile(binary, "tampered-offline-test-poppler-binary");
    await assert.rejects(
      preflightPromotionEnvironment({
        repoRoot: testRoot,
        popplerLocator: relative(testRoot, binary),
        pdfFixtures,
        runner,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PromotionEnvironmentError);
        assert.equal(error.code, "poppler_attestation_mismatch");
        assert.doesNotMatch(error.message, /[A-Za-z]:\\|promotion-environment-test/i);
        return true;
      }
    );
  } finally {
    if (prior.poppler === undefined) delete process.env.POPPLER_PDFTOPPM; else process.env.POPPLER_PDFTOPPM = prior.poppler;
    if (prior.tmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior.tmpdir;
    if (prior.temp === undefined) delete process.env.TEMP; else process.env.TEMP = prior.temp;
    if (prior.tmp === undefined) delete process.env.TMP; else process.env.TMP = prior.tmp;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("promotion preflight rejects external or missing Poppler with fixed non-leaking errors", async () => {
  const testRoot = resolve(".artifacts", `promotion-environment-rejection-${process.pid}`);
  await mkdir(join(testRoot, "eval"), { recursive: true });
  await writeFile(join(testRoot, "eval", "promotion-poppler.lock.json"), JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    basename: process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm",
    version: "26.05.0",
    packageSpec: "poppler=26.05.0=offline_test",
    sha256: "0".repeat(64),
    bundleFiles: 1,
    bundleSha256: "0".repeat(64),
  }));
  try {
    await assert.rejects(
      preflightPromotionEnvironment({ repoRoot: testRoot, popplerLocator: process.execPath, pdfFixtures: [] }),
      (error: unknown) => {
        assert.ok(error instanceof PromotionEnvironmentError);
        assert.equal(error.code, "poppler_outside_repository");
        assert.equal(error.message, "the promotion Poppler executable must resolve inside this repository");
        assert.doesNotMatch(error.message, /[A-Za-z]:\\|node\.exe/i);
        return true;
      }
    );
    await assert.rejects(
      preflightPromotionEnvironment({ repoRoot: testRoot, popplerLocator: ".artifacts/missing/pdftoppm.exe", pdfFixtures: [] }),
      (error: unknown) => {
        assert.ok(error instanceof PromotionEnvironmentError);
        assert.equal(error.code, "poppler_missing");
        assert.equal(error.message, "the project-contained promotion Poppler executable is unavailable");
        return true;
      }
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("evaluation safe-review preserves raw source uncertainty across normalization", () => {
  const clean = {
    vendor: "Aster Office Supply",
    invoice_number: "AST-1",
    invoice_date: "2026-05-03",
    tax_id: "EU-AST-1",
    currency: "EUR",
    subtotal: 100,
    tax: 20,
    total: 120,
    confidence: 0.95,
  };
  assert.deepEqual(evaluateVisionSafeReview(clean), {
    predicted: false,
    reasons: [],
    sourceFieldUncertainty: [],
    structuralFailures: [],
  });

  const obscuredTotal = evaluateVisionSafeReview({ ...clean, total: null });
  assert.equal(obscuredTotal.predicted, true);
  assert.ok(obscuredTotal.sourceFieldUncertainty.includes("source_missing_or_invalid:total"));
  assert.ok(
    !obscuredTotal.structuralFailures.includes("R1"),
    "normalization may infer total, but evaluation must preserve the raw-source uncertainty"
  );

  const missingConfidence = evaluateVisionSafeReview({ ...clean, confidence: undefined });
  assert.equal(missingConfidence.predicted, true);
  assert.ok(missingConfidence.reasons.includes("source_missing:confidence"));
});

test("promotion parameters fail closed when any environment-sensitive semantic drifts", () => {
  const values = {
    qwenRequestTimeoutMs: 20_000,
    qwenMaxRetries: 2,
    visionTimeoutMs: 45_000,
    popplerTimeoutMs: 20_000,
    popplerStderrMaxBytes: 8192,
    maxDocumentBytes: 10 * 1024 * 1024,
    maxPdfPages: 3,
    maxPdfRenderDimension: 2200,
    maxPdfRenderedBytes: 48 * 1024 * 1024,
    maxImageDimension: 8192,
    maxImagePixels: 32_000_000,
    extractionReviewThreshold: 0.6,
    autopilotMaxSteps: 8,
    autopilotDeadlineMs: 45_000,
    embeddingModel: "text-embedding-v4",
    embeddingDimensions: 1024,
    defaultDecisionModel: "qwen-plus",
    defaultVisionModel: "qwen-vl-max",
  };
  assert.doesNotThrow(() => assertPromotionParameterLock(values));
  assert.throws(
    () => assertPromotionParameterLock({ ...values, extractionReviewThreshold: 0.1 }),
    (error: unknown) => error instanceof PromotionEnvironmentError
      && error.code === "promotion_parameters_invalid"
      && !/[A-Za-z]:\\/.test(error.message)
  );
});
