// Undoable document operations. Everything that changes the document goes through here so it lands
// in the unlimited history (and the timelapse).
import { app } from './app';
import { PixelStore, type HistoryEntry } from '../core/history';
import { Layer, ctx2d, makeCanvas, type BlendMode } from '../core/layer';
import type { Rect } from '../core/geom';
import { rectClampInt } from '../core/geom';
import { Selection } from '../core/selection';

function thumbnail(): string | undefined {
  const d = app.doc;
  const s = 56 / Math.max(d.width, d.height);
  try { return d.flatten({ scale: s, background: true }).toDataURL('image/jpeg', 0.6); } catch { return undefined; }
}

export function pushEntry(e: Omit<HistoryEntry, 'time'>): void {
  const entry: HistoryEntry = { ...e, time: Date.now() };
  app.history.push(entry);
  const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 30));
  idle(() => { entry.thumb = thumbnail(); app.history.events.emit('change', undefined); });
}

/** Record a pixel change that already happened. `before` covers `rect`. */
export function recordPixels(layer: Layer, rect: Rect, before: ImageData, label: string, icon = 'brush'): void {
  const beforeStore = new PixelStore(before);
  let afterStore: PixelStore | null = null;
  // Capture the exact canvas: animation layers swap canvases per frame.
  const target = layer.canvas;
  const canvasFor = () => {
    if (layer.frames && layer.canvas !== target) {
      for (const [k, c] of layer.frames) if (c === target) { void import('../features/rotoscope').then((m) => m.setFrame(k)); break; }
    }
    return target;
  };
  pushEntry({
    label, icon,
    get bytes() { return beforeStore.bytes + (afterStore?.bytes ?? 0); },
    async undo() {
      const c = ctx2d(canvasFor());
      if (!afterStore) afterStore = new PixelStore(c.getImageData(rect.x, rect.y, rect.w, rect.h));
      c.putImageData(await beforeStore.get(), rect.x, rect.y);
      app.doc.markDirty(layer, rect);
    },
    async redo() {
      const c = ctx2d(canvasFor());
      if (afterStore) c.putImageData(await afterStore.get(), rect.x, rect.y);
      app.doc.markDirty(layer, rect);
    },
    async compact() { await beforeStore.compact(); await afterStore?.compact(); },
  });
}

/** Make `after` respect the selection: pixels outside keep their `before` value. */
function clipToSelection(ctx: CanvasRenderingContext2D, rect: Rect, before: ImageData): void {
  const sel = app.doc.selection;
  if (!sel.mask) return;
  const after = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  const a = after.data, b = before.data, m = sel.mask, W = app.doc.width;
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const k = m[(rect.y + y) * W + rect.x + x] / 255;
      if (k >= 1) continue;
      const i = (y * rect.w + x) * 4;
      for (let c = 0; c < 4; c++) a[i + c] = b[i + c] + (a[i + c] - b[i + c]) * k;
    }
  }
  ctx.putImageData(after, rect.x, rect.y);
}

function alphaLockRestore(ctx: CanvasRenderingContext2D, rect: Rect, before: ImageData): void {
  const after = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  for (let i = 3; i < after.data.length; i += 4) after.data[i] = before.data[i];
  ctx.putImageData(after, rect.x, rect.y);
}

/**
 * Run a CPU edit on a layer with undo, selection clipping and alpha lock.
 * `rect` null = whole layer.
 */
export async function editPixels(
  layer: Layer, rect: Rect | null, label: string, icon: string,
  fn: (ctx: CanvasRenderingContext2D) => void | Promise<void>,
  opts: { clip?: boolean } = {},
): Promise<boolean> {
  if (!layer.editable) { app.toast(`"${layer.name}" is locked. Unlock it in the Layers panel first.`, 'error'); return false; }
  await app.backend.flush();
  const r = rectClampInt(rect ?? { x: 0, y: 0, w: app.doc.width, h: app.doc.height }, layer.canvas.width, layer.canvas.height);
  if (!r) return false;
  const ctx = ctx2d(layer.canvas);
  const before = ctx.getImageData(r.x, r.y, r.w, r.h);
  ctx.save();
  await fn(ctx);
  ctx.restore();
  if (opts.clip !== false) clipToSelection(ctx, r, before);
  if (layer.alphaLock) alphaLockRestore(ctx, r, before);
  app.doc.markDirty(layer, r);
  recordPixels(layer, r, before, label, icon);
  return true;
}

// ---------------------------------------------------------------------------------------- layers
export function addLayer(layer?: Layer, index?: number, label = 'New layer'): Layer {
  const doc = app.doc;
  const l = layer ?? doc.createLayer();
  doc.insertLayer(l, index);
  const at = doc.indexOf(l);
  pushEntry({
    label, icon: 'layers',
    undo() { doc.removeLayer(l); },
    redo() { doc.insertLayer(l, at); },
  });
  return l;
}

export function deleteLayer(l: Layer): void {
  const doc = app.doc;
  if (doc.layers.length <= 1) { app.toast('A document needs at least one layer.', 'error'); return; }
  const at = doc.removeLayer(l);
  pushEntry({ label: `Delete "${l.name}"`, icon: 'trash', undo() { doc.insertLayer(l, at); }, redo() { doc.removeLayer(l); } });
}

export function duplicateLayer(l: Layer): Layer {
  const doc = app.doc;
  const c = new Layer(l.name + ' copy', doc.width, doc.height, l.kind === 'video' ? 'paint' : l.kind);
  ctx2d(c.canvas).drawImage(l.canvas, 0, 0);
  c.opacity = l.opacity; c.blend = l.blend;
  if (l.source) { c.source = makeCanvas(doc.width, doc.height); ctx2d(c.source).drawImage(l.source, 0, 0); c.adjustments = { ...l.adjustments! }; }
  return addLayer(c, doc.indexOf(l) + 1, 'Duplicate layer');
}

export async function mergeDown(l: Layer): Promise<void> {
  const doc = app.doc;
  const i = doc.indexOf(l);
  if (i <= 0) { app.toast('There is no layer below to merge into.', 'error'); return; }
  await app.backend.flush();
  const below = doc.layers[i - 1];
  if (!below.editable) { app.toast(`"${below.name}" is locked.`, 'error'); return; }
  const ctx = ctx2d(below.canvas);
  const before = ctx.getImageData(0, 0, doc.width, doc.height);
  const saved = { o: below.opacity, v: below.visible, lv: l.visible };
  below.opacity = 1; below.visible = true; l.visible = true;
  const both = doc.flatten({ layers: [below, l], background: false });
  below.opacity = saved.o; below.visible = saved.v; l.visible = saved.lv;
  ctx.clearRect(0, 0, doc.width, doc.height);
  ctx.drawImage(both, 0, 0);
  const store = new PixelStore(before);
  let after: PixelStore | null = null;
  doc.removeLayer(l);
  doc.setActive(below);
  doc.markDirty(below, null);
  pushEntry({
    label: `Merge "${l.name}" down`, icon: 'merge',
    async undo() {
      after = new PixelStore(ctx.getImageData(0, 0, doc.width, doc.height));
      ctx.putImageData(await store.get(), 0, 0);
      doc.markDirty(below, null);
      doc.insertLayer(l, i);
    },
    async redo() {
      ctx.putImageData(await after!.get(), 0, 0);
      doc.markDirty(below, null);
      doc.removeLayer(l);
    },
  });
}

export function moveLayer(l: Layer, to: number): void {
  const doc = app.doc;
  const from = doc.indexOf(l);
  to = Math.max(0, Math.min(doc.layers.length - 1, to));
  if (from === to) return;
  doc.moveLayer(l, to);
  pushEntry({ label: 'Reorder layers', icon: 'layers', undo() { doc.moveLayer(l, from); }, redo() { doc.moveLayer(l, to); } });
}

type LayerProps = Partial<Pick<Layer, 'opacity' | 'blend' | 'visible' | 'locked' | 'alphaLock' | 'name'>>;
let lastProp: { layer: Layer; key: string; time: number; entry: HistoryEntry; after: LayerProps } | null = null;

/** Change layer properties; rapid changes of the same property (slider drags) merge into one step. */
export function setLayerProps(l: Layer, props: LayerProps, label?: string): void {
  const doc = app.doc;
  const key = Object.keys(props).sort().join(',');
  const before: LayerProps = {};
  for (const k of Object.keys(props) as (keyof LayerProps)[]) (before as any)[k] = l[k];
  Object.assign(l, props);
  doc.events.emit('structure', undefined);
  const now = Date.now();
  const h = app.history;
  if (lastProp && lastProp.layer === l && lastProp.key === key && now - lastProp.time < 1200 && h.entries[h.index - 1] === lastProp.entry) {
    Object.assign(lastProp.after, props);
    lastProp.time = now;
    return;
  }
  const after = { ...props };
  const names: Record<string, string> = { opacity: 'Layer opacity', blend: 'Blend mode', visible: 'Toggle visibility', locked: 'Lock layer', alphaLock: 'Lock transparency', name: 'Rename layer' };
  pushEntry({
    label: label ?? names[key] ?? 'Layer properties', icon: 'layers',
    undo() { Object.assign(l, before); doc.events.emit('structure', undefined); },
    redo() { Object.assign(l, after); doc.events.emit('structure', undefined); },
  });
  lastProp = { layer: l, key, time: now, entry: h.entries[h.index - 1], after };
}

export function setBlend(l: Layer, blend: BlendMode) { setLayerProps(l, { blend }); }

// ---------------------------------------------------------------------------------------- selection
export function changeSelection(fn: (s: Selection) => void, label: string): void {
  const doc = app.doc;
  const before = doc.selection.clone();
  fn(doc.selection);
  const after = doc.selection.clone();
  doc.events.emit('selection', undefined);
  pushEntry({
    label, icon: 'select',
    undo() { doc.selection = before.clone(); doc.events.emit('selection', undefined); },
    redo() { doc.selection = after.clone(); doc.events.emit('selection', undefined); },
  });
}

// ---------------------------------------------------------------------------------------- canvas size
interface Snapshot { layer: Layer; canvas: HTMLCanvasElement; source?: HTMLCanvasElement; frames?: Map<number, HTMLCanvasElement> }

export async function resizeDocument(w: number, h: number, dx: number, dy: number, scale: boolean, label: string): Promise<void> {
  const doc = app.doc;
  await app.backend.flush();
  const snap = (): { w: number; h: number; layers: Snapshot[] } => ({
    w: doc.width, h: doc.height,
    layers: doc.layers.map((l) => ({ layer: l, canvas: l.canvas, source: l.source, frames: l.frames ? new Map(l.frames) : undefined })),
  });
  const restore = (s: { w: number; h: number; layers: Snapshot[] }, ddx: number, ddy: number) => {
    for (const sn of s.layers) {
      sn.layer.canvas = sn.canvas; sn.layer.source = sn.source;
      if (sn.frames) sn.layer.frames = new Map(sn.frames);
      sn.layer.version++;
    }
    doc.width = s.w; doc.height = s.h;
    doc.selection = new Selection(s.w, s.h);
    doc.events.emit('resize', { dx: ddx, dy: ddy });
    doc.events.emit('structure', undefined);
    doc.events.emit('selection', undefined);
  };
  const before = snap();
  doc.resizeCanvas(w, h, dx, dy, scale);
  const after = snap();
  pushEntry({
    label, icon: 'crop',
    undo() { restore(before, scale ? 0 : -dx, scale ? 0 : -dy); },
    redo() { restore(after, scale ? 0 : dx, scale ? 0 : dy); },
  });
}

/** Rebuild every layer through a drawing function (rotate/flip canvas etc.). */
export async function remapDocument(w: number, h: number, label: string, draw: (ctx: CanvasRenderingContext2D, src: HTMLCanvasElement) => void): Promise<void> {
  const doc = app.doc;
  await app.backend.flush();
  const map = (src: HTMLCanvasElement) => { const c = makeCanvas(w, h); const x = ctx2d(c); x.save(); draw(x, src); x.restore(); return c; };
  const before = { w: doc.width, h: doc.height, layers: doc.layers.map((l) => ({ l, canvas: l.canvas, source: l.source, frames: l.frames ? new Map(l.frames) : undefined })) };
  for (const l of doc.layers) {
    l.canvas = map(l.canvas);
    if (l.source) l.source = map(l.source);
    if (l.frames) { for (const [k, f] of l.frames) l.frames.set(k, map(f)); l.canvas = l.frames.get(l.currentFrame) ?? l.canvas; }
    l.version++;
  }
  const after = { w, h, layers: doc.layers.map((l) => ({ l, canvas: l.canvas, source: l.source, frames: l.frames ? new Map(l.frames) : undefined })) };
  const apply = (s: typeof before) => {
    for (const x of s.layers) { x.l.canvas = x.canvas; x.l.source = x.source; if (x.frames) x.l.frames = new Map(x.frames); x.l.version++; }
    doc.width = s.w; doc.height = s.h;
    doc.selection = new Selection(s.w, s.h);
    doc.events.emit('resize', { dx: 0, dy: 0 });
    doc.events.emit('structure', undefined);
    doc.events.emit('selection', undefined);
  };
  apply(after);
  pushEntry({ label, icon: 'rotate', undo() { apply(before); }, redo() { apply(after); } });
}
