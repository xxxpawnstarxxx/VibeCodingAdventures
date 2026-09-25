// Fallback backend: CPU liquid paint + Canvas2D compositing. Used when WebGPU is unavailable.
import type { PaintDocument } from '../core/document';
import type { Layer } from '../core/layer';
import { ctx2d, makeCanvas } from '../core/layer';
import type { Rect } from '../core/geom';
import { rectUnion } from '../core/geom';
import { CpuWetPainter } from './cpuPainter';
import { applyView, checkerPattern, compositeRegion } from './compositor2d';
import type { CommitInfo, Dab, PaintBackend, RenderOptions, StrokeParams } from './types';
import type { TipImage } from './paintModel';

export class CanvasBackend implements PaintBackend {
  readonly kind = 'canvas2d' as const;
  readonly label = 'Canvas 2D (CPU)';
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private doc!: PaintDocument;
  private comp!: HTMLCanvasElement;
  private compCtx!: CanvasRenderingContext2D;
  private compDirty: Rect | null = null;
  private painter: CpuWetPainter | null = null;
  private strokeLayer: Layer | null = null;
  private label_ = '';
  private lastTick = 0;
  private tip: TipImage | null = null;
  onCommit: (c: CommitInfo) => void = () => {};
  onChange: () => void = () => {};

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'paint-surface';
    this.ctx = this.canvas.getContext('2d')!;
  }

  setDocument(doc: PaintDocument): void {
    this.doc = doc;
    const all = () => { this.compDirty = { x: 0, y: 0, w: doc.width, h: doc.height }; this.onChange(); };
    this.allocComp();
    doc.events.on('pixels', ({ rect }) => { this.compDirty = rectUnion(this.compDirty, rect ?? { x: 0, y: 0, w: doc.width, h: doc.height }); this.onChange(); });
    doc.events.on('structure', all);
    doc.events.on('background', all);
    doc.events.on('resize', () => { this.allocComp(); all(); });
    all();
  }

  private allocComp() {
    this.comp = makeCanvas(this.doc.width, this.doc.height);
    this.compCtx = ctx2d(this.comp);
  }

  get stroking() { return !!this.painter?.active; }
  get animating() { return !!this.painter?.active; }

  setTipImage(img: ImageData | null): void {
    if (!img) { this.tip = null; return; }
    const data = new Float32Array(img.width * img.height);
    for (let i = 0; i < data.length; i++) data[i] = (img.data[i * 4 + 3] / 255) * (1 - (img.data[i * 4] / 255) * 0);
    this.tip = { w: img.width, h: img.height, data };
  }

  beginStroke(layer: Layer, params: StrokeParams, selection: Uint8Array | null, label: string): void {
    if (this.painter?.active) this.finishStroke();
    this.painter = new CpuWetPainter(layer.canvas);
    this.painter.setTip(this.tip);
    this.painter.begin(params, selection);
    this.strokeLayer = layer;
    this.label_ = label;
    this.lastTick = performance.now();
  }

  addDabs(dabs: Dab[]): void {
    if (!this.painter?.active) return;
    this.painter.addDabs(dabs);
    this.onChange();
  }

  endStroke(): void {
    if (!this.painter?.active) return;
    this.painter.end();
    this.onChange();
  }

  private finishStroke(): void {
    const p = this.painter, layer = this.strokeLayer;
    if (!p || !layer) return;
    const r = p.commit();
    this.painter = null;
    this.strokeLayer = null;
    if (r) {
      this.doc.markDirty(layer, r.rect);
      this.onCommit({ layer, rect: r.rect, before: r.before, label: this.label_ });
    }
  }

  async flush(): Promise<void> {
    if (this.painter?.active) { this.painter.end(); this.finishStroke(); }
  }

  private step(): void {
    const p = this.painter;
    if (!p?.active || !this.strokeLayer) return;
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    const r = p.tick(dt);
    if (r) { this.strokeLayer.version++; this.compDirty = rectUnion(this.compDirty, r); }
    if (p.settled) this.finishStroke();
  }

  render(o: RenderOptions): void {
    this.step();
    const dpr = o.dpr;
    const W = Math.round(o.width * dpr), H = Math.round(o.height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    if (this.compDirty) {
      const r = this.compDirty;
      const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
      const reg = { x, y, w: Math.min(this.doc.width, Math.ceil(r.x + r.w)) - x, h: Math.min(this.doc.height, Math.ceil(r.y + r.h)) - y };
      if (reg.w > 0 && reg.h > 0) compositeRegion(this.doc, this.compCtx, reg, o.showPaper, o.exclude);
      this.compDirty = null;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    applyView(ctx, o);
    if (this.doc.background.transparent) {
      ctx.fillStyle = checkerPattern(ctx);
      ctx.fillRect(0, 0, this.doc.width, this.doc.height);
    }
    ctx.imageSmoothingEnabled = o.view.zoom < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.comp, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  destroy(): void { this.canvas.remove(); }
}
