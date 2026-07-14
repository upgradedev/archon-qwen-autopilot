// Browser e2e — the HAPPY autopilot journeys, driven against the REAL served UI with
// the offline Fakes (no key, no DB, in-memory stores). Every test here installs the
// NETWORK GUARD (no same-origin 4xx/5xx during the journey) and asserts POPULATED
// content — never an empty list, a stuck spinner, or an error surface on a happy path.
//
// Filename sorts AFTER upload-ux.spec.ts on purpose: the shared server's in-memory
// stores accumulate across the run, so the pre-existing upload-ux suite runs first on
// a clean store, and these delta-based specs tolerate the state it leaves behind. No
// test here asserts global emptiness or an absolute total — only deltas + a per-test
// unique vendor.

import { test, expect } from "@playwright/test";
import {
  installGuard,
  gotoReady,
  dismissTour,
  processJson,
  pngFile,
  uniqueInvoice,
  pendingCount,
  decidedCount,
} from "./helpers.js";

test("cold start renders every surface with no broken tiles (header, charts, health pill, tabs) — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  // Header identity + the one-line explainer.
  await expect(page.locator("header")).toContainText("it proposes, you approve");
  // The health pill resolved to a real decider id (not the '…' placeholder) — the
  // /health round-trip succeeded and populated it.
  await expect(page.locator("#model")).not.toHaveText(/decider …/);
  await expect(page.locator("#model")).toContainText(/decider/);
  // Both charts rendered their headings — no blank/broken tile.
  await expect(page.locator("#chartPending")).toContainText("Pending");
  await expect(page.locator("#chartDecided")).toContainText("Decided");
  // The SVG (data) or the zero-state text — a chart body is present either way.
  await expect(page.locator("#chartPending svg, #chartPending .zero")).toHaveCount(1);
  // Both tab panes exist; Pending is active by default.
  await expect(page.locator("#pane-pending")).toHaveClass(/active/);
  await expect(page.locator("#tabDecided")).toBeVisible();

  guard.assertClean();
});

test("Load sample invoice → exactly one PENDING proposal exists and the pending chart populates — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const before = await pendingCount(page);
  await page.locator("#loadSample").click();
  // Success toast confirms the proposal was queued.
  await expect(page.locator("#toast")).toHaveClass(/show/);
  await expect(page.locator("#toast")).toContainText(/Sample invoice queued/i);
  // The shared e2e server may already hold this exact fixed sample from an earlier
  // journey. The product invariant is stronger than a +1 assertion: retries reuse
  // one live item and never create a second Meridian proposal.
  await expect.poll(async () => {
    const after = await pendingCount(page);
    return after === before || after === before + 1;
  }).toBe(true);
  const meridianCards = page.locator("#queue .card", { hasText: "Meridian Logistics" });
  await expect(meridianCards).toHaveCount(1);
  const card = meridianCards;
  await expect(card).toBeVisible();
  await expect(card.locator("button.approve")).toBeVisible();
  await expect(card).toContainText("Nothing executes until you approve");
  // The pending chart now has data (its legend only renders when total > 0).
  await expect(page.locator("#chartPending .legend")).toBeVisible();

  guard.assertClean();
});

test("paste JSON → Process streams the live loop → a PENDING proposal renders (nothing executed) — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const decidedBefore = await decidedCount(page);
  const invoice = uniqueInvoice("Happy-Process");
  const card = await processJson(page, invoice);

  // A real autonomous read/analyze step streamed (recall_vendor_history is step 1).
  await expect(page.locator("#processView")).toContainText("recall_vendor_history");
  // The proposal is a gated PENDING card with the human controls.
  await expect(card.locator("button.approve")).toBeVisible();
  await expect(card.locator("button.amend")).toBeVisible();
  await expect(card.locator("button.reject")).toBeVisible();
  // Nothing was decided/executed by processing (the gate held).
  expect(await decidedCount(page)).toBe(decidedBefore);

  guard.assertClean();
});

test("full lifecycle — approve executes and the item moves to Decided as 'approved' — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const invoice = uniqueInvoice("Happy-Approve");
  const card = await processJson(page, invoice);

  const decidedBefore = await decidedCount(page);
  await card.locator("button.approve").click();
  await expect(page.locator("#toast")).toContainText(/Approved/i);
  // The approved item left the pending queue and landed in Decided with the badge.
  await expect(page.locator("#queue .card", { hasText: invoice.vendor })).toHaveCount(0);
  await expect.poll(() => decidedCount(page)).toBe(decidedBefore + 1);
  await page.locator("#tabDecided").click();
  const row = page.locator("#pane-decided .decided-item", { hasText: invoice.vendor });
  await expect(row).toBeVisible();
  await expect(row.locator(".badge.approved")).toHaveText("approved");
  // The decided chart populated too.
  await expect(page.locator("#chartDecided .legend")).toBeVisible();

  guard.assertClean();
});

test("full lifecycle — amend edits the args, executes, and Decided shows 'amended' with a prev→new diff — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const invoice = uniqueInvoice("Happy-Amend");
  const card = await processJson(page, invoice);

  // Edit the proposed action arguments in the card's textarea (add a field so the
  // diff is guaranteed to show a change), then Amend & approve.
  const ta = card.locator("textarea");
  const current = await ta.inputValue();
  const args = JSON.parse(current);
  args.memo = "e2e amend";
  await ta.fill(JSON.stringify(args, null, 2));
  await card.locator("button.amend").click();
  await expect(page.locator("#toast")).toContainText(/Amended & approved/i);

  await page.locator("#tabDecided").click();
  const row = page.locator("#pane-decided .decided-item", { hasText: invoice.vendor });
  await expect(row).toBeVisible();
  await expect(row.locator(".badge.amended")).toHaveText("amended");
  // The amend audit trail (prev → new) is rendered.
  await expect(row.locator(".diff")).toContainText("memo");
  await expect(row.locator(".diff .next")).toContainText("e2e amend");

  guard.assertClean();
});

test("full lifecycle — reject discards the proposal (nothing executes) and Decided shows 'rejected' — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const invoice = uniqueInvoice("Happy-Reject");
  const card = await processJson(page, invoice);

  await card.locator("button.reject").click();
  await expect(page.locator("#toast")).toContainText(/Rejected — nothing executed/i);
  await expect(page.locator("#queue .card", { hasText: invoice.vendor })).toHaveCount(0);

  await page.locator("#tabDecided").click();
  const row = page.locator("#pane-decided .decided-item", { hasText: invoice.vendor });
  await expect(row).toBeVisible();
  await expect(row.locator(".badge.rejected")).toHaveText("rejected");
  await expect(row).toContainText(/Rejected — nothing executed/i);

  guard.assertClean();
});

test("real-document path — 'Use sample document' extracts via the vision path, renders review, then processes to a PENDING proposal — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const before = await pendingCount(page);
  // Fetches the bundled invoice PNG and runs it through the exact /extract/document
  // (Qwen-VL, offline fake) path a judge would use → the extract-for-review panel.
  await page.locator("#sampleDoc").click();
  const review = page.locator("#extractReview");
  await expect(review).toHaveClass(/show/);
  await expect(review).toContainText("Extracted for review");
  await expect(review).toContainText("Meridian Logistics");
  // The extracted invoice is placed in the editable box for correction.
  await expect(page.locator("#invoiceInput")).toHaveValue(/Meridian Logistics/);

  // Process the reviewed invoice. If another journey already queued this fixed
  // sample, the streamed idempotency guard explains why the existing proposal is
  // reused; a fresh isolated run streams the normal recall step.
  await page.locator("#processBtn").click();
  await expect(page.locator("#processView .proc-step").first()).toBeVisible();
  await expect(page.locator("#processView")).toContainText(/recall_vendor_history|live_idempotency_guard/);
  await expect.poll(async () => {
    const after = await pendingCount(page);
    return after === before || after === before + 1;
  }).toBe(true);
  await expect(page.locator("#queue .card", { hasText: "Meridian Logistics" })).toHaveCount(1);

  guard.assertClean();
});

test("file upload happy — selecting a valid PNG shows its name, extracts for review, and does NOT run the loop yet — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  await gotoReady(page);

  const file = pngFile("acme-invoice.png");
  const before = await pendingCount(page);
  await page.setInputFiles("#fileInput", file);
  // The filename is shown and the extracted invoice renders for review.
  await expect(page.locator("#fileName")).toHaveText(file.name);
  const review = page.locator("#extractReview");
  await expect(review).toContainText("Extracted for review");
  await expect(review).toContainText("Meridian Logistics");
  await expect(page.locator("#reviewNote")).toContainText("review the extracted fields, then Process");
  // Extract-only: nothing was proposed yet (queue unchanged until Process).
  expect(await pendingCount(page)).toBe(before);

  guard.assertClean();
});

test("guided tour — walking Next through every step reaches Done and closes the overlay — guard clean", async ({ page }) => {
  const guard = installGuard(page);
  // Do NOT dismiss — the first-visit tour must auto-open.
  await gotoReady(page, { dismiss: false });
  await expect(page.locator("#tourOverlay")).toHaveClass(/show/);
  await expect(page.locator("#tourPop")).toBeVisible();

  // Click through Next until the final step's Done button, then it must close.
  for (let i = 0; i < 8; i++) {
    const done = page.locator("#tourPop button.primary", { hasText: "Done" });
    if (await done.count()) {
      await done.click();
      break;
    }
    await page.locator("#tourPop button.primary", { hasText: "Next" }).click();
  }
  await expect(page.locator("#tourOverlay")).not.toHaveClass(/show/);

  guard.assertClean();
});
