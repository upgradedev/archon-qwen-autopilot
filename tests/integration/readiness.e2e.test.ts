// e2e — the readiness gate runs end to end and reports an honest offline score.
//
// This spawns the REAL `scripts/readiness.ts` as its own process (exactly as CI's
// `readiness` job does), with NO DashScope key and NO DATABASE_URL, so every check runs
// on the deterministic offline Fakes. It asserts the three things the gate promises:
//   1. it runs to completion and EXITS 0 (the gate passed);
//   2. it emits a well-formed readiness.json with automatable completion ≥ 95%
//      and zero failed automatable checks;
//   3. the four rubric criteria are all present, and the honest `user-gated` items
//      (final playback, hosted video, live-box redeploy) are surfaced, not auto-claimed.
//
// Spawning the real script (rather than importing main(), which calls process.exit)
// is the point: it proves the CI job's exact command path is green and self-reporting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  passesReadinessGate,
  READINESS_GATE_THRESHOLD_PCT,
} from "../../scripts/readiness-policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT = join(ROOT, "readiness.json");

test("readiness policy requires both the weighted floor and zero failed checks", () => {
  assert.equal(READINESS_GATE_THRESHOLD_PCT, 95);
  assert.equal(passesReadinessGate(95, 0), true, "the exact floor passes when every check passes");
  assert.equal(passesReadinessGate(100, 0), true, "a clean perfect report passes");
  assert.equal(passesReadinessGate(94.9, 0), false, "a clean report below the floor fails");
  assert.equal(passesReadinessGate(95, 1), false, "a failed check cannot hide at the exact floor");
  assert.equal(passesReadinessGate(100, 1), false, "even a rounded 100% cannot hide a failed check");
  assert.equal(passesReadinessGate(Number.NaN, 0), false, "a non-finite score fails closed");
  assert.equal(passesReadinessGate(101, 0), false, "an out-of-range score fails closed");
  assert.equal(passesReadinessGate(100, -1), false, "an invalid failure count fails closed");
});

test("readiness gate runs offline, exits 0, and reports a clean ≥95% result", () => {
  rmSync(OUT, { force: true }); // ensure we assert on a freshly-written report

  const env = { ...process.env };
  delete env.DASHSCOPE_API_KEY; // force the deterministic offline Fakes
  delete env.DATABASE_URL; // in-memory stores — no DB needed for the gate

  // Runs to completion and exits 0 → the gate passed (execFileSync throws on non-zero).
  execFileSync("node", ["--import", "tsx", "scripts/readiness.ts", "--json"], {
    cwd: ROOT,
    env,
    stdio: "pipe",
    timeout: 180_000,
  });

  const report = JSON.parse(readFileSync(OUT, "utf8"));

  // Offline completion is at/above the CI floor, and the gate agrees it passed.
  assert.ok(report.automatableCompletionPct >= 95, `automatable completion ${report.automatableCompletionPct}% must be ≥95%`);
  assert.equal(report.gatePass, true, "the gate must report gatePass=true offline");
  assert.equal(report.gateThresholdPct, 95, "the gate threshold is pinned at 95%");
  assert.deepEqual(
    report.gatePolicy,
    { requiresZeroFailedAutomatableChecks: true },
    "the report must publish the zero-failure release policy",
  );
  assert.equal(report.totals.failed, 0, "no automatable check may be failing offline");

  // All four rubric criteria are present with their rubric weights.
  const byName = new Map(report.criteria.map((c: { name: string; weight: number }) => [c.name, c.weight]));
  assert.deepEqual(
    [byName.get("Technical"), byName.get("Innovation"), byName.get("Problem value"), byName.get("Presentation")],
    [30, 30, 25, 15],
    "the four criteria carry the Track-4 rubric weights (30/30/25/15)"
  );

  // Honest user-gated items are surfaced (human playback + hosting + live box),
  // never auto-claimed as passing. SMTP recipient delivery is intentionally not a
  // claim and therefore is not mislabeled as unfinished submission work.
  assert.ok(report.totals.userGated >= 3, `expected ≥3 user-gated items, got ${report.totals.userGated}`);
  const gatedIds = new Set(report.userGated.map((g: { id: string }) => g.id));
  for (const id of ["video-present", "video-hosted", "live-box-redeploy"]) {
    assert.ok(gatedIds.has(id), `user-gated item '${id}' must be surfaced`);
  }
  assert.ok(!gatedIds.has("smtp-live-send"), "recipient delivery is a bounded non-claim, not a release blocker");

  // Both real terminal-action sinks are reported wired (the Part-A "agent actually executes" claim).
  const problem = report.criteria.find((c: { name: string }) => c.name === "Problem value");
  const problemChecks = new Set(problem.checks.filter((c: { status: string }) => c.status === "pass").map((c: { id: string }) => c.id));
  assert.ok(problemChecks.has("sink-smtp") && problemChecks.has("sink-ledger"), "both real sinks (SMTP + JSONL ledger) must pass");
});
