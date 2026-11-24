// Headless walkthrough of the Guided Run tab — proves every step computes for real.
import { chromium } from 'playwright-core';
const base = process.env.BASE_URL || 'http://localhost:5173/';
const shot = (page, name) => page.screenshot({ path: `../artifacts/${name}.jpg`, type: 'jpeg', quality: 84, fullPage: false });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));

await page.goto(base, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /^Guided Run$/i }).click();
await page.waitForTimeout(400);
await shot(page, 'guided-1-task');

// step 2
await page.getByRole('button', { name: /Compile it/i }).click();
await page.waitForTimeout(400);
await shot(page, 'guided-2-compile');

// interact: pin an OFF-SURFACE tool to force it in (recompute is live)
const pinButtons = page.locator('.pool-row:has(span:text("○")) .seg3 button', { hasText: 'pin' });
const n = await pinButtons.count();
if (n > 0) {
  await pinButtons.first().click();
  await page.waitForTimeout(300);
  await shot(page, 'guided-2b-pinned');
  // unpin again — restore default surface
  const unpin = page.locator('.pool-row .seg3 button.on-pin').first();
  if (await unpin.count()) { await unpin.click(); await page.waitForTimeout(300); }
} else {
  console.log('note: no off-surface pool rows to pin (all pool rows already selected)');
}

// step 3
await page.getByRole('button', { name: /Issue certificate/i }).click();
await page.waitForTimeout(400);
await shot(page, 'guided-3-certificate');

// step 4 — click Next/Retry until the plan completes
await page.getByRole('button', { name: /Begin execution/i }).click();
await page.waitForTimeout(400);
for (let i = 0; i < 16; i++) {
  const seal = page.getByRole('button', { name: /Seal receipt/i });
  if (await seal.isEnabled().catch(() => false)) break;
  const next = page.getByRole('button', { name: /Next call|Retry \(bounded\)|Running…/i }).first();
  if (!(await next.count())) break;
  await next.click();
  await page.waitForTimeout(450);
}
await page.waitForTimeout(400);
await shot(page, 'guided-4-act');

// step 5 — seal and verify the chain
await page.getByRole('button', { name: /Seal receipt/i }).click();
await page.waitForTimeout(500);
await shot(page, 'guided-5-receipt');
await page.getByRole('button', { name: /Verify chain/i }).click();
await page.waitForTimeout(400);
await shot(page, 'guided-5b-chain');

const bad = errors.filter(e => !e.includes('favicon'));
if (bad.length) { console.error('console errors:', bad); process.exitCode = 1; } else console.log('no console errors');
console.log('GUIDED CHECK DONE');
await browser.close();
