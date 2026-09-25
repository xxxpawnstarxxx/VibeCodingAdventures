// Paint bucket, gradient and colour picker tools.
import { app } from '../app/app';
import type { ToolEvent, Viewport } from '../app/viewport';
import { editPixels } from '../app/ops';
import { floodFillMask } from '../wasm/wasm';
import { h } from '../ui/dom';
import { segmented, select, slider, toggle } from '../ui/controls';
import { sampleColor, type Tool } from './tool';
import { clamp, cssRgb, hsvToRgb, kmMix, mixOklab, rgbToHex, rgbToHsv, type RGB } from '../core/color';
import { ctx2d, makeCanvas } from '../core/layer';

// ---------------------------------------------------------------------------------------- bucket
const fillOpts = { tolerance: 32, contiguous: true, allLayers: true, expand: 1, fillWith: 'color' as 'color' | 'rainbow' | 'secondary' };

async function bucketFill(x: number, y: number): Promise<void> {
  const doc = app.doc;
  const layer = doc.active;
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  await app.backend.flush();
  const src = fillOpts.allLayers ? doc.flatten({ background: false }) : layer.canvas;
  const img = ctx2d(src).getImageData(0, 0, doc.width, doc.height);
  const mask = floodFillMask(img, x, y, fillOpts.tolerance, fillOpts.contiguous);
  // grow by a pixel or two so fills tuck under anti-aliased line art (no white halos)
  const W = doc.width, H = doc.height;
  for (let pass = 0; pass < fillOpts.expand; pass++) {
    const m2 = mask.slice();
    for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (!mask[k] && (mask[k - 1] || mask[k + 1] || mask[k - W] || mask[k + W])) m2[k] = 255;
    }
    mask.set(m2);
  }
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (mask[j * W + i]) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; y1 = j; }
  if (x1 < 0) return;
  const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const tmp = makeCanvas(rect.w, rect.h);
  const t = ctx2d(tmp);
  const out = t.createImageData(rect.w, rect.h);
  const col = fillOpts.fillWith === 'secondary' ? app.color2 : app.color;
  const [h0, s0, v0] = rgbToHsv(col);
  for (let j = 0; j < rect.h; j++) for (let i = 0; i < rect.w; i++) {
    const m = mask[(rect.y + j) * W + rect.x + i];
    if (!m) continue;
    let c = col;
    if (fillOpts.fillWith === 'rainbow') c = hsvToRgb(h0 + ((i + j) / Math.max(rect.w, rect.h)) * 360, Math.max(0.6, s0), Math.max(0.8, v0));
    const o = (j * rect.w + i) * 4;
    out.data[o] = c[0] * 255; out.data[o + 1] = c[1] * 255; out.data[o + 2] = c[2] * 255; out.data[o + 3] = m;
  }
  t.putImageData(out, 0, 0);
  await editPixels(layer, rect, 'Fill', 'bucket', (ctx) => { ctx.drawImage(tmp, rect.x, rect.y); });
  app.pushRecent();
}

export const bucketTool: Tool = {
  id: 'fill', name: 'Fill', icon: 'bucket', key: 'G',
  desc: 'Paint bucket: fills an enclosed area with colour. Great for flat colouring inside line art.',
  hint: 'Click inside an area to fill it · Tolerance decides how similar colours must be',
  cursor: 'crosshair',
  down(e) {
    if (e.alt) { app.tools.pickColorAt(e, false); return; }
    void bucketFill(Math.floor(e.x), Math.floor(e.y));
  },
  options() {
    return h('div', { class: 'opts' },
      slider({ label: 'Tolerance', tip: 'How different a colour can be and still get filled. Low = only the exact colour; high = similar colours too.', min: 0, max: 255, step: 1, value: fillOpts.tolerance, compact: true, onInput: (v) => (fillOpts.tolerance = v) }),
      slider({ label: 'Grow edge', tip: 'Expands the fill under anti-aliased outlines so no light fringe remains.', min: 0, max: 4, step: 1, value: fillOpts.expand, unit: 'px', compact: true, onInput: (v) => (fillOpts.expand = v) }),
      toggle('Only connected area', fillOpts.contiguous, (v) => (fillOpts.contiguous = v), 'On: fill only the touching area. Off: replace that colour everywhere.'),
      toggle('Look at all layers', fillOpts.allLayers, (v) => (fillOpts.allLayers = v), 'On: outlines on other layers stop the fill (colour under line art). Off: only look at the current layer.'),
      select('Fill with', fillOpts.fillWith, [{ value: 'color', label: 'Main colour' }, { value: 'secondary', label: 'Second colour' }, { value: 'rainbow', label: 'Rainbow' }], (v) => (fillOpts.fillWith = v), 'What to pour into the area.'),
    );
  },
};

// ---------------------------------------------------------------------------------------- picker
const pickOpts = { size: 3, allLayers: true };
let loupe: { x: number; y: number; c: RGB | null } | null = null;

export const pickerTool: Tool = {
  id: 'picker', name: 'Pick colour', icon: 'eyedropper', key: 'I',
  desc: 'Colour picker (eyedropper): click anywhere on the canvas to take that colour. Alt+click sets the second colour.',
  hint: 'Click or drag to pick a colour · Alt+click: pick second colour · Tip: Alt+click also works while painting',
  cursor: 'crosshair',
  down(e) { this.move!(e); },
  move(e) {
    const c = sampleColor(e.x, e.y, pickOpts.allLayers, pickOpts.size);
    loupe = { x: e.x, y: e.y, c };
    if (c) app.setColor(c, e.alt);
    app.view.requestOverlay();
  },
  up() { loupe = null; app.pushRecent(); app.view.requestOverlay(); },
  drawOverlay(ctx, vp) {
    if (!loupe?.c) return;
    const s = vp.toScreen(loupe.x, loupe.y);
    vp.screenTransform(ctx);
    ctx.lineWidth = 14;
    ctx.strokeStyle = cssRgb(loupe.c);
    ctx.beginPath(); ctx.arc(s.x, s.y, 34, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(s.x, s.y, 41, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, 27, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(rgbToHex(loupe.c), s.x, s.y + 60);
  },
  options() {
    return h('div', { class: 'opts' },
      select('Sample size', String(pickOpts.size) as '1' | '3' | '5' | '11', [{ value: '1', label: 'Exact pixel' }, { value: '3', label: '3 × 3 average' }, { value: '5', label: '5 × 5 average' }, { value: '11', label: '11 × 11 average' }], (v) => (pickOpts.size = Number(v)), 'Averaging several pixels avoids picking a single noisy pixel.'),
      toggle('All layers', pickOpts.allLayers, (v) => (pickOpts.allLayers = v), 'On: pick the colour you see. Off: pick only from the current layer.'),
    );
  },
};

// ---------------------------------------------------------------------------------------- gradient
type GradType = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
type GradColors = 'fg-bg' | 'fg-transparent' | 'rainbow' | 'swatches';
type GradMix = 'oklab' | 'paint' | 'rgb';
const gradOpts = { type: 'linear' as GradType, colors: 'fg-bg' as GradColors, mix: 'oklab' as GradMix, opacity: 1, reverse: false, dither: true };
let gradDrag: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;

function gradientLUT(): Float32Array {
  const N = 1024;
  const lut = new Float32Array(N * 4);
  const stops: { c: RGB; a: number }[] = [];
  if (gradOpts.colors === 'fg-bg') stops.push({ c: app.color, a: 1 }, { c: app.color2, a: 1 });
  else if (gradOpts.colors === 'fg-transparent') stops.push({ c: app.color, a: 1 }, { c: app.color, a: 0 });
  else if (gradOpts.colors === 'rainbow') for (let i = 0; i <= 6; i++) stops.push({ c: hsvToRgb(i * 60, 0.85, 1), a: 1 });
  else {
    const sw = app.settings.swatches.slice(0, 8).map((x) => ({ c: [parseInt(x.slice(1, 3), 16) / 255, parseInt(x.slice(3, 5), 16) / 255, parseInt(x.slice(5, 7), 16) / 255] as RGB, a: 1 }));
    stops.push(...(sw.length >= 2 ? sw : [{ c: app.color, a: 1 }, { c: app.color2, a: 1 }]));
  }
  if (gradOpts.reverse) stops.reverse();
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const f = t * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(f));
    const u = f - k;
    const a = stops[k], b = stops[k + 1];
    const c = gradOpts.mix === 'oklab' ? mixOklab(a.c, b.c, u) : gradOpts.mix === 'paint' ? kmMix(a.c, b.c, u) : [a.c[0] + (b.c[0] - a.c[0]) * u, a.c[1] + (b.c[1] - a.c[1]) * u, a.c[2] + (b.c[2] - a.c[2]) * u] as RGB;
    lut.set([c[0], c[1], c[2], (a.a + (b.a - a.a) * u) * gradOpts.opacity], i * 4);
  }
  return lut;
}

export async function drawGradient(a: { x: number; y: number }, b: { x: number; y: number }): Promise<void> {
  const doc = app.doc;
  const lut = gradientLUT();
  const W = doc.width, H = doc.height;
  const tmp = makeCanvas(W, H);
  const t = ctx2d(tmp);
  const img = t.createImageData(W, H);
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1, L = Math.sqrt(L2);
  const ang0 = Math.atan2(dy, dx);
  const d = img.data;
  let seed = 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - a.x, py = y + 0.5 - a.y;
      let tt: number;
      switch (gradOpts.type) {
        case 'radial': tt = Math.sqrt(px * px + py * py) / L; break;
        case 'angle': { let an = Math.atan2(py, px) - ang0; an = ((an % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); tt = an / (2 * Math.PI); break; }
        case 'reflected': tt = Math.abs((px * dx + py * dy) / L2); break;
        case 'diamond': { const u = (px * dx + py * dy) / L2, v = (-px * dy + py * dx) / L2; tt = Math.abs(u) + Math.abs(v); break; }
        default: tt = (px * dx + py * dy) / L2;
      }
      tt = clamp(tt);
      const k = Math.round(tt * 1023) * 4;
      const o = (y * W + x) * 4;
      let n = 0;
      if (gradOpts.dither) { seed = (seed * 1664525 + 1013904223) >>> 0; n = (seed / 4294967296 - 0.5); }
      d[o] = lut[k] * 255 + n; d[o + 1] = lut[k + 1] * 255 + n; d[o + 2] = lut[k + 2] * 255 + n; d[o + 3] = lut[k + 3] * 255;
    }
  }
  t.putImageData(img, 0, 0);
  await editPixels(doc.active, null, 'Gradient', 'gradient', (ctx) => ctx.drawImage(tmp, 0, 0));
}

export const gradientTool: Tool = {
  id: 'gradient', name: 'Gradient', icon: 'gradient', key: 'Shift+G',
  desc: 'Drag to fill with a smooth blend between colours - skies, backgrounds, lighting. Stays inside a selection if you have one.',
  hint: 'Drag from start to end · Shift: snap angle to 15°',
  cursor: 'crosshair',
  down(e) { gradDrag = { a: { x: e.x, y: e.y }, b: { x: e.x, y: e.y } }; },
  move(e) {
    if (!gradDrag) return;
    let { x, y } = e;
    if (e.shift) {
      const dx = x - gradDrag.a.x, dy = y - gradDrag.a.y, L = Math.hypot(dx, dy);
      const an = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      x = gradDrag.a.x + Math.cos(an) * L; y = gradDrag.a.y + Math.sin(an) * L;
    }
    gradDrag.b = { x, y };
    app.view.requestOverlay();
  },
  up() {
    const g = gradDrag; gradDrag = null;
    if (g && Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) > 2) void drawGradient(g.a, g.b);
    app.view.requestOverlay();
  },
  drawOverlay(ctx: CanvasRenderingContext2D, vp: Viewport) {
    if (!gradDrag) return;
    const a = vp.toScreen(gradDrag.a.x, gradDrag.a.y), b = vp.toScreen(gradDrag.b.x, gradDrag.b.y);
    vp.screenTransform(ctx);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = cssRgb(app.color); ctx.beginPath(); ctx.arc(a.x, a.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = gradOpts.colors === 'fg-transparent' ? 'transparent' : cssRgb(app.color2); ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  },
  options() {
    return h('div', { class: 'opts' },
      segmented(gradOpts.type, [
        { value: 'linear', label: 'Linear', tip: 'Straight blend from start to end.' },
        { value: 'radial', label: 'Radial', tip: 'Circular blend outward from the start point - glows, spotlights.' },
        { value: 'angle', label: 'Angle', tip: 'Sweeps around the start point like a colour wheel.' },
        { value: 'reflected', label: 'Mirror', tip: 'Linear blend mirrored on both sides of the start point.' },
        { value: 'diamond', label: 'Diamond', tip: 'Diamond-shaped blend.' },
      ], (v) => (gradOpts.type = v)),
      select('Colours', gradOpts.colors, [{ value: 'fg-bg', label: 'Main → second' }, { value: 'fg-transparent', label: 'Main → transparent' }, { value: 'rainbow', label: 'Rainbow' }, { value: 'swatches', label: 'First 8 swatches' }], (v) => (gradOpts.colors = v), 'Which colours the gradient goes through.'),
      select('Blend style', gradOpts.mix, [{ value: 'oklab', label: 'Smooth (perceptual)' }, { value: 'paint', label: 'Like mixing paint' }, { value: 'rgb', label: 'Digital (RGB)' }], (v) => (gradOpts.mix = v), 'Smooth: even, vivid transitions. Paint: mixes like real pigments (blue + yellow = green). RGB: classic digital blend (can look grey in the middle).'),
      slider({ label: 'Opacity', min: 0, max: 1, step: 0.01, percent: true, value: gradOpts.opacity, compact: true, onInput: (v) => (gradOpts.opacity = v), tip: 'Overall strength of the gradient.' }),
      toggle('Reverse', gradOpts.reverse, (v) => (gradOpts.reverse = v), 'Swap the direction of the colours.'),
    );
  },
};
