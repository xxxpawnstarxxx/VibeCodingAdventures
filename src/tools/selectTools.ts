// Selection tools: box/ellipse, lasso (freehand + polygon) and magic wand.
import { app } from '../app/app';
import type { ToolEvent, Viewport } from '../app/viewport';
import { changeSelection } from '../app/ops';
import type { Pt } from '../core/geom';
import { rectFromPoints } from '../core/geom';
import type { SelectMode } from '../core/selection';
import { h } from '../ui/dom';
import { segmented, slider, toggle } from '../ui/controls';
import type { Tool } from './tool';
import { ctx2d } from '../core/layer';

export const selOpts = { mode: 'replace' as SelectMode, shape: 'rect' as 'rect' | 'ellipse', feather: 0, lasso: 'free' as 'free' | 'polygon', tolerance: 32, contiguous: true, allLayers: true };

function modeFor(e: ToolEvent): SelectMode {
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  return selOpts.mode;
}

const modeNames: Record<SelectMode, string> = { replace: 'Select', add: 'Add to selection', subtract: 'Subtract from selection', intersect: 'Intersect selection' };

function modeControl() {
  return segmented(selOpts.mode, [
    { value: 'replace', label: 'New', tip: 'Start a new selection each time.' },
    { value: 'add', label: 'Add', tip: 'Add to the existing selection. (Hold Shift)', key: 'Shift' },
    { value: 'subtract', label: 'Subtract', tip: 'Remove from the existing selection. (Hold Alt)', key: 'Alt' },
    { value: 'intersect', label: 'Intersect', tip: 'Keep only the overlap. (Hold Shift+Alt)', key: 'Shift+Alt' },
  ], (v) => (selOpts.mode = v));
}

function featherControl() {
  return slider({ label: 'Feather', min: 0, max: 100, step: 1, unit: 'px', value: selOpts.feather, compact: true, onInput: (v) => (selOpts.feather = v), tip: 'Softens the selection edge so painting and effects fade out smoothly.' });
}

function selectHint() { return ' · Shift: add · Alt: subtract · Ctrl+D: deselect · Ctrl+Shift+I: invert'; }

// ---------------------------------------------------------------------------------------- box
let box: { a: Pt; b: Pt; mode: SelectMode; shift: boolean } | null = null;

function boxRect(): { x: number; y: number; w: number; h: number } {
  const b = box!;
  let r = rectFromPoints(b.a, b.b);
  if (b.shift && selOpts.mode === 'replace') { const m = Math.max(r.w, r.h); r = { x: b.b.x < b.a.x ? b.a.x - m : b.a.x, y: b.b.y < b.a.y ? b.a.y - m : b.a.y, w: m, h: m }; }
  return r;
}

export const selectTool: Tool = {
  id: 'select', name: 'Select', icon: 'selectRect', key: 'M',
  desc: 'Select a rectangle or ellipse. Painting, fills, effects and moves then only affect the selected area.',
  hint: 'Drag to select · Click to deselect' + selectHint(),
  cursor: 'crosshair',
  down(e) { box = { a: { x: e.x, y: e.y }, b: { x: e.x, y: e.y }, mode: modeFor(e), shift: false }; },
  move(e) { if (box) { box.b = { x: e.x, y: e.y }; box.shift = e.shift; app.view.requestOverlay(); } },
  up() {
    const b = box; box = null;
    if (!b) return;
    const r = rectFromPoints(b.a, b.b);
    if (r.w < 2 && r.h < 2) { if (b.mode === 'replace' && app.doc.selection.active) changeSelection((s) => s.clear(), 'Deselect'); return; }
    box = b;
    const rr = boxRect();
    box = null;
    changeSelection((s) => s.applyShape({ type: selOpts.shape, rect: rr }, b.mode, selOpts.feather), modeNames[b.mode]);
    app.view.requestOverlay();
  },
  cancel() { box = null; },
  drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport) {
    if (!box) return;
    const r = boxRect();
    vp.docTransform(ctx);
    const px = 1 / vp.view.zoom;
    ctx.beginPath();
    if (selOpts.shape === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = 'rgba(80,150,255,0.12)'; ctx.fill();
    ctx.lineWidth = px; ctx.setLineDash([4 * px, 4 * px]); ctx.strokeStyle = '#fff'; ctx.stroke();
    vp.screenTransform(ctx);
    const s = vp.toScreen(box.b.x, box.b.y);
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(s.x + 12, s.y + 12, 92, 20);
    ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.fillText(`${Math.round(r.w)} × ${Math.round(r.h)} px`, s.x + 18, s.y + 26);
  },
  options() {
    return h('div', { class: 'opts' },
      segmented(selOpts.shape, [{ value: 'rect', label: 'Rectangle', icon: 'rect', tip: 'Rectangular selection. Shift = square.' }, { value: 'ellipse', label: 'Ellipse', icon: 'ellipse', tip: 'Oval selection. Shift = circle.' }], (v) => (selOpts.shape = v)),
      modeControl(), featherControl());
  },
};

// ---------------------------------------------------------------------------------------- lasso
let lasso: { pts: Pt[]; mode: SelectMode } | null = null;
let polyHover: Pt | null = null;

function finishLasso(): void {
  const l = lasso; lasso = null; polyHover = null;
  if (!l || l.pts.length < 3) { app.view.requestOverlay(); return; }
  changeSelection((s) => s.applyShape({ type: 'polygon', points: l.pts }, l.mode, selOpts.feather), modeNames[l.mode]);
  app.view.requestOverlay();
}

export const lassoTool: Tool = {
  id: 'lasso', name: 'Lasso', icon: 'lasso', key: 'L',
  desc: 'Draw around any shape to select it freehand, or click point-by-point for straight-edged (polygon) selections.',
  hint: 'Freehand: drag around an area · Polygon: click points, click the first point or double-click / Enter to close' + selectHint(),
  cursor: 'crosshair',
  down(e) {
    const p = { x: e.x, y: e.y };
    if (selOpts.lasso === 'polygon') {
      if (!lasso) { lasso = { pts: [p], mode: modeFor(e) }; return; }
      const first = app.view.toScreen(lasso.pts[0].x, lasso.pts[0].y);
      if (Math.hypot(first.x - e.sx, first.y - e.sy) < 10 && lasso.pts.length > 2) { finishLasso(); return; }
      lasso.pts.push(p);
      app.view.requestOverlay();
      return;
    }
    lasso = { pts: [p], mode: modeFor(e) };
  },
  move(e) {
    if (lasso && selOpts.lasso === 'free') { for (const s of e.samples) lasso.pts.push({ x: s.x, y: s.y }); app.view.requestOverlay(); }
  },
  hover(e) { if (lasso && selOpts.lasso === 'polygon') { polyHover = { x: e.x, y: e.y }; app.view.requestOverlay(); } },
  up() { if (selOpts.lasso === 'free') finishLasso(); },
  cancel() { lasso = null; },
  key_(e) {
    if (!lasso) return false;
    if (e.key === 'Enter') { finishLasso(); return true; }
    if (e.key === 'Escape') { lasso = null; app.view.requestOverlay(); return true; }
    if (e.key === 'Backspace') { lasso.pts.pop(); if (!lasso.pts.length) lasso = null; app.view.requestOverlay(); return true; }
    return false;
  },
  drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport) {
    if (!lasso) return;
    vp.docTransform(ctx);
    const px = 1 / vp.view.zoom;
    ctx.beginPath();
    lasso.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (polyHover) ctx.lineTo(polyHover.x, polyHover.y);
    ctx.fillStyle = 'rgba(80,150,255,0.1)'; ctx.fill();
    ctx.lineWidth = 1.5 * px; ctx.strokeStyle = '#fff'; ctx.setLineDash([4 * px, 4 * px]); ctx.stroke();
    ctx.setLineDash([]);
    if (selOpts.lasso === 'polygon') for (const p of lasso.pts) { ctx.fillStyle = '#4b8bff'; ctx.fillRect(p.x - 3 * px, p.y - 3 * px, 6 * px, 6 * px); }
  },
  options() {
    return h('div', { class: 'opts' },
      segmented(selOpts.lasso, [{ value: 'free', label: 'Freehand', icon: 'lasso', tip: 'Drag around the area like drawing with a pencil.' }, { value: 'polygon', label: 'Polygon', icon: 'polygon', tip: 'Click corner points for straight edges. Click the first point or press Enter to finish.' }], (v) => { selOpts.lasso = v; lasso = null; }),
      modeControl(), featherControl());
  },
};

// ---------------------------------------------------------------------------------------- wand
export const wandTool: Tool = {
  id: 'wand', name: 'Magic wand', icon: 'wand', key: 'W',
  desc: 'Click an area to automatically select everything of a similar colour - e.g. a background or a flat-coloured shape.',
  hint: 'Click an area to select similar colours' + selectHint(),
  cursor: 'crosshair',
  async down(e) {
    const doc = app.doc;
    if (e.x < 0 || e.y < 0 || e.x >= doc.width || e.y >= doc.height) return;
    await app.backend.flush();
    const src = selOpts.allLayers ? doc.flatten({ background: false }) : doc.active.canvas;
    const img = ctx2d(src).getImageData(0, 0, doc.width, doc.height);
    const mode = modeFor(e);
    changeSelection((s) => { s.applyWand(img, e.x, e.y, selOpts.tolerance, selOpts.contiguous, mode); if (selOpts.feather) s.feather(selOpts.feather); }, 'Magic wand');
  },
  options() {
    return h('div', { class: 'opts' },
      slider({ label: 'Tolerance', min: 0, max: 255, step: 1, value: selOpts.tolerance, compact: true, onInput: (v) => (selOpts.tolerance = v), tip: 'How similar colours must be to get selected. Higher = more gets selected.' }),
      toggle('Only connected area', selOpts.contiguous, (v) => (selOpts.contiguous = v), 'On: select only the touching area. Off: select that colour everywhere.'),
      toggle('All layers', selOpts.allLayers, (v) => (selOpts.allLayers = v), 'Look at the whole picture instead of just the current layer.'),
      modeControl(), featherControl());
  },
};
