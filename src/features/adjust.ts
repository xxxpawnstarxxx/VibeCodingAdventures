// Image adjustments (non-destructive for photo layers) + image import helpers.
import { app } from '../app/app';
import { addLayer, pushEntry, recordPixels } from '../app/ops';
import { Layer, ctx2d, makeCanvas } from '../core/layer';
import { DEFAULT_ADJUSTMENTS, applyAdjustments, type Adjustments } from '../wasm/wasm';
import { h } from '../ui/dom';
import { button, slider } from '../ui/controls';
import { openDialog } from '../ui/dialog';

const FIELDS: { key: keyof Adjustments; label: string; tip: string; min: number; max: number; step: number; unit?: string; percent?: boolean }[] = [
  { key: 'exposure', label: 'Exposure', tip: 'Overall light, like a camera exposure (in stops).', min: -3, max: 3, step: 0.01 },
  { key: 'brightness', label: 'Brightness', tip: 'Make everything lighter or darker.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'contrast', label: 'Contrast', tip: 'Difference between darks and lights. Higher = punchier.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'highlights', label: 'Highlights', tip: 'Brighten or recover the lightest parts only.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'shadows', label: 'Shadows', tip: 'Brighten or deepen the darkest parts only.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'saturation', label: 'Saturation', tip: 'How colourful everything is. -100% = black & white.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'vibrance', label: 'Vibrance', tip: 'Boosts dull colours more than already-vivid ones (gentler than saturation).', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'hue', label: 'Hue shift', tip: 'Rotate every colour around the colour wheel.', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'temperature', label: 'Warmth', tip: 'Cooler (blue) or warmer (orange) light.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'tint', label: 'Tint', tip: 'Shift toward green or magenta.', min: -1, max: 1, step: 0.01, percent: true },
  { key: 'gamma', label: 'Mid-tones', tip: 'Gamma: brighten or darken the middle tones without touching pure black/white.', min: 0.2, max: 3, step: 0.01 },
  { key: 'grayscale', label: 'Black & white', tip: 'Fade to greyscale.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'sepia', label: 'Sepia', tip: 'Old-photo brown tone.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'invert', label: 'Invert', tip: 'Turn colours into their negatives.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'posterize', label: 'Posterize', tip: 'Reduce to a few flat colour levels per channel (0 = off). Nice for a screen-print look.', min: 0, max: 16, step: 1 },
];

/** Recompute an image layer's pixels from its untouched source + adjustments. */
export function renderImageLayer(l: Layer): void {
  if (!l.source || !l.adjustments) return;
  const src = ctx2d(l.source).getImageData(0, 0, l.source.width, l.source.height);
  const out = applyAdjustments(src, l.adjustments);
  ctx2d(l.canvas).putImageData(out, 0, 0);
  app.doc.markDirty(l, null);
}

export function openAdjustDialog(l: Layer): void {
  if (l.kind === 'video') { app.toast('Video layers cannot be adjusted.', 'error'); return; }
  if (!l.editable) { app.toast(`"${l.name}" is locked.`, 'error'); return; }
  void app.backend.flush().then(() => {
    const isImage = l.kind === 'image' && !!l.source;
    const start: Adjustments = { ...(isImage ? l.adjustments ?? DEFAULT_ADJUSTMENTS : DEFAULT_ADJUSTMENTS) };
    const cur: Adjustments = { ...start };
    const base = isImage ? null : ctx2d(l.canvas).getImageData(0, 0, app.doc.width, app.doc.height);
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (isImage) { l.adjustments = { ...cur }; renderImageLayer(l); }
      else { ctx2d(l.canvas).putImageData(applyAdjustments(base!, cur), 0, 0); app.doc.markDirty(l, null); }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    const d = openDialog(isImage ? `Adjust photo: ${l.name}` : `Adjust colours: ${l.name}`, {
      width: 420, icon: 'adjust', modal: false, className: 'side-dialog',
      subtitle: isImage ? 'Photo layers stay adjustable - you can come back and change these any time.' : 'Changes are previewed live on the canvas.',
    });
    const sliders = FIELDS.map((f) => {
      const s = slider({ label: f.label, tip: f.tip, min: f.min, max: f.max, step: f.step, unit: f.unit, percent: f.percent, value: cur[f.key], onInput: (v) => { cur[f.key] = v; schedule(); } });
      return { f, s };
    });
    d.body.append(h('div', { class: 'adjust-grid' }, ...sliders.map((x) => x.s)));
    let committed = false;
    const reset = () => { Object.assign(cur, DEFAULT_ADJUSTMENTS); sliders.forEach(({ f, s }) => s.set(cur[f.key])); schedule(); };
    const auto = () => {
      // simple auto-levels: stretch luminance to full range, gentle vibrance
      const src = isImage ? ctx2d(l.source!).getImageData(0, 0, l.source!.width, l.source!.height) : base!;
      let lo = 255, hi = 0;
      const hist = new Uint32Array(256); let n = 0;
      for (let i = 0; i < src.data.length; i += 16) { if (src.data[i + 3] < 128) continue; const v = Math.round(src.data[i] * 0.299 + src.data[i + 1] * 0.587 + src.data[i + 2] * 0.114); hist[v]++; n++; }
      let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
      acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.01) { hi = v; break; } }
      const range = Math.max(20, hi - lo);
      cur.contrast = Math.min(0.6, Math.max(0, (255 / range - 1) / 3));
      cur.brightness = ((127 - (lo + hi) / 2) / 255) * 0.8;
      cur.vibrance = 0.25;
      sliders.forEach(({ f, s }) => s.set(cur[f.key]));
      schedule();
    };
    d.footer.append(
      button('Auto', { icon: 'sparkles', tip: 'Automatically improve brightness and contrast.', onClick: auto }),
      button('Reset', { icon: 'undo', tip: 'Set everything back to neutral.', onClick: reset }),
      button('Cancel', { onClick: () => d.close() }),
      button('Apply', { icon: 'check', primary: true, onClick: () => { committed = true; d.close(); } }),
    );
    d.onClose = () => {
      if (raf) { cancelAnimationFrame(raf); apply(); }
      if (!committed) {
        if (isImage) { l.adjustments = { ...start }; renderImageLayer(l); }
        else { ctx2d(l.canvas).putImageData(base!, 0, 0); app.doc.markDirty(l, null); }
        return;
      }
      if (isImage) {
        const after = { ...cur };
        pushEntry({ label: 'Adjust photo', icon: 'adjust', undo() { l.adjustments = { ...start }; renderImageLayer(l); }, redo() { l.adjustments = { ...after }; renderImageLayer(l); } });
      } else recordPixels(l, { x: 0, y: 0, w: app.doc.width, h: app.doc.height }, base!, 'Adjust colours', 'adjust');
    };
  });
}

/** Add an image as a new adjustable photo layer, fitted into the canvas. */
export function addImageLayer(img: CanvasImageSource & { width: number; height: number }, name: string, fit: 'fit' | 'fill' | 'actual' = 'fit'): Layer {
  const doc = app.doc;
  const l = new Layer(name, doc.width, doc.height, 'image');
  const iw = (img as any).naturalWidth ?? img.width, ih = (img as any).naturalHeight ?? img.height;
  let s = 1;
  if (fit === 'fit') s = Math.min(1, doc.width / iw, doc.height / ih);
  if (fit === 'fill') s = Math.max(doc.width / iw, doc.height / ih);
  const w = iw * s, hh = ih * s;
  l.source = makeCanvas(doc.width, doc.height);
  const sc = ctx2d(l.source);
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(img, (doc.width - w) / 2, (doc.height - hh) / 2, w, hh);
  l.adjustments = { ...DEFAULT_ADJUSTMENTS };
  ctx2d(l.canvas).drawImage(l.source, 0, 0);
  addLayer(l, undefined, `Import "${name}"`);
  return l;
}
