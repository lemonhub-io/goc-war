// hud.ts — tactical telemetry overlay: dossier, telemetry, phase rail, log

/** live numbers the director feeds the telemetry panel */
export interface HudState {
  capacitor: number;   // MJ
  velocity: number;    // km/s
  altitude: number;    // km
  yieldKt: number;     // kt TNT-equivalent
  integrity: number;   // % target integrity
}

/** the operator gauge around the reticle (null hides it) */
export interface Ctl {
  /** 0..1 inner ring — stack charge (or lock progress while acquiring) */
  charge: number;
  /** 0..1 outer ring — overcharge */
  over: number;
  main: string;
  sub: string;
  /** colour/behaviour state: hint | idle | charging | over | sweet | danger */
  state: string;
  /** show the rings (text-only hints hide them) */
  ring: boolean;
}

export interface StrikeRecord { n: number; grade: string; kt: number; auto: boolean }

export interface Hud {
  log(msg: string): void;
  setPhase(i: number): void;
  flash(size: 'small' | 'big'): void;
  feedGlitch(): void;
  feedReset(): void;
  /** full-screen title-card slam (kanji + subline), optionally toned perfect | overload */
  title(main: string, sub: string, tone?: string): void;
  /** per-frame operator gauge */
  control(c: Ctl | null): void;
  /** log a finished strike into the record panel (best yield persists) */
  record(r: StrikeRecord): void;
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

  const title = (main: string, sub: string, tone = '') => {
    titleEl.querySelector('b')!.textContent = main;
    titleEl.querySelector('span')!.textContent = sub;
    titleEl.classList.remove('run', 'perfect', 'overload');
    void titleEl.offsetWidth;
    titleEl.classList.add('run');
    if (tone) titleEl.classList.add(tone);
  };

  // ---- operator gauge: only touches the DOM when a value actually changes
  const ctlEl = $('ctl'), ctlMain = $('ctl-main'), ctlSub = $('ctl-sub');
  const gChg = $('g-chg'), gOver = $('g-over');
  const C1 = 2 * Math.PI * 54, C2 = 2 * Math.PI * 63;
  let cCls = '', cMain = '', cSub = '', cChg = -1, cOv = -1, cHot = false;
  const control = (c: Ctl | null) => {
    const cls = c ? `on ${c.state}${c.ring ? ' ring' : ''}` : '';
    if (cls !== cCls) { ctlEl.className = cls; cCls = cls; }
    const hot = !!c && (c.state === 'over' || c.state === 'sweet' || c.state === 'danger');
    if (hot !== cHot) { document.body.classList.toggle('overcharge', hot); cHot = hot; }
    if (!c) return;   // keep the last text so the fade-out still reads
    if (c.main !== cMain) { ctlMain.textContent = c.main; cMain = c.main; }
    if (c.sub !== cSub) { ctlSub.textContent = c.sub; cSub = c.sub; }
    const ch = Math.round(c.charge * 300) / 300;
    if (ch !== cChg) { gChg.setAttribute('stroke-dasharray', `${(C1 * ch).toFixed(1)} ${C1.toFixed(1)}`); cChg = ch; }
    const ov = Math.round(c.over * 300) / 300;
    if (ov !== cOv) { gOver.setAttribute('stroke-dasharray', `${(C2 * ov).toFixed(1)} ${C2.toFixed(1)}`); cOv = ov; }
  };

  // ---- strike record: last few strikes this session, best yield kept across visits
  const recList = $('rec-list'), recBest = $('rec-best');
  const BEST_KEY = 'goc-war:best-kt';
  let best = 0;
  try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch { /* storage blocked */ }
  if (best > 0) recBest.textContent = `${best.toFixed(1)} kt`;
  const record = (r: StrikeRecord) => {
    recList.querySelector('.rec-empty')?.remove();
    const row = document.createElement('div');
    row.className = `rec-row ${r.auto ? 'auto' : r.grade.toLowerCase()}`;
    const n = document.createElement('b'); n.textContent = `#${String(r.n).padStart(2, '0')}`;
    const g = document.createElement('span'); g.textContent = r.auto ? 'AUTO' : r.grade;
    const k = document.createElement('samp'); k.textContent = `${r.kt.toFixed(1)} kt`;
    row.append(n, g, k);
    recList.prepend(row);
    while (recList.children.length > 4) recList.lastChild!.remove();
    if (!r.auto && r.kt > best + 1e-6) {
      best = r.kt;
      row.classList.add('best');
      recBest.textContent = `${best.toFixed(1)} kt`;
      recBest.classList.remove('new'); void recBest.offsetWidth; recBest.classList.add('new');
      try { localStorage.setItem(BEST_KEY, String(best)); } catch { /* storage blocked */ }
      log(`NEW BEST YIELD ${best.toFixed(1)} KT`);
    }
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

  return { log, setPhase, flash, title, control, record, feedGlitch, feedReset, setBackend, setPerf, tick };
}
