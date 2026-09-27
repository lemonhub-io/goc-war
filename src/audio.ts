// audio.ts — tiny synthesized soundscape: rumble bed, lance booms, breach riser
export interface Synth {
  readonly enabled: boolean;
  toggle(): boolean;
  boom(v: number): void;
  breachRiser(): void;
}

export function createSynth(): Synth {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let _enabled = false;

  function ensure() {
    if (ctx) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);

    // rumble bed: looping brown-ish noise through a deep lowpass
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
    const bed = ctx.createGain();
    bed.gain.value = 0.5;
    src.connect(lp).connect(bed).connect(master!);
    src.start();

    // slow amplitude LFO for unease
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.18;
    lfo.connect(lfoG).connect(bed.gain);
    lfo.start();
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
    const nb = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (nd.length * 0.12));
    n.buffer = nb;
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

  return {
    get enabled() { return _enabled; },
    toggle() {
      ensure();
      ctx!.resume();
      _enabled = !_enabled;
      if (master) master.gain.linearRampToValueAtTime(_enabled ? 0.42 : 0, ctx!.currentTime + 0.4);
      return _enabled;
    },
    boom, breachRiser,
  };
}
