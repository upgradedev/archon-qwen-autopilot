// Unit — the daily upload rate limiter (the open demo's budget guardrail). Proves
// the default cap is 20, that the (20+1)th consume in a day is rejected without
// incrementing, and that the window resets at the UTC day boundary (via a fake
// clock, so the reset is deterministic and does not wait for real midnight).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DailyRateLimiter, DEFAULT_DAILY_UPLOAD_LIMIT } from "../../src/ap/rate-limit.js";

test("the documented default upload cap is 20/day", () => {
  assert.equal(DEFAULT_DAILY_UPLOAD_LIMIT, 20);
  assert.equal(new DailyRateLimiter().snapshot().limit, 20);
});

test("the 21st upload in a UTC day is rejected (and does not increment past the cap)", () => {
  const rl = new DailyRateLimiter(20, () => new Date("2026-07-06T09:00:00Z"));
  for (let i = 1; i <= 20; i++) {
    const r = rl.consume();
    assert.equal(r.allowed, true, `upload #${i} should be allowed`);
    assert.equal(r.used, i);
    assert.equal(r.remaining, 20 - i);
  }
  const twentyFirst = rl.consume();
  assert.equal(twentyFirst.allowed, false);
  assert.equal(twentyFirst.remaining, 0);
  assert.equal(twentyFirst.used, 20); // still 20 — the cap was not exceeded
  // A 22nd attempt is still rejected (idempotent once over).
  assert.equal(rl.consume().allowed, false);
});

test("an injected low cap is honored (mechanism, not just the default)", () => {
  const rl = new DailyRateLimiter(2, () => new Date("2026-07-06T00:00:00Z"));
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, false);
});

test("the window resets at the UTC day boundary", () => {
  let now = new Date("2026-07-06T23:59:00Z");
  const rl = new DailyRateLimiter(3, () => now);
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, true);
  assert.equal(rl.consume().allowed, false); // day 1 exhausted

  now = new Date("2026-07-07T00:01:00Z"); // tick past 00:00 UTC → new day
  const first = rl.consume();
  assert.equal(first.allowed, true, "the new UTC day resets the window");
  assert.equal(first.used, 1);
  assert.equal(first.day, "2026-07-07");
});
