// make-icons.mjs — render the UN·GOC seal to PNG icons via headless chromium
// (same driver as shot.mjs). Outputs into public/icons/.
//
//   node make-icons.mjs            # writes all icons
//   CHROME=/path/to/chrome OUT=public/icons node make-icons.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const EXE = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const OUT = process.env.OUT || 'public/icons';
mkdirSync(OUT, { recursive: true });

// shared.ts:makeEmblemSVG — pentagram seal, un-blue on void black
const EMBLEM = `
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="24" r="21" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="24" cy="24" r="15" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3"/>
  <path d="M24 7 L27.8 19.2 L40.5 19.4 L30.6 27 L34.2 39.5 L24 32.2 L13.8 39.5 L17.4 27 L7.5 19.4 L20.2 19.2 Z" fill="currentColor" opacity="0.9"/>
</svg>`;

const page = (size, emblemPct) => `<!doctype html><style>
  html,body{margin:0}
  body{width:${size}px;height:${size}px;background:#020308;display:flex;align-items:center;justify-content:center}
  .seal{width:${Math.round(size * emblemPct)}px;height:${Math.round(size * emblemPct)}px;color:#7fb4ff}
  .seal svg{width:100%;height:100%;display:block}
</style><div class="seal">${EMBLEM}</div>`;

// emblemPct: regular icons fill ~84%; maskable must keep the mark inside the
// 80%-diameter safe zone → ~66% leaves the seal circle fully visible
const ICONS = [
  ['icon-192.png', 192, 0.84],
  ['icon-512.png', 512, 0.84],
  ['icon-maskable-512.png', 512, 0.66],
  ['apple-touch-icon.png', 180, 0.78],
];

const browser = await chromium.launch({ executablePath: EXE });
try {
  for (const [name, size, pct] of ICONS) {
    const p = await browser.newPage({ viewport: { width: size, height: size } });
    await p.setContent(page(size, pct));
    await p.screenshot({ path: join(OUT, name), type: 'png' });
    await p.close();
    console.log(`${name}  ${size}x${size}`);
  }
} finally {
  await browser.close();
}
