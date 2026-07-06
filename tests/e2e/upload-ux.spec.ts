// Browser e2e — the document-upload UX, driven against the REAL served UI with the
// offline Fakes (no key, no database, no live Qwen). Each test asserts exactly what
// one of the shipped, user-reported bugs would have violated:
//
//   • "Choose file does nothing on select"      → test: selecting a file triggers extraction
//   • "Filename not shown"                       → test: the selected filename is displayed
//   • two-step review flow (extract → review)    → test: the extracted invoice renders for review
//   • Process runs the loop, nothing executes    → test: proposal appears PENDING in the queue
//   • empty state / sample / tour / decided / charts render → test: static UI surfaces
//
// These are the tests whose absence let the bugs ship: the handlers are wired in the
// browser, so only a browser driving the real page can catch a dead change handler.

import { test, expect } from "@playwright/test";

// A tiny fake image payload. The offline FakeExtractionClient ignores the bytes and
// returns the canonical demo invoice (Meridian Logistics), so any buffer works.
const FAKE_PNG = {
  name: "acme-invoice.png",
  mimeType: "image/png",
  buffer: Buffer.from("\x89PNG\r\n\x1a\n fake image bytes for e2e"),
};

// Close the first-visit guided tour if it is showing (it auto-opens and its backdrop
// would intercept clicks). Asserting it appeared is part of the static-UI test.
async function dismissTour(page: import("@playwright/test").Page) {
  const overlay = page.locator("#tourOverlay");
  if (await overlay.evaluate((n) => n.classList.contains("show")).catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(overlay).not.toHaveClass(/show/);
  }
}

test("static UI: header, sample buttons, guided tour, decided tab, charts, and the empty state all render", async ({ page }) => {
  await page.goto("/");

  // Header identity — the one-line explainer.
  await expect(page.locator("header")).toContainText("it proposes, you approve");

  // The one-click sample controls a judge uses.
  await expect(page.locator("#loadSample")).toHaveText(/Load sample invoice/);
  await expect(page.locator("#sampleDoc")).toHaveText(/Use sample document/);

  // The first-visit guided tour auto-opens.
  await expect(page.locator("#tourOverlay")).toHaveClass(/show/);
  await expect(page.locator("#tourPop")).toBeVisible();
  await dismissTour(page);

  // Empty-state guidance (fresh in-memory server) rather than a blank list.
  await expect(page.locator("#queue")).toContainText("No invoices in the queue");

  // The at-a-glance charts render (headings present).
  await expect(page.locator("#chartPending")).toContainText("Pending");
  await expect(page.locator("#chartDecided")).toContainText("Decided");

  // The Decided tab switches and shows its own empty state.
  await page.locator("#tabDecided").click();
  await expect(page.locator("#pane-decided")).toHaveClass(/active/);
  await expect(page.locator("#decided")).toContainText("Nothing decided yet");
});

test("selecting a file shows its name AND triggers extraction that renders the invoice for review (no loop yet)", async ({ page }) => {
  await page.goto("/");
  await dismissTour(page);

  // Precondition: no filename yet.
  await expect(page.locator("#fileName")).toHaveText(/No file selected/);

  // Bug #1 + #2: selecting a file must wire the change handler AND display the name.
  await page.setInputFiles("#fileInput", FAKE_PNG);
  await expect(page.locator("#fileName")).toHaveText(FAKE_PNG.name);

  // Bug #3 (step 1): the file is extracted (Qwen-VL / offline fake) and the parsed
  // invoice is rendered for the human to REVIEW — the multi-step loop has NOT run.
  const review = page.locator("#extractReview");
  await expect(review).toHaveClass(/show/);
  await expect(review).toContainText("Extracted for review");
  await expect(review).toContainText("Meridian Logistics"); // the extracted vendor
  await expect(page.locator("#reviewNote")).toContainText("review the extracted fields, then Process");

  // The extracted invoice is also placed in the editable JSON box for correction.
  await expect(page.locator("#invoiceInput")).toHaveValue(/Meridian Logistics/);

  // Nothing was proposed yet — the queue is still empty (extract-only).
  await expect(page.locator("#queue")).toContainText("No invoices in the queue");
});

test('clicking "Process invoice" runs the loop, streams the live steps, and the proposal appears PENDING in the queue (nothing executed)', async ({ page }) => {
  await page.goto("/");
  await dismissTour(page);

  // Extract first (step 1), then process the reviewed invoice (step 2).
  await page.setInputFiles("#fileInput", FAKE_PNG);
  await expect(page.locator("#extractReview")).toContainText("Meridian Logistics");

  await page.locator("#processBtn").click();

  // The live step stream appears in the process view as the loop reasons.
  const proc = page.locator("#processView");
  await expect(proc.locator(".proc-step").first()).toBeVisible();
  await expect(proc).toContainText("recall_vendor_history");

  // The proposal lands in the PENDING queue with the human-gate controls — and
  // crucially the gate held: it is a proposal awaiting approval, nothing executed.
  const card = page.locator("#queue .card").first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Meridian Logistics");
  await expect(card).toContainText("Nothing executes until you approve");
  await expect(card.locator("button.approve")).toBeVisible();

  // Nothing has been decided/executed — the Decided tab is still empty.
  await page.locator("#tabDecided").click();
  await expect(page.locator("#decided")).toContainText("Nothing decided yet");
});
