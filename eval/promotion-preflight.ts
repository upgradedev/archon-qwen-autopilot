// Zero-provider-call readiness check for the keyed model-promotion attempt.
// It exercises every environment/provenance boundary that can fail before model
// quality is measured, but never creates the immutable result path.

import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertFrozenDataset } from "./hash.js";
import { EVAL_SET } from "./dataset.js";
import {
  canonicalEvidenceCommand,
  categoricalEvalError,
  probeEvidencePublicationDirectory,
  promotionEvidenceArtifactPath,
} from "./artifact-safety.js";
import {
  parsePromotionCli,
  PROMOTION_ABSOLUTE_GATES,
  PROMOTION_ARTIFACT_POLICY,
  PROMOTION_MODELS,
  PROMOTION_MATERIAL_BENEFIT_GATES,
  PROMOTION_PROTOCOL_FILES,
  PROMOTION_RELATIVE_GATES,
  comparePromotionReleaseSnapshots,
  promotionReleaseSnapshot,
} from "./compare.js";
import {
  cleanupPromotionEnvironment,
  finalizePromotionEnvironment,
  preflightPromotionEnvironment,
  PromotionEnvironmentError,
  promotionEnvironmentDiagnostic,
} from "./promotion-environment.js";
import {
  assertPinnedPromotionRuntime,
  committedProtocolState,
  PINNED_PROMOTION_RUNTIME,
} from "./protocol-provenance.js";
import { loadFrozenVisionSet } from "./vision/fixtures.js";
import { officialEvidenceEndpoint } from "../src/qwen/client.js";

async function main(): Promise<void> {
  const cli = parsePromotionCli(["--online", ...process.argv.slice(2)]);
  await assertPinnedPromotionRuntime();
  const target = await promotionEvidenceArtifactPath(
    cli.write,
    process.cwd(),
    PROMOTION_ARTIFACT_POLICY
  );
  const datasetSha256 = await assertFrozenDataset();
  const vision = await loadFrozenVisionSet();
  let endpoint: ReturnType<typeof officialEvidenceEndpoint>;
  try {
    endpoint = officialEvidenceEndpoint();
  } catch {
    throw new PromotionEnvironmentError("promotion_endpoint_invalid");
  }
  const protocol = await committedProtocolState(PROMOTION_PROTOCOL_FILES, {
    strict: true,
    allowResultArtifacts: true,
    expectedReleaseGitCommit: cli.expectedRelease,
    requireHeadMatchesOriginMain: true,
  });
  const publicationCapability = await probeEvidencePublicationDirectory(resolve(process.cwd(), "eval", "results"));
  const afterPublicationProbe = await committedProtocolState(PROMOTION_PROTOCOL_FILES, {
    strict: true,
    allowResultArtifacts: true,
    expectedReleaseGitCommit: cli.expectedRelease,
    requireHeadMatchesOriginMain: true,
  });
  if (afterPublicationProbe.protocolSha256 !== protocol.protocolSha256) {
    throw new PromotionEnvironmentError("promotion_protocol_tree_invalid");
  }
  const environment = await preflightPromotionEnvironment({ pdfFixtures: vision.pdfFixtures });
  let environmentFinalized = false;
  let attestation;
  try {
    attestation = await finalizePromotionEnvironment(environment);
    environmentFinalized = true;
  } finally {
    if (!environmentFinalized) {
      await cleanupPromotionEnvironment(environment).catch(() => {
        throw new PromotionEnvironmentError("promotion_temp_cleanup_failed");
      });
    }
  }
  const endDatasetSha256 = await assertFrozenDataset();
  const endVision = await loadFrozenVisionSet();
  const endProtocol = await committedProtocolState(PROMOTION_PROTOCOL_FILES, {
    strict: true,
    allowResultArtifacts: true,
    expectedReleaseGitCommit: cli.expectedRelease,
    requireHeadMatchesOriginMain: true,
  });
  const releaseStart = promotionReleaseSnapshot(protocol, datasetSha256, vision, environment.attestation);
  const releaseEnd = promotionReleaseSnapshot(endProtocol, endDatasetSha256, endVision, attestation);
  const releaseComparison = comparePromotionReleaseSnapshots(releaseStart, releaseEnd);
  if (releaseComparison.status !== "passed") {
    throw new PromotionEnvironmentError("promotion_protocol_tree_invalid");
  }
  const commandArgs = [
    "--runs", "4",
    "--baseline-decision", cli.baselineDecision,
    "--baseline-vision", cli.baselineVision,
    "--candidate", cli.candidate,
    "--expected-release", cli.expectedRelease,
    "--write", relative(process.cwd(), target).replace(/\\/g, "/"),
  ];
  console.log(JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    check: "archon-model-promotion-preflight",
    providerCalls: 0,
    artifactCreated: false,
    nextArtifact: relative(process.cwd(), target).replace(/\\/g, "/"),
    models: PROMOTION_MODELS,
    endpoint,
    runtime: PINNED_PROMOTION_RUNTIME,
    dataset: { cases: EVAL_SET.length, sha256: datasetSha256 },
    visionFixtureSet: { cases: vision.manifest.cases.length, sha256: vision.fixtureSetSha256, fixtureBytesSha256: vision.fixtureBytesSha256 },
    protocol: {
      gitCommit: protocol.gitCommit,
      originMainGitCommit: protocol.originMainGitCommit,
      expectedReleaseGitCommit: protocol.expectedReleaseGitCommit,
      headMatchesExpectedRelease: protocol.headMatchesExpectedRelease,
      headMatchesOriginMain: protocol.headMatchesOriginMain,
      gitClean: protocol.gitClean,
      protocolTreeClean: protocol.protocolTreeClean,
      protocolSha256: protocol.protocolSha256,
      protocolBlobs: protocol.protocolBlobs,
      files: protocol.files,
      allowedDirtyResultArtifacts: protocol.allowedDirtyResultArtifacts,
      priorEvidence: protocol.evidenceLedger,
    },
    promotionEnvironment: attestation,
    publicationCapability,
    sameReleaseAttestation: {
      status: releaseComparison.status,
      start: releaseStart,
      end: releaseEnd,
      mismatches: releaseComparison.mismatches,
    },
    gates: {
      absoluteCandidate: PROMOTION_ABSOLUTE_GATES,
      relativeNonInferiority: PROMOTION_RELATIVE_GATES,
      materialBenefit: PROMOTION_MATERIAL_BENEFIT_GATES,
    },
    command: canonicalEvidenceCommand("eval/promotion-preflight.ts", commandArgs),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof PromotionEnvironmentError
      ? promotionEnvironmentDiagnostic(error)
      : categoricalEvalError(error);
    console.error(`Promotion preflight failed: ${JSON.stringify(safe)}`);
    process.exit(1);
  });
}
