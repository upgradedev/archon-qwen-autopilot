// Currency safety boundary. ECMA-402 exposes the runtime's CLDR-backed set of
// recognized ISO 4217 currency identifiers. Cache it once so normalization,
// reviewer validation, and historical comparisons use the exact same predicate.
// The conservative fallback is used only on runtimes without supportedValuesOf;
// rejecting a rare valid code for human clarification is safer than accepting a
// fabricated three-letter token at a financial sink.

const FALLBACK_ISO_4217 = [
  "AED", "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "JPY", "KRW", "MXN", "MYR", "NOK",
  "NZD", "PHP", "PLN", "RON", "SAR", "SEK", "SGD", "THB", "TRY", "TWD",
  "USD", "VND", "ZAR",
] as const;

type IntlWithSupportedCurrencies = typeof Intl & {
  supportedValuesOf?: (key: "currency") => string[];
};

const runtimeValues = (Intl as IntlWithSupportedCurrencies).supportedValuesOf?.("currency");
const SUPPORTED_CURRENCIES = new Set(
  (runtimeValues?.length ? runtimeValues : [...FALLBACK_ISO_4217]).map((code) => code.toUpperCase())
);

export function canonicalCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return isSupportedCurrency(code) ? code : null;
}

export function isSupportedCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) && SUPPORTED_CURRENCIES.has(value);
}

export function supportedCurrencyCodes(): readonly string[] {
  return [...SUPPORTED_CURRENCIES].sort();
}
