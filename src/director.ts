// director.ts — the orbital strike timeline, camera rig, shot cuts and the
// operator's trigger.
//
//   0.0 ─  7.4  ACQUIRE    platform slews onto the target, lock rings close      (hold: slew ×3)
//   7.4 ─ 13.2  CHARGE     OPERATOR: holding the trigger fills the coil stack, the
//                          camera pushes in with it; let go and the charge bleeds back
//      ─ ─ ─ ─  OVERCHARGE keep holding past 100%: release inside the sweet window
//                          for a PERFECT strike, hold too long and the stack vents
//  13.2 ─ 17.2  RELEASE    coil pulse, rod leaves the muzzle, re-entry (orbit cam)
//  17.2 ─ 20.9  DESCENT    rod-cam through the cloud decks (ground world)
//  20.9 ─ 28.0  IMPACT     whiteout, shock, mushroom — sized by the earned yield (drag to survey)
//  28.0 ─ 42.0  AFTERMATH  back to orbit: the scar glows on the night side       (hold: next strike ×4)
//
// Every effect is still a pure function of the phase clock `pt` (plus uniforms
// derived from it); the operator only decides how `pt` crosses the CHARGE
// segment. With `interactive = false` (?freeze captures, ?auto kiosk) the clock
// is plain loop time again, so seeking and stills stay deterministic.
import * as THREE from 'three/webgpu';
import {
  U, TARGET_POS, EARTH_C, ER, SUN_DIR, MUZZLE_LOCAL, TWO_PI, isScreenYDown,
} from './shared';
import type { Platform } from './platform';
import type { Rod, Beam } from './rod';
import type { Ground } from './ground';
import type { Hud, HudState, Ctl } from './hud';
import type { Synth } from './audio';

export const LOOP = 42;

const T_AIM0 = 1.6, T_AIM1 = 6.8;
const T_LOCK0 = 2.6, T_LOCK1 = 7.2;
const T_DESIG = 8.2;
const T_CHG0 = 7.4, T_FIRE = 13.2;
const T_LAUNCH = 13.55;
const T_ENTRY = 16.9;
const T_CUT1 = 17.2;
const T_IMPACT = 20.9;
const T_WIDE_END = 28.0;
const T_END = LOOP;

/** seconds of held trigger from an empty stack to full */
const CHARGE_TIME = 3.0;
/** fraction of a full stack bled per second while the trigger is up */
const LEAK = 0.4;
/** seconds of overcharge before the stack vents on its own */
const OVER_TIME = 1.7;
/** overcharge window that earns a PERFECT release */
const SWEET0 = 0.6, SWEET1 = 0.82;
/** yield of a nominal strike (kt) — the release grade scales it */
const BASE_KT = 11.4;

export type Grade = 'NOMINAL' | 'PERFECT' | 'HOT' | 'OVERLOAD';
const GRADE_TXT: Record<Grade, string> = {
  NOMINAL: 'NOMINAL RELEASE', PERFECT: 'PERFECT RELEASE', HOT: 'HOT RELEASE', OVERLOAD: 'OVERLOAD VENT',
};

type Mode = 'acquire' | 'gate' | 'over' | 'run';

function seg(t: number, a: number, b: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
/** exp(-k·x) for x ≥ 0, 0 before */
const decay = (x: number, k: number) => (x < 0 ? 0 : Math.exp(-x * k));
const wrap = (t: number) => ((t % LOOP) + LOOP) % LOOP;
/** haptic tick where supported (Android); silently absent elsewhere */
const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* unsupported */ } };

export interface World {
  orbit: THREE.Group;
  ground: Ground;
  platform: Platform;
  rodOrbit: Rod;
  rodGround: Rod;
  designator: Beam;
  sky: THREE.Mesh;
}

// ---- fixed geometry of the shot ------------------------------------------------
const AIM_DIR = TARGET_POS.clone().normalize();                       // barrel axis passes through the origin
const Q_AIM = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), AIM_DIR);
const M0 = AIM_DIR.clone().multiplyScalar(-MUZZLE_LOCAL.y);            // muzzle, platform at rest on target
const Y_UP = new THREE.Vector3(0, 1, 0);

/** distance along the rod path where it crosses the atmosphere shell */
const S_ENTRY = (() => {
  const Ra = ER * 1.034;
  const oc = M0.clone().sub(EARTH_C);
  const b = oc.dot(AIM_DIR);
  const c = oc.lengthSq() - Ra * Ra;
  return -b - Math.sqrt(b * b - c);
})();
const ENTRY_POS = M0.clone().addScaledVector(AIM_DIR, S_ENTRY);

/** rod distance from the muzzle at loop time pt */
function rodS(pt: number): number {
  const u = (pt - T_LAUNCH) / (T_ENTRY - T_LAUNCH);
  if (u <= 0) return 0;
  if (u <= 1) return S_ENTRY * Math.pow(u, 2.1);
  const vE = (S_ENTRY * 2.1) / (T_ENTRY - T_LAUNCH);
  return S_ENTRY + vE * (pt - T_ENTRY);
}

// ground-world descent
const DESC_DIR = new THREE.Vector3(0.16, -1, -0.1).normalize();
const DESC_H = 720;
const rodGroundPos = (u: number, out: THREE.Vector3) =>
  out.copy(DESC_DIR).multiplyScalar(-DESC_H * (1 - Math.pow(u, 2.2)));

const BEATS: [number, string][] = [
  [0.8, 'UPLINK ESTABLISHED // TAC-FEED 04 LIVE'],
  [2.2, 'AEGIS-7 SLEWING — TARGET KTE-7909 ACQUIRED'],
  [4.6, 'ORBITAL FIX: 400 KM // INCLINATION 97.4°'],
  [6.4, 'GROUND LOCK STABLE — CEP < 4 M'],
  [7.45, 'RELEASE AUTHORITY HANDED TO OPERATOR'],
  [8.2, 'DESIGNATOR PAINTING TARGET'],
  [9.6, 'COIL STACK 1–10 CHARGING'],
  [11.6, 'CAPACITORS NEAR FULL'],
  [13.9, 'ROD CLEAR OF THE BORE // 11.8 KM/S TERMINAL'],
  [16.4, 'ATMOSPHERIC INTERFACE — PLASMA SHEATH'],
  [19.2, 'ROD-CAM: ALTITUDE FALLING THROUGH 30 KM'],
  [21.4, 'IMPACT CONFIRMED — GROUND ZERO KTE-7909'],
  [24.5, 'SHOCKFRONT CLEARING OUTLYING ELEMENTS'],
  [29.0, 'BDA: TARGET FILE DENIED — NO SURVIVORS DETECTED'],
  [34.0, 'AEGIS-7 CAPACITORS DISCHARGED // COOLING'],
  [39.6, 'FEED LOOP ARMS IN 4…3…2…'],
];

interface Shot { pos: THREE.Vector3; look: THREE.Vector3; fov: number; roll: number; id: number; rate: number }

export class Director {
  private w: World;
  private hud: Hud;
  private audio: Synth;
  private camPosSm = new THREE.Vector3(-92, 24, 108);
  private lookSm = new THREE.Vector3(-6, -52, 0);
  private rollSm = 0;
  private fovSm = 52;
  private lastShot = -1;
  private mouse = new THREE.Vector2();
  private mouseSm = new THREE.Vector2();
  private shot: Shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 52, roll: 0, id: 0, rate: 2.3 };
  private tsSm = 1;
  private resetFired = false;
  private lastPhase = -1;
  private lastBeat = -1;
  private beatCycle = -1;
  private fired = new Set<string>();
  private snap = true;
  private rodPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private qV = new THREE.Vector3();
  private qKick = new THREE.Quaternion();
  private eKick = new THREE.Euler();

  // ---- phase clock + operator state
  private pt = 0;
  private prevPt = 0;
  private lastT = 0;
  private primed = false;
  private cycle = 0;
  private mode: Mode = 'acquire';
  /** 0..1 position through the CHARGE segment (the stack level) */
  private chg = 0;
  /** 0..1 overcharge past a full stack */
  private over = 0;
  private overVis = 0;
  private sweetHit = false;
  private alarmPh = 0;
  private idle = 0;
  private auto = false;
  private autoShot = false;
  private everHeld = false;
  private ptrDown = false;
  private keyDown = false;
  private dragged = false;
  private ffOn = false;
  private hitstop = 0;
  private invertT = 0;
  private grade: Grade = 'NOMINAL';
  private yk = 1;
  private strikeNo = 0;
  // drag look-around (radians), target + smoothed
  private yawU = 0;
  private pitchU = 0;
  private yawSm = 0;
  private pitchSm = 0;
  private readonly holdHint: string;

  /** false: the clock is plain loop time and the trigger is ignored (captures / kiosk) */
  interactive = true;
  /** debug: ?cam=px,py,pz,lx,ly,lz[,fov] replaces the scripted camera (orbit world) */
  camOverride: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  hudState: HudState = { capacitor: 0, velocity: 0, altitude: 400, yieldKt: 0, integrity: 100 };

  constructor(world: World, hud: Hud, audio: Synth) {
    this.w = world; this.hud = hud; this.audio = audio;
    this.holdHint = matchMedia('(pointer: coarse)').matches ? 'PRESS AND HOLD ANYWHERE' : 'HOLD MOUSE OR SPACE';
    addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2);
    });
  }

  get phaseTime(): number { return this.pt; }
  get phaseIndex(): number {
    const t = this.pt;
    return t < T_CHG0 ? 0 : t < T_FIRE ? 1 : t < T_WIDE_END ? 2 : 3;
  }
  /** simulation speed the render loop should advance by (slow-mo around the hits, fast-forward on hold) */
  get timeScale(): number { return this.tsSm; }
  /** next update places the camera exactly (no damping) — used after a seek */
  snapNext() { this.snap = true; }

  // ------------------------------------------------------------------ operator input
  //
  // One trigger for everything: press-and-hold (pointer, Space, Enter) charges at
  // the gate and fast-forwards toward the next charge elsewhere. A pointer that
  // travels becomes a drag: it orbits the camera instead of fast-forwarding
  // (at the gate it keeps charging — the thumb is still on the trigger).

  press(src: 'ptr' | 'key') {
    if (src === 'ptr') { this.ptrDown = true; this.dragged = false; } else this.keyDown = true;
    this.everHeld = true; this.auto = false; this.idle = 0;
  }
  lift(src: 'ptr' | 'key') {
    if (src === 'ptr') { this.ptrDown = false; this.dragged = false; } else this.keyDown = false;
  }
  liftAll() { this.ptrDown = false; this.keyDown = false; this.dragged = false; }
  /** pointer moved by (dx, dy) px while pressed, `travel` px from the press point */
  drag(dx: number, dy: number, travel: number) {
    if (!this.ptrDown) return;
    if (!this.dragged && travel > 12) this.dragged = true;
    if (!this.dragged) return;
    this.yawU = THREE.MathUtils.clamp(this.yawU - dx * 0.0055, -1.1, 1.1);
    this.pitchU = THREE.MathUtils.clamp(this.pitchU + dy * 0.004, -0.4, 0.45);
  }

  private trigger(): boolean {
    if (this.auto) return true;
    const charging = this.mode === 'gate' || this.mode === 'over';
    return this.keyDown || (this.ptrDown && (charging || !this.dragged));
  }
  private get autoAfter(): number { return this.everHeld ? 16 : 8; }

  /** move the phase clock: free-running outside the CHARGE segment, operator-driven inside it */
  private advance(dT: number, dt: number) {
    const trig = this.trigger();
    switch (this.mode) {
      case 'acquire':
        this.pt += dT;
        if (this.pt >= T_CHG0) {
          this.pt = T_CHG0; this.mode = 'gate';
          this.chg = 0; this.over = 0; this.idle = 0;
        }
        break;
      case 'gate':
        if (trig) { this.chg += dt / CHARGE_TIME; this.idle = 0; }
        else { this.chg = Math.max(0, this.chg - dt * LEAK); this.idle += dt; }
        if (!this.auto && this.idle > this.autoAfter) this.auto = true;
        if (this.chg >= 1) {
          this.chg = 1; this.mode = 'over'; this.over = 0; this.sweetHit = false; this.alarmPh = 0;
          this.audio.warn(0);
          this.hud.log('STACK FULL  OVERCHARGE ARMED');
        }
        this.pt = T_CHG0 + this.chg * (T_FIRE - T_CHG0 - 1e-3);
        break;
      case 'over':
        this.pt = T_FIRE - 1e-3;
        if (this.auto) { this.release(0); break; }
        if (trig) {
          this.over += dt / OVER_TIME;
          if (!this.sweetHit && this.over >= SWEET0) {
            this.sweetHit = true; this.audio.sweet(); buzz(14);
          }
          if (this.over >= 1) this.release(1);
        } else this.release(this.over);
        break;
      case 'run':
        this.pt += dT;
        if (this.pt >= LOOP) { this.pt -= LOOP; this.mode = 'acquire'; }
        break;
    }
  }

  /** the trigger came up past a full stack: grade the timing, fire */
  private release(over: number) {
    let g: Grade, yk: number;
    if (over >= 1) { g = 'OVERLOAD'; yk = 0.75; }
    else if (over >= SWEET0 && over < SWEET1) { g = 'PERFECT'; yk = 1.6; }
    else if (over >= SWEET1) { g = 'HOT'; yk = 1.15; }
    else { g = 'NOMINAL'; yk = 1 + 0.25 * (over / SWEET0); }
    this.grade = g; this.yk = yk; U.yieldK.value = yk;
    this.autoShot = this.auto; this.auto = false;
    this.mode = 'run'; this.pt = T_FIRE;
    this.strikeNo++;
    this.hud.log(`${this.autoShot ? 'AUTOPILOT RELEASE' : GRADE_TXT[g]}  YIELD ×${yk.toFixed(2)}`);
    if (g === 'PERFECT') {
      // freeze-frame on the perfect release: the hit lands, then everything moves
      this.hitstop = 0.16; this.invertT = 0.05;
      this.audio.perfect(); this.hud.flash('small');
      if (this.everHeld) buzz([18, 40, 70]);
    } else if (g === 'OVERLOAD') {
      this.audio.vent(); this.hud.feedGlitch();
      if (this.everHeld) buzz([90, 30, 90]);
    } else if (this.everHeld && !this.autoShot) buzz(35);
  }

  // ------------------------------------------------------------------ shots

  private computeShot(pt: number, t: number): Shot {
    const s = this.shot;
    const sway = (f: number, a: number) => Math.sin(t * f) * a;
    if (pt < T_CUT1) {
      // ---- orbit, before the cut (B follows the operator's charge)
      const A = seg(pt, 0, T_CHG0), B = seg(pt, T_CHG0, T_FIRE);
      s.pos.set(-92, 24, 108).lerp(this.tmp.set(-64, 8, 82), A).lerp(this.tmp2.set(-34, -16, 54), B);
      s.look.set(-6, -52, 0).lerp(this.tmp.set(-4, -34, 0), A).lerp(this.tmp2.set(2, -24, 0), B);
      s.fov = 52 - 7 * B;
      const pull = seg(pt, T_FIRE, T_FIRE + 0.9);
      s.pos.lerp(this.tmp.set(-52, -22, 74), pull);
      s.fov += 4 * pull;
      // chase the rod once it clears the muzzle
      const wF = seg(pt, T_LAUNCH - 0.1, T_LAUNCH + 1.1);
      if (wF > 0) {
        this.tmp.copy(this.rodPos).add(this.tmp2.set(-17, 7, 26));
        s.pos.lerp(this.tmp, wF);
        this.tmp.copy(this.rodPos).addScaledVector(AIM_DIR, 16);
        s.look.lerp(this.tmp, wF);
        s.fov = THREE.MathUtils.lerp(s.fov, 50, wF);
      }
      s.roll = sway(0.31, 0.012);
      s.id = 0; s.rate = 2.3;
    } else if (pt < T_IMPACT) {
      // ---- ground world: rod-cam. Starts above-behind (the cloud decks rushing up),
      // swings out to a side-on chase so the horizon and the streak read together
      const u = (pt - T_CUT1) / (T_IMPACT - T_CUT1);
      rodGroundPos(u, this.rodPos);
      const f = DESC_DIR;
      const sv = this.tmp2.set(1, 0, 0).cross(f).normalize();     // horizontal, ⟂ travel
      const wS = seg(u, 0.12, 0.62);
      this.tmp.copy(f).multiplyScalar(-46).add(this.qV.set(15, 5, -13));
      this.qV.copy(f).multiplyScalar(-20).addScaledVector(sv, 150);
      this.tmp.lerp(this.qV, wS);
      s.pos.copy(this.rodPos).add(this.tmp);
      s.pos.y = Math.max(s.pos.y, 14);
      s.look.copy(this.rodPos).addScaledVector(f, 70 * (1 - wS) + 14 * wS);
      s.look.lerp(this.qV.set(0, 14, 0), seg(u, 0.8, 1.0) * 0.6);
      s.fov = 58 + 14 * u * u;
      s.roll = 0.12 * Math.sin(u * 2.4) + sway(2.1, 0.012) * (0.3 + u);
      s.id = 1; s.rate = 9;
    } else if (pt < T_WIDE_END) {
      // ---- ground world: wide impact cam — low and close so the column towers
      const k = pt - T_IMPACT;
      const th = 0.45 + 0.05 * k;
      const R = 168 - 5 * Math.min(k, 3);
      s.pos.set(Math.sin(th) * R, 9 + 0.7 * k, Math.cos(th) * R);
      s.look.set(0, Math.min(72, 22 + k * 4.2), 0);
      s.fov = 50 - 4 * seg(pt, T_IMPACT, T_WIDE_END);
      s.roll = sway(0.23, 0.01);
      s.id = 2; s.rate = 3.2;
    } else {
      // ---- orbit return: the scar on the night side
      const k = seg(pt, T_WIDE_END, T_END);
      s.pos.set(-62, -10, 112).lerp(this.tmp.set(-100, 8, 128), k);
      s.look.set(-22, -48, -10);
      s.fov = 50 - 4 * k;
      s.roll = sway(0.27, 0.01) - 0.02;
      s.id = 3; s.rate = 2.0;
    }
    return s;
  }

  // ------------------------------------------------------------------ update

  update(t: number, dt: number, camera: THREE.PerspectiveCamera) {
    if (!this.primed) {
      this.primed = true; this.lastT = t;
      this.pt = this.prevPt = wrap(t);
      this.mode = this.pt < T_CHG0 ? 'acquire' : this.pt < T_FIRE ? 'gate' : 'run';
      this.chg = THREE.MathUtils.clamp((this.pt - T_CHG0) / (T_FIRE - T_CHG0), 0, 1);
    }
    const dT = Math.max(0, t - this.lastT);
    this.lastT = t;
    if (this.interactive) this.advance(dT, dt);
    else {
      this.pt = wrap(t);
      this.mode = this.pt < T_CHG0 ? 'acquire' : this.pt < T_FIRE ? 'gate' : 'run';
    }
    const pt = this.pt;
    if (pt + LOOP * 0.5 < this.prevPt) this.cycle++;
    this.prevPt = pt;
    const cycleStart = t - pt;
    const w = this.w;

    // ---------- time dilation: the hits land in slow motion, a held trigger skips the waiting
    const bump = seg(pt, T_IMPACT - 0.25, T_IMPACT + 0.05) * (1 - seg(pt, T_IMPACT + 0.6, T_IMPACT + 1.8));
    const bumpF = seg(pt, T_FIRE + 0.15, T_FIRE + 0.4) * (1 - seg(pt, T_FIRE + 0.7, T_FIRE + 1.2));
    let tsTarget = 1 - 0.78 * bump - 0.42 * bumpF;
    this.ffOn = this.interactive && !this.auto && this.trigger()
      && (this.mode === 'acquire' || (this.mode === 'run' && pt > T_WIDE_END + 2.5));
    if (this.ffOn) tsTarget *= this.mode === 'acquire' ? 3 : 4;
    this.tsSm += (tsTarget - this.tsSm) * Math.min(1, dt * (tsTarget < this.tsSm ? 40 : 7));
    if (this.hitstop > 0) { this.hitstop -= dt; this.tsSm = 0.03; }

    // ---------- world visibility (cuts between the orbit and ground worlds)
    const inOrbit = pt < T_CUT1 || pt >= T_WIDE_END;
    w.orbit.visible = inOrbit;
    w.ground.group.visible = !inOrbit;

    // ---------- timeline-derived uniforms
    U.time.value = t;
    U.tFire.value = cycleStart + T_FIRE;
    U.tImpact.value = cycleStart + T_IMPACT;
    const age = pt - T_IMPACT;
    const yk = this.interactive ? this.yk : 1;
    U.yieldK.value = yk;

    U.lock.value = seg(pt, T_LOCK0, T_LOCK1);
    U.designator.value = seg(pt, T_DESIG, T_DESIG + 0.8) * (1 - seg(pt, T_LAUNCH, T_LAUNCH + 0.25));
    U.charge.value = Math.pow(seg(pt, T_CHG0, T_FIRE), 1.15) * (1 - seg(pt, T_FIRE + 0.25, T_FIRE + 0.5));
    const tf = pt - (T_FIRE + 0.3);
    U.muzzle.value = tf < 0 ? 0.55 * seg(pt, T_FIRE, T_FIRE + 0.3) : decay(tf, 4.2);
    U.heat.value = tf < 0 ? 0 : decay(tf, 0.2);
    U.reentry.value = seg(pt, T_ENTRY - 1.2, T_ENTRY + 0.3) * (1 - seg(pt, T_IMPACT, T_IMPACT + 0.15));
    U.fire.value = age < 0 ? 0 : seg(age, 0, 0.7) * (0.45 + 0.55 * decay(age, 0.12)) * (1 - seg(pt, 38.5, 41.8)) * (0.8 + 0.2 * yk);

    // overcharge: the stack's strain, plus an alarm whose pulse rate climbs toward the vent
    const ovTarget = this.mode === 'over' ? this.over : 0;
    this.overVis = ovTarget >= this.overVis ? ovTarget : this.overVis * Math.exp(-dt * 5);
    U.over.value = this.overVis;
    if (this.mode === 'over') {
      const beat = Math.floor(this.alarmPh);
      this.alarmPh += dt * (1.2 + 4.6 * this.over);
      if (Math.floor(this.alarmPh) !== beat) this.audio.warn(this.over);
    }
    U.alarm.value = this.overVis * (0.5 + 0.5 * Math.cos(this.alarmPh * TWO_PI));

    // flash / shake / aberration envelopes (stateless sums of impulses)
    U.flash.value = Math.max(
      0.85 * decay(tf, 5.5),
      0.3 * decay(pt - (T_ENTRY + 0.1), 6),
      pt < T_IMPACT ? seg(pt, T_IMPACT - 0.3, T_IMPACT) : decay(age, 1.7),
    );
    const uDesc = THREE.MathUtils.clamp((pt - T_CUT1) / (T_IMPACT - T_CUT1), 0, 1);
    U.shake.value = Math.max(
      1.1 * decay(tf, 2.6),
      0.3 * seg(pt, T_ENTRY - 1.0, T_ENTRY),
      pt >= T_CUT1 && pt < T_IMPACT ? 0.2 + 0.9 * uDesc * uDesc : 0,
      (1.7 * decay(age, 1.5) + 0.2 * decay(age, 0.2)) * yk,
      0.6 * this.overVis * this.overVis,
    );
    U.caBoost.value = Math.max(0.9 * decay(tf, 3), 1.5 * decay(age, 2.2) * yk, 0.4 * U.shake.value, 0.8 * this.overVis);
    U.exposure.value = 1 + U.flash.value * 0.8;
    if (this.invertT > 0) this.invertT -= dt;
    U.invert.value = this.invertT > 0 ? 1 : 0;

    // ---------- one-shot cues (audio / hud)
    this.cues(pt);
    if (pt < 2 && this.resetFired) { this.resetFired = false; this.fired.clear(); this.hud.feedReset(); }
    if (pt > T_END - 0.5 && !this.resetFired) { this.resetFired = true; this.hud.feedGlitch(); }
    const ph = this.phaseIndex;
    if (ph !== this.lastPhase) { this.lastPhase = ph; this.hud.setPhase(ph); }
    this.logBeats(pt);

    // ---------- platform
    const aimK = seg(pt, T_AIM0, T_AIM1);
    const q = w.platform.group.quaternion;
    q.identity().slerp(Q_AIM, aimK);
    // slow free-drift of the station + a pitch kick from the shot
    this.eKick.set(0.012 * Math.sin(t * 0.21) + 0.03 * decay(tf, 2.4) * Math.sin(tf * 13), 0.012 * Math.sin(t * 0.17), 0.01 * Math.sin(t * 0.13));
    q.multiply(this.qKick.setFromEuler(this.eKick));
    const recoilT = pt - (T_FIRE + 0.32);
    const recoil = recoilT < 0 ? 0 : 2.8 * yk * decay(recoilT, 2.4) * Math.cos(recoilT * 2.6);
    w.platform.update({ t, charge: U.charge.value, over: this.overVis, sinceFire: pt - T_FIRE, recoil });
    w.platform.group.updateMatrixWorld(true);

    // ---------- designator + rod
    const dOn = U.designator.value > 0.01 && inOrbit;
    if (dOn) w.designator.set(w.platform.muzzleWorld(this.tmp), TARGET_POS, 0.13);
    else w.designator.mesh.visible = false;

    const s = rodS(pt);
    this.rodPos.copy(M0).addScaledVector(AIM_DIR, s);
    U.entryPos.value.copy(ENTRY_POS);
    if (pt >= T_LAUNCH && pt < T_CUT1) w.rodOrbit.place(this.rodPos, AIM_DIR, Math.min(70, 6 + s * 1.15));
    else w.rodOrbit.group.visible = false;

    if (pt >= T_CUT1 && pt < T_IMPACT) {
      rodGroundPos(uDesc, this.tmp2);
      U.rodPosG.value.copy(this.tmp2);
      w.rodGround.place(this.tmp2, DESC_DIR, 120);
      this.rodPos.copy(this.tmp2);        // (shot code reads rodPos)
    } else {
      w.rodGround.group.visible = false;
      U.rodPosG.value.set(0, 1e4, 0);
    }

    // ---------- camera
    this.mouseSm.lerp(this.mouse, Math.min(1, dt * 3));
    const sh = this.computeShot(pt, t);
    sh.fov -= 6 * this.overVis;           // overcharge tension: the lens creeps in on the barrel
    if (this.camOverride) { sh.pos.copy(this.camOverride.pos); sh.look.copy(this.camOverride.look); sh.fov = this.camOverride.fov; sh.roll = 0; sh.id = 99; }
    const dampK = (l: number) => 1 - Math.exp(-l * dt);
    const cut = this.snap || sh.id !== this.lastShot;
    if (cut) {
      this.camPosSm.copy(sh.pos); this.lookSm.copy(sh.look);
      this.fovSm = sh.fov; this.rollSm = sh.roll;
      this.lastShot = sh.id; this.snap = false;
    } else {
      this.camPosSm.lerp(sh.pos, dampK(sh.rate));
      this.lookSm.lerp(sh.look, dampK(sh.rate * 1.3));
      this.fovSm += (sh.fov - this.fovSm) * dampK(5);
      this.rollSm += (sh.roll - this.rollSm) * dampK(3.6);
    }

    // operator look-around: a drag orbits the camera about its look point and
    // springs home once let go, so the scripted framing always comes back
    const lookOK = sh.id !== 1 && sh.id !== 99;
    if (!lookOK) { this.yawU = this.pitchU = this.yawSm = this.pitchSm = 0; }
    if (!(this.ptrDown && this.dragged)) { const k = Math.exp(-dt * 1.3); this.yawU *= k; this.pitchU *= k; }
    this.yawSm += (this.yawU - this.yawSm) * dampK(9);
    this.pitchSm += (this.pitchU - this.pitchSm) * dampK(9);
    camera.position.copy(this.camPosSm);
    if (lookOK && (Math.abs(this.yawSm) > 1e-4 || Math.abs(this.pitchSm) > 1e-4)) {
      const off = this.tmp.copy(this.camPosSm).sub(this.lookSm).applyAxisAngle(Y_UP, this.yawSm);
      const right = this.tmp2.copy(off).cross(Y_UP);
      if (right.lengthSq() > 1e-6) off.applyAxisAngle(right.normalize(), this.pitchSm);
      camera.position.copy(this.lookSm).add(off);
      if (!inOrbit) camera.position.y = Math.max(camera.position.y, 4);
    }

    const shk = U.shake.value;
    const n = (f: number) => (Math.sin(t * f * 9.1) + Math.sin(t * f * 13.7) * 0.5) * 0.5;
    const shkScale = sh.id === 1 ? 0.6 : sh.id === 2 ? 1.3 : 1.0;
    camera.position.x += n(1.7) * shk * 0.9 * shkScale + this.mouseSm.x * (sh.id === 2 ? 3 : 0.8);
    camera.position.y += n(2.3) * shk * 0.7 * shkScale - this.mouseSm.y * (sh.id === 2 ? 2 : 0.5);
    camera.position.z += n(1.3) * shk * 0.5 * shkScale;
    camera.lookAt(this.lookSm.x + n(2.9) * shk * 0.6, this.lookSm.y + n(3.7) * shk * 0.5, this.lookSm.z);
    camera.rotateZ(this.rollSm + n(1.1) * shk * 0.012);
    camera.fov = this.fovSm + U.flash.value * 3;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // keep skies centred on the camera (no parallax)
    w.sky.position.copy(camera.position);
    w.ground.follow(camera);

    // ---------- screen-space: shockwaves + light-source rays
    this.screenFx(pt, camera, inOrbit, yk);

    // ---------- hud numbers + the operator gauge
    const hs = this.hudState;
    hs.capacitor = U.charge.value * 4800 + this.overVis * 1500;
    const p = THREE.MathUtils.clamp((pt - T_LAUNCH) / (T_IMPACT - T_LAUNCH), 0, 1);
    hs.velocity = pt < T_LAUNCH ? 0 : 11.8 * Math.min(1, Math.pow(p, 0.5)) * (age > 0 ? 0 : 1);
    hs.altitude = age > 0 ? 0 : pt < T_LAUNCH ? 400 : 400 * (1 - Math.pow(p, 2.0));
    hs.yieldKt = age > 0 ? BASE_KT * yk * (1 - Math.exp(-age * 5)) : 0;
    hs.integrity = age > 0 ? 100 * Math.exp(-age * 0.9 * yk) : 100;
    this.hud.control(this.ctl());
  }

  // ------------------------------------------------------------------ operator gauge

  private ctlState: Ctl = { charge: 0, over: 0, main: '', sub: '', state: '', ring: false };
  private ctl(): Ctl | null {
    if (!this.interactive) return null;
    const c = this.ctlState, pt = this.pt;
    c.over = 0; c.main = ''; c.ring = true;
    switch (this.mode) {
      case 'acquire':
        c.charge = U.lock.value; c.state = 'hint';
        c.main = 'ACQUIRING TARGET';
        c.sub = this.ffOn ? 'SLEWING ×3' : 'HOLD TO SLEW FASTER';
        return c;
      case 'gate': {
        const trig = this.trigger();
        c.charge = this.chg;
        c.state = trig ? 'charging' : 'idle';
        c.main = trig ? `CHARGING ${Math.floor(this.chg * 100)}%` : 'HOLD TO CHARGE';
        c.sub = this.auto ? 'AUTOPILOT CHARGING'
          : trig ? 'RELEASE PAST FULL TO FIRE'
          : this.idle > this.autoAfter - 3 ? `AUTOPILOT IN ${Math.ceil(this.autoAfter - this.idle)}`
          : this.chg > 0 ? 'CHARGE BLEEDING' : this.holdHint;
        return c;
      }
      case 'over': {
        const sweet = this.over >= SWEET0 && this.over < SWEET1;
        c.charge = 1; c.over = this.over;
        c.main = 'RELEASE TO FIRE';
        c.state = sweet ? 'sweet' : this.over >= SWEET1 ? 'danger' : 'over';
        c.sub = sweet ? 'NOW' : this.over >= SWEET1 ? 'OVERLOAD IMMINENT' : 'WAIT FOR THE WHITE BAND';
        return c;
      }
      case 'run':
        c.ring = false; c.state = 'hint'; c.charge = 0;
        if (pt >= T_IMPACT + 1.5 && pt < T_WIDE_END - 0.5) { c.sub = 'DRAG TO SURVEY'; return c; }
        if (pt > T_WIDE_END + 2.5) { c.sub = this.ffOn ? 'NEXT STRIKE ×4' : 'HOLD FOR NEXT STRIKE'; return c; }
        return null;
    }
    return null;
  }

  // ------------------------------------------------------------------ cues

  private once(key: string, cond: boolean, fn: () => void) {
    if (cond && !this.fired.has(key)) { this.fired.add(key); fn(); }
  }

  private cues(pt: number) {
    const a = this.audio, h = this.hud;
    this.once('lock', pt >= T_LOCK1, () => a.blip());
    // the stack is handed to the operator: klaxon calls for the trigger
    this.once('charge', pt >= T_CHG0, () => { a.klaxon(); if (this.interactive) h.flash('small'); });
    this.once('title1', pt >= T_FIRE, () => {
      if (!this.interactive) { h.title('轨道打击', 'ORBITAL KINETIC STRIKE // AEGIS-7 RELEASE'); return; }
      const tone = this.grade === 'PERFECT' ? 'perfect' : this.grade === 'OVERLOAD' ? 'overload' : '';
      h.title('轨道打击', `${this.autoShot ? 'AUTOPILOT RELEASE' : GRADE_TXT[this.grade]}  YIELD ×${this.yk.toFixed(2)}`, tone);
    });
    this.once('fire', pt >= T_FIRE + 0.28, () => a.railgun());
    this.once('entry', pt >= T_ENTRY - 0.7, () => a.reentry());
    this.once('impact', pt >= T_IMPACT - 0.02, () => {
      const yk = this.interactive ? this.yk : 1;
      a.impact(yk); h.flash('big');
      // impact frame: a few frames of negative before the whiteout
      this.invertT = yk >= 1.5 ? 0.09 : 0.06;
      if (this.everHeld) buzz(yk >= 1.5 ? [70, 30, 160] : [60, 40, 110]);
      if (this.interactive && this.strikeNo > 0) {
        h.record({ n: this.strikeNo, grade: this.grade, kt: BASE_KT * yk, auto: this.autoShot });
      }
    });
    this.once('title2', pt >= T_WIDE_END, () => h.title('目标已毁', 'TARGET NEUTRALIZED // BDA IN PROGRESS'));
    // reset audio-side one-shots when the clock wraps
    if (pt < 1) this.fired.clear();
  }

  private logBeats(pt: number) {
    // the gate can run the clock backwards (charge bleeding off), so beats only
    // re-arm when a new cycle starts, never on a backwards step
    if (this.cycle !== this.beatCycle) { this.beatCycle = this.cycle; this.lastBeat = -1; }
    for (const [bt, msg] of BEATS) {
      if (pt >= bt && this.lastBeat < bt) { this.hud.log(msg); this.lastBeat = bt; }
    }
  }

  // ------------------------------------------------------------------ screen fx

  private _p = new THREE.Vector3();
  private projectUv(world: THREE.Vector3, camera: THREE.PerspectiveCamera): [number, number] | null {
    this._p.copy(world).applyMatrix4(camera.matrixWorldInverse);
    if (this._p.z > -0.2) return null;
    this._p.applyMatrix4(camera.projectionMatrix);
    const x = this._p.x * 0.5 + 0.5;
    const y = isScreenYDown() ? 0.5 - this._p.y * 0.5 : 0.5 + this._p.y * 0.5;
    return [x, y];
  }

  private screenFx(pt: number, camera: THREE.PerspectiveCamera, inOrbit: boolean, yk: number) {
    const arr = U.shocks.array as THREE.Vector4[];
    for (const v of arr) v.set(0.5, 0.5, 2, 0);
    let n = 0;
    const put = (world: THREE.Vector3, t0: number, dur: number, strength: number) => {
      const age = (pt - t0) / dur;
      if (age < 0 || age >= 1 || n >= arr.length) return;
      const uv = this.projectUv(world, camera);
      if (!uv) return;
      arr[n++].set(uv[0], uv[1], age, strength);
    };
    if (inOrbit) {
      this.w.platform.muzzleWorld(this.tmp);
      put(this.tmp, T_FIRE + 0.3, 1.3, 1.5 * Math.min(yk, 1.3));
      put(ENTRY_POS, T_ENTRY, 0.9, 0.8);
    } else {
      put(this.tmp.set(0, 2, 0), T_IMPACT, 2.6, 2.6 * yk);
      put(this.tmp.set(0, 12, 0), T_IMPACT + 0.3, 2.0, 1.4 * yk);
      put(this.tmp.set(0, 30, 0), T_IMPACT + 0.9, 2.4, 0.9 * yk);
      // a perfect strike gets a late suck-back ring: the air rushing in behind the blast
      if (yk >= 1.5) put(this.tmp.set(0, 20, 0), T_IMPACT + 1.4, 2.2, -1.1);
    }

    // rays: the sun in orbit, the fireball on the ground
    let strength = 0;
    let uv: [number, number] | null = null;
    if (inOrbit) {
      uv = this.projectUv(this.tmp.copy(SUN_DIR).multiplyScalar(2400), camera);
      strength = uv ? 0.5 : 0;
    } else {
      uv = this.projectUv(this.tmp.set(0, 26, 0), camera);
      strength = Math.min(1, U.fire.value * 0.7 + U.flash.value * 0.6);
    }
    if (uv) U.rayUv.value.set(uv[0], uv[1]);
    U.rays.value = uv ? strength : 0;
    U.aspect.value = camera.aspect;
  }
}

void MUZZLE_LOCAL;
