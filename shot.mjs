// shot.mjs — deterministic stills of the strike at chosen loop times.
//
//   TIMES  loop seconds to capture (default: one frame per beat of the strike)
//   URL    dev/preview server origin           (default http://127.0.0.1:5199/)
//   OUT    output dir                          (default /tmp/shots)
//   CHROME chromium executable
//   WEBGPU=1  use the real WebGPU backend instead of the WebGL2 debug backend
//
// Each still loads `?freeze&clean&seek=T`: the timeline is held at T (every effect
// is a pure function of loop time), the HUD is hidden, and the camera is placed
// exactly. WebGL2 (`?webgl`) is the default because software WebGPU devices
// (SwiftShader) are lost under load; real GPUs can use WEBGPU=1.
import { chromium } from 'playwright-core';

const EXE = process.env.CHROME || '/home/user1/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const ORIGIN = process.env.URL || 'http://127.0.0.1:5199/';
const OUT = process.env.OUT || '/tmp/shots';
const times = (process.env.TIMES || '5,12,14.2,17,19.6,21,24,26,33').split(',').map(Number);
const gpu = !!process.env.WEBGPU;
const q = process.env.Q || 'potato';

const browser = await chromium.launch({
  executablePath: EXE,
  args: gpu
    ? ['--no-sandbox', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader']
    : ['--no-sandbox', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const logs = [];
for (const t of times) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${(e.stack || e.message).slice(0, 800)}`));
  await page.goto(`${ORIGIN}?${gpu ? '' : 'webgl&'}freeze&clean&nowarm&q=${q}&seek=${t}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(process.env.WAIT || 15000));   // boot typing + first frame
  await page.screenshot({ path: `${OUT}/t${t}.png`, timeout: 300000 });
  console.log(`shot @ loop ${t}s`);
  await page.close();
}
console.log('--- console ---');
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
