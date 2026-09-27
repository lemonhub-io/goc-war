// main.ts — boot, renderer init (WebGPU w/ WebGL2 fallback), scene assembly, loop
import * as THREE from 'three/webgpu';
import { buildShelves, buildFloor, buildBooks } from './library';
import { buildPortal } from './portal';
import { buildDust, buildEmbers, buildFlames, buildSmoke, buildPageVortex } from './particles';
import { buildCombat } from './combat';
import { buildPost } from './fx';
import { Director } from './director';
import { createHud } from './hud';
import { createSynth } from './audio';
import { U, PORTAL, makeEmblemSVG } from './shared';

const BOOT_LINES = [
  'UNGOC TACNET v6.4 // SECURE UPLINK',
  'AUTH: STRIKE TEAM-1909 "FIREBREAK" — OK',
  'SAT-THAUM LINK: LOCKED  [108-COUNCIL EYES ONLY]',
  'COMPILING PARTICLE FIELD — 190K AGENTS',
  'ESTABLISHING WAY // KTE-7909-ALEXANDRIA',
];

async function typeBoot(): Promise<void> {
  const el = document.getElementById('boot-lines')!;
  for (const line of BOOT_LINES) {
    const d = document.createElement('div');
    el.appendChild(d);
    for (let i = 0; i <= line.length; i += 2) {
      d.textContent = `> ${line.slice(0, i)}`;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

function fatal(msg: string) {
  const f = document.getElementById('fatal')!;
  f.hidden = false;
  f.querySelector('.fatal-msg')!.textContent = msg;
  document.getElementById('boot')!.style.display = 'none';
}

async function initRenderer(canvas: HTMLCanvasElement): Promise<{ renderer: THREE.WebGPURenderer | null; webgpu: boolean }> {
  // try WebGPU first
  if ('gpu' in navigator) {
    try {
      const r = new THREE.WebGPURenderer({
        canvas, antialias: true, powerPreference: 'high-performance',
      });
      await r.init();
      if ((r.backend as any).isWebGPUBackend) return { renderer: r, webgpu: true };
      // landed on webgl fallback silently
    } catch { /* fall through */ }
  }
  try {
    const r = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
    await r.init();
    return { renderer: r, webgpu: false };
  } catch (e) {
    return { renderer: null, webgpu: false };
  }
}

async function boot() {
  const bootDone = typeBoot();
  const canvas = document.getElementById('scene') as HTMLCanvasElement;

  const { renderer, webgpu } = await initRenderer(canvas);
  if (!renderer) { fatal('RENDERER INIT FAILED — WebGPU + WebGL2 both unavailable on this device.'); return; }

  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  // ---------------------------------------------------------------- scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020308);
  scene.fog = new THREE.FogExp2(0x05070c, 0.028);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);
  camera.position.set(0, 4.6, 26);

  // lights — kept sparse; most illumination is emissive + bloom
  scene.add(new THREE.AmbientLight(0x1a2035, 0.85));
  const portalLight = new THREE.PointLight(0x5f9dff, 30, 90, 1.6);
  portalLight.position.set(PORTAL.x, PORTAL.y, PORTAL.z + 3);
  scene.add(portalLight);
  const fireLight = new THREE.PointLight(0xff6a22, 0, 70, 1.7);
  fireLight.position.set(0, 2.4, -10);
  scene.add(fireLight);

  const skip = new Set((new URLSearchParams(location.search).get('skip') || '').split(',').filter(Boolean));
  const add = (name: string, o: THREE.Object3D) => { if (!skip.has(name)) scene.add(o); };

  add('floor', buildFloor());
  add('shelves', buildShelves());
  const books = buildBooks();
  add('books', books.mesh);
  add('portal', buildPortal());
  add('dust', buildDust());
  const embers = buildEmbers(webgpu && !skip.has('compute'));
  add('embers', embers.object);
  if (webgpu && embers.initKernel) await renderer.computeAsync(embers.initKernel);
  add('flames', buildFlames());
  add('smoke', buildSmoke());
  const vortex = buildPageVortex();
  add('vortex', vortex.clean);
  add('vortexB', vortex.burning);

  const hud = createHud();
  const audio = createSynth();
  const combat = buildCombat(hud, audio);
  add('lances', combat.lances);
  add('bursts', combat.bursts);
  add('rings', combat.rings);

  const post = buildPost(renderer, scene, camera);
  const director = new Director(combat, hud);

  document.getElementById('emblem-slot')!.innerHTML = makeEmblemSVG();
  document.getElementById('boot-emblem')!.innerHTML = makeEmblemSVG(44);
  hud.setBackend(webgpu ? 'WEBGPU' : 'WEBGL2');
  hud.log('TAC-FEED 04 ONLINE');
  hud.setPhase(0);

  // audio toggle
  const at = document.getElementById('audio-toggle')!;
  at.addEventListener('click', () => {
    at.textContent = `AUDIO: ${audio.toggle() ? 'ON' : 'OFF'}`;
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------------------------------------------------------------- reveal
  await bootDone;
  const bootEl = document.getElementById('boot')!;
  bootEl.classList.add('done');
  setTimeout(() => (bootEl.style.display = 'none'), 900);
  document.getElementById('boot')!.addEventListener('click', () => {
    bootEl.classList.add('done');
    setTimeout(() => (bootEl.style.display = 'none'), 500);
  });

  // ---------------------------------------------------------------- loop
  const clock = new THREE.Clock();
  let t = 0;
  let frame = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    t += dt;

    director.update(t, dt, camera);
    books.update(t, U.strike.value, U.breach.value);

    // light rig breathes with the scene
    portalLight.intensity = 30 + U.breach.value * 700 + Math.sin(t * 7.3) * 8 * U.breach.value;
    fireLight.intensity = U.inferno.value * 420 * (0.8 + Math.sin(t * 9.7) * 0.2);

    if (webgpu && embers.updateKernel) renderer.compute(embers.updateKernel);
    if (skip.has('post')) renderer.render(scene, camera); else post.render();

    if ((frame & 7) === 0) hud.tick(t);
    frame++;
  });
}

boot().catch((e) => {
  console.error(e);
  fatal(`BOOT FAILURE — ${e?.message ?? e}`);
});
