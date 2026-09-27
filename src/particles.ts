// particles.ts — GPU particle systems: ember storm (compute), dust, flames,
// smoke, and the burning-page vortex spiraling into the Way
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uv, hash, mix, smoothstep, pow, abs, fract,
  sin, cos, exp, texture, instanceIndex,   instancedArray, If, Loop, select, deltaTime, int, max,
} from 'three/tsl';
import {
  U, PORTAL, emberRamp, TWO_PI, FIRE_ZONE_COUNT, buildFireZones,
  makeSmokeTexture, makeFlameTexture, makePageAtlas, attr, field, asScalar, TslField,
} from './shared';

function spriteCloud(mat: THREE.SpriteNodeMaterial, count: number, order = 12): THREE.Sprite {
  const s = new THREE.Sprite(mat);
  s.count = count;
  s.userData.baseCount = count;
  s.frustumCulled = false;
  s.renderOrder = order;
  return s;
}

// =================================================================== DUST

const LITE = new URLSearchParams(location.search).has('lite');
const DUST_COUNT = LITE ? 5000 : 10000;

export function buildDust(): THREE.Sprite {
  const seeds = new Float32Array(DUST_COUNT * 4);
  for (let i = 0; i < DUST_COUNT; i++) {
    seeds[i * 4] = (Math.random() - 0.5) * 70;      // x
    seeds[i * 4 + 1] = Math.random() * 26;          // y
    seeds[i * 4 + 2] = -40 + Math.random() * 60;    // z
    seeds[i * 4 + 3] = Math.random();               // seed
  }
  const sd = attr(new THREE.InstancedBufferAttribute(seeds, 4));
  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  mat.positionNode = Fn(() => {
    const s = sd.w;
    return vec3(
      sd.x.add(sin(U.time.mul(0.11).add(s.mul(40))).mul(2.4)),
      sd.y.add(sin(U.time.mul(0.07).add(s.mul(23))).mul(1.6)),
      sd.z.add(cos(U.time.mul(0.09).add(s.mul(31))).mul(2.2)),
    );
  })();
  mat.scaleNode = Fn(() => {
    const s = sd.w.mul(0.05).add(0.012);
    return vec2(s, s);
  })();
  mat.colorNode = Fn(() => {
    // motes catch the way-light near the portal, warm near the fires
    const toP = vec3(
      sd.x.sub(PORTAL.x), sd.y.sub(PORTAL.y), sd.z.sub(PORTAL.z),
    ).length();
    const cold = vec3(0.45, 0.65, 1.0).mul(U.breach.mul(0.8).add(0.12)).mul(smoothstep(26.0, 4.0, toP));
    const warm = vec3(0.9, 0.45, 0.15).mul(U.inferno.mul(0.5)).mul(0.4);
    const a = float(0.10).add(sd.w.mul(0.12));
    return vec4(cold.add(warm).mul(a).add(vec3(0.05, 0.05, 0.07).mul(a)), a);
  })();
  return spriteCloud(mat, DUST_COUNT, 5);
}

// =================================================================== EMBERS

export interface EmberSystem {
  object: THREE.Sprite;
  updateKernel?: THREE.ComputeNode;
  initKernel?: THREE.ComputeNode;
}

export function buildEmbers(webgpu: boolean): EmberSystem {
  const N = LITE ? 30000 : (webgpu ? 90000 : 30000);

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  if (webgpu) {
    // ---- stateful GPU compute path: positions persist, impacts shove them
    const pos = instancedArray(N, 'vec4');   // xyz + age
    const vel = instancedArray(N, 'vec4');   // xyz + seed
    const zones = instancedArray(buildFireZones(), 'vec4');

    const initKernel = Fn(() => {
      const i = instanceIndex;
      const h1 = hash(i.toFloat());
      const h2 = hash(i.toFloat().add(17.7));
      const h3 = hash(i.toFloat().add(41.3));
      const zi = int(h1.mul(FIRE_ZONE_COUNT)).mod(FIRE_ZONE_COUNT);
      const z = zones.element(zi);
      const dirRaw = vec3(h2.mul(2).sub(1), h3.mul(2).sub(1), h1.mul(2).sub(1));
      const dir = dirRaw.div(dirRaw.length().max(0.01));
      pos.element(i).assign(vec4(
        z.x.add(dir.x.mul(z.w.mul(h3))),
        z.y.add(abs(dir.y).mul(z.w.mul(0.5))),
        z.z.add(dir.z.mul(z.w.mul(h3))),
        h2.mul(7.0),
      ));
      vel.element(i).assign(vec4(dir.mul(0.4).add(vec3(0, 0.9, 0)).xyz, h3));
    })().compute(N);

    const updateKernel = Fn(() => {
      const i = instanceIndex;
      const p = pos.element(i);
      const v = vel.element(i);
      const seed = v.w;
      const dt = deltaTime.min(0.05);

      // turbulent thermal field
      const flow = vec3(
        sin(p.z.mul(0.32).add(U.time.mul(0.9))).mul(0.55)
          .add(sin(p.y.mul(0.5).add(U.time.mul(0.4))).mul(0.35)),
        float(0.9).add(sin(p.x.mul(0.3).add(U.time.mul(0.8))).mul(0.3))
          .add(U.inferno.mul(1.6)),
        cos(p.x.mul(0.28).sub(U.time.mul(0.6))).mul(0.55)
          .add(sin(p.y.mul(0.42).add(U.time.mul(0.5))).mul(0.35)),
      );

      // vortex pull around the Way
      const toC = vec3(PORTAL.x, PORTAL.y, PORTAL.z).sub(p.xyz);
      const dC = toC.length().max(0.5);
      const tangent = vec3(toC.z, 0, toC.x.negate()).normalize();
      const swirl = tangent.mul(exp(dC.mul(-0.09)).mul(2.6).mul(U.breach.add(0.2)))
        .add(toC.div(dC).mul(exp(dC.mul(-0.14)).mul(0.9).mul(U.breach)));

      const newV = v.xyz.mul(0.976).add(flow.add(swirl).mul(dt)).toVar();

      // impact shock impulses
      Loop(4, ({ i: k }) => {
        const imp = field(U.impacts.element(k));
        const ia = U.time.sub(imp.w);
        If(ia.greaterThan(0).and(ia.lessThan(1.5)), () => {
          const dv = p.xyz.sub(imp.xyz);
          const dd = dv.length().max(0.4);
          const amp = float(9.0).mul(exp(ia.mul(-3.2))).mul(exp(dd.mul(-0.07)));
          newV.addAssign(dv.div(dd).mul(amp));
        });
      });

      const newP = p.xyz.add(newV.mul(dt)).toVar();
      const life = float(3.5).add(seed.mul(7.0));
      const newAge = p.w.add(dt.mul(0.55).add(seed.mul(0.45))).toVar();

      const dead = newAge.greaterThan(life).or(newP.y.greaterThan(34)).or(newP.length().greaterThan(85));
      If(dead, () => {
        const h1 = hash(i.toFloat().add(U.time.mul(13.7)));
        const h2 = hash(i.toFloat().add(U.time.mul(7.3)).add(5.1));
        const h3 = hash(i.toFloat().add(U.time.mul(3.1)).add(9.7));
        const zi = int(h1.mul(FIRE_ZONE_COUNT)).mod(FIRE_ZONE_COUNT);
        const z = zones.element(zi);
        const dirRaw = vec3(h2.mul(2).sub(1), abs(h3.mul(2).sub(1)).mul(0.7), h1.mul(2).sub(1));
        const dir = dirRaw.div(dirRaw.length().max(0.01));
        p.assign(vec4(
          z.x.add(dir.x.mul(z.w.mul(h2))),
          z.y.add(dir.y.mul(z.w.mul(0.4))),
          z.z.add(dir.z.mul(z.w.mul(h2))),
          0,
        ));
        v.assign(vec4(dir.mul(0.5).add(vec3(0, 1.1, 0)), seed));
      }).Else(() => {
        p.assign(vec4(newP, newAge));
        v.assign(vec4(newV, seed));
      });
    })().compute(N);

    // render — same material grammar as the parametric fallback
    const posAttr = pos.toAttribute();
    const velAttr = vel.toAttribute();
    mat.positionNode = posAttr.xyz;
    mat.scaleNode = Fn(() => {
      const s = velAttr.w.mul(0.07).add(0.018).add(U.inferno.mul(0.02));
      return vec2(s, s);
    })();
    mat.colorNode = Fn(() => {
      const life = float(3.5).add(velAttr.w.mul(7.0));
      const ageN = posAttr.w.div(life).clamp(0, 1);
      const bright = emberRamp(ageN).mul(float(1.6).add(U.inferno.mul(2.2)));
      const a = smoothstep(0.0, 0.08, ageN).mul(smoothstep(1.0, 0.75, ageN));
      const amp = float(0.25).add(U.inferno.mul(0.9)).add(U.breach.mul(0.25));
      return vec4(bright.mul(a).mul(amp), a.mul(amp));
    })();

    const object = spriteCloud(mat, N, 13);
    return { object, initKernel, updateKernel };
  }

  // ---- parametric fallback (WebGL2): deterministic life loops
  const base = new Float32Array(N * 4);
  const misc = new Float32Array(N * 4);
  const zoneArr = buildFireZones();
  for (let i = 0; i < N; i++) {
    const zi = (Math.random() * FIRE_ZONE_COUNT) | 0;
    base[i * 4] = zoneArr[zi * 4] + (Math.random() - 0.5) * zoneArr[zi * 4 + 3] * 2;
    base[i * 4 + 1] = zoneArr[zi * 4 + 1] + Math.random() * 0.5;
    base[i * 4 + 2] = zoneArr[zi * 4 + 2] + (Math.random() - 0.5) * zoneArr[zi * 4 + 3] * 2;
    base[i * 4 + 3] = Math.random();
    misc[i * 4] = 4 + Math.random() * 9;          // rise height
    misc[i * 4 + 1] = Math.random() * TWO_PI;      // sway phase
    misc[i * 4 + 2] = 3.5 + Math.random() * 7;     // life
    misc[i * 4 + 3] = Math.random();               // size seed
  }
  const bs = attr(new THREE.InstancedBufferAttribute(base, 4));
  const ms = attr(new THREE.InstancedBufferAttribute(misc, 4));

  mat.positionNode = Fn(() => {
    const ph = fract(U.time.div(ms.z).add(bs.w));
    const ageN = ph;
    const sway = vec3(
      asScalar(sin(ageN.mul(9).add(ms.y)).mul(1.6)),
      asScalar(ageN.mul(ms.x)),
      asScalar(cos(ageN.mul(7).add(ms.y)).mul(1.6)),
    );
    // pull toward portal swirl high in the cycle
    const toC = vec3(PORTAL.x, PORTAL.y, PORTAL.z).sub(bs.xyz);
    const pull = pow(ageN, 2.0).mul(U.breach.mul(0.55));
    return bs.xyz.add(sway).add(toC.mul(pull));
  })();
  mat.scaleNode = Fn(() => {
    const s = ms.w.mul(0.07).add(0.018).add(U.inferno.mul(0.02));
    return vec2(s, s);
  })();
  mat.colorNode = Fn(() => {
    const ageN = fract(U.time.div(ms.z).add(bs.w));
    const bright = emberRamp(ageN).mul(float(1.6).add(U.inferno.mul(2.2)));
    const a = smoothstep(0.0, 0.08, ageN).mul(smoothstep(1.0, 0.75, ageN));
    const amp = float(0.25).add(U.inferno.mul(0.9)).add(U.breach.mul(0.25));
    return vec4(bright.mul(a).mul(amp), a.mul(amp));
  })();
  return { object: spriteCloud(mat, N, 13) };
}

// =================================================================== FLAMES

const FLAME_COUNT = LITE ? 900 : 1900;

export function buildFlames(): THREE.Sprite {
  const zoneArr = buildFireZones();
  const data = new Float32Array(FLAME_COUNT * 4);
  for (let i = 0; i < FLAME_COUNT; i++) {
    const zi = (Math.random() * (FIRE_ZONE_COUNT - 3)) | 0; // mostly shelf/floor zones
    data[i * 4] = zoneArr[zi * 4] + (Math.random() - 0.5) * zoneArr[zi * 4 + 3] * 1.6;
    data[i * 4 + 1] = zoneArr[zi * 4 + 1];
    data[i * 4 + 2] = zoneArr[zi * 4 + 2] + (Math.random() - 0.5) * zoneArr[zi * 4 + 3] * 1.6;
    data[i * 4 + 3] = Math.random();
  }
  const fd = attr(new THREE.InstancedBufferAttribute(data, 4));
  const tex = makeFlameTexture();

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  mat.positionNode = Fn(() => {
    const s = fd.w;
    const age = fract(U.time.mul(0.9).add(s.mul(9.3)));
    // gusty sway — amplitude surges and dies down per flame
    const gust = float(0.65).add(sin(U.time.mul(0.43).add(s.mul(17.0))).mul(0.35));
    return vec3(
      fd.x.add(sin(U.time.mul(2.0).add(s.mul(50))).mul(0.25).mul(gust)),
      fd.y.add(age.mul(1.1).add(s.mul(2.4))),
      fd.z.add(cos(U.time.mul(1.7).add(s.mul(37))).mul(0.25).mul(gust)),
    );
  })();
  mat.rotationNode = Fn(() => sin(U.time.mul(1.9).add(fd.w.mul(40))).mul(0.35))();
  mat.scaleNode = Fn(() => {
    const age = fract(U.time.mul(0.9).add(fd.w.mul(9.3)));
    const w = mix(float(0.5).add(fd.w.mul(0.7)), 0.08, age).mul(U.puffScale);
    return vec2(w, w.mul(2.1));
  })();
  mat.colorNode = Fn(() => {
    const age = fract(U.time.mul(0.9).add(fd.w.mul(9.3)));
    const t = texture(tex, vec2(uv().x, uv().y.oneMinus()));
    const hot = emberRamp(age.mul(0.8)).mul(2.6);
    const flicker = float(0.7).add(sin(U.time.mul(11).add(fd.w.mul(80))).mul(0.3));
    const a = t.a.mul(pow(age.oneMinus(), 1.4)).mul(flicker)
      .mul(float(0.1).add(U.inferno.mul(0.9)));
    return vec4(hot.mul(a), a);
  })();
  return spriteCloud(mat, FLAME_COUNT, 14);
}

// =================================================================== SMOKE

const SMOKE_COUNT = LITE ? 700 : 1400;

export function buildSmoke(): THREE.Sprite {
  const zoneArr = buildFireZones();
  const data = new Float32Array(SMOKE_COUNT * 4);
  for (let i = 0; i < SMOKE_COUNT; i++) {
    const zi = (Math.random() * FIRE_ZONE_COUNT) | 0;
    data[i * 4] = zoneArr[zi * 4] + (Math.random() - 0.5) * zoneArr[zi * 4 + 3] * 1.8;
    data[i * 4 + 1] = zoneArr[zi * 4 + 1] + 0.8;
    data[i * 4 + 2] = zoneArr[zi * 4 + 2] + (Math.random() - 0.5) * zoneArr[zi * 4 + 3] * 1.8;
    data[i * 4 + 3] = Math.random();
  }
  const sd = attr(new THREE.InstancedBufferAttribute(data, 4));
  const tex = makeSmokeTexture();

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  mat.positionNode = Fn(() => {
    const s = sd.w;
    const cyc = fract(U.time.mul(0.09).add(s.mul(3.7)));
    return vec3(
      sd.x.add(sin(cyc.mul(6).add(s.mul(40))).mul(2.6)).add(cyc.mul(6).mul(s.sub(0.5))),
      sd.y.add(cyc.mul(15)),
      sd.z.add(cos(cyc.mul(5).add(s.mul(31))).mul(2.4)),
    );
  })();
  mat.rotationNode = Fn(() => U.time.mul(0.12).mul(sd.w.sub(0.5)).add(sd.w.mul(9)))();
  mat.scaleNode = Fn(() => {
    const cyc = fract(U.time.mul(0.09).add(sd.w.mul(3.7)));
    const s = mix(float(1.6).add(sd.w.mul(2.0)), 7.0, cyc).mul(U.puffScale);
    return vec2(s, s);
  })();
  mat.colorNode = Fn(() => {
    const cyc = fract(U.time.mul(0.09).add(sd.w.mul(3.7)));
    const t = texture(tex, uv());
    // dark body, faintly fire-lit low in its life
    const underlit = pow(cyc.oneMinus(), 3.0).mul(U.inferno).mul(0.8);
    const col = mix(vec3(0.035, 0.035, 0.05), vec3(0.35, 0.13, 0.04), underlit);
    const a = t.a.mul(0.30).mul(smoothstep(0.0, 0.15, cyc)).mul(smoothstep(1.0, 0.55, cyc))
      .mul(float(0.15).add(U.inferno.mul(0.85)));
    return vec4(col, a);
  })();
  return spriteCloud(mat, SMOKE_COUNT, 15);
}

// =================================================================== PAGE VORTEX

const PAGE_CLEAN = LITE ? 2500 : 5500;
const PAGE_BURNING = LITE ? 900 : 2000;

interface PageAttrs { a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute }

function pageSeeds(count: number, burning: boolean): PageAttrs {
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    a[i * 4 + 0] = 2.5 + Math.pow(Math.random(), 0.8) * 15;   // orbit radius
    a[i * 4 + 1] = (0.25 + Math.random() * 0.9) * (Math.random() < 0.5 ? -1 : 1); // ang speed
    a[i * 4 + 2] = Math.random() * TWO_PI;                     // phase
    a[i * 4 + 3] = (Math.random() - 0.5) * 7;                  // z wave offset
    b[i * 4 + 0] = Math.random();                              // seed
    b[i * 4 + 1] = 0.4 + Math.random() * 0.9;                  // size
    b[i * 4 + 2] = burning ? 3 : (Math.random() * 3) | 0;      // atlas variant
    b[i * 4 + 3] = (Math.random() - 0.5) * 2.4;                // roll speed
  }
  return {
    a: new THREE.InstancedBufferAttribute(a, 4),
    b: new THREE.InstancedBufferAttribute(b, 4),
  };
}

export function buildPageVortex(): { clean: THREE.Sprite; burning: THREE.Sprite } {
  const atlas = makePageAtlas();

  const mkPos = (pa: TslField, pb: TslField) => Fn(() => {
    const spin = float(0.3).add(U.strike.mul(1.9));
    // orbital flutter — pages surge and slacken against the vortex pull
    const wob = sin(U.time.mul(0.42).add(pa.z.mul(2.0))).mul(0.3);
    const ang = pa.z.add(U.time.mul(pa.y).mul(spin)).add(wob);
    // harvest subset spirals into the throat as strike ramps
    const pull = select(pb.x.lessThan(0.3), U.strike.mul(0.85), float(0));
    const rr = pa.x.mul(pull.oneMinus().max(0.05));
    const bob = sin(U.time.mul(1.1).add(pa.z.mul(3.0))).mul(0.9);
    return vec3(
      asScalar(cos(ang).mul(rr).add(PORTAL.x)),
      asScalar(sin(ang).mul(rr).mul(0.8).add(bob).add(PORTAL.y)),
      asScalar(pa.w.add(sin(ang.mul(1.7).add(pa.z)).mul(1.2)).add(PORTAL.z)),
    );
  })();

  const mkRot = (pa: TslField, pb: TslField) => Fn(() => {
    const spin = float(0.3).add(U.strike.mul(1.9));
    const ang = pa.z.add(U.time.mul(pa.y).mul(spin));
    const flutter = sin(U.time.mul(3.1).add(pb.x.mul(60))).mul(0.6);
    return ang.mul(pb.w).add(flutter);
  })();

  // ---- clean pages
  const { a: cAttrA, b: cAttrB } = pageSeeds(PAGE_CLEAN, false);
  const cpa = attr(cAttrA);
  const cpb = attr(cAttrB);
  const cleanMat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  cleanMat.positionNode = mkPos(cpa, cpb);
  cleanMat.rotationNode = mkRot(cpa, cpb);
  cleanMat.scaleNode = Fn(() => {
    const flutter = float(0.85).add(sin(U.time.mul(2.3).add(cpb.x.mul(40))).mul(0.25));
    return vec2(cpb.y.mul(0.8).mul(flutter), cpb.y);
  })();
  cleanMat.colorNode = Fn(() => {
    // atlas cell derived from seed: 0→(0,0.5) 1→(0.5,0.5) 2→(0,0)
    const vi = hash(cpb.x.mul(911.0)).mul(3.0).floor();
    const off = select(vi.lessThan(0.5), vec2(0, 0.5),
      select(vi.lessThan(1.5), vec2(0.5, 0.5), vec2(0, 0)));
    const puv = uv().mul(0.5).add(off);
    const t = texture(atlas, puv);
    // pull subset gets sucked in — fade near the throat
    const rr = cpa.x.mul(select(cpb.x.lessThan(0.3), max(U.strike.mul(0.85).oneMinus(), 0.05), float(1)));
    const gone = smoothstep(1.4, 2.2, rr);
    // some pages ignite as the inferno spreads
    const ignited = smoothstep(cpb.x, cpb.x.add(0.1), U.inferno.mul(0.8));
    const shade = float(0.75).add(hash(cpb.x.mul(99)).mul(0.45));
    const warmTint = mix(vec3(1.0, 1.0, 1.0), vec3(1.6, 0.9, 0.5), ignited);
    const a = t.a.mul(gone).mul(0.92);
    return vec4(t.rgb.mul(shade).mul(warmTint), a);
  })();
  const clean = spriteCloud(cleanMat, PAGE_CLEAN, 11);

  // ---- burning pages
  const { a: bAttrA, b: bAttrB } = pageSeeds(PAGE_BURNING, true);
  const bpa = attr(bAttrA);
  const bpb = attr(bAttrB);
  const burnMat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  burnMat.positionNode = mkPos(bpa, bpb);
  burnMat.rotationNode = mkRot(bpa, bpb);
  burnMat.scaleNode = Fn(() => {
    const flutter = float(0.85).add(sin(U.time.mul(2.6).add(bpb.x.mul(40))).mul(0.3));
    return vec2(bpb.y.mul(0.8).mul(flutter), bpb.y);
  })();
  burnMat.colorNode = Fn(() => {
    const puv = uv().mul(0.5).add(vec2(0.5, 0.0)); // charred cell (1,0)
    const t = texture(atlas, puv);
    // burn cycle: appears only when the inferno reaches this page's threshold
    const gate = smoothstep(bpb.x.mul(0.9), bpb.x.mul(0.9).add(0.15), U.inferno);
    const cyc = fract(U.time.mul(0.3).add(bpb.x.mul(7.7)));
    const heat = emberRamp(cyc.mul(0.85)).mul(3.2);
    const a = t.a.mul(gate).mul(pow(cyc.oneMinus(), 0.7)).mul(0.95);
    return vec4(heat.mul(a), a);
  })();
  const burning = spriteCloud(burnMat, PAGE_BURNING, 12);

  return { clean, burning };
}
