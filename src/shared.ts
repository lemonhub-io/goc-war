// shared.ts — global uniforms, constants, procedural textures
import * as THREE from 'three/webgpu';
import { uniform, uniformArray, Fn, vec3, mix, smoothstep, instancedBufferAttribute } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** Permissive TSL node surface. The r186 typings don't model the dynamic
 *  swizzles/math operators that attribute/storage nodes expose at runtime
 *  (NodeExtensions interfaces are empty), so field access is funnelled
 *  through this one declared seam instead of scattered casts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TslField { [member: string]: any }

/** wrap a typed node to expose TSL's dynamic member surface */
export const field = (n: object): TslField => n as unknown as TslField;

/** instanced attribute → TSL field (positions/seeds as vec4) */
export const attr = (a: THREE.InstancedBufferAttribute | THREE.BufferAttribute): TslField =>
  field(instancedBufferAttribute(a) as object);

/** re-tag a TSL field value as a typed scalar node — for calls whose
 *  params are typed `Scalar` (vec3()/math fns reject untyped members) */
export const asScalar = (n: TslField): Node<'float'> => n as unknown as Node<'float'>;

export const SCAR_COUNT = 12;
export const SHOCK_COUNT = 6;

// ---------------------------------------------------------------- uniforms

export const U = {
  /** monotonic seconds */
  time: uniform(0),
  /** 0..1 — way aperture */
  breach: uniform(0),
  /** 0..1 — library fire spread */
  inferno: uniform(0),
  /** 0..1 — combat activity (vortex speed, lance glow) */
  strike: uniform(0),
  /** camera shake amplitude */
  shake: uniform(0),
  /** white flash envelope */
  flash: uniform(0),
  /** chromatic aberration boost on impacts */
  caBoost: uniform(0),
  /** live fill-rate dial — shrinks big soft sprites (smoke/flames) on low tiers */
  puffScale: uniform(1),
  /** global exposure lift during breach */
  exposure: uniform(1),
  /** last 4 impact events: xyz pos + w = start time */
  impacts: uniformArray([
    new THREE.Vector4(0, -999, 0, -999),
    new THREE.Vector4(0, -999, 0, -999),
    new THREE.Vector4(0, -999, 0, -999),
    new THREE.Vector4(0, -999, 0, -999),
  ]),
  /** 0..1 — floor sigil draw-on progress */
  sigil: uniform(0),
  /** 0..1 — the Way collapsing after the finisher (scales the aperture down) */
  collapse: uniform(0),
  /** 0..1 — falling ash density */
  ash: uniform(0),
  /** 0..1 — visibility of the floor scars (fades out with the loop) */
  scarFade: uniform(1),
  /** viewport aspect (w/h) — post shockwaves are aspect-corrected */
  aspect: uniform(16 / 9),
  /** 0..1 — crepuscular streak strength from the Way */
  rays: uniform(0),
  /** Way centre in screen uv (y down, WebGPU convention) */
  portalUv: uniform(new THREE.Vector2(0.5, 0.4)),
  /** floor scars from pillar strikes: x,z = pos, z-comp = size, w = start time */
  scars: uniformArray(Array.from({ length: SCAR_COUNT }, () => new THREE.Vector4(0, 0, 1, -999))),
  /** live screen-space shockwaves: xy = centre uv, z = age 0..1 (>=1 dead), w = signed strength */
  shocks: uniformArray(Array.from({ length: SHOCK_COUNT }, () => new THREE.Vector4(0.5, 0.5, 2, 0))),
};

let scarCursor = 0;
/** burn a scorch-and-crack scar into the floor at (x,z) */
export function pushScar(x: number, z: number, size: number, t: number) {
  const v = U.scars.array[scarCursor % SCAR_COUNT] as THREE.Vector4;
  v.set(x, z, size, t);
  scarCursor++;
}
export function clearScars() {
  for (const v of U.scars.array as THREE.Vector4[]) v.set(0, 0, 1, -999);
  scarCursor = 0;
}

let impactCursor = 0;
export function pushImpact(p: THREE.Vector3, t: number) {
  const v = U.impacts.array[impactCursor % 4] as THREE.Vector4;
  v.set(p.x, p.y, p.z, t);
  impactCursor++;
}

// ---------------------------------------------------------------- constants

export const PORTAL = new THREE.Vector3(0, 10.5, -17.5);
export const PORTAL_R = 7.4;

// ---------------------------------------------------------------- tsl helpers

/** classic ember color ramp: white-hot -> gold -> orange -> red -> dead */
export const emberRamp = /*#__PURE__*/ Fn(([t]: [any]) => {
  const c1 = vec3(1.0, 0.97, 0.82);
  const c2 = vec3(1.0, 0.62, 0.18);
  const c3 = vec3(0.95, 0.26, 0.06);
  const c4 = vec3(0.28, 0.04, 0.01);
  const a = mix(c1, c2, smoothstep(0.0, 0.25, t));
  const b = mix(a, c3, smoothstep(0.25, 0.68, t));
  return mix(b, c4, smoothstep(0.68, 1.0, t));
});

/** GOC energy ramp: near-white -> ice blue -> deep electric */
export const wayRamp = /*#__PURE__*/ Fn(([t]: [any]) => {
  const c1 = vec3(0.95, 0.99, 1.0);
  const c2 = vec3(0.42, 0.75, 1.0);
  const c3 = vec3(0.10, 0.32, 0.95);
  const a = mix(c1, c2, smoothstep(0.0, 0.45, t));
  return mix(a, c3, smoothstep(0.45, 1.0, t));
});

export const TWO_PI = Math.PI * 2;

/** deterministic fire spawn zones: xyz = center, w = radius */
export const FIRE_ZONE_COUNT = 26;
export function buildFireZones(): Float32Array {
  const arr = new Float32Array(FIRE_ZONE_COUNT * 4);
  let i = 0;
  const put = (x: number, y: number, z: number, r: number) => {
    arr[i * 4 + 0] = x; arr[i * 4 + 1] = y; arr[i * 4 + 2] = z; arr[i * 4 + 3] = r; i++;
  };
  // shelf base lines, both flanks
  for (let k = 0; k < 9; k++) {
    const z = -30 + k * 4.4;
    put(-11.5 - (k % 3) * 6.5, 0.3, z, 3.2);
    put(11.5 + (k % 3) * 6.5, 0.3, z, 3.2);
  }
  // center-floor hotspots (book piles) under the portal
  put(0, 0.4, -12, 4.5);
  put(-3.5, 0.3, -8, 2.6);
  put(3.8, 0.3, -7, 2.8);
  put(-1.2, 0.3, -4, 2.2);
  put(1.8, 0.3, -3, 2.4);
  // portal ring splash
  put(0, 10.5, -17.5, 7.2);
  put(0, 4.0, -16.5, 3.0);
  put(-5.5, 6.5, -17, 2.2);
  return arr;
}

// ---------------------------------------------------------------- textures

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** soft round smoke puff, blotchy */
export function makeSmokeTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 34;
      const x = 64 + Math.cos(a) * r;
      const y = 64 + Math.sin(a) * r * 0.9;
      const rad = 10 + Math.random() * 22;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      const v = 190 + Math.floor(Math.random() * 60);
      grad.addColorStop(0, `rgba(${v},${v},${v},${0.10 + Math.random() * 0.10})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    // radial mask so edges are always clean
    const mask = g.createRadialGradient(64, 64, 30, 64, 64, 62);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = mask;
    g.fillRect(0, 0, 128, 128);
    g.globalCompositeOperation = 'source-over';
  });
}

/** 2x2 page atlas: 3 parchment variants + 1 charred glowing variant */
export function makePageAtlas(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    const cell = (cx: number, cy: number, mode: number) => {
      g.save();
      g.translate(cx * 128, cy * 128);
      // parchment body with torn silhouette — alpha channel carries the page shape
      g.beginPath();
      const x0 = 22, y0 = 14, w = 84, h = 100;
      g.moveTo(x0 + 6, y0);
      g.lineTo(x0 + w - 8, y0 + 3);
      g.lineTo(x0 + w, y0 + h * 0.4);
      g.lineTo(x0 + w - 5, y0 + h - 6);
      g.lineTo(x0 + 10, y0 + h);
      g.lineTo(x0, y0 + h * 0.55);
      g.lineTo(x0 + 3, y0 + 8);
      g.closePath();
      if (mode < 3) {
        const shades = ['#d9cdb2', '#cbbfa4', '#e2d7bd'];
        g.fillStyle = shades[mode];
        g.fill();
        // scribbled glyph rows
        g.strokeStyle = 'rgba(58,44,30,0.75)';
        g.lineWidth = 1.6;
        for (let row = 0; row < 9; row++) {
          const y = y0 + 12 + row * 9.5;
          g.beginPath();
          let x = x0 + 10 + Math.random() * 6;
          const xEnd = x0 + w - 10 - Math.random() * 22;
          while (x < xEnd) {
            const seg = 3 + Math.random() * 7;
            const dy = (Math.random() - 0.5) * 4.5;
            g.moveTo(x, y);
            g.lineTo(x + seg, y + dy);
            if (Math.random() < 0.3) { g.moveTo(x + seg * 0.5, y - 2.6); g.lineTo(x + seg * 0.5, y + 2.6); }
            x += seg + 2.5;
          }
          g.stroke();
        }
        // marginal sigil
        g.strokeStyle = 'rgba(120,40,30,0.6)';
        g.strokeRect(x0 + w - 18, y0 + 6, 10, 10);
      } else {
        // charred page: near-black body, burning cracks
        g.fillStyle = '#0b0705';
        g.fill();
        g.strokeStyle = 'rgba(255,120,30,0.95)';
        g.lineWidth = 1.4;
        for (let i = 0; i < 26; i++) {
          const x = x0 + Math.random() * w;
          const y = y0 + Math.random() * h;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + (Math.random() - 0.5) * 18, y + (Math.random() - 0.5) * 18);
          g.stroke();
        }
        // ember edge
        g.strokeStyle = 'rgba(255,160,60,0.9)';
        g.lineWidth = 2.5;
        g.stroke();
      }
      g.restore();
    };
    cell(0, 0, 0); cell(1, 0, 1); cell(0, 1, 2); cell(1, 1, 3);
  });
}

/** teardrop flame, white-hot base */
export function makeFlameTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 96, (g) => {
    g.clearRect(0, 0, 64, 96);
    const grad = g.createRadialGradient(32, 78, 2, 32, 62, 52);
    grad.addColorStop(0.0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.25, 'rgba(255,220,140,0.85)');
    grad.addColorStop(0.55, 'rgba(255,140,40,0.55)');
    grad.addColorStop(0.85, 'rgba(200,50,10,0.18)');
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(32, 2);
    g.bezierCurveTo(50, 34, 58, 56, 32, 92);
    g.bezierCurveTo(6, 56, 14, 34, 32, 2);
    g.fill();
  });
}

/** GOC-ish emblem: ringed star in a broken circle */
export function makeEmblemSVG(size = 34): string {
  const s = size;
  return `<svg width="${s}" height="${s}" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="24" r="21" stroke="currentColor" stroke-width="1.6"/>
  <circle cx="24" cy="24" r="15" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3"/>
  <path d="M24 7 L27.8 19.2 L40.5 19.4 L30.6 27 L34.2 39.5 L24 32.2 L13.8 39.5 L17.4 27 L7.5 19.4 L20.2 19.2 Z" fill="currentColor" opacity="0.9"/>
</svg>`;
}
