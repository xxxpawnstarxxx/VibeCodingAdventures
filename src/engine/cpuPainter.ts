// CPU implementation of the liquid paint model. Used by the Canvas2D backend (no WebGPU) and for
// rendering brush preview thumbnails. Works on 64px tiles allocated lazily, so memory scales with
// the painted area rather than the document size.
import { clamp, type RGB } from '../core/color';
import type { Rect } from '../core/geom';
import { applyWet, footprint, granulation, LIN8, linearMix, spectralMix, toSrgb8, type MixFn, type TipImage } from './paintModel';
import type { Dab, StrokeParams } from './types';

const T = 64;

interface Tile {
  tx: number; ty: number; x: number; y: number; w: number; h: number;
  base: ImageData; // pixels before the stroke
  P: Float32Array; // premultiplied linear pigment rgb + mass
  W: Float32Array; // water
  dirty: boolean;
}

interface Reservoir { c: RGB; a: number; init: boolean }

export class CpuWetPainter {
  private tiles = new Map<number, Tile>();
  private prm!: StrokeParams;
  private res: Reservoir[] = [];
  private mask: Uint8Array | null = null;
  private mix: MixFn = spectralMix;
  private tip: TipImage | null = null;
  bbox: Rect | null = null;
  active = false;
  lifted = false;
  private settleLeft = 0;
  private ctx: CanvasRenderingContext2D;

  constructor(public target: HTMLCanvasElement) {
    this.ctx = target.getContext('2d', { willReadFrequently: true })!;
  }

  setTarget(c: HTMLCanvasElement) { this.target = c; this.ctx = c.getContext('2d', { willReadFrequently: true })!; }
  setTip(t: TipImage | null) { this.tip = t; }

  begin(prm: StrokeParams, mask: Uint8Array | null): void {
    this.prm = prm;
    this.mask = mask;
    this.mix = prm.spectral ? spectralMix : linearMix;
    this.tiles.clear();
    this.res = [];
    this.bbox = null;
    this.active = true;
    this.lifted = false;
  }

  private key(tx: number, ty: number) { return ty * 100000 + tx; }

  private tile(tx: number, ty: number): Tile | null {
    const W = this.target.width, H = this.target.height;
    if (tx < 0 || ty < 0 || tx * T >= W || ty * T >= H) return null;
    const k = this.key(tx, ty);
    let t = this.tiles.get(k);
    if (!t) {
      const x = tx * T, y = ty * T, w = Math.min(T, W - x), h = Math.min(T, H - y);
      t = { tx, ty, x, y, w, h, base: this.ctx.getImageData(x, y, w, h), P: new Float32Array(w * h * 4), W: new Float32Array(w * h), dirty: false };
      this.tiles.set(k, t);
      this.bbox = this.bbox
        ? (() => { const b = this.bbox!; const x0 = Math.min(b.x, x), y0 = Math.min(b.y, y); return { x: x0, y: y0, w: Math.max(b.x + b.w, x + w) - x0, h: Math.max(b.y + b.h, y + h) - y0 }; })()
        : { x, y, w, h };
    }
    return t;
  }

  /** Visible colour (linear, straight) + alpha at a pixel including wet paint. */
  private sample(px: number, py: number): [number, number, number, number] {
    const tx = Math.floor(px / T), ty = Math.floor(py / T);
    const t = this.tiles.get(this.key(tx, ty));
    if (!t) {
      if (px < 0 || py < 0 || px >= this.target.width || py >= this.target.height) return [0, 0, 0, 0];
      const d = this.ctx.getImageData(px, py, 1, 1).data;
      return [LIN8[d[0]], LIN8[d[1]], LIN8[d[2]], d[3] / 255];
    }
    const i = (py - t.y) * t.w + (px - t.x);
    const b = t.base.data;
    const ba = b[i * 4 + 3] / 255;
    const m = t.P[i * 4 + 3];
    if (m < 1e-4) return [LIN8[b[i * 4]], LIN8[b[i * 4 + 1]], LIN8[b[i * 4 + 2]], ba];
    return applyWet(LIN8[b[i * 4]], LIN8[b[i * 4 + 1]], LIN8[b[i * 4 + 2]], ba, t.P[i * 4], t.P[i * 4 + 1], t.P[i * 4 + 2], m,
      { ...this.prm, mode: 'paint' }, linearMix, 1, 1);
  }

  addDabs(dabs: Dab[]): void {
    for (const d of dabs) this.dab(d);
  }

  private dab(d: Dab): void {
    const prm = this.prm;
    // ---- reservoir: pick up canvas colour, refill toward loaded colour
    let r = this.res[d.strand];
    if (!r) r = this.res[d.strand] = { c: [...d.color] as RGB, a: 1, init: false };
    const needSample = prm.mode === 'smudge' || prm.mode === 'blend' || (prm.mode === 'paint' && prm.pickup > 0);
    let S: [number, number, number, number] = [0, 0, 0, 0];
    if (needSample) {
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      const rr = d.r * 0.6;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const px = Math.round(d.x + (i / 2) * rr), py = Math.round(d.y + (j / 2) * rr);
        const s = this.sample(px, py);
        sr += s[0] * s[3]; sg += s[1] * s[3]; sb += s[2] * s[3]; sa += s[3]; n++;
      }
      S = sa > 1e-4 ? [sr / sa, sg / sa, sb / sa, sa / n] : [0, 0, 0, 0];
    }
    let depColor: RGB, target: number;
    if (prm.mode === 'paint') {
      r.c = this.mix(r.c, d.color, r.init ? prm.load : 1);
      r.init = true;
      if (S[3] > 0) r.c = this.mix(r.c, [S[0], S[1], S[2]], prm.pickup * S[3] * 0.6);
      depColor = r.c; target = 1;
    } else if (prm.mode === 'smudge' || prm.mode === 'blend') {
      if (!r.init || d.first) { r.c = [S[0], S[1], S[2]]; r.a = S[3]; r.init = true; }
      else {
        const k = prm.mode === 'blend' ? 0.5 : 1 - prm.pickup * 0.92;
        if (S[3] > 0) r.c = linearMix(r.c, [S[0], S[1], S[2]], k * (S[3] / Math.max(S[3], r.a, 1e-3)));
        r.a = r.a + (S[3] - r.a) * k;
      }
      depColor = r.c; target = r.a;
      if (target < 0.01) return;
    } else { depColor = [0, 0, 0]; target = 1; }

    // ---- deposit
    const ext = d.r * (prm.tip === 1 || prm.tip === 4 ? 1.5 : 1) + 1;
    const x0 = Math.floor(d.x - ext), y0 = Math.floor(d.y - ext), x1 = Math.ceil(d.x + ext), y1 = Math.ceil(d.y + ext);
    const wet = prm.wetness;
    const maskW = this.target.width;
    for (let ty = Math.floor(y0 / T); ty <= Math.floor(y1 / T); ty++) {
      for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) {
        const t = this.tile(tx, ty);
        if (!t) continue;
        const ax = Math.max(x0, t.x), ay = Math.max(y0, t.y), bx = Math.min(x1, t.x + t.w - 1), by = Math.min(y1, t.y + t.h - 1);
        for (let y = ay; y <= by; y++) {
          for (let x = ax; x <= bx; x++) {
            let f = footprint(x + 0.5, y + 0.5, d, prm, this.tip);
            if (f <= 0.001) continue;
            if (this.mask) f *= this.mask[y * maskW + x] / 255;
            if (f <= 0.001) continue;
            const i = (y - t.y) * t.w + (x - t.x);
            const P = t.P, o = i * 4;
            P[o] += (depColor[0] * target - P[o]) * f;
            P[o + 1] += (depColor[1] * target - P[o + 1]) * f;
            P[o + 2] += (depColor[2] * target - P[o + 2]) * f;
            P[o + 3] += (target - P[o + 3]) * f;
            t.W[i] += (wet - t.W[i]) * f;
          }
        }
        t.dirty = true;
      }
    }
  }

  private flow(dtMs: number): void {
    const prm = this.prm;
    if (prm.wetness <= 0.01 || prm.mode !== 'paint') return;
    const diff = Math.pow(1 - prm.viscosity, 2) * 0.22;
    const edge = prm.wetEdge * 0.9;
    const evap = this.lifted ? dtMs / Math.max(16, this.settleLeft + dtMs) : 0.002;
    const get = (t: Tile, x: number, y: number): [Tile, number] | null => {
      if (x >= 0 && y >= 0 && x < t.w && y < t.h) return [t, y * t.w + x];
      const gx = t.x + x, gy = t.y + y;
      const n = this.tiles.get(this.key(Math.floor(gx / T), Math.floor(gy / T)));
      if (!n) return null;
      return [n, (gy - n.y) * n.w + (gx - n.x)];
    };
    for (const t of this.tiles.values()) {
      let any = false;
      for (let i = 0; i < t.W.length; i++) if (t.W[i] > 0.02) { any = true; break; }
      if (!any) continue;
      t.dirty = true;
      const { P, W } = t;
      for (let y = 0; y < t.h; y++) {
        for (let x = 0; x < t.w; x++) {
          const i = y * t.w + x;
          const w = W[i];
          if (w <= 0.02) continue;
          const nbs = [get(t, x + 1, y), get(t, x - 1, y), get(t, x, y + 1), get(t, x, y - 1)];
          for (const nb of nbs) {
            if (!nb) continue;
            const [nt, j] = nb;
            const wn = nt.W[j];
            const o = i * 4, q = j * 4;
            if (wn > 0.02) {
              const k = diff * Math.min(w, wn);
              const e = Math.max(-0.2, Math.min(0.2, edge * (w - wn))); // pigment drifts toward the drier (edge) cell
              for (let c = 0; c < 4; c++) {
                let fl = k * (nt.P[q + c] - P[o + c]) * 0.5;
                if (e > 0) fl -= e * P[o + c]; else fl -= e * nt.P[q + c];
                P[o + c] += fl; nt.P[q + c] -= fl;
              }
              const wf = 0.12 * (wn - w);
              W[i] += wf; nt.W[j] -= wf;
            } else if (w > 0.55 && diff > 0.05) {
              // bleed: very wet runny paint creeps into dry neighbours
              const spread = (w - 0.55) * diff * 0.35;
              nt.W[j] += spread; W[i] -= spread;
              for (let c = 0; c < 4; c++) { const fl = P[o + c] * spread * 0.8; nt.P[q + c] += fl; P[o + c] -= fl; }
              nt.dirty = true;
            }
          }
          W[i] = Math.max(0, W[i] - evap * Math.max(W[i], 0.05));
        }
      }
    }
  }

  private massAt(gx: number, gy: number): number {
    const t = this.tiles.get(this.key(Math.floor(gx / T), Math.floor(gy / T)));
    if (!t) return 0;
    return t.P[((gy - t.y) * t.w + (gx - t.x)) * 4 + 3];
  }

  /** Wet-edge darkening: pigment is denser just inside the boundary of a wet stroke. */
  private edgeBoost(gx: number, gy: number, m: number): number {
    const e = this.prm.wetEdge;
    if (e <= 0 || this.prm.mode !== 'paint') return 1;
    const R = 3;
    const avg = (this.massAt(gx - R, gy) + this.massAt(gx + R, gy) + this.massAt(gx, gy - R) + this.massAt(gx, gy + R)
      + this.massAt(gx - 2, gy - 2) + this.massAt(gx + 2, gy + 2) + this.massAt(gx - 2, gy + 2) + this.massAt(gx + 2, gy - 2)) / 8;
    return 1 + e * clamp(((m - avg) / Math.max(m, 1e-3)) * 4) * 1.2;
  }

  /** Composite dirty tiles into the target canvas. Returns dirty rect. */
  private present(): Rect | null {
    let rect: Rect | null = null;
    const prm = this.prm;
    for (const t of this.tiles.values()) {
      if (!t.dirty) continue;
      t.dirty = false;
      const out = new ImageData(t.w, t.h);
      const b = t.base.data, o = out.data, P = t.P;
      for (let i = 0; i < t.w * t.h; i++) {
        const m = P[i * 4 + 3];
        if (m < 1e-4) { o[i * 4] = b[i * 4]; o[i * 4 + 1] = b[i * 4 + 1]; o[i * 4 + 2] = b[i * 4 + 2]; o[i * 4 + 3] = b[i * 4 + 3]; continue; }
        let shade = 1;
        const x = i % t.w, y = (i / t.w) | 0;
        if (prm.impasto > 0) {
          // relief from the pigment "height" (central differences over 2px)
          const mAt = (dx: number, dy: number) => { const xx = x + dx, yy = y + dy; return xx >= 0 && yy >= 0 && xx < t.w && yy < t.h ? P[(yy * t.w + xx) * 4 + 3] : m; };
          const gx = (mAt(-2, 0) - mAt(2, 0)) * 2.2, gy = (mAt(0, -2) - mAt(0, 2)) * 2.2;
          shade = 1 + clamp((gx * -0.6 + gy * -0.7) * prm.impasto, -0.3, 0.3);
        }
        const r = applyWet(LIN8[b[i * 4]], LIN8[b[i * 4 + 1]], LIN8[b[i * 4 + 2]], b[i * 4 + 3] / 255,
          P[i * 4], P[i * 4 + 1], P[i * 4 + 2], m, prm, this.mix, shade, 1, granulation(t.x + x, t.y + y, prm) * this.edgeBoost(t.x + x, t.y + y, m));
        o[i * 4] = toSrgb8(r[0]); o[i * 4 + 1] = toSrgb8(r[1]); o[i * 4 + 2] = toSrgb8(r[2]); o[i * 4 + 3] = Math.round(clamp(r[3]) * 255);
      }
      this.ctx.putImageData(out, t.x, t.y);
      const r: Rect = { x: t.x, y: t.y, w: t.w, h: t.h };
      rect = rect ? { x: Math.min(rect.x, r.x), y: Math.min(rect.y, r.y), w: Math.max(rect.x + rect.w, r.x + r.w) - Math.min(rect.x, r.x), h: Math.max(rect.y + rect.h, r.y + r.h) - Math.min(rect.y, r.y) } : r;
    }
    return rect;
  }

  /** Advance simulation. Returns dirty rect (or null). */
  tick(dtMs: number): Rect | null {
    if (!this.active) return null;
    this.flow(Math.min(50, dtMs));
    if (this.lifted) this.settleLeft -= dtMs;
    return this.present();
  }

  end(): void { this.lifted = true; this.settleLeft = this.prm.wetness > 0.01 && this.prm.mode === 'paint' ? this.prm.settle : 0; }

  get settled(): boolean { return this.lifted && this.settleLeft <= 0; }

  /** Finish: returns rect + pixels before the stroke, and resets. */
  commit(): { rect: Rect; before: ImageData } | null {
    this.present();
    this.active = false;
    const b = this.bbox;
    if (!b) return null;
    const before = new ImageData(b.w, b.h);
    const cur = this.ctx.getImageData(b.x, b.y, b.w, b.h);
    before.data.set(cur.data);
    for (const t of this.tiles.values()) {
      for (let y = 0; y < t.h; y++) {
        const src = t.base.data.subarray(y * t.w * 4, (y + 1) * t.w * 4);
        before.data.set(src, ((t.y - b.y + y) * b.w + (t.x - b.x)) * 4);
      }
    }
    this.tiles.clear();
    this.bbox = null;
    return { rect: b, before };
  }
}
