// wasm.ts — loads the Rust BooksSim (wasm/src/lib.rs).
// Two builds ship in public/:
//   wasm-mt   → atomics + SharedArrayBuffer + rayon thread pool (needs COOP/COEP)
//   wasm-simd → single-thread simd128 (always available)
// The MT build is only used when the page is cross-origin isolated; else the
// SIMD build runs. InstancedBufferAttribute views map straight into wasm
// linear memory — the per-frame matrix/color upload is zero-copy.

export interface BooksWasm {
  mode: 'wasm-mt' | 'wasm-simd';
  threads: number;
  sim: { update(t: number, s: number, b: number): void; reset(): void };
  mats: Float32Array;
  cols: Float32Array;
}

interface WasmModule {
  default(input?: unknown): Promise<{ memory: WebAssembly.Memory }>;
  initThreadPool?(n: number): Promise<unknown>;
  BooksSim: new (n: number) => {
    update(t: number, s: number, b: number): void;
    reset(): void;
    mats_ptr(): number; mats_len(): number;
    cols_ptr(): number; cols_len(): number;
    free(): void;
  };
}

// resolve against document.baseURI — with base './' a bare relative import
// would resolve inside assets/, but the pkgs are served at the site root
async function tryLoad(dir: string, mt: boolean, n: number): Promise<BooksWasm> {
  const url = new URL(`${dir}/goc_wasm.js`, document.baseURI).href;
  const mod = (await import(/* @vite-ignore */ url)) as WasmModule;
  const out = await mod.default();
  const sim = new mod.BooksSim(n);
  const memory = out.memory;
  let threads = 1;
  if (mt && mod.initThreadPool) {
    const hw = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? 4;
    threads = Math.max(2, Math.min(8, hw - 1));
    await mod.initThreadPool(threads);
  }
  return {
    mode: mt ? 'wasm-mt' : 'wasm-simd',
    threads,
    sim,
    mats: new Float32Array(memory.buffer, sim.mats_ptr(), sim.mats_len()),
    cols: new Float32Array(memory.buffer, sim.cols_ptr(), sim.cols_len()),
  };
}

export async function loadBooksWasm(n: number): Promise<BooksWasm | null> {
  try {
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      try {
        return await tryLoad('wasm-mt', true, n);
      } catch {
        // shared-memory init can still fail (no COOP/COEP on this host,
        // browser without wasm threads) — fall through to the SIMD build
      }
    }
    return await tryLoad('wasm-simd', false, n);
  } catch (e) {
    console.warn('[wasm] BooksSim unavailable, using JS path', e);
    return null;
  }
}
