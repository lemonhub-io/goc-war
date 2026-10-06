// rod.ts — the tungsten kinetic rod (nose glow, plasma sheath, ion/plasma
// trail) and the designator laser. The rod is built twice: once for the orbit
// world and once, bigger, for the descent shot — both read U.reentry.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, float, mix, smoothstep, pow, abs, sin, cos, exp, uv, mx_noise_float,
  positionLocal, normalView,
} from 'three/tsl';
import { U, TWO_PI } from './shared';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();

function additive(extra: object = {}) {
  return new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false, ...extra,
  });
}

export interface Rod {
  group: THREE.Group;
  /** pos = nose position, dir = unit travel direction, trail = trail length in local units */
  place(pos: THREE.Vector3, dir: THREE.Vector3, trail: number): void;
}

export function buildRod(scale: number): Rod {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(scale);
  group.add(inner);

  // ---- tungsten body: dark metal heating from the nose back
  const bodyMat = new THREE.MeshBasicNodeMaterial({ fog: false });
  bodyMat.colorNode = Fn(() => {
    const y = positionLocal.y;
    const heat = U.reentry.mul(smoothstep(-3.0, 5.0, y)).mul(1.2);
    const base = vec3(0.1, 0.1, 0.12).add(vec3(0.04, 0.05, 0.07).mul(smoothstep(-4.0, 4.0, y)));
    const hot = mix(vec3(1.0, 0.35, 0.08), vec3(1.0, 0.95, 0.8), smoothstep(0.4, 1.2, heat)).mul(heat.mul(5.0));
    return vec4(base.add(hot), 1.0);
  })();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 8, 14), bodyMat);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.7, 14), bodyMat);
  nose.position.y = 4.85;
  inner.add(body, nose);

  // ---- plasma sheath: a fresnel shell hugging the nose
  const sheathMat = additive();
  sheathMat.colorNode = Fn(() => {
    const v = uv().y;
    const nz = abs(normalView.z);
    const n = mx_noise_float(vec3(uv().x.mul(TWO_PI).cos().mul(1.6), uv().x.mul(TWO_PI).sin().mul(1.6), v.mul(6.0).add(U.time.mul(26.0)))).mul(0.5).add(0.75);
    const e = pow(nz, 0.9).mul(pow(float(1.0).sub(v), 1.1)).mul(n).mul(U.reentry).mul(3.4);
    return vec4(mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.92, 0.75), pow(v, 1.5)).mul(e), 1.0);
  })();
  const sheath = new THREE.Mesh(new THREE.ConeGeometry(1.5, 8, 28, 1, true), sheathMat);
  sheath.position.y = 5.4 - 4;
  inner.add(sheath);

  // ---- trail: ion-blue in vacuum, white-orange plasma once it bites air
  const trailMat = additive();
  trailMat.colorNode = Fn(() => {
    const p = uv();
    const v = p.y;                              // 0 at the tail → 1 at the nose
    const ang = p.x.mul(TWO_PI);
    const nz = pow(abs(normalView.z), 0.8);
    const n = mx_noise_float(vec3(cos(ang).mul(2.0), sin(ang).mul(2.0), v.mul(9.0).sub(U.time.mul(28.0)))).mul(0.5).add(0.6);
    const fade = pow(v, 1.7);
    const col = mix(vec3(0.45, 0.78, 1.0), mix(vec3(1.0, 0.5, 0.14), vec3(1.0, 0.9, 0.7), pow(v, 3.0)), U.reentry);
    const e = fade.mul(nz).mul(n).mul(float(1.3).add(U.reentry.mul(2.6)));
    return vec4(col.mul(e), 1.0);
  })();
  const trail = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.2, 1, 24, 1, true).translate(0, -0.5, 0), trailMat);
  trail.position.y = 3.8;
  inner.add(trail);
  // a thin hot core down the trail axis
  const coreMat = additive();
  coreMat.colorNode = Fn(() => {
    const v = uv().y;
    const e = pow(v, 2.4).mul(abs(normalView.z).pow(2.0)).mul(float(2.0).add(U.reentry.mul(4.0)));
    return vec4(mix(vec3(0.7, 0.9, 1.0), vec3(1.0, 0.85, 0.6), U.reentry).mul(e), 1.0);
  })();
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.05, 1, 12, 1, true).translate(0, -0.5, 0), coreMat);
  core.position.y = 4.4;
  inner.add(core);

  // ---- nose glow
  const gm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  gm.colorNode = Fn(() => {
    const r = uv().sub(0.5).length().mul(2.0);
    const e = exp(r.mul(-4.5)).mul(float(1.2).add(U.reentry.mul(3.0))).add(smoothstep(0.2, 0.0, r).mul(3.0));
    return vec4(mix(vec3(0.6, 0.85, 1.0), vec3(1.0, 0.62, 0.25), U.reentry).mul(e), e.min(1.0));
  })();
  const glow = new THREE.Sprite(gm);
  glow.position.y = 5.6;
  glow.scale.setScalar(9);
  glow.renderOrder = 25;
  inner.add(glow);

  for (const m of [body, nose, sheath, trail, core]) { m.frustumCulled = false; m.renderOrder = 24; }
  glow.frustumCulled = false;
  group.visible = false;

  return {
    group,
    place(pos, dir, trailLen) {
      group.position.copy(pos);
      _q.setFromUnitVectors(Y_AXIS, _d.copy(dir).normalize());
      group.quaternion.copy(_q);
      // trail radius grows with re-entry (a sheath of plasma rather than a thread of ions)
      const w = 0.5 + U.reentry.value * 0.8;
      trail.scale.set(w, trailLen, w);
      core.scale.set(1, trailLen * 0.8, 1);
      group.visible = true;
    },
  };
}

// ------------------------------------------------------------------ designator laser

export interface Beam {
  mesh: THREE.Mesh;
  set(from: THREE.Vector3, to: THREE.Vector3, radius: number): void;
}

export function buildDesignator(): Beam {
  const mat = additive();
  mat.colorNode = Fn(() => {
    const v = uv().y;
    const nz = pow(abs(normalView.z), 0.6);
    const pulse = pow(sin(v.mul(160.0).sub(U.time.mul(48.0))).mul(0.5).add(0.5), 3.0).mul(0.8).add(0.4);
    const flick = sin(U.time.mul(61.0)).mul(0.12).add(0.88);
    const e = nz.mul(pulse).mul(flick).mul(U.designator).mul(2.6);
    return vec4(mix(vec3(1.0, 0.1, 0.06), vec3(1.0, 0.55, 0.45), nz.mul(0.5)).mul(e), 1.0);
  })();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 23;
  mesh.visible = false;
  return {
    mesh,
    set(from, to, radius) {
      _d.copy(to).sub(from);
      const L = _d.length();
      mesh.position.copy(from);
      mesh.quaternion.setFromUnitVectors(Y_AXIS, _d.normalize());
      mesh.scale.set(radius, L, radius);
      mesh.visible = true;
    },
  };
}
