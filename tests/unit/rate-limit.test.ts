// Unit — the daily upload rate limiter (the open demo's budget guardrail). Proves
// the two-tier design: a PER-CLIENT bucket (so one busy client cannot 429 the next
// judge) plus a GLOBAL backstop across all clients (the hard total-spend bound), the
// documented default per-client cap, that the (cap+1)th consume for a client is
// rejected without incrementing, and that the window resets at the UTC day boundary
// (via a fake clock, so the reset is deterministic and does not wait for midnight).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DailyRateLimiter,
  DEFAULT_DAILY_UPLOAD_LIMIT,
  DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT,
} from "../../src/ap/rate-limit.js";

test("the documented default per-client cap is 100/day and the global backstop is higher", () => {
  assert.equal(DEFAULT_DAILY_UPLOAD_LIMIT, 100);
  assert.ok(DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT > DEFAULT_DAILY_UPLOAD_LIMIT);
  const snap = new DailyRateLimiter().snapshot("1.2.3.4");
  assert.equal(snap.limit, 100);
  assert.equal(snap.globalLimit, DEFAULT_GLOBAL_DAILY_UPLOAD_LIMIT);
});

test("the (cap+1)th upload for a client is rejected (and does not increment past the cap)", () => {
  const rl = new DailyRateLimiter(20, () => new Date("2026-07-06T09:00:00Z"));
  for (let i = 1; i <= 20; i++) {
    const r = rl.consume("10.0.0.1");
    assert.equal(r.allowed, true, `upload #${i} should be allowed`);
    assert.equal(r.used, i);
    assert.equal(r.remaining, 20 - i);
  }
  const twentyFirst = rl.consume("10.0.0.1");
  assert.equal(twentyFirst.allowed, false);
  assert.equal(twentyFirst.scope, "ip"); // the client's OWN cap, not the global backstop
  assert.equal(twentyFirst.remaining, 0);
  assert.equal(twentyFirst.used, 20); // still 20 — the cap was not exceeded
  // A 22nd attempt is still rejected (idempotent once over).
  assert.equal(rl.consume("10.0.0.1").allowed, false);
});

test("per-client isolation: one client hitting its cap does NOT starve another client", () => {
  const rl = new DailyRateLimiter(2, () => new Date("2026-07-06T00:00:00Z"));
  // Client A exhausts its own bucket…
  assert.equal(rl.consume("A").allowed, true);
  assert.equal(rl.consume("A").allowed, true);
  assert.equal(rl.consume("A").allowed, false);
  // …but client B still has its full, independent budget (the starvation fix).
  const b1 = rl.consume("B");
  assert.equal(b1.allowed, true);
  assert.equal(b1.used, 1);
  assert.equal(rl.consume("B").allowed, true);
  assert.equal(rl.consume("B").allowed, false);
});

test("the global backstop bounds TOTAL accepted workflows across many distinct clients", () => {
  // Per-client cap 1, global backstop 3: three distinct clients each consume their one
  // slot (global now 3); the 4th client — with an empty bucket of its own — is refused
  // on the GLOBAL tier, so accepted workflows stay bounded no matter how many clients appear.
  const rl = new DailyRateLimiter(1, () => new Date("2026-07-06T00:00:00Z"), 3);
  assert.equal(rl.consume("c1").allowed, true);
  assert.equal(rl.consume("c2").allowed, true);
  assert.equal(rl.consume("c3").allowed, true);
  const over = rl.consume("c4"); // fresh client, but the global budget is spent
  assert.equal(over.allowed, false);
  assert.equal(over.scope, "global"); // rejected by the backstop, not the client's own cap
  assert.equal(over.used, 0); // this client never consumed anything
});

test("an operator's hard global backstop is never silently widened", () => {
  const rl = new DailyRateLimiter(50, () => new Date("2026-07-06T00:00:00Z"), 5);
  assert.equal(rl.snapshot("x").globalLimit, 5);
  for (let i = 0; i < 5; i++) assert.equal(rl.consume("x").allowed, true);
  const over = rl.consume("x");
  assert.equal(over.allowed, false);
  assert.equal(over.scope, "global");
  assert.equal(over.globalUsed, 5);
});

test("keyless consumers share one bucket (the default key)", () => {
  const rl = new DailyRateLimiter(2, () => new Date("2026-07-06T00:00:00Z"));
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, false); // same shared bucket, now full
});

test("the window resets at the UTC day boundary (both tiers)", () => {
  let now = new Date("2026-07-06T23:59:00Z");
  const rl = new DailyRateLimiter(3, () => now);
  assert.equal(rl.consume("ip").allowed, true);
  assert.equal(rl.consume("ip").allowed, true);
  assert.equal(rl.consume("ip").allowed, true);
  assert.equal(rl.consume("ip").allowed, false); // day 1 exhausted

  now = new Date("2026-07-07T00:01:00Z"); // tick past 00:00 UTC → new day
  const first = rl.consume("ip");
  assert.equal(first.allowed, true, "the new UTC day resets the window");
  assert.equal(first.used, 1);
  assert.equal(first.day, "2026-07-07");
});
