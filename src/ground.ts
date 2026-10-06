// ground.ts — the ground world: night terrain with a crater that opens at
// ground zero, city lights and buildings that are razed as the shockwave
// reaches them, flames in the rubble, cloud decks the rod tears through, and
// the sky dome. Everything reacts to age = U.time - U.tImpact (stateless).
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, hash, mix, smoothstep, pow, abs, sin, cos, exp, fract, floor, step,
  dot, cross, normalize, max, min, clamp, texture, uv, mx_noise_float,
  positionLocal, positionGeometry, positionWorld, cameraPosition, select,
} from 'three/tsl';
import { U, TWO_PI, V3, field, attr, emberRamp, makeFlameTexture } from './shared';
import { starColor } from './space';

// shock model shared with the impact FX: R(τ) = C0·τ / (1 + K·τ); arrival(d) = d / (C0 − K·d)
export const SHOCK_C0 = 75.0;
export const SHOCK_K = 0.35;
export const SHOCK_MAX = SHOCK_C0 / SHOCK_K - 6.0;

const shockR = (age: any) => age.mul(SHOCK_C0).div(age.mul(SHOCK_K).add(1.0));
const arrival = (d: any) => d.div(float(SHOCK_C0).sub(d.mul(SHOCK_K)).max(1.0));

// ------------------------------------------------------------------ terrain

/** polar grid, dense toward the centre so the crater has vertices to move */
function polarGrid(rMin: number, rMax: number, nTheta: number, nR: number, power: number): THREE.BufferGeometry {
  const pos = new Float32Array((nR + 1) * (nTheta + 1) * 3);
  const idx: number[] = [];
  for (let i = 0; i <= nR; i++) {
    const r = rMin + (rMax - rMin) * Math.pow(i / nR, power);
    for (let j = 0; j <= nTheta; j++) {
      const th = (j / nTheta) * TWO_PI;
      const o = (i * (nTheta + 1) + j) * 3;
      pos[o] = Math.cos(th) * r; pos[o + 1] = 0; pos[o + 2] = Math.sin(th) * r;
    }
  }
  for (let i = 0; i < nR; i++) {
    for (let j = 0; j < nTheta; j++) {
      const a = i * (nTheta + 1) + j, b = a + nTheta + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** ground height: flat plains around ground zero, mountains rising past ~5 km */
export const heightAt = (x: any, z: any): any => {
  const r = vec2(x, z).length();
  const m = smoothstep(450.0, 1300.0, r);
  const n1 = mx_noise_float(vec3(x.mul(0.004), z.mul(0.004), 3.3));
  const n2 = mx_noise_float(vec3(x.mul(0.016), z.mul(0.016), 7.7));
  const n3 = mx_noise_float(vec3(x.mul(0.07), z.mul(0.07), 1.1));
  const mount = pow(n1.mul(0.5).add(0.5), 1.6).mul(m).mul(70.0).add(n2.mul(m).mul(12.0));
  return mount.add(n3.mul(0.1)).add(n2.mul(0.3));
};

const craterAt = (d: any, age: any): any => {
  const a = max(age, 0.0);
  const live = step(0.0, age);
  const Rc = float(7.5).mul(float(1.0).sub(exp(a.mul(-5.0)))).add(0.01);
  const q = d.div(Rc);
  const bowl = max(float(1.0).sub(q.mul(q)), 0.0).pow(1.2).mul(-2.6);
  const rim = exp(d.sub(Rc.mul(1.12)).div(1.5).pow(2.0).negate()).mul(0.9);
  return bowl.add(rim).mul(live);
};

const TERRAIN_FOG = vec3(0.022, 0.045, 0.08);

function terrainMaterial(withCrater: boolean): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
  const age = () => U.time.sub(U.tImpact);
  mat.positionNode = Fn(() => {
    const x = positionLocal.x, z = positionLocal.z;
    let y = heightAt(x, z);
    if (withCrater) y = y.add(craterAt(vec2(x, z).length(), age()));
    return vec3(x, y, z);
  })();
  mat.colorNode = Fn(() => {
    const wp = positionWorld;
    const d = vec2(wp.x, wp.z).length();
    const a = age();
    const aP = max(a, 0.0);
    const live = step(0.0, a);

    const n = mx_noise_float(vec3(wp.x.mul(0.03), wp.z.mul(0.03), 0.7)).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(wp.x.mul(0.2), wp.z.mul(0.2), 4.1)).mul(0.5).add(0.5);
    let col: any = mix(vec3(0.012, 0.018, 0.024), vec3(0.034, 0.042, 0.04), n).mul(n2.mul(0.4).add(0.8));
    // moonlit relief + a faint cold cap on the high ground
    const hF = clamp(wp.y.div(55.0), 0.0, 1.0);
    col = col.add(vec3(0.05, 0.07, 0.1).mul(pow(hF, 1.4)));
    // field strips / roads — a faint grid so the descent has something to rush over
    const gx = smoothstep(0.03, 0.0, abs(fract(wp.x.mul(0.012)).sub(0.5)).sub(0.485));
    const gz = smoothstep(0.03, 0.0, abs(fract(wp.z.mul(0.012)).sub(0.5)).sub(0.485));
    col = col.add(vec3(0.02, 0.026, 0.034).mul(gx.max(gz)).mul(smoothstep(900.0, 300.0, d)));

    // ---- shock front sweeping the ground, charred plain behind it
    const Rs = shockR(aP);
    const front = exp(d.sub(Rs).div(aP.mul(0.8).add(1.5)).pow(2.0).negate()).mul(exp(aP.mul(-0.32))).mul(live);
    const scorch = smoothstep(Rs.add(2.0), Rs.sub(30.0).max(0.0), d).mul(live).mul(smoothstep(0.0, 0.5, aP)).mul(smoothstep(SHOCK_MAX, 40.0, d));
    col = mix(col, vec3(0.006, 0.005, 0.005), scorch.mul(0.7));

    // ---- crater: molten floor, glowing fracture lines, cooling
    const Rc = float(7.5).mul(float(1.0).sub(exp(aP.mul(-5.0)))).add(0.01);
    const crack = smoothstep(0.1, 0.0, abs(mx_noise_float(vec3(wp.x.mul(0.33), wp.z.mul(0.33), 2.2))));
    const heat = exp(aP.mul(-0.07)).mul(live);
    const molten = smoothstep(Rc.mul(1.05), Rc.mul(0.1), d).mul(heat).mul(n2.mul(0.8).add(0.5));
    const cracks = crack.mul(smoothstep(Rc.mul(2.6), Rc.mul(0.4), d)).mul(heat).mul(smoothstep(0.0, 1.0, aP));
    col = col.add(mix(vec3(1.0, 0.35, 0.06), vec3(1.0, 0.8, 0.45), molten.mul(0.7)).mul(molten.mul(3.2).add(cracks.mul(2.2))));
    col = col.add(vec3(1.0, 0.82, 0.58).mul(front).mul(2.4));

    // ---- firelight wash from the rising cloud
    const wash = vec3(1.0, 0.42, 0.12).mul(U.fire).mul(exp(d.mul(-0.013))).mul(n2.mul(0.9).add(0.35)).mul(0.75);
    col = col.add(wash.mul(col.length().mul(5.0).add(0.2)));

    // ---- distance haze, warmed by the fire
    const dc = positionWorld.sub(cameraPosition).length();
    const fog = float(1.0).sub(exp(dc.mul(-0.0013)));
    const fogCol = TERRAIN_FOG.add(vec3(0.6, 0.22, 0.06).mul(U.fire).mul(0.22));
    return vec4(mix(col, fogCol, fog.mul(0.92)), 1.0);
  })();
  return mat;
}

export function buildTerrain(): THREE.Group {
  const g = new THREE.Group();
  const near = new THREE.Mesh(polarGrid(0.01, 220, 220, 150, 2.1), terrainMaterial(true));
  const far = new THREE.Mesh(polarGrid(214, 3400, 200, 90, 1.7), terrainMaterial(false));
  for (const m of [near, far]) { m.frustumCulled = false; g.add(m); }
  return g;
}

// ------------------------------------------------------------------ sky

export function buildGroundSky(): THREE.Mesh {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.colorNode = Fn(() => {
    const dir = positionLocal.normalize();
    const up = dir.y;
    const hz = exp(abs(up).mul(-7.0));
    const zen = vec3(0.002, 0.004, 0.015);
    const horizon = vec3(0.03, 0.065, 0.12).add(vec3(0.18, 0.1, 0.05).mul(0.08));
    let col: any = mix(horizon.mul(hz.mul(0.7).add(0.3)), zen, smoothstep(0.0, 0.55, up));
    const stars = starColor(dir, 190.0).mul(smoothstep(0.03, 0.3, up)).mul(float(1.0).sub(U.fire.mul(0.8)));
    col = col.add(stars);
    col = col.add(vec3(1.0, 0.4, 0.1).mul(U.fire).mul(hz).mul(0.45));
    col = mix(col, vec3(0.006, 0.01, 0.016), smoothstep(0.0, -0.2, up));
    return vec4(col, 1.0);
  })();
  const m = new THREE.Mesh(new THREE.SphereGeometry(2900, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

// ------------------------------------------------------------------ cities

interface City { x: number; z: number; r: number; w: number }
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function makeCities(): { near: City[]; far: City[] } {
  const near: City[] = [];
  const angs = [0.2, 0.95, 1.7, 2.45, 3.1, 3.8, 4.5, 5.3, 5.9];
  angs.forEach((a, i) => {
    const d = 62 + (i % 3) * 38 + rnd(0, 20);
    near.push({ x: Math.sin(a) * d, z: Math.cos(a) * d, r: rnd(22, 42), w: rnd(0.7, 1.3) });
  });
  const far: City[] = [];
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * TWO_PI, d = rnd(230, 1750);
    far.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: rnd(40, 170), w: rnd(0.4, 1.4) });
  }
  return { near, far };
}

const pick = (cs: City[]) => {
  const tot = cs.reduce((s, c) => s + c.w, 0);
  let r = Math.random() * tot;
  for (const c of cs) { r -= c.w; if (r <= 0) return c; }
  return cs[0];
};

export function buildCityLights(cities: { near: City[]; far: City[] }): THREE.Sprite {
  const N = 16000;
  const pos = new Float32Array(N * 4);
  const all = [...cities.near, ...cities.far];
  for (let i = 0; i < N; i++) {
    let x: number, z: number;
    if (Math.random() < 0.12) {          // rural scatter
      const a = Math.random() * TWO_PI, d = rnd(40, 1800);
      x = Math.cos(a) * d; z = Math.sin(a) * d;
    } else {
      const c = pick(all);
      x = c.x + gauss() * c.r * 0.9; z = c.z + gauss() * c.r * 0.9;
      x = Math.round(x / 5) * 5 + rnd(-0.6, 0.6); z = Math.round(z / 5) * 5 + rnd(-0.6, 0.6);   // street grid
    }
    if (Math.hypot(x, z) < 16) { x += 30; }
    pos[i * 4] = x; pos[i * 4 + 1] = rnd(0.3, 0.9); pos[i * 4 + 2] = z; pos[i * 4 + 3] = Math.random();
  }
  const A = attr(new THREE.InstancedBufferAttribute(pos, 4));
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const dist = () => vec2(A.x, A.z).length();
  const tau = () => U.time.sub(U.tImpact).sub(arrival(dist()));
  const hit = () => step(0.0, tau()).mul(step(dist(), SHOCK_MAX));
  mat.positionNode = Fn(() => vec3(A.x, A.y, A.z))();
  mat.scaleNode = Fn(() => {
    const s = A.w.mul(1.0).add(0.7).add(dist().mul(0.0016));
    return vec2(s, s).mul(U.puffScale.mul(0.35).add(0.65));
  })();
  mat.colorNode = Fn(() => {
    const r = uv().sub(0.5).length().mul(2.0);
    const shape = smoothstep(1.0, 0.1, r);
    const tw = sin(U.time.mul(2.0).add(A.w.mul(90.0))).mul(0.15).add(0.85);
    const cool = step(0.82, A.w);
    const base = mix(vec3(1.0, 0.68, 0.32), vec3(0.75, 0.85, 1.0), cool).mul(2.0).mul(tw);
    const t = tau();
    // flash white-orange as the front arrives, then the lights go out
    const alive = float(1.0).sub(hit().mul(smoothstep(0.0, 0.35, t)));
    const flash = hit().mul(exp(t.max(0.0).mul(-4.5))).mul(vec3(1.0, 0.6, 0.25)).mul(5.0);
    return vec4(base.mul(alive).add(flash).mul(shape), shape.mul(alive.add(flash.x.mul(0.2)).min(1.0)));
  })();
  const s = new THREE.Sprite(mat);
  s.count = N; s.userData.baseCount = N; s.frustumCulled = false; s.renderOrder = 6;
  return s;
}

export interface Buildings { mesh: THREE.InstancedMesh; fires: THREE.Sprite }

export function buildBuildings(cities: { near: City[]; far: City[] }): Buildings {
  const N = 1500;
  const cData = new Float32Array(N * 4), sData = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const c = pick(cities.near);
    let x = 0, z = 0, k = 0;
    do { x = c.x + gauss() * c.r; z = c.z + gauss() * c.r; k++; } while (Math.hypot(x, z) < 26 && k < 8);
    const core = Math.max(0, 1 - Math.hypot(x - c.x, z - c.z) / c.r);
    const w = rnd(0.9, 2.3);
    cData[i * 4] = x; cData[i * 4 + 1] = z; cData[i * 4 + 2] = Math.random(); cData[i * 4 + 3] = 0;
    sData[i * 4] = w; sData[i * 4 + 1] = 1.6 + Math.pow(Math.random(), 2.4) * 17 * (0.35 + core); sData[i * 4 + 2] = w * rnd(0.8, 1.2); sData[i * 4 + 3] = 0;
  }
  const A = attr(new THREE.InstancedBufferAttribute(cData, 4));
  const B = attr(new THREE.InstancedBufferAttribute(sData, 4));

  const dist = () => vec2(A.x, A.y).length();
  const tau = () => U.time.sub(U.tImpact).sub(arrival(dist()));
  const hit = () => step(0.0, tau()).mul(step(dist(), SHOCK_MAX));

  const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
  mat.positionNode = Fn(() => {
    const t = tau();
    const h = hit();
    const fall = smoothstep(0.0, 1.5, t.max(0.0)).mul(h);
    const dv = normalize(vec3(A.x, 0.0, A.y).add(vec3(0.001, 0.0, 0.0)));
    const axis = vec3(dv.z, 0.0, dv.x.negate());
    const theta = fall.mul(A.z.mul(0.7).add(0.7)).mul(1.35);
    const pg = field(positionGeometry);
    const p = V3(pg.x.mul(B.x), pg.y.add(0.5).mul(B.y).mul(float(1.0).sub(fall.mul(0.55))), pg.z.mul(B.z));
    // Rodrigues rotation toppling the tower away from ground zero
    const c = cos(theta), s = sin(theta);
    const rotated = p.mul(c).add(cross(axis, p).mul(s)).add(axis.mul(dot(axis, p).mul(float(1.0).sub(c))));
    const push = dv.mul(smoothstep(0.0, 1.6, t.max(0.0)).mul(h).mul(B.y.mul(0.35).add(1.0)));
    const ground = heightAt(A.x, A.y);
    return vec3(A.x, ground, A.y).add(rotated).add(push);
  })();
  mat.colorNode = Fn(() => {
    const p = uv();
    const t = tau();
    const h = hit();
    const cols = floor(B.x.mul(2.2)).max(1.0);
    const rows = floor(B.y.mul(2.6)).max(2.0);
    const cell = vec2(floor(p.x.mul(cols)), floor(p.y.mul(rows)));
    const fx = fract(p.x.mul(cols)), fy = fract(p.y.mul(rows));
    const win = smoothstep(0.18, 0.28, fx).mul(smoothstep(0.82, 0.72, fx)).mul(smoothstep(0.22, 0.32, fy)).mul(smoothstep(0.8, 0.7, fy));
    const on = step(0.45, hash(cell.x.add(cell.y.mul(31.7)).add(A.z.mul(97.0))));
    const warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.8, 0.9, 1.0), step(0.8, hash(cell.x.add(A.z.mul(13.0)))));
    const alive = float(1.0).sub(h.mul(smoothstep(0.0, 0.3, t)));
    const body = vec3(0.016, 0.018, 0.024).add(vec3(0.02, 0.03, 0.05).mul(p.y));
    const lit = warm.mul(win).mul(on).mul(alive).mul(1.7);
    const heat = h.mul(exp(t.max(0.0).mul(-1.6))).mul(smoothstep(0.0, 0.12, t)).mul(vec3(1.0, 0.5, 0.15)).mul(3.5);
    const wash = vec3(1.0, 0.4, 0.12).mul(U.fire).mul(0.35).mul(exp(dist().mul(-0.01))).mul(p.y.mul(0.5).add(0.5));
    return vec4(body.mul(h.mul(-0.6).add(1.0)).add(lit).add(heat).add(wash), 1.0);
  })();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  const I = new THREE.Matrix4();
  for (let i = 0; i < N; i++) mesh.setMatrixAt(i, I);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  // flames licking up out of the rubble once the front has passed
  const tex = makeFlameTexture();
  const fm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const burn = () => {
    const t = tau();
    return smoothstep(0.5, 1.6, t).mul(exp(t.max(0.0).mul(-0.045))).mul(hit());
  };
  fm.positionNode = Fn(() => {
    const age = fract(U.time.mul(0.7).add(A.z.mul(9.0)));
    return vec3(
      A.x.add(sin(U.time.mul(2.0).add(A.z.mul(60.0))).mul(0.3)),
      heightAt(A.x, A.y).add(0.3).add(age.mul(B.y.mul(0.1).add(1.4))),
      A.y.add(cos(U.time.mul(1.7).add(A.z.mul(40.0))).mul(0.3)),
    );
  })();
  fm.scaleNode = Fn(() => {
    const age = fract(U.time.mul(0.7).add(A.z.mul(9.0)));
    const w = mix(B.x.mul(1.1).add(0.8), 0.12, age).mul(U.puffScale);
    return vec2(w, w.mul(2.2));
  })();
  fm.colorNode = Fn(() => {
    const age = fract(U.time.mul(0.7).add(A.z.mul(9.0)));
    const tx = texture(tex, vec2(uv().x, uv().y.oneMinus()));
    const hot = emberRamp(age.mul(0.8).add(0.05)).mul(2.8);
    const flicker = sin(U.time.mul(12.0).add(A.z.mul(80.0))).mul(0.3).add(0.7);
    const a = tx.a.mul(pow(age.oneMinus(), 1.3)).mul(flicker).mul(burn());
    return vec4(hot.mul(a), a);
  })();
  const fires = new THREE.Sprite(fm);
  fires.count = N; fires.userData.baseCount = N; fires.frustumCulled = false; fires.renderOrder = 12;
  return { mesh, fires };
}

// ------------------------------------------------------------------ cloud decks

export function buildClouds(): THREE.Group {
  const g = new THREE.Group();
  const heights = [360, 240, 140];
  heights.forEach((y, li) => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    mat.colorNode = Fn(() => {
      const wp = positionWorld;
      const drift = vec2(U.time.mul(1.6 + li * 0.7), U.time.mul(0.9));
      const q = vec2(wp.x.add(drift.x), wp.z.add(drift.y));
      const n1 = mx_noise_float(vec3(q.x.mul(0.0032), q.y.mul(0.0032), li * 3.1));
      const n2 = mx_noise_float(vec3(q.x.mul(0.009), q.y.mul(0.009), U.time.mul(0.03).add(li * 7.7)));
      const n3 = mx_noise_float(vec3(q.x.mul(0.026), q.y.mul(0.026), li * 1.3));
      const dens = n1.mul(0.55).add(n2.mul(0.3)).add(n3.mul(0.15)).add(0.12);
      const cover = smoothstep(0.0, 0.5, dens);
      const dR = wp.sub(U.rodPosG).length();
      const rodLight = vec3(1.0, 0.58, 0.26).mul(exp(dR.mul(dR).div(2.0 * 75.0 * 75.0).negate())).mul(U.reentry).mul(3.2);
      const fireUnder = vec3(1.0, 0.4, 0.1).mul(U.fire).mul(exp(vec2(wp.x, wp.z).length().mul(-0.006))).mul(1.5);
      const base = mix(vec3(0.02, 0.03, 0.05), vec3(0.06, 0.08, 0.12), n2.mul(0.5).add(0.5));
      const dc = vec2(wp.x.sub(cameraPosition.x), wp.z.sub(cameraPosition.z)).length();
      const near = smoothstep(2.0, 38.0, abs(cameraPosition.y.sub(wp.y)));
      const a = cover.mul(0.82).mul(near).mul(smoothstep(1500.0, 700.0, dc));
      return vec4(base.add(rodLight.mul(cover.mul(0.7).add(0.3))).add(fireUnder.mul(cover)), a);
    })();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), mat);
    m.position.y = y;
    m.frustumCulled = false;
    m.renderOrder = 8 + li;
    g.add(m);
  });
  return g;
}

// ------------------------------------------------------------------ assembly

export interface Ground {
  group: THREE.Group;
  /** keep the sky centred on the camera */
  follow(camera: THREE.Camera): void;
}

export function buildGround(): Ground {
  const group = new THREE.Group();
  const sky = buildGroundSky();
  group.add(sky);
  group.add(buildTerrain());
  const cities = makeCities();
  group.add(buildCityLights(cities));
  const b = buildBuildings(cities);
  group.add(b.mesh, b.fires);
  group.add(buildClouds());
  return {
    group,
    follow(camera) { sky.position.copy(camera.position); },
  };
}

void select; void min;
