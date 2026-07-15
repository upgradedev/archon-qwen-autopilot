// Shared financial-domain bounds used by both analysis and the irreversible sink
// boundary. A proposal that passes R1–R4 must not later become non-executable only
// because the reviewer validator applies a different amount policy.

export const MAX_FINANCIAL_AMOUNT = 1_000_000_000;

export function isBoundedNonnegativeAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_FINANCIAL_AMOUNT;
}

export function isBoundedPositiveAmount(value: unknown): value is number {
  return isBoundedNonnegativeAmount(value) && value > 0;
}
