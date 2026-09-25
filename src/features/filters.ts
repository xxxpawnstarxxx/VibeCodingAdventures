// Effects & filters with live preview. Applied to the current layer, inside the selection if any.
import { app } from '../app/app';
import { recordPixels } from '../app/ops';
import { ctx2d } from '../core/layer';
import { blurImage, grainImage, kuwaharaImage, applyAdjustments, DEFAULT_ADJUSTMENTS } from '../wasm/wasm';
import { paper } from '../engine/paintModel';
import { h } from '../ui/dom';
import { button, slider, toggle } from '../ui/controls';
import { openDialog } from '../ui/dialog';

interface Param { key: string; label: string; tip: string; min: number; max: number; step: number; value: number; unit?: string; percent?: boolean }
export interface FilterDef { id: string; name: string; desc: string; icon: string; params: Param[]; bool?: { key: string; label: string; tip: string; value: boolean }[]; apply(img: ImageData, p: Record<string, number | boolean>): ImageData }

const clone = (img: ImageData) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

export const FILTERS: FilterDef[] = [
  {
    id: 'grain', name: 'Noise / film grain', icon: 'noise', desc: 'Adds fine grain like film or textured paper. Makes digital colour feel more natural.',
    params: [
      { key: 'amount', label: 'Amount', tip: 'Strength of the grain.', min: 0, max: 1, step: 0.01, value: 0.18, percent: true },
      { key: 'size', label: 'Grain size', tip: '1 = pixel-fine; higher = softer, clumpier grain.', min: 1, max: 8, step: 0.1, value: 1.4, unit: 'px' },
    ],
    bool: [{ key: 'mono', label: 'Monochrome grain', tip: 'Grain without colour speckles (like black & white film).', value: true }],
    apply(img, p) { const o = clone(img); grainImage(o, p.amount as number, p.size as number, !!p.mono, 7); return o; },
  },
  {
    id: 'paper', name: 'Paper texture', icon: 'paper', desc: 'Presses your painting into the grain of watercolour paper.',
    params: [
      { key: 'strength', label: 'Strength', tip: 'How visible the paper texture is.', min: 0, max: 1, step: 0.01, value: 0.35, percent: true },
      { key: 'scale', label: 'Texture size', tip: 'Coarse or fine paper.', min: 0.3, max: 4, step: 0.05, value: 1.2 },
    ],
    apply(img, p) {
      const o = clone(img), d = o.data, W = o.width;
      const s = p.strength as number, sc = p.scale as number;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        const x = (i / 4) % W, y = Math.floor(i / 4 / W);
        const n = paper(x, y, sc);
        const f = 1 - s * (1 - n) * 0.6 + s * (n - 0.5) * 0.15;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
      return o;
    },
  },
  {
    id: 'blur', name: 'Blur', icon: 'filter', desc: 'Softens everything - depth of field, dreamy backgrounds, soft shadows.',
    params: [{ key: 'radius', label: 'Radius', tip: 'How far pixels are blurred.', min: 1, max: 80, step: 1, value: 6, unit: 'px' }],
    apply(img, p) { const o = clone(img); blurImage(o, p.radius as number); return o; },
  },
  {
    id: 'sharpen', name: 'Sharpen', icon: 'filter', desc: 'Crisps up edges and fine detail (unsharp mask).',
    params: [
      { key: 'amount', label: 'Amount', tip: 'How strongly edges are enhanced.', min: 0, max: 3, step: 0.01, value: 0.8 },
      { key: 'radius', label: 'Radius', tip: 'Size of the detail being sharpened.', min: 1, max: 20, step: 1, value: 2, unit: 'px' },
    ],
    apply(img, p) {
      const b = clone(img); blurImage(b, p.radius as number);
      const o = clone(img), a = p.amount as number;
      for (let i = 0; i < o.data.length; i += 4) for (let c = 0; c < 3; c++) o.data[i + c] = img.data[i + c] + (img.data[i + c] - b.data[i + c]) * a;
      return o;
    },
  },
  {
    id: 'oil', name: 'Oil paint look', icon: 'brush', desc: 'Turns detail into smooth painterly patches with crisp edges (Kuwahara filter).',
    params: [{ key: 'radius', label: 'Brush size', tip: 'Size of the painted patches. Larger is slower.', min: 1, max: 10, step: 1, value: 4, unit: 'px' }],
    apply(img, p) { return kuwaharaImage(img, p.radius as number); },
  },
  {
    id: 'watercolor', name: 'Watercolour wash', icon: 'brush', desc: 'Softens into flat washes with gently darkened edges, like watercolour.',
    params: [
      { key: 'radius', label: 'Wash size', tip: 'Size of the colour washes.', min: 1, max: 8, step: 1, value: 3, unit: 'px' },
      { key: 'edges', label: 'Edge darkening', tip: 'How much pigment pools at edges.', min: 0, max: 1, step: 0.01, value: 0.5, percent: true },
    ],
    apply(img, p) {
      const k = kuwaharaImage(img, p.radius as number);
      const b = clone(k); blurImage(b, (p.radius as number) * 2);
      const e = p.edges as number;
      for (let i = 0; i < k.data.length; i += 4) for (let c = 0; c < 3; c++) {
        const diff = b.data[i + c] - k.data[i + c];
        k.data[i + c] = k.data[i + c] - Math.max(0, -diff) * e * 1.5 - Math.abs(diff) * e * 0.3;
      }
      return k;
    },
  },
  {
    id: 'pixelate', name: 'Pixelate', icon: 'grid', desc: 'Big square pixels - retro game or mosaic look.',
    params: [{ key: 'size', label: 'Block size', tip: 'Size of each square.', min: 2, max: 128, step: 1, value: 12, unit: 'px' }],
    apply(img, p) {
      const o = clone(img), s = p.size as number, W = o.width, H = o.height, d = o.data;
      for (let by = 0; by < H; by += s) for (let bx = 0; bx < W; bx += s) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let y = by; y < Math.min(H, by + s); y++) for (let x = bx; x < Math.min(W, bx + s); x++) { const i = (y * W + x) * 4; const al = img.data[i + 3]; r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; n++; }
        for (let y = by; y < Math.min(H, by + s); y++) for (let x = bx; x < Math.min(W, bx + s); x++) { const i = (y * W + x) * 4; if (a) { d[i] = r / a; d[i + 1] = g / a; d[i + 2] = b / a; } d[i + 3] = a / n; }
      }
      return o;
    },
  },
  {
    id: 'posterize', name: 'Posterize', icon: 'palette', desc: 'Reduces the picture to a few flat colour levels - screen-print and pop-art styles.',
    params: [{ key: 'levels', label: 'Levels', tip: 'Number of tones per colour channel.', min: 2, max: 12, step: 1, value: 4 }],
    apply(img, p) { return applyAdjustments(img, { ...DEFAULT_ADJUSTMENTS, posterize: p.levels as number }); },
  },
  {
    id: 'vignette', name: 'Vignette', icon: 'ellipse', desc: 'Darkens the corners to draw the eye to the centre.',
    params: [
      { key: 'strength', label: 'Strength', tip: 'How dark the edges get.', min: 0, max: 1, step: 0.01, value: 0.45, percent: true },
      { key: 'size', label: 'Clear area', tip: 'Size of the untouched centre.', min: 0, max: 1, step: 0.01, value: 0.45, percent: true },
    ],
    apply(img, p) {
      const o = clone(img), W = o.width, H = o.height, d = o.data;
      const s = p.strength as number, sz = p.size as number;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
        const r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
        const t = Math.min(1, Math.max(0, (r - sz) / (1 - sz + 1e-3)));
        const f = 1 - s * t * t * (3 - 2 * t);
        const i = (y * W + x) * 4;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
      return o;
    },
  },
  {
    id: 'glow', name: 'Glow / bloom', icon: 'sparkles', desc: 'Bright areas softly glow, like light on a camera lens.',
    params: [
      { key: 'threshold', label: 'Brightness threshold', tip: 'Only parts brighter than this glow.', min: 0, max: 1, step: 0.01, value: 0.65, percent: true },
      { key: 'radius', label: 'Glow size', tip: 'How far the glow spreads.', min: 2, max: 80, step: 1, value: 20, unit: 'px' },
      { key: 'strength', label: 'Strength', tip: 'How bright the glow is.', min: 0, max: 2, step: 0.01, value: 0.8 },
    ],
    apply(img, p) {
      const b = clone(img), th = (p.threshold as number) * 255;
      for (let i = 0; i < b.data.length; i += 4) { const l = b.data[i] * 0.3 + b.data[i + 1] * 0.59 + b.data[i + 2] * 0.11; if (l < th) { b.data[i] = b.data[i + 1] = b.data[i + 2] = 0; } }
      blurImage(b, p.radius as number);
      const o = clone(img), s = p.strength as number;
      for (let i = 0; i < o.data.length; i += 4) for (let c = 0; c < 3; c++) o.data[i + c] = 255 - (255 - o.data[i + c]) * (1 - (b.data[i + c] / 255) * s);
      return o;
    },
  },
  {
    id: 'chroma', name: 'Chromatic aberration', icon: 'filter', desc: 'Splits red and blue slightly apart for a lens / glitch look.',
    params: [{ key: 'shift', label: 'Shift', tip: 'Distance between colour channels.', min: 1, max: 30, step: 1, value: 4, unit: 'px' }],
    apply(img, p) {
      const o = clone(img), W = o.width, H = o.height, s = p.shift as number;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const xr = Math.min(W - 1, x + s), xb = Math.max(0, x - s);
        o.data[i] = img.data[(y * W + xr) * 4]; o.data[i + 2] = img.data[(y * W + xb) * 4 + 2];
      }
      return o;
    },
  },
  {
    id: 'halftone', name: 'Halftone dots', icon: 'grid', desc: 'Comic-book printing dots.',
    params: [{ key: 'size', label: 'Dot spacing', tip: 'Distance between dots.', min: 3, max: 40, step: 1, value: 8, unit: 'px' }],
    apply(img, p) {
      const W = img.width, H = img.height, s = p.size as number;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      for (let by = 0; by < H; by += s) for (let bx = 0; bx < W; bx += s) {
        const cx = Math.min(W - 1, bx + (s >> 1)), cy = Math.min(H - 1, by + (s >> 1));
        const i = (cy * W + cx) * 4;
        const a = img.data[i + 3]; if (!a) continue;
        const l = (img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11) / 255;
        x.fillStyle = `rgba(${img.data[i]},${img.data[i + 1]},${img.data[i + 2]},${a / 255})`;
        x.beginPath(); x.arc(cx, cy, (s / 2) * Math.sqrt(1 - l * 0.85) * 1.2, 0, Math.PI * 2); x.fill();
      }
      return x.getImageData(0, 0, W, H);
    },
  },
  {
    id: 'emboss', name: 'Emboss', icon: 'filter', desc: 'Makes the image look pressed or carved.',
    params: [{ key: 'strength', label: 'Strength', tip: 'Depth of the effect.', min: 0, max: 1, step: 0.01, value: 0.6, percent: true }],
    apply(img, p) {
      const o = clone(img), W = o.width, H = o.height, s = p.strength as number;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4, a = ((y - 1) * W + x - 1) * 4, b = ((y + 1) * W + x + 1) * 4;
        for (let c = 0; c < 3; c++) o.data[i + c] = img.data[i + c] + (img.data[b + c] - img.data[a + c]) * s * 1.5;
      }
      return o;
    },
  },
];

export function openFilter(f: FilterDef): void {
  const layer = app.doc.active;
  if (!layer.editable) { app.toast(`"${layer.name}" is locked.`, 'error'); return; }
  void app.backend.flush().then(() => {
    const doc = app.doc;
    const ctx = ctx2d(layer.canvas);
    const orig = ctx.getImageData(0, 0, doc.width, doc.height);
    const params: Record<string, number | boolean> = {};
    for (const p of f.params) params[p.key] = p.value;
    for (const b of f.bool ?? []) params[b.key] = b.value;
    let preview = true, timer = 0, committed = false;
    const status = h('span', { class: 'hint' });
    const run = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!preview) { ctx.putImageData(orig, 0, 0); doc.markDirty(layer, null); return; }
        status.textContent = 'Working…';
        requestAnimationFrame(() => {
          const t0 = performance.now();
          const out = f.apply(orig, params);
          const mask = doc.selection.mask;
          if (mask) for (let i = 0; i < mask.length; i++) { const k = mask[i] / 255; if (k >= 1) continue; for (let c = 0; c < 4; c++) out.data[i * 4 + c] = orig.data[i * 4 + c] + (out.data[i * 4 + c] - orig.data[i * 4 + c]) * k; }
          if (layer.alphaLock) for (let i = 3; i < out.data.length; i += 4) out.data[i] = orig.data[i];
          ctx.putImageData(out, 0, 0);
          doc.markDirty(layer, null);
          status.textContent = `Preview ready (${Math.round(performance.now() - t0)} ms)`;
        });
      }, 120);
    };
    const d = openDialog(f.name, { width: 400, icon: f.icon, subtitle: f.desc + (doc.selection.active ? ' Only the selected area changes.' : ''), modal: false, className: 'side-dialog' });
    for (const p of f.params) d.body.append(slider({ label: p.label, tip: p.tip, min: p.min, max: p.max, step: p.step, value: p.value, unit: p.unit, percent: p.percent, onInput: (v) => { params[p.key] = v; run(); } }));
    for (const b of f.bool ?? []) d.body.append(toggle(b.label, b.value, (v) => { params[b.key] = v; run(); }, b.tip));
    d.body.append(toggle('Preview on canvas', true, (v) => { preview = v; run(); }, 'Compare before/after by switching the preview off and on.'), status);
    d.footer.append(button('Cancel', { onClick: () => d.close() }), button('Apply', { icon: 'check', primary: true, onClick: () => { committed = true; clearTimeout(timer); preview = true; d.close(); } }));
    d.onClose = () => {
      clearTimeout(timer);
      if (committed) {
        const out = f.apply(orig, params);
        const mask = doc.selection.mask;
        if (mask) for (let i = 0; i < mask.length; i++) { const k = mask[i] / 255; if (k >= 1) continue; for (let c = 0; c < 4; c++) out.data[i * 4 + c] = orig.data[i * 4 + c] + (out.data[i * 4 + c] - orig.data[i * 4 + c]) * k; }
        if (layer.alphaLock) for (let i = 3; i < out.data.length; i += 4) out.data[i] = orig.data[i];
        ctx.putImageData(out, 0, 0);
        doc.markDirty(layer, null);
        recordPixels(layer, { x: 0, y: 0, w: doc.width, h: doc.height }, orig, f.name, f.icon);
      } else { ctx.putImageData(orig, 0, 0); doc.markDirty(layer, null); }
    };
    run();
  });
}

/** Apply a filter directly (used by the automation API). */
export async function applyFilterNow(id: string, params: Record<string, number | boolean> = {}): Promise<void> {
  const f = FILTERS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown filter "${id}". Known: ${FILTERS.map((x) => x.id).join(', ')}`);
  const layer = app.doc.active;
  await app.backend.flush();
  const ctx = ctx2d(layer.canvas);
  const orig = ctx.getImageData(0, 0, app.doc.width, app.doc.height);
  const p: Record<string, number | boolean> = {};
  for (const x of f.params) p[x.key] = x.value;
  for (const x of f.bool ?? []) p[x.key] = x.value;
  Object.assign(p, params);
  const out = f.apply(orig, p);
  const mask = app.doc.selection.mask;
  if (mask) for (let i = 0; i < mask.length; i++) { const k = mask[i] / 255; for (let c = 0; c < 4; c++) out.data[i * 4 + c] = orig.data[i * 4 + c] + (out.data[i * 4 + c] - orig.data[i * 4 + c]) * k; }
  ctx.putImageData(out, 0, 0);
  app.doc.markDirty(layer, null);
  recordPixels(layer, { x: 0, y: 0, w: app.doc.width, h: app.doc.height }, orig, f.name, f.icon);
}
