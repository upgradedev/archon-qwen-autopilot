// Capture private review candidates from the final live Autopilot UI.
// Output stays in a repository-contained ignored directory. A human must sanitize,
// inspect, and explicitly promote selected images to demo/final-media; this script
// never writes submission evidence directly.
const { chromium } = require('playwright');
const path = require('node:path');
const { resolveRepoContainedPath } = require('./repo-path.cjs');
(async () => {
  const base = process.env.AUTOPILOT_URL;
  if (!base || !base.startsWith('https://')) {
    throw new Error('AUTOPILOT_URL must be the final HTTPS deployment URL');
  }
  const outDir = resolveRepoContainedPath(
    process.argv[2] || '.artifacts/video-captures',
    'capture output'
  );
  require('fs').mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1320 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  // Dismiss any first-visit guided-tour overlay.
  await page.evaluate(() => {
    const kill = /tour|overlay|backdrop|spotlight|coach|onboard|popover/i;
    document.querySelectorAll('*').forEach(el => {
      if (el.id && kill.test(el.id)) el.remove();
      if (el.className && typeof el.className === 'string' && kill.test(el.className)) el.remove();
    });
    // click a skip/close button if one exists
    [...document.querySelectorAll('button,a')].forEach(b => {
      if (/skip|got it|close|dismiss|done|×|✕/i.test((b.textContent||''))) b.click();
    });
  });
  await page.waitForTimeout(500);
  const hidden = await page.evaluate(() => {
    const bad = /EL\d{6,}|could not reach a confident action|no_progress_fallback|Aventine|Contoso|Tailspin|Northwind|Meridian/i;
    let n=0; document.querySelectorAll('.card').forEach(c=>{ if(bad.test(c.textContent||'')){c.style.display='none';n++;} }); return n;
  });
  console.log('title:', await page.title(), '| hidden cards:', hidden);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'ui_overview.png'), fullPage: false });
  const firstCard = page.locator('.card:visible').first();
  if (await firstCard.count()) { await firstCard.scrollIntoViewIfNeeded(); await firstCard.screenshot({ path: path.join(outDir, 'ui_card.png') }); }
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
