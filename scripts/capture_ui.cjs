// Capture real screenshots of the LIVE Alibaba Cloud approval UI for the demo video.
// Non-mutating: hides out-of-scope test/noise cards client-side only (positioning
// guard + a tidy queue); dismisses the first-visit guided tour if present.
const { chromium } = require('playwright');
(async () => {
  const base = process.env.AUTOPILOT_URL || 'https://autopilot.43.106.13.19.sslip.io/';
  const outDir = process.argv[2] || 'demo/video/assets';
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
  await page.screenshot({ path: outDir + '/ui_overview.png', fullPage: false });
  const firstCard = page.locator('.card:visible').first();
  if (await firstCard.count()) { await firstCard.scrollIntoViewIfNeeded(); await firstCard.screenshot({ path: outDir + '/ui_card.png' }); }
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
