// Turns raw pointer samples into brush dabs: stabilizer -> guides -> symmetry -> spacing -> dynamics.
import type { Pt } from '../core/geom';
import { clamp, hsvToRgb, lerp, mixOklab, rgbToHsv, toLinear, type RGB } from '../core/color';
import type { BrushSettings } from './brush';
import type { Dab } from './types';

export interface InputSample { x: number; y: number; p: number; tiltX: number; tiltY: number; t: number }

// ------------------------------------------------------------------------------------------ stabilizer
export interface StabilizerSettings {
  mode: 'off' | 'smooth' | 'rope';
  strength: number; // 0..100
  predictive: boolean;
  catchUp: boolean;
}

/** One-euro filter: strong smoothing when slow (kills jitter), little lag when fast. */
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  constructor(public minCutoff: number, public beta: number, public dCutoff = 1) {}
  private alpha(cutoff: number, dt: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v: number, dt: number): number {
    if (this.x === null) { this.x = v; return v; }
    const d = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

export class Stabilizer {
  private fx: OneEuro;
  private fy: OneEuro;
  private rope: Pt | null = null;
  private lastT = 0;
  private lastRaw: InputSample | null = null;
  private lastOut: InputSample | null = null;
  private vel = { x: 0, y: 0 };
  constructor(private s: StabilizerSettings, private zoom: number) {
    const k = s.strength / 100;
    this.fx = new OneEuro(lerp(8, 0.15, Math.sqrt(k)), lerp(0.05, 0.004, k));
    this.fy = new OneEuro(lerp(8, 0.15, Math.sqrt(k)), lerp(0.05, 0.004, k));
  }

  push(s: InputSample): InputSample | null {
    const k = this.s.strength / 100;
    const dt = Math.max(1, s.t - (this.lastT || s.t - 8)) / 1000;
    this.lastT = s.t;
    if (this.lastRaw) {
      const a = 0.3;
      this.vel.x = lerp(this.vel.x, (s.x - this.lastRaw.x) / dt, a);
      this.vel.y = lerp(this.vel.y, (s.y - this.lastRaw.y) / dt, a);
    }
    this.lastRaw = s;
    if (this.s.mode === 'off' || k <= 0) return (this.lastOut = s);
    let out: InputSample;
    if (this.s.mode === 'rope') {
      const L = (k * 60) / this.zoom;
      if (!this.rope) { this.rope = { x: s.x, y: s.y }; return (this.lastOut = s); }
      const dx = s.x - this.rope.x, dy = s.y - this.rope.y, d = Math.hypot(dx, dy);
      if (d <= L) return null;
      this.rope.x += (dx / d) * (d - L);
      this.rope.y += (dy / d) * (d - L);
      out = { ...s, x: this.rope.x, y: this.rope.y };
    } else {
      out = { ...s, x: this.fx.filter(s.x, dt), y: this.fy.filter(s.y, dt) };
    }
    if (this.s.predictive) {
      // Predictive catch-up: at speed, pull the smoothed point toward where the pen is heading so the
      // line doesn't trail behind, while slow careful movements stay fully stabilised.
      const speed = Math.hypot(this.vel.x, this.vel.y) * this.zoom; // screen px / s
      const f = clamp((speed - 150) / 1500) * 0.6;
      out.x = lerp(out.x, s.x + this.vel.x * 0.008, f);
      out.y = lerp(out.y, s.y + this.vel.y * 0.008, f);
    }
    return (this.lastOut = out);
  }

  /** Samples that close the gap between the stabilised point and the pen on lift. */
  finish(): InputSample[] {
    if (!this.s.catchUp || !this.lastRaw || !this.lastOut || this.s.mode === 'off') return [];
    const a = this.lastOut, b = this.lastRaw;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 0.5) return [];
    const n = Math.min(24, Math.ceil(d / 2));
    const out: InputSample[] = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out.push({ ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), p: lerp(a.p, b.p * 0.6, t) });
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------ symmetry
export interface SymmetrySettings {
  mode: 'off' | 'vertical' | 'horizontal' | 'quad' | 'radial';
  count: number;
  mirror: boolean;
  cx: number;
  cy: number;
}

export type PtTransform = (p: Pt) => Pt;

export function symmetryTransforms(s: SymmetrySettings): PtTransform[] {
  const { cx, cy } = s;
  const id: PtTransform = (p) => ({ x: p.x, y: p.y });
  const mx: PtTransform = (p) => ({ x: 2 * cx - p.x, y: p.y });
  const my: PtTransform = (p) => ({ x: p.x, y: 2 * cy - p.y });
  switch (s.mode) {
    case 'vertical': return [id, mx];
    case 'horizontal': return [id, my];
    case 'quad': return [id, mx, my, (p) => ({ x: 2 * cx - p.x, y: 2 * cy - p.y })];
    case 'radial': {
      const n = Math.max(2, Math.min(32, Math.round(s.count)));
      const list: PtTransform[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        list.push((p) => { const dx = p.x - cx, dy = p.y - cy; return { x: cx + dx * c - dy * sn, y: cy + dx * sn + dy * c }; });
        if (s.mirror) list.push((p) => { const dx = p.x - cx, dy = -(p.y - cy); return { x: cx + dx * c - dy * sn, y: cy + dx * sn + dy * c }; });
      }
      return list;
    }
    default: return [id];
  }
}

// ------------------------------------------------------------------------------------------ guides
export interface GuideSettings {
  enabled: boolean;
  magnet: number; // 0..1 how strongly strokes snap
  rulers: { a: Pt; b: Pt }[];
  perspective: Pt[]; // vanishing points
  gridSnap: boolean;
  gridSize: number;
  showGrid: boolean;
}

/** Per-stroke magnetic constraint: decides the intended guide from your first motion, then pulls toward it. */
export class GuideSnapper {
  private start: Pt | null = null;
  private dir: Pt | null = null;
  private decided = false;
  constructor(private g: GuideSettings, private zoom: number) {}

  apply(p: Pt): Pt {
    const g = this.g;
    if (!g.enabled || g.magnet <= 0) return p;
    if (!this.start) { this.start = { ...p }; return p; }
    if (!this.decided) {
      const dx = p.x - this.start.x, dy = p.y - this.start.y, d = Math.hypot(dx, dy);
      if (d * this.zoom < 10) return p;
      this.decided = true;
      const move = { x: dx / d, y: dy / d };
      const cands: Pt[] = [];
      for (const r of g.rulers) {
        const rx = r.b.x - r.a.x, ry = r.b.y - r.a.y, rl = Math.hypot(rx, ry);
        if (rl > 0) { cands.push({ x: rx / rl, y: ry / rl }); cands.push({ x: -ry / rl, y: rx / rl }); }
      }
      for (const vp of g.perspective) {
        const vx = this.start.x - vp.x, vy = this.start.y - vp.y, vl = Math.hypot(vx, vy);
        if (vl > 0) cands.push({ x: vx / vl, y: vy / vl });
      }
      if (g.gridSnap) cands.push({ x: 1, y: 0 }, { x: 0, y: 1 });
      let best: Pt | null = null, bestCos = Math.cos((22 * Math.PI) / 180);
      for (const c of cands) {
        const cos = Math.abs(c.x * move.x + c.y * move.y);
        if (cos > bestCos) { bestCos = cos; best = c; }
      }
      this.dir = best;
    }
    if (!this.dir) return p;
    const s = this.start, dx = p.x - s.x, dy = p.y - s.y;
    const t = dx * this.dir.x + dy * this.dir.y;
    const proj = { x: s.x + this.dir.x * t, y: s.y + this.dir.y * t };
    return { x: lerp(p.x, proj.x, g.magnet), y: lerp(p.y, proj.y, g.magnet) };
  }
}

// ------------------------------------------------------------------------------------------ dabs
let seedCounter = 1;
const rnd = () => Math.random();

interface StrandState { last: InputSample | null; carry: number; travelled: number; dir: Pt; lastDab: Pt | null; count: number }

export interface StrokeContext {
  brush: BrushSettings;
  color: RGB; // sRGB
  color2: RGB;
  stabilizer: StabilizerSettings;
  symmetry: SymmetrySettings;
  guides: GuideSettings;
  zoom: number;
  isPen: boolean;
  pressureGamma: number;
}

export class StrokeBuilder {
  private stab: Stabilizer;
  private snap: GuideSnapper;
  private transforms: PtTransform[];
  private strands: StrandState[];
  private base: [number, number, number];
  constructor(private c: StrokeContext) {
    this.stab = new Stabilizer(c.stabilizer, c.zoom);
    this.snap = new GuideSnapper(c.guides, c.zoom);
    this.transforms = symmetryTransforms(c.symmetry);
    this.strands = this.transforms.map(() => ({ last: null, carry: 0, travelled: 0, dir: { x: 1, y: 0 }, lastDab: null, count: 0 }));
    this.base = rgbToHsv(c.color);
  }

  push(raw: InputSample): Dab[] {
    const p = { ...raw, p: this.pressure(raw.p) };
    const s = this.stab.push(p);
    if (!s) return [];
    return this.emit(s);
  }

  finish(): Dab[] {
    const out: Dab[] = [];
    for (const s of this.stab.finish()) out.push(...this.emit(s));
    return out;
  }

  private pressure(p: number): number {
    if (!this.c.isPen) return 1;
    return Math.pow(clamp(p, 0, 1), this.c.pressureGamma);
  }

  private emit(s: InputSample): Dab[] {
    const g = this.snap.apply(s);
    const pt = { ...s, x: g.x, y: g.y };
    const dabs: Dab[] = [];
    this.transforms.forEach((tf, i) => {
      const q = tf(pt);
      this.walk(i, { ...pt, x: q.x, y: q.y }, dabs);
    });
    return dabs;
  }

  private radiusAt(p: number): number {
    const b = this.c.brush;
    const f = b.pressureSize ? lerp(b.minSize, 1, p) : 1;
    return Math.max(0.5, (b.size / 2) * f);
  }

  private walk(i: number, s: InputSample, out: Dab[]): void {
    const st = this.strands[i];
    const b = this.c.brush;
    if (!st.last) {
      st.last = s;
      out.push(this.makeDab(i, s, st));
      return;
    }
    const a = st.last;
    const dx = s.x - a.x, dy = s.y - a.y, d = Math.hypot(dx, dy);
    if (d < 1e-3) return;
    const ux = dx / d, uy = dy / d;
    // smoothed stroke direction for direction-following tips
    st.dir = { x: lerp(st.dir.x, ux, 0.35), y: lerp(st.dir.y, uy, 0.35) };
    let pos = -st.carry;
    for (;;) {
      const t0 = clamp(pos / d, 0, 1);
      const pr = lerp(a.p, s.p, t0);
      const step = Math.max(0.35, this.radiusAt(pr) * 2 * b.spacing);
      pos += step;
      if (pos > d) { st.carry = d - (pos - step); break; }
      const t = pos / d;
      const q: InputSample = { x: lerp(a.x, s.x, t), y: lerp(a.y, s.y, t), p: lerp(a.p, s.p, t), tiltX: s.tiltX, tiltY: s.tiltY, t: s.t };
      st.travelled += step;
      out.push(this.makeDab(i, q, st));
    }
    st.last = s;
  }

  private makeDab(i: number, s: InputSample, st: StrandState): Dab {
    const b = this.c.brush;
    let r = this.radiusAt(s.p);
    if (b.sizeJitter > 0) r *= 1 - b.sizeJitter * rnd() * 0.8;
    let x = s.x, y = s.y;
    if (b.scatter > 0) {
      const a = rnd() * Math.PI * 2, m = rnd() * b.scatter * r * 2;
      x += Math.cos(a) * m; y += Math.sin(a) * m;
    }
    let angle = (b.angle * Math.PI) / 180;
    let roundness = b.roundness;
    if (b.angleMode === 'direction') angle += Math.atan2(st.dir.y, st.dir.x);
    else if (b.angleMode === 'tilt' && (s.tiltX || s.tiltY)) {
      angle = Math.atan2(s.tiltY, s.tiltX);
      const tilt = Math.min(1, Math.hypot(s.tiltX, s.tiltY) / 60);
      roundness = Math.max(0.15, roundness * (1 - tilt * 0.6));
    }
    if (b.angleJitter > 0) angle += (rnd() - 0.5) * Math.PI * 2 * b.angleJitter;
    // flow normalised by spacing so build-up speed doesn't depend on stamp density
    let flow = b.flow * (b.pressureFlow && this.c.isPen ? lerp(0.2, 1, s.p) : 1);
    flow = 1 - Math.pow(1 - clamp(flow, 0, 0.999), Math.max(0.05, b.spacing / 0.12));
    st.count++;
    return {
      x, y, r, angle, roundness, hardness: b.hardness, flow,
      color: toLinear(this.colorAt(i, st.travelled)), strand: i, seed: (seedCounter = (seedCounter * 1103515245 + 12345) & 0x7fffffff),
      first: st.count === 1,
    };
  }

  private colorAt(i: number, travelled: number): RGB {
    const b = this.c.brush;
    let [h, s, v] = this.base;
    let col: RGB = this.c.color;
    if (b.colorMode === 'rainbow') {
      if (s < 0.25) s = 0.85;
      if (v < 0.35) v = 0.95;
      col = hsvToRgb(h + (travelled * b.rainbowSpeed) / 100, s, v);
    } else if (b.colorMode === 'gradient') {
      const cyc = (travelled * b.rainbowSpeed) / 100 / 360;
      const t = 1 - Math.abs(((cyc % 2) + 2) % 2 - 1);
      col = mixOklab(this.c.color, this.c.color2, t);
    }
    const jit = b.colorMode === 'jitter' ? 1 : 0.5;
    if (b.hueJitter > 0 || b.satJitter > 0 || b.valJitter > 0) {
      const hsv = rgbToHsv(col);
      col = hsvToRgb(
        hsv[0] + (rnd() - 0.5) * 360 * b.hueJitter * jit,
        clamp(hsv[1] + (rnd() - 0.5) * b.satJitter * jit),
        clamp(hsv[2] + (rnd() - 0.5) * b.valJitter * jit),
      );
    }
    return col;
  }
}
