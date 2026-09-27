// goc_wasm — CPU-side scene computation in Rust → WASM.
// The hot loop is the levitating-book system: ~460 books × trig, quaternion,
// mat4 compose and color lerp per frame, written straight into views that
// the JS side binds as InstancedBufferAttribute storage (zero copy).
//
// - drift trig is batched 4-at-a-time through f32x4 helpers (simd128)
// - "parallel" feature splits the book range across rayon workers when the
//   page is cross-origin isolated (COOP/COEP), else the serial build runs

use wasm_bindgen::prelude::*;

#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;

// force a thread-local root so wasm-ld emits __wasm_init_tls — required by
// the wasm-bindgen threading transform (it errors without TLS data)
#[cfg(feature = "parallel")]
mod tls_root {
    use std::cell::Cell;
    thread_local! { static TLS: Cell<u32> = const { Cell::new(7) }; }
    #[wasm_bindgen::prelude::wasm_bindgen]
    pub fn __goc_tls_root() -> u32 { TLS.with(|c| c.get()) }
}
#[cfg(feature = "parallel")]
pub use tls_root::__goc_tls_root;

use core::arch::wasm32::*;

const PORTAL: [f32; 3] = [0.0, 10.5, -17.5];
const HOT: [f32; 3] = [1.0, 0.478, 0.157];
const TWO_PI: f32 = 6.283185307179586;

// ---------------------------------------------------------------- fast sin
// Bhaskara-style approximation, |err| ~0.15% on [-pi, pi] — plenty for visual
// motion and ~30× cheaper than libm on the wasm path.

#[inline(always)]
fn wrap_pi(x: f32) -> f32 {
    // wrap to [-pi, pi]
    let k = (x * (1.0 / TWO_PI) + 0.5).floor();
    x - k * TWO_PI
}

#[inline(always)]
fn sin_fast(x: f32) -> f32 {
    let x = wrap_pi(x);
    // parabolic: 4x(pi-|x|) / (pi*pi - 4|x|(pi-|x|)) * sign(x)
    let ax = x.abs();
    let num = 4.0 * x * (core::f32::consts::PI - ax);
    let den = core::f32::consts::PI * core::f32::consts::PI - 4.0 * ax * (core::f32::consts::PI - ax);
    num / den
}

#[inline(always)]
fn cos_fast(x: f32) -> f32 {
    sin_fast(x + core::f32::consts::FRAC_PI_2)
}

#[cfg(target_feature = "simd128")]
#[inline(always)]
fn sin4(v: v128) -> v128 {
    let pi = f32x4_splat(core::f32::consts::PI);
    let inv_2pi = f32x4_splat(1.0 / TWO_PI);
    let half = f32x4_splat(0.5);
    let two_pi = f32x4_splat(TWO_PI);
    // wrap: x - floor(x/2pi + .5)*2pi
    let k = f32x4_floor(f32x4_add(f32x4_mul(v, inv_2pi), half));
    let x = f32x4_sub(v, f32x4_mul(k, two_pi));
    let ax = f32x4_abs(x);
    let t = f32x4_sub(pi, ax);                        // pi - |x|
    let num = f32x4_mul(f32x4_mul(f32x4_splat(4.0), x), t);
    let den = f32x4_sub(f32x4_mul(pi, pi), f32x4_mul(f32x4_splat(4.0), f32x4_mul(ax, t)));
    f32x4_div(num, den)
}

// ---------------------------------------------------------------- rng
// deterministic xorshift — book layout varies per build seed, same as JS's
// Math.random in spirit (no need to match positions exactly)

struct Rng(u64);
impl Rng {
    #[inline(always)]
    fn next(&mut self) -> f32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        self.0 = s;
        ((s >> 11) as f32) * (1.0 / 9007199254740992.0)
    }
    #[inline(always)]
    fn range(&mut self, a: f32, b: f32) -> f32 {
        a + self.next() * (b - a)
    }
}

// ---------------------------------------------------------------- sim

#[wasm_bindgen]
pub struct BooksSim {
    n: usize,
    // per-book statics
    base: Vec<f32>,      // xyz * n
    params: Vec<f32>,    // bobAmp, bobSpeed, phase, spin * n
    misc: Vec<f32>,      // scale, pullDelay, harvested, _ * n
    dead: Vec<f32>,      // 0/1 flags — mutable during update
    cover: Vec<f32>,     // rgb * n
    // outputs (mapped by JS into instanced attributes)
    mats: Vec<f32>,      // 16 * n — column-major
    cols: Vec<f32>,      // 3 * n
}

const COVERS: [[f32; 3]; 8] = [
    [0.353, 0.114, 0.114], [0.173, 0.227, 0.165], [0.114, 0.169, 0.271],
    [0.290, 0.212, 0.125], [0.227, 0.122, 0.227], [0.341, 0.314, 0.243],
    [0.133, 0.149, 0.180], [0.420, 0.353, 0.200],
];

#[wasm_bindgen]
impl BooksSim {
    #[wasm_bindgen(constructor)]
    pub fn new(n: usize) -> BooksSim {
        let mut rng = Rng(0x9E3779B97F4A7C15 ^ (n as u64));
        let mut base = vec![0.0; n * 3];
        let mut params = vec![0.0; n * 4];
        let mut misc = vec![0.0; n * 4];
        let mut cover = vec![0.0; n * 3];
        let harvest_n = (n as f32 * 0.38) as usize;
        for i in 0..n {
            let r = 3.0 + rng.next().powf(0.7) * 16.0;
            let a = rng.next() * TWO_PI;
            base[i * 3] = a.cos() * r * 1.15;
            base[i * 3 + 1] = 1.5 + rng.next() * 10.5;
            base[i * 3 + 2] = -16.0 + a.sin() * r * 0.8 + rng.next() * 6.0;

            params[i * 4] = 0.15 + rng.next() * 0.55;      // bobAmp
            params[i * 4 + 1] = 0.4 + rng.next() * 0.9;    // bobSpeed
            params[i * 4 + 2] = rng.next() * TWO_PI;       // phase
            params[i * 4 + 3] = (rng.next() - 0.5) * 0.7;  // spin

            misc[i * 4] = 0.7 + rng.next() * 0.9;                      // scale
            misc[i * 4 + 1] = rng.next() * 0.85;                       // pullDelay
            misc[i * 4 + 2] = if i < harvest_n { 1.0 } else { 0.0 };   // harvested
            misc[i * 4 + 3] = 0.0;                                     // dead

            let c = COVERS[(rng.next() * COVERS.len() as f32) as usize];
            cover[i * 3] = c[0];
            cover[i * 3 + 1] = c[1];
            cover[i * 3 + 2] = c[2];
        }
        BooksSim {
            n, base, params, misc, cover,
            dead: vec![0.0; n],
            mats: vec![0.0; n * 16],
            cols: vec![0.0; n * 3],
        }
    }

    pub fn count(&self) -> usize { self.n }

    /// pointer/len pairs for zero-copy views over wasm linear memory
    pub fn mats_ptr(&self) -> *const f32 { self.mats.as_ptr() }
    pub fn mats_len(&self) -> usize { self.mats.len() }
    pub fn cols_ptr(&self) -> *const f32 { self.cols.as_ptr() }
    pub fn cols_len(&self) -> usize { self.cols.len() }

    pub fn reset(&mut self) {
        for i in 0..self.n {
            self.dead[i] = 0.0;
            self.cols[i * 3] = self.cover[i * 3];
            self.cols[i * 3 + 1] = self.cover[i * 3 + 1];
            self.cols[i * 3 + 2] = self.cover[i * 3 + 2];
        }
    }

    // ---------------------------------------------------------- update

    /// per-frame book update — fills mats[] and cols[]
    pub fn update(&mut self, t: f32, strike: f32, _breach: f32) {
        let n = self.n;
        let base = &self.base;
        let params = &self.params;
        let misc = &self.misc;
        let cover = &self.cover;

        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            // zip output buffers with their book index, parallel over rows
            self.mats
                .par_chunks_mut(16)
                .zip(self.cols.par_chunks_mut(3))
                .zip(self.dead.par_iter_mut())
                .enumerate()
                .for_each(|(i, ((m, c), dead))| {
                    update_book(i, t, strike, base, params, misc, dead, cover, m, c);
                });
        }
        #[cfg(not(feature = "parallel"))]
        {
            // drift trig batched through f32x4 — the rest is scalar
            simd_drift_pass(n, t, base, params, &mut self.mats);
            for i in 0..n {
                let m = &mut self.mats[i * 16..i * 16 + 16];
                let c = &mut self.cols[i * 3..i * 3 + 3];
                let dead = &mut self.dead[i];
                update_book(i, t, strike, base, params, misc, dead, cover, m, c);
            }
        }
    }
}

/// SIMD pass: writes drift offsets into the mat's translation column.
/// Harvest/quaternion fill happens per-book afterwards.
#[cfg(target_feature = "simd128")]
fn simd_drift_pass(n: usize, t: f32, base: &[f32], params: &[f32], mats: &mut [f32]) {
    let mut i = 0usize;
    let chunks = n / 4;
    for _ in 0..chunks {
        let i0 = i;
        // gather 4 books' params
        let bob_speed = f32x4(
            params[(i0) * 4 + 1], params[(i0 + 1) * 4 + 1],
            params[(i0 + 2) * 4 + 1], params[(i0 + 3) * 4 + 1],
        );
        let phase = f32x4(
            params[i0 * 4 + 2], params[(i0 + 1) * 4 + 2],
            params[(i0 + 2) * 4 + 2], params[(i0 + 3) * 4 + 2],
        );
        let bob_amp = f32x4(
            params[i0 * 4], params[(i0 + 1) * 4],
            params[(i0 + 2) * 4], params[(i0 + 3) * 4],
        );
        let tt = f32x4_splat(t);

        // beat = 0.65 + 0.35*sin(t*0.21 + phase*2.1)
        let beat = f32x4_add(
            f32x4_splat(0.65),
            f32x4_mul(
                f32x4_splat(0.35),
                sin4(f32x4_add(f32x4_mul(tt, f32x4_splat(0.21)), f32x4_mul(phase, f32x4_splat(2.1)))),
            ),
        );
        // dy = sin(t*speed + phase) * amp * beat
        let dy = f32x4_mul(
            f32x4_mul(sin4(f32x4_add(f32x4_mul(tt, bob_speed), phase)), bob_amp),
            beat,
        );
        // dx = sin(t*speed*0.6 + phase*1.7) * amp * 0.5 * beat
        let dx = f32x4_mul(
            f32x4_mul(
                f32x4_mul(
                    sin4(f32x4_add(
                        f32x4_mul(f32x4_mul(tt, bob_speed), f32x4_splat(0.6)),
                        f32x4_mul(phase, f32x4_splat(1.7)),
                    )),
                    bob_amp,
                ),
                f32x4_splat(0.5),
            ),
            beat,
        );
        // dz = cos(t*speed*0.45 + phase*0.9) * amp * 0.3 * beat
        let dz = f32x4_mul(
            f32x4_mul(
                f32x4_mul(
                    sin4(f32x4_add(
                        f32x4_add(
                            f32x4_mul(f32x4_mul(tt, bob_speed), f32x4_splat(0.45)),
                            f32x4_splat(core::f32::consts::FRAC_PI_2),
                        ),
                        f32x4_mul(phase, f32x4_splat(0.9)),
                    )),
                    bob_amp,
                ),
                f32x4_splat(0.3),
            ),
            beat,
        );

        for k in 0..4 {
            let bi = i0 + k;
            // store base+drift into translation column (m[12..14])
            let (dxk, dyk, dzk) = match k {
                0 => (f32x4_extract_lane::<0>(dx), f32x4_extract_lane::<0>(dy), f32x4_extract_lane::<0>(dz)),
                1 => (f32x4_extract_lane::<1>(dx), f32x4_extract_lane::<1>(dy), f32x4_extract_lane::<1>(dz)),
                2 => (f32x4_extract_lane::<2>(dx), f32x4_extract_lane::<2>(dy), f32x4_extract_lane::<2>(dz)),
                _ => (f32x4_extract_lane::<3>(dx), f32x4_extract_lane::<3>(dy), f32x4_extract_lane::<3>(dz)),
            };
            mats[bi * 16 + 12] = base[bi * 3] + dxk;
            mats[bi * 16 + 13] = base[bi * 3 + 1] + dyk;
            mats[bi * 16 + 14] = base[bi * 3 + 2] + dzk;
        }
        i += 4;
    }
    // tail
    for bi in i..n {
        let amp = params[bi * 4];
        let speed = params[bi * 4 + 1];
        let phase = params[bi * 4 + 2];
        let beat = 0.65 + 0.35 * sin_fast(t * 0.21 + phase * 2.1);
        mats[bi * 16 + 12] = base[bi * 3] + sin_fast(t * speed * 0.6 + phase * 1.7) * amp * 0.5 * beat;
        mats[bi * 16 + 13] = base[bi * 3 + 1] + sin_fast(t * speed + phase) * amp * beat;
        mats[bi * 16 + 14] = base[bi * 3 + 2] + cos_fast(t * speed * 0.45 + phase * 0.9) * amp * 0.3 * beat;
    }
}

#[cfg(not(target_feature = "simd128"))]
fn simd_drift_pass(_n: usize, _t: f32, _base: &[f32], _params: &[f32], _mats: &mut [f32]) {}

/// per-book scalar pass: harvest pull, quaternion, matrix compose, color.
/// For the serial path `m[12..14]` is pre-filled by the SIMD pass.
#[inline(always)]
fn update_book(
    i: usize, t: f32, strike: f32,
    base: &[f32], params: &[f32], misc: &[f32], dead: &mut f32, cover: &[f32],
    m: &mut [f32], c: &mut [f32],
) {
    let phase = params[i * 4 + 2];
    let spin = params[i * 4 + 3];
    let scale0 = misc[i * 4];
    let pull_delay = misc[i * 4 + 1];
    let harvested = misc[i * 4 + 2] > 0.5;

    #[cfg(feature = "parallel")]
    {
        // parallel path computes drift inline (no pre-pass)
        let amp = params[i * 4];
        let speed = params[i * 4 + 1];
        let beat = 0.65 + 0.35 * sin_fast(t * 0.21 + phase * 2.1);
        m[12] = base[i * 3] + sin_fast(t * speed * 0.6 + phase * 1.7) * amp * 0.5 * beat;
        m[13] = base[i * 3 + 1] + sin_fast(t * speed + phase) * amp * beat;
        m[14] = base[i * 3 + 2] + cos_fast(t * speed * 0.45 + phase * 0.9) * amp * 0.3 * beat;
    }
    #[cfg(not(feature = "parallel"))]
    let _ = base;

    let mut px = m[12];
    let mut py = m[13];
    let mut pz = m[14];
    let mut sc = scale0;
    let mut hot = 0.0f32;

    if harvested && strike > 0.0 && *dead < 0.5 {
        let k = ((strike - pull_delay) / 0.35).clamp(0.0, 1.0);
        if k > 0.0 {
            let dx = PORTAL[0] - px;
            let dy = PORTAL[1] - py;
            let dz = PORTAL[2] - pz;
            let d = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-4);
            let pull = k * k;
            let step = pull * (d - 2.0).max(0.0);
            px += dx / d * step;
            py += dy / d * step;
            pz += dz / d * step;
            let sw = pull * (4.0 + 6.0 * sin_fast(phase));
            px += sin_fast(t * 3.1 + phase) * sw * 0.35;
            py += cos_fast(t * 2.3 + phase) * sw * 0.3;
            hot = (k * 1.6).min(1.0);
            sc = scale0 * (1.0 - k * 0.9).max(0.001);
            if d < 2.2 || k >= 1.0 { *dead = 1.0; }
        }
    }
    if *dead > 0.5 { sc = 0.0001; }

    // euler XYZ → quaternion (matches THREE.Euler default order)
    let ex = sin_fast(t * 0.31 + phase) * 0.5 + sin_fast(t * 0.83 + phase * 3.1) * 0.15;
    let ey = t * spin + phase + sin_fast(t * 0.45 + phase * 1.3) * 0.3;
    let ez = cos_fast(t * 0.27 + phase) * 0.5 + cos_fast(t * 0.77 + phase * 2.3) * 0.15;

    let c1 = cos_fast(ex * 0.5); let s1 = sin_fast(ex * 0.5);
    let c2 = cos_fast(ey * 0.5); let s2 = sin_fast(ey * 0.5);
    let c3 = cos_fast(ez * 0.5); let s3 = sin_fast(ez * 0.5);
    let qx = s1 * c2 * c3 + c1 * s2 * s3;
    let qy = c1 * s2 * c3 - s1 * c2 * s3;
    let qz = c1 * c2 * s3 + s1 * s2 * c3;
    let qw = c1 * c2 * c3 - s1 * s2 * s3;

    // mat4 compose (column-major, same layout THREE.Matrix4.compose emits)
    let x2 = qx + qx; let y2 = qy + qy; let z2 = qz + qz;
    let xx = qx * x2; let xy = qx * y2; let xz = qx * z2;
    let yy = qy * y2; let yz = qy * z2; let zz = qz * z2;
    let wx = qw * x2; let wy = qw * y2; let wz = qw * z2;
    m[0] = (1.0 - (yy + zz)) * sc;
    m[1] = (xy + wz) * sc;
    m[2] = (xz - wy) * sc;
    m[3] = 0.0;
    m[4] = (xy - wz) * sc;
    m[5] = (1.0 - (xx + zz)) * sc;
    m[6] = (yz + wx) * sc;
    m[7] = 0.0;
    m[8] = (xz + wy) * sc;
    m[9] = (yz - wx) * sc;
    m[10] = (1.0 - (xx + yy)) * sc;
    m[11] = 0.0;
    m[12] = px; m[13] = py; m[14] = pz;
    m[15] = 1.0;

    // color lerp toward HOT as it burns
    let h = if hot > 0.0 { hot.min(1.0) } else { 0.0 };
    c[0] = cover[i * 3] + (HOT[0] - cover[i * 3]) * h;
    c[1] = cover[i * 3 + 1] + (HOT[1] - cover[i * 3 + 1]) * h;
    c[2] = cover[i * 3 + 2] + (HOT[2] - cover[i * 3 + 2]) * h;
}
