// The liquid paint model, CPU reference implementation (mirrors shaders in gpu/shaders.ts).
//
// Wet state per pixel: premultiplied pigment P = (m*r, m*g, m*b, m) in LINEAR rgb plus water w.
//  * Dabs push P toward the brush reservoir colour with strength = footprint * flow ("mix toward"
//    rather than "add", so paint can never over-accumulate into mud or blow out).
//  * The reservoir picks up canvas colour (spectral Kubelka–Munk mixing) and refills toward the
//    loaded colour; this gives real wet-into-wet blending, smearing and colour pickup.
//  * Flow: wet pixels exchange pigment with wet neighbours (diffusion scaled by (1-viscosity)),
//    pigment drifts toward drier cells (wet-edge darkening), very wet paint bleeds outward a little.
//  * Composite: coverage = opacity * (1 - e^{-3m}); result mixes opaque covering (spectral mix)
//    with glazing (multiplicative filter like watercolour), then optional impasto lighting.
import { clamp, kmMixLinear, type RGB } from '../core/color';
import type { Dab, StrokeParams } from './types';

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 144665)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 0xffffff) / 16777215;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Paper tooth: two octaves of value noise + fine fibre. 0..1 */
export function paper(x: number, y: number, scale: number): number {
  const s = 1 / (3.2 * scale);
  // cold-press paper: medium tooth + fine fibres (slightly stretched) + a little per-pixel noise
  return valueNoise(x * s, y * s, 7) * 0.5 + valueNoise(x * s * 2.3, y * s * 3.1, 11) * 0.32 + hash2(x, y, 3) * 0.18;
}

/** Bristle strength across the brush (u: 0..1), smooth and irregular rather than striped. */
export function bristleProfile(u: number, fan: boolean, seed: number): number {
  const n = fan ? 9 : 16;
  const a = valueNoise(u * n, 0.5, seed), b = valueNoise(u * n * 2.9, 3.5, seed + 7);
  let v = 0.62 * a + 0.38 * b;
  if (fan) v *= smoothstep(0.3, 0.55, b); // gaps between bristle clumps
  return v;
}

export interface TipImage { w: number; h: number; data: Float32Array }

/** Footprint 0..1 of a dab at pixel centre (px,py). */
export function footprint(px: number, py: number, d: Dab, prm: StrokeParams, tipImg: TipImage | null): number {
  const dx = px - d.x, dy = py - d.y;
  const c = Math.cos(d.angle), s = Math.sin(d.angle);
  let lx = (dx * c + dy * s) / d.r;
  const ly = (-dx * s + dy * c) / d.r;
  const tip = prm.tip;
  let dist: number;
  if (tip === 4 && tipImg) {
    const u = (dx * c + dy * s) / d.r * 0.5 + 0.5, v = ly * 0.5 + 0.5;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
    const sx = Math.floor(u * tipImg.w), sy = Math.floor(v * tipImg.h);
    return tipImg.data[sy * tipImg.w + sx] * d.flow;
  }
  lx /= Math.max(0.05, d.roundness);
  if (tip === 1) dist = Math.pow(Math.pow(Math.abs(lx), 6) + Math.pow(Math.abs(ly), 6), 1 / 6);
  else dist = Math.sqrt(lx * lx + ly * ly);
  if (dist >= 1) return 0;
  const h = d.hardness * 0.98;
  let f = 1 - smoothstep(h, 1, dist);
  let bristle = prm.bristles;
  if (tip === 3) bristle = Math.max(bristle, 0.85);
  if (bristle > 0) {
    const strength = bristleProfile(ly * 0.5 + 0.5, tip === 3, prm.seed & 0xffff);
    f *= 1 - bristle * (1 - Math.min(1, 0.15 + strength * 1.1));
  }
  f *= d.flow;
  if (prm.grain > 0) {
    const n = paper(px, py, prm.grainScale);
    f *= 1 - prm.grain * (1 - smoothstep(0.55 - f * 0.45, 0.8 - f * 0.3, n));
  }
  return clamp(f);
}

export type MixFn = (a: RGB, b: RGB, t: number) => RGB;
export const linearMix: MixFn = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const spectralMix: MixFn = (a, b, t) => {
  if (t <= 0.002) return [a[0], a[1], a[2]];
  if (t >= 0.998) return [b[0], b[1], b[2]];
  // cheap exit for near-identical colours
  if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.01) return linearMix(a, b, t);
  return kmMixLinear(a, b, t);
};

const lin = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export const LIN8 = lin;
const enc = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) { const c = i / 4096; enc[i] = Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255); }
export const toSrgb8 = (v: number) => enc[Math.round(clamp(v) * 4096)];

/** Watercolour granulation: pigment settles into the paper's valleys. */
export function granulation(x: number, y: number, prm: StrokeParams): number {
  const g = prm.transparency * prm.wetness;
  if (g <= 0.05 || prm.mode !== 'paint') return 1;
  return 1 + (0.5 - paper(x, y, 1.1)) * 0.9 * g;
}

/** Coverage from pigment mass. */
export function coverage(m: number, opacity: number): number {
  return opacity * (1 - Math.exp(-3 * m)) / (1 - Math.exp(-3));
}

/**
 * Apply wet paint to a straight-alpha linear base pixel. Returns [r,g,b,a] linear straight.
 * shade: impasto light factor (1 = none).
 */
export function applyWet(
  br: number, bg: number, bb: number, ba: number,
  P0: number, P1: number, P2: number, m: number,
  prm: StrokeParams, mix: MixFn, shade: number, maskV: number, gran = 1,
): [number, number, number, number] {
  if (m < 1e-4) return [br, bg, bb, ba];
  m *= gran;
  let cov = clamp(coverage(m, prm.opacity) * maskV);
  if (prm.mode === 'erase') return [br, bg, bb, ba * (1 - cov)];
  if (prm.alphaLock) { if (ba <= 0) return [br, bg, bb, ba]; }
  const c: RGB = [P0 / m, P1 / m, P2 / m];
  let outC: RGB;
  if (ba > 0.001) {
    const opaque = prm.mode === 'paint' ? mix([br, bg, bb], c, cov) : linearMix([br, bg, bb], c, cov);
    const t = prm.mode === 'paint' ? prm.transparency : 0;
    const glaze: RGB = [br * (1 - cov + c[0] * cov), bg * (1 - cov + c[1] * cov), bb * (1 - cov + c[2] * cov)];
    const mixed = linearMix(opaque, glaze, t);
    const outA0 = ba + cov * (1 - ba);
    const wb = ba / outA0;
    outC = linearMix(c, mixed, wb);
  } else outC = c;
  const outA = prm.alphaLock ? ba : ba + cov * (1 - ba);
  if (shade !== 1) { outC = [outC[0] * shade, outC[1] * shade, outC[2] * shade]; }
  return [outC[0], outC[1], outC[2], outA];
}
