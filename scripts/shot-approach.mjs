import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
await page.goto(process.env.BASE_URL || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /How It Works/i }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: '../artifacts/ui-5-approach.jpg', type: 'jpeg', quality: 82 });
await browser.close();
console.log('done');
