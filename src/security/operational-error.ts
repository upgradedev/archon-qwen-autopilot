import { randomUUID } from "node:crypto";

export type OperationalErrorCode =
  | "timeout"
  | "authentication_failed"
  | "rate_limited"
  | "storage_unavailable"
  | "delivery_unavailable"
  | "provider_unavailable"
  | "invalid_upstream_response"
  | "unexpected_failure";

export interface SafeOperationalError {
  code: OperationalErrorCode;
  message: string;
  reference: string;
  context: string;
}

const MESSAGES: Record<OperationalErrorCode, string> = {
  timeout: "the operation timed out",
  authentication_failed: "upstream authentication failed",
  rate_limited: "the upstream service is rate limited",
  storage_unavailable: "durable storage is unavailable",
  delivery_unavailable: "the delivery service is unavailable",
  provider_unavailable: "the upstream provider is unavailable",
  invalid_upstream_response: "the upstream service returned an invalid response",
  unexpected_failure: "an unexpected operational failure occurred",
};

// Classification may inspect the raw error in-process, but neither its message nor
// stack crosses this function. API bodies, work items, memory warnings, and logs get
// only the fixed allowlisted message plus a correlation reference.
export function toSafeOperationalError(err: unknown, context = "operation"): SafeOperationalError {
  const candidate = err as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown; message?: unknown };
  const raw = `${String(candidate?.name ?? "")} ${String(candidate?.code ?? "")} ${String(
    candidate?.status ?? candidate?.statusCode ?? ""
  )} ${String(candidate?.message ?? (typeof err === "string" ? err : ""))}`.toLowerCase();
  let code: OperationalErrorCode = "unexpected_failure";
  if (/timeout|timed out|aborterror|etimedout/.test(raw)) code = "timeout";
  else if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|auth|credential|api[_ -]?key/.test(raw)) {
    code = "authentication_failed";
  } else if (/\b429\b|rate.?limit|too many requests|quota/.test(raw)) code = "rate_limited";
  else if (/postgres|database|sqlstate|econnrefused|connection refused|storage|disk|enospc/.test(raw)) {
    code = "storage_unavailable";
  } else if (/smtp|email|mail|delivery/.test(raw)) code = "delivery_unavailable";
  else if (/json|parse|schema|invalid response|malformed/.test(raw)) code = "invalid_upstream_response";
  else if (/provider|upstream|network|fetch|socket|econnreset|unavailable/.test(raw)) {
    code = "provider_unavailable";
  }
  return { code, message: MESSAGES[code], reference: randomUUID(), context };
}

export function safeOperationalSummary(err: unknown, context = "operation"): string {
  const safe = toSafeOperationalError(err, context);
  return `${safe.message} [${safe.code}; ref ${safe.reference}]`;
}
