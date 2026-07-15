// Coarse process-local HTTP abuse guard. Durable daily provider-workflow quotas remain
// the admission authority; this fixed-window layer protects public reads/docs/readiness and
// parser/route CPU from request floods. req.ip is supplied by Fastify's explicitly
// configured trust-proxy boundary, never by manually parsing X-Forwarded-For.

export interface HttpRequestLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface HttpRequestRateLimiter {
  consume(key: string, limit: number): HttpRequestLimitResult;
}

interface WindowState {
  startMs: number;
  count: number;
  touchedMs: number;
}

export class InMemoryHttpRequestRateLimiter implements HttpRequestRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private operations = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000
  ) {}

  consume(key: string, rawLimit: number): HttpRequestLimitResult {
    const now = this.now();
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(100_000, Math.trunc(rawLimit)))
      : 1;
    let state = this.windows.get(key);
    if (!state || now - state.startMs >= this.windowMs) {
      state = { startMs: now, count: 0, touchedMs: now };
      this.windows.set(key, state);
    }
    state.touchedMs = now;
    state.count += 1;
    this.operations += 1;
    if (this.operations % 256 === 0) this.prune(now);
    const retryAfterSeconds = Math.max(1, Math.ceil((state.startMs + this.windowMs - now) / 1000));
    return {
      allowed: state.count <= limit,
      remaining: Math.max(0, limit - state.count),
      retryAfterSeconds,
    };
  }

  private prune(now: number): void {
    for (const [key, state] of this.windows) {
      if (now - state.startMs >= this.windowMs * 2) this.windows.delete(key);
    }
    if (this.windows.size <= this.maxKeys) return;
    const oldest = [...this.windows.entries()].sort((a, b) => a[1].touchedMs - b[1].touchedMs);
    const excess = this.windows.size - this.maxKeys;
    for (let index = 0; index < excess; index++) {
      this.windows.delete(oldest[index]![0]);
    }
  }
}
