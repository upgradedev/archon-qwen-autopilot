import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cleanupPromotionEvidenceStagingRemnants } from "./artifact-safety.js";
import { PromotionEnvironmentError, promotionEnvironmentDiagnostic } from "./promotion-environment.js";
import { verifiedEvidenceLedger } from "./protocol-provenance.js";

export interface PromotionRecoveryReport {
  status: "passed";
  providerCalls: 0;
  artifact: {
    path: string;
    authoritative: "absent" | "present-unregistered" | "present-registered";
    rootStatus: "incomplete" | "promotion-pass" | "promotion-fail" | null;
    sha256: string | null;
    sourceCommit: string | null;
  };
  staging: { authority: "non-authoritative"; removed: string[] };
  recovery: {
    sameAttemptReusable: boolean;
    requiredAction: "rerun-preflight-for-same-attempt" | "register-immutable-artifact-before-next-attempt" | "use-next-attempt";
    nextAttemptPath: string;
  };
}

export function parsePromotionRecoveryCli(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== "--write"
    || !/^eval\/results\/model-promotion-ab-attempt-(?:0[2-9]|[1-9][0-9])\.json$/.test(argv[1] ?? "")) {
    throw new PromotionEnvironmentError("promotion_protocol_arguments_invalid");
  }
  return argv[1]!;
}

export async function recoverPromotionAttempt(
  input: string,
  repoRoot = process.cwd()
): Promise<PromotionRecoveryReport> {
  if (isAbsolute(input) || input.includes("\\")
    || !/^eval\/results\/model-promotion-ab-attempt-(?:0[2-9]|[1-9][0-9])\.json$/.test(input)) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  const root = await realpath(resolve(repoRoot)).catch(() => {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  });
  const target = resolve(root, input);
  if (relative(root, target).replace(/\\/g, "/") !== input) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  const staging = await cleanupPromotionEvidenceStagingRemnants(input, root);
  const ledger = await verifiedEvidenceLedger(root).catch(() => {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  });
  const matching = ledger.filter((entry) => /^eval\/results\/model-promotion-ab-attempt-[0-9]{2}\.json$/.test(entry.path));
  const attempt = Number(/attempt-([0-9]{2})\.json$/.exec(input)?.[1]);
  const registered = matching.find((entry) => entry.path === input);
  const nextAttempt = matching.length + 1;
  if ((!registered && attempt !== nextAttempt) || (registered && attempt >= nextAttempt)) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }

  let info;
  try { info = await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PromotionEnvironmentError("promotion_artifact_invalid");
    }
  }
  if (!info) {
    if (registered) throw new PromotionEnvironmentError("promotion_artifact_invalid");
    return {
      status: "passed",
      providerCalls: 0,
      artifact: { path: input, authoritative: "absent", rootStatus: null, sha256: null, sourceCommit: null },
      staging: { authority: "non-authoritative", removed: staging.removed },
      recovery: {
        sameAttemptReusable: true,
        requiredAction: "rerun-preflight-for-same-attempt",
        nextAttemptPath: input,
      },
    };
  }
  const targetReal = await realpath(target).catch(() => "");
  if (!info.isFile() || info.isSymbolicLink()
    || !targetReal || relative(root, targetReal).replace(/\\/g, "/") !== input) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  const bytes = await readFile(targetReal);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  const rootStatus = parsed.status;
  const sourceCommit = (parsed.provenance as Record<string, unknown> | undefined)?.gitCommit;
  if (!new Set(["incomplete", "promotion-pass", "promotion-fail"]).has(String(rootStatus))
    || typeof sourceCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    throw new PromotionEnvironmentError("promotion_artifact_invalid");
  }
  return {
    status: "passed",
    providerCalls: 0,
    artifact: {
      path: input,
      authoritative: registered ? "present-registered" : "present-unregistered",
      rootStatus: rootStatus as PromotionRecoveryReport["artifact"]["rootStatus"],
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceCommit,
    },
    staging: { authority: "non-authoritative", removed: staging.removed },
    recovery: {
      sameAttemptReusable: false,
      requiredAction: registered ? "use-next-attempt" : "register-immutable-artifact-before-next-attempt",
      nextAttemptPath: `eval/results/model-promotion-ab-attempt-${String(registered ? nextAttempt : attempt + 1).padStart(2, "0")}.json`,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  recoverPromotionAttempt(parsePromotionRecoveryCli(process.argv.slice(2))).then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error) => {
    const fixed = error instanceof PromotionEnvironmentError
      ? error
      : new PromotionEnvironmentError("promotion_artifact_invalid");
    console.error(JSON.stringify(promotionEnvironmentDiagnostic(fixed)));
    process.exit(1);
  });
}
