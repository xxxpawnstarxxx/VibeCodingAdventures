// Reference board: pin images as floating windows over the workspace. Zoom/pan inside them, flip,
// greyscale (to judge values), adjust opacity, pick colours from them, or drop them into the painting.
import { app } from '../app/app';
import { h, svgIcon } from '../ui/dom';
import { icon } from '../ui/icons';
import { pickFile } from '../ui/dialog';
import { addImageLayer } from './adjust';

interface RefWin {
  id: number; el: HTMLElement; img: HTMLImageElement; src: string; name: string;
  x: number; y: number; w: number; h: number; zoom: number; px: number; py: number;
  flip: boolean; gray: boolean; opacity: number; picking: boolean; collapsed: boolean;
}

let nextId = 1;
let host: HTMLElement;

class References {
  wins: RefWin[] = [];

  init(parent: HTMLElement) { host = parent; }

  async addFromFile(): Promise<void> {
    const files = await pickFile('image/*', true);
    for (const f of files) await this.addBlob(f, f.name);
  }

  async addBlob(b: Blob, name: string): Promise<void> {
    const url = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(b); });
    this.add(url, name);
  }

  addCanvasSnapshot(): void {
    const c = app.doc.flatten({ scale: Math.min(1, 1600 / Math.max(app.doc.width, app.doc.height)) });
    this.add(c.toDataURL('image/jpeg', 0.9), 'Snapshot ' + new Date().toLocaleTimeString());
  }

  add(src: string, name: string, state?: Partial<RefWin>): RefWin {
    const img = h('img', { class: 'ref-img', src, alt: name, draggable: false });
    const body = h('div', { class: 'ref-body' }, img);
    const title = h('div', { class: 'ref-title', tip: { title: 'Reference: ' + name, desc: 'Drag the title bar to move. Scroll inside to zoom, drag to pan. Drag the corner to resize.' } }, svgIcon(icon('pin')), h('span', null, name));
    const btn = (ic: string, label: string, desc: string, fn: () => void, toggleable = false) => {
      const b = h('button', { class: 'ref-btn', type: 'button', tip: { title: label, desc } }, svgIcon(icon(ic)));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); if (toggleable) b.classList.toggle('on'); });
      return b;
    };
    const opacity = h('input', { type: 'range', min: 10, max: 100, value: 100, class: 'ref-op', 'aria-label': 'Reference opacity', title: 'Opacity' });
    const tools = h('div', { class: 'ref-tools' },
      btn('eyedropper', 'Pick colour', 'Click in the reference to take its colour as your main colour.', () => { w.picking = !w.picking; el.classList.toggle('picking', w.picking); }, true),
      btn('flip', 'Flip', 'Mirror the reference - a classic trick to spot mistakes.', () => { w.flip = !w.flip; this.apply(w); }, true),
      btn('filter', 'Values (greyscale)', 'Show in greyscale to compare light and dark values without colour.', () => { w.gray = !w.gray; this.apply(w); }, true),
      btn('fit', 'Fit', 'Reset zoom and pan.', () => { w.zoom = 1; w.px = 0; w.py = 0; this.apply(w); }),
      btn('layers', 'Place in painting', 'Add this image as a new adjustable photo layer (e.g. to trace over).', () => { const im = new Image(); im.onload = () => addImageLayer(im, name); im.src = src; }),
      opacity,
      btn('minus', 'Collapse', 'Shrink to just the title bar.', () => { w.collapsed = !w.collapsed; el.classList.toggle('collapsed', w.collapsed); }),
      btn('close', 'Unpin', 'Remove this reference.', () => this.remove(w)),
    );
    const resize = h('div', { class: 'ref-resize', tip: 'Drag to resize' });
    const el = h('div', { class: 'ref-window', 'data-tip-side': 'top' }, title, tools, body, resize);
    const w: RefWin = { id: nextId++, el, img, src, name, x: 80 + (this.wins.length % 5) * 30, y: 80 + (this.wins.length % 5) * 30, w: 320, h: 260, zoom: 1, px: 0, py: 0, flip: false, gray: false, opacity: 1, picking: false, collapsed: false, ...state };
    opacity.value = String(Math.round(w.opacity * 100));
    opacity.addEventListener('input', () => { w.opacity = Number(opacity.value) / 100; this.apply(w); });
    opacity.addEventListener('pointerdown', (e) => e.stopPropagation());
    img.onload = () => {
      if (!state) { const ar = img.naturalWidth / img.naturalHeight; w.h = Math.round(w.w / ar) + 58; }
      this.apply(w);
    };
    // drag window
    title.addEventListener('pointerdown', (e) => {
      title.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, x0 = w.x, y0 = w.y;
      const mv = (ev: PointerEvent) => { w.x = x0 + ev.clientX - sx; w.y = y0 + ev.clientY - sy; this.apply(w); };
      const up = () => { title.removeEventListener('pointermove', mv); title.removeEventListener('pointerup', up); };
      title.addEventListener('pointermove', mv); title.addEventListener('pointerup', up);
      this.bringToFront(w);
    });
    resize.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      resize.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, w0 = w.w, h0 = w.h;
      const mv = (ev: PointerEvent) => { w.w = Math.max(180, w0 + ev.clientX - sx); w.h = Math.max(120, h0 + ev.clientY - sy); this.apply(w); };
      const up = () => { resize.removeEventListener('pointermove', mv); resize.removeEventListener('pointerup', up); };
      resize.addEventListener('pointermove', mv); resize.addEventListener('pointerup', up);
    });
    // pan / pick inside
    body.addEventListener('pointerdown', (e) => {
      this.bringToFront(w);
      if (w.picking) { this.pick(w, e); return; }
      body.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY, x0 = w.px, y0 = w.py;
      const mv = (ev: PointerEvent) => { w.px = x0 + ev.clientX - sx; w.py = y0 + ev.clientY - sy; this.apply(w); };
      const up = () => { body.removeEventListener('pointermove', mv); body.removeEventListener('pointerup', up); };
      body.addEventListener('pointermove', mv); body.addEventListener('pointerup', up);
    });
    body.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = body.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
      const z = Math.max(0.2, Math.min(20, w.zoom * Math.exp(-e.deltaY * 0.002)));
      w.px = mx - ((mx - w.px) * z) / w.zoom; w.py = my - ((my - w.py) * z) / w.zoom;
      w.zoom = z; this.apply(w);
    }, { passive: false });
    host.append(el);
    this.wins.push(w);
    this.apply(w);
    app.toast(`Pinned "${name}" as a reference.`, 'success');
    return w;
  }

  private pick(w: RefWin, e: PointerEvent) {
    const r = w.img.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    const iu = w.flip ? 1 - u : u;
    x.drawImage(w.img, Math.floor(iu * w.img.naturalWidth), Math.floor(v * w.img.naturalHeight), 1, 1, 0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    app.setColor([d[0] / 255, d[1] / 255, d[2] / 255], e.altKey);
    app.pushRecent();
  }

  private bringToFront(w: RefWin) { host.append(w.el); }

  apply(w: RefWin) {
    Object.assign(w.el.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.collapsed ? '' : w.h + 'px', opacity: String(w.opacity) });
    w.img.style.transform = `translate(${w.px}px, ${w.py}px) scale(${w.zoom * (w.flip ? -1 : 1)}, ${w.zoom})`;
    w.img.style.filter = w.gray ? 'grayscale(1)' : '';
  }

  remove(w: RefWin) { w.el.remove(); this.wins = this.wins.filter((x) => x !== w); }
  clear() { [...this.wins].forEach((w) => this.remove(w)); }

  async serialize(_asBlobs: boolean): Promise<unknown> {
    return this.wins.map((w) => ({ src: w.src, name: w.name, x: w.x, y: w.y, w: w.w, h: w.h, zoom: w.zoom, px: w.px, py: w.py, flip: w.flip, gray: w.gray, opacity: w.opacity }));
  }
  async deserialize(data: unknown): Promise<void> {
    this.clear();
    if (!Array.isArray(data)) return;
    for (const d of data) this.add(d.src, d.name, d);
  }
}

export const references = new References();
