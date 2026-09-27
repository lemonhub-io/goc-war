// director.ts — the strike timeline: phases, camera rig, shake, event schedule
import * as THREE from 'three/webgpu';
import { U } from './shared';
import type { Combat } from './combat';
import type { Hud } from './hud';
import type { Synth } from './audio';

export const LOOP = 44;

// phase boundaries within the loop
const T_BREACH_HIT = 9.4;
const T_BREACH_DONE = 15.0;
const T_STRIKE_END = 33.0;
const T_END = LOOP;

const VOLLEYS = [16.4, 18.1, 20.4, 22.2, 24.6, 26.8, 28.7, 30.5, 31.9];

function seg(t: number, a: number, b: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

export class Director {
  private combat: Combat;
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
  private resetFired = false;
  private elapsed = 0;

  constructor(combat: Combat, hud: Hud, audio: Synth) {
    this.combat = combat; this.hud = hud; this.audio = audio;
    window.addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2);
    });
  }

  get phaseTime(): number { return this.elapsed % LOOP; }
  get phaseIndex(): number {
    const t = this.phaseTime;
    return t < T_BREACH_HIT ? 0 : t < T_BREACH_DONE ? 1 : t < T_STRIKE_END ? 2 : 3;
  }

  update(t: number, dt: number, camera: THREE.PerspectiveCamera) {
    this.elapsed = t;
    const pt = this.phaseTime;

    // ---------- global uniforms
    U.time.value = t;
    U.breach.value = Math.pow(seg(pt, T_BREACH_HIT - 1.2, T_BREACH_DONE), 0.8);   // fast tear, slow saturate
    U.strike.value = Math.pow(seg(pt, T_BREACH_DONE - 1.5, T_BREACH_DONE + 2.0), 1.4); // snapped commitment
    U.inferno.value = Math.min(1, seg(pt, 15, 34) * 1.15 + seg(pt, 38, 43) * 0.05);
    U.shake.value *= Math.exp(-dt * 3.0);
    U.flash.value *= Math.exp(-dt * 4.5);
    U.caBoost.value *= Math.exp(-dt * 3.4);
    U.exposure.value = 1 + U.breach.value * 0.5 + U.flash.value * 0.8;

    // ---------- events
    if (pt < 2) { // loop restarted
      if (this.resetFired) {
        this.resetFired = false;
        this.volleyIdx = 0;
        this.volleyJitter = VOLLEYS.map(() => (Math.random() - 0.5) * 0.55);
        this.breachFired = false;
        this.breachDoneFired = false;
        this.hud.feedReset();
      }
    }
    if (!this.breachFired && pt >= T_BREACH_HIT) {
      this.breachFired = true;
      this.combat.breachBlast(t);
      this.hud.log('WAY BREACH CONFIRMED — APERTURE 0.0 → 7.4 M');
    }
    // secondary accent when the aperture finishes opening — a settle thump
    if (!this.breachDoneFired && pt >= T_BREACH_DONE) {
      this.breachDoneFired = true;
      U.shake.value += 0.35;
      U.flash.value = Math.max(U.flash.value, 0.3);
      this.audio.boom(0.5);
    }
    while (this.volleyIdx < VOLLEYS.length && pt >= VOLLEYS[this.volleyIdx] + this.volleyJitter[this.volleyIdx]) {
      this.combat.fireVolley(t);
      this.volleyIdx++;
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
      if (ph === 3) this.hud.log('SEARING IN EFFECT — LIBRARY DENIED');
      if (ph === 2) { this.audio.klaxon(); this.hud.log('FIREBREAK ELEMENTS THROUGH — WEAPONS FREE'); }
    }

    // ---------- camera
    this.mouseSm.lerp(this.mouse, Math.min(1, dt * 3));
    const orbit = seg(pt, T_BREACH_DONE, T_STRIKE_END);
    const pull = seg(pt, T_STRIKE_END - 1, T_END - 1);
    const push = seg(pt, T_BREACH_HIT - 1, T_BREACH_DONE);

    const ang = orbit * 0.5 - 0.0;             // sweep right during strike
    const baseX = Math.sin(ang) * 9.0 * (1 - pull);
    const baseY = 4.6 + push * 1.1 + orbit * 1.8 + pull * 5.2;
    const baseZ = 26 - push * 5.5 - orbit * 3.0 + pull * 5.5;

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
      Math.sin(ang * 0.6) * 4 + this.mouseSm.x * 2.6 + swayX * 0.6 + n(2.9) * sh * 1.4,
      8.6 + push * 1.6 - orbit * 0.8 - this.mouseSm.y * 1.8 + swayY * 0.5 + n(3.7) * sh,
      -15.5,
    );
    this.lookSm.lerp(this.lookTarget, dampK(3.0));
    camera.lookAt(this.lookSm);

    // organic roll — leans into sway, kicks during impacts
    const rollT = -swayX * 0.016 - this.mouseSm.x * 0.007 + n(1.1) * sh * 0.02;
    this.rollSm += (rollT - this.rollSm) * dampK(3.6);
    camera.rotateZ(this.rollSm);

    const fovT = 55 + U.flash.value * 4 - orbit * 2 + Math.sin(t * 0.21) * 0.6;
    this.fovSm += (fovT - this.fovSm) * dampK(5);
    camera.fov = this.fovSm;
    camera.updateProjectionMatrix();

    // combat housekeeping
    this.combat.update(t, dt);
  }

  private lastBeatIdx = 0;
  private logBeats(pt: number) {
    const beats: [number, () => void][] = [
      [1.0, () => this.hud.log('UPLINK ESTABLISHED // TAC-FEED 04 LIVE')],
      [3.5, () => this.hud.log('KNOCK-PATTERN OVERRIDE ACCEPTED')],
      [6.0, () => this.hud.log('WAY SIGNATURE RISING — 0.04 M')],
      [8.2, () => this.hud.log('FIREBREAK-1 IN POSITION // LANCES HOT')],
      [9.8, () => this.hud.log('APERTURE EXPANDING — 焚书协议执行中')],
      [14.5, () => this.hud.log('WAY STABILIZED — STRIKE TEAM COMMITTED')],
      [19.0, () => this.hud.log('SERPENT COUNTER-ELEMENTS: NONE DETECTED')],
      [24.0, () => this.hud.log('CATALOGUE DENIAL PASSED 40%')],
      [29.0, () => this.hud.log('THAUMIC FEEDBACK WITHIN TOLERANCE')],
      [33.5, () => this.hud.log('ALL ELEMENTS EXFIL — SEALING WAY')],
      [36.0, () => this.hud.log('KTE-7909-ALEXANDRIA: NEUTRALIZED')],
      [40.0, () => this.hud.log('FEED LOOP ARMS IN 4…3…2…')],
    ];
    if (pt < this.lastBeatIdx) this.lastBeatIdx = 0;
    for (const [bt, fn] of beats) {
      if (pt >= bt && this.lastBeatIdx < bt) { fn(); this.lastBeatIdx = bt; }
    }
  }
}
