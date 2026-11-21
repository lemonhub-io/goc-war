// main.ts — boot, renderer init, scene assembly, operator input, quality governor, loop
import * as THREE from 'three/webgpu';
import {
  installDiagHooks, createDiagPanel, showDiag, dlog, dset,
  diagAdapterInfo, diagFrame, armWatchdog,
} from './diag';
import { buildSky, buildSun, buildEarth, buildEntryFlash } from './space';
import { buildPlatform } from './platform';
import { buildRod, buildDesignator } from './rod';
import { buildGround } from './ground';
import { buildImpact } from './impact';
import { buildPost } from './fx';
import { Director } from './director';
import { createHud } from './hud';
import { createSynth } from './audio';
import { U, SUN_DIR, makeEmblemSVG, setScreenYDown } from './shared';
import { initPwa } from './pwa';

installDiagHooks();

const BOOT_LINES = [
  'UNGOC TACNET v6.4 // SECURE UPLINK',
  'AUTH: ORBITAL STRIKE GROUP "AEGIS-7" — OK',
  'ORBITAL LINK: LOCKED  [108-COUNCIL EYES ONLY]',
  'COMPILING SCENE — EARTH / PLATFORM / GROUND ZERO',
  'ACQUIRING TARGET // KTE-7909',
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
  /** true when the device lacks 'core-features-and-limits' (some WebKit builds) */
  compatibilityMode?: boolean | null;
  device?: { lost: Promise<{ reason: string; message: string }> };
}

/** the adapter isn't kept by three's backend — ask for one ourselves for the diag/tiering.
 *  GPUAdapterInfo fields are prototype getters, so they're copied out explicitly. */
interface AdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  features?: { has(name: string): boolean };
  limits?: Record<string, number>;
}
async function probeAdapter(): Promise<AdapterLike | null> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<AdapterLike | null> } }).gpu;
    return (await gpu?.requestAdapter({ powerPreference: 'high-performance' })) ?? null;
  } catch { return null; }
}

const backendOf = (r: THREE.WebGPURenderer): GpuBackend =>
  r.backend as unknown as GpuBackend;

async function initRenderer(canvas: HTMLCanvasElement, allowWebGL: boolean): Promise<THREE.WebGPURenderer | null> {
  // WebGPU only — `?webgl` opts into the WebGL2 backend for debugging / headless capture
  if (!allowWebGL && !('gpu' in navigator)) { dlog('INIT', 'navigator.gpu absent'); return null; }
  try {
    const r = new THREE.WebGPURenderer({
      canvas, antialias: false, powerPreference: 'high-performance', forceWebGL: allowWebGL,
    });
    await r.init();
    if (!allowWebGL && !backendOf(r).isWebGPUBackend) { dlog('INIT', 'renderer init fell through to non-WebGPU backend'); return null; }
    dlog('INIT', allowWebGL ? 'WebGL2 backend (debug)' : 'WebGPU renderer up');
    return r;
  } catch (e) {
    dlog('INIT', `renderer init threw: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** true if the GPU adapter is software-emulated (SwiftShader / llvmpipe) */
function softwareAdapter(adapter: AdapterLike | null): boolean {
  try {
    const info = adapter?.info;
    const name = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.description ?? ''}`;
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch { return false; }
}

async function boot() {
  document.getElementById('load')?.remove();
  createDiagPanel();
  const bootDone = typeBoot();
  const canvas = document.getElementById('scene') as HTMLCanvasElement;

  const params = new URLSearchParams(location.search);
  if (params.has('clean')) document.body.classList.add('clean');   // ?clean hides the HUD overlay (capture)
  const renderer = await initRenderer(canvas, params.has('webgl'));
  if (!renderer) {
    fatal('WEBGPU REQUIRED — this page cannot be accessed on this device/browser.\nUSE: Chrome/Edge 113+, Safari 26+, or Firefox 141+ with hardware acceleration enabled.');
    return;
  }
  const isWebGPU = !!backendOf(renderer).isWebGPUBackend;
  setScreenYDown(isWebGPU);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const adapter = isWebGPU ? await probeAdapter() : null;
  diagAdapterInfo(adapter?.info);
  dset('compat', String(backendOf(renderer).compatibilityMode ?? 'n/a'));
  if (adapter?.features) dset('core-features', String(adapter.features.has('core-features-and-limits')));
  if (adapter?.limits) {
    const l = adapter.limits;
    dset('limits', `tex2d ${l.maxTextureDimension2D} vbuf ${l.maxVertexBuffers} vattr ${l.maxVertexAttributes} interstage ${l.maxInterStageShaderVariables} ubo ${l.maxUniformBufferBindingSize}`);
  }
  // GPU validation errors are asynchronous and never reach the render try/catch
  let gpuErrors = 0;
  (renderer as unknown as { onError: (i: { type?: string; message?: string }) => void }).onError = (i) => {
    gpuErrors++;
    dset('gpu-errors', String(gpuErrors));
    if (gpuErrors <= 6) dlog('GPU', `${i.type ?? 'GPUError'}: ${i.message ?? ''}`.slice(0, 900));
  };

  // if the WebGPU device is lost (driver crash / GPU timeout), fail visibly
  backendOf(renderer).device?.lost.then((info) => {
    if (info.reason !== 'destroyed') {
      dlog('DEVICE', `lost: ${info.reason} ${info.message ?? ''}`);
      fatal('WEBGPU DEVICE LOST — reload the page to retry.');
    }
  });

  // ---------------------------------------------------------------- scene
  // Two worlds share the scene and are toggled by the director: ORBIT (station,
  // Earth, rod) and GROUND (terrain, cities, impact). Lights live at scene
  // level and never change, so cutting between worlds never recompiles shaders.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.3, 7000);
  camera.position.set(-118, 30, 150);

  // rim from the real sun, a cheated key from the camera side so the station reads, earthshine fill
  const rimLight = new THREE.DirectionalLight(0xfff1de, 3.6);
  rimLight.position.copy(SUN_DIR).multiplyScalar(200);
  const keyLight = new THREE.DirectionalLight(0xcfe0ff, 2.6);
  keyLight.position.set(90, 70, 130);
  scene.add(rimLight, keyLight, new THREE.HemisphereLight(0x101830, 0x4a78c8, 1.3), new THREE.AmbientLight(0x1a2540, 0.7));

  const orbit = new THREE.Group();
  const sky = buildSky();
  const platform = buildPlatform();
  const rodOrbit = buildRod(1);
  const designator = buildDesignator();
  orbit.add(sky, buildSun(), buildEarth(), buildEntryFlash(), platform.group, rodOrbit.group, designator.mesh);
  scene.add(orbit);

  const ground = buildGround();
  const rodGround = buildRod(2.2);
  ground.group.add(rodGround.group, buildImpact());
  scene.add(ground.group);

  // quality governor scales every sprite cloud that declares a baseCount
  const scalable: THREE.Sprite[] = [];
  scene.traverse((o) => { if (o.userData?.baseCount) scalable.push(o as THREE.Sprite); });

  const skip = new Set((params.get('skip') || '').split(',').filter(Boolean));
  const hud = createHud();
  const audio = createSynth();
  const director = new Director({ orbit, ground, platform, rodOrbit, rodGround, designator, sky }, hud, audio);
  // ?freeze (stills) and ?auto (kiosk / ambient screen) run the plain cinematic loop
  director.interactive = !params.has('freeze') && !params.has('auto');

  const camParam = params.get('cam');
  if (camParam) {
    const v = camParam.split(',').map(Number);
    if (v.length >= 6) director.camOverride = { pos: new THREE.Vector3(v[0], v[1], v[2]), look: new THREE.Vector3(v[3], v[4], v[5]), fov: v[6] || 50 };
  }

  // two precompiled post chains — swapping pipelines is a pointer change,
  // so quality transitions never recompile shaders mid-run
  const postFull = buildPost(renderer, scene, camera, false);
  const postLite = buildPost(renderer, scene, camera, true);

  // warm every pipeline of both worlds before the first frame so the cuts
  // (orbit → rod-cam → impact → orbit) never hitch on a shader compile
  orbit.visible = true; ground.group.visible = true;
  if (!params.has('nowarm')) {
    try { await renderer.compileAsync(scene, camera); } catch (e) { dlog('COMPILE', String(e)); }
  }

  document.getElementById('emblem-slot')!.innerHTML = makeEmblemSVG();
  document.getElementById('boot-emblem')!.innerHTML = makeEmblemSVG(44);
  hud.setBackend(isWebGPU ? 'WEBGPU' : 'WEBGL2');
  hud.log('TAC-FEED 04 ONLINE');
  hud.setPhase(0);
  // audio: arms on the first user gesture (browser policy), toggle overrides;
  // the button pulses TAP TO ARM until sound is live so silence is never a surprise
  const at = document.getElementById('audio-toggle')!;
  const setAudioLabel = () => {
    at.textContent = audio.enabled ? 'AUDIO: ON' : 'AUDIO: TAP TO ARM ▸';
    at.classList.toggle('unarmed', !audio.enabled);
  };
  setAudioLabel();
  // blur after a click so Space goes back to being the trigger, not a button press
  at.addEventListener('click', () => { audio.toggle(); setAudioLabel(); at.blur(); });
  const arm = (e: Event) => {
    if (audio.enabled || e.target === at) return;
    audio.toggle(); setAudioLabel();
  };
  addEventListener('pointerdown', arm);
  addEventListener('keydown', arm);
  // ---------------------------------------------------------------- operator input
  // the whole frame is the trigger: press-and-hold (pointer / Space / Enter)
  // charges at the gate and fast-forwards elsewhere; a pointer that travels
  // turns into a look-around drag
  const offTrigger = (e: Event) =>
    e.target instanceof Element && !!e.target.closest('button, a, input, textarea, #diag, #fatal, #boot');
  let ptrId = -1, px0 = 0, py0 = 0, pxL = 0, pyL = 0;
  addEventListener('pointerdown', (e) => {
    if (ptrId !== -1 || offTrigger(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    ptrId = e.pointerId; px0 = pxL = e.clientX; py0 = pyL = e.clientY;
    director.press('ptr');
  });
  addEventListener('pointermove', (e) => {
    if (e.pointerId !== ptrId) return;
    director.drag(e.clientX - pxL, e.clientY - pyL, Math.hypot(e.clientX - px0, e.clientY - py0));
    pxL = e.clientX; pyL = e.clientY;
  });
  const ptrEnd = (e: PointerEvent) => { if (e.pointerId === ptrId) { ptrId = -1; director.lift('ptr'); } };
  addEventListener('pointerup', ptrEnd);
  addEventListener('pointercancel', ptrEnd);
  const trigKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space' && e.code !== 'Enter') return false;
    // a button that only holds focus from a mouse click hands Space back to the trigger;
    // keyboard-focused buttons (focus-visible) keep their normal activation
    const el = e.target;
    if (el instanceof HTMLButtonElement && !el.closest('#diag, #fatal') && !el.matches(':focus-visible')) {
      el.blur();
      return true;
    }
    return !offTrigger(e);
  };
  addEventListener('keydown', (e) => {
    if (!trigKey(e)) return;
    e.preventDefault();
    if (!e.repeat) director.press('key');
  });
  addEventListener('keyup', (e) => { if (trigKey(e)) { e.preventDefault(); director.lift('key'); } });
  const dropAll = () => { ptrId = -1; director.liftAll(); };
  addEventListener('blur', dropAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) dropAll(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // quiet HUD tick each time a log line lands
  new MutationObserver(() => audio.blip())
    .observe(document.getElementById('log')!, { childList: true });

  // ---------------------------------------------------------------- perf governor
  // Fill-rate is the dominant cost (big additive sprites + post chain). Per
  // level we scale: drawn particle fraction, framebuffer pixel budget,
  // soft-sprite footprint, and post complexity — all live, no rebuilds.
  const forcedQ = params.get('q');                 // ?q=high|med|low|potato
  const softGPU = softwareAdapter(adapter);
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
  // render ladder: a chain that keeps throwing (driver / WGSL compiler quirks on
  // some WebKit builds) steps down to the lite chain, then to a bare scene
  // render, so the feed degrades instead of going black
  const PATHS = ['post', 'lite post', 'no post'];
  let path = 0;
  let fails = 0;
  dset('render-path', PATHS[path]);
  armWatchdog();
  let t = Number(params.get('seek')) || 0;   // ?seek=SECONDS jumps the timeline (debug / capture)
  const freeze = params.has('freeze');       // ?freeze holds the timeline at `seek` (deterministic stills)
  let last = performance.now();
  let frame = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!freeze) t += dt * director.timeScale;   // slow-mo around the hits
    else director.snapNext();

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

    director.update(t, freeze ? 0.033 : dt, camera);
    audio.update(dt);

    try {
      if (skip.has('post') || path === 2) renderer.render(scene, camera);
      else (path === 1 ? postLite : post).render();
      diagFrame();
      fails = 0;
    } catch (e) {
      // pipeline build failures land here on some drivers
      const msg = e instanceof Error ? (e.stack || e.message) : String(e);
      if (fails === 0) {
        dlog('RENDER', `[${PATHS[path]}] ${msg}`.slice(0, 1500));
        dset(`render-error-${path}`, msg.split('\n')[0].slice(0, 240));
      }
      if (++fails >= 3) {
        if (path < 2) {
          path++; fails = 0;
          dset('render-path', PATHS[path]);
          dlog('RENDER', `stepping down to: ${PATHS[path]}`);
        } else if (fails === 3) showDiag('every render path throws');
      }
    }

    if ((frame & 7) === 0) hud.tick(t, director.hudState);
    frame++;
  });
}

initPwa();

boot().catch((e) => {
  console.error(e);
  fatal(`BOOT FAILURE — ${e?.message ?? e}`);
});
