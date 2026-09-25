// Brushes panel: visual list of presets (with live-rendered stroke previews) for the current tool.
import { app, type BrushSlot } from '../../app/app';
import { h, svgIcon } from '../dom';
import { icon } from '../icons';
import type { BrushSettings } from '../../engine/brush';
import { CpuWetPainter } from '../../engine/cpuPainter';
import { StrokeBuilder } from '../../engine/stroke';
import { tipIndex } from '../../engine/types';
import { ctx2d, makeCanvas } from '../../core/layer';
import { hsvToRgb } from '../../core/color';
import { openBrushEditor } from '../../features/brushEditor';

const previewCache = new Map<string, string>();
let refreshList: () => void = () => {};
/** Re-render the brush list (after adding/removing custom brushes). */
export function refreshBrushList() { refreshList(); }

/** Render a sample S-stroke with the real CPU paint engine. */
export function renderBrushPreview(b: BrushSettings, w = 180, hgt = 48): HTMLCanvasElement {
  const c = makeCanvas(w, hgt);
  const x = ctx2d(c);
  if (b.mode === 'erase' || b.mode === 'smudge' || b.mode === 'blend') {
    for (let i = 0; i < 6; i++) { x.fillStyle = `rgb(${hsvToRgb(i * 50 + 190, 0.55, 0.9).map((v) => v * 255).join(',')})`; x.fillRect((i * w) / 6, 0, w / 6 + 1, hgt); }
  }
  const p = new CpuWetPainter(c);
  const scale = Math.min(1, (hgt * 0.42) / Math.max(1, b.size / 2));
  const bb = { ...b, size: Math.max(2, b.size * scale) };
  p.begin({
    mode: b.mode, opacity: b.opacity, wetness: b.wetness, viscosity: b.viscosity, pickup: b.pickup, load: b.load, transparency: b.transparency,
    wetEdge: b.wetEdge, impasto: b.impasto, grain: b.grain, grainScale: b.grainScale, bristles: b.bristles, tip: tipIndex(b.tip) === 4 ? 0 : tipIndex(b.tip),
    settle: b.settle, spectral: true, alphaLock: false, seed: 1234,
  }, null);
  const sb = new StrokeBuilder({
    brush: bb, color: [0.13, 0.28, 0.62], color2: [0.9, 0.35, 0.3], stabilizer: { mode: 'off', strength: 0, predictive: false, catchUp: false },
    symmetry: { mode: 'off', count: 1, mirror: false, cx: 0, cy: 0 }, guides: { enabled: false, magnet: 0, rulers: [], perspective: [], gridSnap: false, gridSize: 10, showGrid: false },
    zoom: 1, isPen: true, pressureGamma: 1,
  });
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = 12 + t * (w - 24), py = hgt / 2 + Math.sin(t * Math.PI * 2) * hgt * 0.18;
    const pr = Math.sin(t * Math.PI) * 0.85 + 0.15;
    p.addDabs(sb.push({ x: px, y: py, p: pr, tiltX: 0, tiltY: 0, t: i * 8 }));
    if (i % 6 === 0) p.tick(16);
  }
  p.end();
  for (let i = 0; i < 20 && !p.settled; i++) p.tick(Math.max(16, b.settle / 12));
  p.commit();
  return c;
}

function previewURL(b: BrushSettings): string {
  const key = JSON.stringify({ ...b, name: '', description: '' });
  let u = previewCache.get(key);
  if (!u) { u = renderBrushPreview(b).toDataURL(); previewCache.set(key, u); }
  return u;
}

const SLOT_CATS: Record<BrushSlot, string[]> = { brush: ['Paint', 'Dry', 'Ink', 'Fun', 'Custom'], eraser: ['Eraser', 'Custom'], smudge: ['Blend', 'Custom'] };

export function brushPanel(): HTMLElement {
  const list = h('div', { class: 'brush-list', role: 'listbox', 'aria-label': 'Brushes' });
  const el = h('div', { class: 'panel-body brush-panel' },
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', tip: { title: 'Edit brush', desc: 'Open the brush editor to tweak every setting, make a rainbow brush, or design your own brush tip.' }, onclick: () => openBrushEditor() }, svgIcon(icon('settings')), h('span', null, 'Edit brush')),
      h('button', { class: 'btn small', type: 'button', tip: { title: 'New custom brush', desc: 'Save the current brush settings as your own brush.' }, onclick: () => openBrushEditor(true) }, svgIcon(icon('plus')), h('span', null, 'New brush')),
    ),
    list);

  let queued = 0;
  function render() {
    list.innerHTML = '';
    const slot = app.brushSlot;
    const cats = SLOT_CATS[slot];
    const brushes = app.allBrushes.filter((b) => cats.includes(b.category) && (b.category !== 'Custom' || app.slotFor(b) === slot));
    let lastCat = '';
    const gen = ++queued;
    const pending: [HTMLImageElement, BrushSettings][] = [];
    for (const b of brushes) {
      if (b.category !== lastCat) { list.append(h('div', { class: 'brush-cat' }, b.category === 'Dry' ? 'Dry media' : b.category)); lastCat = b.category; }
      const img = h('img', { class: 'brush-prev', alt: '', draggable: false });
      const active = app.brush.id === b.id;
      const item = h('button', { class: 'brush-item' + (active ? ' active' : ''), type: 'button', role: 'option', 'aria-selected': String(active), tip: { title: b.name, desc: b.description || 'Custom brush.' } },
        img, h('span', { class: 'brush-label' }, b.name));
      item.dataset.id = b.id;
      item.addEventListener('click', () => { app.selectBrush(b, slot); });
      item.addEventListener('dblclick', () => openBrushEditor());
      list.append(item);
      pending.push([img, b]);
    }
    // render previews progressively so the panel appears instantly
    const step = () => {
      if (gen !== queued) return;
      const next = pending.shift();
      if (!next) return;
      next[0].src = previewURL(next[1]);
      setTimeout(step, 0);
    };
    step();
  }
  let lastSlot = app.brushSlot;
  app.events.on('brush', () => {
    if (app.brushSlot !== lastSlot) { lastSlot = app.brushSlot; render(); return; }
    list.querySelectorAll<HTMLElement>('.brush-item').forEach((it) => {
      const on = it.dataset.id === app.brush.id;
      it.classList.toggle('active', on);
      it.setAttribute('aria-selected', String(on));
    });
  });
  refreshList = render;
  render();
  return el;
}
