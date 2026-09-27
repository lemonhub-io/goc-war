// main.ts — boot, WebGPU renderer init, scene assembly, quality governor, loop
import * as THREE from 'three/webgpu';
import {
  installDiagHooks, createDiagPanel, showDiag, dlog, dset,
  diagAdapterInfo, diagFrame, armWatchdog,
} from './diag';
import { buildShelves, buildFloor, buildBooks } from './library';
import { buildPortal } from './portal';
import { buildDust, buildEmbers, buildFlames, buildSmoke, buildPageVortex } from './particles';
import { buildCombat } from './combat';
import { buildPost } from './fx';
import { Director } from './director';
import { createHud } from './hud';
import { createSynth } from './audio';
import { U, PORTAL, makeEmblemSVG } from './shared';

installDiagHooks();

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
  dlog('FATAL', msg);
  showDiag();
}

/** runtime shape of the WebGPU backend — `adapter`/`device` exist but are
 *  absent from the shipped .d.ts */
interface GpuBackend {
  isWebGPUBackend?: boolean;
  adapter?: {
    info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  };
  device?: { lost: Promise<{ reason: string; message: string }> };
}

const backendOf = (r: THREE.WebGPURenderer): GpuBackend =>
  r.backend as unknown as GpuBackend;

async function initRenderer(canvas: HTMLCanvasElement): Promise<THREE.WebGPURenderer | null> {
  // WebGPU only — no WebGL fallback
  if (!('gpu' in navigator)) { dlog('INIT', 'navigator.gpu absent'); return null; }
  try {
    const r = new THREE.WebGPURenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
    });
    await r.init();
    if (!backendOf(r).isWebGPUBackend) { dlog('INIT', 'renderer init fell through to non-WebGPU backend'); return null; }
    dlog('INIT', 'WebGPU renderer up');
    return r;
  } catch (e) {
    dlog('INIT', `renderer init threw: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** true if the GPU adapter is software-emulated (SwiftShader / llvmpipe) */
function softwareAdapter(renderer: THREE.WebGPURenderer): boolean {
  try {
    const info = backendOf(renderer).adapter?.info;
    const name = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`;
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { return false; }
}

async function boot() {
  document.getElementById('load')?.remove();
  createDiagPanel();
  const bootDone = typeBoot();
  const canvas = document.getElementById('scene') as HTMLCanvasElement;

  const renderer = await initRenderer(canvas);
  if (!renderer) {
    fatal('WEBGPU REQUIRED — this page cannot be accessed on this device/browser.\nUSE: Chrome/Edge 113+, Safari 26+, or Firefox 141+ with hardware acceleration enabled.');
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  diagAdapterInfo(backendOf(renderer).adapter?.info);
  armWatchdog();

  // if the WebGPU device is lost (driver crash / GPU timeout), fail visibly
  backendOf(renderer).device?.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      dlog('DEVICE', `lost: ${info.reason} ${info.message ?? ''}`);
      fatal('WEBGPU DEVICE LOST — reload the page to retry.');
    }
  });

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
  const embers = buildEmbers(!skip.has('compute'));
  add('embers', embers.object);
  if (embers.initKernel) await renderer.computeAsync(embers.initKernel);
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

  // two precompiled post chains — swapping pipelines is a pointer change,
  // so quality transitions never recompile shaders mid-run
  const postFull = buildPost(renderer, scene, camera, false);
  const postLite = buildPost(renderer, scene, camera, true);
  const director = new Director(combat, hud, audio);

  document.getElementById('emblem-slot')!.innerHTML = makeEmblemSVG();
  document.getElementById('boot-emblem')!.innerHTML = makeEmblemSVG(44);
  hud.setBackend('WEBGPU');
  hud.log('TAC-FEED 04 ONLINE');
  hud.setPhase(0);

  // audio: arms on the first user gesture (browser policy), toggle overrides
  const at = document.getElementById('audio-toggle')!;
  const setAudioLabel = () => { at.textContent = `AUDIO: ${audio.enabled ? 'ON' : 'OFF'}`; };
  at.addEventListener('click', () => { audio.toggle(); setAudioLabel(); });
  addEventListener('pointerdown', (e) => {
    if (audio.enabled || e.target === at) return;
    audio.toggle(); setAudioLabel();
  });
  // quiet HUD tick each time a log line lands
  new MutationObserver(() => audio.blip())
    .observe(document.getElementById('log')!, { childList: true });

  // ---------------------------------------------------------------- perf governor
  // Fill-rate is the dominant cost (big additive sprites + post chain). Per
  // level we scale: drawn particle fraction, framebuffer pixel budget,
  // soft-sprite footprint, and post complexity — all live, no rebuilds.
  const params = new URLSearchParams(location.search);
  const forcedQ = params.get('q');                 // ?q=high|med|low|potato
  const softGPU = softwareAdapter(renderer);
  const mobileUA = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const weakHW = (navigator.hardwareConcurrency ?? 8) <= 4
    || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
  const LEVELS = [
    { name: 'HIGH',   q: 1.0,  px: 4.2e6, dprCap: 1.6,  lite: false, puff: 1.0 },
    { name: 'MED',    q: 0.7,  px: 2.6e6, dprCap: 1.25, lite: false, puff: 1.0 },
    { name: 'LOW',    q: 0.5,  px: 1.6e6, dprCap: 1.0,  lite: true,  puff: 0.85 },
    { name: 'POTATO', q: 0.32, px: 1.0e6, dprCap: 0.72, lite: true,  puff: 0.7 },
  ];
  let levelIdx = softGPU ? 3 : params.has('lite') ? 2 : mobileUA || weakHW ? 1 : 0;
  if (forcedQ) {
    const fi = LEVELS.findIndex((l) => l.name === forcedQ.toUpperCase());
    if (fi >= 0) levelIdx = fi;
  }
  const autoQ = !forcedQ;
  let qLevel = LEVELS[levelIdx];
  let post = postFull;
  let fpsEma = 60;
  let lastQChange = 0;
  let upStreak = 0;

  const applyQuality = () => {
    qLevel = LEVELS[levelIdx];
    // cap total framebuffer pixels — on 4K/retina screens raw dpr is the
    // single biggest cost driver, so budget first, dpr-cap second
    const dpr = Math.min(
      devicePixelRatio, qLevel.dprCap,
      Math.sqrt(qLevel.px / (innerWidth * innerHeight)),
    );
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight);
    for (const s of scalable) s.count = Math.max(64, Math.floor(s.userData.baseCount * qLevel.q));
    U.puffScale.value = qLevel.puff;
    post = qLevel.lite ? postLite : postFull;
    dset('quality', `${autoQ ? 'AUTO·' : ''}${qLevel.name}`);
    hud.setPerf(`${autoQ ? 'AUTO·' : ''}${qLevel.name}`);
  };
  applyQuality();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    applyQuality();
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

    // fps governor — down fast, up slow; badge shows live fps so the user
    // can see the governor working
    if (dt > 0) {
      fpsEma = fpsEma * 0.94 + (1 / dt) * 0.06;
      if (autoQ && t > 5 && t - lastQChange > 2.0) {
        if (fpsEma < 38 && levelIdx < LEVELS.length - 1) {
          levelIdx++; applyQuality(); lastQChange = t; upStreak = 0;
        } else if (fpsEma > 57 && levelIdx > 0) {
          if (++upStreak > 240) { levelIdx--; applyQuality(); lastQChange = t; upStreak = 0; }
        } else upStreak = 0;
      }
      if ((frame & 31) === 0) hud.setPerf(`${autoQ ? 'AUTO·' : ''}${qLevel.name} ${Math.round(fpsEma)}FPS`);
    }

    director.update(t, dt, camera);
    audio.update(dt);
    books.update(t, U.strike.value, U.breach.value);

    // light rig breathes with the scene
    portalLight.intensity = 30 + U.breach.value * 700 + Math.sin(t * 7.3) * 8 * U.breach.value;
    fireLight.intensity = U.inferno.value * 420 * (0.8 + Math.sin(t * 9.7) * 0.2);

    if (embers.updateKernel) renderer.compute(embers.updateKernel);
    try {
      if (skip.has('post')) renderer.render(scene, camera); else post.render();
      diagFrame();
    } catch (e) {
      // pipeline build failures land here on some drivers — surface once
      if ((frame & 63) === 0) dlog('RENDER', e instanceof Error ? (e.stack || e.message) : String(e));
      if (frame === 0) showDiag('first frame threw');
    }

    if ((frame & 7) === 0) hud.tick(t);
    frame++;
  });
}

boot().catch((e) => {
  console.error(e);
  fatal(`BOOT FAILURE — ${e?.message ?? e}`);
});
