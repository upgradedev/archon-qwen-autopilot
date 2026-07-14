// Playwright config — browser e2e for the Archon Autopilot approval UI.
//
// These tests drive the REAL served UI (src/ui.html) against a locally-started
// server, fully OFFLINE: the webServer command starts `npm start` with NO
// DASHSCOPE_API_KEY and NO DATABASE_URL, so the decider + embedder + vision
// extractor auto-fall back to the deterministic Fakes and the stores are in-memory.
// No live Qwen or database is used. A fixed, test-only reviewer credential exercises
// the same authenticated queue boundary as production without using a real secret.
// They exist because the upload-UX bugs (dead file
// handler, missing filename, no review step) were browser-only and unit tests could
// not have caught them; only a real browser driving the real page can.
//
// testDir is scoped to tests/e2e so Playwright never picks up the node:test
// *.test.ts files under tests/unit and tests/integration.

import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT || "9123";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REVIEWER_TOKEN = "e2e-only-reviewer-token-32-characters";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Applied by the browser context to page loads and same-origin fetches, including
    // the initial /pending + /decided requests that occur before test code can type
    // into the token field.
    extraHTTPHeaders: { authorization: `Bearer ${REVIEWER_TOKEN}` },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm start",
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Force the offline posture regardless of the host environment. A high daily
    // upload cap keeps the shared-server suite well clear of the 10/day guard (which
    // exists for the open live demo, not the test run).
    env: {
      PORT,
      NODE_ENV: "test",
      DASHSCOPE_API_KEY: "",
      DATABASE_URL: "",
      ALLOW_FAKE_QWEN: "true",
      REVIEWER_TOKEN,
      REVIEWER_NAME: "playwright-reviewer",
      UPLOAD_DAILY_LIMIT: "1000",
    },
  },
});
