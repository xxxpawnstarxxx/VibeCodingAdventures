// WGSL for the WebGPU backend. Mirrors src/engine/paintModel.ts (the CPU reference).
import { SMITS, SPECTRAL_TO_RGB, LIGHTNESS_CORRECTION } from '../../core/color';

const f = (n: number) => {
  const s = n.toFixed(6);
  return s.includes('.') ? s : s + '.0';
};
const v4 = (a: number[]) => `vec4f(${a.map(f).join(', ')})`;
/** Spectrum (10 bands) packed into 3 vec4 (last two lanes padding). */
const spec3 = (s: number[], pad = 0) => [v4(s.slice(0, 4)), v4(s.slice(4, 8)), v4([s[8], s[9], pad, pad])];

function specConsts(): string {
  let out = '';
  for (const [name, s] of Object.entries(SMITS)) {
    const [a, b, c] = spec3(s, 0);
    out += `const SP_${name.toUpperCase()} = Spec(${a}, ${b}, ${c});\n`;
  }
  SPECTRAL_TO_RGB.forEach((row, i) => {
    const [a, b, c] = spec3(row, 0);
    out += `const MR${i} = Spec(${a}, ${b}, ${c});\n`;
  });
  return out;
}

export const COMMON = /* wgsl */ `
struct Spec { a: vec4f, b: vec4f, c: vec4f }
fn cube(x: f32) -> f32 { return x * x * x; }
${specConsts()}

fn sAdd(o: Spec, s: Spec, w: f32) -> Spec { return Spec(o.a + s.a * w, o.b + s.b * w, o.c + s.c * w); }

fn toSpec(c: vec3f) -> Spec {
  let r = c.x; let g = c.y; let b = c.z;
  var o = Spec(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  if (r <= g && r <= b) {
    o = sAdd(o, SP_WHITE, r);
    if (g <= b) { o = sAdd(o, SP_CYAN, g - r); o = sAdd(o, SP_BLUE, b - g); }
    else { o = sAdd(o, SP_CYAN, b - r); o = sAdd(o, SP_GREEN, g - b); }
  } else if (g <= r && g <= b) {
    o = sAdd(o, SP_WHITE, g);
    if (r <= b) { o = sAdd(o, SP_MAGENTA, r - g); o = sAdd(o, SP_BLUE, b - r); }
    else { o = sAdd(o, SP_MAGENTA, b - g); o = sAdd(o, SP_RED, r - b); }
  } else {
    o = sAdd(o, SP_WHITE, b);
    if (r <= g) { o = sAdd(o, SP_YELLOW, r - b); o = sAdd(o, SP_GREEN, g - r); }
    else { o = sAdd(o, SP_YELLOW, g - b); o = sAdd(o, SP_RED, r - g); }
  }
  return o;
}
fn sDot(m: Spec, s: Spec) -> f32 { return dot(m.a, s.a) + dot(m.b, s.b) + dot(m.c.xy, s.c.xy); }
fn ks4(r: vec4f) -> vec4f { let R = clamp(r, vec4f(0.0005), vec4f(0.9995)); return (1.0 - R) * (1.0 - R) / (2.0 * R); }
fn ksInv4(k: vec4f) -> vec4f { return 1.0 + k - sqrt(k * k + 2.0 * k); }

fn oklab(c: vec3f) -> vec3f {
  let l = pow(max(0.4122214708 * c.x + 0.5363325363 * c.y + 0.0514459929 * c.z, 0.0), 1.0 / 3.0);
  let m = pow(max(0.2119034982 * c.x + 0.6806995451 * c.y + 0.1073969566 * c.z, 0.0), 1.0 / 3.0);
  let s = pow(max(0.0883024619 * c.x + 0.2817188376 * c.y + 0.6299787005 * c.z, 0.0), 1.0 / 3.0);
  return vec3f(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
               1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
               0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
fn oklabInv(c: vec3f) -> vec3f {
  let l = cube(c.x + 0.3963377774 * c.y + 0.2158037573 * c.z);
  let m = cube(c.x - 0.1055613458 * c.y - 0.0638541728 * c.z);
  let s = cube(c.x - 0.0894841775 * c.y - 1.291485548 * c.z);
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
               -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
               -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}

/** Kubelka-Munk spectral pigment mix of two LINEAR colours. */
fn kmMix(a: vec3f, b: vec3f, t: f32) -> vec3f {
  if (t <= 0.002) { return a; }
  if (t >= 0.998) { return b; }
  let d = abs(a - b);
  if (d.x + d.y + d.z < 0.01) { return mix(a, b, t); }
  let sa = toSpec(a); let sb = toSpec(b);
  let r = Spec(ksInv4(mix(ks4(sa.a), ks4(sb.a), t)), ksInv4(mix(ks4(sa.b), ks4(sb.b), t)), ksInv4(mix(ks4(sa.c), ks4(sb.c), t)));
  let km = clamp(vec3f(sDot(MR0, r), sDot(MR1, r), sDot(MR2, r)), vec3f(0.0), vec3f(1.0));
  let K = oklab(km); let L = oklab(mix(a, b, t));
  return clamp(oklabInv(vec3f(mix(K.x, L.x, ${f(LIGHTNESS_CORRECTION)}), K.y, K.z)), vec3f(0.0), vec3f(1.0));
}

fn toLin1(c: f32) -> f32 { if (c <= 0.04045) { return c / 12.92; } return pow((c + 0.055) / 1.055, 2.4); }
fn toLin(c: vec3f) -> vec3f { return vec3f(toLin1(c.x), toLin1(c.y), toLin1(c.z)); }
fn toSrgb1(c0: f32) -> f32 { let c = clamp(c0, 0.0, 1.0); if (c <= 0.0031308) { return c * 12.92; } return 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
fn toSrgb(c: vec3f) -> vec3f { return vec3f(toSrgb1(c.x), toSrgb1(c.y), toSrgb1(c.z)); }

fn hash2(x: i32, y: i32, seed: u32) -> f32 {
  var h: u32 = bitcast<u32>(x) * 374761393u + bitcast<u32>(y) * 668265263u + seed * 144665u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h & 0xffffffu) / 16777215.0;
}
fn vnoise(x: f32, y: f32, seed: u32) -> f32 {
  let xi = i32(floor(x)); let yi = i32(floor(y));
  let fx = x - floor(x); let fy = y - floor(y);
  let ux = fx * fx * (3.0 - 2.0 * fx); let uy = fy * fy * (3.0 - 2.0 * fy);
  let a = hash2(xi, yi, seed); let b = hash2(xi + 1, yi, seed); let c = hash2(xi, yi + 1, seed); let d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
fn paperN(x: f32, y: f32, scale: f32) -> f32 {
  let s = 1.0 / (3.2 * scale);
  return vnoise(x * s, y * s, 7u) * 0.5 + vnoise(x * s * 2.3, y * s * 3.1, 11u) * 0.32 + hash2(i32(floor(x)), i32(floor(y)), 3u) * 0.18;
}
`;

export const PAINT = /* wgsl */ `
${COMMON}

struct StrokeU {
  docSize: vec2<i32>, wetOrigin: vec2<i32>, wetSize: vec2<i32>, _p0: vec2<i32>,
  mode: u32, tip: u32, spectral: u32, alphaLock: u32,
  opacity: f32, wetness: f32, viscosity: f32, pickup: f32,
  load: f32, transparency: f32, wetEdge: f32, impasto: f32,
  grain: f32, grainScale: f32, bristles: f32, evap: f32,
  seed: u32, hasMask: u32, hasTip: u32, _p1: u32,
}
struct PassU {
  rectMin: vec2<i32>, rectMax: vec2<i32>,
  parity: u32, strand: u32, first: u32, _p: u32,
  pos: vec2f, r: f32, angle: f32,
  roundness: f32, hardness: f32, flow: f32, _q: f32,
  color: vec4f,
}

@group(0) @binding(0) var<uniform> S: StrokeU;
@group(0) @binding(1) var<uniform> P: PassU;
@group(0) @binding(2) var<storage, read_write> wet: array<u32>;
@group(0) @binding(3) var layerTex: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var maskTex: texture_2d<f32>;
@group(0) @binding(6) var tipTex: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> res: array<vec4f>;

const MODE_PAINT = 0u; const MODE_ERASE = 1u; const MODE_SMUDGE = 2u; const MODE_BLEND = 3u;

fn wi(p: vec2<i32>) -> i32 {
  let q = p - S.wetOrigin;
  if (q.x < 0 || q.y < 0 || q.x >= S.wetSize.x || q.y >= S.wetSize.y) { return -1; }
  return q.y * S.wetSize.x + q.x;
}
fn getP(i: i32) -> vec4f {
  if (i < 0) { return vec4f(0.0); }
  let a = unpack2x16float(wet[i * 3]); let b = unpack2x16float(wet[i * 3 + 1]);
  return vec4f(a.x, a.y, b.x, b.y);
}
fn getW(i: i32) -> f32 { if (i < 0) { return 0.0; } return unpack2x16float(wet[i * 3 + 2]).x; }
fn setWet(i: i32, p: vec4f, w: f32) {
  wet[i * 3] = pack2x16float(p.xy);
  wet[i * 3 + 1] = pack2x16float(p.zw);
  wet[i * 3 + 2] = pack2x16float(vec2f(w, 0.0));
}
fn inDoc(p: vec2<i32>) -> bool { return p.x >= 0 && p.y >= 0 && p.x < S.docSize.x && p.y < S.docSize.y; }
fn baseAt(p: vec2<i32>) -> vec4f {
  if (!inDoc(p)) { return vec4f(0.0); }
  let c = textureLoad(layerTex, p, 0);
  return vec4f(toLin(c.rgb), c.a);
}
fn maskAt(p: vec2<i32>) -> f32 { if (S.hasMask == 0u) { return 1.0; } return textureLoad(maskTex, p, 0).r; }

fn coverage(m: f32) -> f32 { return S.opacity * (1.0 - exp(-3.0 * m)) / (1.0 - exp(-3.0)); }

fn mixSel(a: vec3f, b: vec3f, t: f32) -> vec3f { if (S.spectral == 1u) { return kmMix(a, b, t); } return mix(a, b, t); }

/** Mirrors applyWet() in paintModel.ts. base: linear straight. Returns linear straight. */
fn applyWet(base: vec4f, p: vec4f, mode: u32, shade: f32, mk: f32, forceLinear: bool, gran: f32) -> vec4f {
  let m = p.w * gran;
  if (m < 0.0001) { return base; }
  let cov = clamp(coverage(m) * mk, 0.0, 1.0);
  if (mode == MODE_ERASE) { return vec4f(base.rgb, base.a * (1.0 - cov)); }
  if (S.alphaLock == 1u && base.a <= 0.0) { return base; }
  let c = p.rgb / m;
  var outC = c;
  if (base.a > 0.001) {
    var opaque: vec3f;
    if (mode == MODE_PAINT && !forceLinear) { opaque = mixSel(base.rgb, c, cov); } else { opaque = mix(base.rgb, c, cov); }
    var t = 0.0;
    if (mode == MODE_PAINT) { t = S.transparency; }
    let glaze = base.rgb * (1.0 - cov + c * cov);
    let mixed = mix(opaque, glaze, t);
    let outA0 = base.a + cov * (1.0 - base.a);
    outC = mix(c, mixed, base.a / outA0);
  }
  var outA = base.a + cov * (1.0 - base.a);
  if (S.alphaLock == 1u) { outA = base.a; }
  return vec4f(outC * shade, outA);
}

fn smooth01(e0: f32, e1: f32, x: f32) -> f32 { return smoothstep(e0, e1, x); }

/** Mirrors footprint() in paintModel.ts. */
fn footprint(px: f32, py: f32) -> f32 {
  let dx = px - P.pos.x; let dy = py - P.pos.y;
  let c = cos(P.angle); let s = sin(P.angle);
  var lx = (dx * c + dy * s) / P.r;
  let ly = (-dx * s + dy * c) / P.r;
  if (S.tip == 4u && S.hasTip == 1u) {
    let u = lx * 0.5 + 0.5; let v = ly * 0.5 + 0.5;
    if (u < 0.0 || v < 0.0 || u >= 1.0 || v >= 1.0) { return 0.0; }
    let dim = vec2f(textureDimensions(tipTex));
    return textureLoad(tipTex, vec2<i32>(vec2f(u, v) * dim), 0).r * P.flow;
  }
  lx = lx / max(0.05, P.roundness);
  var dist: f32;
  if (S.tip == 1u) { dist = pow(pow(abs(lx), 6.0) + pow(abs(ly), 6.0), 1.0 / 6.0); }
  else { dist = sqrt(lx * lx + ly * ly); }
  if (dist >= 1.0) { return 0.0; }
  var fp = 1.0 - smoothstep(P.hardness * 0.98, 1.0, dist);
  var bristle = S.bristles;
  if (S.tip == 3u) { bristle = max(bristle, 0.85); }
  if (bristle > 0.0) {
    let fan = S.tip == 3u;
    var n = 16.0;
    if (fan) { n = 9.0; }
    let u = ly * 0.5 + 0.5;
    let sd = S.seed & 0xffffu;
    let a = vnoise(u * n, 0.5, sd); let b = vnoise(u * n * 2.9, 3.5, sd + 7u);
    var strength = 0.62 * a + 0.38 * b;
    if (fan) { strength = strength * smoothstep(0.3, 0.55, b); }
    fp = fp * (1.0 - bristle * (1.0 - min(1.0, 0.15 + strength * 1.1)));
  }
  fp = fp * P.flow;
  if (S.grain > 0.0) {
    let n = paperN(px, py, S.grainScale);
    fp = fp * (1.0 - S.grain * (1.0 - smoothstep(0.55 - fp * 0.45, 0.8 - fp * 0.3, n)));
  }
  return clamp(fp, 0.0, 1.0);
}

// ---------------------------------------------------------------- reservoir sampling (1 workgroup)
var<workgroup> accC: array<vec4f, 64>;

@compute @workgroup_size(64)
fn cs_sample(@builtin(local_invocation_index) li: u32) {
  let gx = f32(li % 8u) - 3.5; let gy = f32(li / 8u) - 3.5;
  let rr = P.r * 0.6 / 3.5;
  let q = vec2<i32>(i32(round(P.pos.x + gx * rr)), i32(round(P.pos.y + gy * rr)));
  let b = baseAt(q);
  let v = applyWet(b, getP(wi(q)), MODE_PAINT, 1.0, 1.0, true, 1.0);
  accC[li] = vec4f(v.rgb * v.a, v.a);
  workgroupBarrier();
  var s = 32u;
  loop {
    if (s == 0u) { break; }
    if (li < s) { accC[li] = accC[li] + accC[li + s]; }
    workgroupBarrier();
    s = s / 2u;
  }
  if (li == 0u) {
    let sum = accC[0];
    var sc = vec3f(0.0); var sa = 0.0;
    if (sum.w > 0.0001) { sc = sum.rgb / sum.w; sa = sum.w / 64.0; }
    let k = P.strand * 2u;
    var rc = res[k].rgb; var ra = res[k + 1u].x; let inited = res[k + 1u].y > 0.5;
    if (S.mode == MODE_PAINT) {
      var refill = S.load;
      if (!inited) { refill = 1.0; }
      rc = mixSel(rc, P.color.rgb, refill);
      if (sa > 0.0) { rc = mixSel(rc, sc, S.pickup * sa * 0.6); }
      ra = 1.0;
    } else if (S.mode == MODE_SMUDGE || S.mode == MODE_BLEND) {
      if (!inited || P.first == 1u) { rc = sc; ra = sa; }
      else {
        var kk = 1.0 - S.pickup * 0.92;
        if (S.mode == MODE_BLEND) { kk = 0.5; }
        if (sa > 0.0) { rc = mix(rc, sc, kk * (sa / max(max(sa, ra), 0.001))); }
        ra = ra + (sa - ra) * kk;
      }
    }
    res[k] = vec4f(rc, 1.0);
    res[k + 1u] = vec4f(ra, 1.0, 0.0, 0.0);
  }
}

// ---------------------------------------------------------------- deposit one dab
@compute @workgroup_size(8, 8)
fn cs_deposit(@builtin(global_invocation_id) gid: vec3u) {
  let p = P.rectMin + vec2<i32>(gid.xy);
  if (p.x > P.rectMax.x || p.y > P.rectMax.y || !inDoc(p)) { return; }
  let i = wi(p);
  if (i < 0) { return; }
  var f = footprint(f32(p.x) + 0.5, f32(p.y) + 0.5);
  f = f * maskAt(p);
  if (f <= 0.001) { return; }
  let k = P.strand * 2u;
  var dep = res[k].rgb; var tgt = 1.0;
  if (S.mode == MODE_SMUDGE || S.mode == MODE_BLEND) { tgt = res[k + 1u].x; if (tgt < 0.01) { return; } }
  if (S.mode == MODE_ERASE) { dep = vec3f(0.0); }
  let cur = getP(i);
  let np = cur + (vec4f(dep * tgt, tgt) - cur) * f;
  let w = getW(i);
  setWet(i, np, w + (S.wetness - w) * f);
}

// ---------------------------------------------------------------- flow (red-black relaxation)
@compute @workgroup_size(8, 8)
fn cs_flow(@builtin(global_invocation_id) gid: vec3u) {
  let p = P.rectMin + vec2<i32>(gid.xy);
  if (p.x > P.rectMax.x || p.y > P.rectMax.y || !inDoc(p)) { return; }
  if (u32((p.x + p.y) & 1) != P.parity) { return; }
  let i = wi(p);
  if (i < 0) { return; }
  var pc = getP(i);
  var w = getW(i);
  let diff = pow(1.0 - S.viscosity, 2.0) * 0.22;
  let edge = S.wetEdge * 0.9;
  var offs = array<vec2<i32>, 4>(vec2<i32>(1, 0), vec2<i32>(-1, 0), vec2<i32>(0, 1), vec2<i32>(0, -1));
  var dP = vec4f(0.0); var dW = 0.0;
  for (var n = 0; n < 4; n++) {
    let j = wi(p + offs[n]);
    if (j < 0) { continue; }
    let wn = getW(j); let pn = getP(j);
    if (w > 0.02 && wn > 0.02) {
      let k = diff * min(w, wn);
      dP += k * (pn - pc) * 0.5;
      let e = clamp(edge * (w - wn), -0.2, 0.2);
      if (e > 0.0) { dP -= e * pc; } else { dP -= e * pn; }
      dW += 0.12 * (wn - w);
    } else if (w > 0.02 && wn <= 0.02 && w > 0.55 && diff > 0.05) {
      let spread = (w - 0.55) * diff * 0.35;   // we bleed out into a dry neighbour
      dP -= pc * spread * 0.8; dW -= spread;
    } else if (w <= 0.02 && wn > 0.55 && diff > 0.05) {
      let spread = (wn - 0.55) * diff * 0.35;  // a very wet neighbour bleeds into us
      dP += pn * spread * 0.8; dW += spread;
    }
  }
  pc = max(pc + dP, vec4f(0.0));
  w = max(0.0, w + dW);
  w = max(0.0, w - S.evap * max(w, 0.05));
  setWet(i, pc, w);
}

// ---------------------------------------------------------------- composite wet paint onto layer
@compute @workgroup_size(8, 8)
fn cs_composite(@builtin(global_invocation_id) gid: vec3u) {
  let p = P.rectMin + vec2<i32>(gid.xy);
  if (p.x > P.rectMax.x || p.y > P.rectMax.y || !inDoc(p)) { return; }
  let raw = textureLoad(layerTex, p, 0);
  let i = wi(p);
  let pc = getP(i);
  if (pc.w < 0.0001) { textureStore(outTex, p, raw); return; }
  var shade = 1.0;
  if (S.impasto > 0.0) {
    let gx = (getP(wi(p + vec2<i32>(-2, 0))).w - getP(wi(p + vec2<i32>(2, 0))).w) * 2.2;
    let gy = (getP(wi(p + vec2<i32>(0, -2))).w - getP(wi(p + vec2<i32>(0, 2))).w) * 2.2;
    shade = 1.0 + clamp((gx * -0.6 + gy * -0.7) * S.impasto, -0.3, 0.3);
  }
  var gran = 1.0;
  let g = S.transparency * S.wetness;
  if (g > 0.05 && S.mode == MODE_PAINT) { gran = 1.0 + (0.5 - paperN(f32(p.x), f32(p.y), 1.1)) * 0.9 * g; }
  if (S.wetEdge > 0.0 && S.mode == MODE_PAINT) {
    let avg = (getP(wi(p + vec2<i32>(-3, 0))).w + getP(wi(p + vec2<i32>(3, 0))).w + getP(wi(p + vec2<i32>(0, -3))).w + getP(wi(p + vec2<i32>(0, 3))).w
      + getP(wi(p + vec2<i32>(-2, -2))).w + getP(wi(p + vec2<i32>(2, 2))).w + getP(wi(p + vec2<i32>(-2, 2))).w + getP(wi(p + vec2<i32>(2, -2))).w) / 8.0;
    gran = gran * (1.0 + S.wetEdge * clamp((pc.w - avg) / max(pc.w, 0.001) * 4.0, 0.0, 1.0) * 1.2);
  }
  let r = applyWet(vec4f(toLin(raw.rgb), raw.a), pc, S.mode, shade, 1.0, false, gran);
  textureStore(outTex, p, vec4f(toSrgb(r.rgb), clamp(r.a, 0.0, 1.0)));
}

@compute @workgroup_size(8, 8)
fn cs_clear(@builtin(global_invocation_id) gid: vec3u) {
  let p = P.rectMin + vec2<i32>(gid.xy);
  if (p.x > P.rectMax.x || p.y > P.rectMax.y) { return; }
  let i = wi(p);
  if (i < 0) { return; }
  wet[i * 3] = 0u; wet[i * 3 + 1] = 0u; wet[i * 3 + 2] = 0u;
}
`;

export const COMPOSE = /* wgsl */ `
${COMMON}
struct LayerU { opacity: f32, mode: u32, isBg: u32, paper: f32, bg: vec4f }
@group(0) @binding(0) var<uniform> L: LayerU;
@group(0) @binding(1) var accTex: texture_2d<f32>;
@group(0) @binding(2) var srcTex: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }
fn clipColor(c0: vec3f) -> vec3f {
  var c = c0;
  let l = lum(c); let n = min(c.x, min(c.y, c.z)); let x = max(c.x, max(c.y, c.z));
  if (n < 0.0) { c = l + (c - l) * l / max(l - n, 1e-5); }
  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5); }
  return c;
}
fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + (l - lum(c))); }
fn sat(c: vec3f) -> f32 { return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z)); }
fn setSat(c: vec3f, s: f32) -> vec3f {
  let mx = max(c.x, max(c.y, c.z)); let mn = min(c.x, min(c.y, c.z));
  if (mx - mn < 1e-5) { return vec3f(0.0); }
  return (c - mn) * s / (mx - mn);
}
fn softD(x: f32) -> f32 { if (x <= 0.25) { return ((16.0 * x - 12.0) * x + 4.0) * x; } return sqrt(x); }
fn soft1(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return b - (1.0 - 2.0 * s) * b * (1.0 - b); }
  return b + (2.0 * s - 1.0) * (softD(b) - b);
}
fn hard1(b: f32, s: f32) -> f32 { if (s <= 0.5) { return b * 2.0 * s; } let t = 2.0 * s - 1.0; return b + t - b * t; }
fn dodge1(b: f32, s: f32) -> f32 { if (b <= 0.0) { return 0.0; } if (s >= 1.0) { return 1.0; } return min(1.0, b / (1.0 - s)); }
fn burn1(b: f32, s: f32) -> f32 { if (b >= 1.0) { return 1.0; } if (s <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - b) / s); }

fn blendFn(m: u32, b: vec3f, s: vec3f) -> vec3f {
  switch m {
    case 1u: { return b * s; }
    case 2u: { return b + s - b * s; }
    case 3u: { return vec3f(hard1(s.x, b.x), hard1(s.y, b.y), hard1(s.z, b.z)); }
    case 4u: { return vec3f(soft1(b.x, s.x), soft1(b.y, s.y), soft1(b.z, s.z)); }
    case 5u: { return vec3f(hard1(b.x, s.x), hard1(b.y, s.y), hard1(b.z, s.z)); }
    case 6u: { return min(b, s); }
    case 7u: { return max(b, s); }
    case 8u: { return vec3f(dodge1(b.x, s.x), dodge1(b.y, s.y), dodge1(b.z, s.z)); }
    case 9u: { return vec3f(burn1(b.x, s.x), burn1(b.y, s.y), burn1(b.z, s.z)); }
    case 10u: { return abs(b - s); }
    case 11u: { return b + s - 2.0 * b * s; }
    case 12u: { return setLum(setSat(s, sat(b)), lum(b)); }
    case 13u: { return setLum(setSat(b, sat(s)), lum(b)); }
    case 14u: { return setLum(s, lum(b)); }
    case 15u: { return setLum(b, lum(s)); }
    default: { return s; }
  }
}

@fragment fn fs_layer(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2<i32>(pos.xy);
  let dst = textureLoad(accTex, p, 0);
  if (L.isBg == 1u) {
    if (L.bg.a <= 0.0) { return vec4f(0.0); }
    var c = L.bg.rgb;
    if (L.paper > 0.0) {
      // same texture as the CPU paper tile (256px repeat)
      let q = vec2f(f32(p.x % 256), f32(p.y % 256));
      let n = paperN(q.x, q.y, 1.3);
      let v = (255.0 - (1.0 - n) * 60.0) / 255.0;
      c = mix(c, c * v, L.paper);
    }
    return vec4f(c, 1.0);
  }
  let src = textureLoad(srcTex, p, 0);
  let sa_ = src.a * L.opacity;
  if (sa_ <= 0.0) { return dst; }
  if (L.mode == 16u) { return min(vec4f(1.0), dst + vec4f(src.rgb * sa_, sa_)); }
  let ab = dst.a;
  var cb = vec3f(0.0);
  if (ab > 0.0) { cb = dst.rgb / ab; }
  let cs = (1.0 - ab) * src.rgb + ab * clamp(blendFn(L.mode, cb, src.rgb), vec3f(0.0), vec3f(1.0));
  return vec4f(cs * sa_ + dst.rgb * (1.0 - sa_), sa_ + ab * (1.0 - sa_));
}
`;

export const SCREEN = /* wgsl */ `
struct ScreenU {
  inv0: vec4f,   // doc = inv0.xy * sx + inv0.zw * sy + inv1.xy  (device px -> doc px)
  inv1: vec4f,   // xy: translation, z: zoom (device px per doc px), w: checker(1)
  docSize: vec2f, grid: f32, _p: f32,
  workspace: vec4f,
}
@group(0) @binding(0) var<uniform> U: ScreenU;
@group(0) @binding(1) var comp: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn toDoc(s: vec2f) -> vec2f { return U.inv0.xy * s.x + U.inv0.zw * s.y + U.inv1.xy; }

fn fetch(d: vec2f) -> vec4f {
  let uv = d / U.docSize;
  if (U.inv1.z >= 2.0) {
    let q = clamp(vec2<i32>(floor(d)), vec2<i32>(0), vec2<i32>(U.docSize) - 1);
    return textureLoad(comp, q, 0);
  }
  return textureSampleLevel(comp, samp, uv, 0.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = toDoc(pos.xy);
  if (d.x < 0.0 || d.y < 0.0 || d.x >= U.docSize.x || d.y >= U.docSize.y) { return U.workspace; }
  var c: vec4f;
  let z = U.inv1.z;
  if (z < 0.75) {
    // zoomed out: supersample to avoid shimmering
    c = vec4f(0.0);
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let o = (U.inv0.xy * f32(i) + U.inv0.zw * f32(j)) * 0.33;
        c += fetch(clamp(d + o, vec2f(0.0), U.docSize - 0.001));
      }
    }
    c = c / 9.0;
  } else { c = fetch(d); }
  var bg = vec3f(1.0);
  if (U.inv1.w > 0.5) {
    let q = vec2<i32>(floor(pos.xy / 10.0));
    if (((q.x + q.y) & 1) == 0) { bg = vec3f(0.96); } else { bg = vec3f(0.82); }
  }
  var outc = c.rgb + bg * (1.0 - c.a);
  if (U.grid > 0.5 && z >= 8.0) {
    let f = fract(d);
    let px = 1.0 / z;
    if (f.x < px || f.y < px) { outc = mix(outc, vec3f(0.5), 0.35); }
  }
  return vec4f(outc, 1.0);
}
`;
