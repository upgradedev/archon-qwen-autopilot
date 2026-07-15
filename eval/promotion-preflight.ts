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
  promotionEvidenceArtifactPath,
} from "./artifact-safety.js";
import {
  parsePromotionCli,
  PROMOTION_ABSOLUTE_GATES,
  PROMOTION_ARTIFACT_POLICY,
  PROMOTION_MODELS,
  PROMOTION_PROTOCOL_FILES,
  PROMOTION_RELATIVE_GATES,
} from "./compare.js";
import {
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
  });
  const environment = await preflightPromotionEnvironment({ pdfFixtures: vision.pdfFixtures });
  const attestation = await finalizePromotionEnvironment(environment);
  const commandArgs = [
    "--runs", "4",
    "--baseline-decision", cli.baselineDecision,
    "--baseline-vision", cli.baselineVision,
    "--candidate", cli.candidate,
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
    visionFixtureSet: { cases: vision.manifest.cases.length, sha256: vision.fixtureSetSha256 },
    protocol: {
      gitCommit: protocol.gitCommit,
      gitClean: protocol.gitClean,
      protocolTreeClean: protocol.protocolTreeClean,
      protocolSha256: protocol.protocolSha256,
      files: protocol.files,
      allowedDirtyResultArtifacts: protocol.allowedDirtyResultArtifacts,
      priorEvidence: protocol.evidenceLedger,
    },
    promotionEnvironment: attestation,
    gates: {
      absoluteCandidate: PROMOTION_ABSOLUTE_GATES,
      relativeNonInferiority: PROMOTION_RELATIVE_GATES,
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
