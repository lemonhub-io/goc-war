// strike.ts — the thaumic strike itself: designator reticles lock onto the
// floor, a needle of light drops from the sky, swells into a helical pillar,
// and detonates — dome, shock-rings, scorch scars, chain-lightning arcs and a
// screen-space shockwave that refracts the whole frame (see fx.ts).
//
// Everything animated per-frame on the CPU is written into instance
// matrices/colours (the same grammar the floor rings use), so the shaders only
// need to shape the surfaces.
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uv, hash, mix, smoothstep, pow, abs, sin, cos,
  atan, exp, floor, step, instanceIndex, mx_noise_float, normalView,
} from 'three/tsl';
import {
  U, PORTAL, PORTAL_R, TWO_PI, SHOCK_COUNT, pushImpact, pushScar, clearScars, attr,
} from './shared';
import type { Combat } from './combat';
import type { Hud } from './hud';
import type { Synth } from './audio';

const BEAM_H = 70;
const BASE_R = 0.95;
const MAX_PILLARS = 14;
const MAX_ARCS = 18;
const ARC_BEADS = 34;
const RETICLE_R = 3.4;

const BLUE = new THREE.Color(0x66aaff);
const ORANGE = new THREE.Color(0xff7733);

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

export interface Strike {
  object: THREE.Group;
  /** designate + strike one floor point; the pillar lands `lead` seconds later */
  pillar(t: number, x: number, z: number, scale: number, lead?: number, chargeDelay?: number): void;
  /** seven pillars marching toward the Way in a zig-zag carpet */
  barrage(t: number): void;
  /** ring of eight pillars, then the colossal finisher on the aperture */
  convergence(t: number): void;
  /** the Way swallowing itself — inward-running shockwave */
  implode(t: number): void;
  /** screen-space shockwave at a world point (strength < 0 runs inward) */
  shock(t: number, pos: THREE.Vector3, strength: number, dur?: number): void;
  /** jagged thaumic discharge between two world points */
  arc(t: number, from: THREE.Vector3, to: THREE.Vector3, dur?: number, amp?: number, cold?: boolean): void;
  /** requested simulation speed — hit-stop and the convergence slow-mo */
  timeScale(t: number): number;
  update(t: number, dt: number, camera: THREE.PerspectiveCamera): void;
  reset(): void;
  /** world point of the most recent detonation (drives the strike light) */
  readonly lastHit: THREE.Vector3;
}

interface Pillar {
  pos: THREE.Vector3;
  t0: number; tHit: number; scale: number;
  hit: boolean; mega: boolean;
}
interface ShockEv { pos: THREE.Vector3; t0: number; dur: number; strength: number }

export function buildStrike(combat: Combat, hud: Hud, audio: Synth): Strike {
  const group = new THREE.Group();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const BLACK = new THREE.Color(0, 0, 0);

  /** instanced mesh with per-instance colour slots, initially all collapsed */
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, order: number) => {
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.frustumCulled = false;
    m.renderOrder = order;
    for (let i = 0; i < n; i++) { m.setMatrixAt(i, ZERO); m.setColorAt(i, BLACK); }
    m.instanceMatrix.needsUpdate = true;
    return m;
  };
  const addMat = (extra: Partial<THREE.MeshBasicNodeMaterialParameters> = {}) =>
    new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, ...extra,
    });

  // ------------------------------------------------------------ pillar beams
  // unit cylinder, origin at the TOP (y ∈ [-1,0]) so scaling y grows it downward
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true).translate(0, -0.5, 0);

  const coreMat = addMat();
  coreMat.colorNode = Fn(() => {
    const p = uv();
    const ang = p.x.mul(TWO_PI);
    const v = p.y;                                   // 0 at the ground → 1 at the sky
    const fres = pow(abs(normalView.z), 0.7);        // bright spine, soft silhouette
    // helical rune-bands winding down the column + downward-streaming plasma
    const helix = sin(ang.mul(3.0).add(v.mul(26.0)).sub(U.time.mul(16.0))).mul(0.5).add(0.5);
    const n = mx_noise_float(vec3(
      cos(ang).mul(2.0), sin(ang).mul(2.0), v.mul(5.0).add(U.time.mul(14.0)),
    )).mul(0.5).add(0.5);
    const ground = exp(v.mul(-7.0)).mul(2.2);
    const body = float(0.6).add(helix.mul(0.5)).add(n.mul(0.7)).add(ground);
    const a = fres.mul(smoothstep(1.0, 0.72, v));
    return vec4(vec3(1.0, 1.0, 1.0).mul(body).mul(a), a);
  })();
  const cores = instanced(beamGeo, coreMat, MAX_PILLARS, 18);

  const glowMat = addMat();
  glowMat.colorNode = Fn(() => {
    const p = uv();
    const v = p.y;
    const fres = pow(abs(normalView.z), 2.2);
    const n = mx_noise_float(vec3(p.x.mul(TWO_PI).cos().mul(1.4), p.x.mul(TWO_PI).sin().mul(1.4), v.mul(3.0).add(U.time.mul(6.0)))).mul(0.5).add(0.6);
    const a = fres.mul(n).mul(smoothstep(1.0, 0.5, v)).mul(exp(v.mul(-1.2)).mul(0.6).add(0.4));
    return vec4(vec3(0.5, 0.78, 1.0).mul(a), a);
  })();
  const glows = instanced(beamGeo, glowMat, MAX_PILLARS, 17);

  // ------------------------------------------------------------ blast domes
  const domeGeo = new THREE.SphereGeometry(1, 40, 20, 0, TWO_PI, 0, Math.PI / 2);
  const domeMat = addMat();
  domeMat.colorNode = Fn(() => {
    const p = uv();
    const rim = pow(abs(normalView.z).oneMinus(), 2.4).mul(1.5).add(0.06);
    // a faint geodesic lattice rides the shell
    const lat = pow(abs(sin(p.y.mul(Math.PI * 14.0))), 18.0);
    const lon = pow(abs(sin(p.x.mul(Math.PI * 30.0))), 18.0);
    const lattice = lat.max(lon).mul(0.55);
    const e = rim.add(lattice);
    return vec4(vec3(0.6, 0.85, 1.0).mul(e), 1.0);
  })();
  const domes = instanced(domeGeo, domeMat, MAX_PILLARS, 16);

  // ------------------------------------------------------------ designator reticles
  const reticleGeo = new THREE.PlaneGeometry(2, 2);
  const reticleMat = addMat();
  reticleMat.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2.0);
    const r = p.length();
    const a = atan(p.y, p.x);
    const dashed = smoothstep(0.93, 0.945, r).mul(smoothstep(1.0, 0.985, r))
      .mul(smoothstep(0.2, 0.5, sin(a.mul(8.0)).mul(0.5).add(0.5)));
    const mid = smoothstep(0.02, 0.0, abs(r.sub(0.62)));
    const inner = smoothstep(0.012, 0.0, abs(r.sub(0.3))).mul(0.6);
    // crosshair ticks
    const tx = smoothstep(0.03, 0.012, abs(p.x)).mul(smoothstep(0.12, 0.16, abs(p.y))).mul(smoothstep(0.52, 0.46, abs(p.y)));
    const ty = smoothstep(0.03, 0.012, abs(p.y)).mul(smoothstep(0.12, 0.16, abs(p.x))).mul(smoothstep(0.52, 0.46, abs(p.x)));
    const dot = smoothstep(0.06, 0.03, r);
    const total = dashed.mul(1.4).add(mid).add(inner).add(tx).add(ty).add(dot.mul(1.5));
    return vec4(vec3(1.0, 1.0, 1.0).mul(total).mul(smoothstep(1.0, 0.97, r)), 1.0);
  })();
  const reticles = instanced(reticleGeo, reticleMat, MAX_PILLARS, 14);

  group.add(glows, cores, domes, reticles);

  // ------------------------------------------------------------ chain-lightning arcs
  // Each arc is a string of additive beads; bead offsets come from smooth
  // noise re-rolled ~28×/s, so the bolt crawls and re-forks like real discharge.
  const ARC_INST = MAX_ARCS * ARC_BEADS;
  const arcA = new Float32Array(ARC_INST * 4);
  const arcB = new Float32Array(ARC_INST * 4);
  const arcC = new Float32Array(ARC_INST * 4);
  for (let i = 0; i < ARC_INST; i++) { arcA[i * 4 + 3] = -1e3; arcB[i * 4 + 3] = 1; }
  const arcAttrA = new THREE.InstancedBufferAttribute(arcA, 4);
  const arcAttrB = new THREE.InstancedBufferAttribute(arcB, 4);
  const arcAttrC = new THREE.InstancedBufferAttribute(arcC, 4);
  const AA = attr(arcAttrA), AB = attr(arcAttrB), AC = attr(arcAttrC);

  const arcMat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beadS = () => instanceIndex.mod(ARC_BEADS).toFloat().add(0.5).div(ARC_BEADS);
  const arcAge = () => U.time.sub(AA.w).div(AB.w);
  arcMat.positionNode = Fn(() => {
    const s = beadS();
    const tq = floor(U.time.mul(28.0));
    const k = s.mul(9.0).add(AC.x.mul(31.0));
    const j = vec3(
      mx_noise_float(vec3(k, tq, 1.3)),
      mx_noise_float(vec3(k, tq, 7.1)),
      mx_noise_float(vec3(k, tq, 13.7)),
    );
    const env = sin(s.mul(Math.PI)).mul(AC.y);
    return mix(AA.xyz, AB.xyz, s).add(j.mul(env));
  })();
  const arcLive = () => {
    const s = beadS();
    const age = arcAge();
    // the bolt zips out from its origin in the first ~1/6 of its life, then dies away
    return step(s, age.mul(6.0)).mul(step(0.0, age)).mul(smoothstep(1.0, 0.45, age));
  };
  arcMat.scaleNode = Fn(() => {
    const live = arcLive();
    const sz = float(0.26).mul(live).mul(hash(instanceIndex.toFloat().mul(1.93)).mul(0.6).add(0.7));
    return vec2(sz, sz);
  })();
  arcMat.colorNode = Fn(() => {
    const live = arcLive();
    const col = mix(vec3(1.0, 0.72, 0.32), vec3(0.62, 0.85, 1.0), AC.z).mul(4.2);
    return vec4(col.mul(live), live);
  })();
  const arcs = new THREE.Sprite(arcMat);
  arcs.count = ARC_INST;
  arcs.frustumCulled = false;
  arcs.renderOrder = 19;
  group.add(arcs);

  let arcCursor = 0;
  const arc: Strike['arc'] = (t, from, to, dur = 0.42, amp = 0.9, cold = true) => {
    const slot = arcCursor++ % MAX_ARCS;
    const seed = Math.random();
    for (let k = 0; k < ARC_BEADS; k++) {
      const i = (slot * ARC_BEADS + k) * 4;
      arcA[i] = from.x; arcA[i + 1] = from.y; arcA[i + 2] = from.z; arcA[i + 3] = t;
      arcB[i] = to.x; arcB[i + 1] = to.y; arcB[i + 2] = to.z; arcB[i + 3] = dur;
      arcC[i] = seed; arcC[i + 1] = amp; arcC[i + 2] = cold ? 1 : 0;
    }
    arcAttrA.needsUpdate = true; arcAttrB.needsUpdate = true; arcAttrC.needsUpdate = true;
  };

  // ------------------------------------------------------------ shockwave events (→ post)
  const shocks: ShockEv[] = [];
  const shock: Strike['shock'] = (t, pos, strength, dur = 1.0) => {
    shocks.push({ pos: pos.clone(), t0: t, dur, strength });
    if (shocks.length > SHOCK_COUNT) shocks.shift();
  };

  // ------------------------------------------------------------ scheduling
  const pillars: Pillar[] = [];
  const lastHit = new THREE.Vector3(0, 7, -12);
  const pillar: Strike['pillar'] = (t, x, z, scale, lead = 0.9, chargeDelay = 0) => {
    if (pillars.length >= MAX_PILLARS) pillars.shift();
    pillars.push({ pos: new THREE.Vector3(x, 0, z), t0: t, tHit: t + lead, scale, hit: false, mega: false });
    // charge whine is wall-clock audio — stagger it to match staggered designations
    if (chargeDelay > 0) setTimeout(() => audio.pillarCharge(), chargeDelay * 1000);
    else audio.pillarCharge();
  };

  const barrage: Strike['barrage'] = (t) => {
    for (let i = 0; i < 7; i++) {
      const side = i % 2 ? 1 : -1;
      pillar(t + i * 0.16, side * (10.5 - i * 1.3), -2.5 - i * 2.0, 0.82 + i * 0.05, 0.95, i * 0.16);
    }
    hud.log('THAUMIC CARPET — SIX-POINT LADDER TOWARD THE WAY');
  };

  const megaSite = new THREE.Vector3(PORTAL.x, 0, PORTAL.z + 1.5);
  const convergence: Strike['convergence'] = (t) => {
    const c = new THREE.Vector3(0, 0, -14);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TWO_PI + 0.4;
      pillar(t + k * 0.11, c.x + Math.cos(a) * 14.5, c.z + Math.sin(a) * 9.5, 1.05, 1.0, k * 0.11);
    }
    // the finisher — a column wider than the Way itself
    if (pillars.length >= MAX_PILLARS) pillars.shift();
    pillars.push({ pos: megaSite.clone(), t0: t + 0.6, tHit: t + 2.5, scale: 4.3, hit: false, mega: true });
    audio.convergenceRiser();
  };

  const implode: Strike['implode'] = (t) => {
    shock(t, PORTAL, -2.4, 1.3);
    shock(t + 0.18, PORTAL, -1.6, 1.0);
  };

  // ------------------------------------------------------------ impact
  const tmp = new THREE.Vector3();
  const onHit = (p: Pillar) => {
    p.hit = true;
    lastHit.copy(p.pos).setY(7);
    const t = p.tHit, s = p.scale;
    const ground = p.pos.clone().setY(0.35);
    combat.burst(t, ground, true, 1.3 * Math.min(s, 2.4));
    combat.burst(t + 0.03, ground, false, 1.0 * Math.min(s, 2.4));
    combat.ring(p.pos.clone().setY(0.15), t, 14 * s + 6, 1.1, BLUE);
    combat.ring(p.pos.clone().setY(0.18), t + 0.09, 8 * s + 4, 0.8, ORANGE);
    pushImpact(p.pos.clone().setY(1), t);
    pushScar(p.pos.x, p.pos.z, 2.4 * Math.min(s, 2.2), t);
    shock(t, tmp.copy(p.pos).setY(1.2), Math.min(2.4, 0.9 * s + 0.2), p.mega ? 1.8 : 1.0);
    U.shake.value = Math.min(1.8, U.shake.value + 0.45 * Math.min(s, 2.2));
    U.flash.value = Math.max(U.flash.value, p.mega ? 1.0 : Math.min(0.75, 0.3 * s));
    U.caBoost.value = Math.min(1.6, U.caBoost.value + 0.55 * Math.min(s, 2));
    audio.pillarSlam(Math.min(s, 2.6));
    hud.flash(p.mega ? 'big' : 'small');
    // forked discharge crawling out over the floor
    const forks = p.mega ? 7 : 3;
    for (let k = 0; k < forks; k++) {
      const a = Math.random() * TWO_PI;
      const d = (4 + Math.random() * 7) * Math.min(s, 2.4);
      tmp.set(p.pos.x + Math.cos(a) * d, 0.25, p.pos.z + Math.sin(a) * d * 0.7);
      arc(t + k * 0.03, ground, tmp.clone(), 0.38 + Math.random() * 0.25, 0.9 + Math.random() * 0.8, true);
    }
    if (s > 0.8 && !p.mega) {
      const a = Math.random() * TWO_PI;
      tmp.set(PORTAL.x + Math.cos(a) * PORTAL_R * 0.95, PORTAL.y + Math.sin(a) * PORTAL_R * 0.95, PORTAL.z);
      arc(t + 0.05, ground, tmp.clone(), 0.5, 2.2, false);
    }
    if (p.mega) {
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * TWO_PI;
        tmp.set(PORTAL.x + Math.cos(a) * PORTAL_R, PORTAL.y + Math.sin(a) * PORTAL_R, PORTAL.z);
        arc(t + 0.02 * k, ground, tmp.clone(), 0.7, 2.6, k % 2 === 0);
      }
    }
  };

  // ------------------------------------------------------------ per-frame
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const sv = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const col = new THREE.Color();
  const RED = new THREE.Color(1.0, 0.22, 0.16);
  const WHITE = new THREE.Color(1, 1, 1);
  let discharge = 0;

  const update: Strike['update'] = (t, dt, camera) => {
    camera.updateMatrixWorld();

    // ---- pillars
    for (let i = pillars.length - 1; i >= 0; i--) {
      if (t > pillars[i].tHit + 2.0) pillars.splice(i, 1);
    }
    for (let i = 0; i < MAX_PILLARS; i++) {
      const p = pillars[i];
      if (!p) {
        cores.setMatrixAt(i, ZERO); glows.setMatrixAt(i, ZERO);
        domes.setMatrixAt(i, ZERO); reticles.setMatrixAt(i, ZERO);
        continue;
      }
      if (!p.hit && t >= p.tHit) onHit(p);
      const tau = t - p.tHit;
      const prog = Math.min(1, Math.max(0, (t - p.t0) / (p.tHit - p.t0)));
      const s = p.scale;

      // --- beam: thin red designator needle while locking, then the pillar
      let rCore = 0, iCore = 0, rGlow = 0, iGlow = 0;
      if (tau < 0) {
        if (prog > 0.22) {
          rCore = 0.045 * Math.max(1, Math.sqrt(s));
          iCore = 0.25 + 1.1 * prog * prog;
        }
      } else if (tau < 1.9) {
        const swell = easeOut(tau / 0.1);
        const decay = Math.exp(-Math.max(0, tau - 0.1) * 2.5);
        const flick = 1 + 0.1 * Math.sin(tau * 70);
        rCore = BASE_R * s * (0.05 + 0.95 * swell) * (0.22 + 0.78 * decay) * flick;
        iCore = (2.4 * decay + 0.25 * Math.exp(-tau * 0.8)) * (tau < 0.12 ? 2.0 : 1);
        rGlow = rCore * 3.8;
        iGlow = 1.25 * decay * (tau < 0.12 ? 1.6 : 1);
      }
      if (rCore > 0) {
        m.compose(pv.set(p.pos.x, BEAM_H, p.pos.z), q.identity(), sv.set(rCore, BEAM_H, rCore));
        cores.setMatrixAt(i, m);
        if (tau < 0) col.copy(RED).multiplyScalar(iCore);
        else col.setRGB(0.9, 0.97, 1.0).multiplyScalar(iCore);
        cores.setColorAt(i, col);
      } else { cores.setMatrixAt(i, ZERO); cores.setColorAt(i, BLACK); }
      if (rGlow > 0) {
        m.compose(pv.set(p.pos.x, BEAM_H, p.pos.z), q.identity(), sv.set(rGlow, BEAM_H, rGlow));
        glows.setMatrixAt(i, m);
        glows.setColorAt(i, col.setRGB(0.3, 0.6, 1.0).multiplyScalar(iGlow));
      } else { glows.setMatrixAt(i, ZERO); glows.setColorAt(i, BLACK); }

      // --- blast dome
      const dT = tau / (p.mega ? 1.6 : 1.1);
      if (tau >= 0 && dT < 1) {
        const rad = (p.mega ? 10 : 7.5) * s * easeOut(dT) + 0.3;
        m.compose(pv.set(p.pos.x, 0, p.pos.z), q.identity(), sv.set(rad, rad * 0.75, rad));
        domes.setMatrixAt(i, m);
        domes.setColorAt(i, col.setRGB(0.55, 0.8, 1.0).multiplyScalar(Math.pow(1 - dT, 2.2) * 1.5));
      } else { domes.setMatrixAt(i, ZERO); domes.setColorAt(i, BLACK); }

      // --- reticle: contracts from wide to lock, then flashes out
      if (tau < 0.28) {
        const lock = easeOut(prog);
        const rad = RETICLE_R * Math.max(0.8, s) * (1 + 2.3 * (1 - lock) * (1 - lock)) * (tau > 0 ? 1 + tau * 5 : 1);
        e.set(-Math.PI / 2, t * 2.6 * (1 - prog) + p.t0, 0);
        q.setFromEuler(e);
        m.compose(pv.set(p.pos.x, 0.12, p.pos.z), q, sv.set(rad, rad, rad));
        reticles.setMatrixAt(i, m);
        const fade = tau > 0 ? 1 - tau / 0.28 : 1;
        col.copy(RED).lerp(WHITE, smoothLerp(prog, 0.55, 1.0)).multiplyScalar((0.35 + 1.3 * prog) * fade);
        reticles.setColorAt(i, col);
      } else { reticles.setMatrixAt(i, ZERO); reticles.setColorAt(i, BLACK); }
    }
    for (const mesh of [cores, glows, domes, reticles]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // ---- ambient discharge: the open Way throws bolts at the floor
    if (U.strike.value > 0.25) {
      discharge += dt * (1.6 + U.strike.value * 2.2);
      while (discharge > 1) {
        discharge -= 1;
        const a = Math.random() * TWO_PI;
        pv.set(PORTAL.x + Math.cos(a) * PORTAL_R * 0.95, PORTAL.y + Math.sin(a) * PORTAL_R * 0.95, PORTAL.z);
        tmp.set((Math.random() - 0.5) * 26, 0.2, PORTAL.z + 3 + Math.random() * 14);
        arc(t, pv, tmp, 0.3 + Math.random() * 0.2, 1.3, Math.random() < 0.7);
      }
    }

    // ---- screen-space uniforms for post
    U.aspect.value = camera.aspect;
    projectUv(PORTAL, camera, (x, y) => U.portalUv.value.set(x, y), () => U.portalUv.value.set(0.5, 0.4));
    for (let i = shocks.length - 1; i >= 0; i--) if (t > shocks[i].t0 + shocks[i].dur) shocks.splice(i, 1);
    const arr = U.shocks.array as THREE.Vector4[];
    for (let i = 0; i < SHOCK_COUNT; i++) {
      const ev = shocks[i];
      if (!ev || t < ev.t0) { arr[i].set(0.5, 0.5, 2, 0); continue; }
      projectUv(ev.pos, camera,
        (x, y) => arr[i].set(x, y, (t - ev.t0) / ev.dur, ev.strength),
        () => arr[i].set(0.5, 0.5, 2, 0));
    }
  };

  const timeScale: Strike['timeScale'] = (t) => {
    let k = 1;
    for (const p of pillars) {
      const tau = t - p.tHit;
      if (p.mega) {
        // the world drags as the finisher lands, then rushes back
        if (tau > -0.5 && tau < 1.8) {
          const into = smoothLerp(tau, -0.5, -0.05);
          const out = 1 - smoothLerp(tau, 0.5, 1.8);
          k = Math.min(k, 1 - 0.72 * Math.min(into, out));
        }
      } else if (tau >= 0 && tau < 0.07) {
        k = Math.min(k, 0.45);    // hit-stop
      }
    }
    return k;
  };

  const reset = () => {
    pillars.length = 0; shocks.length = 0; discharge = 0;
    clearScars();
    const arr = U.shocks.array as THREE.Vector4[];
    for (const v of arr) v.set(0.5, 0.5, 2, 0);
  };

  return {
    object: group, pillar, barrage, convergence, implode, shock, arc, timeScale, update, reset, lastHit,
  };
}

function smoothLerp(x: number, a: number, b: number): number {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

const _p = new THREE.Vector3();
/** world → screen uv (y down, WebGPU convention); `off` when behind the camera */
function projectUv(
  world: THREE.Vector3, camera: THREE.PerspectiveCamera,
  on: (x: number, y: number) => void, off: () => void,
) {
  _p.copy(world).applyMatrix4(camera.matrixWorldInverse);
  if (_p.z > -0.2) { off(); return; }
  _p.applyMatrix4(camera.projectionMatrix);
  on(_p.x * 0.5 + 0.5, 0.5 - _p.y * 0.5);
}
