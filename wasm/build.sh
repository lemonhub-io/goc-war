#!/usr/bin/env bash
# Rebuilds both WASM packages into public/.
#   wasm-simd — stable toolchain, simd128, single-thread (always loadable)
#   wasm-mt   — nightly toolchain, atomics + shared memory + rayon pool
#               (only usable on cross-origin-isolated pages, i.e. COOP/COEP)
# Requires: rustup targets stable+nightly wasm32-unknown-unknown, wasm-pack,
#           rust-src component on nightly.
set -euo pipefail
cd "$(dirname "$0")"

echo "== wasm-simd (stable, simd128) =="
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build --target web --out-dir ../public/wasm-simd \
  --out-name goc_wasm --release

echo "== wasm-mt (nightly, atomics + rayon) =="
MT_FLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128"
MT_FLAGS="$MT_FLAGS -C link-arg=--shared-memory -C link-arg=--import-memory"
MT_FLAGS="$MT_FLAGS -C link-arg=--max-memory=1073741824"
MT_FLAGS="$MT_FLAGS -C link-arg=--export=__wasm_init_tls"
MT_FLAGS="$MT_FLAGS -C link-arg=--export=__tls_size"
MT_FLAGS="$MT_FLAGS -C link-arg=--export=__tls_align"
MT_FLAGS="$MT_FLAGS -C link-arg=--export=__tls_base"

# build-std recompiles std with the atomics features — required for TLS init
RUSTUP_TOOLCHAIN=nightly RUSTFLAGS="$MT_FLAGS" \
  cargo +nightly build --release --target wasm32-unknown-unknown \
  -Z build-std=panic_abort,std --features parallel

# wasm-bindgen CLI matching Cargo.toml's wasm-bindgen version
WB=$(ls -d ~/.cache/.wasm-pack/wasm-bindgen-*/wasm-bindgen | head -1)
mkdir -p ../public/wasm-mt
"$WB" target/wasm32-unknown-unknown/release/goc_wasm.wasm \
  --out-dir ../public/wasm-mt --typescript --target web --out-name goc_wasm

rm -f ../public/wasm-mt/package.json ../public/wasm-simd/package.json \
      ../public/wasm-mt/.gitignore ../public/wasm-simd/.gitignore
echo "done → public/wasm-simd + public/wasm-mt"
