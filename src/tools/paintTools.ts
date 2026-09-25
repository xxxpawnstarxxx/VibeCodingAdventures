// Brush, Eraser and Blend/Smudge tools - all drive the liquid paint engine.
import { app, type BrushSlot } from '../app/app';
import type { ToolEvent, Viewport } from '../app/viewport';
import { StrokeBuilder, type InputSample } from '../engine/stroke';
import { tipIndex, type StrokeParams } from '../engine/types';
import { h } from '../ui/dom';
import { button, slider } from '../ui/controls';
import { sampleColor, type Tool } from './tool';
import type { Layer } from '../core/layer';
import { confirmDialog } from '../ui/dialog';
import { addLayer, resizeDocument } from '../app/ops';
import { openBrushEditor } from '../features/brushEditor';

let lastPoint: InputSample | null = null;

export class PaintTool implements Tool {
  paints = true;
  private builder: StrokeBuilder | null = null;
  private layer: Layer | null = null;
  constructor(public id: string, public name: string, public icon: string, public key: string, public desc: string, public hint: string, private slot: BrushSlot) {}

  activate() { app.brushSlot = this.slot; app.applyTip(); app.events.emit('brush', undefined); }

  private params(layer: Layer): StrokeParams {
    const b = app.brush;
    return {
      mode: b.mode, opacity: b.opacity, wetness: b.wetness, viscosity: b.viscosity, pickup: b.pickup, load: b.load,
      transparency: b.transparency, wetEdge: b.wetEdge, impasto: b.impasto, grain: b.grain, grainScale: b.grainScale,
      bristles: b.bristles, tip: tipIndex(b.tip), settle: b.settle, spectral: app.settings.spectral, alphaLock: layer.alphaLock,
      seed: (Math.random() * 1e9) | 0,
    };
  }

  private checkLayer(): Layer | null {
    const l = app.doc.active;
    if (!l.visible) { app.toast(`"${l.name}" is hidden. Show it (eye icon) to paint on it.`, 'error'); return null; }
    if (l.locked) { app.toast(`"${l.name}" is locked. Unlock it in the Layers panel to paint.`, 'error'); return null; }
    if (l.kind === 'video') { app.toast('Video layers are for tracing. Paint on the animation layer above it.', 'error'); return null; }
    if (l.kind === 'image' && l.adjustments) {
      void confirmDialog('Paint on an image layer?',
        'This is an adjustable photo layer. Painting on it will make its current adjustments permanent. Most people paint on a new layer above instead, so the photo stays adjustable.',
        'Paint on a new layer', 'Cancel', { label: 'Make permanent & paint', value: 'raster' }).then((r) => {
        if (r === 'ok') { addLayer(undefined, app.doc.indexOf(l) + 1, 'New layer'); app.toast('New layer added - paint away!', 'success'); }
        if (r === 'raster') { l.kind = 'paint'; l.source = undefined; l.adjustments = undefined; app.doc.events.emit('structure', undefined); }
      });
      return null;
    }
    return l;
  }

  down(e: ToolEvent): void {
    if (e.alt && this.slot !== 'eraser') { app.tools.pickColorAt(e, false); return; }
    const layer = this.checkLayer();
    if (!layer) return;
    const doc = app.doc;
    const m = app.brush.size + 64;
    if (doc.infinite && (e.x < m || e.y < m || e.x > doc.width - m || e.y > doc.height - m)) {
      this.layer = layer;
      void this.ensureRoom(e).then(() => {
        if (this.layer !== layer) return;
        const p = app.view.toDoc(e.sx, e.sy);
        this.start(layer, { ...e, x: p.x, y: p.y });
      });
      return;
    }
    this.start(layer, e);
  }

  private newBuilder(e: ToolEvent): StrokeBuilder {
    return new StrokeBuilder({
      brush: app.brush, color: app.color, color2: app.color2, stabilizer: app.settings.stabilizer, symmetry: app.settings.symmetry,
      guides: app.settings.guides, zoom: app.view.view.zoom, isPen: e.isPen, pressureGamma: app.settings.pressureGamma,
    });
  }

  private start(layer: Layer, e: ToolEvent): void {
    this.layer = layer;
    const b = app.brush;
    this.builder = this.newBuilder(e);
    const label = b.mode === 'erase' ? 'Erase' : b.mode === 'paint' ? `${b.name} stroke` : b.name;
    app.backend.beginStroke(layer, this.params(layer), app.doc.selection.mask, label);
    if (e.shift && lastPoint) {
      // straight line from the previous stroke's end
      const a = lastPoint;
      const n = Math.max(2, Math.ceil(Math.hypot(e.x - a.x, e.y - a.y) / 2));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        app.backend.addDabs(this.builder.push({ x: a.x + (e.x - a.x) * t, y: a.y + (e.y - a.y) * t, p: a.p + (e.p - a.p) * t, tiltX: e.tiltX, tiltY: e.tiltY, t: e.t + i }));
      }
    } else {
      app.backend.addDabs(this.builder.push(e));
    }
    lastPoint = e;
    if (b.mode === 'paint') app.pushRecent();
  }

  /** Infinite canvas: grow the document when painting near its edge. */
  private async ensureRoom(e: { x: number; y: number }): Promise<boolean> {
    const doc = app.doc;
    if (!doc.infinite) return false;
    const m = app.brush.size + 64;
    const grow = 1024;
    let l = 0, t = 0, r = 0, b = 0;
    if (e.x < m) l = grow;
    if (e.y < m) t = grow;
    if (e.x > doc.width - m) r = grow;
    if (e.y > doc.height - m) b = grow;
    if (!(l || t || r || b)) return false;
    if (doc.width + l + r > 16384 || doc.height + t + b > 16384) return false;
    await resizeDocument(doc.width + l + r, doc.height + t + b, l, t, false, 'Expand canvas');
    app.view.shiftForResize(l, t);
    return true;
  }

  move(e: ToolEvent): void {
    if (!this.builder) return;
    const dabs = [];
    for (const s of e.samples) dabs.push(...this.builder.push(s));
    app.backend.addDabs(dabs);
    lastPoint = e;
    const doc = app.doc;
    if (doc.infinite) {
      const m = app.brush.size / 2 + 8;
      if (e.x < m || e.y < m || e.x > doc.width - m || e.y > doc.height - m) {
        // split the stroke, grow the canvas, continue
        const builder = this.builder;
        this.builder = null;
        app.backend.addDabs(builder.finish());
        app.backend.endStroke();
        const layer = this.layer;
        void (async () => {
          await app.backend.flush();
          const grew = await this.ensureRoom(e);
          if (!layer || this.layer !== layer) return;
          const pt = grew ? app.view.toDoc(e.sx, e.sy) : e;
          this.start(layer, { ...e, x: pt.x, y: pt.y, shift: false });
        })();
      }
    }
  }

  up(e: ToolEvent): void {
    if (!this.builder) { this.layer = null; return; }
    app.backend.addDabs(this.builder.finish());
    app.backend.endStroke();
    this.builder = null;
    this.layer = null;
    lastPoint = e;
  }

  cancel(): void { this.up({} as ToolEvent); }

  drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport): void {
    if (!vp.hover || !lastPoint || this.builder) return;
    // show a straight-line preview while Shift is held
    if (!(window as any).__shiftHeld) return;
    vp.docTransform(ctx);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1 / vp.view.zoom;
    ctx.setLineDash([4 / vp.view.zoom, 4 / vp.view.zoom]);
    ctx.beginPath(); ctx.moveTo(lastPoint.x, lastPoint.y); ctx.lineTo(vp.hover.x, vp.hover.y); ctx.stroke();
  }

  options(): HTMLElement {
    const b = app.brush;
    const wrap = h('div', { class: 'opts' });
    const name = h('button', { class: 'brush-name', type: 'button', tip: { title: 'Brush', desc: 'Current brush. Click to edit every setting or create your own brush.' } }, b.name);
    name.addEventListener('click', () => openBrushEditor());
    wrap.append(name);
    const sl = (key: 'size' | 'opacity' | 'flow' | 'wetness' | 'pickup' | 'viscosity', label: string, tip: string, min: number, max: number, percent = true, curve = 1) =>
      slider({ label, tip, min, max, value: b[key] as number, percent, unit: percent ? undefined : 'px', compact: true, curve, step: percent ? 0.01 : 1,
        onInput: (v) => { (app.brush as any)[key] = v; app.events.emit('brush', undefined); } });
    wrap.append(sl('size', 'Size', 'Brush size in pixels. Shortcut: [ and ]', 1, 600, false, 2.2));
    if (this.slot === 'brush') {
      wrap.append(sl('opacity', 'Opacity', 'How see-through each stroke is.', 0, 1));
      wrap.append(sl('flow', 'Flow', 'How fast paint builds up while you drag.', 0.01, 1));
      wrap.append(sl('wetness', 'Water', 'More water = paint flows, softens and blends by itself.', 0, 1));
      wrap.append(sl('pickup', 'Mixing', 'How much the brush mixes with colours already on the canvas.', 0, 1));
      wrap.append(sl('viscosity', 'Thickness', 'Runny (low) or thick like oil (high).', 0, 1));
    } else if (this.slot === 'eraser') {
      wrap.append(sl('opacity', 'Strength', 'How much paint is removed per stroke.', 0, 1));
      wrap.append(sl('flow', 'Flow', 'How fast erasing builds up.', 0.01, 1));
    } else {
      wrap.append(sl('flow', 'Strength', 'How strongly paint is moved.', 0.01, 1));
      wrap.append(sl('pickup', 'Drag distance', 'How far colours are dragged along.', 0, 1));
    }
    wrap.append(button('Brush settings', { icon: 'settings', small: true, tip: { title: 'Brush settings', desc: 'Open the full brush editor: shape, texture, liquid physics, rainbow colours, custom tips. Save your own brushes.' }, onClick: () => openBrushEditor() }));
    return wrap;
  }
}

export function makePaintTools(): Tool[] {
  return [
    new PaintTool('brush', 'Brush', 'brush', 'B', 'Paint with realistic liquid paint. Pick a brush (watercolour, oil, ink…) in the Brushes panel.', 'Drag to paint · Shift+click: straight line · Alt+click or right-click: pick colour · [ ] size', 'brush'),
    new PaintTool('eraser', 'Eraser', 'eraser', 'E', 'Remove paint from the current layer. Soft, hard and "lift paint" erasers are in the Brushes panel.', 'Drag to erase · Shift+click: straight line · [ ] size', 'eraser'),
    new PaintTool('smudge', 'Blend', 'smudge', 'S', 'Smudge and blend colours that are already painted, like using your finger or a dry brush.', 'Drag across colours to blend them · [ ] size', 'smudge'),
  ];
}

export function pickAt(p: { x: number; y: number }, secondary: boolean): void {
  const c = sampleColor(p.x, p.y, true, 3);
  if (c) app.setColor(c, secondary);
}
