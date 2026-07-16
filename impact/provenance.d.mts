export const LOCKED_NODE_VERSION: "v24.18.0";
export const LOCKED_NODE_LABEL: "Node.js 24.18.0";
export const REPLAY_SOURCE_PATHS: readonly string[];
export const REPLAY_EVIDENCE_INPUT_PATHS: readonly string[];

export interface ReplaySourceCollection {
  sourceCommit: string;
  sourceIdentity: {
    gitTree: string;
    replaySourcePaths: string[];
  };
}

export interface VerifiedReplaySourceIdentity {
  gitCommit: string;
  gitTree: string;
  replaySourcePaths: string[];
  sourceCommitIsAncestor: true;
  currentHeadSourceClosureMatches: true;
  worktreeSourceClosureClean: true;
  indexFlagsClean: true;
}

export function assertLockedImpactRuntime(actualVersion?: string): void;
export function assertCommittedReplayEvidenceInputs(options?: { repoRoot?: string }): void;
export function captureReplaySourceIdentityAtCleanHead(
  options?: { repoRoot?: string },
): Readonly<VerifiedReplaySourceIdentity>;
export function verifyReplaySourceIdentity(
  collection: ReplaySourceCollection,
  options?: { repoRoot?: string },
): Readonly<VerifiedReplaySourceIdentity>;
