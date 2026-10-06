// space.ts — the orbit world's backdrop: star dome, the Earth (continents,
// clouds, city lights on the night side, the in-world target lock and the
// strike aftermath), its atmosphere shell, and the sun.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, hash, mix, smoothstep, pow, abs, sin, atan, exp, floor, fract,
  dot, cross, normalize, max, clamp, step, acos, uv, mx_noise_float,
  positionLocal, positionWorld, normalWorld, cameraPosition,
} from 'three/tsl';
import { U, ER, EARTH_C, SUN_DIR, emberRamp } from './shared';

// ------------------------------------------------------------------ stars

/** procedural star field + faint galactic band for a unit direction */
export function starColor(dir: any, density = 150.0): any {
  const p = dir.mul(density);
  const cell: any = floor(p);
  const seed: any = dot(cell, vec3(12.9898, 78.233, 37.719) as any);
  const h = hash(seed);
  const h2 = hash(seed.add(19.19));
  const h3 = hash(seed.add(7.77));
  const h4 = hash(seed.add(3.1));
  const off = vec3(h2, h3, h4).sub(0.5).mul(0.6);
  const d = fract(p).sub(0.5).sub(off).length();
  const present = step(0.975, h);
  const mag = pow(h.sub(0.975).div(0.025), 1.6).mul(3.4).add(0.6);
  const twinkle = sin(U.time.mul(2.0).add(h2.mul(60.0))).mul(0.18).add(0.82);
  const tint = mix(vec3(0.7, 0.82, 1.0), vec3(1.0, 0.86, 0.68), h3);
  const star = tint.mul(smoothstep(0.34, 0.0, d).pow(1.6)).mul(mag).mul(present).mul(twinkle);

  // galactic band: soft glow broken up by dust lanes
  const band = dot(dir, normalize(vec3(0.35, 0.75, -0.55)));
  const glow = exp(band.mul(band).mul(-13.0));
  const n1 = mx_noise_float(dir.mul(5.0)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(dir.mul(17.0).add(3.3)).mul(0.5).add(0.5);
  const dust = smoothstep(0.7, 0.3, mx_noise_float(dir.mul(9.0).add(8.1)).mul(0.5).add(0.5));
  const mw = mix(vec3(0.07, 0.085, 0.16), vec3(0.2, 0.13, 0.2), n2)
    .mul(glow.mul(n1.mul(0.9).add(0.15)).mul(dust.mul(0.7).add(0.3)));
  return star.add(mw);
}

export function buildSky(): THREE.Mesh {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.colorNode = Fn(() => vec4(starColor(positionLocal.normalize()), 1.0))();
  const m = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

// ------------------------------------------------------------------ the sun

export function buildSun(): THREE.Sprite {
  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  mat.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2.0);
    const r = p.length();
    const core = smoothstep(0.1, 0.0, r).mul(40.0);
    const halo = exp(r.mul(-5.5)).mul(2.2);
    // anamorphic streak + a faint vertical cross
    const streak = exp(abs(p.x).mul(-2.6)).mul(exp(abs(p.y).mul(-70.0))).mul(1.6);
    const cross2 = exp(abs(p.y).mul(-4.0)).mul(exp(abs(p.x).mul(-90.0))).mul(0.5);
    const e = core.add(halo).add(streak).add(cross2).mul(smoothstep(1.0, 0.8, r.max(abs(p.x).mul(0.4))));
    const col = mix(vec3(1.0, 0.85, 0.62), vec3(1.0, 0.97, 0.9), core.min(1.0));
    return vec4(col.mul(e), e.min(1.0));
  })();
  const s = new THREE.Sprite(mat);
  s.position.copy(SUN_DIR).multiplyScalar(2400);
  s.scale.setScalar(1300);
  s.renderOrder = -5;
  s.frustumCulled = false;
  return s;
}

// ------------------------------------------------------------------ the Earth

/** shared target-frame maths: arc-length distance and local x/y (scene units) from the strike site */
const targetFrame = (n: any) => {
  const td: any = U.targetDir;
  const tA = normalize(cross(vec3(0, 0, 1), td));
  const tB = cross(td, tA);
  const s = acos(clamp(dot(n, td), -1.0, 1.0)).mul(ER);
  const x = dot(n, tA).mul(ER);
  const y = dot(n, tB).mul(ER);
  return { s, x, y, phi: atan(y, x) };
};

const ring = (s: any, r0: any, w: any) => smoothstep(w, 0.0, abs(s.sub(r0)));

export function buildEarth(): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(EARTH_C);

  const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
  mat.colorNode = Fn(() => {
    const n = positionLocal.normalize();
    const ndl = dot(n, U.sunDir);
    const t = U.time;

    // ---- continents
    const q = n.mul(2.3);
    const c1 = mx_noise_float(q.add(vec3(1.7, 3.1, 0.4)));
    const c2 = mx_noise_float(q.mul(2.1).add(vec3(5.2, 0.7, 8.3)));
    const c3 = mx_noise_float(q.mul(4.4).add(vec3(9.9, 4.1, 2.2)));
    const h = c1.mul(0.62).add(c2.mul(0.28)).add(c3.mul(0.1));
    const land = smoothstep(0.02, 0.07, h);
    const ocean = mix(vec3(0.008, 0.04, 0.14), vec3(0.03, 0.16, 0.36), smoothstep(-0.45, 0.0, h));
    const dry = smoothstep(0.1, 0.55, h.add(c3.mul(0.35)));
    const ground = mix(vec3(0.05, 0.13, 0.05), vec3(0.34, 0.26, 0.14), dry);
    const ice = smoothstep(0.84, 0.94, abs(n.y).add(c2.mul(0.05)));
    const surf = mix(mix(ocean, ground, land), vec3(0.85, 0.9, 0.95), ice);

    // ---- clouds (drift slowly)
    const drift = vec3(t.mul(0.006), 0.0, t.mul(0.003));
    const cn = mx_noise_float(n.mul(3.2).add(drift));
    const cn2 = mx_noise_float(n.mul(7.5).add(drift.mul(1.6)).add(4.4));
    const cl = smoothstep(0.1, 0.52, cn.mul(0.7).add(cn2.mul(0.4)));

    // ---- strike aftermath: scar, fire field, pressure ring, ash pall
    const f = targetFrame(n);
    const age = t.sub(U.tImpact);
    const live = step(0.0, age);
    const ageP = max(age, 0.0);
    const pall = exp(f.s.mul(f.s).div(float(2.0).mul(ageP.mul(0.9).add(6.0).pow(2.0))).negate())
      .mul(float(1.0).sub(exp(ageP.mul(-0.35)))).mul(live);

    // ---- lighting
    const day = smoothstep(-0.08, 0.22, ndl);
    const V = normalize(cameraPosition.sub(positionWorld));
    const H = normalize(U.sunDir.add(V));
    const spec = pow(max(dot(n, H), 0.0), 140.0).mul(float(1.0).sub(land)).mul(float(1.0).sub(cl)).mul(3.2);
    const lit = max(ndl, 0.0);
    const dayCol = surf.mul(lit.mul(1.55).add(0.05)).add(vec3(1.0, 0.92, 0.75).mul(spec));
    const dayCl = mix(dayCol, vec3(1.0, 1.0, 1.0).mul(lit.mul(1.1).add(0.1)), cl.mul(0.92));

    // night side: dim earthshine, then the lights of civilisation
    const nightBase = surf.mul(0.035).add(vec3(0.002, 0.006, 0.02));
    const cityN = mx_noise_float(n.mul(900.0)).mul(0.5).add(0.5);
    const cluster = smoothstep(0.34, 0.66, mx_noise_float(n.mul(12.0).add(2.9)).mul(0.5).add(0.5)
      .add(mx_noise_float(n.mul(30.0)).mul(0.2)));
    const lights = land.mul(smoothstep(0.62, 0.8, cityN)).mul(cluster)
      .mul(float(1.0).sub(cl.mul(0.75))).mul(float(1.0).sub(pall));
    const nightCol = nightBase.add(vec3(1.0, 0.64, 0.3).mul(lights).mul(2.6));
    const nightCl = mix(nightCol, vec3(0.035, 0.045, 0.085), cl.mul(0.5));

    let col = mix(nightCl, dayCl, day);
    // sunset fringe along the terminator
    col = col.add(vec3(1.0, 0.42, 0.14).mul(exp(ndl.mul(ndl).mul(-70.0))).mul(0.3).mul(cl.mul(0.8).add(0.2)));

    // ---- in-world target lock: contracting ring, dashes, crosshair, radar sweep
    const lk = U.lock;
    const R1 = float(24.0).sub(lk.mul(10.0));
    const dash = smoothstep(0.2, 0.5, sin(f.phi.mul(18.0).add(t.mul(0.8))).mul(0.5).add(0.5));
    const cross2 = smoothstep(0.35, 0.1, abs(f.x)).mul(smoothstep(3.0, 3.8, abs(f.y))).mul(smoothstep(17.0, 15.0, abs(f.y)))
      .add(smoothstep(0.35, 0.1, abs(f.y)).mul(smoothstep(3.0, 3.8, abs(f.x))).mul(smoothstep(17.0, 15.0, abs(f.x))));
    const sweepA = fract(f.phi.div(Math.PI * 2.0).sub(t.mul(0.22)));
    const sweep = pow(sweepA, 6.0).mul(smoothstep(24.0, 0.0, f.s)).mul(0.5);
    const hud = ring(f.s, R1, 0.5).mul(dash).add(ring(f.s, 10.5, 0.32).mul(0.8))
      .add(ring(f.s, 4.6, 0.3)).add(cross2).add(sweep)
      .add(smoothstep(0.9, 0.0, f.s).mul(1.4)).mul(lk);
    const hudCol = mix(vec3(1.0, 0.18, 0.12), vec3(1.0, 0.8, 0.7), U.designator);
    col = col.add(hudCol.mul(hud).mul(2.0).mul(float(1.0).sub(live)));

    // ---- aftermath glow
    const sg = ageP.mul(0.2).add(2.4);
    const scar = exp(f.s.mul(f.s).div(sg.mul(sg).mul(2.0)).negate());
    const mottle = mx_noise_float(n.mul(500.0).add(vec3(0.0, t.mul(0.8), 0.0))).mul(0.5).add(0.9);
    const scarCol = emberRamp(clamp(ageP.mul(0.025), 0.0, 0.9)).mul(scar.mul(mottle)).mul(exp(ageP.mul(-0.05)).mul(3.6));
    const fireN = smoothstep(0.62, 0.85, mx_noise_float(n.mul(700.0)).mul(0.5).add(0.5));
    const fires = fireN.mul(exp(f.s.mul(f.s).div(200.0).negate())).mul(smoothstep(0.0, 3.0, ageP))
      .mul(exp(ageP.mul(-0.03))).mul(vec3(1.0, 0.36, 0.08)).mul(3.4);
    const ringS = float(70.0).mul(float(1.0).sub(exp(ageP.mul(-0.12))));
    const rw = ageP.mul(0.15).add(1.2);
    const rr = exp(f.s.sub(ringS).div(rw).pow(2.0).negate()).mul(exp(ageP.mul(-0.1))).mul(smoothstep(0.0, 0.4, ageP));
    col = mix(col, vec3(0.04, 0.035, 0.035), pall.mul(0.55));
    col = col.add(scarCol.add(fires).mul(live)).add(vec3(1.0, 0.8, 0.55).mul(rr).mul(1.6).mul(live));
    return vec4(col, 1.0);
  })();

  const earth = new THREE.Mesh(new THREE.SphereGeometry(ER, 160, 96), mat);
  earth.frustumCulled = false;
  earth.renderOrder = -4;
  group.add(earth);

  // ---- atmosphere shell
  const am = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  am.colorNode = Fn(() => {
    const N = normalWorld;
    const V = normalize(cameraPosition.sub(positionWorld));
    const nv = max(dot(N, V), 0.0);
    const rim = pow(float(1.0).sub(nv), 4.0);
    const ndl = dot(N, U.sunDir);
    const lit = smoothstep(-0.38, 0.38, ndl);
    const body = mix(vec3(0.06, 0.2, 0.85), vec3(0.34, 0.62, 1.0), rim);
    const sunset = vec3(1.0, 0.4, 0.1).mul(exp(ndl.mul(ndl).mul(-24.0))).mul(0.45);
    // re-entry bloom where the rod meets the air
    const dE = positionWorld.sub(U.entryPos).length();
    const flare = vec3(1.0, 0.56, 0.2).mul(exp(dE.mul(dE).div(2.0 * 15.0 * 15.0).negate())).mul(U.reentry).mul(1.5);
    const a = rim.mul(lit.mul(0.95).add(0.12));
    return vec4(body.mul(a).mul(1.25).add(sunset.mul(rim)).add(flare.mul(rim.mul(0.8).add(0.2))), 1.0);
  })();
  const atm = new THREE.Mesh(new THREE.SphereGeometry(ER * 1.034, 128, 64), am);
  atm.frustumCulled = false;
  atm.renderOrder = -3;
  group.add(atm);

  return group;
}

/** blazing contact flash where the rod meets the air — rides U.entryPos */
export function buildEntryFlash(): THREE.Sprite {
  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  mat.positionNode = Fn(() => vec3(U.entryPos.x, U.entryPos.y, U.entryPos.z))();
  mat.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2.0);
    const r = p.length();
    const e = exp(r.mul(-4.0)).mul(1.4).add(smoothstep(0.18, 0.0, r).mul(3.0))
      .add(exp(abs(p.x).mul(-3.0)).mul(exp(abs(p.y).mul(-40.0))).mul(1.6));
    const k = smoothstep(0.4, 1.0, U.reentry);
    return vec4(mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.92, 0.8), exp(r.mul(-3.0))).mul(e).mul(k), 1.0);
  })();
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(70);
  s.renderOrder = 26; s.frustumCulled = false;
  return s;
}

export { SUN_DIR };
