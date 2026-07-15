// Shared Playwright e2e helpers — journeys + fixtures + the network guard.
//
// NOT a spec (no `.spec.ts`), so Playwright's testMatch never runs it as a test; it
// is imported by the journey specs. Everything here drives the REAL served UI
// (src/ui.html) against the locally-started OFFLINE server (no key, no DB → the
// deterministic Fakes + in-memory stores), exactly like upload-ux.spec.ts.
//
// ── State model (important) ──────────────────────────────────────────────────
// Playwright runs a SINGLE shared server for the whole run (workers:1) whose
// in-memory stores ACCUMULATE across tests and never reset. So the journey specs
// NEVER assert global emptiness or an absolute pending/decided total — they assert
// DELTAS and scope every card lookup to a per-test UNIQUE vendor. This keeps them
// order-independent and non-polluting.

import { expect, type Page, type Locator } from "@playwright/test";

export const E2E_REVIEWER_TOKEN = "e2e-only-reviewer-token-32-characters";

// A genuinely valid 1 x 1 PNG. The document preflight validates the mandatory
// IHDR dimensions (not just the signature), while the offline FakeExtractionClient
// ignores the pixels and returns the canonical demo invoice deterministically.
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SIG = [...MINIMAL_PNG.subarray(0, 8)];

export function pngFile(name = "invoice.png") {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(MINIMAL_PNG),
  };
}

// A file NAMED .png whose leading bytes are NOT a PNG signature — a disguised file
// the server's magic-byte sniff must reject (400), never extract.
export function badPngFile(name = "disguised.png") {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.from(" this is really a PDF header, not PNG")]),
  };
}

// A .txt upload — an unsupported type the server rejects at validateDocument (400).
export function textFile(name = "notes.txt") {
  return { name, mimeType: "text/plain", buffer: Buffer.from("just some plain text, not an invoice") };
}

// A PNG comfortably OVER the 10 MB cap so @fastify/multipart truncates it → 413.
export function oversizedPngFile(name = "huge.png", bytes = 11 * 1024 * 1024) {
  const buf = Buffer.alloc(bytes, 0x20);
  for (let i = 0; i < PNG_SIG.length; i++) buf[i] = PNG_SIG[i]!;
  return { name, mimeType: "image/png", buffer: buf };
}

// A clean, unique-vendor invoice so a card is findable + isolable per test. A fresh
// vendor from a fresh tax_id/number is NOT a duplicate, so the loop proposes the
// terminal draft_journal_entry (a normal PENDING proposal) — same shape the offline
// integration slice asserts for a new vendor.
export function uniqueInvoice(prefix: string, over: Record<string, unknown> = {}) {
  const tag = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    vendor: tag,
    invoice_number: `${prefix}-INV-${Math.floor(Math.random() * 1e6)}`,
    invoice_date: "2026-06-30",
    tax_id: `TX-${Math.floor(Math.random() * 1e6)}`,
    currency: "EUR",
    subtotal: 5200,
    tax: 1248,
    total: 6448,
    line_items: [{ description: "Services", quantity: 1, unit_price: 5200, amount: 5200 }],
    ...over,
  };
}

// ── Network guard (the demo-mode-e2e rule) ───────────────────────────────────
// On a HAPPY/demo journey NO same-origin request may come back 4xx/5xx. Install
// BEFORE navigating so it sees every response. /favicon.ico is excluded — the
// browser auto-requests it and the Fastify app legitimately 404s it (it is a page
// server, not a favicon host); it is never part of a user journey.
export function installGuard(page: Page): { violations: string[]; assertClean: () => void } {
  const violations: string[] = [];
  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    if (status < 400) return;
    if (/\/favicon\.ico(\?|$)/.test(url)) return;
    // Only guard the app's own origin — external links are
    // never navigated in these journeys, but be explicit.
    if (!/^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost/.test(url)) return;
    violations.push(`${status} ${res.request().method()} ${url}`);
  });
  return {
    violations,
    assertClean: () => expect(violations, `no same-origin 4xx/5xx on a happy journey`).toEqual([]),
  };
}

// ── Navigation + tour ────────────────────────────────────────────────────────
// The guided tour auto-opens on first visit and its backdrop intercepts clicks.

export async function dismissTour(page: Page) {
  const overlay = page.locator("#tourOverlay");
  if (await overlay.evaluate((n) => n.classList.contains("show")).catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(overlay).not.toHaveClass(/show/);
  }
}

// Navigate to the app and wait until the initial queue load has completed (the
// pending count label is populated by load()). Dismisses the auto-tour by default.
export async function gotoReady(
  page: Page,
  opts: { dismiss?: boolean; reviewerToken?: string | null } = {},
) {
  const reviewerToken = opts.reviewerToken === undefined ? E2E_REVIEWER_TOKEN : opts.reviewerToken;
  await page.addInitScript((token) => {
    const storage = (globalThis as any).sessionStorage;
    if (token) storage.setItem("archonReviewerToken", token);
    else storage.removeItem("archonReviewerToken");
  }, reviewerToken);
  await page.goto("/");
  await expect(page.locator("#count")).toContainText(reviewerToken ? "item" : "locked");
  if (opts.dismiss !== false) await dismissTour(page);
}

// ── Journey drivers ──────────────────────────────────────────────────────────

// Read the live pending/decided counts straight from the API — robust to whatever
// state other tests left behind (we only ever assert on the DELTA around an action).
export function pendingCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const token = (globalThis as any).sessionStorage.getItem("archonReviewerToken") || "";
    const response = await fetch("/pending", { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`pending count failed: HTTP ${response.status}`);
    const j = (await response.json()) as { pending: unknown[] };
    return j.pending.length;
  });
}
export function decidedCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const token = (globalThis as any).sessionStorage.getItem("archonReviewerToken") || "";
    const response = await fetch("/decided", { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`decided count failed: HTTP ${response.status}`);
    const j = (await response.json()) as { decided: unknown[] };
    return j.decided.length;
  });
}

// Paste an invoice into the JSON box and Process it — the streamed loop → a PENDING
// proposal. Returns the queue card locator scoped to this invoice's unique vendor.
export async function processJson(page: Page, invoice: Record<string, unknown>): Promise<Locator> {
  await page.fill("#invoiceInput", JSON.stringify(invoice, null, 2));
  await page.locator("#processBtn").click();
  // The live step stream appears as the loop reasons.
  await expect(page.locator("#processView .proc-step").first()).toBeVisible();
  const card = page.locator("#queue .card", { hasText: String(invoice.vendor) });
  await expect(card).toBeVisible();
  return card;
}
