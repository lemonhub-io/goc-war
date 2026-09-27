// diag.ts — on-page diagnostics: captures errors, console noise, adapter
// info and render progress into a copyable log so users on machines without
// devtools can report failures.
import { U } from './shared';

interface Entry { t: number; lvl: string; msg: string }

const entries: Entry[] = [];
const MAX_ENTRIES = 400;
const bootT = performance.now();

export function dlog(lvl: string, msg: string) {
  entries.push({ t: (performance.now() - bootT) / 1000, lvl, msg });
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (panelOpen) renderLines();
}

// ---------------------------------------------------------------- capture

let hooked = false;
export function installDiagHooks() {
  if (hooked) return;
  hooked = true;

  addEventListener('error', (e) => {
    dlog('ERROR', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    dlog('REJECT', r instanceof Error ? (r.stack || r.message) : String(r));
  });

  // Three.js TSL logs pipeline build failures via console.error/warn —
  // mirror them into the buffer so they're visible without devtools
  for (const lvl of ['error', 'warn'] as const) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a: unknown[]) => {
      try {
        dlog(lvl.toUpperCase(), a.map((x) => {
          if (x instanceof Error) return x.stack || x.message;
          if (typeof x === 'object') return JSON.stringify(x)?.slice(0, 300);
          return String(x);
        }).join(' ').slice(0, 1200));
      } catch { /* never break logging */ }
      orig(...a);
    };
  }
  dlog('INFO', 'diag hooks installed');
}

// ---------------------------------------------------------------- runtime state

const state: Record<string, string> = {};
export function dset(k: string, v: string) { state[k] = v; }

export interface AdapterInfo {
  vendor?: string; architecture?: string; device?: string; description?: string;
}

export function diagAdapterInfo(info: AdapterInfo | undefined) {
  try {
    dset('adapter', JSON.stringify({
      vendor: info?.vendor, architecture: info?.architecture,
      device: info?.device, description: info?.description,
    }));
  } catch { dset('adapter', 'unreadable'); }
}

// ---------------------------------------------------------------- snapshot

export function snapshot(): string {
  const nav = navigator;
  const deviceMemory = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
  const head = [
    `== GOC-WAR DIAGNOSTICS ${new Date().toISOString()} ==`,
    `url: ${location.href}`,
    `ua: ${nav.userAgent}`,
    `cores: ${nav.hardwareConcurrency} mem: ${deviceMemory ?? '?'}GB dpr: ${devicePixelRatio}`,
    `vp: ${innerWidth}x${innerHeight} hidden: ${document.hidden}`,
    `gpu-in-navigator: ${'gpu' in nav}`,
    ...Object.entries(state).map(([k, v]) => `${k}: ${v}`),
    `== LOG (${entries.length}) ==`,
  ];
  const body = entries.map((e) => `${e.t.toFixed(2).padStart(8)}s [${e.lvl}] ${e.msg}`);
  return head.concat(body).join('\n');
}

// ---------------------------------------------------------------- panel

let panelOpen = false;
let preEl: HTMLPreElement | null = null;

function renderLines() {
  if (preEl) preEl.textContent = snapshot();
}

export function showDiag(reason?: string) {
  const el = document.getElementById('diag')!;
  el.hidden = false;
  panelOpen = true;
  if (reason) dlog('DIAG', reason);
  renderLines();
}

export function createDiagPanel() {
  const host = document.createElement('div');
  host.id = 'diag';
  host.hidden = true;
  host.innerHTML = `
    <div class="diag-box">
      <div class="diag-h">
        <b>TAC-FEED DIAGNOSTICS</b>
        <span>if the feed is dead — copy this log and send it back</span>
      </div>
      <pre class="diag-pre"></pre>
      <div class="diag-btns">
        <button id="diag-copy" type="button">COPY LOG</button>
        <button id="diag-close" type="button">CLOSE</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  preEl = host.querySelector('.diag-pre');

  host.querySelector('#diag-close')!.addEventListener('click', () => {
    host.hidden = true;
    panelOpen = false;
  });
  host.querySelector('#diag-copy')!.addEventListener('click', async () => {
    renderLines();
    const txt = snapshot();
    const btn = host.querySelector('#diag-copy') as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(txt);
      btn.textContent = 'COPIED ✓';
    } catch {
      // clipboard API may be blocked — select text for manual copy
      const r = document.createRange();
      r.selectNodeContents(preEl!);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
      btn.textContent = 'SELECTED — CTRL+C';
    }
    setTimeout(() => (btn.textContent = 'COPY LOG'), 2000);
  });

  const btn = document.createElement('button');
  btn.id = 'diag-toggle';
  btn.type = 'button';
  btn.textContent = 'DIAG';
  btn.addEventListener('click', () => (panelOpen ? (host.hidden = true, panelOpen = false) : showDiag()));
  document.body.appendChild(btn);

  if (new URLSearchParams(location.search).has('diag')) showDiag('opened via ?diag');
}

// ---------------------------------------------------------------- watchdog
// if the pipeline never produces a frame, the user sees a black feed with a
// healthy HUD — surface the log automatically instead of stranding them.

let frames = 0;
let armed = false;
export function diagFrame() { frames++; }
export function armWatchdog() {
  if (armed) return;
  armed = true;
  setInterval(() => {
    dset('frames', String(frames));
    dset('t', U.time.value.toFixed(1));
    if (armed && frames === 0 && performance.now() - bootT > 9000) {
      armed = false;
      showDiag('watchdog: 0 rendered frames after 9s');
    }
  }, 2000);
}
