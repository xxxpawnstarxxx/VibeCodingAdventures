import { Emitter } from './events';
import { Layer, canvasBlendOp, ctx2d, makeCanvas, type LayerKind } from './layer';
import type { Rect } from './geom';
import { Selection } from './selection';
import type { RGB } from './color';
import { cssRgb } from './color';

export interface DocEvents extends Record<string, unknown> {
  /** Pixels of a layer changed (rect null = whole layer). Backends upload to GPU. */
  pixels: { layer: Layer; rect: Rect | null };
  /** Layer list / properties changed. */
  structure: void;
  /** Document size changed (all layers replaced). */
  resize: { dx: number; dy: number };
  active: Layer;
  selection: void;
  background: void;
}

export interface Background { color: RGB; transparent: boolean; paper: number }

export class PaintDocument {
  width: number;
  height: number;
  layers: Layer[] = [];
  activeId = 0;
  background: Background = { color: [1, 1, 1], transparent: false, paper: 0.35 };
  /** Infinite canvas: grows automatically when you paint near an edge. */
  infinite = false;
  name = 'Untitled';
  selection: Selection;
  events = new Emitter<DocEvents>();

  constructor(w: number, h: number) {
    this.width = Math.round(w);
    this.height = Math.round(h);
    this.selection = new Selection(this.width, this.height);
  }

  get active(): Layer {
    return this.layers.find((l) => l.id === this.activeId) ?? this.layers[this.layers.length - 1];
  }

  setActive(layer: Layer): void {
    this.activeId = layer.id;
    this.events.emit('active', layer);
    this.events.emit('structure', undefined);
  }

  getLayer(id: number): Layer | undefined { return this.layers.find((l) => l.id === id); }
  indexOf(layer: Layer): number { return this.layers.indexOf(layer); }

  createLayer(name?: string, kind: LayerKind = 'paint'): Layer {
    return new Layer(name ?? Layer.nextName(this.layers), this.width, this.height, kind);
  }

  /** Insert at index (default: above active). Does not record history - see ops.ts. */
  insertLayer(layer: Layer, index?: number): void {
    const i = index ?? (this.layers.length ? this.indexOf(this.active) + 1 : 0);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, i)), 0, layer);
    this.activeId = layer.id;
    this.events.emit('pixels', { layer, rect: null });
    this.events.emit('structure', undefined);
    this.events.emit('active', layer);
  }

  removeLayer(layer: Layer): number {
    const i = this.indexOf(layer);
    if (i < 0) return -1;
    this.layers.splice(i, 1);
    if (this.activeId === layer.id && this.layers.length) this.activeId = this.layers[Math.max(0, i - 1)].id;
    this.events.emit('structure', undefined);
    this.events.emit('active', this.active);
    return i;
  }

  moveLayer(layer: Layer, to: number): void {
    const i = this.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, to)), 0, layer);
    this.events.emit('structure', undefined);
  }

  markDirty(layer: Layer, rect: Rect | null = null): void {
    layer.version++;
    this.events.emit('pixels', { layer, rect });
  }

  /** Composite visible layers into a canvas (CPU). */
  flatten(opts: { background?: boolean; scale?: number; layers?: Layer[]; region?: Rect } = {}): HTMLCanvasElement {
    const scale = opts.scale ?? 1;
    const reg = opts.region ?? { x: 0, y: 0, w: this.width, h: this.height };
    const out = makeCanvas(reg.w * scale, reg.h * scale);
    const c = ctx2d(out);
    c.imageSmoothingQuality = 'high';
    if (opts.background ?? !this.background.transparent) {
      c.fillStyle = cssRgb(this.background.color);
      c.fillRect(0, 0, out.width, out.height);
    }
    for (const l of opts.layers ?? this.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      c.globalAlpha = l.opacity;
      c.globalCompositeOperation = canvasBlendOp(l.blend);
      c.drawImage(l.canvas, reg.x, reg.y, reg.w, reg.h, 0, 0, out.width, out.height);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    return out;
  }

  /**
   * Change canvas size. Content is offset by (dx, dy). Layers get fresh canvases.
   * Returns the old canvases so callers can record undo.
   */
  resizeCanvas(w: number, h: number, dx: number, dy: number, scaleContent = false): void {
    const ow = this.width, oh = this.height;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const remap = (src: HTMLCanvasElement) => {
      const c = makeCanvas(w, h);
      const x = ctx2d(c);
      x.imageSmoothingQuality = 'high';
      if (scaleContent) x.drawImage(src, 0, 0, ow, oh, 0, 0, w, h);
      else x.drawImage(src, dx, dy);
      return c;
    };
    for (const l of this.layers) {
      l.canvas = remap(l.canvas);
      if (l.source) l.source = remap(l.source);
      if (l.frames) for (const [k, f] of l.frames) l.frames.set(k, remap(f));
      if (l.frames) l.canvas = l.frames.get(l.currentFrame) ?? l.canvas;
      l.version++;
    }
    this.width = w; this.height = h;
    this.selection = new Selection(w, h);
    this.events.emit('resize', { dx: scaleContent ? 0 : dx, dy: scaleContent ? 0 : dy });
    this.events.emit('selection', undefined);
    this.events.emit('structure', undefined);
  }
}
