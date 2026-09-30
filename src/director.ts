// director.ts — the strike timeline: phases, camera rig, shake, event schedule
//
//  0.0 ─ 9.4   APPROACH   quiet hall; the floor seal inscribes itself
//  9.4 ─ 15.0  BREACH     the Way tears open (shockwave + flash)
// 15.0 ─ 33.2  STRIKE     designated pillars → carpet barrage → CONVERGENCE:
//                         ring of eight, then the finisher on the aperture
// 33.2 ─ 44.0  ASHFALL    the Way collapses inward, ash sifts down, feed loops
import * as THREE from 'three/webgpu';
import { U, PORTAL } from './shared';
import type { Combat } from './combat';
import type { Strike } from './strike';
import type { Hud } from './hud';
import type { Synth } from './audio';

export const LOOP = 44;

// phase boundaries within the loop
const T_SIGIL_START = 1.0;
const T_SIGIL_DONE = 8.4;
const T_BREACH_HIT = 9.4;
const T_BREACH_DONE = 15.0;
const T_STRIKE_END = 33.2;
const T_END = LOOP;

// volleys fire in burst groups — tighter triplets with breathing gaps
// instead of a metronome cadence. Each one is a pillar (x, z, scale) plus
// supporting MK-IV lances.
const VOLLEYS: { t: number; x: number; z: number; s: number }[] = [
  { t: 16.3, x: -7.0, z: -12.0, s: 0.85 },
  { t: 16.9, x: 8.0, z: -16.5, s: 0.85 },
  { t: 17.5, x: -11.5, z: -6.5, s: 0.9 },
  { t: 20.0, x: 3.5, z: -9.0, s: 1.0 },
  { t: 20.7, x: -4.5, z: -20.0, s: 1.0 },
  { t: 21.4, x: 10.5, z: -6.0, s: 1.05 },
  { t: 23.4, x: -9.5, z: -19.0, s: 1.1 },
  { t: 24.1, x: 6.5, z: -21.5, s: 1.15 },
  { t: 28.6, x: -1.5, z: -5.5, s: 1.2 },
];
const T_BARRAGE = 25.5;
const T_CONVERGE = 30.4;

function seg(t: number, a: number, b: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

export class Director {
  private combat: Combat;
  private strike: Strike;
  private hud: Hud;
  private audio: Synth;
  private camPosSm = new THREE.Vector3(0, 4.6, 26);
  private lookSm = new THREE.Vector3(0, 9, -16);
  private rollSm = 0;
  private fovSm = 55;
  private posTarget = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private mouse = new THREE.Vector2();
  private mouseSm = new THREE.Vector2();
  private volleyIdx = 0;
  private volleyJitter: number[] = VOLLEYS.map(() => 0);
  private lastPhase = -1;
  private breachFired = false;
  private breachDoneFired = false;
  private barrageFired = false;
  private convergeFired = false;
  private implodeFired = false;
  private resetFired = false;
  private elapsed = 0;
  private tsSm = 1;

  /** called once per loop restart so the owner can reset the world (books etc.) */
  onLoopRestart: () => void = () => {};

  constructor(combat: Combat, strike: Strike, hud: Hud, audio: Synth) {
    this.combat = combat; this.strike = strike; this.hud = hud; this.audio = audio;
    window.addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2);
    });
  }

  get phaseTime(): number { return this.elapsed % LOOP; }
  get phaseIndex(): number {
    const t = this.phaseTime;
    return t < T_BREACH_HIT ? 0 : t < T_BREACH_DONE ? 1 : t < T_STRIKE_END ? 2 : 3;
  }
  /** simulation speed the render loop should advance by (hit-stop / slow-mo) */
  get timeScale(): number { return this.tsSm; }

  update(t: number, dt: number, camera: THREE.PerspectiveCamera) {
    this.elapsed = t;
    const pt = this.phaseTime;

    // ---------- time dilation: eased so hit-stops read as impact, not stutter
    const tsTarget = this.strike.timeScale(t);
    this.tsSm += (tsTarget - this.tsSm) * Math.min(1, dt * (tsTarget < this.tsSm ? 40 : 6));

    // ---------- global uniforms
    U.time.value = t;
    U.collapse.value = seg(pt, 34.6, 37.8);
    U.breach.value = Math.pow(seg(pt, T_BREACH_HIT - 1.2, T_BREACH_DONE), 0.8) * (1 - U.collapse.value);
    U.strike.value = Math.pow(seg(pt, T_BREACH_DONE - 1.5, T_BREACH_DONE + 2.0), 1.4);
    U.inferno.value = Math.min(1, seg(pt, 15, 34) * 1.15 + seg(pt, 38, 43) * 0.05);
    U.sigil.value = seg(pt, T_SIGIL_START, T_SIGIL_DONE) * (1 - seg(pt, 38.5, 43.0));
    U.ash.value = seg(pt, 33.4, 37.5) * (1 - seg(pt, 42.0, 44.0));
    U.scarFade.value = 1 - seg(pt, 39.5, 43.6);
    U.rays.value = U.breach.value * (0.35 + 0.65 * U.strike.value);
    U.shake.value *= Math.exp(-dt * 3.0);
    U.flash.value *= Math.exp(-dt * 4.5);
    U.caBoost.value *= Math.exp(-dt * 3.4);
    U.exposure.value = 1 + U.breach.value * 0.5 + U.flash.value * 0.8;

    // ---------- events
    if (pt < 2) { // loop restarted
      if (this.resetFired) {
        this.resetFired = false;
        this.volleyIdx = 0;
        this.volleyJitter = VOLLEYS.map(() => (Math.random() - 0.5) * 0.3);
        this.breachFired = false;
        this.breachDoneFired = false;
        this.barrageFired = false;
        this.convergeFired = false;
        this.implodeFired = false;
        this.strike.reset();
        this.onLoopRestart();
        this.hud.feedReset();
      }
    }
    if (!this.breachFired && pt >= T_BREACH_HIT) {
      this.breachFired = true;
      this.combat.breachBlast(t);
      this.strike.shock(t, PORTAL, 2.3, 1.7);
      this.strike.shock(t + 0.22, PORTAL, 1.3, 1.3);
      this.hud.log('WAY BREACH CONFIRMED — APERTURE 0.0 → 7.4 M');
    }
    // secondary accent when the aperture finishes opening — a settle thump
    if (!this.breachDoneFired && pt >= T_BREACH_DONE) {
      this.breachDoneFired = true;
      U.shake.value += 0.35;
      U.flash.value = Math.max(U.flash.value, 0.3);
      this.strike.shock(t, PORTAL, 1.0, 1.2);
      this.audio.boom(0.5);
      this.hud.title('奇术打击', 'OCCULT ARTS STRIKE // THAUMIC ORDNANCE RELEASED');
    }
    while (this.volleyIdx < VOLLEYS.length && pt >= VOLLEYS[this.volleyIdx].t + this.volleyJitter[this.volleyIdx]) {
      const v = VOLLEYS[this.volleyIdx];
      this.strike.pillar(t, v.x, v.z, v.s);
      this.combat.fireVolley(t);
      this.volleyIdx++;
    }
    if (!this.barrageFired && pt >= T_BARRAGE) {
      this.barrageFired = true;
      this.strike.barrage(t);
    }
    // closing act — a ring of eight, then the finisher on the aperture
    if (!this.convergeFired && pt >= T_CONVERGE) {
      this.convergeFired = true;
      this.combat.finalSalvo(t);
      this.strike.convergence(t);
      this.hud.log('THAUMIC CONVERGENCE — ALL TUBES, ALL ELEMENTS');
    }
    // the Way folds in on itself
    if (!this.implodeFired && pt >= 34.6) {
      this.implodeFired = true;
      this.strike.implode(t);
      U.flash.value = Math.max(U.flash.value, 0.9);
      U.shake.value = Math.min(1.8, U.shake.value + 1.0);
      this.audio.boom(1.4);
      this.hud.title('焚毁', 'KTE-7909 // WAY COLLAPSE — DENIAL COMPLETE');
    }
    // scripted log beats
    this.logBeats(pt);
    // near loop end — glitch
    if (pt > T_END - 0.5 && !this.resetFired) {
      this.resetFired = true;
      this.hud.feedGlitch();
    }

    // ---------- hud phase
    const ph = this.phaseIndex;
    if (ph !== this.lastPhase) {
      this.lastPhase = ph;
      this.hud.setPhase(ph);
      if (ph === 3) this.hud.log('ASHFALL PROTOCOL — LIBRARY DENIED');
      if (ph === 2) { this.audio.klaxon(); this.hud.log('FIREBREAK ELEMENTS THROUGH — WEAPONS FREE'); }
    }

    // ---------- camera
    this.mouseSm.lerp(this.mouse, Math.min(1, dt * 3));
    const orbit = seg(pt, T_BREACH_DONE, T_STRIKE_END);
    const pull = seg(pt, T_STRIKE_END + 1, T_END - 1);
    const push = seg(pt, T_BREACH_HIT - 1, T_BREACH_DONE);
    // convergence dolly: drop low and surge at the aperture for the finisher
    const conv = seg(pt, T_CONVERGE - 0.4, T_CONVERGE + 2.6) * (1 - seg(pt, 34.2, 36.5));
    // approach: slow crawl-in while the seal draws
    const creep = seg(pt, 0, T_BREACH_HIT);

    // camera: sink toward the floor as the Way opens (push), sweep on a
    // wider arc during strike (orbit), pull high to survey the ash (pull)
    const ang = orbit * 0.65 - 0.0;
    const baseX = Math.sin(ang) * 11.0 * (1 - pull) * (1 - conv * 0.8);
    const baseY = 5.4 - push * 1.8 + orbit * 1.9 + pull * 5.4 - creep * 0.6 - conv * 3.1;
    const baseZ = 26 - push * 5.5 - orbit * 3.0 + pull * 5.5 - creep * 1.5 - conv * 7.5;

    // ---------- handheld rig: scripted targets are damped, impacts are not
    const sh = U.shake.value;
    const swayX = Math.sin(t * 0.37) * 0.35 + Math.sin(t * 1.31) * 0.1;
    const swayY = Math.cos(t * 0.29) * 0.28;
    const n = (f: number) => (Math.sin(t * f * 9.1) + Math.sin(t * f * 13.7) * 0.5) * 0.5;
    const dampK = (l: number) => 1 - Math.exp(-l * dt);

    // position chases its target with mass — shake rides on top, unsmoothed
    this.posTarget.set(baseX + swayX, baseY + swayY, baseZ);
    this.camPosSm.lerp(this.posTarget, dampK(2.3));
    camera.position.copy(this.camPosSm);
    camera.position.x += n(1.7) * sh * 1.1;
    camera.position.y += n(2.3) * sh * 0.9;
    camera.position.z += n(1.3) * sh * 0.7;

    this.lookTarget.set(
      Math.sin(ang * 0.6) * 4 * (1 - conv) + this.mouseSm.x * 2.6 + swayX * 0.6 + n(2.9) * sh * 1.4,
      8.6 + push * 1.6 - orbit * 0.8 + conv * 2.0 - this.mouseSm.y * 1.8 + swayY * 0.5 + n(3.7) * sh,
      -15.5,
    );
    this.lookSm.lerp(this.lookTarget, dampK(3.0));
    camera.lookAt(this.lookSm);

    // organic roll — leans into sway, kicks during impacts
    const rollT = -swayX * 0.016 - this.mouseSm.x * 0.007 + n(1.1) * sh * 0.02 + conv * 0.035;
    this.rollSm += (rollT - this.rollSm) * dampK(3.6);
    camera.rotateZ(this.rollSm);

    // the lens breathes with the strike: impacts punch FOV out, the
    // convergence dolly widens it, slow-mo holds it there
    const fovT = 55 + U.flash.value * 5 - orbit * 2 + conv * 9 + Math.sin(t * 0.21) * 0.6;
    this.fovSm += (fovT - this.fovSm) * dampK(5);
    camera.fov = this.fovSm;
    camera.updateProjectionMatrix();

    // combat + strike housekeeping
    this.combat.update(t, dt);
    this.strike.update(t, dt, camera);
  }

  private lastBeatIdx = 0;
  private logBeats(pt: number) {
    const beats: [number, () => void][] = [
      [1.0, () => this.hud.log('UPLINK ESTABLISHED // TAC-FEED 04 LIVE')],
      [2.4, () => this.hud.log('THAUMIC SEAL INSCRIBING — 6-POINT / 8-POINT LATTICE')],
      [3.5, () => this.hud.log('KNOCK-PATTERN OVERRIDE ACCEPTED')],
      [6.0, () => this.hud.log('WAY SIGNATURE RISING — 0.04 M')],
      [8.2, () => this.hud.log('FIREBREAK-1 IN POSITION // LANCES HOT')],
      [9.8, () => this.hud.log('APERTURE EXPANDING — 焚书协议执行中')],
      [14.5, () => this.hud.log('WAY STABILIZED — STRIKE TEAM COMMITTED')],
      [19.0, () => this.hud.log('SERPENT COUNTER-ELEMENTS: NONE DETECTED')],
      [24.0, () => this.hud.log('INDEX DENIAL PASSED 40%')],
      [29.0, () => this.hud.log('THAUMIC FEEDBACK WITHIN TOLERANCE')],
      [33.6, () => this.hud.log('ALL ELEMENTS EXFIL — WAY COLLAPSING')],
      [36.5, () => this.hud.log('KTE-7909-ALEXANDRIA: NEUTRALIZED')],
      [40.0, () => this.hud.log('FEED LOOP ARMS IN 4…3…2…')],
    ];
    if (pt < this.lastBeatIdx) this.lastBeatIdx = 0;
    for (const [bt, fn] of beats) {
      if (pt >= bt && this.lastBeatIdx < bt) { fn(); this.lastBeatIdx = bt; }
    }
  }
}
