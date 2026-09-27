// combat.ts — strike weapons: energy lances, impact bursts, floor shock-rings
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uv, hash, mix, smoothstep, pow,
  exp, atan, instanceIndex,
  cameraProjectionMatrix, cameraViewMatrix,
} from 'three/tsl';
import { U, PORTAL, emberRamp, wayRamp, pushImpact, attr } from './shared';
import type { Hud } from './hud';
import type { Synth } from './audio';

const MAX_LANCES = 24;
const MAX_BURSTS = 16;
const SPARKS_PER_BURST = 48;
const MAX_RINGS = 16;

// ------------------------------------------------------------------ lances
// Each slot: A = (sx,sy,sz,t0)  B = (dir*travel, dur)  C = (len,width,intensity,seed)

export interface Combat {
  lances: THREE.Sprite;
  bursts: THREE.Sprite;
  rings: THREE.InstancedMesh;
  fireVolley(t: number): void;
  breachBlast(t: number): void;
  update(t: number, dt: number): void;
  pendingCount(): number;
}

export function buildCombat(hud: Hud, audio: Synth): Combat {
  // ---------------- lance slot buffers (written on spawn)
  const lanceA = new Float32Array(MAX_LANCES * 4).fill(0);
  const lanceB = new Float32Array(MAX_LANCES * 4).fill(0);
  const lanceC = new Float32Array(MAX_LANCES * 4).fill(0);
  for (let i = 0; i < MAX_LANCES; i++) lanceA[i * 4 + 3] = -1e3; // t0 far past
  const attrA = new THREE.InstancedBufferAttribute(lanceA, 4);
  const attrB = new THREE.InstancedBufferAttribute(lanceB, 4);
  const attrC = new THREE.InstancedBufferAttribute(lanceC, 4);
  const LA = attr(attrA);
  const LB = attr(attrB);
  const LC = attr(attrC);

  const lanceMat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  const lanceProgress = Fn(() => {
    const age = U.time.sub(LA.w);
    return age.div(LB.w).clamp(0, 1);
  });

  lanceMat.positionNode = Fn(() => {
    const prog = lanceProgress();
    const head = LA.xyz.add(LB.xyz.mul(prog.mul(prog).mul(3).sub(prog.mul(prog).mul(prog).mul(2)))); // smoothstep ease
    const back = LB.xyz.normalize().mul(LC.x.mul(0.5));
    return head.sub(back);
  })();

  lanceMat.rotationNode = Fn(() => {
    // screen-space angle of travel direction
    const prog = lanceProgress();
    const head = LA.xyz.add(LB.xyz.mul(prog.mul(prog).mul(3).sub(prog.mul(prog).mul(prog).mul(2))));
    const tail = head.sub(LB.xyz.normalize().mul(LC.x));
    const hClip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(head, 1.0)));
    const tClip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(tail, 1.0)));
    const hNdc = hClip.xy.div(hClip.w);
    const tNdc = tClip.xy.div(tClip.w);
    const d = hNdc.sub(tNdc);
    return atan(d.y, d.x).sub(Math.PI / 2);
  })();

  lanceMat.scaleNode = Fn(() => {
    const prog = lanceProgress();
    const live = smoothstep(0.0, 0.05, prog).mul(smoothstep(1.0, 0.85, prog));
    return vec2(LC.y.mul(live).add(0.001), LC.x.add(0.001));
  })();

  lanceMat.colorNode = Fn(() => {
    const p = uv().sub(0.5);
    // v is along the beam: hot leading tip, fading tail
    const across = exp(p.x.mul(p.x).mul(-160.0));
    const along = smoothstep(-0.5, -0.28, p.y).mul(smoothstep(0.5, 0.1, p.y));
    const tip = exp(p.y.sub(0.5).abs().mul(-9.0));
    const core = across.mul(along).mul(0.65).add(across.mul(tip).mul(1.6));
    const col = mix(vec3(0.45, 0.7, 1.0), vec3(1.0, 1.0, 1.0), tip.mul(0.7))
      .mul(LC.z.mul(4.5));
    const prog = lanceProgress();
    const live = smoothstep(0.0, 0.05, prog).mul(smoothstep(1.0, 0.8, prog));
    const a = core.mul(live);
    return vec4(col.mul(a), a);
  })();

  const lances = new THREE.Sprite(lanceMat);
  (lances as any).count = MAX_LANCES;
  lances.frustumCulled = false;
  lances.renderOrder = 16;

  // ---------------- burst pool — params replicated per-spark so plain
  // instanced attributes work on every backend
  const BURST_INST = MAX_BURSTS * SPARKS_PER_BURST;
  const burstA = new Float32Array(BURST_INST * 4);
  const burstB = new Float32Array(BURST_INST * 4);
  for (let i = 0; i < BURST_INST; i++) { burstA[i * 4 + 3] = -1e3; burstB[i * 4 + 1] = 1; }
  const bAttrA = new THREE.InstancedBufferAttribute(burstA, 4);
  const bAttrB = new THREE.InstancedBufferAttribute(burstB, 4);
  const burstSlotA = attr(bAttrA);
  const burstSlotB = attr(bAttrB);

  const burstMat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  const sparkId = instanceIndex.mod(SPARKS_PER_BURST);
  const burstAge = Fn(() => U.time.sub(burstSlotA.w).div(burstSlotB.y).clamp(0, 1));

  burstMat.positionNode = Fn(() => {
    const s = hash(sparkId.toFloat().mul(7.13).add(burstSlotB.z.mul(131.0)));
    const s2 = hash(sparkId.toFloat().mul(3.71).add(burstSlotB.z.mul(57.0)));
    const s3 = hash(sparkId.toFloat().mul(9.37).add(burstSlotB.z.mul(211.0)));
    // sphere-ish direction, biased up
    const dir = vec3(s.mul(2).sub(1), s2.mul(1.4), s3.mul(2).sub(1));
    const nd = dir.div(dir.length().max(0.05));
    const age = burstAge();
    const ease = age.mul(2).sub(age.mul(age)).add(0.0001); // 1-(1-a)^2
    const dist = ease.mul(burstSlotB.x.mul(2.5).add(s.mul(6.0)));
    return burstSlotA.xyz.add(nd.mul(dist)).add(vec3(0, age.mul(age).mul(-2.2), 0));
  })();
  burstMat.scaleNode = Fn(() => {
    const age = burstAge();
    const s = mix(float(0.11), 0.015, age);
    return vec2(s, s);
  })();
  burstMat.colorNode = Fn(() => {
    const age = burstAge();
    const cold = burstSlotB.w; // >0.5 → GOC-blue lance burst, else fire burst
    const fire = emberRamp(age.mul(0.9)).mul(4.5);
    const ice = wayRamp(age.mul(0.9)).mul(4.5);
    const col = mix(fire, ice, cold);
    const a = pow(age.oneMinus().max(0.0), 1.6);
    return vec4(col.mul(a), a);
  })();
  const bursts = new THREE.Sprite(burstMat);
  (bursts as any).count = MAX_BURSTS * SPARKS_PER_BURST;
  bursts.frustumCulled = false;
  bursts.renderOrder = 17;

  // ---------------- floor shock-rings (CPU instanced mesh)
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 72, 1);
  const ringMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS);
  rings.frustumCulled = false;
  rings.renderOrder = 15;
  interface Ring { pos: THREE.Vector3; t0: number; dur: number; maxR: number; col: THREE.Color }
  const ringPool: Ring[] = [];
  const rm = new THREE.Matrix4();
  const rq = new THREE.Quaternion();
  const re = new THREE.Euler(-Math.PI / 2, 0, 0);
  const rs = new THREE.Vector3();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX_RINGS; i++) rings.setMatrixAt(i, ZERO);
  rings.instanceMatrix.needsUpdate = true;
  const rc = new THREE.Color(0);
  for (let i = 0; i < MAX_RINGS; i++) rings.setColorAt(i, rc);

  function spawnRing(pos: THREE.Vector3, t: number, maxR: number, dur: number, col: THREE.Color) {
    ringPool.push({ pos: pos.clone(), t0: t, dur, maxR, col });
    if (ringPool.length > MAX_RINGS) ringPool.shift();
  }

  // ---------------- volley scheduling
  interface Pending { t: number; pos: THREE.Vector3; cold: boolean }
  const pending: Pending[] = [];
  let lanceCursor = 0;
  let burstCursor = 0;
  const BLUE = new THREE.Color(0x66aaff);
  const ORANGE = new THREE.Color(0xff7733);

  function spawnLance(t: number, from: THREE.Vector3, to: THREE.Vector3, dur: number) {
    const i = lanceCursor++ % MAX_LANCES;
    const dir = to.clone().sub(from);
    const travel = dir.length();
    lanceA[i * 4] = from.x; lanceA[i * 4 + 1] = from.y; lanceA[i * 4 + 2] = from.z; lanceA[i * 4 + 3] = t;
    lanceB[i * 4] = dir.x * 1.08; lanceB[i * 4 + 1] = dir.y * 1.08; lanceB[i * 4 + 2] = dir.z * 1.08; lanceB[i * 4 + 3] = dur;
    lanceC[i * 4] = Math.min(14, travel * 0.5); lanceC[i * 4 + 1] = 0.5 + Math.random() * 0.45;
    lanceC[i * 4 + 2] = 0.8 + Math.random() * 0.5; lanceC[i * 4 + 3] = Math.random();
    attrA.needsUpdate = true; attrB.needsUpdate = true; attrC.needsUpdate = true;
    pending.push({ t: t + dur, pos: to.clone(), cold: true });
  }

  function spawnBurst(t: number, pos: THREE.Vector3, cold: boolean, strength = 1) {
    const slot = burstCursor++ % MAX_BURSTS;
    const dur = 0.7 + Math.random() * 0.4;
    const seed = Math.random();
    for (let k = 0; k < SPARKS_PER_BURST; k++) {
      const i = slot * SPARKS_PER_BURST + k;
      burstA[i * 4] = pos.x; burstA[i * 4 + 1] = pos.y; burstA[i * 4 + 2] = pos.z; burstA[i * 4 + 3] = t;
      burstB[i * 4] = strength; burstB[i * 4 + 1] = dur;
      burstB[i * 4 + 2] = seed; burstB[i * 4 + 3] = cold ? 1 : 0;
    }
    bAttrA.needsUpdate = true; bAttrB.needsUpdate = true;
  }

  const TARGETS = [
    new THREE.Vector3(-12.5, 3.5, -14), new THREE.Vector3(12.5, 5.5, -20),
    new THREE.Vector3(-13.5, 7.0, -24), new THREE.Vector3(12.0, 2.0, -10),
    new THREE.Vector3(-8.0, 1.0, -9), new THREE.Vector3(6.5, 1.0, -8),
    new THREE.Vector3(-19.0, 9.0, -28), new THREE.Vector3(19.0, 11.0, -27),
    new THREE.Vector3(-2.5, 0.5, -6), new THREE.Vector3(3.0, 0.5, -5.5),
  ];

  const fireVolley = (t: number) => {
    const n = 2 + ((Math.random() * 3) | 0); // 2-4 beams
    for (let k = 0; k < n; k++) {
      const target = TARGETS[(Math.random() * TARGETS.length) | 0];
      const from = new THREE.Vector3(
        target.x * -0.6 + (Math.random() - 0.5) * 10,
        24 + Math.random() * 10,
        target.z + 26 + Math.random() * 14,
      );
      spawnLance(t + k * (0.1 + Math.random() * 0.14), from, target, 0.5 + Math.random() * 0.22);
    }
    hud.flash('small');
    audio.boom(0.4 + Math.random() * 0.3);
    hud.log(pickLanceLog());
  };

  const breachBlast = (t: number) => {
    // the Way tears open — massive ring + blast
    spawnBurst(t, PORTAL.clone().add(new THREE.Vector3(0, 0, 1.5)), true, 2.2);
    spawnRing(PORTAL.clone().setY(0.15), t, 34, 1.6, BLUE);
    spawnRing(PORTAL.clone().setY(0.2), t + 0.12, 22, 1.2, BLUE);
    pushImpact(PORTAL, t);
    U.shake.value = Math.min(1.6, U.shake.value + 1.2);
    U.flash.value = 1;
    U.caBoost.value = Math.min(1.5, U.caBoost.value + 1);
    audio.breachRiser();
    hud.flash('big');
  };

  let shakeSeed = 0;
  const update = (t: number, dt: number) => {
    // resolve pending impacts
    for (let i = pending.length - 1; i >= 0; i--) {
      const e = pending[i];
      if (t >= e.t) {
        pending.splice(i, 1);
        spawnBurst(e.t, e.pos, e.cold, 1.1);
        spawnBurst(e.t + 0.04, e.pos, false, 0.8);
        spawnRing(e.pos.clone().setY(Math.max(0.12, e.pos.y * 0.15)), e.t, 13 + Math.random() * 8, 1.0, e.cold ? BLUE : ORANGE);
        pushImpact(e.pos, e.t);
        U.shake.value = Math.min(1.4, U.shake.value + 0.55);
        U.caBoost.value = Math.min(1.2, U.caBoost.value + 0.55);
        audio.boom(0.7 + Math.random() * 0.4);
      }
    }
    // rings
    for (let i = 0; i < ringPool.length; i++) {
      const r = ringPool[i];
      const age = (t - r.t0) / r.dur;
      const idx = ringPool.length - 1 - i; // stable slot order
      if (age >= 1) { ringPool.splice(i, 1); i--; rings.setMatrixAt(idx, ZERO); continue; }
      const ease = 1 - Math.pow(1 - Math.max(0, age), 3);
      const s = Math.max(0.001, r.maxR * ease);
      rs.set(s, s, s); re.set(-Math.PI / 2, 0, 0); rq.setFromEuler(re);
      rm.compose(r.pos, rq, rs);
      rings.setMatrixAt(idx, rm);
      const fade = Math.pow(1 - Math.max(0, age), 1.7) * 0.8;
      rc.copy(r.col).multiplyScalar(fade * 3.0);
      rings.setColorAt(idx, rc);
    }
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    shakeSeed++;
  };

  return {
    lances, bursts, rings, fireVolley, breachBlast, update,
    pendingCount: () => pending.length,
  };
}

const LANCE_LOGS = [
  'LANCE IMPACT — SECTOR C-9 // GREEK FIRE SPREAD',
  'MK-IV LANCE AWAY — SHELF RANK 12 DENIED',
  'DIRECT HIT — CATALOGUE NODE BURNING',
  'FIREBREAK-2 REPORTS CLEAN KILL ZONE',
  'THAUMIC RETURN SUPPRESSED — RE-FIRE',
  'ORDNANCE EXPENDED — DENIAL +4.2%',
];
function pickLanceLog(): string {
  return LANCE_LOGS[(Math.random() * LANCE_LOGS.length) | 0];
}
