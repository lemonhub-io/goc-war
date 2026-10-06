// hud.ts — tactical telemetry overlay: dossier, telemetry, phase rail, log

/** live numbers the director feeds the telemetry panel */
export interface HudState {
  capacitor: number;   // MJ
  velocity: number;    // km/s
  altitude: number;    // km
  yieldKt: number;     // kt TNT-equivalent
  integrity: number;   // % target integrity
}

export interface Hud {
  log(msg: string): void;
  setPhase(i: number): void;
  flash(size: 'small' | 'big'): void;
  feedGlitch(): void;
  feedReset(): void;
  /** full-screen title-card slam (kanji + subline) */
  title(main: string, sub: string): void;
  setBackend(name: string): void;
  setPerf(text: string): void;
  tick(t: number, s: HudState): void;
}

const MAX_LOG = 6;

export function createHud(): Hud {
  const $ = (id: string) => document.getElementById(id)!;
  const logEl = $('log');
  const phaseCells = [...document.querySelectorAll<HTMLElement>('.phase-cell')];
  const alertEl = $('alert');
  const glitchEl = $('glitch');
  const titleEl = $('strike-title');
  const clockEl = $('clock');
  const backendEl = $('backend');
  const perfEl = $('perf');
  const tv = {
    cap: $('tv-cap'), vel: $('tv-vel'), alt: $('tv-alt'),
    yield: $('tv-yield'), integ: $('tv-integ'), integBar: $('tv-integ-bar'),
  };

  const log = (msg: string) => {
    const d = document.createElement('div');
    d.className = 'log-line';
    d.textContent = `> ${msg}`;
    logEl.prepend(d);
    while (logEl.children.length > MAX_LOG) logEl.lastChild!.remove();
  };

  const setPhase = (i: number) => {
    phaseCells.forEach((c, k) => {
      c.classList.toggle('active', k === i);
      c.classList.toggle('done', k < i);
    });
    document.body.classList.toggle('phase-strike', i === 2);
    document.body.classList.toggle('phase-searing', i === 3);
  };

  let flashTimer = 0;
  const flash = (size: 'small' | 'big') => {
    alertEl.classList.remove('small', 'big');
    void alertEl.offsetWidth; // restart css anim
    alertEl.classList.add(size);
    if (size === 'big') {
      document.body.classList.add('alerted');
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => document.body.classList.remove('alerted'), 2600);
    }
  };

  const title = (main: string, sub: string) => {
    titleEl.querySelector('b')!.textContent = main;
    titleEl.querySelector('span')!.textContent = sub;
    titleEl.classList.remove('run');
    void titleEl.offsetWidth;
    titleEl.classList.add('run');
  };

  const feedGlitch = () => {
    glitchEl.classList.remove('run');
    void glitchEl.offsetWidth;
    glitchEl.classList.add('run');
  };
  const feedReset = () => {
    log('— FEED LOOP RESTART —');
  };

  const setBackend = (name: string) => {
    backendEl.textContent = name;
    backendEl.classList.toggle('degraded', name !== 'WEBGPU');
  };

  const setPerf = (text: string) => {
    perfEl.textContent = text;
    perfEl.classList.toggle('degraded', !text.endsWith('HIGH'));
  };

  let clockBase = Date.now();
  const tick = (_t: number, st: HudState) => {
    tv.cap.textContent = `${st.capacitor.toFixed(0)} MJ`;
    tv.vel.textContent = `${st.velocity.toFixed(2)} km/s`;
    tv.alt.textContent = `${st.altitude.toFixed(1)} km`;
    tv.yield.textContent = `${st.yieldKt.toFixed(1)} kt`;
    tv.integ.textContent = `${st.integrity.toFixed(1)}%`;
    tv.integBar.style.width = `${Math.max(0, Math.min(100, st.integrity))}%`;
    // mission clock
    const s = (Date.now() - clockBase) / 1000;
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
    const ss = String(Math.floor(s) % 60).padStart(2, '0');
    clockEl.textContent = `T+${hh}:${mm}:${ss}`;
  };

  return { log, setPhase, flash, title, feedGlitch, feedReset, setBackend, setPerf, tick };
}
