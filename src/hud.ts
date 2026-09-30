// hud.ts — tactical telemetry overlay: dossier, telemetry, phase rail, log
import { U } from './shared';

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
  tick(t: number): void;
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
    thaum: $('tv-thaum'), eve: $('tv-eve'), aperture: $('tv-aperture'),
    denial: $('tv-denial'), denialBar: $('tv-denial-bar'),
  };

  let denial = 0;
  let lastPhase = 0;

  const log = (msg: string) => {
    const d = document.createElement('div');
    d.className = 'log-line';
    d.textContent = `> ${msg}`;
    logEl.prepend(d);
    while (logEl.children.length > MAX_LOG) logEl.lastChild!.remove();
  };

  const setPhase = (i: number) => {
    lastPhase = i;
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
    denial = 0;
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
  const tick = (t: number) => {
    // telemetry — derived from scene uniforms + noise
    const th = (U.breach.value * 940 + Math.sin(t * 2.1) * 30 + Math.sin(t * 7.7) * 12).toFixed(1);
    const eve = (U.inferno.value * 2400 + 140 + Math.sin(t * 3.3) * 55).toFixed(0);
    const ap = (U.breach.value * 7.36).toFixed(2);
    tv.thaum.textContent = `${th} kΨ`;
    tv.eve.textContent = `${eve} mEV`;
    tv.aperture.textContent = `${ap} m`;
    if (lastPhase >= 2) denial = Math.min(96.4, denial + (0.55 + Math.random() * 0.8) * (lastPhase === 3 ? 1.6 : 1));
    tv.denial.textContent = `${denial.toFixed(1)}%`;
    tv.denialBar.style.width = `${Math.min(100, denial)}%`;
    // mission clock
    const s = (Date.now() - clockBase) / 1000;
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
    const ss = String(Math.floor(s) % 60).padStart(2, '0');
    clockEl.textContent = `T+${hh}:${mm}:${ss}`;
  };

  return { log, setPhase, flash, title, feedGlitch, feedReset, setBackend, setPerf, tick };
}
