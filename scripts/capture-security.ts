// Capture the REAL advisory injection-scan `security` block for the committed
// prompt-injection attack invoice, so the demo-video "injection detected" beat can
// render authentic, reproducible numbers (no fabricated output).
//
// It runs the SAME production scanner (src/qwen/injection-scan.ts) that /extract and
// /intake use over the vision-extracted invoice fields, and emits the exact
// `security` block shape the server returns, plus the exact human-facing banner
// string the SSE trace + approval UI show. Offline, deterministic, no key, no network.
//
//   npx tsx scripts/capture-security.ts
//     → demo/video/assets/live_intake_attack_security.json
//
// Re-run any time the attack fixture changes; the beat reads the committed output.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { scanForInjection } from "../src/qwen/injection-scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ASSETS = join(ROOT, "demo", "video", "assets");

const attack = JSON.parse(readFileSync(join(ASSETS, "live_intake_attack.json"), "utf8"));
const scan = scanForInjection(attack.invoice as Record<string, unknown>);

// Mirror server.ts inputSafety().security exactly.
const security = {
  injectionDetected: scan.detected,
  injectionCount: scan.count,
  matches: scan.matches,
  autonomousExecutionBlocked: true as const,
};

// The exact banner text the live SSE `security` event + approval UI render.
const banner =
  `⚠️ This document contained ${security.injectionCount} suspected injected ` +
  `instruction(s) — labeled as untrusted data; autonomous execution remains ` +
  `blocked by the human gate.`;

const out = { security, banner };
const dest = join(ASSETS, "live_intake_attack_security.json");
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`[capture-security] injectionDetected=${security.injectionDetected} ` +
  `count=${security.injectionCount} -> ${dest}`);
