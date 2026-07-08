// Daily upload rate limiter — protects the Qwen API budget on the OPEN demo.
//
// The live demo is intentionally open (no login, so judges can test it freely —
// see the README). To keep an open endpoint from running up the Qwen bill, invoice
// uploads (POST /intake and the streaming / document routes) are capped PER UTC DAY.
// This is a deliberate, rules-compliant guardrail, not authentication.
//
// TWO TIERS, so a single busy client cannot starve everyone else out of the demo:
//   • a PER-CLIENT bucket (keyed by a best-effort client id — the caller passes the
//     request's IP), so one judge hitting the cap does not 429 the next judge; and
//   • a GLOBAL backstop across all clients, so the total spend stays bounded even
//     with many distinct clients (the whole reason the limiter exists). A decision
//     is rejected when EITHER the caller's own bucket OR the global backstop is full,
//     and the result says WHICH (`scope`) so the message is accurate.
//
// It is per-process and in-memory, keyed by the UTC calendar day, so it resets at
// 00:00 UTC (and on restart). That is sufficient for a single-box demo; a multi-
// instance deployment would move this to a shared store (e.g. the same PostgreSQL).
// The clock is injectable so the UTC-reset behaviour is unit-testable.
//
// Honesty note on the per-client key: behind a reverse proxy the caller's IP is only
// as trustworthy as the proxy's `X-Forwarded-For`, which a client can spoof. So the
// per-client bucket is a BEST-EFFORT fairness split, and the GLOBAL backstop is the
// hard, spoof-proof spend bound. Size the backstop so that even in the degenerate
// "every client collapses to one key" case it alone does not starve the judges.

// The per-client daily cap. 100 uploads/day per client is plenty for a judge to
// exercise every path many times over while bounding one client's spend; tune it for
// a judging window via UPLOAD_DAILY_LIMIT.
export const DEFAULT_DAILY_UPLOAD_LIMIT = Number(process.env.UPLOAD_DAILY_LIMIT || 100);
// The global daily backstop across ALL clients — the hard total-spend bound. Kept
// well above the per-client cap so distinct judges never collide on it, yet finite so
// an abusive fleet cannot run the bill away. Tune via UPLOAD_GLOBAL_DAILY_LIMIT.
export const DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT = Number(process.env.UPLOAD_GLOBAL_DAILY_LIMIT || 2000);

// The key used when a caller does not supply one (e.g. an internal call with no
// request context). All keyless consumers share this single bucket.
export const SHARED_CLIENT_KEY = "_shared";

export interface RateLimitResult {
  allowed: boolean;
  limit: number; // the PER-CLIENT cap this decision was made against
  used: number; // this client's count AFTER a successful consume
  remaining: number; // remaining in this client's bucket
  day: string; // the UTC day bucket this decision was made against (YYYY-MM-DD)
  scope: "ip" | "global"; // on a rejection, WHICH limit governed it (accurate messaging)
  globalLimit: number; // the global backstop cap
  globalUsed: number; // the global count across all clients AFTER a successful consume
}

export class DailyRateLimiter {
  private day: string;
  private buckets = new Map<string, number>(); // per-client counts for the current day
  private globalCount = 0; // total across all clients for the current day

  constructor(
    private limit: number = DEFAULT_DAILY_UPLOAD_LIMIT,
    private now: () => Date = () => new Date(), // injectable clock for deterministic tests
    // The global backstop. Defaults high, but never below the per-client cap (a
    // per-client cap above the backstop would be meaningless — one client could never
    // reach its own limit).
    private globalLimit: number = DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT
  ) {
    this.globalLimit = Math.max(this.globalLimit, this.limit);
    this.day = utcDay(this.now());
  }

  // Atomically check-and-consume one unit for `key` on the current UTC day. Call this
  // ONLY on a genuine upload attempt that passed payload validation, so invalid
  // requests never burn budget. Rejects (without incrementing) once EITHER this
  // client's bucket OR the global backstop is full; `scope` says which.
  consume(key: string = SHARED_CLIENT_KEY): RateLimitResult {
    this.roll();
    const used = this.buckets.get(key) ?? 0;
    // The caller's own bucket is checked first, so a client at its personal cap is told
    // "ip" (come back tomorrow), not mislabelled as a global outage.
    if (used >= this.limit) return this.result(false, "ip", used, this.globalCount);
    if (this.globalCount >= this.globalLimit) return this.result(false, "global", used, this.globalCount);
    const nextUsed = used + 1;
    this.buckets.set(key, nextUsed);
    this.globalCount += 1;
    return this.result(true, "ip", nextUsed, this.globalCount);
  }

  // Read the current window for `key` without consuming (surfaced on health probes).
  snapshot(key: string = SHARED_CLIENT_KEY): RateLimitResult {
    this.roll();
    const used = this.buckets.get(key) ?? 0;
    const allowed = used < this.limit && this.globalCount < this.globalLimit;
    const scope: "ip" | "global" = used >= this.limit ? "ip" : "global";
    return this.result(allowed, scope, used, this.globalCount);
  }

  // Reset both tiers at the UTC day boundary.
  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.buckets.clear();
      this.globalCount = 0;
    }
  }

  private result(allowed: boolean, scope: "ip" | "global", used: number, globalUsed: number): RateLimitResult {
    return {
      allowed,
      limit: this.limit,
      used,
      remaining: Math.max(0, this.limit - used),
      day: this.day,
      scope,
      globalLimit: this.globalLimit,
      globalUsed,
    };
  }
}

// The UTC calendar-day bucket (YYYY-MM-DD) — the reset boundary is 00:00 UTC.
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
