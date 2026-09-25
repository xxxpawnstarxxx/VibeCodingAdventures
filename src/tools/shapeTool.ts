// Geometric shapes: line, rectangle, ellipse, polygon, star, arrow. Crisp vector fill/outline, or
// outline painted with the current liquid brush for a hand-made look.
import { app } from '../app/app';
import type { ToolEvent, Viewport } from '../app/viewport';
import { editPixels } from '../app/ops';
import type { Pt } from '../core/geom';
import { cssRgb } from '../core/color';
import { h } from '../ui/dom';
import { segmented, select, slider, toggle } from '../ui/controls';
import type { Tool } from './tool';
import { StrokeBuilder } from '../engine/stroke';
import { tipIndex } from '../engine/types';

export type ShapeKind = 'line' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'arrow';
export const shapeOpts = { kind: 'rect' as ShapeKind, style: 'fill' as 'fill' | 'outline' | 'both', width: 6, radius: 0, sides: 6, brushOutline: false };

let drag: { a: Pt; b: Pt; shift: boolean; alt: boolean } | null = null;

/** Build a closed/open path of points for a shape in the box a→b. */
export function shapePath(kind: ShapeKind, a: Pt, b: Pt, shift: boolean, alt: boolean): { path: Path2D; pts: Pt[]; closed: boolean } {
  let x0 = a.x, y0 = a.y, x1 = b.x, y1 = b.y;
  if (kind === 'line' || kind === 'arrow') {
    if (shift) {
      const an = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 12)) * (Math.PI / 12), L = Math.hypot(x1 - x0, y1 - y0);
      x1 = x0 + Math.cos(an) * L; y1 = y0 + Math.sin(an) * L;
    }
    const p = new Path2D();
    const pts: Pt[] = [{ x: x0, y: y0 }, { x: x1, y: y1 }];
    p.moveTo(x0, y0); p.lineTo(x1, y1);
    if (kind === 'arrow') {
      const an = Math.atan2(y1 - y0, x1 - x0), s = Math.max(12, shapeOpts.width * 4);
      const l = { x: x1 - Math.cos(an - 0.45) * s, y: y1 - Math.sin(an - 0.45) * s }, r = { x: x1 - Math.cos(an + 0.45) * s, y: y1 - Math.sin(an + 0.45) * s };
      p.moveTo(l.x, l.y); p.lineTo(x1, y1); p.lineTo(r.x, r.y);
      pts.push(l, { x: x1, y: y1 }, r);
    }
    return { path: p, pts, closed: false };
  }
  let w = x1 - x0, hh = y1 - y0;
  if (shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
  if (alt) { x0 -= w; y0 -= hh; w *= 2; hh *= 2; }
  const rx = Math.min(x0, x0 + w), ry = Math.min(y0, y0 + hh), rw = Math.abs(w), rh = Math.abs(hh);
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const pts: Pt[] = [];
  if (kind === 'rect') {
    const r = Math.min(shapeOpts.radius, rw / 2, rh / 2);
    if (r > 0) {
      const seg = 8;
      const corner = (ccx: number, ccy: number, a0: number) => { for (let i = 0; i <= seg; i++) { const an = a0 + (i / seg) * (Math.PI / 2); pts.push({ x: ccx + Math.cos(an) * r, y: ccy + Math.sin(an) * r }); } };
      corner(rx + rw - r, ry + r, -Math.PI / 2); corner(rx + rw - r, ry + rh - r, 0); corner(rx + r, ry + rh - r, Math.PI / 2); corner(rx + r, ry + r, Math.PI);
    } else pts.push({ x: rx, y: ry }, { x: rx + rw, y: ry }, { x: rx + rw, y: ry + rh }, { x: rx, y: ry + rh });
  } else if (kind === 'ellipse') {
    const n = Math.max(32, Math.round((rw + rh) / 4));
    for (let i = 0; i < n; i++) { const an = (i / n) * Math.PI * 2; pts.push({ x: cx + Math.cos(an) * rw / 2, y: cy + Math.sin(an) * rh / 2 }); }
  } else {
    const n = Math.max(3, shapeOpts.sides);
    const k = kind === 'star' ? n * 2 : n;
    for (let i = 0; i < k; i++) {
      const an = -Math.PI / 2 + (i / k) * Math.PI * 2;
      const rr = kind === 'star' && i % 2 ? 0.45 : 1;
      pts.push({ x: cx + Math.cos(an) * rw / 2 * rr, y: cy + Math.sin(an) * rh / 2 * rr });
    }
  }
  const p = new Path2D();
  pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
  p.closePath();
  return { path: p, pts, closed: true };
}

export async function commitShape(kind: ShapeKind, a: Pt, b: Pt, shift = false, alt = false): Promise<void> {
  const { path, pts, closed } = shapePath(kind, a, b, shift, alt);
  const doc = app.doc;
  const wantFill = closed && shapeOpts.style !== 'outline';
  const wantLine = !closed || shapeOpts.style !== 'fill';
  const brush = shapeOpts.brushOutline && wantLine;
  if (wantFill || (wantLine && !brush)) {
    await editPixels(doc.active, null, `Draw ${kind}`, 'shapes', (ctx) => {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (wantFill) { ctx.fillStyle = cssRgb(app.color); ctx.fill(path); }
      if (wantLine && !brush) { ctx.strokeStyle = cssRgb(shapeOpts.style === 'both' ? app.color2 : app.color); ctx.lineWidth = shapeOpts.width; ctx.stroke(path); }
    });
  }
  if (brush) await brushAlongPath(closed ? [...pts, pts[0]] : pts);
}

/** Paint a polyline with the current brush through the liquid engine. */
export async function brushAlongPath(pts: Pt[], pressure = 1): Promise<void> {
  const layer = app.doc.active;
  if (!layer.editable || pts.length < 2) return;
  const b = app.brush;
  const sb = new StrokeBuilder({
    brush: b, color: shapeOpts.style === 'both' ? app.color2 : app.color, color2: app.color2,
    stabilizer: { mode: 'off', strength: 0, predictive: false, catchUp: false }, symmetry: { ...app.settings.symmetry, mode: 'off' },
    guides: { ...app.settings.guides, enabled: false }, zoom: 1, isPen: false, pressureGamma: 1,
  });
  app.backend.beginStroke(layer, {
    mode: b.mode, opacity: b.opacity, wetness: b.wetness, viscosity: b.viscosity, pickup: b.pickup, load: b.load, transparency: b.transparency,
    wetEdge: b.wetEdge, impasto: b.impasto, grain: b.grain, grainScale: b.grainScale, bristles: b.bristles, tip: tipIndex(b.tip), settle: b.settle,
    spectral: app.settings.spectral, alphaLock: layer.alphaLock, seed: (Math.random() * 1e9) | 0,
  }, app.doc.selection.mask, `${b.name} shape`);
  let t = performance.now();
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 3));
    for (let k = 0; k < n; k++) {
      const u = k / n;
      app.backend.addDabs(sb.push({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, p: pressure, tiltX: 0, tiltY: 0, t: (t += 4) }));
    }
  }
  const last = pts[pts.length - 1];
  app.backend.addDabs(sb.push({ x: last.x, y: last.y, p: pressure, tiltX: 0, tiltY: 0, t: t + 4 }));
  app.backend.endStroke();
  await app.backend.flush();
}

export const shapeTool: Tool = {
  id: 'shapes', name: 'Shapes', icon: 'shapes', key: 'U',
  desc: 'Draw lines, rectangles, circles, polygons, stars and arrows. Outline can be painted with your current brush for a hand-made look.',
  hint: 'Drag to draw · Shift: perfect square/circle or 15° angles · Alt: draw from centre',
  cursor: 'crosshair',
  down(e: ToolEvent) { drag = { a: { x: e.x, y: e.y }, b: { x: e.x, y: e.y }, shift: e.shift, alt: e.alt }; },
  move(e: ToolEvent) { if (drag) { drag.b = { x: e.x, y: e.y }; drag.shift = e.shift; drag.alt = e.alt; app.view.requestOverlay(); } },
  up() {
    const d = drag; drag = null;
    if (d && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 1) void commitShape(shapeOpts.kind, d.a, d.b, d.shift, d.alt);
    app.view.requestOverlay();
  },
  cancel() { drag = null; },
  drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport) {
    if (!drag) return;
    const { path, closed } = shapePath(shapeOpts.kind, drag.a, drag.b, drag.shift, drag.alt);
    vp.docTransform(ctx);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (closed && shapeOpts.style !== 'outline') { ctx.globalAlpha = 0.6; ctx.fillStyle = cssRgb(app.color); ctx.fill(path); ctx.globalAlpha = 1; }
    if (!closed || shapeOpts.style !== 'fill') {
      ctx.strokeStyle = cssRgb(shapeOpts.style === 'both' ? app.color2 : app.color);
      ctx.lineWidth = shapeOpts.brushOutline ? app.brush.size : shapeOpts.width;
      ctx.globalAlpha = 0.7; ctx.stroke(path); ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1 / vp.view.zoom; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.setLineDash([4 / vp.view.zoom, 4 / vp.view.zoom]); ctx.stroke(path);
  },
  options() {
    return h('div', { class: 'opts' },
      segmented(shapeOpts.kind, [
        { value: 'line', label: 'Line', icon: 'line', tip: 'Straight line.' },
        { value: 'arrow', label: 'Arrow', icon: 'arrow', tip: 'Line with an arrow head.' },
        { value: 'rect', label: 'Rectangle', icon: 'rect', tip: 'Rectangle or square (Shift). Set corner rounding below.' },
        { value: 'ellipse', label: 'Ellipse', icon: 'ellipse', tip: 'Oval or circle (Shift).' },
        { value: 'polygon', label: 'Polygon', icon: 'polygon', tip: 'Regular polygon - set the number of sides.' },
        { value: 'star', label: 'Star', icon: 'star', tip: 'Star - set the number of points.' },
      ], (v) => (shapeOpts.kind = v), 'shape-kinds'),
      select('Style', shapeOpts.style, [{ value: 'fill', label: 'Filled' }, { value: 'outline', label: 'Outline' }, { value: 'both', label: 'Fill + outline' }], (v) => (shapeOpts.style = v), 'Filled uses the main colour. Outline uses the main colour; with Fill + outline, the outline uses the second colour.'),
      slider({ label: 'Line width', min: 1, max: 200, step: 1, unit: 'px', value: shapeOpts.width, compact: true, curve: 2, onInput: (v) => (shapeOpts.width = v), tip: 'Thickness of outlines and lines.' }),
      slider({ label: 'Corners', min: 0, max: 300, step: 1, unit: 'px', value: shapeOpts.radius, compact: true, curve: 2, onInput: (v) => (shapeOpts.radius = v), tip: 'Rounded corner radius for rectangles.' }),
      slider({ label: 'Sides / points', min: 3, max: 24, step: 1, unit: '', value: shapeOpts.sides, compact: true, onInput: (v) => (shapeOpts.sides = v), tip: 'Number of sides for polygons, or points for stars.' }),
      toggle('Paint outline with brush', shapeOpts.brushOutline, (v) => (shapeOpts.brushOutline = v), 'Draw the outline using your current liquid brush (its size, texture and wetness) instead of a perfect vector line.'),
    );
  },
};
