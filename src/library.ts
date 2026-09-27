// library.ts — the Wanderers' Library: shelf monoliths, floor, levitating books
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, hash, mix, smoothstep, abs, fract,
  floor, positionWorld, positionLocal, instanceIndex,
} from 'three/tsl';
import { U, PORTAL } from './shared';

// ------------------------------------------------------------------ shelves

const SHELF_COUNT = 96;

export function buildShelves(): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x05060a),
    roughness: 0.92,
    metalness: 0.0,
  });

  // procedural spine-stripes
  mat.colorNode = Fn(() => {
    const rows = fract(positionLocal.y.mul(9.0));
    const shelfRow = smoothstep(0.0, 0.08, rows).mul(smoothstep(1.0, 0.86, rows));
    const bookJitter = hash(floor(positionWorld.x.mul(6.2)).add(floor(positionWorld.y.mul(9.0)).mul(61.7)).add(instanceIndex.toFloat().mul(13.1)));
    const spineTint = mix(vec3(0.055, 0.05, 0.055), vec3(0.16, 0.1, 0.06), bookJitter);
    return vec4(mix(vec3(0.012, 0.013, 0.02), spineTint, shelfRow), 1.0);
  })();
  // fire underglow + cold sheen from the Way — emissive so it reads in the dark
  mat.emissiveNode = Fn(() => {
    const low = smoothstep(7.0, 0.0, positionWorld.y);
    const fire = U.inferno.mul(low).mul(vec3(0.9, 0.32, 0.07)).mul(hash(instanceIndex.toFloat()).mul(0.5).add(0.55));
    const d = positionWorld.sub(vec3(PORTAL.x, PORTAL.y, PORTAL.z)).length();
    const rim = vec3(0.25, 0.5, 1.0).mul(U.breach.mul(0.35)).mul(smoothstep(30.0, 6.0, d));
    return vec3(fire.add(rim));
  })();

  const mesh = new THREE.InstancedMesh(geo, mat, SHELF_COUNT);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  let i = 0;
  const put = (x: number, y: number, z: number, w: number, h: number, d: number, ry: number, rz = 0) => {
    e.set(0, ry, rz); q.setFromEuler(e);
    p.set(x, y, z); s.set(w, h, d);
    m.compose(p, q, s);
    mesh.setMatrixAt(i++, m);
  };
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  // flanks — tall slab stacks receding into dark
  for (let k = 0; k < 34; k++) {
    const z = -34 + k * 1.35;
    put(-12.4 - rnd(0, 0.4), rnd(6.5, 8.5), z, rnd(1.4, 2.0), rnd(13, 17), rnd(4.4, 5.2), rnd(-0.03, 0.03));
    put(12.4 + rnd(0, 0.4), rnd(6.5, 8.5), z, rnd(1.4, 2.0), rnd(13, 17), rnd(4.4, 5.2), rnd(-0.03, 0.03));
  }
  for (let k = 0; k < 12; k++) {
    const z = -32 + k * 2.8;
    put(-20 - rnd(0, 4), rnd(7, 10), z, rnd(2.4, 3.4), rnd(15, 21), rnd(5, 6), rnd(-0.05, 0.05));
    put(20 + rnd(0, 4), rnd(7, 10), z, rnd(2.4, 3.4), rnd(15, 21), rnd(5, 6), rnd(-0.05, 0.05));
  }
  // far back stacks behind the way
  for (let k = 0; k < 8; k++) {
    put(rnd(-14, 14), rnd(9, 13), -30 - rnd(0, 5), rnd(3, 6), rnd(18, 26), rnd(2, 3), rnd(-0.3, 0.3));
  }
  // fallen / toppled slabs — the strike has already hit here
  put(-6.5, 2.1, -8.5, 1.7, 14, 4.6, 0.5, 1.25);
  put(6.0, 1.6, -11.0, 1.7, 13, 4.4, -0.4, -1.32);
  put(-3.0, 0.9, -2.0, 1.6, 10, 4.0, 0.9, 1.45);
  put(8.6, 0.7, -4.5, 1.6, 9.5, 3.8, -0.8, 1.5);

  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ------------------------------------------------------------------ floor

export function buildFloor(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(160, 160);
  const mat = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x04050a),
    roughness: 0.55,
    metalness: 0.35,
  });
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    // stone tile seams
    const gx = abs(fract(p.x.mul(0.25)).sub(0.5));
    const gz = abs(fract(p.z.mul(0.25)).sub(0.5));
    const seam = smoothstep(0.485, 0.5, gx).add(smoothstep(0.485, 0.5, gz));
    const base = vec3(0.014, 0.015, 0.022).sub(seam.mul(0.008));
    // cold light pooling under the Way
    const pd = vec2(p.x.sub(PORTAL.x), p.z.sub(PORTAL.z + 2.0)).length();
    const pool = vec3(0.3, 0.55, 1.0).mul(U.breach.mul(0.5)).mul(smoothstep(16.0, 2.0, pd));
    // hot wash spreading with the fires
    const fd = vec2(p.x, p.z.add(9.0)).length();
    const warm = vec3(0.85, 0.3, 0.06).mul(U.inferno.mul(0.4)).mul(smoothstep(24.0, 3.0, fd));
    return vec4(base.add(pool).add(warm), 1.0);
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0;
  mesh.frustumCulled = false;
  return mesh;
}

// ------------------------------------------------------------------ books

export interface BookSystem {
  mesh: THREE.InstancedMesh;
  update(t: number, strike: number, breach: number): void;
  reset(): void;
}

const BOOK_COUNT = 460;
const HARVEST_FRACTION = 0.38;

const COVERS = [
  new THREE.Color(0x5a1d1d), new THREE.Color(0x2c3a2a), new THREE.Color(0x1d2b45),
  new THREE.Color(0x4a3620), new THREE.Color(0x3a1f3a), new THREE.Color(0x57503e),
  new THREE.Color(0x22262e), new THREE.Color(0x6b5a33),
];

export function buildBooks(): BookSystem {
  const geo = new THREE.BoxGeometry(0.68, 0.92, 0.15);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.0 });
  const mesh = new THREE.InstancedMesh(geo, mat, BOOK_COUNT);
  mesh.frustumCulled = false;

  interface B {
    base: THREE.Vector3; pos: THREE.Vector3;
    axis: THREE.Vector3; phase: number; bobAmp: number; bobSpeed: number;
    spin: number; harvested: boolean; pullDelay: number; dead: boolean;
    cover: THREE.Color; scale: number;
  }
  const books: B[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < BOOK_COUNT; i++) {
    const harvested = i < BOOK_COUNT * HARVEST_FRACTION;
    // distribute through the hall, denser near center
    const r = 3 + Math.pow(Math.random(), 0.7) * 16;
    const a = Math.random() * Math.PI * 2;
    const base = new THREE.Vector3(
      Math.cos(a) * r * 1.15,
      1.5 + Math.random() * 10.5,
      -16 + Math.sin(a) * r * 0.8 + Math.random() * 6,
    );
    const cover = COVERS[(Math.random() * COVERS.length) | 0].clone();
    books.push({
      base, pos: base.clone(),
      axis: new THREE.Vector3().randomDirection(),
      phase: Math.random() * Math.PI * 2,
      bobAmp: 0.15 + Math.random() * 0.55,
      bobSpeed: 0.4 + Math.random() * 0.9,
      spin: (Math.random() - 0.5) * 0.7,
      harvested,
      pullDelay: Math.random() * 0.85,
      dead: false,
      cover,
      scale: 0.7 + Math.random() * 0.9,
    });
    c.copy(cover);
    mesh.setColorAt(i, c);
  }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const toPortal = new THREE.Vector3();
  const HOT = new THREE.Color(0xff7a28);

  const update = (t: number, strike: number, breach: number) => {
    for (let i = 0; i < BOOK_COUNT; i++) {
      const b = books[i];
      // gentle levitation drift — amplitude beats make it breathe, not metronome
      const beat = 0.65 + 0.35 * Math.sin(t * 0.21 + b.phase * 2.1);
      b.pos.copy(b.base);
      b.pos.y += Math.sin(t * b.bobSpeed + b.phase) * b.bobAmp * beat;
      b.pos.x += Math.sin(t * b.bobSpeed * 0.6 + b.phase * 1.7) * b.bobAmp * 0.5 * beat;
      b.pos.z += Math.cos(t * b.bobSpeed * 0.45 + b.phase * 0.9) * b.bobAmp * 0.3 * beat;

      let sc = b.scale;
      let hot = 0;

      if (b.harvested && strike > 0) {
        // pulled into the Way — spiral in, heat up, vanish
        const k = Math.max(0, Math.min(1, (strike - b.pullDelay) / 0.35));
        if (k > 0) {
          toPortal.copy(PORTAL).sub(b.pos);
          const d = toPortal.length();
          const pull = k * k;
          b.pos.addScaledVector(toPortal.normalize(), pull * Math.max(0, d - 2));
          // orbital swirl while pulled
          const sw = pull * (4 + 6 * Math.sin(b.phase));
          b.pos.x += Math.sin(t * 3.1 + b.phase) * sw * 0.35;
          b.pos.y += Math.cos(t * 2.3 + b.phase) * sw * 0.3;
          hot = Math.min(1, k * 1.6);
          sc = b.scale * Math.max(0.001, 1 - k * 0.9);
          if (d < 2.2 || k >= 1) { b.dead = true; }
        }
      }
      if (b.dead) { sc = 0.0001; }

      e.set(
        Math.sin(t * 0.31 + b.phase) * 0.5 + Math.sin(t * 0.83 + b.phase * 3.1) * 0.15,
        t * b.spin + b.phase + Math.sin(t * 0.45 + b.phase * 1.3) * 0.3,
        Math.cos(t * 0.27 + b.phase) * 0.5 + Math.cos(t * 0.77 + b.phase * 2.3) * 0.15,
      );
      q.setFromEuler(e);
      s.setScalar(sc);
      m.compose(b.pos, q, s);
      mesh.setMatrixAt(i, m);

      // heat tint
      if (hot > 0) {
        c.copy(b.cover).lerp(HOT, Math.min(1, hot));
        mesh.setColorAt(i, c);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  const reset = () => {
    for (let i = 0; i < BOOK_COUNT; i++) {
      const b = books[i];
      b.dead = false;
      b.pos.copy(b.base);
      c.copy(b.cover);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  return { mesh, update, reset };
}
