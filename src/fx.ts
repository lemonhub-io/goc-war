// fx.ts — post chain: shockwave refraction, sun/fireball rays, HDR bloom,
// impact-driven chromatic aberration, vignette, film grain, scanline weave,
// the overcharge alarm (red edge pulse) and the inverted impact frame.
// `lite` tier: weaker bloom, no chromatic aberration — roughly halves the
// per-pixel post cost on weak GPUs while keeping the signature glow.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, pass, screenUV, hash, smoothstep, sin, exp, pow, mix, dot } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { U, field, TslField, SHOCK_COUNT } from './shared';

export function buildPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, lite = false): THREE.PostProcessing {
  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();

  // ---- shockwave refraction: each live shock is an expanding gaussian band that
  // shoves the frame radially (outward for muzzle / impact blasts)
  let offs: any = vec2(0.0, 0.0);
  for (let k = 0; k < SHOCK_COUNT; k++) {
    const sh = field(U.shocks.element(k));
    const d2 = screenUV.sub(vec2(sh.x, sh.y));
    const dc = vec2(d2.x.mul(U.aspect), d2.y);
    const d = dc.length();
    const age = sh.z;
    const ease = float(1.0).sub(pow(float(1.0).sub(age).clamp(0.0, 1.0), 2.2));
    const rad = ease.mul(0.95);
    const w = age.mul(0.06).add(0.03);
    const x = d.sub(rad).div(w);
    const band = exp(x.mul(x).negate());
    const amp = sh.w.mul(pow(float(1.0).sub(age).clamp(0.0, 1.0), 2.0)).mul(0.055);
    const dirUv = vec2(dc.x.div(U.aspect), dc.y).div(d.max(0.0001));
    offs = offs.add(dirUv.mul(band.mul(amp)));
  }
  const warped = field(sceneColor.sample(screenUV.sub(offs)));

  // ---- crepuscular streaks: short radial march toward the light source (sun / fireball); only the
  // hot HDR pixels (lum > ~1) contribute so the rest of the frame stays clean
  let rays: any = vec3(0.0, 0.0, 0.0);
  if (!lite) {
    const toC = field(U.rayUv).sub(screenUV);
    for (let i = 1; i <= 6; i++) {
      const tap = field(sceneColor.sample(screenUV.add(toC.mul(i * 0.07)))).rgb;
      const lum = dot(tap, vec3(0.3, 0.59, 0.11));
      rays = rays.add(tap.mul(smoothstep(0.8, 3.2, lum)).mul(Math.pow(0.82, i)));
    }
    rays = rays.mul(field(U.rays).mul(0.32));
  }

  const bloomed = warped.add(bloom(sceneColor, lite ? 0.5 : 0.75, 0.55, 0.65)).add(vec4(rays, 0.0));
  const c: TslField = lite
    ? bloomed
    : field(chromaticAberration(bloomed, field(U.caBoost).mul(0.55).add(0.06), new THREE.Vector2(0.5, 0.5), float(1.05)));

  post.outputNode = Fn(() => {
    const p = screenUV.sub(0.5);
    const r = p.length();

    // vignette
    const vig = smoothstep(0.95, 0.32, r.mul(1.35));
    // animated grain
    // (scalar seed — a vec3 hash collapses to per-column noise on some backends)
    const grain = hash(dot(screenUV.mul(919.0), vec2(12.9898, 78.233)).add(U.time.mul(61.0))).mul(0.022).sub(0.011);
    // faint scanline weave, breathes with alert state
    const scan = sin(screenUV.y.mul(900.0).add(U.time.mul(9.0))).mul(0.012).mul(U.shake.mul(0.5).add(0.4));
    // muzzle / impact flash
    const flash = U.flash.mul(vec3(0.85, 0.9, 1.0)).mul(0.55);

    // overcharge alarm: the frame edge pulses red in step with the warning beeps
    const alarm = vec3(1.0, 0.1, 0.04).mul(smoothstep(0.2, 0.75, r).mul(U.alarm).mul(0.55));

    // grade: scorched warmth while ground zero burns
    const graded = mix(c.rgb, c.rgb.mul(vec3(1.1, 0.97, 0.86)), U.fire.mul(0.55));
    const lit: any = graded.mul(vig.mul(U.exposure)).add(grain).add(scan).add(flash).add(alarm);
    // impact frame: a few frames of cold negative on the hit
    const neg = vec3(1.0, 1.0, 1.0).sub(lit.clamp(0.0, 1.0)).mul(vec3(0.82, 0.9, 1.0));
    const out = mix(lit, neg, U.invert);
    return vec4(out, 1.0);
  })();

  return post;
}
