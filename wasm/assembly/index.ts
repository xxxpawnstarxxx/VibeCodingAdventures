// Flowpaint Studio - image processing kernels compiled to WebAssembly with AssemblyScript.
// Memory model: a bump allocator the host resets between operations (see src/wasm/wasm.ts).
// All pixel buffers are straight (non-premultiplied) RGBA8.

let top: usize = (__heap_base + 15) & ~15;
const base: usize = top;

export function reset(): void {
  top = base;
}

export function alloc(bytes: i32): usize {
  const ptr = top;
  top = (top + <usize>bytes + 15) & ~15;
  const needed = <i32>((top + 0xffff) >>> 16);
  const have = memory.size();
  if (needed > have) memory.grow(needed - have);
  return ptr;
}

// ---------------------------------------------------------------- flood fill
// Scanline flood fill. Writes 255 into mask for matching pixels. Returns count.
// tol is 0..255 (max channel distance). contiguous=0 selects every matching pixel.
export function floodFill(src: usize, w: i32, h: i32, sx: i32, sy: i32, tol: i32, contiguous: i32, mask: usize, stack: usize): i32 {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0;
  const si = (sy * w + sx) << 2;
  const r0 = <i32>load<u8>(src + si), g0 = <i32>load<u8>(src + si + 1), b0 = <i32>load<u8>(src + si + 2), a0 = <i32>load<u8>(src + si + 3);
  memory.fill(mask, 0, <usize>(w * h));
  let count = 0;
  if (!contiguous) {
    const n = w * h;
    for (let i = 0; i < n; i++) {
      if (match(src, i, r0, g0, b0, a0, tol)) { store<u8>(mask + i, 255); count++; }
    }
    return count;
  }
  let sp = 0;
  store<i32>(stack, sx); store<i32>(stack + 4, sy); sp = 1;
  while (sp > 0) {
    sp--;
    let x = load<i32>(stack + (sp << 3));
    const y = load<i32>(stack + (sp << 3) + 4);
    const row = y * w;
    if (load<u8>(mask + row + x)) continue;
    // walk left
    while (x > 0 && !load<u8>(mask + row + x - 1) && match(src, row + x - 1, r0, g0, b0, a0, tol)) x--;
    let spanUp = false, spanDown = false;
    while (x < w && !load<u8>(mask + row + x) && match(src, row + x, r0, g0, b0, a0, tol)) {
      store<u8>(mask + row + x, 255); count++;
      if (y > 0) {
        const up = (y - 1) * w + x;
        const m = !load<u8>(mask + up) && match(src, up, r0, g0, b0, a0, tol);
        if (m && !spanUp) { store<i32>(stack + (sp << 3), x); store<i32>(stack + (sp << 3) + 4, y - 1); sp++; spanUp = true; }
        else if (!m) spanUp = false;
      }
      if (y < h - 1) {
        const dn = (y + 1) * w + x;
        const m = !load<u8>(mask + dn) && match(src, dn, r0, g0, b0, a0, tol);
        if (m && !spanDown) { store<i32>(stack + (sp << 3), x); store<i32>(stack + (sp << 3) + 4, y + 1); sp++; spanDown = true; }
        else if (!m) spanDown = false;
      }
      x++;
    }
  }
  return count;
}

@inline function match(src: usize, i: i32, r0: i32, g0: i32, b0: i32, a0: i32, tol: i32): bool {
  const p = src + (<usize>i << 2);
  const a = <i32>load<u8>(p + 3);
  // Two fully transparent pixels always match regardless of their hidden rgb.
  if (a0 == 0 && a == 0) return true;
  let d = abs(a - a0);
  let t = abs(<i32>load<u8>(p) - r0); if (t > d) d = t;
  t = abs(<i32>load<u8>(p + 1) - g0); if (t > d) d = t;
  t = abs(<i32>load<u8>(p + 2) - b0); if (t > d) d = t;
  return d <= tol;
}

// ---------------------------------------------------------------- histogram
// 15-bit colour histogram (5 bits per channel). out has 32768 u32 slots.
export function histogram(src: usize, n: i32, out: usize): i32 {
  memory.fill(out, 0, 32768 * 4);
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const p = src + (<usize>i << 2);
    if (load<u8>(p + 3) < 128) continue;
    const key = ((<i32>load<u8>(p) >> 3) << 10) | ((<i32>load<u8>(p + 1) >> 3) << 5) | (<i32>load<u8>(p + 2) >> 3);
    const slot = out + (<usize>key << 2);
    store<u32>(slot, load<u32>(slot) + 1);
    counted++;
  }
  return counted;
}

// ---------------------------------------------------------------- adjustments
// params (f32): 0 brightness(-1..1) 1 contrast(-1..1) 2 saturation(-1..1) 3 vibrance(-1..1)
// 4 hue(deg) 5 temperature(-1..1) 6 tint(-1..1) 7 exposure(stops) 8 gamma(0.1..5)
// 9 invert(0..1) 10 grayscale(0..1) 11 sepia(0..1) 12 posterize(levels, 0=off)
// 13 highlights(-1..1) 14 shadows(-1..1)
export function adjust(src: usize, dst: usize, n: i32, params: usize): void {
  const bright = load<f32>(params), contrast = load<f32>(params + 4), sat = load<f32>(params + 8), vib = load<f32>(params + 12);
  const hue = load<f32>(params + 16), temp = load<f32>(params + 20), tint = load<f32>(params + 24), expo = load<f32>(params + 28);
  const gamma = load<f32>(params + 32), invert = load<f32>(params + 36), gray = load<f32>(params + 40), sepia = load<f32>(params + 44);
  const post = load<f32>(params + 48), hi = load<f32>(params + 52), sh = load<f32>(params + 56);
  const expMul = Mathf.pow(2.0, expo);
  const cf: f32 = contrast >= 0 ? 1.0 + contrast * 3.0 : 1.0 + contrast;
  const invG: f32 = 1.0 / (gamma < 0.05 ? 0.05 : gamma);
  // hue rotation matrix (luma-preserving, as used by CSS hue-rotate)
  const a = hue * 0.017453292;
  const c = Mathf.cos(a), s = Mathf.sin(a);
  const m00: f32 = 0.213 + c * 0.787 - s * 0.213, m01: f32 = 0.715 - c * 0.715 - s * 0.715, m02: f32 = 0.072 - c * 0.072 + s * 0.928;
  const m10: f32 = 0.213 - c * 0.213 + s * 0.143, m11: f32 = 0.715 + c * 0.285 + s * 0.140, m12: f32 = 0.072 - c * 0.072 - s * 0.283;
  const m20: f32 = 0.213 - c * 0.213 - s * 0.787, m21: f32 = 0.715 - c * 0.715 + s * 0.715, m22: f32 = 0.072 + c * 0.928 + s * 0.072;
  const doHue = hue != 0.0;
  for (let i = 0; i < n; i++) {
    const p = src + (<usize>i << 2);
    const q = dst + (<usize>i << 2);
    let r = <f32>load<u8>(p) / 255.0, g = <f32>load<u8>(p + 1) / 255.0, b = <f32>load<u8>(p + 2) / 255.0;
    const al = load<u8>(p + 3);
    // exposure
    r *= expMul; g *= expMul; b *= expMul;
    // temperature / tint
    r += temp * 0.12; b -= temp * 0.12; g += tint * 0.1; r -= tint * 0.03; b -= tint * 0.03;
    // brightness
    r += bright * 0.5; g += bright * 0.5; b += bright * 0.5;
    // shadows / highlights
    if (hi != 0.0 || sh != 0.0) {
      const l0: f32 = 0.299 * r + 0.587 * g + 0.114 * b;
      const hw: f32 = smooth(0.4, 1.0, l0), sw: f32 = 1.0 - smooth(0.0, 0.6, l0);
      const d: f32 = hi * hw * 0.35 + sh * sw * 0.35;
      r += d; g += d; b += d;
    }
    // contrast around mid grey
    r = (r - 0.5) * cf + 0.5; g = (g - 0.5) * cf + 0.5; b = (b - 0.5) * cf + 0.5;
    if (doHue) {
      const nr = m00 * r + m01 * g + m02 * b, ng = m10 * r + m11 * g + m12 * b, nb = m20 * r + m21 * g + m22 * b;
      r = nr; g = ng; b = nb;
    }
    let l: f32 = 0.299 * r + 0.587 * g + 0.114 * b;
    // saturation & vibrance
    let sf: f32 = 1.0 + sat;
    if (vib != 0.0) {
      const mx = max(r, max(g, b)), mn = min(r, min(g, b));
      const curSat = mx - mn;
      sf *= 1.0 + vib * (1.0 - curSat) * 1.2;
    }
    r = l + (r - l) * sf; g = l + (g - l) * sf; b = l + (b - l) * sf;
    if (gray > 0.0) { l = 0.299 * r + 0.587 * g + 0.114 * b; r += (l - r) * gray; g += (l - g) * gray; b += (l - b) * gray; }
    if (sepia > 0.0) {
      const sr: f32 = 0.393 * r + 0.769 * g + 0.189 * b, sg: f32 = 0.349 * r + 0.686 * g + 0.168 * b, sb: f32 = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * sepia; g += (sg - g) * sepia; b += (sb - b) * sepia;
    }
    r = clamp01(r); g = clamp01(g); b = clamp01(b);
    if (gamma != 1.0) { r = Mathf.pow(r, invG); g = Mathf.pow(g, invG); b = Mathf.pow(b, invG); }
    if (invert > 0.0) { r += (1.0 - 2.0 * r) * invert; g += (1.0 - 2.0 * g) * invert; b += (1.0 - 2.0 * b) * invert; }
    if (post >= 2.0) {
      const lv = post - 1.0;
      r = Mathf.round(r * lv) / lv; g = Mathf.round(g * lv) / lv; b = Mathf.round(b * lv) / lv;
    }
    store<u8>(q, <u8>(clamp01(r) * 255.0 + 0.5));
    store<u8>(q + 1, <u8>(clamp01(g) * 255.0 + 0.5));
    store<u8>(q + 2, <u8>(clamp01(b) * 255.0 + 0.5));
    store<u8>(q + 3, al);
  }
}

@inline function clamp01(v: f32): f32 { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }
@inline function smooth(e0: f32, e1: f32, x: f32): f32 { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3.0 - 2.0 * t); }

// ---------------------------------------------------------------- blur
// Box blur on RGBA (alpha-weighted so transparent pixels don't bleed black). One pass, both axes.
export function boxBlur(buf: usize, tmp: usize, w: i32, h: i32, radius: i32): void {
  if (radius < 1) return;
  // horizontal: buf -> tmp (as f32 premultiplied)  vertical: tmp -> buf
  const win: f32 = <f32>(radius * 2 + 1);
  for (let y = 0; y < h; y++) {
    let sr: f32 = 0, sg: f32 = 0, sb: f32 = 0, sa: f32 = 0;
    const row = y * w;
    for (let k = -radius; k <= radius; k++) {
      const x = k < 0 ? 0 : (k >= w ? w - 1 : k);
      const p = buf + (<usize>(row + x) << 2);
      const a = <f32>load<u8>(p + 3);
      sr += <f32>load<u8>(p) * a; sg += <f32>load<u8>(p + 1) * a; sb += <f32>load<u8>(p + 2) * a; sa += a;
    }
    for (let x = 0; x < w; x++) {
      const t = tmp + (<usize>(row + x) << 4);
      store<f32>(t, sr / win); store<f32>(t + 4, sg / win); store<f32>(t + 8, sb / win); store<f32>(t + 12, sa / win);
      const xo = x - radius < 0 ? 0 : x - radius;
      const xi = x + radius + 1 >= w ? w - 1 : x + radius + 1;
      const po = buf + (<usize>(row + xo) << 2), pi = buf + (<usize>(row + xi) << 2);
      const ao = <f32>load<u8>(po + 3), ai = <f32>load<u8>(pi + 3);
      sr += <f32>load<u8>(pi) * ai - <f32>load<u8>(po) * ao;
      sg += <f32>load<u8>(pi + 1) * ai - <f32>load<u8>(po + 1) * ao;
      sb += <f32>load<u8>(pi + 2) * ai - <f32>load<u8>(po + 2) * ao;
      sa += ai - ao;
    }
  }
  for (let x = 0; x < w; x++) {
    let sr: f32 = 0, sg: f32 = 0, sb: f32 = 0, sa: f32 = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = k < 0 ? 0 : (k >= h ? h - 1 : k);
      const t = tmp + (<usize>(y * w + x) << 4);
      sr += load<f32>(t); sg += load<f32>(t + 4); sb += load<f32>(t + 8); sa += load<f32>(t + 12);
    }
    for (let y = 0; y < h; y++) {
      const p = buf + (<usize>(y * w + x) << 2);
      const a = sa / win;
      if (a > 0.001) {
        store<u8>(p, <u8>min<f32>(255.0, sr / sa + 0.5));
        store<u8>(p + 1, <u8>min<f32>(255.0, sg / sa + 0.5));
        store<u8>(p + 2, <u8>min<f32>(255.0, sb / sa + 0.5));
      }
      store<u8>(p + 3, <u8>min<f32>(255.0, a + 0.5));
      const yo = y - radius < 0 ? 0 : y - radius;
      const yi = y + radius + 1 >= h ? h - 1 : y + radius + 1;
      const to = tmp + (<usize>(yo * w + x) << 4), ti = tmp + (<usize>(yi * w + x) << 4);
      sr += load<f32>(ti) - load<f32>(to);
      sg += load<f32>(ti + 4) - load<f32>(to + 4);
      sb += load<f32>(ti + 8) - load<f32>(to + 8);
      sa += load<f32>(ti + 12) - load<f32>(to + 12);
    }
  }
}

// Box blur of a single channel u8 mask (used for feathering selections).
export function blurMask(buf: usize, tmp: usize, w: i32, h: i32, radius: i32): void {
  if (radius < 1) return;
  const win: f32 = <f32>(radius * 2 + 1);
  for (let y = 0; y < h; y++) {
    let s: f32 = 0; const row = y * w;
    for (let k = -radius; k <= radius; k++) { const x = k < 0 ? 0 : (k >= w ? w - 1 : k); s += <f32>load<u8>(buf + row + x); }
    for (let x = 0; x < w; x++) {
      store<f32>(tmp + (<usize>(row + x) << 2), s / win);
      const xo = x - radius < 0 ? 0 : x - radius; const xi = x + radius + 1 >= w ? w - 1 : x + radius + 1;
      s += <f32>load<u8>(buf + row + xi) - <f32>load<u8>(buf + row + xo);
    }
  }
  for (let x = 0; x < w; x++) {
    let s: f32 = 0;
    for (let k = -radius; k <= radius; k++) { const y = k < 0 ? 0 : (k >= h ? h - 1 : k); s += load<f32>(tmp + (<usize>(y * w + x) << 2)); }
    for (let y = 0; y < h; y++) {
      store<u8>(buf + y * w + x, <u8>min<f32>(255.0, s / win + 0.5));
      const yo = y - radius < 0 ? 0 : y - radius; const yi = y + radius + 1 >= h ? h - 1 : y + radius + 1;
      s += load<f32>(tmp + (<usize>(yi * w + x) << 2)) - load<f32>(tmp + (<usize>(yo * w + x) << 2));
    }
  }
}

// ---------------------------------------------------------------- noise / grain
@inline function hash(x: i32, y: i32, seed: i32): f32 {
  let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return <f32>(h & 0xffffff) / 16777215.0;
}

function valueNoise(x: f32, y: f32, seed: i32): f32 {
  const xi = <i32>Mathf.floor(x), yi = <i32>Mathf.floor(y);
  const fx = x - <f32>xi, fy = y - <f32>yi;
  const ux = fx * fx * (3.0 - 2.0 * fx), uy = fy * fy * (3.0 - 2.0 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

// amount 0..1, size >= 1 (grain size in px), mono 0/1, seed.
export function grain(buf: usize, w: i32, h: i32, amount: f32, size: f32, mono: i32, seed: i32): void {
  const inv: f32 = 1.0 / (size < 1.0 ? 1.0 : size);
  const useVN = size > 1.01;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = buf + (<usize>(y * w + x) << 2);
      if (load<u8>(p + 3) == 0) continue;
      const fx = <f32>x * inv, fy = <f32>y * inv;
      const n0 = useVN ? valueNoise(fx, fy, seed) : hash(x, y, seed);
      for (let ch = 0; ch < 3; ch++) {
        let n = n0;
        if (!mono) n = useVN ? valueNoise(fx + <f32>ch * 17.3, fy - <f32>ch * 9.1, seed + ch * 31) : hash(x, y, seed + ch * 31);
        // mid-tone weighted film grain: strongest in mid tones
        const v = <f32>load<u8>(p + ch) / 255.0;
        const wgt: f32 = 0.35 + 0.65 * (1.0 - Mathf.abs(v - 0.5) * 2.0);
        const nv = clamp01(v + (n - 0.5) * amount * wgt);
        store<u8>(p + ch, <u8>(nv * 255.0 + 0.5));
      }
    }
  }
}

// ---------------------------------------------------------------- kuwahara (oil paint)
// Generalised 4-sector Kuwahara filter. Produces flat painterly regions with crisp edges.
export function kuwahara(src: usize, dst: usize, w: i32, h: i32, radius: i32): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let bestVar: f32 = 1e30;
      let br: f32 = 0, bg: f32 = 0, bb: f32 = 0;
      for (let q = 0; q < 4; q++) {
        const x0 = (q & 1) ? x : x - radius, y0 = (q & 2) ? y : y - radius;
        let sr: f32 = 0, sg: f32 = 0, sb: f32 = 0, sl: f32 = 0, sl2: f32 = 0, cnt: f32 = 0;
        for (let yy = y0; yy <= y0 + radius; yy += 1) {
          const cy = yy < 0 ? 0 : (yy >= h ? h - 1 : yy);
          for (let xx = x0; xx <= x0 + radius; xx += 1) {
            const cx = xx < 0 ? 0 : (xx >= w ? w - 1 : xx);
            const p = src + (<usize>(cy * w + cx) << 2);
            const r = <f32>load<u8>(p), g = <f32>load<u8>(p + 1), b = <f32>load<u8>(p + 2);
            const l: f32 = 0.299 * r + 0.587 * g + 0.114 * b;
            sr += r; sg += g; sb += b; sl += l; sl2 += l * l; cnt += 1.0;
          }
        }
        const mean: f32 = sl / cnt;
        const v = sl2 / cnt - mean * mean;
        if (v < bestVar) { bestVar = v; br = sr / cnt; bg = sg / cnt; bb = sb / cnt; }
      }
      const o = dst + (<usize>(y * w + x) << 2);
      store<u8>(o, <u8>br); store<u8>(o + 1, <u8>bg); store<u8>(o + 2, <u8>bb);
      store<u8>(o + 3, load<u8>(src + (<usize>(y * w + x) << 2) + 3));
    }
  }
}

// ---------------------------------------------------------------- gradients (sobel)
// Writes f32 pairs (gx, gy) of luminance gradient per pixel into out.
export function sobel(src: usize, out: usize, w: i32, h: i32): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let gx: f32 = 0, gy: f32 = 0;
      for (let j = -1; j <= 1; j++) {
        const cy = y + j < 0 ? 0 : (y + j >= h ? h - 1 : y + j);
        for (let i = -1; i <= 1; i++) {
          const cx = x + i < 0 ? 0 : (x + i >= w ? w - 1 : x + i);
          const p = src + (<usize>(cy * w + cx) << 2);
          const l: f32 = (0.299 * <f32>load<u8>(p) + 0.587 * <f32>load<u8>(p + 1) + 0.114 * <f32>load<u8>(p + 2)) / 255.0;
          const wx: f32 = <f32>i * (j == 0 ? 2.0 : 1.0);
          const wy: f32 = <f32>j * (i == 0 ? 2.0 : 1.0);
          gx += l * wx; gy += l * wy;
        }
      }
      const o = out + (<usize>(y * w + x) << 3);
      store<f32>(o, gx); store<f32>(o + 4, gy);
    }
  }
}
