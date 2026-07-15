// Daily upload rate limiter — bounds provider-workflow admissions on the OPEN demo.
//
// The live demo is intentionally open (no login, so judges can test it freely —
// see the README). To limit an open endpoint's model exposure, invoice
// uploads (POST /intake and the streaming / document routes) are capped PER UTC DAY.
// This is a deliberate, rules-compliant guardrail, not authentication.
//
// TWO TIERS, so a single busy client cannot starve everyone else out of the demo:
//   • a PER-CLIENT bucket (keyed by a best-effort client id — the caller passes the
//     request's IP), so one judge hitting the cap does not 429 the next judge; and
//   • a GLOBAL backstop across all clients, so accepted workflows stay bounded even
//     with many distinct clients (the whole reason the limiter exists). A decision
//     is rejected when EITHER the caller's own bucket OR the global backstop is full,
//     and the result says WHICH (`scope`) so the message is accurate.
//
// DailyRateLimiter is the dependency-free test/dev implementation. Production
// uses PostgresDailyRateLimiter below: its two counters are locked and incremented
// in one transaction, so restarts and multiple replicas cannot reset/oversubscribe it.
//
// Honesty note on the per-client key: behind a reverse proxy the caller's IP is only
// as trustworthy as the proxy's `X-Forwarded-For`, which a client can spoof. So the
// per-client bucket is a BEST-EFFORT fairness split, and the GLOBAL backstop is the
// hard, spoof-proof workflow-entitlement bound. Size it so that even in the degenerate
// "every client collapses to one key" case it alone does not starve the judges.

// The per-client daily cap. 100 uploads/day per client is plenty for a judge to
// exercise every path many times over while bounding one client's admissions; tune it for
// a judging window via UPLOAD_DAILY_LIMIT.
import { createHash } from "node:crypto";
import { withClient } from "../db/client.js";

export const DEFAULT_DAILY_UPLOAD_LIMIT = boundedLimit(process.env.UPLOAD_DAILY_LIMIT, 100);
// The global daily backstop across ALL clients — the hard accepted-workflow bound. Kept
// well above the per-client cap so distinct judges never collide on it, yet finite so
// an abusive fleet cannot run the bill away. Tune via UPLOAD_GLOBAL_DAILY_LIMIT.
export const DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT = boundedLimit(process.env.UPLOAD_GLOBAL_DAILY_LIMIT, 2000);

// A valid out-of-band reviewer credential uses a separate, still-bounded reserve.
// Public traffic therefore cannot consume judging capacity, while leaked/abusive
// credentials still cannot create an unlimited workflow-admission bypass. The total
// accepted workflows/day is bounded by both global caps; calls/tokens are separate.
export const DEFAULT_REVIEWER_DAILY_UPLOAD_LIMIT = boundedLimit(process.env.REVIEWER_UPLOAD_DAILY_LIMIT, 250);
export const DEFAULT_REVIEWER_GLOBAL_DAILY_UPLOAD_LIMIT = boundedLimit(process.env.REVIEWER_UPLOAD_GLOBAL_DAILY_LIMIT, 500);

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

export interface UploadRateLimiter {
  consume(key?: string): RateLimitResult | Promise<RateLimitResult>;
  snapshot(key?: string): RateLimitResult | Promise<RateLimitResult>;
}

export class DailyRateLimiter {
  private day: string;
  private buckets = new Map<string, number>(); // per-client counts for the current day
  private globalCount = 0; // total across all clients for the current day

  constructor(
    private limit: number = DEFAULT_DAILY_UPLOAD_LIMIT,
    private now: () => Date = () => new Date(), // injectable clock for deterministic tests
    // The global backstop is an independent HARD workflow-entitlement ceiling. It may deliberately
    // be lower than the per-client fairness cap; never widen an operator's budget.
    private globalLimit: number = DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT
  ) {
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

// Durable, atomic two-tier quota. Rows are scoped by UTC day and retained as a
// small audit trail; a best-effort cleanup removes windows older than 14 days.
export class PostgresDailyRateLimiter implements UploadRateLimiter {
  private readonly globalLimit: number;
  private readonly globalKey: string;
  private readonly namespace: string;

  constructor(
    private readonly limit: number = DEFAULT_DAILY_UPLOAD_LIMIT,
    private readonly now: () => Date = () => new Date(),
    globalLimit: number = DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT,
    namespace = ""
  ) {
    this.globalLimit = globalLimit;
    if (namespace && !/^[a-z0-9_-]{1,32}$/i.test(namespace)) throw new Error("rate-limit namespace must be 1–32 safe characters");
    this.namespace = namespace;
    // Keep the historical public key unchanged; named reserves get disjoint rows.
    this.globalKey = namespace ? `__global__:${namespace}` : "__global__";
  }

  async consume(key: string = SHARED_CLIENT_KEY): Promise<RateLimitResult> {
    return this.readOrConsume(key, true);
  }

  async snapshot(key: string = SHARED_CLIENT_KEY): Promise<RateLimitResult> {
    return this.readOrConsume(key, false);
  }

  private async readOrConsume(key: string, consume: boolean): Promise<RateLimitResult> {
    const day = utcDay(this.now());
    const clientKey = durableClientKey(this.namespace ? `${this.namespace}:${key}` : key);
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO ap_daily_quota(day, client_key, used)
           VALUES ($1::date, $2, 0), ($1::date, $3, 0)
           ON CONFLICT (day, client_key) DO NOTHING`,
          [day, clientKey, this.globalKey]
        );
        const rows = await client.query<{ client_key: string; used: number }>(
          `SELECT client_key, used
             FROM ap_daily_quota
            WHERE day = $1::date AND client_key IN ($2, $3)
            ORDER BY client_key
            FOR UPDATE`,
          [day, clientKey, this.globalKey]
        );
        const used = Number(rows.rows.find((r) => r.client_key === clientKey)?.used ?? 0);
        const globalUsed = Number(rows.rows.find((r) => r.client_key === this.globalKey)?.used ?? 0);
        const scope: "ip" | "global" = used >= this.limit ? "ip" : "global";
        const allowed = used < this.limit && globalUsed < this.globalLimit;
        let nextUsed = used;
        let nextGlobal = globalUsed;
        if (consume && allowed) {
          await client.query(
            `UPDATE ap_daily_quota SET used = used + 1
              WHERE day = $1::date AND client_key IN ($2, $3)`,
            [day, clientKey, this.globalKey]
          );
          nextUsed += 1;
          nextGlobal += 1;
          // Small, bounded housekeeping inside the already-open transaction.
          await client.query(`DELETE FROM ap_daily_quota WHERE day < current_date - 14`);
        }
        await client.query("COMMIT");
        return makeResult(
          allowed,
          allowed ? "ip" : scope,
          nextUsed,
          nextGlobal,
          day,
          this.limit,
          this.globalLimit
        );
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }
}

// The UTC calendar-day bucket (YYYY-MM-DD) — the reset boundary is 00:00 UTC.
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function durableClientKey(key: string): string {
  return `client:${createHash("sha256").update(key || SHARED_CLIENT_KEY).digest("hex")}`;
}

function boundedLimit(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(1, Math.min(1_000_000, Math.trunc(value))) : fallback;
}

function makeResult(
  allowed: boolean,
  scope: "ip" | "global",
  used: number,
  globalUsed: number,
  day: string,
  limit: number,
  globalLimit: number
): RateLimitResult {
  return {
    allowed,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    day,
    scope,
    globalLimit,
    globalUsed,
  };
}
