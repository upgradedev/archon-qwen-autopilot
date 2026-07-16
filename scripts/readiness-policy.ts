export const READINESS_GATE_THRESHOLD_PCT = 95 as const;

/**
 * A green release-readiness gate means both that the weighted completion floor
 * is met and that no automatable check is known to be failing. Keeping this as
 * a small pure policy function lets the integration suite pin the exact boundary
 * without manufacturing a failure in the full readiness workflow.
 */
export function passesReadinessGate(
  automatableCompletionPct: number,
  failedAutomatableChecks: number,
): boolean {
  return (
    Number.isFinite(automatableCompletionPct) &&
    automatableCompletionPct >= 0 &&
    automatableCompletionPct <= 100 &&
    automatableCompletionPct >= READINESS_GATE_THRESHOLD_PCT &&
    Number.isSafeInteger(failedAutomatableChecks) &&
    failedAutomatableChecks === 0
  );
}
