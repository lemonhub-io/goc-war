// sigil.ts — thaumaturgy rig: the floor seal that inscribes itself during the
// approach (rings, rune band, counter-rotating star polygons), and the
// gyroscopic halo rings that orbit the Way. Both are pure shader surfaces
// driven by the shared uniforms (U.sigil / U.breach / U.strike).
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uv, mix, smoothstep, pow, abs, fract,
  sin, cos, atan, exp, texture,
} from 'three/tsl';
import { U, PORTAL, PORTAL_R, TWO_PI } from './shared';

// TSL's typings don't model its dynamic operator surface — helpers here pass raw nodes around
/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------ glyphs

const GLYPH_CELLS = 39;

/** a strip of invented rune glyphs, one per cell — sampled around the seal's rune band */
function makeGlyphStrip(): THREE.CanvasTexture {
  const cw = 42, ch = 64;
  const c = document.createElement('canvas');
  c.width = GLYPH_CELLS * cw; c.height = ch;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round';
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  for (let i = 0; i < GLYPH_CELLS; i++) {
    const ox = i * cw;
    // vertical spine most of the time, then 3-5 hooked strokes off a 3x5 lattice
    if (Math.random() < 0.75) {
      g.beginPath(); g.moveTo(ox + cw / 2, 9); g.lineTo(ox + cw / 2, ch - 9); g.stroke();
    }
    const strokes = 3 + ((Math.random() * 3) | 0);
    for (let s = 0; s < strokes; s++) {
      const x0 = ox + 8 + ((Math.random() * 3) | 0) * 13;
      const y0 = 9 + ((Math.random() * 5) | 0) * 11.5;
      const x1 = ox + 8 + ((Math.random() * 3) | 0) * 13;
      const y1 = 9 + ((Math.random() * 5) | 0) * 11.5;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    if (Math.random() < 0.5) {
      g.beginPath(); g.arc(ox + cw / 2, rnd(14, ch - 14), rnd(3.5, 6.5), 0, TWO_PI);
      Math.random() < 0.5 ? g.stroke() : g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

const rot2 = (p: any, a: any) => vec2(
  p.x.mul(cos(a)).sub(p.y.mul(sin(a))),
  p.x.mul(sin(a)).add(p.y.mul(cos(a))),
);

/** soft hairline around radius r0 */
const ringLine = (r: any, r0: number, w: number) => smoothstep(w, 0.0, abs(r.sub(r0)));

/** {n/k} star polygon of circumradius R — union of its n chords, unrolled so
 *  the chord normals stay compile-time constants */
function starLines(pr: any, r: any, n: number, k: number, R: number, w: number): any {
  const h = R * Math.cos((k * Math.PI) / n);
  let acc: any = float(0);
  for (let j = 0; j < n; j++) {
    const phi = (TWO_PI * j) / n + (k * Math.PI) / n;
    const d = abs(pr.x.mul(Math.cos(phi)).add(pr.y.mul(Math.sin(phi))).sub(h));
    acc = acc.max(smoothstep(w, 0.0, d));
  }
  return acc.mul(smoothstep(R + 0.006, R - 0.004, r));
}

/** filled node dots at the star's vertices */
function vertexNodes(pr: any, n: number, R: number, rad: number): any {
  let acc: any = float(0);
  for (let j = 0; j < n; j++) {
    const th = (TWO_PI * j) / n;
    const d = pr.sub(vec2(Math.cos(th) * R, Math.sin(th) * R)).length();
    const halo = smoothstep(0.006, 0.0, abs(d.sub(rad)));
    const dot = smoothstep(rad * 0.38, rad * 0.2, d);
    acc = acc.max(halo.add(dot));
  }
  return acc;
}

// ------------------------------------------------------------------ floor seal

export function buildSigil(): THREE.Mesh {
  const glyphs = makeGlyphStrip();
  const geo = new THREE.PlaneGeometry(66, 66);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  mat.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2.0);
    const r = p.length();
    const a = atan(p.y, p.x);
    const t = U.time;

    // ---- draw-on: the seal inscribes outward from the centre, a white-hot
    // front riding its leading edge
    const edge = U.sigil.mul(1.04);
    const vis = smoothstep(edge, edge.sub(0.07), r);
    const drawing = smoothstep(0.0, 0.03, U.sigil).mul(smoothstep(1.0, 0.92, U.sigil));
    const front = exp(abs(r.sub(edge)).mul(-46.0)).mul(drawing);

    // ---- concentric hairlines
    const rings = ringLine(r, 0.985, 0.008).mul(1.3)
      .add(ringLine(r, 0.94, 0.004))
      .add(ringLine(r, 0.72, 0.004))
      .add(ringLine(r, 0.68, 0.003).mul(0.7))
      .add(ringLine(r, 0.42, 0.005).mul(0.9))
      .add(ringLine(r, 0.17, 0.006));

    // ---- degree ticks on the outer band; every 10th one runs long
    const tm = fract(a.div(TWO_PI).mul(120.0).add(t.mul(0.05)));
    const tickBand = smoothstep(0.935, 0.95, r).mul(smoothstep(0.98, 0.965, r));
    const ticks = smoothstep(0.12, 0.0, abs(tm.sub(0.5))).mul(tickBand).mul(0.9);

    // ---- rune band, slowly counter-drifting
    const bandV = r.sub(0.735).div(0.185);
    const inBand = smoothstep(0.0, 0.05, bandV).mul(smoothstep(1.0, 0.95, bandV));
    const g = texture(glyphs, vec2(fract(a.div(TWO_PI).add(t.mul(0.011)).add(1.0)), bandV.oneMinus())).r;
    const runes = g.mul(inBand).mul(1.5);

    // ---- counter-rotating star polygons
    const prA = rot2(p, t.mul(0.085).add(U.strike.mul(0.6)));
    const prB = rot2(p, t.mul(-0.12).add(0.4));
    const prC = rot2(p, t.mul(0.2));
    const stars = starLines(prA, r, 6, 2, 0.70, 0.0045).mul(1.35)
      .add(starLines(prB, r, 8, 3, 0.46, 0.0042).mul(1.2))
      .add(starLines(prC, r, 3, 1, 0.23, 0.0045).mul(1.1));
    const nodes = vertexNodes(prA, 6, 0.70, 0.038).mul(1.4)
      .add(vertexNodes(prB, 8, 0.46, 0.028).mul(1.2));

    // ---- energy waves pumped outward once the strike commits
    const waves = pow(sin(r.mul(22.0).sub(t.mul(2.6))).mul(0.5).add(0.5), 9.0)
      .mul(U.strike.mul(0.55).add(U.breach.mul(0.12)))
      .mul(smoothstep(1.0, 0.25, r));
    // centre eye breathes
    const eye = smoothstep(0.17, 0.0, r).mul(sin(t.mul(2.2)).mul(0.25).add(0.75)).mul(0.35);

    const total = rings.add(ticks).add(runes).add(stars).add(nodes).add(waves).add(eye);
    const gain = float(0.85).add(U.breach.mul(0.55)).add(U.strike.mul(1.5));

    const col = mix(vec3(0.34, 0.6, 1.0), vec3(1.0, 0.78, 0.42), U.strike.mul(0.85));
    const lit = col.mul(total.mul(gain).mul(vis))
      .add(vec3(0.85, 0.93, 1.0).mul(front).mul(2.4));
    return vec4(lit, 1.0);
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0.05, -14);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}

// ------------------------------------------------------------------ gyro halo

export interface Thaumaturgy {
  object: THREE.Group;
  update(t: number): void;
}

/** three tilted rune-dashed rings gimballing around the aperture */
function buildHalo(): Thaumaturgy {
  const group = new THREE.Group();
  group.position.copy(PORTAL);

  const cfg = [
    { k: 1.26, tilt: [1.18, 0.0, 0.0], spin: 0.35, dash: 18 },
    { k: 1.44, tilt: [0.0, 1.05, 0.25], spin: -0.27, dash: 27 },
    { k: 1.62, tilt: [0.62, 0.58, 0.0], spin: 0.19, dash: 40 },
  ];
  const rings: { pivot: THREE.Object3D; ring: THREE.Mesh; c: typeof cfg[number] }[] = [];

  for (const c of cfg) {
    const geo = new THREE.RingGeometry(PORTAL_R * c.k, PORTAL_R * c.k + 0.16, 192, 1);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    mat.colorNode = Fn(() => {
      const p = uv().sub(0.5);
      const a = atan(p.y, p.x);
      // long dashes broken by a finer rune-tick comb; a bright comet runs around
      const dashes = smoothstep(0.15, 0.55, sin(a.mul(c.dash)).mul(0.5).add(0.5));
      const comb = pow(abs(sin(a.mul(c.dash * 6))), 3.0).mul(0.6).add(0.4);
      const comet = pow(sin(a.sub(U.time.mul(c.spin * 3.0)).mul(1.0)).mul(0.5).add(0.5), 14.0);
      const amp = U.breach.mul(0.9).add(U.strike.mul(1.1));
      const e = dashes.mul(comb).mul(0.7).add(comet.mul(2.2)).mul(amp);
      return vec4(mix(vec3(0.4, 0.68, 1.0), vec3(1.0, 0.85, 0.55), U.strike.mul(0.7)).mul(e), 1.0);
    })();
    const ring = new THREE.Mesh(geo, mat);
    ring.frustumCulled = false;
    ring.renderOrder = 10;
    const pivot = new THREE.Object3D();
    pivot.rotation.set(c.tilt[0], c.tilt[1], c.tilt[2]);
    pivot.add(ring);
    group.add(pivot);
    rings.push({ pivot, ring, c });
  }

  return {
    object: group,
    update(t: number) {
      const sp = 0.4 + U.breach.value * 1.2 + U.strike.value * 1.6;
      for (const r of rings) {
        r.ring.rotation.z = t * r.c.spin * sp;
        // slow precession so the gimbal never settles into a fixed pose
        r.pivot.rotation.x = r.c.tilt[0] + Math.sin(t * 0.21 * sp + r.c.k) * 0.25;
        r.pivot.rotation.y = r.c.tilt[1] + Math.cos(t * 0.17 * sp + r.c.k * 2) * 0.25;
      }
    },
  };
}

export function buildThaumaturgy(): Thaumaturgy {
  const group = new THREE.Group();
  group.add(buildSigil());
  const halo = buildHalo();
  group.add(halo.object);
  return { object: group, update: halo.update };
}
