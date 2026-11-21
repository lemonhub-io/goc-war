// impact.ts — ground-zero effects, all closed-form in age = U.time - U.tImpact
// so the director can seek anywhere in the loop: flash dome, shock ring and
// dust wall, condensation ring, the mushroom column (analytic toroidal
// vortex cap + swirling stem), ballistic debris with streak trails, ember fall.
// U.yieldK (earned by the operator's release timing) sizes the blast: dome,
// fireball, column, debris throw and flash all scale with it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, hash, mix, smoothstep, pow, abs, sin, cos, exp, fract, step, sqrt,
  normalize, max, clamp, texture, uv, mx_noise_float, positionLocal, normalView, instanceIndex,
} from 'three/tsl';
import { U, TWO_PI, V3, field, attr, asScalar, emberRamp, makeSmokeTexture } from './shared';

const pl: any = field(positionLocal);
import { SHOCK_C0, SHOCK_K } from './ground';

const age = () => U.time.sub(U.tImpact);
const ageP = () => max(age(), 0.0);
const live = () => step(0.0, age());
const shockR = (a: any) => a.mul(SHOCK_C0).div(a.mul(SHOCK_K).add(1.0));
/** size scale for volumes that grow with yield — square root, so a big strike reads bigger yet stays in frame */
const ysz = () => asScalar(field(U.yieldK).sqrt());

function additive(extra: object = {}) {
  return new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false, ...extra,
  });
}

// ------------------------------------------------------------------ flash dome + shock

function buildFlashDome(): THREE.Mesh {
  const mat = additive();
  mat.positionNode = Fn(() => {
    const a = ageP();
    const R = float(62.0).mul(U.yieldK).mul(float(1.0).sub(exp(a.mul(-6.5)))).add(0.01);
    return pl.mul(R);
  })();
  mat.colorNode = Fn(() => {
    const a = ageP();
    const rim = pow(float(1.0).sub(abs(normalView.z)), 1.6);
    const n = mx_noise_float(vec3(uv().x.mul(18.0), uv().y.mul(18.0), U.time.mul(5.0))).mul(0.3).add(0.8);
    const col = mix(vec3(1.0, 0.97, 0.88), vec3(1.0, 0.42, 0.1), smoothstep(0.0, 0.9, a));
    const e = exp(a.mul(-4.6)).mul(live()).mul(rim.mul(1.6).add(0.55)).mul(n).mul(7.0);
    return vec4(col.mul(e), 1.0);
  })();
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 56, 28, 0, TWO_PI, 0, Math.PI / 2), mat);
  m.frustumCulled = false; m.renderOrder = 30;
  return m;
}

function buildShock(): THREE.Group {
  const g = new THREE.Group();

  // bright leading ring on the ground
  const rm = additive();
  rm.positionNode = Fn(() => {
    const R = shockR(ageP());
    return V3(pl.x.mul(R), pl.y.add(0.5), pl.z.mul(R));
  })();
  rm.colorNode = Fn(() => {
    const a = ageP();
    const e = exp(a.mul(-0.7)).mul(live()).mul(2.2).mul(U.yieldK);
    return vec4(vec3(1.0, 0.82, 0.58).mul(e), 1.0);
  })();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.965, 1.0, 180).rotateX(-Math.PI / 2), rm);
  ring.frustumCulled = false; ring.renderOrder = 31;
  g.add(ring);

  // dust wall: a low turbulent skirt riding the front, lit orange from behind
  const dm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  dm.positionNode = Fn(() => {
    const a = ageP();
    const R = shockR(a).mul(0.97);
    const H = float(3.0).add(exp(a.mul(-0.3)).mul(24.0)).mul(smoothstep(0.0, 0.25, a));
    return V3(pl.x.mul(R), pl.y.mul(H), pl.z.mul(R));
  })();
  dm.colorNode = Fn(() => {
    const p = uv();
    const a = ageP();
    const ang = p.x.mul(TWO_PI);
    const n = mx_noise_float(vec3(cos(ang).mul(5.0), sin(ang).mul(5.0), p.y.mul(3.2).sub(U.time.mul(1.1)))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(cos(ang).mul(14.0), sin(ang).mul(14.0), p.y.mul(7.0).add(U.time.mul(0.7)))).mul(0.5).add(0.5);
    const cover = smoothstep(0.15, 0.7, n.mul(0.7).add(n2.mul(0.35))).mul(pow(float(1.0).sub(p.y), 0.7));
    const hotEdge = exp(p.y.mul(-6.0)).mul(exp(a.mul(-0.5))).mul(vec3(1.0, 0.45, 0.12)).mul(2.0);
    const dust = vec3(0.2, 0.15, 0.12).add(vec3(0.6, 0.24, 0.07).mul(U.fire).mul(0.5));
    const alpha = cover.mul(exp(a.mul(-0.16))).mul(live()).mul(smoothstep(0.0, 0.3, a)).mul(0.95);
    return vec4(dust.add(hotEdge.mul(cover)), alpha);
  })();
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 160, 1, true).translate(0, 0.5, 0), dm);
  wall.frustumCulled = false; wall.renderOrder = 28;
  g.add(wall);

  // condensation ring — the Wilson-cloud halo racing outward overhead
  const cm = additive();
  cm.positionNode = Fn(() => {
    const a = ageP();
    const R = float(170.0).mul(float(1.0).sub(exp(a.mul(-1.3)))).add(0.1);
    return V3(pl.x.mul(R), pl.y.add(float(16.0).add(a.mul(2.2))), pl.z.mul(R));
  })();
  cm.colorNode = Fn(() => {
    const a = ageP();
    const e = exp(a.sub(0.5).max(0.0).mul(-0.9)).mul(smoothstep(0.3, 0.55, a)).mul(live()).mul(1.8);
    return vec4(vec3(0.75, 0.88, 1.0).mul(e), 1.0);
  })();
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.93, 1.0, 180).rotateX(-Math.PI / 2), cm);
  halo.frustumCulled = false; halo.renderOrder = 31;
  g.add(halo);
  return g;
}

// ------------------------------------------------------------------ mushroom column

function seeds(n: number): Float32Array {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) a[i] = Math.random();
  return a;
}

/** analytic cloud: returns { pos, isCap, hc, yFrac } for a sprite's seed vector */
function mushroom(S: any) {
  const a = ageP();
  const ys = ysz();
  const hc = float(8.0).add(float(112.0).mul(float(1.0).sub(exp(a.mul(-0.17)))).mul(ys));
  const rc = float(4.0).add(float(40.0).mul(float(1.0).sub(exp(a.mul(-0.2)))).mul(ys));
  const rt = rc.mul(0.55);
  // toroidal cap: tube sections roll — rising in the middle, falling at the rim
  const psi = S.x.mul(TWO_PI).add(a.mul(0.05));
  const th = S.y.mul(TWO_PI).add(a.mul(S.z.mul(0.5).add(0.75)).mul(1.5));
  const rr = rt.mul(sqrt(S.w));
  const capR = rc.add(rr.mul(cos(th)));
  const cap = vec3(cos(psi).mul(capR), hc.add(rr.mul(sin(th)).mul(0.8)), sin(psi).mul(capR));
  // swirling stem, flared into a pedestal at the base
  const sy = pow(S.y, 0.85);
  const yS = sy.mul(hc);
  const rS = float(3.2).add(pow(float(1.0).sub(sy), 3.0).mul(8.0)).add(sin(yS.mul(0.22).sub(a.mul(1.2)).add(S.x.mul(20.0))).mul(1.4));
  const psiS = S.x.mul(TWO_PI).add(yS.mul(0.22)).sub(a.mul(0.6));
  const rad = rS.mul(sqrt(S.w));
  const stem = vec3(cos(psiS).mul(rad), yS, sin(psiS).mul(rad));
  // opening fireball
  const rf = float(46.0).mul(ys).mul(float(1.0).sub(exp(a.mul(-3.0))));
  const dirv = normalize(vec3(hash(S.x.mul(91.7)).mul(2.0).sub(1.0), hash(S.y.mul(53.3)).mul(1.4).sub(0.2), hash(S.z.mul(77.1)).mul(2.0).sub(1.0)).add(0.001));
  const ball = dirv.mul(rf.mul(sqrt(S.w))).add(vec3(0.0, rf.mul(0.7), 0.0));
  const isCap = step(S.z, 0.55);
  const body = mix(stem, cap, isCap);
  const pos = mix(ball, body, smoothstep(0.15, 2.4, a));
  return { pos, isCap, hc, yFrac: sy, a };
}

function buildMushroom(): { smoke: THREE.Sprite; fire: THREE.Sprite } {
  const tex = makeSmokeTexture();

  // ---- smoke body
  const NS = 3600;
  const SA = attr(new THREE.InstancedBufferAttribute(seeds(NS), 4));
  const sm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: false });
  sm.positionNode = Fn(() => mushroom(SA).pos)();
  sm.scaleNode = Fn(() => {
    const m = mushroom(SA);
    const grow = float(1.0).sub(exp(m.a.mul(-0.8))).mul(0.6).add(0.4);
    const s = mix(float(8.0), float(22.0), SA.w).mul(grow).mul(U.puffScale);
    return vec2(s, s);
  })();
  sm.rotationNode = Fn(() => SA.x.mul(TWO_PI).add(U.time.mul(SA.y.sub(0.5)).mul(0.3)))();
  sm.colorNode = Fn(() => {
    const m = mushroom(SA);
    const t = texture(tex, uv());
    const y = m.pos.y;
    const glow = m.isCap.mul(exp(m.a.mul(-0.22))).mul(1.1).add(exp(y.div(-30.0)).mul(exp(m.a.mul(-0.1))).mul(1.0));
    const base = vec3(0.17, 0.135, 0.12).add(vec3(0.03, 0.05, 0.1).mul(smoothstep(30.0, 110.0, y)));
    const col = base.add(vec3(1.0, 0.42, 0.12).mul(glow).mul(SA.w.mul(0.8).add(0.5)));
    const a = t.a.mul(0.5).mul(smoothstep(0.0, 0.18, m.a)).mul(live()).mul(SA.x.mul(0.4).add(0.6))
      .mul(smoothstep(60.0, 25.0, m.a));
    return vec4(col as any, a as any);
  })();
  const smoke = new THREE.Sprite(sm);
  smoke.count = NS; smoke.userData.baseCount = NS; smoke.frustumCulled = false; smoke.renderOrder = 27;

  // ---- incandescent core
  const NF = 2400;
  const FA = attr(new THREE.InstancedBufferAttribute(seeds(NF), 4));
  const fm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  fm.positionNode = Fn(() => mushroom(FA).pos)();
  fm.scaleNode = Fn(() => {
    const m = mushroom(FA);
    const s = mix(float(6.0), float(15.0), FA.w).mul(float(1.0).sub(exp(m.a.mul(-1.5))).mul(0.5).add(0.5)).mul(U.puffScale);
    return vec2(s, s);
  })();
  fm.colorNode = Fn(() => {
    const m = mushroom(FA);
    const t = texture(tex, uv());
    const heat = clamp(m.a.mul(0.07).add(FA.w.mul(0.25)), 0.0, 1.0);
    const e = exp(m.a.mul(-0.17)).mul(smoothstep(0.0, 0.1, m.a)).mul(live());
    const hot = emberRamp(heat).mul(3.6);
    const a = t.a.mul(e).mul(0.6);
    return vec4(hot.mul(a), a);
  })();
  const fire = new THREE.Sprite(fm);
  fire.count = NF; fire.userData.baseCount = NF; fire.frustumCulled = false; fire.renderOrder = 29;
  return { smoke, fire };
}

// ------------------------------------------------------------------ debris + embers

function buildDebris(): THREE.Sprite {
  const N = 460, TR = 8;
  const base = seeds(N);
  const rep = new Float32Array(N * TR * 4);
  for (let i = 0; i < N; i++) for (let k = 0; k < TR; k++) rep.set(base.subarray(i * 4, i * 4 + 4), (i * TR + k) * 4);
  const S = attr(new THREE.InstancedBufferAttribute(rep, 4));
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const kk = () => instanceIndex.mod(TR).toFloat();
  const tauF = () => ageP().sub(kk().mul(0.012)).sub(S.w.mul(0.08));
  const path = () => {
    const tau = tauF().max(0.0);
    const az = S.x.mul(TWO_PI);
    const ys = ysz();
    const vh = float(10.0).add(pow(S.y, 1.4).mul(66.0)).mul(ys);
    const vy = float(24.0).add(S.z.mul(92.0)).mul(ys);
    const g = 55.0;
    const tg = vy.mul(2.0).div(g);
    const tl = tau.min(tg);
    const slide = float(1.0).sub(exp(tau.sub(tg).max(0.0).mul(-3.0))).mul(0.18).mul(tau.sub(tg).max(0.0).min(0.6));
    const horiz = tl.add(slide);
    const y = max(vy.mul(tau).sub(tau.mul(tau).mul(0.5 * g)), 0.0);
    return { p: V3(cos(az).mul(vh).mul(horiz), y.add(0.3), sin(az).mul(vh).mul(horiz)), tau, tg };
  };
  mat.positionNode = Fn(() => path().p)();
  mat.scaleNode = Fn(() => {
    const k = kk();
    const s = float(0.7).mul(float(1.0).sub(k.div(TR).mul(0.7))).mul(S.w.mul(0.6).add(0.6));
    return vec2(s as any, s as any).mul(live());
  })();
  mat.colorNode = Fn(() => {
    const r = uv().sub(0.5).length().mul(2.0);
    const shape = smoothstep(1.0, 0.1, r);
    const { tau, tg } = path();
    const k = kk();
    const flying = step(tau, tg);
    const landed = float(1.0).sub(flying);
    const trailFade = pow(float(1.0).sub(k.div(TR)), 1.5);
    const head = emberRamp(clamp(k.div(TR).mul(0.6).add(tau.mul(0.18)), 0.0, 1.0)).mul(5.5).mul(trailFade).mul(flying);
    const cool = emberRamp(clamp(tau.sub(tg).mul(0.08).add(0.35), 0.0, 1.0)).mul(exp(tau.sub(tg).max(0.0).mul(-0.28))).mul(1.3).mul(landed).mul(step(k, 0.5));
    const a = shape.mul(live()).mul(step(0.001, tauF()));
    return vec4(head.add(cool).mul(a), a);
  })();
  const s = new THREE.Sprite(mat);
  s.count = N * TR; s.userData.baseCount = N * TR; s.frustumCulled = false; s.renderOrder = 32;
  return s;
}

function buildEmbers(): THREE.Sprite {
  const N = 3000;
  const S = attr(new THREE.InstancedBufferAttribute(seeds(N), 4));
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const delay = () => S.z.mul(7.0).add(2.0);
  const t = () => ageP().sub(delay());
  mat.positionNode = Fn(() => {
    const r = sqrt(S.x).mul(170.0).add(6.0);
    const ang = S.y.mul(TWO_PI);
    const fall = S.w.mul(5.0).add(3.0);
    const y = float(34.0).add(S.x.mul(40.0)).sub(t().max(0.0).mul(fall));
    const sway = sin(t().mul(0.9).add(S.y.mul(40.0))).mul(1.4);
    return V3(cos(ang).mul(r).add(sway), y.max(0.25), sin(ang).mul(r).add(sway.mul(0.7)));
  })();
  mat.scaleNode = Fn(() => { const s = S.w.mul(0.14).add(0.12); return vec2(s, s).mul(live()); })();
  mat.colorNode = Fn(() => {
    const r = uv().sub(0.5).length().mul(2.0);
    const shape = smoothstep(1.0, 0.1, r);
    const tt = t();
    const fall = S.w.mul(5.0).add(3.0);
    const y = float(34.0).add(S.x.mul(40.0)).sub(tt.max(0.0).mul(fall));
    const flick = sin(U.time.mul(11.0).add(S.x.mul(80.0))).mul(0.3).add(0.7);
    const heat = clamp(tt.mul(0.05).add(S.w.mul(0.3)), 0.0, 1.0);
    const a = shape.mul(step(0.0, tt)).mul(smoothstep(0.0, 0.6, y)).mul(flick).mul(exp(tt.max(0.0).mul(-0.05)));
    return vec4((emberRamp(heat) as any).mul(2.6).mul(a), a as any);
  })();
  const s = new THREE.Sprite(mat);
  s.count = N; s.userData.baseCount = N; s.frustumCulled = false; s.renderOrder = 33;
  return s;
}

// ------------------------------------------------------------------ blast flash sprite

function buildBlastGlow(): THREE.Sprite {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  mat.colorNode = Fn(() => {
    const r = uv().sub(0.5).length().mul(2.0);
    const a = ageP();
    const flashE = exp(a.mul(-3.4)).mul(14.0).mul(U.yieldK);
    const fireE = U.fire.mul(0.9);
    const e = exp(r.mul(-3.6)).mul(flashE.add(fireE)).mul(live());
    const col = mix(vec3(1.0, 0.45, 0.14), vec3(1.0, 0.95, 0.85), exp(a.mul(-2.2)));
    return vec4(col.mul(e), e.min(1.0));
  })();
  const s = new THREE.Sprite(mat);
  s.position.set(0, 16, 0);
  s.scale.setScalar(190);
  s.renderOrder = 34; s.frustumCulled = false;
  return s;
}

// ------------------------------------------------------------------ assembly

export function buildImpact(): THREE.Group {
  const g = new THREE.Group();
  g.add(buildFlashDome(), buildShock(), buildBlastGlow());
  const m = buildMushroom();
  g.add(m.smoke, m.fire, buildDebris(), buildEmbers());
  return g;
}

void vec4; void fract;
