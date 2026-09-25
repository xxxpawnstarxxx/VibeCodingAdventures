// Colour science: sRGB/linear, HSV, OKLab/OKLCH, hex, and spectral Kubelka–Munk pigment mixing.

export type RGB = [number, number, number]; // 0..1 sRGB (gamma encoded) unless stated

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c: number): number {
  c = clamp(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export const toLinear = (c: RGB): RGB => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
export const toSrgb = (c: RGB): RGB => [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])];

export function hexToRgb(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
}
export function rgb255(c: RGB): [number, number, number] {
  return [Math.round(clamp(c[0]) * 255), Math.round(clamp(c[1]) * 255), Math.round(clamp(c[2]) * 255)];
}
export function cssRgb(c: RGB, a = 1): string {
  const [r, g, b] = rgb255(c);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/** Accepts '#rrggbb', 'rgb(...)', [r,g,b] (0..1 or 0..255) or named basic colours. */
export function parseColor(input: unknown): RGB | null {
  if (Array.isArray(input) && input.length >= 3) {
    const arr = input.slice(0, 3).map(Number);
    const scale = arr.some((v) => v > 1) ? 255 : 1;
    return arr.map((v) => clamp(v / scale)) as RGB;
  }
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const hex = hexToRgb(s);
  if (hex) return hex;
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    if (p.length >= 3) return [clamp(p[0] / 255), clamp(p[1] / 255), clamp(p[2] / 255)];
  }
  const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#e02020', green: '#20a040', blue: '#2050e0', yellow: '#f5d020',
    orange: '#f08020', purple: '#8030c0', pink: '#f080b0', brown: '#7a4a2a', gray: '#808080', grey: '#808080',
    cyan: '#20c0e0', magenta: '#d020c0', teal: '#208080', navy: '#1a2a6a', skyblue: '#87ceeb', gold: '#d4a020',
  };
  return named[s] ? hexToRgb(named[s]) : null;
}

export function rgbToHsv([r, g, b]: RGB): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}
export function hslToRgb(h: number, s: number, l: number): RGB {
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return hsvToRgb(h, sv, v);
}

// OKLab (Björn Ottosson). Input/Output linear sRGB.
export function linearToOklab([r, g, b]: RGB): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export function oklabToLinear([L, a, b]: [number, number, number]): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
export const srgbToOklab = (c: RGB) => linearToOklab(toLinear(c));
export const oklabToSrgb = (c: [number, number, number]) => toSrgb(oklabToLinear(c));
export function oklch(c: RGB): [number, number, number] {
  const [L, a, b] = srgbToOklab(c);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.hypot(a, b), h];
}
export function fromOklch(L: number, C: number, h: number): RGB {
  const r = (h * Math.PI) / 180;
  return oklabToSrgb([L, C * Math.cos(r), C * Math.sin(r)]);
}
export function mixOklab(a: RGB, b: RGB, t: number): RGB {
  const A = srgbToOklab(a), B = srgbToOklab(b);
  return oklabToSrgb([lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]);
}
export function luminance(c: RGB): number {
  const l = toLinear(c);
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}

// ------------------------------------------------------------------------------------------------
// Spectral pigment mixing.
// RGB -> 10-band reflectance via Smits (1999) basis spectra; mixing uses Kubelka–Munk K/S in each
// band; spectrum -> RGB via the minimum-norm inverse of the basis (so unmixed colours round-trip
// exactly). This gives blue + yellow = green, like real paint, instead of RGB's grey.
// ------------------------------------------------------------------------------------------------
export const SMITS = {
  white: [1.0, 1.0, 0.9999, 0.9993, 0.9992, 0.9998, 1.0, 1.0, 1.0, 1.0],
  cyan: [0.971, 0.9426, 1.0007, 1.0007, 1.0007, 1.0007, 0.1564, 0.0, 0.0, 0.0],
  magenta: [1.0, 1.0, 0.9685, 0.2229, 0.0, 0.0458, 0.8369, 1.0, 1.0, 0.9959],
  yellow: [0.0001, 0.0, 0.1088, 0.6651, 1.0, 1.0, 0.9996, 0.9586, 0.9685, 0.984],
  red: [0.1012, 0.0515, 0.0, 0.0, 0.0, 0.0, 0.8325, 1.0149, 1.0149, 1.0149],
  green: [0.0, 0.0, 0.0273, 0.7937, 1.0, 0.9418, 0.1719, 0.0, 0.0, 0.0025],
  blue: [1.0, 1.0, 0.8916, 0.3323, 0.0, 0.0, 0.0003, 0.0369, 0.0483, 0.0496],
};

function computeSpectralToRgb(): number[][] {
  // S: 10x7 (columns basis spectra), T: 3x7 (their rgb). M = T * (S^T S)^-1 * S^T
  const names = ['white', 'cyan', 'magenta', 'yellow', 'red', 'green', 'blue'] as const;
  const T: number[][] = [
    [1, 0, 1, 1, 1, 0, 0],
    [1, 1, 0, 1, 0, 1, 0],
    [1, 1, 1, 0, 0, 0, 1],
  ];
  const S = names.map((n) => SMITS[n]); // 7 x 10 (row = basis)
  const StS: number[][] = [];
  for (let i = 0; i < 7; i++) {
    StS.push([]);
    for (let j = 0; j < 7; j++) {
      let s = 0;
      for (let k = 0; k < 10; k++) s += S[i][k] * S[j][k];
      StS[i].push(s);
    }
  }
  const inv = invert(StS);
  // P = inv * S  (7x10)
  const P: number[][] = [];
  for (let i = 0; i < 7; i++) {
    P.push([]);
    for (let k = 0; k < 10; k++) {
      let s = 0;
      for (let j = 0; j < 7; j++) s += inv[i][j] * S[j][k];
      P[i].push(s);
    }
  }
  const M: number[][] = [];
  for (let r = 0; r < 3; r++) {
    M.push([]);
    for (let k = 0; k < 10; k++) {
      let s = 0;
      for (let i = 0; i < 7; i++) s += T[r][i] * P[i][k];
      M[r].push(s);
    }
  }
  return M;
}

function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

export const SPECTRAL_TO_RGB = computeSpectralToRgb();

/** Linear RGB -> 10-band reflectance (Smits). */
export function linearToSpectrum([r, g, b]: RGB): number[] {
  const S = SMITS;
  const out = new Array(10).fill(0);
  const add = (spec: number[], w: number) => { for (let i = 0; i < 10; i++) out[i] += spec[i] * w; };
  if (r <= g && r <= b) {
    add(S.white, r);
    if (g <= b) { add(S.cyan, g - r); add(S.blue, b - g); } else { add(S.cyan, b - r); add(S.green, g - b); }
  } else if (g <= r && g <= b) {
    add(S.white, g);
    if (r <= b) { add(S.magenta, r - g); add(S.blue, b - r); } else { add(S.magenta, b - g); add(S.red, r - b); }
  } else {
    add(S.white, b);
    if (r <= g) { add(S.yellow, r - b); add(S.green, g - r); } else { add(S.yellow, g - b); add(S.red, r - g); }
  }
  return out;
}
export function spectrumToLinear(s: number[]): RGB {
  const M = SPECTRAL_TO_RGB;
  const o: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) { let v = 0; for (let k = 0; k < 10; k++) v += M[c][k] * s[k]; o[c] = v; }
  return o;
}
export const LIGHTNESS_CORRECTION = 0.5;
const ks = (R: number) => { R = clamp(R, 0.0005, 0.9995); return ((1 - R) * (1 - R)) / (2 * R); };
const ksToR = (k: number) => 1 + k - Math.sqrt(k * k + 2 * k);

/** Mix two linear-RGB paints with Kubelka–Munk in spectral space. t = amount of b. */
export function kmMixLinear(a: RGB, b: RGB, t: number): RGB {
  if (t <= 0) return [...a] as RGB;
  if (t >= 1) return [...b] as RGB;
  const sa = linearToSpectrum(a), sb = linearToSpectrum(b);
  const out: number[] = [];
  for (let i = 0; i < 10; i++) out.push(ksToR(ks(sa[i]) * (1 - t) + ks(sb[i]) * t));
  const res = spectrumToLinear(out);
  const km: RGB = [clamp(res[0]), clamp(res[1]), clamp(res[2])];
  // Single-constant K-M over-darkens tints (white has weak "tinting strength" in this model).
  // Keep the K-M hue/chroma but pull lightness halfway towards the linear mix.
  const lin: RGB = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const K = linearToOklab(km), Lm = linearToOklab(lin);
  const o = oklabToLinear([lerp(K[0], Lm[0], LIGHTNESS_CORRECTION), K[1], K[2]]);
  return [clamp(o[0]), clamp(o[1]), clamp(o[2])];
}
export function kmMix(a: RGB, b: RGB, t: number): RGB {
  return toSrgb(kmMixLinear(toLinear(a), toLinear(b), t));
}
