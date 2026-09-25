// Loader + typed wrappers for the AssemblyScript image-processing kernels (wasm/assembly/index.ts).
import wasmUrl from './imgproc.wasm?url';

interface Kernels {
  memory: WebAssembly.Memory;
  reset(): void;
  alloc(bytes: number): number;
  floodFill(src: number, w: number, h: number, sx: number, sy: number, tol: number, contiguous: number, mask: number, stack: number): number;
  histogram(src: number, n: number, out: number): number;
  adjust(src: number, dst: number, n: number, params: number): void;
  boxBlur(buf: number, tmp: number, w: number, h: number, radius: number): void;
  blurMask(buf: number, tmp: number, w: number, h: number, radius: number): void;
  grain(buf: number, w: number, h: number, amount: number, size: number, mono: number, seed: number): void;
  kuwahara(src: number, dst: number, w: number, h: number, radius: number): void;
  sobel(src: number, out: number, w: number, h: number): void;
}

let k: Kernels | null = null;

export async function initWasm(): Promise<void> {
  const res = await fetch(wasmUrl);
  const bytes = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, { env: { abort: () => { throw new Error('wasm abort'); } } });
  k = instance.exports as unknown as Kernels;
}

export function wasmReady(): boolean { return !!k; }

function K(): Kernels {
  if (!k) throw new Error('WASM kernels not loaded');
  k.reset();
  return k;
}

function put(kk: Kernels, data: ArrayLike<number> & { length: number }, bytesPerEl = 1): number {
  const ptr = kk.alloc(data.length * bytesPerEl);
  if (bytesPerEl === 1) new Uint8Array(kk.memory.buffer, ptr, data.length).set(data as Uint8Array);
  else new Float32Array(kk.memory.buffer, ptr, data.length).set(data as Float32Array);
  return ptr;
}

/** Returns a 0/255 mask of matching pixels. */
export function floodFillMask(img: ImageData, x: number, y: number, tolerance: number, contiguous: boolean): Uint8Array {
  const kk = K();
  const { width: w, height: h } = img;
  const src = put(kk, img.data);
  const mask = kk.alloc(w * h);
  const stack = kk.alloc(w * h * 8 + 64);
  kk.floodFill(src, w, h, Math.floor(x), Math.floor(y), Math.round(tolerance), contiguous ? 1 : 0, mask, stack);
  return new Uint8Array(kk.memory.buffer, mask, w * h).slice();
}

/** 15-bit colour histogram (5 bits per channel). */
export function colorHistogram(img: ImageData): { bins: Uint32Array; total: number } {
  const kk = K();
  const src = put(kk, img.data);
  const out = kk.alloc(32768 * 4);
  const total = kk.histogram(src, img.width * img.height, out);
  return { bins: new Uint32Array(kk.memory.buffer, out, 32768).slice(), total };
}

export interface Adjustments {
  brightness: number; contrast: number; saturation: number; vibrance: number; hue: number;
  temperature: number; tint: number; exposure: number; gamma: number; invert: number;
  grayscale: number; sepia: number; posterize: number; highlights: number; shadows: number;
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0, contrast: 0, saturation: 0, vibrance: 0, hue: 0, temperature: 0, tint: 0,
  exposure: 0, gamma: 1, invert: 0, grayscale: 0, sepia: 0, posterize: 0, highlights: 0, shadows: 0,
};

export function applyAdjustments(img: ImageData, a: Adjustments): ImageData {
  const kk = K();
  const n = img.width * img.height;
  const src = put(kk, img.data);
  const dst = kk.alloc(n * 4);
  const p = new Float32Array([a.brightness, a.contrast, a.saturation, a.vibrance, a.hue, a.temperature, a.tint,
    a.exposure, a.gamma, a.invert, a.grayscale, a.sepia, a.posterize, a.highlights, a.shadows]);
  const pp = put(kk, p, 4);
  kk.adjust(src, dst, n, pp);
  const out = new ImageData(img.width, img.height);
  out.data.set(new Uint8Array(kk.memory.buffer, dst, n * 4));
  return out;
}

/** Approximate gaussian blur: three box passes. Mutates img. */
export function blurImage(img: ImageData, radius: number): void {
  if (radius < 1) return;
  const kk = K();
  const { width: w, height: h } = img;
  const buf = put(kk, img.data);
  const tmp = kk.alloc(w * h * 16);
  const r = Math.max(1, Math.round(radius / 1.7));
  for (let i = 0; i < 3; i++) kk.boxBlur(buf, tmp, w, h, r);
  img.data.set(new Uint8Array(kk.memory.buffer, buf, w * h * 4));
}

export function blurMaskInPlace(mask: Uint8Array, w: number, h: number, radius: number): void {
  if (radius < 1) return;
  const kk = K();
  const buf = put(kk, mask);
  const tmp = kk.alloc(w * h * 4);
  const r = Math.max(1, Math.round(radius / 1.7));
  for (let i = 0; i < 3; i++) kk.blurMask(buf, tmp, w, h, r);
  mask.set(new Uint8Array(kk.memory.buffer, buf, w * h));
}

export function grainImage(img: ImageData, amount: number, size: number, mono: boolean, seed = 1): void {
  const kk = K();
  const buf = put(kk, img.data);
  kk.grain(buf, img.width, img.height, amount, size, mono ? 1 : 0, seed);
  img.data.set(new Uint8Array(kk.memory.buffer, buf, img.data.length));
}

export function kuwaharaImage(img: ImageData, radius: number): ImageData {
  const kk = K();
  const { width: w, height: h } = img;
  const src = put(kk, img.data);
  const dst = kk.alloc(w * h * 4);
  kk.kuwahara(src, dst, w, h, Math.max(1, Math.round(radius)));
  const out = new ImageData(w, h);
  out.data.set(new Uint8Array(kk.memory.buffer, dst, w * h * 4));
  return out;
}

/** Luminance gradient field, interleaved (gx, gy). */
export function sobelField(img: ImageData): Float32Array {
  const kk = K();
  const { width: w, height: h } = img;
  const src = put(kk, img.data);
  const out = kk.alloc(w * h * 8);
  kk.sobel(src, out, w, h);
  return new Float32Array(kk.memory.buffer, out, w * h * 2).slice();
}
