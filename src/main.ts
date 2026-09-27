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
  const forceGL = new URLSearchParams(location.search).has('force-gl');
  // try WebGPU first — MSAA off: the post chain renders into textures anyway
  if (!forceGL && 'gpu' in navigator) {
    try {
      const r = new THREE.WebGPURenderer({
        canvas, antialias: false, powerPreference: 'high-performance',
      });
      await r.init();
      if ((r.backend as any).isWebGPUBackend) return { renderer: r, webgpu: true };
      // landed on webgl fallback silently
    } catch { /* fall through */ }
  }
  try {
    const r = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: true });
    await r.init();
    return { renderer: r, webgpu: false };
  } catch (e) {
    return { renderer: null, webgpu: false };
  }
}

/** true if the GPU adapter is software-emulated (SwiftShader / llvmpipe) */
function softwareAdapter(renderer: THREE.WebGPURenderer): boolean {
  try {
    const info = (renderer.backend as any)?.adapter?.info;
    const name = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`;
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { return false; }
}

async function boot() {
  const bootDone = typeBoot();
  const canvas = document.getElementById('scene') as HTMLCanvasElement;

  const { renderer, webgpu } = await initRenderer(canvas);
  if (!renderer) { fatal('RENDERER INIT FAILED — WebGPU + WebGL2 both unavailable on this device.'); return; }

  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  // if the WebGPU device is lost (driver crash / GPU timeout), reload once
  // in WebGL2 compatibility mode instead of leaving a black screen
  if (webgpu) {
    (renderer.backend as any).device?.lost?.then((info: any) => {
      if (info?.reason !== 'destroyed') {
        const u = new URL(location.href);
        u.searchParams.set('force-gl', '1');
        location.href = u.toString();
      }
    });
  }

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
  const scalable: THREE.Sprite[] = [];
  const add = (name: string, o: THREE.Object3D) => {
    if (skip.has(name)) return;
    scene.add(o);
    if (o.userData?.baseCount) scalable.push(o as THREE.Sprite);
  };

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

  // ---------------------------------------------------------------- perf governor
  // Fill-rate is the dominant cost (big additive sprites + bloom). Scale DPR and
  // the drawn fraction of each instanced particle system — both are live, free
  // to change, and degrade gracefully.
  const params = new URLSearchParams(location.search);
  const forcedQ = params.get('q');                 // ?q=high|med|low|potato
  const softGPU = softwareAdapter(renderer);
  const LEVELS = [
    { name: 'HIGH',   q: 1.0,  dpr: Math.min(devicePixelRatio, 1.6) },
    { name: 'MED',    q: 0.7,  dpr: Math.min(devicePixelRatio, 1.2) },
    { name: 'LOW',    q: 0.5,  dpr: 1.0 },
    { name: 'POTATO', q: 0.35, dpr: 0.8 },
  ];
  let levelIdx = params.has('lite') || softGPU ? 2 : 0;
  if (forcedQ) levelIdx = Math.max(0, LEVELS.findIndex((l) => l.name === forcedQ.toUpperCase()));
  const autoQ = !forcedQ;
  let qLevel = LEVELS[levelIdx];
  let fpsEma = 60;
  let lastQChange = 0;
  let upStreak = 0;

  const applyQuality = () => {
    qLevel = LEVELS[levelIdx];
    renderer.setPixelRatio(qLevel.dpr);
    renderer.setSize(innerWidth, innerHeight);
    for (const s of scalable) (s as any).count = Math.max(64, Math.floor(s.userData.baseCount * qLevel.q));
    hud.setPerf(`${autoQ ? 'AUTO·' : ''}${qLevel.name}`);
  };
  applyQuality();

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
  let t = 0;
  let last = performance.now();
  let frame = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    t += dt;

    // fps governor — down fast, up slow
    if (dt > 0) {
      fpsEma = fpsEma * 0.94 + (1 / dt) * 0.06;
      if (autoQ && t > 5 && t - lastQChange > 2.0) {
        if (fpsEma < 38 && levelIdx < LEVELS.length - 1) {
          levelIdx++; applyQuality(); lastQChange = t; upStreak = 0;
        } else if (fpsEma > 57 && levelIdx > 0) {
          if (++upStreak > 240) { levelIdx--; applyQuality(); lastQChange = t; upStreak = 0; }
        } else upStreak = 0;
      }
    }

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
