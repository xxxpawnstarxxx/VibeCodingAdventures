// The painting viewport: view transform, input routing, overlay drawing and the render loop.
import { app } from './app';
import type { Pt } from '../core/geom';
import type { PaintBackend, View } from '../engine/types';
import type { InputSample } from '../engine/stroke';
import { symmetryTransforms } from '../engine/stroke';
import { h } from '../ui/dom';

export interface ToolEvent extends InputSample {
  sx: number; sy: number;
  shift: boolean; alt: boolean; ctrl: boolean;
  button: number;
  pointerType: string;
  samples: InputSample[];
  isPen: boolean;
}

export type OverlayHook = (ctx: CanvasRenderingContext2D, vp: Viewport) => void;

export class Viewport {
  readonly el: HTMLElement;
  readonly overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  view: View = { x: 0, y: 0, zoom: 1, rotation: 0 };
  width = 1;
  height = 1;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  private backend: PaintBackend | null = null;
  private dirty = true;
  private overlayDirty = true;
  hover: Pt | null = null;
  hoverScreen: Pt | null = null;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private gesture: { startDist: number; startAngle: number; startView: View; mid: Pt; docMid: Pt } | null = null;
  private panning: { x: number; y: number; view: View } | null = null;
  private rotating: { angle0: number; view: View } | null = null;
  private drawingPointer: number | null = null;
  private spaceDown = false;
  private rDown = false;
  private symDrag = false;
  overlayHooks: OverlayHook[] = [];
  underHooks: OverlayHook[] = [];
  exclude = new Set<number>();
  lastPointerType = 'mouse';

  constructor(parent: HTMLElement) {
    this.el = h('section', { class: 'viewport', tabIndex: 0, 'aria-label': 'Canvas' });
    this.overlay = h('canvas', { class: 'overlay' });
    this.octx = this.overlay.getContext('2d')!;
    this.el.append(this.overlay);
    parent.append(this.el);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindInput();
    const loop = () => { this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; this.updateCursor(); if (e.target === document.body || this.el.contains(e.target as Node)) e.preventDefault(); }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !isTyping(e)) { this.rDown = true; }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); }
      if (e.key === 'r') this.rDown = false;
    });
    window.addEventListener('blur', () => { this.spaceDown = false; this.rDown = false; });
  }

  attachBackend(b: PaintBackend): void {
    this.backend?.canvas.remove();
    this.backend = b;
    this.el.prepend(b.canvas);
    b.onChange = () => { this.dirty = true; };
    this.dirty = true;
  }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    const first = this.width <= 1;
    this.width = Math.max(1, r.width); this.height = Math.max(1, r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.overlay.width = Math.round(this.width * this.dpr);
    this.overlay.height = Math.round(this.height * this.dpr);
    if (first && app.doc) this.fit();
    this.requestRender();
  }

  requestRender(): void { this.dirty = true; this.overlayDirty = true; }
  requestOverlay(): void { this.overlayDirty = true; }

  // ------------------------------------------------------------------ transforms
  toDoc(sx: number, sy: number): Pt {
    const { x, y, zoom, rotation } = this.view;
    const dx = sx - x, dy = sy - y;
    const c = Math.cos(-rotation), s = Math.sin(-rotation);
    return { x: (dx * c - dy * s) / zoom, y: (dx * s + dy * c) / zoom };
  }
  toScreen(px: number, py: number): Pt {
    const { x, y, zoom, rotation } = this.view;
    const c = Math.cos(rotation), s = Math.sin(rotation);
    return { x: x + (px * c - py * s) * zoom, y: y + (px * s + py * c) * zoom };
  }

  fit(): void {
    const d = app.doc;
    const pad = 48;
    const z = Math.min((this.width - pad * 2) / d.width, (this.height - pad * 2) / d.height);
    this.view.zoom = Math.max(0.02, Math.min(8, z));
    this.view.rotation = 0;
    this.view.x = (this.width - d.width * this.view.zoom) / 2;
    this.view.y = (this.height - d.height * this.view.zoom) / 2;
    this.changed();
  }

  zoomAt(z: number, sx = this.width / 2, sy = this.height / 2): void {
    z = Math.max(0.02, Math.min(64, z));
    const p = this.toDoc(sx, sy);
    this.view.zoom = z;
    const s = this.toScreen(p.x, p.y);
    this.view.x += sx - s.x; this.view.y += sy - s.y;
    this.changed();
  }

  setRotation(r: number, sx = this.width / 2, sy = this.height / 2): void {
    const p = this.toDoc(sx, sy);
    this.view.rotation = r;
    const s = this.toScreen(p.x, p.y);
    this.view.x += sx - s.x; this.view.y += sy - s.y;
    this.changed();
  }

  /** Keep content fixed on screen after the canvas grew by (dx,dy) on the top/left. */
  shiftForResize(dx: number, dy: number): void {
    const c = Math.cos(this.view.rotation), s = Math.sin(this.view.rotation);
    this.view.x -= (dx * c - dy * s) * this.view.zoom;
    this.view.y -= (dx * s + dy * c) * this.view.zoom;
    this.changed();
  }

  private changed(): void { this.requestRender(); app.events.emit('view', undefined); }

  // ------------------------------------------------------------------ input
  private sample(e: PointerEvent): InputSample {
    const r = this.el.getBoundingClientRect();
    const p = this.toDoc(e.clientX - r.left, e.clientY - r.top);
    const isPen = e.pointerType === 'pen';
    return { x: p.x, y: p.y, p: isPen ? e.pressure : e.pointerType === 'touch' ? (e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 1) : 1, tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, t: e.timeStamp };
  }

  private toolEvent(e: PointerEvent, samples?: InputSample[]): ToolEvent {
    const r = this.el.getBoundingClientRect();
    const s = this.sample(e);
    return {
      ...s, sx: e.clientX - r.left, sy: e.clientY - r.top, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey,
      button: e.button, pointerType: e.pointerType, samples: samples ?? [s], isPen: e.pointerType === 'pen',
    };
  }

  private bindInput(): void {
    const el = this.el;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.focus({ preventScroll: true });
      this.lastPointerType = e.pointerType;
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      this.pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
      el.setPointerCapture(e.pointerId);
      const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (touches.length >= 2) {
        // two-finger pinch/rotate/pan; cancel any stroke started by the first finger
        if (this.drawingPointer !== null) { app.tools.cancel(); this.drawingPointer = null; }
        this.startGesture();
        return;
      }
      if (e.button === 1 || this.spaceDown || (e.pointerType === 'touch' && app.settings.penOnlyDrawing) || app.tools.current.id === 'hand') {
        this.panning = { x: sx, y: sy, view: { ...this.view } };
        this.updateCursor();
        return;
      }
      if (this.rDown) { this.rotating = { angle0: Math.atan2(sy - this.height / 2, sx - this.width / 2), view: { ...this.view } }; return; }
      if (e.button === 2 && app.tools.current.paints) { app.tools.pickColorAt(this.toDoc(sx, sy), e.altKey); return; }
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // drag symmetry centre
      const sym = app.settings.symmetry;
      if (sym.mode !== 'off') {
        const c = this.toScreen(sym.cx, sym.cy);
        if (Math.hypot(c.x - sx, c.y - sy) < 12) { this.symDrag = true; return; }
      }
      this.drawingPointer = e.pointerId;
      app.tools.down(this.toolEvent(e));
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const ptr = this.pointers.get(e.pointerId);
      if (ptr) { ptr.x = sx; ptr.y = sy; }
      this.hoverScreen = { x: sx, y: sy };
      this.hover = this.toDoc(sx, sy);
      this.overlayDirty = true;
      app.events.emit('status', '');
      if (this.gesture) { this.updateGesture(); return; }
      if (this.panning) {
        this.view.x = this.panning.view.x + sx - this.panning.x;
        this.view.y = this.panning.view.y + sy - this.panning.y;
        this.changed();
        return;
      }
      if (this.rotating) {
        const a = Math.atan2(sy - this.height / 2, sx - this.width / 2);
        this.view = { ...this.rotating.view };
        let rot = this.rotating.view.rotation + a - this.rotating.angle0;
        if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
        this.setRotation(rot);
        return;
      }
      if (this.symDrag) {
        const p = this.toDoc(sx, sy);
        app.settings.symmetry.cx = Math.round(p.x); app.settings.symmetry.cy = Math.round(p.y);
        this.overlayDirty = true;
        return;
      }
      if (this.drawingPointer === e.pointerId) {
        const co = (e as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
        const samples = co && co.length ? co.map((c) => this.sample(c)) : [this.sample(e)];
        app.tools.move(this.toolEvent(e, samples));
      } else if (!this.pointers.size || e.pointerType !== 'touch') {
        app.tools.hover(this.toolEvent(e));
      }
    });
    const end = (e: PointerEvent, cancelled = false) => {
      this.pointers.delete(e.pointerId);
      if (this.gesture) { if (this.pointers.size < 2) this.gesture = null; return; }
      if (this.panning) { this.panning = null; this.updateCursor(); return; }
      if (this.rotating) { this.rotating = null; return; }
      if (this.symDrag) { this.symDrag = false; app.saveSettings(); return; }
      if (this.drawingPointer === e.pointerId) {
        this.drawingPointer = null;
        if (cancelled) app.tools.cancel(); else app.tools.up(this.toolEvent(e));
      }
    };
    el.addEventListener('pointerup', (e) => end(e));
    el.addEventListener('pointercancel', (e) => end(e, true));
    el.addEventListener('pointerleave', () => { this.hover = null; this.overlayDirty = true; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (e.shiftKey && !e.ctrlKey) { this.view.x -= e.deltaY; this.changed(); return; }
      if (e.altKey) { this.setRotation(this.view.rotation + Math.sign(e.deltaY) * (Math.PI / 36), sx, sy); return; }
      const k = e.deltaMode === 1 ? 0.05 : 0.0022;
      this.zoomAt(this.view.zoom * Math.exp(-e.deltaY * k * (e.ctrlKey ? 2.5 : 1)), sx, sy);
    }, { passive: false });
  }

  private startGesture(): void {
    const t = [...this.pointers.values()].filter((p) => p.type === 'touch');
    const [a, b] = t;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.gesture = { startDist: Math.hypot(b.x - a.x, b.y - a.y), startAngle: Math.atan2(b.y - a.y, b.x - a.x), startView: { ...this.view }, mid, docMid: this.toDoc(mid.x, mid.y) };
  }

  private updateGesture(): void {
    const g = this.gesture!;
    const t = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (t.length < 2) return;
    const [a, b] = t;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, g.startDist);
    let rot = Math.atan2(b.y - a.y, b.x - a.x) - g.startAngle;
    if (Math.abs(rot) < 0.08) rot = 0; // small dead zone so pinch-zoom doesn't wobble the canvas
    this.view = { ...g.startView, zoom: Math.max(0.02, Math.min(64, g.startView.zoom * scale)), rotation: g.startView.rotation + rot };
    const s = this.toScreen(g.docMid.x, g.docMid.y);
    this.view.x += mid.x - s.x; this.view.y += mid.y - s.y;
    this.changed();
  }

  updateCursor(): void {
    const t = app.tools?.current;
    this.el.style.cursor = this.panning ? 'grabbing' : this.spaceDown ? 'grab' : t?.cursor ?? (t?.paints && app.settings.showBrushCursor ? 'none' : 'crosshair');
  }

  // ------------------------------------------------------------------ rendering
  private frame(): void {
    if (!this.backend || !app.doc) return;
    if (this.dirty || this.backend.animating) {
      this.dirty = false;
      this.backend.render({ view: this.view, width: this.width, height: this.height, dpr: this.dpr, showPaper: app.settings.showPaper, pixelGrid: app.settings.pixelGrid, exclude: this.exclude });
      this.overlayDirty = true;
    }
    const ants = !!app.doc.selection.outline;
    if (this.overlayDirty || ants) { this.overlayDirty = false; this.drawOverlay(); }
  }

  /** Transform ctx so drawing uses document coordinates. */
  docTransform(ctx: CanvasRenderingContext2D): void {
    const { x, y, zoom, rotation } = this.view;
    const d = this.dpr;
    const c = Math.cos(rotation) * zoom * d, s = Math.sin(rotation) * zoom * d;
    ctx.setTransform(c, s, -s, c, x * d, y * d);
  }
  screenTransform(ctx: CanvasRenderingContext2D): void { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

  private drawOverlay(): void {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const doc = app.doc;
    const px = 1 / this.view.zoom;
    for (const hook of this.underHooks) { ctx.save(); hook(ctx, this); ctx.restore(); }
    // document border
    this.docTransform(ctx);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = px;
    ctx.strokeRect(0, 0, doc.width, doc.height);
    if (doc.infinite) {
      ctx.setLineDash([6 * px, 6 * px]);
      ctx.strokeStyle = 'rgba(120,160,255,0.6)';
      ctx.strokeRect(-px * 3, -px * 3, doc.width + px * 6, doc.height + px * 6);
      ctx.setLineDash([]);
    }
    this.drawGuides(ctx);
    // selection marching ants
    const outline = doc.selection.outline;
    if (outline) {
      const off = (performance.now() / 60) % 8;
      ctx.lineWidth = px;
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -off * px;
      ctx.stroke(outline);
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = (-off + 4) * px;
      ctx.stroke(outline);
      ctx.setLineDash([]);
    }
    this.drawSymmetry(ctx);
    for (const hook of this.overlayHooks) { ctx.save(); hook(ctx, this); ctx.restore(); }
    ctx.save();
    app.tools.current.drawOverlay?.(ctx, this);
    ctx.restore();
    this.drawBrushCursor(ctx);
  }

  private drawSymmetry(ctx: CanvasRenderingContext2D): void {
    const s = app.settings.symmetry;
    if (s.mode === 'off') return;
    const px = 1 / this.view.zoom;
    const L = Math.max(app.doc.width, app.doc.height) * 2;
    this.docTransform(ctx);
    ctx.strokeStyle = 'rgba(255,90,160,0.75)';
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([8 * px, 5 * px]);
    ctx.beginPath();
    const axes: number[] = [];
    if (s.mode === 'vertical' || s.mode === 'quad') axes.push(Math.PI / 2);
    if (s.mode === 'horizontal' || s.mode === 'quad') axes.push(0);
    if (s.mode === 'radial') { const n = Math.max(2, Math.round(s.count)); for (let i = 0; i < n; i++) axes.push((i / n) * Math.PI * 2 - Math.PI / 2); }
    for (const a of axes) {
      const dx = Math.cos(a) * L, dy = Math.sin(a) * L;
      if (s.mode === 'radial') { ctx.moveTo(s.cx, s.cy); ctx.lineTo(s.cx + dx, s.cy + dy); }
      else { ctx.moveTo(s.cx - dx, s.cy - dy); ctx.lineTo(s.cx + dx, s.cy + dy); }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,90,160,0.95)';
    ctx.beginPath(); ctx.arc(s.cx, s.cy, 6 * px, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * px; ctx.stroke();
  }

  private drawGuides(ctx: CanvasRenderingContext2D): void {
    const g = app.settings.guides;
    const px = 1 / this.view.zoom;
    const doc = app.doc;
    if (g.showGrid && g.gridSize > 1) {
      ctx.strokeStyle = 'rgba(80,140,255,0.22)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = g.gridSize; x < doc.width; x += g.gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, doc.height); }
      for (let y = g.gridSize; y < doc.height; y += g.gridSize) { ctx.moveTo(0, y); ctx.lineTo(doc.width, y); }
      ctx.stroke();
    }
    if (!g.enabled && app.tools.current.id !== 'guides') return;
    const L = Math.max(doc.width, doc.height) * 3;
    ctx.lineWidth = 1.2 * px;
    for (const r of g.rulers) {
      const dx = r.b.x - r.a.x, dy = r.b.y - r.a.y, d = Math.hypot(dx, dy) || 1;
      ctx.strokeStyle = 'rgba(0,200,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(r.a.x - (dx / d) * L, r.a.y - (dy / d) * L);
      ctx.lineTo(r.a.x + (dx / d) * L, r.a.y + (dy / d) * L);
      ctx.stroke();
      for (const p of [r.a, r.b]) { ctx.fillStyle = '#00c8ff'; ctx.beginPath(); ctx.arc(p.x, p.y, 5 * px, 0, Math.PI * 2); ctx.fill(); }
    }
    g.perspective.forEach((vp, i) => {
      ctx.strokeStyle = ['rgba(255,170,0,0.35)', 'rgba(0,220,140,0.35)', 'rgba(200,120,255,0.35)'][i % 3];
      ctx.beginPath();
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        ctx.moveTo(vp.x, vp.y); ctx.lineTo(vp.x + Math.cos(a) * L, vp.y + Math.sin(a) * L);
      }
      ctx.stroke();
      ctx.fillStyle = ['#ffaa00', '#00dc8c', '#c878ff'][i % 3];
      ctx.beginPath(); ctx.arc(vp.x, vp.y, 7 * px, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * px; ctx.stroke(); ctx.lineWidth = 1.2 * px;
    });
    if (g.perspective.length >= 2) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.setLineDash([10 * px, 6 * px]);
      ctx.beginPath(); ctx.moveTo(g.perspective[0].x, g.perspective[0].y); ctx.lineTo(g.perspective[1].x, g.perspective[1].y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawBrushCursor(ctx: CanvasRenderingContext2D): void {
    const t = app.tools.current;
    if (!t.paints || !this.hover || !app.settings.showBrushCursor || this.lastPointerType === 'touch') return;
    const b = app.brush;
    const r = b.size / 2;
    this.docTransform(ctx);
    const px = 1 / this.view.zoom;
    const transforms = symmetryTransforms(app.settings.symmetry);
    transforms.forEach((tf, i) => {
      const p = tf(this.hover!);
      ctx.save();
      ctx.translate(p.x, p.y);
      if (b.angleMode === 'fixed') ctx.rotate((b.angle * Math.PI) / 180);
      ctx.beginPath();
      const ry = r, rx = b.tip === 'round' || b.angleMode !== 'fixed' ? r : r * b.roundness;
      ctx.ellipse(0, 0, Math.max(px, rx), Math.max(px, ry), 0, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * px; ctx.strokeStyle = i ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.55)'; ctx.stroke();
      ctx.lineWidth = 1.2 * px; ctx.strokeStyle = i ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.95)'; ctx.stroke();
      ctx.restore();
    });
    // crosshair dot
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(this.hover.x - px, this.hover.y - px, 2 * px, 2 * px);
  }
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
