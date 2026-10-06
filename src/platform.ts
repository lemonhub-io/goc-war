// platform.ts — AEGIS-7, the orbital lance platform: spine, solar wings,
// radiators, and a coil-gun barrel whose capacitor rings charge in sequence,
// carry the launch pulse down the bore, and bleed heat afterwards.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, hash, mix, smoothstep, abs, sin, exp, floor, step,
  instanceIndex, mx_noise_float, uv, positionLocal,
} from 'three/tsl';
import { U, MUZZLE_LOCAL, TWO_PI, attr } from './shared';

const N_RINGS = 10;
const RING_Y0 = -6.9;
const RING_DY = 2.05;

export interface PlatformState {
  t: number;
  /** capacitor charge 0..1 */
  charge: number;
  /** seconds since the launch pulse entered the bore (negative before) */
  sinceFire: number;
  /** recoil displacement along the barrel (local +Y) */
  recoil: number;
}

export interface Platform {
  group: THREE.Group;
  /** muzzle position in world space (after the last update) */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3;
  update(s: PlatformState): void;
}

export function buildPlatform(): Platform {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const hull = new THREE.MeshStandardNodeMaterial({ color: 0xaab2bd, roughness: 0.4, metalness: 0.85 });
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x2a2f38, roughness: 0.5, metalness: 0.9 });
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xd9dde3, roughness: 0.55, metalness: 0.2 });

  // barrel heat — the bore glows cherry after the shot
  const barrelMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c2027, roughness: 0.45, metalness: 0.95 });
  barrelMat.emissiveNode = Fn(() => {
    const y = positionLocal.y;
    const along = smoothstep(-6.0, -26.0, y);
    return vec3(1.0, 0.36, 0.08).mul(U.heat.mul(along.mul(0.8).add(0.2))).mul(1.6);
  })();

  const panelMat = new THREE.MeshStandardNodeMaterial({
    color: 0x0a1226, roughness: 0.22, metalness: 0.6, side: THREE.DoubleSide,
  });
  panelMat.colorNode = Fn(() => {
    const p = uv();
    const cell = vec2(p.x.mul(8.0), p.y.mul(12.0));
    const f = vec2(cell.x.fract(), cell.y.fract());
    const line = smoothstep(0.0, 0.04, f.x.sub(0.5).abs().sub(0.46)).max(smoothstep(0.0, 0.04, f.y.sub(0.5).abs().sub(0.465)));
    const tone = hash(floor(cell.x).add(floor(cell.y).mul(13.7))).mul(0.5).add(0.5);
    const base = mix(vec3(0.015, 0.04, 0.12), vec3(0.06, 0.15, 0.34), tone);
    const gold = vec3(0.55, 0.42, 0.18);
    return vec4(mix(base, gold, line.mul(0.9)), 1.0);
  })();

  const add = (m: THREE.Mesh, x = 0, y = 0, z = 0) => { m.position.set(x, y, z); body.add(m); return m; };
  const cyl = (rt: number, rb: number, h: number, mat: THREE.Material, seg = 24, open = false) =>
    new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat);
  const box = (w: number, h: number, d: number, mat: THREE.Material) =>
    new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

  // ---- spine + hub
  const spine = cyl(1.0, 1.0, 58, hull, 16); spine.rotation.z = Math.PI / 2; add(spine);
  add(box(8.5, 6.2, 8.5, hull));
  const hubCap = box(9.4, 1.0, 9.4, dark); add(hubCap, 0, 3.4, 0); add(box(9.4, 1.0, 9.4, dark), 0, -3.4, 0);
  for (const s of [-1, 1]) {
    const cap = cyl(1.6, 1.1, 2.6, dark, 16); cap.rotation.z = Math.PI / 2; add(cap, s * 29.5, 0, 0);
    const nozzle = cyl(0.9, 1.5, 1.4, dark, 16, true); nozzle.rotation.z = Math.PI / 2; add(nozzle, s * 31.2, 0, 0);
  }

  // ---- solar wings: vertical panels on cross-struts
  for (const s of [-1, 1]) {
    for (const k of [0, 1]) {
      const x = s * (10.5 + k * 11.2);
      add(box(10, 17, 0.14, panelMat), x, 1.5, 0);
      add(box(10.2, 0.28, 0.4, dark), x, 10.1, 0);
      add(box(10.2, 0.28, 0.4, dark), x, -7.1, 0);
      add(box(0.3, 17.2, 0.4, dark), x - 5, 1.5, 0);
    }
    add(box(0.5, 0.5, 0.5, dark), s * 7.6, 1.5, 0);
  }

  // ---- radiators + dish + masts
  for (const s of [-1, 1]) {
    add(box(0.12, 8.5, 18, white), s * 5.0, 9.4, 0);
    add(box(0.6, 1.6, 0.6, dark), s * 5.0, 5.2, 0);
  }
  const dish = new THREE.Mesh(new THREE.SphereGeometry(2.6, 28, 12, 0, TWO_PI, 0, Math.PI / 2.4), white.clone());
  (dish.material as THREE.MeshStandardNodeMaterial).side = THREE.DoubleSide;
  dish.rotation.x = -0.5; add(dish, 0, 8.2, -2.0);
  add(cyl(0.12, 0.12, 4.2, dark, 8), 0, 5.8, -1.2);
  add(cyl(0.05, 0.05, 9, dark, 6), -2.6, 8.0, 2.6);
  add(cyl(0.05, 0.05, 6, dark, 6), 2.8, 7.0, 2.2);

  // ---- greebles scattered over the hub and spine
  const greeble = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), dark, 90);
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    for (let i = 0; i < 90; i++) {
      const onHub = i < 36;
      const a = Math.random() * TWO_PI;
      if (onHub) p.set((Math.random() - 0.5) * 8, (Math.random() < 0.5 ? 1 : -1) * 3.6, (Math.random() - 0.5) * 8);
      else p.set((Math.random() - 0.5) * 52, Math.sin(a) * 1.15, Math.cos(a) * 1.15);
      sc.set(0.3 + Math.random() * 1.1, 0.2 + Math.random() * 0.5, 0.3 + Math.random() * 1.1);
      q.setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0));
      m.compose(p, q, sc); greeble.setMatrixAt(i, m);
    }
    greeble.instanceMatrix.needsUpdate = true;
    body.add(greeble);
  }

  // ---- the lance: mount, bore, coil housings, rails, muzzle brake
  add(cyl(3.6, 3.0, 1.8, dark, 32), 0, -4.4, 0);
  add(cyl(2.0, 2.0, 22.5, barrelMat, 32), 0, -15.6, 0);
  for (let i = 0; i < N_RINGS; i++) add(cyl(2.8, 2.8, 0.95, hull, 36), 0, RING_Y0 + 0.0 - i * RING_DY - 0.0, 0);
  for (const [x, z] of [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) add(box(x ? 0.35 : 1.2, 19, x ? 1.2 : 0.35, dark), x, -15.5, z);
  const brake = cyl(2.5, 3.4, 2.0, dark, 36, true); brake.material = dark.clone();
  (brake.material as THREE.MeshStandardNodeMaterial).side = THREE.DoubleSide;
  add(brake, 0, -27.5, 0);
  // inner bore glow — stays dark until the capacitors fill
  const bore = new THREE.Mesh(
    new THREE.CircleGeometry(2.3, 40).rotateX(Math.PI / 2),
    new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  (bore.material as THREE.MeshBasicNodeMaterial).colorNode = Fn(() => {
    const r = uv().sub(0.5).length().mul(2.0);
    const e = U.charge.mul(0.9).add(U.muzzle.mul(6.0));
    return vec4(mix(vec3(0.3, 0.6, 1.0), vec3(1.0, 1.0, 1.0), U.muzzle.min(1.0)).mul(e).mul(smoothstep(1.0, 0.1, r).mul(0.8).add(0.2)), 1.0);
  })();
  add(bore, 0, -28.2, 0);

  // ---- capacitor ring glow (instanced, intensities driven per frame)
  const glowGeo = new THREE.TorusGeometry(2.95, 0.14, 10, 56).rotateX(Math.PI / 2);
  const glowMat = new THREE.MeshBasicNodeMaterial();
  glowMat.colorNode = Fn(() => vec4(0.5, 0.82, 1.0, 1.0))();
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, N_RINGS);
  {
    const m = new THREE.Matrix4();
    for (let i = 0; i < N_RINGS; i++) {
      m.makeTranslation(0, RING_Y0 - i * RING_DY - 0.55, 0);
      glow.setMatrixAt(i, m); glow.setColorAt(i, new THREE.Color(0, 0, 0));
    }
    glow.instanceMatrix.needsUpdate = true;
    body.add(glow);
  }

  // ---- coil lightning: stateless bead arcs hopping ring-to-ring and onto the hull
  const ARCS = 16, BEADS = 24;
  const aA = new Float32Array(ARCS * BEADS * 4), aB = new Float32Array(ARCS * BEADS * 4);
  for (let k = 0; k < ARCS; k++) {
    const i = k % (N_RINGS - 1);
    const a0 = Math.random() * TWO_PI, a1 = a0 + (Math.random() - 0.5) * 1.6;
    const y0 = RING_Y0 - i * RING_DY - 0.55, y1 = y0 - RING_DY;
    for (let b = 0; b < BEADS; b++) {
      const o = (k * BEADS + b) * 4;
      aA[o] = Math.cos(a0) * 3.0; aA[o + 1] = y0; aA[o + 2] = Math.sin(a0) * 3.0; aA[o + 3] = k + Math.random() * 0.01;
      aB[o] = Math.cos(a1) * 3.0; aB[o + 1] = y1; aB[o + 2] = Math.sin(a1) * 3.0; aB[o + 3] = 0.5 + Math.random() * 0.9;
    }
  }
  const AA = attr(new THREE.InstancedBufferAttribute(aA, 4)), AB = attr(new THREE.InstancedBufferAttribute(aB, 4));
  const arcMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const bead = () => instanceIndex.mod(BEADS).toFloat().add(0.5).div(BEADS);
  const arcAct = () => {
    const tq = floor(U.time.mul(13.0));
    const r = hash(AA.w.mul(91.7).add(tq));
    const sinceFire = U.time.sub(U.tFire);
    const burst = exp(sinceFire.mul(-2.2)).mul(step(0.0, sinceFire)).mul(1.2);
    return step(r, U.charge.mul(0.85).add(burst)).mul(step(0.04, U.charge.add(burst)));
  };
  arcMat.positionNode = Fn(() => {
    const s = bead();
    const tq = floor(U.time.mul(26.0));
    const k = s.mul(7.0).add(AA.w.mul(31.0));
    const j = vec3(mx_noise_float(vec3(k, tq, 1.3)), mx_noise_float(vec3(k, tq, 7.1)), mx_noise_float(vec3(k, tq, 13.7)));
    return mix(AA.xyz, AB.xyz, s).add(j.mul(sin(s.mul(Math.PI)).mul(AB.w)));
  })();
  arcMat.scaleNode = Fn(() => { const z = float(0.13).mul(arcAct()); return vec2(z, z); })();
  arcMat.colorNode = Fn(() => vec4(vec3(0.6, 0.85, 1.0).mul(4.0).mul(arcAct()), arcAct()))();
  const arcs = new THREE.Sprite(arcMat);
  arcs.count = ARCS * BEADS; arcs.frustumCulled = false; arcs.renderOrder = 20;
  body.add(arcs);

  // ---- launch shock rings spreading from the muzzle along the bore axis
  for (let i = 0; i < 3; i++) {
    const rm = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const delay = i * 0.09;
    const age = () => U.time.sub(U.tFire).sub(0.3).sub(delay);
    rm.positionNode = Fn(() => {
      const a = age().max(0.0);
      const rad = float(3.5).add(float(1.0).sub(exp(a.mul(-2.6))).mul(30.0));
      return vec3(positionLocal.x.mul(rad), positionLocal.y.add(a.mul(30.0).negate()), positionLocal.z.mul(rad));
    })();
    rm.colorNode = Fn(() => {
      const a = age();
      const e = exp(a.max(0.0).mul(-2.6)).mul(step(0.0, a)).mul(1.7);
      return vec4(vec3(0.6, 0.85, 1.0).mul(e), 1.0);
    })();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.0, 96).rotateX(Math.PI / 2), rm);
    ring.position.set(0, MUZZLE_LOCAL.y - 0.4, 0);
    ring.frustumCulled = false; ring.renderOrder = 21;
    body.add(ring);
  }

  // ---- muzzle flash star
  const fm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  fm.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2.0);
    const r = p.length();
    const core = smoothstep(0.35, 0.0, r).mul(6.0).add(exp(r.mul(-5.0)).mul(1.4));
    const sx = exp(abs(p.x).mul(-3.0)).mul(exp(abs(p.y).mul(-55.0))).mul(2.4);
    const sy = exp(abs(p.y).mul(-3.0)).mul(exp(abs(p.x).mul(-55.0))).mul(1.4);
    const e = core.add(sx).add(sy).mul(U.muzzle).mul(smoothstep(1.0, 0.7, r.max(abs(p.x).mul(0.5))));
    return vec4(mix(vec3(0.6, 0.85, 1.0), vec3(1.0, 1.0, 1.0), U.muzzle.min(1.0)).mul(e), e.min(1.0));
  })();
  const flash = new THREE.Sprite(fm);
  flash.position.set(0, MUZZLE_LOCAL.y - 1.0, 0);
  flash.scale.setScalar(70);
  flash.renderOrder = 22; flash.frustumCulled = false;
  body.add(flash);

  // ---- running lights
  const navGeo = new THREE.SphereGeometry(0.32, 10, 8);
  const nav = new THREE.InstancedMesh(navGeo, new THREE.MeshBasicNodeMaterial(), 6);
  const navPos: [number, number, number, number][] = [
    [-32, 0, 0, 0], [32, 0, 0, 1], [-26.5, 10.4, 0, 2], [26.5, 10.4, 0, 2], [0, 6.6, -1, 2], [0, -29.0, 0, 3],
  ];
  {
    const m = new THREE.Matrix4();
    navPos.forEach((n, i) => { m.makeTranslation(n[0], n[1], n[2]); nav.setMatrixAt(i, m); nav.setColorAt(i, new THREE.Color(0, 0, 0)); });
    nav.instanceMatrix.needsUpdate = true;
    body.add(nav);
  }
  const NAV_COL = [new THREE.Color(1, 0.1, 0.05), new THREE.Color(0.1, 1, 0.3), new THREE.Color(1, 1, 1), new THREE.Color(1, 0.4, 0.1)];
  const tmp = new THREE.Color();

  const update = (s: PlatformState) => {
    body.position.y = s.recoil;
    const tt = s.t;

    // capacitor rings: fill top→bottom with charge, shimmer, then carry the launch pulse down the bore
    const sweep = s.sinceFire > 0 ? (s.sinceFire / 0.32) * (N_RINGS + 2) : -9;
    const afterglow = s.sinceFire > 0 ? Math.exp(-s.sinceFire * 0.55) : 0;
    for (let i = 0; i < N_RINGS; i++) {
      const on = s.sinceFire > 0 ? 0 : THREE.MathUtils.smoothstep(s.charge, i / N_RINGS * 0.9, i / N_RINGS * 0.9 + 0.12);
      const shimmer = 0.75 + 0.25 * Math.sin(tt * 9 - i * 0.9);
      let I = on * shimmer * (0.9 + s.charge * 1.6);
      I += Math.exp(-Math.pow(i - sweep, 2) / 1.3) * 7.0 * (s.sinceFire > 0 && s.sinceFire < 0.8 ? 1 : 0);
      I += afterglow * 0.7 * (i / N_RINGS);
      tmp.setRGB(0.45, 0.8, 1.0).lerp(new THREE.Color(1.0, 0.55, 0.25), afterglow * 0.7).multiplyScalar(I);
      glow.setColorAt(i, tmp);
    }
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;

    for (let i = 0; i < 6; i++) {
      const kind = navPos[i][3];
      const blink = kind === 2 ? (Math.sin(tt * 3.0 + i) > 0.6 ? 1 : 0.05) : kind === 3 ? (0.4 + s.charge * 1.6) : (Math.sin(tt * 1.7 + i) > 0 ? 1.0 : 0.2);
      nav.setColorAt(i, tmp.copy(NAV_COL[kind]).multiplyScalar(blink * 2.5));
    }
    if (nav.instanceColor) nav.instanceColor.needsUpdate = true;
  };

  const muzzleWorld = (out: THREE.Vector3) => {
    group.updateMatrixWorld(true);
    return out.copy(MUZZLE_LOCAL).applyMatrix4(body.matrixWorld);
  };

  return { group, muzzleWorld, update };
}
