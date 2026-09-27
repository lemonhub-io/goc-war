// shot.mjs — capture frames of the strike at key timeline points
import { chromium } from 'playwright-core';

const EXE = process.env.CHROME || '/home/user1/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const URL = process.env.URL || 'http://127.0.0.1:5199/';
const OUT = process.env.OUT || '/tmp/shots';
const times = (process.env.TIMES || '3500,12000,21000,36000').split(',').map(Number);

const browser = await chromium.launch({
  executablePath: EXE,
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-webgpu-adapter=swiftshader',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${(e.stack||e.message).slice(0, 1200)}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

let last = 0;
for (const t of times) {
  await page.waitForTimeout(t - last);
  last = t;
  await page.screenshot({ path: `${OUT}/t${t}.png` });
  console.log(`shot @ ${t}ms`);
}
const backend = await page.textContent('#backend').catch(() => 'n/a');
console.log('BACKEND:', backend);
console.log('--- console ---');
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
