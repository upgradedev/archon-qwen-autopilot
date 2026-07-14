// Qwen-VL document-read confidence is a source-quality signal, distinct from the
// decision model's confidence in its proposed AP action. A weak extraction must
// never be allowed to look like a confident payment recommendation.

export const EXTRACTION_REVIEW_THRESHOLD = boundedEnvNumber(
  "EXTRACTION_REVIEW_THRESHOLD",
  0.6,
  0,
  1
);

export function hasLowExtractionConfidence(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value < EXTRACTION_REVIEW_THRESHOLD;
}

function boundedEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
