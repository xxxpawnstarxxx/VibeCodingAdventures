// Shared Canvas2D helpers for drawing the document to the screen (used by the fallback backend).
import type { PaintDocument } from '../core/document';
import { canvasBlendOp, ctx2d, makeCanvas } from '../core/layer';
import { cssRgb } from '../core/color';
import type { Rect } from '../core/geom';
import { paper } from './paintModel';
import type { RenderOptions } from './types';

let paperTile: HTMLCanvasElement | null = null;
/** A seamless-ish paper texture tile (subtle), multiplied over the background. */
export function getPaperTile(): HTMLCanvasElement {
  if (paperTile) return paperTile;
  const S = 256;
  const c = makeCanvas(S, S);
  const x = ctx2d(c);
  const img = x.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let i = 0; i < S; i++) {
    // wrap by blending opposite edges
    const n = paper(i, y, 1.3);
    const v = Math.round(255 - (1 - n) * 60);
    const o = (y * S + i) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  paperTile = c;
  return c;
}

let checker: CanvasPattern | null = null;
export function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  if (checker) return checker;
  const c = makeCanvas(16, 16);
  const x = ctx2d(c);
  x.fillStyle = '#cfcfd4'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#f4f4f6'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  checker = ctx.createPattern(c, 'repeat')!;
  return checker;
}

/** Composite (a region of) the document into ctx at 1:1 document coordinates. */
export function compositeRegion(doc: PaintDocument, ctx: CanvasRenderingContext2D, r: Rect, showPaper: boolean, exclude?: Set<number>): void {
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.clearRect(r.x, r.y, r.w, r.h);
  if (!doc.background.transparent) {
    ctx.fillStyle = cssRgb(doc.background.color);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (showPaper && doc.background.paper > 0) {
      ctx.globalAlpha = doc.background.paper;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = ctx.createPattern(getPaperTile(), 'repeat')!;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  for (const l of doc.layers) {
    if (!l.visible || l.opacity <= 0 || exclude?.has(l.id)) continue;
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = canvasBlendOp(l.blend);
    ctx.drawImage(l.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  }
  ctx.restore();
}

/** Set a CSS-pixel view transform (pan/zoom/rotate) on a context sized in device pixels. */
export function applyView(ctx: CanvasRenderingContext2D, o: RenderOptions): void {
  const { view, dpr } = o;
  const c = Math.cos(view.rotation) * view.zoom * dpr, s = Math.sin(view.rotation) * view.zoom * dpr;
  ctx.setTransform(c, s, -s, c, view.x * dpr, view.y * dpr);
}
