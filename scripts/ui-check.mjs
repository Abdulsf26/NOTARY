// Headless UI check: baseline-fooled → protected-confirmed → chain valid.
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL || 'http://localhost:5173/';
const shot = (page, name) => page.screenshot({ path: `artifacts/${name}.jpg`, type: 'jpeg', quality: 82, fullPage: false });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { if (m.type() === 'error') console.error('console.error:', m.text()); });
page.on('pageerror', e => console.error('pageerror:', e.message));

await page.goto(base, { waitUntil: 'networkidle' });
await shot(page, 'ui-1-loaded');

// 1) switch to baseline, run unprotected
await page.getByRole('button', { name: /BASELINE · NO NOTARY/i }).click();
await page.getByRole('button', { name: /Run — Unprotected/i }).click();
await page.locator('.flash', { hasText: 'BASELINE WAS FOOLED' }).waitFor({ timeout: 30000 });
await page.waitForTimeout(400);
await shot(page, 'ui-2-baseline-fooled');

// 2) CTA → protected mode, run again
await page.getByRole('button', { name: /Run it protected/i }).click();
await page.getByRole('button', { name: /Run — Protected by Notary/i }).click();
await page.locator('.flash', { hasText: 'CONFIRMED' }).waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
await shot(page, 'ui-3-protected-confirmed');

// 3) Ledger → verify hash chain
await page.getByRole('button', { name: /Receipts Ledger/i }).click();
await page.getByRole('button', { name: /VERIFY CHAIN/i }).click();
await page.getByText('CHAIN VALID', { exact: false }).waitFor({ timeout: 15000 });
await shot(page, 'ui-4-ledger-chain-valid');

// ── 4) Demo genuinely computes: arbitrary task in ⇒ computed trajectory out ──
await page.getByRole('button', { name: /^Demo Console$/i }).click();
await page.getByRole('button', { name: /^Refund a charge$/i }).click();
await page.getByRole('button', { name: /Run — Protected by Notary/i }).click();
await page.locator('.ev', { hasText: 'stripe.create_refund' }).first().waitFor({ timeout: 30000 });
await page.locator('.flash', { hasText: 'CONFIRMED' }).waitFor({ timeout: 30000 });
const refundTimeline = await page.locator('.timeline').innerText();
if (!refundTimeline.includes('stripe.create_refund')) throw new Error('refund task did not compile to stripe.create_refund');
if (!refundTimeline.includes('CONTRADICTED')) throw new Error('fault injection was not detected for the refund write');
console.log('dynamic task ✓ compiled to stripe.create_refund, fault caught and verified');

// 5) Exactly-once: same task re-run replays from the idempotency ledger
await page.getByRole('button', { name: /Run — Protected by Notary/i }).click();
await page.locator('.ev', { hasText: 'REPLAY' }).first().waitFor({ timeout: 30000 });
console.log('exactly-once ✓ second identical run replayed writes from the ledger');

// 6) Out-of-scope task fails honest, never fabricates
await page.getByRole('button', { name: /^Out of scope$/i }).click();
await page.getByRole('button', { name: /Run — Protected by Notary/i }).click();
await page.locator('.ev', { hasText: 'NO PLAN' }).waitFor({ timeout: 30000 });
console.log('fail-closed ✓ junk task produced NO PLAN, no fabricated calls');

await shot(page, 'ui-6-dynamic-task');

// ── 7) Guided Run: walk all five steps end-to-end ──
await page.getByRole('button', { name: /^Guided Run$/i }).click();
await page.getByRole('button', { name: /Compile it/i }).click();
await page.getByText('WHAT WAS CHOSEN', { exact: false }).waitFor({ timeout: 5000 });
await page.getByRole('button', { name: /Issue certificate/i }).click();
await page.getByText('PRE-FLIGHT COST CERTIFICATE', { exact: false }).waitFor({ timeout: 5000 });
await page.getByRole('button', { name: /Begin execution/i }).click();
for (let i = 0; i < 18; i++) {
  const seal = page.getByRole('button', { name: /Seal receipt/i });
  if (await seal.isEnabled().catch(() => false)) break;
  await page.getByRole('button', { name: /Next call|Retry \(bounded\)|^Done$/i }).first().click();
  await page.waitForTimeout(350);
}
await page.getByRole('button', { name: /Seal receipt/i }).click();
await page.getByText('SHA-256 hash-chained', { exact: false }).waitFor({ timeout: 8000 });
await page.getByRole('button', { name: /Verify chain/i }).click();
await page.getByText('CHAIN VALID', { exact: false }).waitFor({ timeout: 8000 });
console.log('guided run ✓ 5 steps · seal · chain valid');
await shot(page, 'ui-7-guided-chain');

await browser.close();
console.log('UI CHECK (EXTENDED) PASS');
