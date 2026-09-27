// fx.ts — post chain: HDR bloom + impact-driven chromatic aberration +
// vignette, film grain, faint scanline weave
import * as THREE from 'three/webgpu';
import { Fn, vec3, vec4, pass, screenUV, hash, smoothstep, sin } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { U } from './shared';

export function buildPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): THREE.PostProcessing {
  const post = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();

  const bloomed = sceneColor.add(bloom(sceneColor as any, 0.85, 0.62, 0.02) as any);
  const aberrated: any = chromaticAberration(bloomed as any, U.caBoost.mul(0.55).add(0.06) as any, null as any, 1.05 as any) as any;

  post.outputNode = Fn(() => {
    const p = screenUV.sub(0.5);
    const r = p.length();
    const c = aberrated;

    // vignette
    const vig = smoothstep(0.95, 0.32, r.mul(1.35));
    // animated grain
    const grain = hash(vec3(screenUV.mul(919.0), U.time.mul(61.0))).mul(0.05).sub(0.025);
    // faint scanline weave, breathes with alert state
    const scan = sin(screenUV.y.mul(900.0).add(U.time.mul(9.0))).mul(0.012).mul(U.shake.mul(0.5).add(0.4));
    // breach / impact flash
    const flash = U.flash.mul(vec3(0.85, 0.9, 1.0)).mul(0.55);

    const out = c.rgb.mul(vig.mul(U.exposure)).add(grain).add(scan).add(flash);
    return vec4(out, 1.0);
  })();

  return post;
}
