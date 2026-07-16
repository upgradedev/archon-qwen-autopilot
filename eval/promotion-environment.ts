import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertRenderedPdfBudget,
  MAX_PDF_PAGES,
  pdfRenderArgs,
  POPPLER_TIMEOUT_MS,
  popplerSubprocessEnvironment,
  validateImageDimensions,
  validateMagicBytes,
} from "../src/qwen/vision.js";
import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_PDF_RENDER_DIMENSION,
  MAX_PDF_RENDERED_BYTES,
  DEFAULT_VISION_MODEL,
  POPPLER_STDERR_MAX_BYTES,
  VISION_TIMEOUT_MS,
} from "../src/qwen/vision.js";
import { QWEN_MAX_RETRIES, QWEN_REQUEST_TIMEOUT_MS } from "../src/qwen/client.js";
import { EXTRACTION_REVIEW_THRESHOLD } from "../src/ap/extraction-confidence.js";
import { DEFAULT_DECIDER_MODEL, DEFAULT_MAX_STEPS, DEFAULT_RUN_DEADLINE_MS } from "../src/ap/loop.js";
import { DEFAULT_EMBED_MODEL, EMBED_DIM } from "../src/memory/embeddings.js";

export type PromotionEnvironmentErrorCode =
  | "poppler_missing"
  | "poppler_outside_repository"
  | "poppler_invalid_binary"
  | "poppler_lock_invalid"
  | "poppler_attestation_mismatch"
  | "poppler_platform_unsupported"
  | "poppler_version_unavailable"
  | "pdf_raster_preflight_failed"
  | "promotion_temp_invalid"
  | "promotion_temp_cleanup_failed"
  | "promotion_parameters_invalid"
  | "promotion_runtime_invalid"
  | "promotion_protocol_tree_invalid"
  | "promotion_artifact_invalid"
  | "promotion_artifact_exists"
  | "promotion_endpoint_invalid"
  | "promotion_protocol_arguments_invalid"
  | "promotion_credentials_invalid";

const SAFE_MESSAGES: Record<PromotionEnvironmentErrorCode, string> = {
  poppler_missing: "the project-contained promotion Poppler executable is unavailable",
  poppler_outside_repository: "the promotion Poppler executable must resolve inside this repository",
  poppler_invalid_binary: "the project-contained promotion Poppler executable is invalid",
  poppler_lock_invalid: "the committed promotion Poppler lock is invalid",
  poppler_attestation_mismatch: "the project-contained promotion Poppler executable does not match its committed lock",
  poppler_platform_unsupported: "this platform is not pinned for keyed promotion evidence",
  poppler_version_unavailable: "the promotion Poppler version could not be attested",
  pdf_raster_preflight_failed: "the frozen PDF raster preflight failed",
  promotion_temp_invalid: "the promotion temporary workspace is not repository-contained",
  promotion_temp_cleanup_failed: "the promotion temporary workspace could not be cleaned",
  promotion_parameters_invalid: "the keyed promotion parameters do not match the committed protocol",
  promotion_runtime_invalid: "keyed evidence requires the committed Node and tsx runtime pins",
  promotion_protocol_tree_invalid: "keyed evidence requires committed protocol inputs and no unregistered dirty paths",
  promotion_artifact_invalid: "keyed evidence requires a fresh attempt-qualified result path inside this repository",
  promotion_artifact_exists: "the keyed evidence attempt already exists and is immutable",
  promotion_endpoint_invalid: "keyed evidence requires an allowlisted official provider endpoint",
  promotion_protocol_arguments_invalid: "keyed evidence arguments do not match the committed promotion experiment",
  promotion_credentials_invalid: "keyed evidence requires a syntactically valid provider credential",
};

export class PromotionEnvironmentError extends Error {
  readonly code: PromotionEnvironmentErrorCode;

  constructor(code: PromotionEnvironmentErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "PromotionEnvironmentError";
    this.code = code;
  }
}

export interface PromotionEnvironmentAttestation {
  status: "passed";
  poppler: {
    platform: string;
    architecture: string;
    basename: string;
    version: string;
    packageSpec: string;
    sha256: string;
    bundleFiles: number;
    bundleSha256: string;
  };
  frozenPdfRaster: { caseIds: string[]; cases: number; renderedPages: number; maxPagesPerDocument: number };
  temporaryFiles: {
    repositoryDirectory: ".artifacts";
    preflightCleanup: "completed-before-provider-calls";
    liveRunCleanup: "pending" | "completed-after-provider-calls";
  };
}

export interface PromotionEnvironment {
  repositoryRoot: string;
  executablePath: string;
  temporaryRoot: string;
  attestation: PromotionEnvironmentAttestation;
}

export interface PromotionCommandResult { stdout: string; stderr: string }
export interface PromotionCommandRunner {
  run(
    executable: string,
    args: string[],
    timeoutMs: number,
    environment: Readonly<Record<string, string>>
  ): Promise<PromotionCommandResult>;
}

export interface PromotionEnvironmentOptions {
  repoRoot?: string;
  popplerLocator?: string;
  pdfFixtures: Array<{ id: string; path: string }>;
  runner?: PromotionCommandRunner;
}

const exec = promisify(execFile);
const DEFAULT_POPPLER = ".artifacts/supply-chain/poppler/Library/bin/pdftoppm.exe";
const POPPLER_LOCK = "eval/promotion-poppler.lock.json";
const FROZEN_PDF_CASE_IDS = ["v03", "v09", "v11", "v13", "v14"] as const;

interface PopplerLock {
  schemaVersion: 1;
  platform: string;
  architecture: string;
  basename: string;
  version: string;
  packageSpec: string;
  sha256: string;
  bundleFiles: number;
  bundleSha256: string;
}

const defaultRunner: PromotionCommandRunner = {
  async run(executable, args, timeoutMs, environment) {
    const result = await exec(executable, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: popplerSubprocessEnvironment(process.env, environment),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !isAbsolute(rel) && !rel.startsWith("..") && !rel.split(/[\\/]/).includes("..");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function popplerBundleIdentity(executablePath: string, repoRoot: string): Promise<{
  files: number;
  sha256: string;
}> {
  const bundleRoot = await realpath(resolve(dirname(executablePath), ".."));
  if (!inside(repoRoot, bundleRoot)) throw new PromotionEnvironmentError("poppler_attestation_mismatch");
  const files: string[] = [];
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new PromotionEnvironmentError("poppler_attestation_mismatch");
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) files.push(name);
      else throw new PromotionEnvironmentError("poppler_attestation_mismatch");
    }
  };
  try {
    await walk(bundleRoot);
    files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const digest = createHash("sha256").update("archon-poppler-bundle-v1\n");
    for (const file of files) {
      const path = resolve(bundleRoot, ...file.split("/"));
      const fileHash = await sha256(path);
      digest.update(file).update("\0").update(fileHash).update("\n");
    }
    return { files: files.length, sha256: digest.digest("hex") };
  } catch (error) {
    throw fixedEnvironmentError(error, "poppler_attestation_mismatch");
  }
}

async function committedPopplerLock(repoRoot: string): Promise<PopplerLock> {
  try {
    const candidate = resolve(repoRoot, POPPLER_LOCK);
    const resolved = await realpath(candidate);
    if (!inside(repoRoot, resolved)) throw new Error("lock path escaped repository");
    const parsed = JSON.parse(await readFile(resolved, "utf8")) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.platform !== "string"
      || !/^[a-z0-9_-]{1,32}$/.test(parsed.platform)
      || typeof parsed.architecture !== "string"
      || !/^[a-z0-9_-]{1,32}$/.test(parsed.architecture)
      || typeof parsed.basename !== "string"
      || !/^pdftoppm(?:\.exe)?$/i.test(parsed.basename)
      || typeof parsed.version !== "string"
      || !/^[0-9]+(?:\.[0-9]+){1,3}$/.test(parsed.version)
      || typeof parsed.packageSpec !== "string"
      || !/^poppler=[0-9]+(?:\.[0-9]+){1,3}=[A-Za-z0-9_-]{1,64}$/.test(parsed.packageSpec)
      || typeof parsed.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(parsed.sha256)
      || !Number.isInteger(parsed.bundleFiles)
      || Number(parsed.bundleFiles) < 1
      || typeof parsed.bundleSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(parsed.bundleSha256)
    ) throw new Error("malformed lock");
    return parsed as unknown as PopplerLock;
  } catch {
    throw new PromotionEnvironmentError("poppler_lock_invalid");
  }
}

async function projectPoppler(repoRoot: string, locator?: string): Promise<string> {
  const configured = locator ?? process.env.POPPLER_PDFTOPPM
    ?? (process.platform === "win32" ? DEFAULT_POPPLER : "");
  if (!configured.trim() || configured.includes("\0")) throw new PromotionEnvironmentError("poppler_missing");
  const selected = configured.trim();
  const candidate = isAbsolute(selected) ? selected : resolve(repoRoot, selected);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new PromotionEnvironmentError("poppler_missing");
  }
  if (!inside(repoRoot, resolved)) throw new PromotionEnvironmentError("poppler_outside_repository");
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new PromotionEnvironmentError("poppler_missing");
  }
  if (!info.isFile() || !/^pdftoppm(?:\.exe)?$/i.test(basename(resolved))) {
    throw new PromotionEnvironmentError("poppler_invalid_binary");
  }
  return resolved;
}

export const PROMOTION_PARAMETER_LOCK = Object.freeze({
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
});

export function assertPromotionParameterLock(values: Record<string, number | string> = {
  qwenRequestTimeoutMs: QWEN_REQUEST_TIMEOUT_MS,
  qwenMaxRetries: QWEN_MAX_RETRIES,
  visionTimeoutMs: VISION_TIMEOUT_MS,
  popplerTimeoutMs: POPPLER_TIMEOUT_MS,
  popplerStderrMaxBytes: POPPLER_STDERR_MAX_BYTES,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxPdfPages: MAX_PDF_PAGES,
  maxPdfRenderDimension: MAX_PDF_RENDER_DIMENSION,
  maxPdfRenderedBytes: MAX_PDF_RENDERED_BYTES,
  maxImageDimension: MAX_IMAGE_DIMENSION,
  maxImagePixels: MAX_IMAGE_PIXELS,
  extractionReviewThreshold: EXTRACTION_REVIEW_THRESHOLD,
  autopilotMaxSteps: DEFAULT_MAX_STEPS,
  autopilotDeadlineMs: DEFAULT_RUN_DEADLINE_MS,
  embeddingModel: DEFAULT_EMBED_MODEL,
  embeddingDimensions: EMBED_DIM,
  defaultDecisionModel: DEFAULT_DECIDER_MODEL,
  defaultVisionModel: DEFAULT_VISION_MODEL,
}): void {
  for (const [name, expected] of Object.entries(PROMOTION_PARAMETER_LOCK)) {
    if (values[name] !== expected) throw new PromotionEnvironmentError("promotion_parameters_invalid");
  }
}

async function safeTempRoot(repoRoot: string): Promise<string> {
  const artifactRoot = resolve(repoRoot, ".artifacts");
  try {
    await mkdir(artifactRoot, { recursive: true });
    const resolved = await realpath(artifactRoot);
    if (!inside(repoRoot, resolved)) throw new PromotionEnvironmentError("promotion_temp_invalid");
    return resolved;
  } catch (error) {
    if (error instanceof PromotionEnvironmentError) throw error;
    throw new PromotionEnvironmentError("promotion_temp_invalid");
  }
}

function fixedEnvironmentError(error: unknown, fallback: PromotionEnvironmentErrorCode): PromotionEnvironmentError {
  return error instanceof PromotionEnvironmentError ? error : new PromotionEnvironmentError(fallback);
}

export async function preflightPromotionEnvironment(
  options: PromotionEnvironmentOptions
): Promise<PromotionEnvironment> {
  assertPromotionParameterLock();
  const repoRoot = await realpath(resolve(options.repoRoot ?? process.cwd())).catch(() => {
    throw new PromotionEnvironmentError("promotion_temp_invalid");
  });
  const expected = await committedPopplerLock(repoRoot);
  if (expected.platform !== process.platform || expected.architecture !== process.arch) {
    throw new PromotionEnvironmentError("poppler_platform_unsupported");
  }
  const executablePath = await projectPoppler(repoRoot, options.popplerLocator);
  const binarySha256 = await sha256(executablePath).catch(() => {
    throw new PromotionEnvironmentError("poppler_invalid_binary");
  });
  const bundle = await popplerBundleIdentity(executablePath, repoRoot);
  if (basename(executablePath) !== expected.basename || binarySha256 !== expected.sha256
    || bundle.files !== expected.bundleFiles || bundle.sha256 !== expected.bundleSha256) {
    throw new PromotionEnvironmentError("poppler_attestation_mismatch");
  }
  const temporaryRoot = await safeTempRoot(repoRoot);
  const childEnvironment = Object.freeze({ TMPDIR: temporaryRoot, TEMP: temporaryRoot, TMP: temporaryRoot });
  const runner = options.runner ?? defaultRunner;
  let versionResult: PromotionCommandResult;
  try {
    versionResult = await runner.run(executablePath, ["-v"], POPPLER_TIMEOUT_MS, childEnvironment);
  } catch (error) {
    throw fixedEnvironmentError(error, "poppler_version_unavailable");
  }
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`;
  const version = /pdftoppm version\s+([0-9]+(?:\.[0-9]+){1,3})/i.exec(versionText)?.[1];
  if (!version) throw new PromotionEnvironmentError("poppler_version_unavailable");
  if (version !== expected.version) throw new PromotionEnvironmentError("poppler_attestation_mismatch");
  if (JSON.stringify(options.pdfFixtures.map((fixture) => fixture.id)) !== JSON.stringify(FROZEN_PDF_CASE_IDS)) {
    throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
  }

  let work: string;
  try {
    work = await mkdtemp(join(temporaryRoot, `promotion-environment-${process.pid}-${randomUUID()}-`));
  } catch {
    throw new PromotionEnvironmentError("promotion_temp_invalid");
  }
  let renderedPages = 0;
  let preflightError: PromotionEnvironmentError | null = null;
  try {
    for (const fixture of options.pdfFixtures) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(fixture.id)) {
        throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
      }
      const fixtureReal = await realpath(fixture.path).catch(() => "");
      if (!fixtureReal || !inside(repoRoot, fixtureReal)) {
        throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
      }
      const fixtureBytes = await readFile(fixtureReal).catch(() => Buffer.alloc(0));
      if (!validateMagicBytes(fixtureBytes, ".pdf").ok) {
        throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
      }
      const caseDir = join(work, fixture.id);
      await mkdir(caseDir);
      const outPrefix = join(caseDir, "page");
      try {
        await runner.run(executablePath, pdfRenderArgs(fixtureReal, outPrefix), POPPLER_TIMEOUT_MS, childEnvironment);
      } catch {
        throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
      }
      const pages = (await readdir(caseDir))
        .filter((name) => /^page-\d+\.png$/i.test(name))
        .sort();
      if (pages.length < 1 || pages.length > MAX_PDF_PAGES) {
        throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
      }
      const sizes: number[] = [];
      for (const page of pages) {
        const bytes = await readFile(join(caseDir, page));
        const magic = validateMagicBytes(bytes, ".png");
        const dimensions = validateImageDimensions(bytes, ".png");
        if (!magic.ok || !dimensions.ok) throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
        sizes.push(bytes.length);
      }
      try {
        assertRenderedPdfBudget(sizes);
      } catch {
        throw new PromotionEnvironmentError("pdf_raster_preflight_failed");
      }
      renderedPages += pages.length;
    }
  } catch (error) {
    preflightError = fixedEnvironmentError(error, "pdf_raster_preflight_failed");
  }

  try {
    await rm(work, { recursive: true, force: true });
  } catch {
    throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
  }
  if (preflightError) throw preflightError;
  const binaryShaAfter = await sha256(executablePath).catch(() => "");
  const bundleAfter = await popplerBundleIdentity(executablePath, repoRoot);
  if (binaryShaAfter !== binarySha256 || binaryShaAfter !== expected.sha256
    || bundleAfter.files !== bundle.files || bundleAfter.sha256 !== bundle.sha256) {
    throw new PromotionEnvironmentError("poppler_attestation_mismatch");
  }

  let liveRoot: string;
  try {
    liveRoot = await mkdtemp(join(temporaryRoot, `promotion-live-${process.pid}-${randomUUID()}-`));
  } catch {
    throw new PromotionEnvironmentError("promotion_temp_invalid");
  }

  return {
    repositoryRoot: repoRoot,
    executablePath,
    temporaryRoot: liveRoot,
    attestation: {
      status: "passed",
      poppler: {
        platform: process.platform,
        architecture: process.arch,
        basename: basename(executablePath),
        version,
        packageSpec: expected.packageSpec,
        sha256: binarySha256,
        bundleFiles: bundle.files,
        bundleSha256: bundle.sha256,
      },
      frozenPdfRaster: {
        caseIds: options.pdfFixtures.map((fixture) => fixture.id),
        cases: options.pdfFixtures.length,
        renderedPages,
        maxPagesPerDocument: MAX_PDF_PAGES,
      },
      temporaryFiles: {
        repositoryDirectory: ".artifacts",
        preflightCleanup: "completed-before-provider-calls",
        liveRunCleanup: "pending",
      },
    },
  };
}

export async function finalizePromotionEnvironment(
  environment: PromotionEnvironment
): Promise<PromotionEnvironmentAttestation> {
  let root: string;
  let liveRoot: string;
  try {
    root = await realpath(environment.repositoryRoot);
    liveRoot = await realpath(environment.temporaryRoot);
    if (!inside(root, liveRoot) || relative(root, liveRoot).replace(/\\/g, "/").split("/")[0] !== ".artifacts") {
      throw new PromotionEnvironmentError("promotion_temp_invalid");
    }
  } catch (error) {
    throw fixedEnvironmentError(error, "promotion_temp_cleanup_failed");
  }

  let containedUnexpectedFiles = false;
  try {
    containedUnexpectedFiles = (await readdir(liveRoot)).length > 0;
  } catch {
    throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
  }
  try {
    // Even a failed cleanup attestation makes a best effort to remove any rendered
    // invoice pages. The attempt still fails closed when files survived until this
    // boundary; cleanup success does not retroactively earn a clean attestation.
    await rm(liveRoot, { recursive: true, force: true });
  } catch {
    throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
  }
  if (containedUnexpectedFiles) {
    throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
  }

  try {
    const executableSha = await sha256(environment.executablePath);
    const bundle = await popplerBundleIdentity(environment.executablePath, root);
    if (
      executableSha !== environment.attestation.poppler.sha256
      || bundle.files !== environment.attestation.poppler.bundleFiles
      || bundle.sha256 !== environment.attestation.poppler.bundleSha256
    ) throw new PromotionEnvironmentError("poppler_attestation_mismatch");
    return {
      ...environment.attestation,
      temporaryFiles: {
        ...environment.attestation.temporaryFiles,
        liveRunCleanup: "completed-after-provider-calls",
      },
    };
  } catch (error) {
    throw fixedEnvironmentError(error, "promotion_temp_cleanup_failed");
  }
}

// Failure paths before final attestation still have to erase the unique live root.
// This helper is deliberately idempotent so an outer finally can invoke it after
// artifact publication/persistence failures without weakening containment checks.
export async function cleanupPromotionEnvironment(environment: PromotionEnvironment): Promise<void> {
  try {
    const root = await realpath(environment.repositoryRoot);
    let liveRoot: string;
    try {
      liveRoot = await realpath(environment.temporaryRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!inside(root, liveRoot)
      || relative(root, liveRoot).replace(/\\/g, "/").split("/")[0] !== ".artifacts") {
      throw new PromotionEnvironmentError("promotion_temp_invalid");
    }
    await rm(liveRoot, { recursive: true, force: true });
    try {
      await lstat(liveRoot);
      throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    throw fixedEnvironmentError(error, "promotion_temp_cleanup_failed");
  }
}

// The extraction seam reads these process variables lazily. Promotion runs point
// both Poppler and every Node temporary file at the already-attested repository
// paths; no absolute locator is serialized into evidence.
export function applyPromotionEnvironment(environment: PromotionEnvironment): () => void {
  const previous = {
    POPPLER_PDFTOPPM: process.env.POPPLER_PDFTOPPM,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
  process.env.POPPLER_PDFTOPPM = environment.executablePath;
  process.env.TMPDIR = environment.temporaryRoot;
  process.env.TEMP = environment.temporaryRoot;
  process.env.TMP = environment.temporaryRoot;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export function promotionEnvironmentDiagnostic(error: PromotionEnvironmentError): {
  category: "promotion_environment_invalid";
  code: PromotionEnvironmentErrorCode;
  summary: string;
} {
  return { category: "promotion_environment_invalid", code: error.code, summary: error.message };
}
