// audio.ts — synthesized soundscape: rumble bed, portal drone, fire crackle,
// lance zaps, klaxon, UI blips. All Web Audio synthesis — no assets.
// Layer gains ride the shared scene uniforms, so the mix follows the
// timeline automatically (breach opens the drone, inferno grows the fire).
import { U } from './shared';
import { dset } from './diag';

export interface Synth {
  readonly enabled: boolean;
  toggle(): boolean;
  boom(v: number): void;
  breachRiser(): void;
  lanceFire(): void;
  klaxon(): void;
  blip(): void;
  update(dt: number): void;
}

export function createSynth(): Synth {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let _enabled = false;

  // layer gains, driven by update()
  let humGain: GainNode | null = null;
  let fireGain: GainNode | null = null;
  let bedGain: GainNode | null = null;
  let crackleAcc = 0;

  const noiseBuffer = (seconds: number, decayPow = 1): AudioBuffer => {
    const len = Math.floor(ctx!.sampleRate * seconds);
    const buf = ctx!.createBuffer(1, len, ctx!.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decayPow);
    return buf;
  };

  function ensure() {
    if (ctx) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);

    // ---- rumble bed: looping brown-ish noise through a deep lowpass
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 160;
    bedGain = ctx.createGain();
    bedGain.gain.value = 0.5;
    src.connect(lp).connect(bedGain).connect(master);
    src.start();

    // slow amplitude LFO for unease
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.18;
    lfo.connect(lfoG).connect(bedGain.gain);
    lfo.start();

    // ---- portal drone: two detuned triangles + tremolo, gated by U.breach
    humGain = ctx.createGain();
    humGain.gain.value = 0;
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass'; humLp.frequency.value = 420;
    for (const f of [54, 81.3, 108.9]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f === 54 ? 0.5 : 0.22;
      o.connect(g).connect(humLp);
      o.start();
    }
    const trem = ctx.createOscillator();
    trem.frequency.value = 2.1;
    const tremG = ctx.createGain();
    tremG.gain.value = 0.25;
    trem.connect(tremG).connect(humGain.gain);
    trem.start();
    humLp.connect(humGain).connect(master);

    // ---- fire bed: airy noise hiss, gated by U.inferno (pops added live)
    fireGain = ctx.createGain();
    fireGain.gain.value = 0;
    const hiss = ctx.createBufferSource();
    hiss.buffer = noiseBuffer(2.5, 0.2); hiss.loop = true;
    const hissBp = ctx.createBiquadFilter();
    hissBp.type = 'bandpass'; hissBp.frequency.value = 2400; hissBp.Q.value = 0.6;
    hiss.connect(hissBp).connect(fireGain).connect(master);
    hiss.start();
  }

  function boom(v: number) {
    if (!ctx || !master || !_enabled) return;
    const t0 = ctx.currentTime;
    // sub thump
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t0);
    osc.frequency.exponentialRampToValueAtTime(34, t0 + 0.7);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.55 * v, t0);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
    osc.connect(og).connect(master);
    osc.start(t0); osc.stop(t0 + 1);
    // crackle
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(0.6, 3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.setValueAtTime(900, t0);
    bp.frequency.exponentialRampToValueAtTime(120, t0 + 0.5);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.4 * v, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
    n.connect(bp).connect(ng).connect(master);
    n.start(t0);
  }

  function breachRiser() {
    if (!ctx || !master || !_enabled) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(50, t0);
    osc.frequency.exponentialRampToValueAtTime(640, t0 + 3.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.22, t0 + 3.2);
    og.gain.exponentialRampToValueAtTime(0.001, t0 + 4.4);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 80;
    osc.connect(og).connect(hp).connect(master);
    osc.start(t0); osc.stop(t0 + 4.6);
    boom(1.4);
  }

  /** energy lance launch — descending zap with a hiss tail */
  function lanceFire() {
    if (!ctx || !master || !_enabled) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1400, t0);
    o.frequency.exponentialRampToValueAtTime(110, t0 + 0.32);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.34);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.4;
    o.connect(bp).connect(g).connect(master);
    o.start(t0); o.stop(t0 + 0.4);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(0.3, 2.4);
    const nf = ctx.createBiquadFilter();
    nf.type = 'highpass'; nf.frequency.value = 3200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.07, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    n.connect(nf).connect(ng).connect(master);
    n.start(t0);
  }

  /** two-tone alert — plays when the STRIKE phase opens */
  function klaxon() {
    if (!ctx || !master || !_enabled) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.42;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(660, t);
      o.frequency.setValueAtTime(494, t + 0.19);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.02);
      g.gain.setValueAtTime(0.05, t + 0.34);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.4);
    }
  }

  /** tiny HUD tick for log lines */
  function blip() {
    if (!ctx || !master || !_enabled) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1560;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.028, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    o.connect(g).connect(master);
    o.start(t0); o.stop(t0 + 0.06);
  }

  /** fire-crackle pop — scheduled probabilistically from update() */
  function crackle(v: number) {
    if (!ctx || !master) return;
    const t0 = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(0.07 + Math.random() * 0.05, 1.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 3200;
    bp.Q.value = 4 + Math.random() * 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 + 0.08 * v * Math.random(), t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
    n.connect(bp).connect(g).connect(master);
    n.start(t0);
  }

  let lastResume = 0;

  /** drive the ambient layers from the shared scene uniforms */
  function update(dt: number) {
    if (!ctx || !_enabled) return;
    // 'interrupted' (iOS/Safari) and 'suspended' both need resume() — keep
    // retrying (throttled) until the context actually runs again
    if (ctx.state !== 'running') {
      dset('audio', `on ctx=${ctx.state} (retrying)`);
      // wall clock — ctx.currentTime doesn't advance while non-running
      if (performance.now() - lastResume > 600) {
        lastResume = performance.now();
        ctx.resume().catch(() => {});
      }
      return;
    }
    dset('audio', `on ctx=${ctx.state}`);
    const t0 = ctx.currentTime;
    const set = (g: GainNode | null, v: number) => g?.gain.setTargetAtTime(v, t0, 0.25);
    set(humGain, U.breach.value * 0.26);
    set(fireGain, U.inferno.value * 0.30);
    set(bedGain, 0.5 + U.strike.value * 0.15 + Math.min(0.5, U.shake.value * 0.45));

    // crackle density scales with the fire spread
    const inferno = U.inferno.value;
    if (inferno > 0.02) {
      crackleAcc += dt * inferno * 16;
      while (crackleAcc > 1) { crackleAcc -= 1; crackle(inferno); }
    }
  }

  return {
    get enabled() { return _enabled; },
    toggle() {
      ensure();
      ctx!.resume().catch(() => {});
      // iOS can report 'interrupted' and need resume() again after the
      // state settles — the update() retry loop covers that
      ctx!.onstatechange = () => dset('audio', `${_enabled ? 'on' : 'off'} ctx=${ctx!.state}`);
      _enabled = !_enabled;
      if (master) master.gain.linearRampToValueAtTime(_enabled ? 0.42 : 0, ctx!.currentTime + 0.4);
      return _enabled;
    },
    boom, breachRiser, lanceFire, klaxon, blip, update,
  };
}
