// New document, open/save projects, import images/video, export, autosave, clipboard, drag & drop.
import { app } from '../app/app';
import { PaintDocument } from '../core/document';
import { Layer, ctx2d, makeCanvas } from '../core/layer';
import { hexToRgb, rgbToHex, type RGB } from '../core/color';
import { h } from '../ui/dom';
import { button, numberField, segmented, select, slider, toggle } from '../ui/controls';
import { download, openDialog, pickFile } from '../ui/dialog';
import { addImageLayer } from './adjust';
import { DEFAULT_ADJUSTMENTS } from '../wasm/wasm';
import { references } from './references';
import { timelapse } from './timelapse';
import { pickSample } from './samples';
import { addLayer, editPixels } from '../app/ops';
import { importVideo } from './rotoscope';

// ------------------------------------------------------------------------------------ new document
export interface DocPreset { id: string; group: string; name: string; w: number; h: number; tip: string; infinite?: boolean }
const mm = (v: number, dpi: number) => Math.round((v / 25.4) * dpi);
export const DOC_PRESETS: DocPreset[] = [
  { id: 'hd', group: 'Screen', name: 'HD 1920 × 1080', w: 1920, h: 1080, tip: 'Widescreen - desktop wallpapers, videos, slides.' },
  { id: 'qhd', group: 'Screen', name: 'QHD 2560 × 1440', w: 2560, h: 1440, tip: 'Sharper widescreen.' },
  { id: '4k', group: 'Screen', name: '4K 3840 × 2160', w: 3840, h: 2160, tip: 'Ultra HD. Needs a good graphics card for big wet brushes.' },
  { id: 'square', group: 'Screen', name: 'Square 2048 × 2048', w: 2048, h: 2048, tip: 'Great all-rounder for illustrations and social media.' },
  { id: 'insta', group: 'Screen', name: 'Portrait post 1080 × 1350', w: 1080, h: 1350, tip: 'Instagram-style portrait post (4:5).' },
  { id: 'phone', group: 'Screen', name: 'Phone wallpaper 1170 × 2532', w: 1170, h: 2532, tip: 'Tall phone screen.' },
  { id: 'a5-150', group: 'Print', name: 'A5 · 150 dpi', w: mm(148, 150), h: mm(210, 150), tip: '148 × 210 mm at sketch quality.' },
  { id: 'a4-150', group: 'Print', name: 'A4 · 150 dpi', w: mm(210, 150), h: mm(297, 150), tip: '210 × 297 mm at sketch quality - fast and light.' },
  { id: 'a4-300', group: 'Print', name: 'A4 · 300 dpi', w: mm(210, 300), h: mm(297, 300), tip: '210 × 297 mm at full print quality (2480 × 3508 px).' },
  { id: 'a3-150', group: 'Print', name: 'A3 · 150 dpi', w: mm(297, 150), h: mm(420, 150), tip: '297 × 420 mm poster at medium quality.' },
  { id: 'a3-300', group: 'Print', name: 'A3 · 300 dpi', w: mm(297, 300), h: mm(420, 300), tip: '297 × 420 mm at full print quality. Very large.' },
  { id: 'letter', group: 'Print', name: 'US Letter · 300 dpi', w: 2550, h: 3300, tip: '8.5 × 11 inches at print quality.' },
  { id: 'postcard', group: 'Print', name: 'Postcard · 300 dpi', w: mm(148, 300), h: mm(105, 300), tip: '148 × 105 mm landscape postcard.' },
  { id: 'infinite', group: 'Special', name: 'Infinite canvas', w: 2048, h: 1536, infinite: true, tip: 'Starts at 2048 × 1536 and grows automatically whenever you paint near an edge.' },
];

export function newDocument(w: number, h: number, opts: { background?: RGB; transparent?: boolean; infinite?: boolean; paper?: number; name?: string } = {}): PaintDocument {
  const doc = new PaintDocument(w, h);
  doc.background = { color: opts.background ?? [1, 1, 1], transparent: !!opts.transparent, paper: opts.paper ?? 0.35 };
  doc.infinite = !!opts.infinite;
  doc.name = opts.name ?? 'Untitled';
  const l = doc.createLayer('Layer 1');
  doc.layers.push(l);
  doc.activeId = l.id;
  setDocument(doc);
  return doc;
}

export function setDocument(doc: PaintDocument): void {
  app.doc = doc;
  app.settings.symmetry.cx = doc.width / 2;
  app.settings.symmetry.cy = doc.height / 2;
  doc.events.on('resize', ({ dx, dy }) => {
    if (dx || dy) { app.settings.symmetry.cx += dx; app.settings.symmetry.cy += dy; }
  });
  app.backend.setDocument(doc);
  app.history.clear();
  timelapse.reset();
  app.events.emit('document', undefined);
  app.view.fit();
  app.view.requestRender();
}

export function openNewDocDialog(welcome = false, hasAutosave = false): void {
  let sel = DOC_PRESETS[3];
  let bgMode: 'white' | 'cream' | 'transparent' | 'custom' = 'white';
  let custom = '#f4efe6';
  let paper = true;
  const d = openDialog(welcome ? 'Welcome to Flowpaint Studio' : 'New painting', {
    width: 860, icon: welcome ? 'heart' : 'new',
    subtitle: welcome ? 'Realistic liquid paint that never dries, never smudges by accident, and always undoes. Pick a canvas to begin.' : 'Choose a size for your canvas.',
  });
  const wF = numberField('Width', sel.w, () => { sel = { ...sel, id: 'custom', infinite: false }; }, { min: 16, max: 16384, unit: 'px', tip: 'Canvas width in pixels.' });
  const hF = numberField('Height', sel.h, () => { sel = { ...sel, id: 'custom', infinite: false }; }, { min: 16, max: 16384, unit: 'px', tip: 'Canvas height in pixels.' });
  const infT = toggle('Infinite (grows as you paint)', false, (v) => { sel = { ...sel, infinite: v }; }, 'The canvas expands automatically when you paint near an edge.');
  const cards: HTMLElement[] = [];
  const grid = h('div', { class: 'preset-grid' });
  let group = '';
  for (const p of DOC_PRESETS) {
    if (p.group !== group) { grid.append(h('div', { class: 'preset-group' }, p.group)); group = p.group; }
    const ar = p.w / p.h;
    const card = h('button', { class: 'preset' + (p === sel ? ' active' : ''), type: 'button', tip: { title: p.name, desc: p.tip } },
      h('span', { class: 'preset-shape' + (p.infinite ? ' inf' : ''), style: `aspect-ratio:${ar};${ar > 1 ? 'width:44px' : 'height:44px'}` }),
      h('span', { class: 'preset-name' }, p.name),
      h('span', { class: 'preset-dim' }, p.infinite ? 'grows automatically' : `${p.w} × ${p.h}`));
    card.addEventListener('click', () => { sel = p; cards.forEach((c) => c.classList.remove('active')); card.classList.add('active'); wF.input.value = String(p.w); hF.input.value = String(p.h); infT.set(!!p.infinite); });
    card.addEventListener('dblclick', () => create());
    cards.push(card);
    grid.append(card);
  }
  const unitRow = h('div', { class: 'row wrap' },
    wF, hF,
    button('Swap', { icon: 'swap', small: true, tip: 'Swap width and height (portrait ↔ landscape).', onClick: () => { const t = wF.input.value; wF.input.value = hF.input.value; hF.input.value = t; } }),
    infT);
  const bgSeg = segmented(bgMode, [
    { value: 'white', label: 'White paper', tip: 'Classic white background.' },
    { value: 'cream', label: 'Warm paper', tip: 'Off-white watercolour paper tone.' },
    { value: 'transparent', label: 'Transparent', tip: 'No background - export PNGs with see-through areas.' },
    { value: 'custom', label: 'Custom colour', tip: 'Pick any background colour.' },
  ], (v) => { bgMode = v; });
  const colorIn = h('input', { type: 'color', value: custom, class: 'color-input', title: 'Custom background colour' });
  colorIn.addEventListener('input', () => { custom = colorIn.value; bgMode = 'custom'; bgSeg.set('custom'); });
  d.body.append(
    grid,
    h('div', { class: 'sub-title' }, 'Size'), unitRow,
    h('div', { class: 'sub-title' }, 'Background'), h('div', { class: 'row wrap' }, bgSeg, colorIn, toggle('Paper texture', paper, (v) => (paper = v), 'Show a subtle paper grain on the background (also exported).')),
  );
  const create = () => {
    const w = Number(wF.input.value) || sel.w, hh = Number(hF.input.value) || sel.h;
    const bg: RGB = bgMode === 'cream' ? [0.97, 0.95, 0.9] : bgMode === 'custom' ? hexToRgb(custom)! : [1, 1, 1];
    newDocument(w, hh, { background: bg, transparent: bgMode === 'transparent', infinite: sel.infinite, paper: paper ? 0.35 : 0 });
    d.close();
  };
  if (welcome) {
    d.footer.append(
      button('Open file…', { icon: 'folder', tip: 'Open a saved Flowpaint project or any image.', onClick: async () => { d.close(); await openAny(); } }),
      button('Try a sample picture', { icon: 'sparkles', tip: 'Start from one of the built-in paintings and photos - great for practice.', onClick: async () => { d.close(); await openSample(); } }),
    );
    if (hasAutosave) d.footer.append(button('Continue last painting', { icon: 'history', tip: 'Restore the painting you were working on (auto-saved in this browser).', onClick: async () => { d.close(); await restoreAutosave(); } }));
  } else d.footer.append(button('Cancel', { onClick: () => d.close() }));
  d.footer.append(button('Create canvas', { icon: 'check', primary: true, onClick: create }));
}

// ------------------------------------------------------------------------------------ project files
interface SavedLayer {
  name: string; kind: string; opacity: number; blend: string; visible: boolean; locked: boolean; alphaLock: boolean;
  image: string | Blob; source?: string | Blob; adjustments?: unknown; frames?: [number, string | Blob][]; currentFrame?: number;
}
export interface SavedProject {
  format: 'flowpaint'; version: 1; name: string; width: number; height: number; infinite: boolean;
  background: { color: RGB; transparent: boolean; paper: number };
  activeIndex: number; layers: SavedLayer[]; swatches: string[]; references?: unknown; guides?: unknown;
}

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
const toDataURL = (c: HTMLCanvasElement) => c.toDataURL('image/png');

export async function serialize(asBlobs: boolean): Promise<SavedProject> {
  await app.backend.flush();
  const doc = app.doc;
  const enc = async (c: HTMLCanvasElement) => (asBlobs ? toBlob(c) : toDataURL(c));
  const layers: SavedLayer[] = [];
  for (const l of doc.layers) {
    const frames: [number, string | Blob][] = [];
    if (l.frames) for (const [k, f] of l.frames) frames.push([k, await enc(f)]);
    layers.push({
      name: l.name, kind: l.kind === 'video' ? 'paint' : l.kind, opacity: l.opacity, blend: l.blend, visible: l.visible, locked: l.locked, alphaLock: l.alphaLock,
      image: await enc(l.canvas), source: l.source ? await enc(l.source) : undefined, adjustments: l.adjustments,
      frames: l.frames ? frames : undefined, currentFrame: l.currentFrame,
    });
  }
  return {
    format: 'flowpaint', version: 1, name: doc.name, width: doc.width, height: doc.height, infinite: doc.infinite,
    background: { ...doc.background }, activeIndex: doc.indexOf(doc.active), layers, swatches: app.settings.swatches,
    references: await references.serialize(asBlobs), guides: app.settings.guides,
  };
}

async function loadImg(src: string | Blob): Promise<ImageBitmap> {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

export async function deserialize(p: SavedProject): Promise<void> {
  if (p.format !== 'flowpaint') throw new Error('Not a Flowpaint project');
  const doc = new PaintDocument(p.width, p.height);
  doc.name = p.name; doc.infinite = p.infinite; doc.background = { ...p.background };
  for (const s of p.layers) {
    const l = new Layer(s.name, p.width, p.height, s.kind as Layer['kind']);
    Object.assign(l, { opacity: s.opacity, blend: s.blend, visible: s.visible, locked: s.locked, alphaLock: s.alphaLock });
    const draw = async (src: string | Blob, c: HTMLCanvasElement) => { const bmp = await loadImg(src); ctx2d(c).drawImage(bmp, 0, 0); bmp.close(); };
    await draw(s.image, l.canvas);
    if (s.source) { l.source = makeCanvas(p.width, p.height); await draw(s.source, l.source); l.adjustments = { ...DEFAULT_ADJUSTMENTS, ...(s.adjustments as object) }; }
    if (s.frames) {
      l.frames = new Map();
      for (const [k, f] of s.frames) { const c = makeCanvas(p.width, p.height); await draw(f, c); l.frames.set(k, c); }
      l.currentFrame = s.currentFrame ?? 0;
      l.canvas = l.frames.get(l.currentFrame) ?? l.canvas;
    }
    doc.layers.push(l);
  }
  if (!doc.layers.length) doc.layers.push(doc.createLayer('Layer 1'));
  doc.activeId = doc.layers[Math.min(doc.layers.length - 1, Math.max(0, p.activeIndex))].id;
  if (p.swatches?.length) app.settings.swatches = p.swatches;
  if (p.guides) app.settings.guides = { ...app.settings.guides, ...(p.guides as object) };
  setDocument(doc);
  if (p.references) await references.deserialize(p.references);
}

export async function saveProject(): Promise<void> {
  const p = await serialize(false);
  download(new Blob([JSON.stringify(p)], { type: 'application/json' }), `${(app.doc.name || 'painting').replace(/[^\w-]+/g, '_')}.flowpaint`);
  app.toast('Project saved with all layers.', 'success');
}

/** Open a built-in sample picture as a new painting (photo layer + empty layer on top). */
export async function openSample(asLayer = false): Promise<void> {
  const r = await pickSample(asLayer ? 'Import a sample picture' : 'Open a sample picture', asLayer ? 'Adds the picture as an adjustable photo layer.' : 'Opens the picture as a new painting with an empty layer on top to paint on.');
  if (!r) return;
  if (asLayer) { addImageLayer(r.bitmap, r.sample.name); return; }
  newDocument(r.bitmap.width, r.bitmap.height, { name: r.sample.name });
  const empty = app.doc.layers[0];
  addImageLayer(r.bitmap, r.sample.name, 'fit');
  app.doc.removeLayer(empty);
  app.doc.insertLayer(app.doc.createLayer('Paint'));
  app.history.clear();
  app.toast(`Opened "${r.sample.name}". Paint on the top layer - the picture stays untouched below.`, 'success');
}

export async function openAny(): Promise<void> {
  const files = await pickFile('.flowpaint,.json,image/*,video/*');
  for (const f of files) await openFile(f, true);
}

/** Open or import a file. Projects replace the document; images become a new document or a layer. */
export async function openFile(f: File, asNewDoc = false): Promise<void> {
  try {
    if (f.name.endsWith('.flowpaint') || f.type === 'application/json') {
      await deserialize(JSON.parse(await f.text()));
      app.doc.name = f.name.replace(/\.flowpaint$/, '');
      app.toast(`Opened "${f.name}".`, 'success');
    } else if (f.type.startsWith('video/')) {
      await importVideo(f);
    } else if (f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name)) {
      const bmp = await createImageBitmap(f);
      if (asNewDoc) {
        newDocument(bmp.width, bmp.height, { name: f.name.replace(/\.\w+$/, '') });
        const empty = app.doc.layers[0];
        addImageLayer(bmp, f.name.replace(/\.\w+$/, ''), 'fit');
        app.doc.removeLayer(empty);
        const top = app.doc.createLayer('Paint');
        app.doc.insertLayer(top);
        app.history.clear();
      } else addImageLayer(bmp, f.name.replace(/\.\w+$/, ''));
      app.toast(`Imported "${f.name}". Use Layer → Adjust photo to tweak it.`, 'success');
    } else app.toast(`Can't open "${f.name}" - unsupported file type.`, 'error');
  } catch (e) {
    console.error(e);
    app.toast(`Could not open "${f.name}": ${(e as Error).message}`, 'error');
  }
}

export async function importImage(): Promise<void> {
  const files = await pickFile('image/*', true);
  for (const f of files) await openFile(f, false);
}

// ------------------------------------------------------------------------------------ export
export async function exportDialog(): Promise<void> {
  await app.backend.flush();
  const o = { format: 'png' as 'png' | 'jpeg' | 'webp', scale: 1, quality: 0.92, background: !app.doc.background.transparent, what: 'all' as 'all' | 'layer' | 'selection', paper: true };
  const d = openDialog('Export image', { width: 520, icon: 'download', subtitle: 'Save a flat picture to share or print. (Use File → Save project to keep layers.)' });
  const info = h('div', { class: 'hint' });
  const upd = () => {
    const r = o.what === 'selection' && app.doc.selection.bounds ? app.doc.selection.bounds : { w: app.doc.width, h: app.doc.height };
    info.textContent = `Output: ${Math.round(r.w * o.scale)} × ${Math.round(r.h * o.scale)} px`;
  };
  d.body.append(
    segmented(o.format, [
      { value: 'png', label: 'PNG', tip: 'Perfect quality, supports transparency. Best for art.' },
      { value: 'jpeg', label: 'JPEG', tip: 'Small files, no transparency. Best for photos and sharing online.' },
      { value: 'webp', label: 'WebP', tip: 'Modern web format: small and high quality, supports transparency.' },
    ], (v) => (o.format = v)),
    select('What to export', o.what, [{ value: 'all', label: 'Whole picture' }, { value: 'layer', label: 'Current layer only' }, { value: 'selection', label: 'Selected area' }], (v) => { o.what = v; upd(); }, 'Choose to export everything, just one layer, or only what is selected.'),
    slider({ label: 'Size', min: 0.1, max: 4, step: 0.05, value: 1, percent: true, tip: 'Scale the exported image up or down.', onInput: (v) => { o.scale = v; upd(); } }),
    slider({ label: 'Quality (JPEG/WebP)', min: 0.5, max: 1, step: 0.01, value: 0.92, percent: true, tip: 'Higher = better quality, bigger file.', onInput: (v) => (o.quality = v) }),
    toggle('Include background', o.background, (v) => (o.background = v), 'Include the paper colour. Turn off for a transparent PNG/WebP.'),
    info,
  );
  upd();
  const render = () => {
    const doc = app.doc;
    const region = o.what === 'selection' && doc.selection.bounds ? doc.selection.bounds : undefined;
    const c = doc.flatten({ background: o.background || o.format === 'jpeg', scale: o.scale, layers: o.what === 'layer' ? [doc.active] : undefined, region });
    if (o.what === 'selection' && doc.selection.maskCanvas && region) {
      const x = ctx2d(c);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(doc.selection.maskCanvas, region.x, region.y, region.w, region.h, 0, 0, c.width, c.height);
    }
    return c;
  };
  d.footer.append(
    button('Copy to clipboard', { icon: 'copy', tip: 'Copy the image so you can paste it into other apps.', onClick: async () => {
      try { const b = await toBlob(render()); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); app.toast('Copied to clipboard.', 'success'); } catch { app.toast('Your browser blocked clipboard access.', 'error'); }
    } }),
    button('Cancel', { onClick: () => d.close() }),
    button('Export', { icon: 'download', primary: true, onClick: () => {
      const c = render();
      const mime = `image/${o.format}`;
      c.toBlob((b) => { if (b) download(b, `${(app.doc.name || 'painting').replace(/[^\w-]+/g, '_')}.${o.format === 'jpeg' ? 'jpg' : o.format}`); }, mime, o.quality);
      d.close();
    } }),
  );
}

export async function exportImageDataURL(format = 'image/png', scale = 1, background = true): Promise<string> {
  await app.backend.flush();
  return app.doc.flatten({ scale, background }).toDataURL(format, 0.92);
}

// ------------------------------------------------------------------------------------ clipboard
let internalClipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;

export async function copySelection(cut = false): Promise<void> {
  await app.backend.flush();
  const doc = app.doc;
  const b = doc.selection.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const c = makeCanvas(b.w, b.h);
  const x = ctx2d(c);
  x.drawImage(doc.active.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  if (doc.selection.maskCanvas) { x.globalCompositeOperation = 'destination-in'; x.drawImage(doc.selection.maskCanvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h); }
  internalClipboard = { canvas: c, x: b.x, y: b.y };
  try { const blob = await toBlob(c); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch { /* internal clipboard still works */ }
  if (cut) {
    await editPixels(doc.active, b, 'Cut', 'copy', (ctx) => ctx.clearRect(b.x, b.y, b.w, b.h));
  }
  app.toast(cut ? 'Cut to clipboard.' : 'Copied to clipboard.', 'success');
}

export async function pasteImage(e?: ClipboardEvent): Promise<void> {
  const items = e?.clipboardData?.items;
  if (items) {
    for (const it of items) {
      if (it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { await pasteBitmap(await createImageBitmap(f), 'Pasted image'); return; } }
    }
  } else {
    try {
      const list = await navigator.clipboard.read();
      for (const it of list) for (const t of it.types) if (t.startsWith('image/')) { await pasteBitmap(await createImageBitmap(await it.getType(t)), 'Pasted image'); return; }
    } catch { /* fall back to internal */ }
  }
  if (internalClipboard) {
    const l = app.doc.createLayer('Pasted');
    ctx2d(l.canvas).drawImage(internalClipboard.canvas, internalClipboard.x, internalClipboard.y);
    addLayer(l, undefined, 'Paste');
  }
}

async function pasteBitmap(bmp: ImageBitmap, name: string) {
  const doc = app.doc;
  const l = doc.createLayer(name);
  const s = Math.min(1, doc.width / bmp.width, doc.height / bmp.height);
  ctx2d(l.canvas).drawImage(bmp, (doc.width - bmp.width * s) / 2, (doc.height - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  addLayer(l, undefined, 'Paste');
}

// ------------------------------------------------------------------------------------ autosave (IndexedDB)
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('flowpaint', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction('kv', 'readonly'); const r = t.objectStore('kv').get(key); r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error); });
}

let saveTimer = 0;
let saving = false;
export function scheduleAutosave(): void {
  if (!app.settings.autosave) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (saving || app.backend.stroking) { scheduleAutosave(); return; }
    saving = true;
    try { await idbSet('autosave', await serialize(true)); app.events.emit('status', 'Auto-saved'); } catch (e) { console.warn('autosave failed', e); }
    saving = false;
  }, 4000);
}
export async function hasAutosave(): Promise<boolean> { try { return !!(await idbGet('autosave')); } catch { return false; } }
export async function restoreAutosave(): Promise<void> {
  const p = await idbGet<SavedProject>('autosave');
  if (p) { await deserialize(p); app.toast('Restored your last painting.', 'success'); }
}

// ------------------------------------------------------------------------------------ drag & drop
export function installDropHandler(): void {
  const over = h('div', { class: 'drop-overlay' }, h('div', null, 'Drop images, videos or .flowpaint projects'));
  document.body.append(over);
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; over.classList.add('show'); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) over.classList.remove('show'); });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    depth = 0; over.classList.remove('show');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    // dropping onto the reference board pins as reference instead
    if ((e.target as HTMLElement).closest('.ref-window, .ref-drop')) return;
    for (const f of e.dataTransfer.files) await openFile(f, false);
  });
}

export { rgbToHex };
