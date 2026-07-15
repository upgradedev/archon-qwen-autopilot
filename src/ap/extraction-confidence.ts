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

// A document extractor may correctly return `total: null` when the payable total
// is obscured while still reading subtotal and tax. The normalizer's arithmetic
// inference is useful for a reviewer, but it must not be mistaken for a value read
// from the source document. Restrict this guard to inputs carrying the extraction
// confidence signal so ordinary JSON invoices keep their existing normalization
// behavior and do not acquire document-only false positives.
export function hasInferredPayableTotal(
  extractionConfidence: number | null | undefined,
  normalizationNotes: readonly string[]
): boolean {
  const carriesExtractionSignal =
    typeof extractionConfidence === "number" && Number.isFinite(extractionConfidence);
  return carriesExtractionSignal && normalizationNotes.some((note) =>
    note.startsWith("total inferred from subtotal + tax = ")
  );
}

function boundedEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
