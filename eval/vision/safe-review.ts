import { hasLowExtractionConfidence } from "../../src/ap/extraction-confidence.js";
import { normalizeInvoice } from "../../src/ap/normalize.js";
import { validateInvoice } from "../../src/ap/validate.js";

export interface VisionSafeReview {
  predicted: boolean;
  reasons: string[];
  sourceFieldUncertainty: string[];
  structuralFailures: string[];
}

const REQUIRED_SOURCE_TEXT_FIELDS = [
  "vendor",
  "invoice_number",
  "invoice_date",
  "tax_id",
  "currency",
] as const;
const REQUIRED_SOURCE_AMOUNT_FIELDS = ["subtotal", "tax", "total"] as const;

function missingText(value: unknown): boolean {
  return typeof value !== "string" || !value.trim() || value.trim().toUpperCase() === "UNKNOWN";
}

// Evaluation source-quality accounting intentionally inspects the raw model
// extraction before normalizeInvoice can infer a payable total or canonical aliases.
// It independently measures every uncertain source field, including safeguards that
// production may route more narrowly, so inference cannot erase benchmark uncertainty.
export function evaluateVisionSafeReview(invoice: Record<string, unknown>): VisionSafeReview {
  const sourceFieldUncertainty: string[] = [];
  for (const field of REQUIRED_SOURCE_TEXT_FIELDS) {
    if (missingText(invoice[field])) sourceFieldUncertainty.push(`source_missing:${field}`);
  }
  for (const field of REQUIRED_SOURCE_AMOUNT_FIELDS) {
    if (typeof invoice[field] !== "number" || !Number.isFinite(invoice[field])) {
      sourceFieldUncertainty.push(`source_missing_or_invalid:${field}`);
    }
  }
  const confidence = invoice.confidence;
  if (confidence == null) sourceFieldUncertainty.push("source_missing:confidence");
  else if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    sourceFieldUncertainty.push("source_invalid:confidence");
  }

  const normalized = normalizeInvoice(invoice);
  const structuralFailures = validateInvoice(normalized)
    .filter((finding) => !finding.passed)
    .map((finding) => finding.rule);
  const lowConfidence = hasLowExtractionConfidence(normalized.extraction_confidence);
  const reasons = [
    ...sourceFieldUncertainty,
    ...(lowConfidence ? ["low_extraction_confidence"] : []),
    ...structuralFailures.map((rule) => `structural:${rule}`),
  ];
  return {
    predicted: reasons.length > 0,
    reasons,
    sourceFieldUncertainty,
    structuralFailures,
  };
}
