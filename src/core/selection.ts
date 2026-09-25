import type { Pt, Rect } from './geom';
import { ctx2d, makeCanvas } from './layer';
import { blurMaskInPlace, floodFillMask } from '../wasm/wasm';

export type SelectMode = 'replace' | 'add' | 'subtract' | 'intersect';

export type SelectShape =
  | { type: 'rect'; rect: Rect }
  | { type: 'ellipse'; rect: Rect }
  | { type: 'polygon'; points: Pt[] };

/**
 * A soft (0..255) selection mask the size of the document. `mask === null` means "nothing selected"
 * which tools treat as "everything is editable".
 */
export class Selection {
  mask: Uint8Array | null = null;
  bounds: Rect | null = null;
  private _outline: Path2D | null = null;
  private _maskCanvas: HTMLCanvasElement | null = null;
  constructor(public width: number, public height: number) {}

  get active(): boolean { return !!this.mask; }

  clone(): Selection {
    const s = new Selection(this.width, this.height);
    s.mask = this.mask ? this.mask.slice() : null;
    s.bounds = this.bounds ? { ...this.bounds } : null;
    return s;
  }

  clear(): void { this.mask = null; this.bounds = null; this.invalidate(); }

  selectAll(): void {
    this.mask = new Uint8Array(this.width * this.height).fill(255);
    this.recomputeBounds();
  }

  /** Rasterize a shape with antialiasing and combine with the current selection. */
  applyShape(shape: SelectShape, mode: SelectMode, feather = 0): void {
    const c = makeCanvas(this.width, this.height);
    const x = ctx2d(c);
    x.fillStyle = '#fff';
    x.beginPath();
    if (shape.type === 'rect') x.rect(shape.rect.x, shape.rect.y, shape.rect.w, shape.rect.h);
    else if (shape.type === 'ellipse') {
      const r = shape.rect;
      x.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.5, r.w / 2), Math.max(0.5, r.h / 2), 0, 0, Math.PI * 2);
    } else {
      shape.points.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
      x.closePath();
    }
    x.fill();
    const d = x.getImageData(0, 0, this.width, this.height).data;
    const m = new Uint8Array(this.width * this.height);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3];
    if (feather > 0) blurMaskInPlace(m, this.width, this.height, feather);
    this.combine(m, mode);
  }

  /** Magic wand from an image (usually the active layer or the flattened image). */
  applyWand(img: ImageData, x: number, y: number, tolerance: number, contiguous: boolean, mode: SelectMode): void {
    const m = floodFillMask(img, x, y, tolerance, contiguous);
    this.combine(m, mode);
  }

  /** Use a layer's alpha channel as the selection. */
  fromAlpha(img: ImageData, mode: SelectMode = 'replace'): void {
    const m = new Uint8Array(this.width * this.height);
    for (let i = 0; i < m.length; i++) m[i] = img.data[i * 4 + 3];
    this.combine(m, mode);
  }

  combine(m: Uint8Array, mode: SelectMode): void {
    const cur = this.mask;
    if (mode === 'replace' || !cur) {
      if (mode === 'subtract') { this.recomputeBounds(); return; }
      if (mode === 'intersect' && !cur) { this.mask = m; }
      else this.mask = m;
    } else {
      for (let i = 0; i < m.length; i++) {
        const a = cur[i], b = m[i];
        if (mode === 'add') cur[i] = a > b ? a : b;
        else if (mode === 'subtract') cur[i] = (a * (255 - b)) / 255;
        else cur[i] = (a * b) / 255;
      }
    }
    this.recomputeBounds();
  }

  invert(): void {
    if (!this.mask) { this.selectAll(); return; }
    for (let i = 0; i < this.mask.length; i++) this.mask[i] = 255 - this.mask[i];
    this.recomputeBounds();
  }

  feather(radius: number): void {
    if (!this.mask) return;
    blurMaskInPlace(this.mask, this.width, this.height, radius);
    this.recomputeBounds();
  }

  /** Grow (positive) or shrink (negative) the selection by roughly `px` pixels. */
  growShrink(px: number): void {
    if (!this.mask || px === 0) return;
    const m = this.mask;
    blurMaskInPlace(m, this.width, this.height, Math.abs(px));
    const t = px > 0 ? 8 : 247;
    for (let i = 0; i < m.length; i++) m[i] = m[i] > t ? 255 : 0;
    this.recomputeBounds();
  }

  recomputeBounds(): void {
    const m = this.mask;
    this.invalidate();
    if (!m) { this.bounds = null; return; }
    let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
    for (let y = 0; y < this.height; y++) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (m[row + x] > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    if (x1 < 0) { this.mask = null; this.bounds = null; return; }
    this.bounds = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  invalidate(): void { this._outline = null; this._maskCanvas = null; }

  valueAt(x: number, y: number): number {
    if (!this.mask) return 255;
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask[y * this.width + x];
  }

  /** Canvas whose alpha = selection. Use with 'destination-in' to clip. */
  get maskCanvas(): HTMLCanvasElement | null {
    if (!this.mask) return null;
    if (this._maskCanvas) return this._maskCanvas;
    const c = makeCanvas(this.width, this.height);
    const x = ctx2d(c);
    const img = x.createImageData(this.width, this.height);
    for (let i = 0; i < this.mask.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = this.mask[i];
    }
    x.putImageData(img, 0, 0);
    this._maskCanvas = c;
    return c;
  }

  /** Pixel-edge outline (for marching ants), in document coordinates. */
  get outline(): Path2D | null {
    if (!this.mask || !this.bounds) return null;
    if (this._outline) return this._outline;
    const { width: w, height: h } = this;
    const m = this.mask;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] >= 128;
    const p = new Path2D();
    const b = this.bounds;
    // horizontal edges, merged into runs
    for (let y = b.y; y <= b.y + b.h; y++) {
      let run = -1;
      for (let x = b.x; x <= b.x + b.w; x++) {
        const edge = x < b.x + b.w && inside(x, y) !== inside(x, y - 1);
        if (edge && run < 0) run = x;
        if (!edge && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; }
      }
    }
    for (let x = b.x; x <= b.x + b.w; x++) {
      let run = -1;
      for (let y = b.y; y <= b.y + b.h; y++) {
        const edge = y < b.y + b.h && inside(x, y) !== inside(x - 1, y);
        if (edge && run < 0) run = y;
        if (!edge && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; }
      }
    }
    this._outline = p;
    return p;
  }
}
