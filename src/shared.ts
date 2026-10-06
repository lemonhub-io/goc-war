// shared.ts — world constants, global uniforms, colour ramps, procedural textures
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

/** untyped vec3 constructor — TSL's typings reject swizzle members as scalars */
export const V3: (x: any, y: any, z: any) => any = vec3 as any;

export const TWO_PI = Math.PI * 2;
export const SHOCK_COUNT = 6;

// ---------------------------------------------------------------- world
//
// Two worlds share one scene and are toggled by the director:
//   ORBIT   — platform at the origin, Earth far below (ER / ALT in scene units)
//   GROUND  — flat terrain, ground zero at the origin, 1 unit = 100 m

/** Earth radius and platform altitude (scene units, stylised) */
export const ER = 560;
export const ALT = 130;
export const EARTH_C = new THREE.Vector3(0, -(ER + ALT), 0);

/** unit vector (Earth-local) to the strike site, and its world position */
export const TARGET_DIR = new THREE.Vector3(-0.07, 1, -0.045).normalize();
export const TARGET_POS = EARTH_C.clone().addScaledVector(TARGET_DIR, ER);

/** direction to the sun — backlights the platform, puts the strike site on the night side */
export const SUN_DIR = new THREE.Vector3(0.78, -0.12, -0.40).normalize();

/** muzzle of the lance in platform-local space (cannon points down -Y) */
export const MUZZLE_LOCAL = new THREE.Vector3(0, -28.4, 0);

// ---------------------------------------------------------------- uniforms

export const U = {
  /** monotonic seconds */
  time: uniform(0),
  /** camera shake amplitude */
  shake: uniform(0),
  /** white flash envelope */
  flash: uniform(0),
  /** chromatic aberration boost on impacts */
  caBoost: uniform(0),
  /** live fill-rate dial — shrinks big soft sprites (smoke/flames) on low tiers */
  puffScale: uniform(1),
  /** global exposure lift */
  exposure: uniform(1),
  /** viewport aspect (w/h) — post shockwaves are aspect-corrected */
  aspect: uniform(16 / 9),
  /** crepuscular streak strength + source position (screen uv, y per backend) */
  rays: uniform(0),
  rayUv: uniform(new THREE.Vector2(0.5, 0.4)),
  /** live screen-space shockwaves: xy = centre uv, z = age 0..1 (>=1 dead), w = signed strength */
  shocks: uniformArray(Array.from({ length: SHOCK_COUNT }, () => new THREE.Vector4(0.5, 0.5, 2, 0))),

  /** 0..1 muzzle flash, barrel heat; absolute time the lance fired this cycle */
  muzzle: uniform(0),
  heat: uniform(0),
  tFire: uniform(1e4),
  /** 0..1 platform capacitor charge */
  charge: uniform(0),
  /** 0..1 target lock on the Earth surface */
  lock: uniform(0),
  /** 0..1 designator laser */
  designator: uniform(0),
  /** 0..1 re-entry plasma on the rod / atmosphere */
  reentry: uniform(0),
  /** absolute time of ground impact in this loop cycle (age = time - tImpact) */
  tImpact: uniform(1e4),
  /** 0..1 surface firelight (terrain / clouds / buildings pick it up) */
  fire: uniform(0),

  sunDir: uniform(SUN_DIR.clone()),
  targetDir: uniform(TARGET_DIR.clone()),
  /** world position where the rod meets the atmosphere (orbit view) */
  entryPos: uniform(new THREE.Vector3(0, -1e4, 0)),
  /** rod position in the ground world (lights the cloud decks as it passes) */
  rodPosG: uniform(new THREE.Vector3(0, 1e4, 0)),
};

// ---------------------------------------------------------------- screen convention

let screenYDown = true;
/** WebGPU screenUV has y=0 at the top, the WebGL2 backend at the bottom */
export const setScreenYDown = (v: boolean) => { screenYDown = v; };
export const isScreenYDown = () => screenYDown;

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

/** cold plasma ramp: near-white -> ice blue -> deep electric */
export const wayRamp = /*#__PURE__*/ Fn(([t]: [any]) => {
  const c1 = vec3(0.95, 0.99, 1.0);
  const c2 = vec3(0.42, 0.75, 1.0);
  const c3 = vec3(0.10, 0.32, 0.95);
  const a = mix(c1, c2, smoothstep(0.0, 0.45, t));
  return mix(a, c3, smoothstep(0.45, 1.0, t));
});

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
