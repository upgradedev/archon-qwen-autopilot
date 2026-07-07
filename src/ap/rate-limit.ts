// Daily upload rate limiter — protects the Qwen API budget on the OPEN demo.
//
// The live demo is intentionally open (no login, so judges can test it freely —
// see the README). To keep an open endpoint from running up the Qwen bill, invoice
// uploads (POST /intake and POST /intake/stream) are capped at a fixed number PER
// UTC DAY. This is a deliberate, rules-compliant guardrail, not authentication.
//
// It is a per-process, in-memory counter keyed by the UTC calendar day, so it
// resets at 00:00 UTC (and on restart). That is sufficient for a single-box demo;
// a multi-instance deployment would move this to a shared store (e.g. the same
// PostgreSQL). The clock is injectable so the UTC-reset behaviour is unit-testable.

// The default cap. Twenty uploads/day is plenty for a judge to exercise every path
// (sample invoice, a duplicate, an anomaly, an amend) while bounding the spend.
export const DEFAULT_DAILY_UPLOAD_LIMIT = Number(process.env.UPLOAD_DAILY_LIMIT || 20);

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  used: number; // count AFTER a successful consume (== limit when it just hit the cap)
  remaining: number;
  day: string; // the UTC day bucket this decision was made against (YYYY-MM-DD)
}

export class DailyRateLimiter {
  private day: string;
  private count = 0;

  constructor(
    private limit: number = DEFAULT_DAILY_UPLOAD_LIMIT,
    private now: () => Date = () => new Date() // injectable clock for deterministic tests
  ) {
    this.day = utcDay(this.now());
  }

  // Atomically check-and-consume one unit for the current UTC day. Call this ONLY
  // on a genuine upload attempt that passed payload validation, so invalid requests
  // never burn budget. Returns allowed:false (and does NOT increment) once the cap
  // is reached.
  consume(): RateLimitResult {
    const today = utcDay(this.now());
    if (today !== this.day) {
      // A new UTC day — reset the window.
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      return { allowed: false, limit: this.limit, used: this.count, remaining: 0, day: this.day };
    }
    this.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      used: this.count,
      remaining: Math.max(0, this.limit - this.count),
      day: this.day,
    };
  }

  // Read the current window without consuming (surfaced on /health-style probes).
  snapshot(): RateLimitResult {
    const today = utcDay(this.now());
    const used = today === this.day ? this.count : 0;
    return {
      allowed: used < this.limit,
      limit: this.limit,
      used,
      remaining: Math.max(0, this.limit - used),
      day: today,
    };
  }
}

// The UTC calendar-day bucket (YYYY-MM-DD) — the reset boundary is 00:00 UTC.
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
