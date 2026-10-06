// director.ts — the orbital strike timeline, camera rig and shot cuts.
//
//   0.0 ─  7.4  ACQUIRE   platform slews onto the target, lock rings close on the Earth
//   7.4 ─ 13.2  CHARGE    capacitor rings fill, designator paints the site
//  13.2 ─ 17.2  RELEASE    coil pulse, rod leaves the muzzle, re-entry (orbit cam)
//  17.2 ─ 20.9  DESCENT    rod-cam through the cloud decks (ground world)
//  20.9 ─ 28.0  IMPACT     whiteout, shock, mushroom (ground cam, slow orbit)
//  28.0 ─ 42.0  AFTERMATH  back to orbit: the scar glows on the night side
//
// Everything is a pure function of loop time `pt` (plus uniforms derived from
// it), so the timeline can be seeked, looped and slowed without event state.
import * as THREE from 'three/webgpu';
import {
  U, TARGET_POS, EARTH_C, ER, SUN_DIR, MUZZLE_LOCAL, isScreenYDown,
} from './shared';
import type { Platform } from './platform';
import type { Rod, Beam } from './rod';
import type { Ground } from './ground';
import type { Hud, HudState } from './hud';
import type { Synth } from './audio';

export const LOOP = 42;

const T_AIM0 = 2.0, T_AIM1 = 8.0;
const T_LOCK0 = 3.2, T_LOCK1 = 8.4;
const T_DESIG = 8.2;
const T_CHG0 = 7.4, T_FIRE = 13.2;
const T_LAUNCH = 13.55;
const T_ENTRY = 16.9;
const T_CUT1 = 17.2;
const T_IMPACT = 20.9;
const T_WIDE_END = 28.0;
const T_END = LOOP;

function seg(t: number, a: number, b: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
/** exp(-k·x) for x ≥ 0, 0 before */
const decay = (x: number, k: number) => (x < 0 ? 0 : Math.exp(-x * k));

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
  private elapsed = 0;
  private resetFired = false;
  private lastPhase = -1;
  private lastBeat = -1;
  private fired = new Set<string>();
  private snap = true;
  private rodPos = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private qV = new THREE.Vector3();
  private qKick = new THREE.Quaternion();
  private eKick = new THREE.Euler();
  /** debug: ?cam=px,py,pz,lx,ly,lz[,fov] replaces the scripted camera (orbit world) */
  camOverride: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  hudState: HudState = { capacitor: 0, velocity: 0, altitude: 400, yieldKt: 0, integrity: 100 };

  constructor(world: World, hud: Hud, audio: Synth) {
    this.w = world; this.hud = hud; this.audio = audio;
    addEventListener('pointermove', (e) => {
      this.mouse.set((e.clientX / innerWidth - 0.5) * 2, (e.clientY / innerHeight - 0.5) * 2);
    });
  }

  get phaseTime(): number { return this.elapsed % LOOP; }
  get phaseIndex(): number {
    const t = this.phaseTime;
    return t < T_CHG0 ? 0 : t < T_FIRE ? 1 : t < T_WIDE_END ? 2 : 3;
  }
  /** simulation speed the render loop should advance by (slow-mo around the hits) */
  get timeScale(): number { return this.tsSm; }
  /** next update places the camera exactly (no damping) — used after a seek */
  snapNext() { this.snap = true; }

  // ------------------------------------------------------------------ shots

  private computeShot(pt: number, t: number): Shot {
    const s = this.shot;
    const sway = (f: number, a: number) => Math.sin(t * f) * a;
    if (pt < T_CUT1) {
      // ---- orbit, before the cut
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
    this.elapsed = t;
    const pt = this.phaseTime;
    const cycleStart = t - pt;
    const w = this.w;

    // ---------- time dilation: the hits land in slow motion
    const bump = seg(pt, T_IMPACT - 0.25, T_IMPACT + 0.05) * (1 - seg(pt, T_IMPACT + 0.6, T_IMPACT + 1.8));
    const bumpF = seg(pt, T_FIRE + 0.15, T_FIRE + 0.4) * (1 - seg(pt, T_FIRE + 0.7, T_FIRE + 1.2));
    const tsTarget = 1 - 0.78 * bump - 0.42 * bumpF;
    this.tsSm += (tsTarget - this.tsSm) * Math.min(1, dt * (tsTarget < this.tsSm ? 40 : 7));

    // ---------- world visibility (cuts between the orbit and ground worlds)
    const inOrbit = pt < T_CUT1 || pt >= T_WIDE_END;
    w.orbit.visible = inOrbit;
    w.ground.group.visible = !inOrbit;

    // ---------- timeline-derived uniforms
    U.time.value = t;
    U.tFire.value = cycleStart + T_FIRE;
    U.tImpact.value = cycleStart + T_IMPACT;
    const age = pt - T_IMPACT;

    U.lock.value = seg(pt, T_LOCK0, T_LOCK1);
    U.designator.value = seg(pt, T_DESIG, T_DESIG + 0.8) * (1 - seg(pt, T_LAUNCH, T_LAUNCH + 0.25));
    U.charge.value = Math.pow(seg(pt, T_CHG0, T_FIRE), 1.15) * (1 - seg(pt, T_FIRE + 0.25, T_FIRE + 0.5));
    const tf = pt - (T_FIRE + 0.3);
    U.muzzle.value = tf < 0 ? 0.55 * seg(pt, T_FIRE, T_FIRE + 0.3) : decay(tf, 4.2);
    U.heat.value = tf < 0 ? 0 : decay(tf, 0.2);
    U.reentry.value = seg(pt, T_ENTRY - 1.2, T_ENTRY + 0.3) * (1 - seg(pt, T_IMPACT, T_IMPACT + 0.15));
    U.fire.value = age < 0 ? 0 : seg(age, 0, 0.7) * (0.45 + 0.55 * decay(age, 0.12)) * (1 - seg(pt, 38.5, 41.8));

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
      1.7 * decay(age, 1.5) + 0.2 * decay(age, 0.2),
    );
    U.caBoost.value = Math.max(0.9 * decay(tf, 3), 1.5 * decay(age, 2.2), 0.4 * U.shake.value);
    U.exposure.value = 1 + U.flash.value * 0.8;

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
    const recoil = recoilT < 0 ? 0 : 2.8 * decay(recoilT, 2.4) * Math.cos(recoilT * 2.6);
    w.platform.update({ t, charge: U.charge.value, sinceFire: pt - T_FIRE, recoil });
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
    const shk = U.shake.value;
    const n = (f: number) => (Math.sin(t * f * 9.1) + Math.sin(t * f * 13.7) * 0.5) * 0.5;
    const shkScale = sh.id === 1 ? 0.6 : sh.id === 2 ? 1.3 : 1.0;
    camera.position.copy(this.camPosSm);
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
    this.screenFx(pt, camera, inOrbit);

    // ---------- hud numbers
    const hs = this.hudState;
    hs.capacitor = U.charge.value * 4800;
    const p = THREE.MathUtils.clamp((pt - T_LAUNCH) / (T_IMPACT - T_LAUNCH), 0, 1);
    hs.velocity = pt < T_LAUNCH ? 0 : 11.8 * Math.min(1, Math.pow(p, 0.5)) * (age > 0 ? 0 : 1);
    hs.altitude = age > 0 ? 0 : pt < T_LAUNCH ? 400 : 400 * (1 - Math.pow(p, 2.0));
    hs.yieldKt = age > 0 ? 11.4 * (1 - Math.exp(-age * 5)) : 0;
    hs.integrity = age > 0 ? 100 * Math.exp(-age * 0.9) : 100;
  }

  // ------------------------------------------------------------------ cues

  private once(key: string, cond: boolean, fn: () => void) {
    if (cond && !this.fired.has(key)) { this.fired.add(key); fn(); }
  }

  private cues(pt: number) {
    const a = this.audio, h = this.hud;
    this.once('lock', pt >= T_LOCK1, () => a.blip());
    this.once('charge', pt >= T_CHG0, () => { a.chargeRiser(); a.klaxon(); });
    this.once('title1', pt >= T_FIRE, () => h.title('轨道打击', 'ORBITAL KINETIC STRIKE // AEGIS-7 RELEASE'));
    this.once('fire', pt >= T_FIRE + 0.28, () => a.railgun());
    this.once('entry', pt >= T_ENTRY - 0.7, () => a.reentry());
    this.once('impact', pt >= T_IMPACT - 0.02, () => { a.impact(); h.flash('big'); });
    this.once('title2', pt >= T_WIDE_END, () => h.title('目标已毁', 'TARGET NEUTRALIZED // BDA IN PROGRESS'));
    // reset audio-side one-shots when the clock wraps
    if (pt < 1) this.fired.clear();
  }

  private logBeats(pt: number) {
    const beats: [number, string][] = [
      [0.8, 'UPLINK ESTABLISHED // TAC-FEED 04 LIVE'],
      [2.2, 'AEGIS-7 SLEWING — TARGET KTE-7909 ACQUIRED'],
      [4.6, 'ORBITAL FIX: 400 KM // INCLINATION 97.4°'],
      [6.4, 'GROUND LOCK STABLE — CEP < 4 M'],
      [8.2, 'DESIGNATOR PAINTING TARGET'],
      [9.6, 'COIL STACK 1–10 CHARGING'],
      [11.6, 'CAPACITORS 88% — HOLD FOR RELEASE'],
      [13.0, 'RELEASE AUTHORIZED — COUNCIL-108 RES.117-C'],
      [13.9, 'ROD CLEAR OF THE BORE // 11.8 KM/S TERMINAL'],
      [16.4, 'ATMOSPHERIC INTERFACE — PLASMA SHEATH'],
      [19.2, 'ROD-CAM: ALTITUDE FALLING THROUGH 30 KM'],
      [21.4, 'IMPACT CONFIRMED — GROUND ZERO KTE-7909'],
      [24.5, 'SHOCKFRONT CLEARING OUTLYING ELEMENTS'],
      [29.0, 'BDA: TARGET FILE DENIED — NO SURVIVORS DETECTED'],
      [34.0, 'AEGIS-7 CAPACITORS DISCHARGED // COOLING'],
      [39.6, 'FEED LOOP ARMS IN 4…3…2…'],
    ];
    if (pt < this.lastBeat) this.lastBeat = -1;
    for (const [bt, msg] of beats) {
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

  private screenFx(pt: number, camera: THREE.PerspectiveCamera, inOrbit: boolean) {
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
      put(this.tmp, T_FIRE + 0.3, 1.3, 1.5);
      put(ENTRY_POS, T_ENTRY, 0.9, 0.8);
    } else {
      put(this.tmp.set(0, 2, 0), T_IMPACT, 2.6, 2.6);
      put(this.tmp.set(0, 12, 0), T_IMPACT + 0.3, 2.0, 1.4);
      put(this.tmp.set(0, 30, 0), T_IMPACT + 0.9, 2.4, 0.9);
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
