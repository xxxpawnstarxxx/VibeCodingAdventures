// Move/transform, crop, guides, hand and zoom tools.
import { app } from '../app/app';
import type { ToolEvent, Viewport } from '../app/viewport';
import { recordPixels, resizeDocument } from '../app/ops';
import type { Pt, Rect } from '../core/geom';
import { ctx2d, makeCanvas, type Layer } from '../core/layer';
import { h } from '../ui/dom';
import { button, numberField, select, slider, toggle } from '../ui/controls';
import type { Tool } from './tool';

// ---------------------------------------------------------------------------------------- move / transform
interface Floating {
  layer: Layer; canvas: HTMLCanvasElement; before: ImageData; hadSelection: boolean;
  cx: number; cy: number; sx: number; sy: number; angle: number; w: number; h: number;
}
let fl: Floating | null = null;
let dragMode: null | 'move' | 'scale' | 'rotate' = null;
let dragStart: { p: Pt; f: Floating; corner: Pt; a0: number } | null = null;
const moveOpts = { keepRatio: true };

async function lift(): Promise<boolean> {
  if (fl) return true;
  const doc = app.doc;
  const layer = doc.active;
  if (!layer.editable) { app.toast(`"${layer.name}" is locked.`, 'error'); return false; }
  await app.backend.flush();
  const ctx = ctx2d(layer.canvas);
  const before = ctx.getImageData(0, 0, doc.width, doc.height);
  const sel = doc.selection;
  let r: Rect;
  if (sel.bounds) r = sel.bounds;
  else {
    // tight bounds of the layer content
    const d = before.data;
    let x0 = doc.width, y0 = doc.height, x1 = -1, y1 = -1;
    for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) if (d[(y * doc.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    if (x1 < 0) { app.toast('This layer is empty - nothing to move.', 'info'); return false; }
    r = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  const c = makeCanvas(r.w, r.h);
  const cc = ctx2d(c);
  cc.drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  const mask = sel.maskCanvas;
  if (mask) {
    cc.globalCompositeOperation = 'destination-in';
    cc.drawImage(mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(mask, 0, 0); ctx.restore();
  } else ctx.clearRect(r.x, r.y, r.w, r.h);
  doc.markDirty(layer, r);
  fl = { layer, canvas: c, before, hadSelection: !!mask, cx: r.x + r.w / 2, cy: r.y + r.h / 2, sx: 1, sy: 1, angle: 0, w: r.w, h: r.h };
  app.view.requestOverlay();
  return true;
}

function drawFloating(ctx: CanvasRenderingContext2D, f: Floating) {
  ctx.save();
  ctx.translate(f.cx, f.cy); ctx.rotate(f.angle); ctx.scale(f.sx, f.sy);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(f.canvas, -f.w / 2, -f.h / 2);
  ctx.restore();
}

export function commitTransform(): void {
  const f = fl; if (!f) return;
  fl = null;
  const doc = app.doc;
  const ctx = ctx2d(f.layer.canvas);
  drawFloating(ctx, f);
  doc.markDirty(f.layer, null);
  recordPixels(f.layer, { x: 0, y: 0, w: doc.width, h: doc.height }, f.before, 'Move / transform', 'move');
  if (f.hadSelection) { doc.selection.clear(); doc.events.emit('selection', undefined); }
  app.view.requestOverlay();
}

export function cancelTransform(): void {
  const f = fl; if (!f) return;
  fl = null;
  ctx2d(f.layer.canvas).putImageData(f.before, 0, 0);
  app.doc.markDirty(f.layer, null);
  app.view.requestOverlay();
}

function corners(f: Floating): Pt[] {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const x = (u * f.w * f.sx) / 2, y = (v * f.h * f.sy) / 2;
    return { x: f.cx + x * c - y * s, y: f.cy + x * s + y * c };
  });
}
function rotHandle(f: Floating): Pt {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const y = -(f.h * Math.abs(f.sy)) / 2 - 28 / app.view.view.zoom;
  return { x: f.cx - y * s, y: f.cy + y * c };
}
function inside(f: Floating, p: Pt): boolean {
  const c = Math.cos(-f.angle), s = Math.sin(-f.angle);
  const dx = p.x - f.cx, dy = p.y - f.cy;
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return Math.abs(x) <= (f.w * Math.abs(f.sx)) / 2 && Math.abs(y) <= (f.h * Math.abs(f.sy)) / 2;
}

export const moveTool: Tool = {
  id: 'move', name: 'Move', icon: 'move', key: 'V',
  desc: 'Move, resize, rotate and flip the selected area (or the whole layer if nothing is selected).',
  hint: 'Drag to move · Corner handles: resize · Round handle: rotate · Enter: apply · Esc: cancel · Arrow keys: nudge',
  cursor: 'move',
  async down(e: ToolEvent) {
    const p = { x: e.x, y: e.y };
    const hit = 10 / app.view.view.zoom;
    if (fl) {
      const rh = rotHandle(fl);
      if (Math.hypot(rh.x - p.x, rh.y - p.y) < hit) { dragMode = 'rotate'; dragStart = { p, f: { ...fl }, corner: p, a0: Math.atan2(p.y - fl.cy, p.x - fl.cx) }; return; }
      const cs = corners(fl);
      const ci = cs.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) < hit);
      if (ci >= 0) { dragMode = 'scale'; dragStart = { p, f: { ...fl }, corner: cs[(ci + 2) % 4], a0: 0 }; return; }
      if (!inside(fl, p)) { commitTransform(); return; }
    } else if (!(await lift())) return;
    dragMode = 'move';
    dragStart = { p, f: { ...fl! }, corner: p, a0: 0 };
  },
  move(e: ToolEvent) {
    if (!fl || !dragStart || !dragMode) return;
    const f0 = dragStart.f;
    if (dragMode === 'move') { fl.cx = f0.cx + e.x - dragStart.p.x; fl.cy = f0.cy + e.y - dragStart.p.y; }
    else if (dragMode === 'rotate') {
      let a = f0.angle + Math.atan2(e.y - f0.cy, e.x - f0.cx) - dragStart.a0;
      if (e.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      fl.angle = a;
    } else {
      // scale around the opposite corner
      const o = dragStart.corner;
      const c = Math.cos(-f0.angle), s = Math.sin(-f0.angle);
      const lx = (e.x - o.x) * c - (e.y - o.y) * s, ly = (e.x - o.x) * s + (e.y - o.y) * c;
      const ox = (dragStart.p.x - o.x) * c - (dragStart.p.y - o.y) * s, oy = (dragStart.p.x - o.x) * s + (dragStart.p.y - o.y) * c;
      let kx = ox ? lx / ox : 1, ky = oy ? ly / oy : 1;
      if (moveOpts.keepRatio !== e.shift) { const k = Math.abs(kx) > Math.abs(ky) ? kx : ky; kx = k; ky = k; }
      fl.sx = f0.sx * kx; fl.sy = f0.sy * ky;
      const mx = lx / 2, my = ly / 2;
      const c2 = Math.cos(f0.angle), s2 = Math.sin(f0.angle);
      fl.cx = o.x + mx * c2 - my * s2; fl.cy = o.y + mx * s2 + my * c2;
    }
    app.view.requestOverlay();
  },
  up() { dragMode = null; dragStart = null; },
  deactivate() { commitTransform(); },
  key_(e) {
    if (e.key === 'Enter' && fl) { commitTransform(); return true; }
    if (e.key === 'Escape' && fl) { cancelTransform(); return true; }
    const d = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
    if (arrows[e.key]) {
      void lift().then((ok) => { if (ok && fl) { fl.cx += arrows[e.key][0]; fl.cy += arrows[e.key][1]; app.view.requestOverlay(); } });
      return true;
    }
    return false;
  },
  drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport) {
    if (!fl) return;
    vp.docTransform(ctx);
    drawFloating(ctx, fl);
    const px = 1 / vp.view.zoom;
    const cs = corners(fl);
    ctx.beginPath(); cs.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y))); ctx.closePath();
    ctx.lineWidth = px; ctx.strokeStyle = '#4b8bff'; ctx.stroke();
    const rh = rotHandle(fl);
    const top = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const c of cs) { ctx.fillRect(c.x - 5 * px, c.y - 5 * px, 10 * px, 10 * px); ctx.strokeRect(c.x - 5 * px, c.y - 5 * px, 10 * px, 10 * px); }
    ctx.beginPath(); ctx.arc(rh.x, rh.y, 6 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  },
  options() {
    const flip = (hor: boolean) => async () => { if (await lift()) { if (hor) fl!.sx *= -1; else fl!.sy *= -1; app.view.requestOverlay(); } };
    return h('div', { class: 'opts' },
      button('Apply', { icon: 'check', primary: true, small: true, tip: { title: 'Apply transform', desc: 'Place the moved pixels.', key: 'Enter' }, onClick: () => commitTransform() }),
      button('Cancel', { icon: 'close', small: true, tip: { title: 'Cancel transform', desc: 'Put everything back where it was.', key: 'Esc' }, onClick: () => cancelTransform() }),
      button('Flip horizontal', { icon: 'flip', small: true, tip: 'Mirror left ↔ right.', onClick: flip(true) }),
      button('Flip vertical', { icon: 'flip', small: true, tip: 'Mirror top ↕ bottom.', onClick: flip(false) }),
      button('Rotate 90°', { icon: 'rotate', small: true, tip: 'Turn a quarter clockwise.', onClick: async () => { if (await lift()) { fl!.angle += Math.PI / 2; app.view.requestOverlay(); } } }),
      toggle('Keep proportions', moveOpts.keepRatio, (v) => (moveOpts.keepRatio = v), 'When resizing with corner handles, keep the width/height ratio. Hold Shift to temporarily do the opposite.'),
    );
  },
};

// ---------------------------------------------------------------------------------------- crop
let crop: Rect | null = null;
let cropDrag: { mode: 'new' | 'move' | 'edge'; start: Pt; r0: Rect; edges: { l: boolean; r: boolean; t: boolean; b: boolean } } | null = null;
const cropOpts = { aspect: 'free' };
const ASPECTS: Record<string, number> = { free: 0, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '3:2': 3 / 2, '2:3': 2 / 3, 'A4 portrait': 1 / Math.SQRT2, 'A4 landscape': Math.SQRT2 };

function normalized(r: Rect): Rect { return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) }; }
function applyAspect(r: Rect): Rect {
  const a = ASPECTS[cropOpts.aspect];
  if (!a) return r;
  const n = { ...r };
  if (Math.abs(n.w) / Math.max(1, Math.abs(n.h)) > a) n.w = Math.sign(n.w || 1) * Math.abs(n.h) * a; else n.h = Math.sign(n.h || 1) * Math.abs(n.w) / a;
  return n;
}

export async function applyCrop(r: Rect | null = crop): Promise<void> {
  if (!r) return;
  const n = normalized(r);
  const x = Math.round(n.x), y = Math.round(n.y), w = Math.max(1, Math.round(n.w)), hh = Math.max(1, Math.round(n.h));
  await resizeDocument(w, hh, -x, -y, false, 'Crop');
  crop = null;
  app.view.fit();
}

export const cropTool: Tool = {
  id: 'crop', name: 'Crop', icon: 'crop', key: 'C',
  desc: 'Trim the picture to a new frame. You can also drag outside the canvas to make it bigger.',
  hint: 'Drag edges or corners to adjust · Drag inside to move · Enter: apply · Esc: reset',
  cursor: 'crosshair',
  activate() { crop = { x: 0, y: 0, w: app.doc.width, h: app.doc.height }; app.view.requestOverlay(); },
  deactivate() { crop = null; },
  down(e) {
    const p = { x: e.x, y: e.y };
    if (crop) {
      const r = normalized(crop), t = 10 / app.view.view.zoom;
      const edges = { l: Math.abs(p.x - r.x) < t, r: Math.abs(p.x - r.x - r.w) < t, t: Math.abs(p.y - r.y) < t, b: Math.abs(p.y - r.y - r.h) < t };
      const inY = p.y > r.y - t && p.y < r.y + r.h + t, inX = p.x > r.x - t && p.x < r.x + r.w + t;
      if ((edges.l || edges.r) && inY || (edges.t || edges.b) && inX) { cropDrag = { mode: 'edge', start: p, r0: r, edges }; return; }
      if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) { cropDrag = { mode: 'move', start: p, r0: r, edges }; return; }
    }
    cropDrag = { mode: 'new', start: p, r0: { x: p.x, y: p.y, w: 0, h: 0 }, edges: { l: false, r: false, t: false, b: false } };
  },
  move(e) {
    if (!cropDrag) return;
    const d = cropDrag, dx = e.x - d.start.x, dy = e.y - d.start.y;
    if (d.mode === 'new') crop = applyAspect({ x: d.start.x, y: d.start.y, w: dx, h: dy });
    else if (d.mode === 'move') crop = { ...d.r0, x: d.r0.x + dx, y: d.r0.y + dy };
    else {
      const r = { ...d.r0 };
      if (d.edges.l) { r.x += dx; r.w -= dx; }
      if (d.edges.r) r.w += dx;
      if (d.edges.t) { r.y += dy; r.h -= dy; }
      if (d.edges.b) r.h += dy;
      crop = applyAspect(r);
    }
    app.view.requestOverlay();
  },
  up() { cropDrag = null; if (crop) crop = normalized(crop); app.events.emit('tool', 'crop'); },
  key_(e) {
    if (e.key === 'Enter') { void applyCrop(); return true; }
    if (e.key === 'Escape') { this.activate!(); return true; }
    return false;
  },
  drawOverlay(ctx, vp) {
    if (!crop) return;
    const r = normalized(crop);
    vp.docTransform(ctx);
    const px = 1 / vp.view.zoom;
    const big = 1e5;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.rect(-big, -big, big * 2, big * 2); ctx.rect(r.x, r.y + r.h, r.w, -r.h); ctx.fill('evenodd');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * px; ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = px;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) { ctx.moveTo(r.x + (r.w * i) / 3, r.y); ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h); ctx.moveTo(r.x, r.y + (r.h * i) / 3); ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3); }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2]]) ctx.fillRect(x - 4 * px, y - 4 * px, 8 * px, 8 * px);
    vp.screenTransform(ctx);
    const s = vp.toScreen(r.x + r.w / 2, r.y + r.h);
    ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(s.x - 50, s.y + 8, 100, 20);
    ctx.fillStyle = '#fff'; ctx.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}`, s.x, s.y + 22);
  },
  options() {
    return h('div', { class: 'opts' },
      select('Aspect ratio', cropOpts.aspect, Object.keys(ASPECTS).map((k) => ({ value: k, label: k === 'free' ? 'Free' : k })), (v) => { cropOpts.aspect = v; if (crop) { crop = applyAspect(crop); app.view.requestOverlay(); } }, 'Lock the crop frame to a common shape.'),
      button('Apply crop', { icon: 'check', primary: true, small: true, tip: { title: 'Apply crop', key: 'Enter', desc: 'Cut the canvas to the frame.' }, onClick: () => void applyCrop() }),
      button('Reset', { icon: 'undo', small: true, tip: { title: 'Reset frame', key: 'Esc' }, onClick: () => cropTool.activate!() }),
      button('Fit to selection', { icon: 'select', small: true, tip: 'Set the crop frame to the current selection.', onClick: () => { const b = app.doc.selection.bounds; if (b) { crop = { ...b }; app.view.requestOverlay(); } else app.toast('Nothing is selected.', 'info'); } }),
    );
  },
};

// ---------------------------------------------------------------------------------------- guides
let guideDrag: { kind: 'ruler-new' | 'ruler-a' | 'ruler-b' | 'vp'; i: number; start: Pt } | null = null;

export function setPerspective(n: 0 | 1 | 2 | 3): void {
  const d = app.doc, g = app.settings.guides;
  const hy = d.height * 0.42;
  if (n === 0) g.perspective = [];
  if (n === 1) g.perspective = [{ x: d.width / 2, y: hy }];
  if (n === 2) g.perspective = [{ x: -d.width * 0.35, y: hy }, { x: d.width * 1.35, y: hy }];
  if (n === 3) g.perspective = [{ x: -d.width * 0.35, y: hy }, { x: d.width * 1.35, y: hy }, { x: d.width / 2, y: d.height * 2.2 }];
  if (n > 0) g.enabled = true;
  app.saveSettings();
  app.view.requestOverlay();
}

export const guidesTool: Tool = {
  id: 'guides', name: 'Guides', icon: 'ruler', key: 'K',
  desc: 'Set up rulers, perspective vanishing points and a grid. When "Magnetic guides" is on, your strokes gently snap to them while still feeling hand-drawn.',
  hint: 'Drag on the canvas to add a ruler · Drag handles to move · Double-click a handle to delete it',
  cursor: 'crosshair',
  down(e) {
    const g = app.settings.guides;
    const p = { x: e.x, y: e.y }, t = 10 / app.view.view.zoom;
    const vi = g.perspective.findIndex((v) => Math.hypot(v.x - p.x, v.y - p.y) < t);
    if (vi >= 0) { guideDrag = { kind: 'vp', i: vi, start: p }; return; }
    for (let i = 0; i < g.rulers.length; i++) {
      if (Math.hypot(g.rulers[i].a.x - p.x, g.rulers[i].a.y - p.y) < t) { guideDrag = { kind: 'ruler-a', i, start: p }; return; }
      if (Math.hypot(g.rulers[i].b.x - p.x, g.rulers[i].b.y - p.y) < t) { guideDrag = { kind: 'ruler-b', i, start: p }; return; }
    }
    g.rulers.push({ a: p, b: { ...p } });
    g.enabled = true;
    guideDrag = { kind: 'ruler-new', i: g.rulers.length - 1, start: p };
  },
  move(e) {
    const g = app.settings.guides, d = guideDrag;
    if (!d) return;
    const p = { x: e.x, y: e.y };
    if (d.kind === 'vp') g.perspective[d.i] = p;
    else if (d.kind === 'ruler-a') g.rulers[d.i].a = p;
    else g.rulers[d.i].b = p;
    app.view.requestOverlay();
  },
  up() {
    const g = app.settings.guides;
    if (guideDrag?.kind === 'ruler-new') { const r = g.rulers[guideDrag.i]; if (Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) < 4) g.rulers.pop(); }
    guideDrag = null; app.saveSettings(); app.view.requestOverlay();
  },
  options() {
    const g = app.settings.guides;
    const el = h('div', { class: 'opts' },
      toggle('Magnetic guides', g.enabled, (v) => { g.enabled = v; app.saveSettings(); app.view.requestOverlay(); }, 'When on, strokes that start roughly along a ruler or toward a vanishing point are gently pulled onto it.'),
      slider({ label: 'Magnet strength', min: 0, max: 1, step: 0.01, percent: true, value: g.magnet, compact: true, onInput: (v) => { g.magnet = v; app.saveSettings(); }, tip: '100% = perfectly straight; lower keeps some natural hand wobble.' }),
      button('1-point perspective', { icon: 'perspective', small: true, tip: 'One vanishing point in the middle - roads, hallways, rooms seen straight on.', onClick: () => setPerspective(1) }),
      button('2-point', { icon: 'perspective', small: true, tip: 'Two vanishing points on the horizon - buildings seen from a corner.', onClick: () => setPerspective(2) }),
      button('3-point', { icon: 'perspective', small: true, tip: 'Adds a third point below - dramatic views looking down.', onClick: () => setPerspective(3) }),
      button('Clear guides', { icon: 'trash', small: true, tip: 'Remove all rulers and vanishing points.', onClick: () => { g.rulers = []; g.perspective = []; app.saveSettings(); app.view.requestOverlay(); } }),
      toggle('Show grid', g.showGrid, (v) => { g.showGrid = v; app.saveSettings(); app.view.requestOverlay(); }, 'Show a square grid over the canvas (not part of the picture).'),
      toggle('Snap to grid lines', g.gridSnap, (v) => { g.gridSnap = v; app.saveSettings(); }, 'Horizontal/vertical strokes snap straight.'),
    );
    const gs = numberField('Grid size', g.gridSize, (v) => { g.gridSize = Math.max(4, v); app.saveSettings(); app.view.requestOverlay(); }, { min: 4, max: 2000, unit: 'px', tip: 'Spacing of grid lines.' });
    el.append(gs);
    return el;
  },
};
// double-click on a guide handle deletes it
window.addEventListener('dblclick', (e) => {
  if (app.tools?.current.id !== 'guides' || !(e.target as HTMLElement).closest('.viewport')) return;
  const r = app.view.el.getBoundingClientRect();
  const p = app.view.toDoc(e.clientX - r.left, e.clientY - r.top), t = 12 / app.view.view.zoom;
  const g = app.settings.guides;
  g.perspective = g.perspective.filter((v) => Math.hypot(v.x - p.x, v.y - p.y) >= t);
  g.rulers = g.rulers.filter((ru) => Math.hypot(ru.a.x - p.x, ru.a.y - p.y) >= t && Math.hypot(ru.b.x - p.x, ru.b.y - p.y) >= t);
  app.saveSettings(); app.view.requestOverlay();
});

// ---------------------------------------------------------------------------------------- hand / zoom
export const handTool: Tool = {
  id: 'hand', name: 'Hand', icon: 'hand', key: 'H',
  desc: 'Move around the canvas. Tip: hold Space with any tool, or drag with two fingers / middle mouse button.',
  hint: 'Drag to pan · Mouse wheel: zoom · Hold R and drag: rotate the view',
  cursor: 'grab',
};

let zoomDrag: { sx: number; z0: number; ax: number; ay: number } | null = null;
export const zoomTool: Tool = {
  id: 'zoom', name: 'Zoom', icon: 'zoom', key: 'Z',
  desc: 'Click to zoom in, Alt+click to zoom out, or drag left/right to zoom smoothly.',
  hint: 'Click: zoom in · Alt+click: zoom out · Drag: smooth zoom · 0: fit screen · 1: 100%',
  cursor: 'zoom-in',
  down(e) { zoomDrag = { sx: e.sx, z0: app.view.view.zoom, ax: e.sx, ay: e.sy }; },
  move(e) { if (zoomDrag) app.view.zoomAt(zoomDrag.z0 * Math.exp((e.sx - zoomDrag.sx) / 150), zoomDrag.ax, zoomDrag.ay); },
  up(e) {
    if (zoomDrag && Math.abs(e.sx - zoomDrag.sx) < 3) app.view.zoomAt(app.view.view.zoom * (e.alt ? 0.5 : 2), e.sx, e.sy);
    zoomDrag = null;
  },
};
