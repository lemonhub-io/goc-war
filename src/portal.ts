// portal.ts — the Way: jagged GOC breach ring, void disc, orbit sparks, light shaft
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uv, hash, mix, smoothstep, pow, abs, fract,
  sin, cos, atan, mx_noise_float, instanceIndex, select, exp,
} from 'three/tsl';
import { U, PORTAL, PORTAL_R, wayRamp, TWO_PI, attr } from './shared';

// ------------------------------------------------------------------ breach ring

export function buildBreachRing(): THREE.Mesh {
  const geo = new THREE.RingGeometry(PORTAL_R * 0.86, PORTAL_R * 1.08, 160, 1);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  mat.colorNode = Fn(() => {
    const pp = uv().sub(0.5);
    const a = atan(pp.y, pp.x);
    const r = pp.length().mul(2.0); // inner edge ~0.80, outer ~1.0
    const rn = r.sub(0.80).div(0.20); // 0..1 across ring band

    // rotating energy sectors — spin accelerates as the Way opens, with a
    // slow phase wobble so it never feels metronomic
    const spinT = U.time.mul(0.22).mul(U.breach.mul(1.7).add(0.6))
      .add(sin(U.time.mul(0.31)).mul(0.55));
    const rot = a.sub(spinT);
    const sectors = pow(abs(sin(rot.mul(9.0))), 6.0).mul(0.5)
      .add(pow(abs(sin(rot.mul(23.0).add(1.7))), 14.0).mul(0.6));

    // plasma crawl
    const n = mx_noise_float(vec3(rot.mul(3.0), rn.mul(4.0), U.time.mul(0.6))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(rn.mul(9.0), rot.mul(12.0).add(U.time.mul(1.3)), U.time.mul(0.4))).mul(0.5).add(0.5);

    // jagged outer edge — lightning teeth
    const tooth = mx_noise_float(vec3(a.mul(14.0), U.time.mul(2.2), 7.7)).mul(0.5).add(0.5);
    const jag = smoothstep(1.02, 0.86, rn.add(tooth.mul(0.28)));

    const energy = sectors.mul(0.7).add(n.mul(0.8)).add(n2.mul(0.5)).add(0.35);
    const bright = energy.mul(U.breach.mul(7.5).add(0.12));
    const col = wayRamp(rn.mul(0.8).add(n.mul(0.4)).clamp(0, 1)).mul(bright);

    const alpha = smoothstep(0.0, 0.08, rn).mul(jag).mul(U.breach.mul(0.9).add(0.1));
    return vec4(col.mul(alpha), alpha);
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(PORTAL);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

// ------------------------------------------------------------------ void disc

export function buildVoidDisc(): THREE.Mesh {
  const geo = new THREE.CircleGeometry(PORTAL_R * 0.9, 96);

  const base = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  base.colorNode = Fn(() => {
    const pp = uv().sub(0.5);
    const a = atan(pp.y, pp.x);
    const r = pp.length().mul(2.0);
    // slow matter swirl — the dark beyond; quickens and wobbles as it opens
    const sw = a.add(U.time.mul(0.12).add(U.breach.mul(U.time.mul(0.28))))
      .add(sin(U.time.mul(0.23)).mul(0.6)).sub(r.mul(4.2));
    const n = mx_noise_float(vec3(sw.mul(3.0), r.mul(5.0), U.time.mul(0.25))).mul(0.5).add(0.5);
    const col = mix(vec3(0.004, 0.005, 0.012), vec3(0.05, 0.03, 0.12), n.mul(0.5))
      .add(vec3(0.01, 0.015, 0.05).mul(smoothstep(0.85, 1.0, r)).mul(U.breach));
    const alpha = smoothstep(1.0, 0.92, r).mul(0.97).mul(U.breach.mul(0.75).add(0.25));
    return vec4(col, alpha);
  })();
  const mesh = new THREE.Mesh(geo, base);
  mesh.position.copy(PORTAL);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  return mesh;
}

export function buildVoidFilaments(): THREE.Mesh {
  const geo = new THREE.CircleGeometry(PORTAL_R * 0.9, 96);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  mat.colorNode = Fn(() => {
    const pp = uv().sub(0.5);
    const a = atan(pp.y, pp.x);
    const r = pp.length().mul(2.0);
    const sw = a.add(U.time.mul(0.16).add(U.breach.mul(U.time.mul(0.3))))
      .add(sin(U.time.mul(0.27).add(2.0)).mul(0.5)).sub(r.mul(5.0));
    // icy filaments spiraling into the throat
    const f1 = pow(mx_noise_float(vec3(sw.mul(6.0), r.mul(7.0).sub(U.time.mul(0.5)), 3.1)).mul(0.5).add(0.5), 6.0);
    const f2 = pow(mx_noise_float(vec3(sw.mul(11.0).add(9.2), r.mul(10.0), U.time.mul(0.35))).mul(0.5).add(0.5), 8.0);
    // gold flecks — shredded catalogue light
    const f3 = pow(mx_noise_float(vec3(sw.mul(9.0), r.mul(14.0).add(U.time.mul(0.7)), 11.7)).mul(0.5).add(0.5), 14.0);
    const rimFade = smoothstep(1.0, 0.55, r).mul(smoothstep(0.0, 0.2, r));
    const col = vec3(0.35, 0.6, 1.0).mul(f1.mul(2.6).add(f2.mul(1.8)))
      .add(vec3(1.0, 0.72, 0.3).mul(f3.mul(3.0)));
    return vec4(col.mul(rimFade).mul(U.breach.mul(1.2).add(0.03)), rimFade.mul(U.breach.mul(0.9).add(0.05)));
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(PORTAL);
  mesh.position.z += 0.05;
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return mesh;
}

// ------------------------------------------------------------------ orbit sparks

const SPARK_COUNT = 4200;

export function buildOrbitSparks(): THREE.Sprite {
  const seeds = new Float32Array(SPARK_COUNT * 4);
  for (let i = 0; i < SPARK_COUNT; i++) {
    seeds[i * 4 + 0] = Math.random() * TWO_PI;        // phase
    seeds[i * 4 + 1] = 0.15 + Math.random() * 0.75;   // angular speed
    seeds[i * 4 + 2] = Math.random();                  // radius jitter seed
    seeds[i * 4 + 3] = Math.random();                  // misc
  }
  const attrA = new THREE.InstancedBufferAttribute(seeds, 4);
  const sd = attr(attrA);

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  mat.positionNode = Fn(() => {
    // per-spark tangential surge — sparks bunch and spread instead of
    // marching at a fixed angular rate
    const wob = sin(U.time.mul(sd.w.mul(0.9).add(0.35)).add(sd.x.mul(2.0))).mul(0.38);
    const ang = sd.x.add(U.time.mul(sd.y.mul(1.6)).mul(U.breach.mul(0.9).add(0.6))).add(wob);
    // most sparks hug the ring; ~12% eject outward and rejoin
    const ej = fract(U.time.mul(0.22).add(sd.w));
    const eject = select(sd.z.greaterThan(0.88), ej.mul(ej).mul(6.0), float(0));
    const r = float(PORTAL_R * 0.97).add(sd.z.sub(0.5).mul(1.4)).add(eject);
    const z = sd.w.sub(0.5).mul(1.6).add(sin(U.time.mul(0.8).add(sd.x.mul(3.0))).mul(0.5));
    return vec3(
      cos(ang).mul(r).add(PORTAL.x),
      sin(ang).mul(r).add(PORTAL.y),
      z.add(PORTAL.z),
    );
  })();

  mat.scaleNode = Fn(() => {
    const s = sd.w.mul(0.14).add(0.05).mul(U.breach.mul(0.8).add(0.25));
    return vec2(s, s);
  })();

  mat.colorNode = Fn(() => {
    const tw = hash(instanceIndex.toFloat().mul(0.618));
    const col = mix(vec3(0.5, 0.75, 1.0), vec3(0.9, 0.97, 1.0), tw).mul(tw.mul(2.0).add(1.6));
    const fade = U.breach.mul(0.85).add(0.12);
    return vec4(col.mul(fade), fade);
  })();

  const sprite = new THREE.Sprite(mat);
  sprite.count = SPARK_COUNT;
  sprite.userData.baseCount = SPARK_COUNT;
  sprite.frustumCulled = false;
  sprite.renderOrder = 11;
  return sprite;
}

// ------------------------------------------------------------------ light shaft

export function buildLightShaft(): THREE.Group {
  const group = new THREE.Group();
  const mk = (ry: number) => {
    const geo = new THREE.PlaneGeometry(9.5, 21);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    mat.colorNode = Fn(() => {
      const p = uv();
      const edge = smoothstep(0.0, 0.35, p.x).mul(smoothstep(1.0, 0.65, p.x));
      const vert = pow(p.y.oneMinus(), 1.6);
      const streaks = pow(abs(sin(p.x.mul(14.0).add(U.time.mul(0.4)))), 8.0).mul(0.6).add(0.4);
      const n = mx_noise_float(vec3(p.x.mul(6.0), p.y.mul(4.0).sub(U.time.mul(0.5)), 2.2)).mul(0.5).add(0.5);
      const a = edge.mul(vert).mul(streaks).mul(n.mul(0.6).add(0.4));
      const col = vec3(0.4, 0.62, 1.0).mul(a.mul(1.5));
      const amp = U.breach.mul(0.5);
      return vec4(col.mul(amp), a.mul(amp));
    })();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.y = ry;
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    return mesh;
  };
  const a = mk(0); a.position.set(PORTAL.x, 10.0, PORTAL.z + 0.4);
  const b = mk(Math.PI / 2.6); b.position.set(PORTAL.x, 9.6, PORTAL.z + 0.4);
  group.add(a, b);
  return group;
}

// ------------------------------------------------------------------ haze glow

export function buildHazeGlow(): THREE.Sprite {
  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  mat.colorNode = Fn(() => {
    const p = uv().sub(0.5);
    const r = p.length().mul(2.0);
    const a = exp(r.mul(-3.2)).mul(0.4);
    const col = mix(vec3(0.2, 0.42, 0.95), vec3(0.6, 0.8, 1.0), exp(r.mul(-2.0)));
    const amp = U.breach.mul(1.4).add(0.05);
    return vec4(col.mul(a).mul(amp), a.mul(amp));
  })();
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(PORTAL);
  sprite.scale.setScalar(46);
  sprite.renderOrder = 6;
  return sprite;
}

export function buildPortal(): THREE.Group {
  const g = new THREE.Group();
  g.add(buildVoidDisc());
  g.add(buildVoidFilaments());
  g.add(buildBreachRing());
  g.add(buildOrbitSparks());
  g.add(buildLightShaft());
  g.add(buildHazeGlow());
  return g;
}
