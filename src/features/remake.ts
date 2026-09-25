// Remake assistant: import a picture and get a head start on repainting it.
//  * Auto-paint - repaints the picture stroke by stroke (coarse to fine, strokes follow the image's
//    contours, Hertzmann-style), animated so you watch it being painted. Recorded in the timelapse.
//  * Colour block-in - simplified flat colour shapes (Kuwahara + palette quantisation).
//  * Value study - 3-5 tonal values (notan) tinted in one hue.
//  * Paint by numbers - numbered regions, outlines and a colour key.
//  * Tracing setup - faded photo, contour guide in the photo's own colours, grid and a fresh layer.
import { app } from '../app/app';
import { addLayer, pushEntry } from '../app/ops';
import { Layer, ctx2d, makeCanvas } from '../core/layer';
import { blurImage, kuwaharaImage, sobelField } from '../wasm/wasm';
import { extractPalette, paletteCard, type PaletteEntry } from './palette';
import { addImageLayer } from './adjust';
import { timelapse } from './timelapse';
import { hsvToRgb, rgbToHsv, srgbToOklab, type RGB } from '../core/color';
import { h, svgIcon } from '../ui/dom';
import { icon } from '../ui/icons';
import { button, select, slider, toggle } from '../ui/controls';
import { openDialog, pickFile } from '../ui/dialog';
import { pickSample } from './samples';

type Mode = 'autopaint' | 'blockin' | 'values' | 'numbers' | 'trace';
type Style = 'impressionist' | 'expressionist' | 'pointillist' | 'watercolor' | 'sketch';

const MODES: { id: Mode; name: string; icon: string; desc: string }[] = [
  { id: 'autopaint', name: 'Auto-paint', icon: 'brush', desc: 'Watch the picture being repainted with real brush strokes, big to small. Then keep painting on top.' },
  { id: 'blockin', name: 'Colour block-in', icon: 'palette', desc: 'Simplifies the picture into flat colour shapes - the classic first stage of a painting.' },
  { id: 'values', name: 'Value study', icon: 'filter', desc: 'Reduces the picture to 3-5 tones of light and dark, to plan contrast before colour.' },
  { id: 'numbers', name: 'Paint by numbers', icon: 'grid', desc: 'Outlined regions with numbers and a matching colour key. Fill them in with the Fill tool or brushes.' },
  { id: 'trace', name: 'Tracing setup', icon: 'layers', desc: 'Faded photo + a colour contour guide + grid + a new layer to paint on.' },
];

interface Opts { mode: Mode; style: Style; detail: number; colors: number; values: number; tint: string; fit: 'fit' | 'fill'; speed: number; keepPhoto: boolean }

async function sourceToDoc(src: CanvasImageSource & { width: number; height: number }, fit: 'fit' | 'fill'): Promise<ImageData> {
  const d = app.doc;
  const c = makeCanvas(d.width, d.height);
  const x = ctx2d(c);
  const s = fit === 'fill' ? Math.max(d.width / src.width, d.height / src.height) : Math.min(d.width / src.width, d.height / src.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, (d.width - src.width * s) / 2, (d.height - src.height * s) / 2, src.width * s, src.height * s);
  return x.getImageData(0, 0, d.width, d.height);
}

// --------------------------------------------------------------------------------------- auto-paint
interface Stroke { pts: { x: number; y: number }[]; r: number; color: RGB; alpha: number }

function makeStrokes(ref: ImageData, grad: Float32Array, canvasImg: ImageData, R: number, style: Style, threshold: number): Stroke[] {
  const W = ref.width, H = ref.height, d = ref.data, cd = canvasImg.data;
  const strokes: Stroke[] = [];
  const grid = Math.max(2, Math.round(R * (style === 'pointillist' ? 0.9 : 1)));
  const maxLen = style === 'pointillist' ? 0 : style === 'expressionist' ? 16 : style === 'sketch' ? 10 : style === 'watercolor' ? 6 : 8;
  const minLen = style === 'pointillist' ? 0 : 2;
  const colAt = (x: number, y: number): RGB => { const i = (Math.min(H - 1, Math.max(0, y | 0)) * W + Math.min(W - 1, Math.max(0, x | 0))) * 4; return [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]; };
  for (let gy = 0; gy < H; gy += grid) {
    for (let gx = 0; gx < W; gx += grid) {
      // area error between current canvas and reference
      let err = 0, n = 0, bx = gx, by = gy, best = -1;
      for (let y = gy; y < Math.min(H, gy + grid); y += 2) for (let x = gx; x < Math.min(W, gx + grid); x += 2) {
        const i = (y * W + x) * 4;
        const ca = cd[i + 3] / 255;
        const e = ca < 0.5 ? 255 : Math.abs(d[i] - cd[i]) + Math.abs(d[i + 1] - cd[i + 1]) + Math.abs(d[i + 2] - cd[i + 2]);
        err += e; n++;
        if (e > best) { best = e; bx = x; by = y; }
      }
      if (!n || err / n < threshold) continue;
      const c0 = colAt(bx, by);
      const pts = [{ x: bx, y: by }];
      let x = bx, y = by, ldx = 0, ldy = 0;
      for (let k = 1; k <= maxLen; k++) {
        const gi = ((Math.min(H - 1, y | 0)) * W + Math.min(W - 1, x | 0)) * 2;
        const gxv = grad[gi], gyv = grad[gi + 1];
        const mag = Math.hypot(gxv, gyv);
        if (mag < 1e-4) break;
        let dx = -gyv / mag, dy = gxv / mag; // along the contour (perpendicular to gradient)
        if (ldx * dx + ldy * dy < 0) { dx = -dx; dy = -dy; }
        const fc = style === 'expressionist' ? 0.35 : 0.6;
        if (k > 1) { dx = fc * dx + (1 - fc) * ldx; dy = fc * dy + (1 - fc) * ldy; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l; }
        x += dx * R; y += dy * R;
        if (x < 0 || y < 0 || x >= W || y >= H) break;
        const c = colAt(x, y);
        const cc = colAt(x, y);
        const i = ((y | 0) * W + (x | 0)) * 4;
        const diffRef = Math.abs(c[0] - c0[0]) + Math.abs(c[1] - c0[1]) + Math.abs(c[2] - c0[2]);
        const diffCan = Math.abs(cc[0] * 255 - cd[i]) + Math.abs(cc[1] * 255 - cd[i + 1]) + Math.abs(cc[2] * 255 - cd[i + 2]);
        if (k > minLen && diffRef * 255 > diffCan) break;
        pts.push({ x, y });
        ldx = dx; ldy = dy;
      }
      const jit = style === 'expressionist' ? 0.09 : style === 'impressionist' || style === 'pointillist' ? 0.05 : 0.02;
      const [hh, s, v] = rgbToHsv(c0);
      const color = hsvToRgb(hh + (Math.random() - 0.5) * 360 * jit * 0.5, Math.min(1, s * (1 + (Math.random() - 0.3) * jit * 2)), Math.min(1, Math.max(0, v + (Math.random() - 0.5) * jit)));
      strokes.push({ pts, r: style === 'pointillist' ? R * 0.55 : style === 'sketch' ? Math.max(1, R * 0.25) : R, color, alpha: style === 'watercolor' ? 0.35 : 0.92 });
    }
  }
  // random order avoids a visible scan pattern
  for (let i = strokes.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [strokes[i], strokes[j]] = [strokes[j], strokes[i]]; }
  return strokes;
}

function drawStroke(x: CanvasRenderingContext2D, s: Stroke, style: Style): void {
  const [r, g, b] = s.color;
  x.lineCap = 'round'; x.lineJoin = 'round';
  const path = () => { x.beginPath(); s.pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); if (s.pts.length === 1) x.lineTo(s.pts[0].x + 0.01, s.pts[0].y); };
  if (style === 'watercolor') {
    x.globalAlpha = s.alpha;
    x.strokeStyle = `rgb(${r * 255},${g * 255},${b * 255})`;
    x.lineWidth = s.r * 2.2;
    x.filter = `blur(${Math.max(1, s.r * 0.25)}px)`;
    path(); x.stroke();
    x.filter = 'none';
    // darker wet edge
    x.globalAlpha = s.alpha * 0.35;
    x.strokeStyle = `rgb(${r * 200},${g * 200},${b * 200})`;
    x.lineWidth = Math.max(1, s.r * 0.15);
    path(); x.stroke();
    x.globalAlpha = 1;
    return;
  }
  // body
  x.globalAlpha = s.alpha;
  x.strokeStyle = `rgb(${r * 255},${g * 255},${b * 255})`;
  x.lineWidth = s.r * 2;
  path(); x.stroke();
  if (style === 'pointillist' || s.r < 2.5) { x.globalAlpha = 1; return; }
  // bristle streaks: thin lighter / darker lines offset across the stroke
  const n = Math.min(7, 2 + Math.round(s.r / 3));
  for (let k = 0; k < n; k++) {
    const off = (k / (n - 1) - 0.5) * s.r * 1.6;
    const f = 0.82 + Math.random() * 0.36;
    x.globalAlpha = 0.25;
    x.strokeStyle = `rgb(${Math.min(255, r * 255 * f)},${Math.min(255, g * 255 * f)},${Math.min(255, b * 255 * f)})`;
    x.lineWidth = Math.max(0.6, s.r * 0.18);
    x.beginPath();
    s.pts.forEach((p, i) => {
      const q = s.pts[Math.min(s.pts.length - 1, i + 1)], pp = s.pts[Math.max(0, i - 1)];
      let nx = -(q.y - pp.y), ny = q.x - pp.x; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const px = p.x + nx * off, py = p.y + ny * off;
      if (i) x.lineTo(px, py); else x.moveTo(px, py);
    });
    if (s.pts.length === 1) x.lineTo(s.pts[0].x + 0.5, s.pts[0].y);
    x.stroke();
  }
  x.globalAlpha = 1;
}

let cancelAuto = false;

async function autoPaint(ref: ImageData, o: Opts, progress: (t: number, msg: string) => void): Promise<Layer> {
  const doc = app.doc;
  const layer = new Layer(`Auto-paint (${o.style})`, doc.width, doc.height);
  addLayer(layer, undefined, 'Auto-paint layer');
  const x = ctx2d(layer.canvas);
  // underpainting: very blurred toned ground so no paper shows between strokes
  const W = doc.width, H = doc.height;
  const maxR = Math.max(4, Math.round(Math.max(W, H) / (o.style === 'expressionist' ? 18 : 26)));
  const levels: number[] = [];
  const minR = Math.max(1, Math.round(maxR / Math.pow(2, 2 + o.detail * 3)));
  for (let r = maxR; r >= minR; r = Math.floor(r / 2)) { levels.push(r); if (r <= 1) break; }
  if (o.style !== 'watercolor' && o.style !== 'sketch') {
    const under = new ImageData(new Uint8ClampedArray(ref.data), W, H);
    blurImage(under, maxR * 2);
    const tmp = makeCanvas(W, H); ctx2d(tmp).putImageData(under, 0, 0);
    x.globalAlpha = 0.85; x.drawImage(tmp, 0, 0); x.globalAlpha = 1;
  }
  doc.markDirty(layer, null);
  const before = ctx2d(layer.canvas).getImageData(0, 0, W, H);
  cancelAuto = false;
  for (let li = 0; li < levels.length; li++) {
    const R = levels[li];
    const blurred = new ImageData(new Uint8ClampedArray(ref.data), W, H);
    blurImage(blurred, Math.max(1, R * 0.8));
    const grad = sobelField(blurred);
    const cur = x.getImageData(0, 0, W, H);
    const threshold = o.style === 'sketch' ? 60 : 22 + (1 - o.detail) * 30;
    const strokes = makeStrokes(blurred, grad, cur, R, o.style, threshold);
    const perFrame = Math.max(20, Math.round(strokes.length / (40 + 80 * (1 - o.speed))));
    for (let i = 0; i < strokes.length; i += perFrame) {
      if (cancelAuto) break;
      for (let k = i; k < Math.min(strokes.length, i + perFrame); k++) drawStroke(x, strokes[k], o.style);
      doc.markDirty(layer, null);
      timelapse.capture();
      progress((li + i / strokes.length) / levels.length, `Painting with ${R * 2}px brush… (${Math.min(strokes.length, i + perFrame)}/${strokes.length} strokes)`);
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (cancelAuto) break;
  }
  // the whole process is one undo step
  const after = ctx2d(layer.canvas).getImageData(0, 0, W, H);
  pushEntry({ label: 'Auto-paint strokes', icon: 'sparkles',
    undo() { ctx2d(layer.canvas).putImageData(before, 0, 0); doc.markDirty(layer, null); },
    redo() { ctx2d(layer.canvas).putImageData(after, 0, 0); doc.markDirty(layer, null); } });
  progress(1, cancelAuto ? 'Stopped.' : 'Done! Add a new layer and refine it with your own brush strokes.');
  return layer;
}

// --------------------------------------------------------------------------------------- other modes
function quantize(img: ImageData, pal: PaletteEntry[]): Uint8Array {
  const labs = pal.map((p) => srgbToOklab(p.rgb));
  const labels = new Uint8Array(img.width * img.height);
  const cache = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let best = cache.get(key);
    if (best === undefined) {
      const L = srgbToOklab([r / 255, g / 255, b / 255]);
      let bd = Infinity; best = 0;
      labs.forEach((q, k) => { const dd = (q[0] - L[0]) ** 2 + (q[1] - L[1]) ** 2 + (q[2] - L[2]) ** 2; if (dd < bd) { bd = dd; best = k; } });
      cache.set(key, best);
    }
    labels[i] = best;
  }
  return labels;
}

function modeFilter(labels: Uint8Array, W: number, H: number, passes: number, k: number): void {
  const counts = new Uint16Array(k);
  for (let p = 0; p < passes; p++) {
    const src = labels.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      counts.fill(0);
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) counts[src[(y + j) * W + x + i]]++;
      let best = src[y * W + x], bc = 0;
      for (let c = 0; c < k; c++) if (counts[c] > bc) { bc = counts[c]; best = c; }
      labels[y * W + x] = best;
    }
  }
}

function labelsToCanvas(labels: Uint8Array, pal: PaletteEntry[], W: number, H: number): HTMLCanvasElement {
  const c = makeCanvas(W, H), x = ctx2d(c);
  const img = x.createImageData(W, H);
  for (let i = 0; i < labels.length; i++) { const p = pal[labels[i]].rgb; img.data[i * 4] = p[0] * 255; img.data[i * 4 + 1] = p[1] * 255; img.data[i * 4 + 2] = p[2] * 255; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0);
  return c;
}

function blockIn(ref: ImageData, o: Opts): void {
  const W = ref.width, H = ref.height;
  const small = Math.min(1, 900 / Math.max(W, H));
  const sw = Math.round(W * small), sh = Math.round(H * small);
  const sc = makeCanvas(sw, sh); const sx = ctx2d(sc);
  const t = makeCanvas(W, H); ctx2d(t).putImageData(ref, 0, 0);
  sx.drawImage(t, 0, 0, sw, sh);
  let img = sx.getImageData(0, 0, sw, sh);
  img = kuwaharaImage(img, Math.round(3 + (1 - o.detail) * 4));
  const pal = extractPalette(img, o.colors);
  const labels = quantize(img, pal);
  modeFilter(labels, sw, sh, 2, pal.length);
  const flat = labelsToCanvas(labels, pal, sw, sh);
  const l = app.doc.createLayer('Colour block-in');
  const x = ctx2d(l.canvas); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(flat, 0, 0, W, H);
  addLayer(l, undefined, 'Colour block-in');
  app.settings.swatches = pal.map((p) => p.hex); app.saveSettings();
}

function valueStudy(ref: ImageData, o: Opts): void {
  const W = ref.width, H = ref.height;
  const tmp = new ImageData(new Uint8ClampedArray(ref.data), W, H);
  blurImage(tmp, Math.max(1, Math.round(Math.max(W, H) / 400)));
  const tint = o.tint === 'sepia' ? 30 : o.tint === 'blue' ? 215 : o.tint === 'green' ? 140 : -1;
  const n = o.values;
  const out = new ImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const l = (tmp.data[i * 4] * 0.299 + tmp.data[i * 4 + 1] * 0.587 + tmp.data[i * 4 + 2] * 0.114) / 255;
    const q = Math.min(n - 1, Math.floor(l * n)) / (n - 1);
    const v = 0.1 + q * 0.85;
    const c = tint < 0 ? [v, v, v] : hsvToRgb(tint, 0.25 * (1 - q * 0.6), v);
    out.data[i * 4] = c[0] * 255; out.data[i * 4 + 1] = c[1] * 255; out.data[i * 4 + 2] = c[2] * 255; out.data[i * 4 + 3] = 255;
  }
  const l = app.doc.createLayer(`Value study (${n} values)`);
  ctx2d(l.canvas).putImageData(out, 0, 0);
  addLayer(l, undefined, 'Value study');
}

function paintByNumbers(ref: ImageData, o: Opts): void {
  const W = ref.width, H = ref.height;
  const s = Math.min(1, 1400 / Math.max(W, H));
  const sw = Math.round(W * s), sh = Math.round(H * s);
  const t = makeCanvas(W, H); ctx2d(t).putImageData(ref, 0, 0);
  const sc = makeCanvas(sw, sh); const sx = ctx2d(sc); sx.drawImage(t, 0, 0, sw, sh);
  let img = sx.getImageData(0, 0, sw, sh);
  img = kuwaharaImage(img, 4);
  const pal = extractPalette(img, o.colors);
  const labels = quantize(img, pal);
  modeFilter(labels, sw, sh, 4, pal.length);
  // connected regions
  const region = new Int32Array(sw * sh).fill(-1);
  const regions: { label: number; n: number; sx: number; sy: number; px: number; py: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < region.length; i++) {
    if (region[i] >= 0) continue;
    const id = regions.length, lab = labels[i];
    const info = { label: lab, n: 0, sx: 0, sy: 0, px: i % sw, py: (i / sw) | 0 };
    region[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % sw, y = (p / sw) | 0;
      info.n++; info.sx += x; info.sy += y;
      const nb = [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1];
      for (const q of nb) if (q >= 0 && region[q] < 0 && labels[q] === lab) { region[q] = id; stack.push(q); }
    }
    regions.push(info);
  }
  const doc = app.doc;
  const outl = doc.createLayer('Numbers & outlines');
  const x = ctx2d(outl.canvas);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  // outlines where regions change
  const lineImg = x.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const lx = Math.min(sw - 1, (xx * s) | 0), ly = Math.min(sh - 1, (y * s) | 0);
    const r0 = region[ly * sw + lx];
    const r1 = region[ly * sw + Math.min(sw - 1, lx + 1)], r2 = region[Math.min(sh - 1, ly + 1) * sw + lx];
    const nx = Math.min(sw - 1, ((xx + 1) * s) | 0), ny = Math.min(sh - 1, ((y + 1) * s) | 0);
    if ((nx !== lx && r1 !== r0) || (ny !== ly && r2 !== r0)) { const i = (y * W + xx) * 4; lineImg.data[i] = lineImg.data[i + 1] = lineImg.data[i + 2] = 120; }
  }
  x.putImageData(lineImg, 0, 0);
  const minArea = (sw * sh) / 4000;
  x.fillStyle = '#555'; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (const r of regions) {
    if (r.n < minArea) continue;
    let cx = r.sx / r.n, cy = r.sy / r.n;
    if (region[(cy | 0) * sw + (cx | 0)] !== regions.indexOf(r)) { cx = r.px + 1; cy = r.py + 1; }
    const fs = Math.max(8, Math.min(22, Math.sqrt(r.n) / (3 * s)));
    x.font = `${fs}px system-ui, sans-serif`;
    x.fillText(String(r.label + 1), cx / s, cy / s);
  }
  outl.blend = 'multiply';
  addLayer(outl, undefined, 'Paint by numbers');
  // colour key
  const key = doc.createLayer('Colour key');
  const kx = ctx2d(key.canvas);
  const sz = Math.max(24, Math.round(Math.min(W, H) / 30));
  pal.forEach((p, i) => {
    const yy = 10 + i * (sz + 6);
    kx.fillStyle = 'rgba(255,255,255,0.85)'; kx.fillRect(8, yy - 2, sz * 3.2, sz + 4);
    kx.fillStyle = p.hex; kx.fillRect(10, yy, sz, sz);
    kx.fillStyle = '#222'; kx.font = `600 ${Math.round(sz * 0.6)}px system-ui`; kx.textBaseline = 'middle'; kx.fillText(String(i + 1), sz + 18, yy + sz / 2);
  });
  addLayer(key, undefined, 'Colour key');
  app.settings.swatches = pal.map((p) => p.hex); app.saveSettings();
  app.tools.set('fill');
  app.toast('Swatches are set to the numbered colours (1 = first swatch). Fill regions with the Fill tool (set "Look at all layers" on).', 'success');
}

function tracingSetup(src: CanvasImageSource & { width: number; height: number }, ref: ImageData, o: Opts): void {
  const photo = addImageLayer(src, 'Photo reference', o.fit);
  photo.opacity = 0.35; photo.locked = true;
  // contour guide coloured by the photo
  const W = ref.width, H = ref.height;
  const b = new ImageData(new Uint8ClampedArray(ref.data), W, H);
  blurImage(b, Math.max(1, Math.round(Math.max(W, H) / 700)));
  const g = sobelField(b);
  const mags = new Float32Array(W * H);
  let sum = 0;
  for (let i = 0; i < mags.length; i++) { mags[i] = Math.hypot(g[i * 2], g[i * 2 + 1]); sum += mags[i]; }
  const mean = sum / mags.length;
  const th = mean * (3.2 - o.detail * 1.8);
  const out = new ImageData(W, H);
  for (let i = 0; i < mags.length; i++) {
    if (mags[i] < th) continue;
    const a = Math.min(1, (mags[i] - th) / (th + 1e-6));
    // darken the local colour so contours stay readable but keep their hue
    out.data[i * 4] = b.data[i * 4] * 0.55; out.data[i * 4 + 1] = b.data[i * 4 + 1] * 0.55; out.data[i * 4 + 2] = b.data[i * 4 + 2] * 0.55; out.data[i * 4 + 3] = a * 255;
  }
  const cl = app.doc.createLayer('Contour guide (colour)');
  ctx2d(cl.canvas).putImageData(out, 0, 0);
  cl.opacity = 0.7;
  addLayer(cl, undefined, 'Contour guide');
  app.settings.guides.showGrid = true;
  app.settings.guides.gridSize = Math.round(Math.min(W, H) / 8);
  app.saveSettings();
  addLayer(app.doc.createLayer('Your painting'), undefined, 'New layer');
  app.view.requestOverlay();
}

// --------------------------------------------------------------------------------------- dialog
export function openRemakeDialog(initial?: Mode): void {
  const o: Opts = { mode: initial ?? 'autopaint', style: 'impressionist', detail: 0.6, colors: 12, values: 4, tint: 'sepia', fit: 'fit', speed: 0.5, keepPhoto: false };
  let src: (CanvasImageSource & { width: number; height: number }) | null = null;
  let srcName = '';
  const d = openDialog('Remake a picture', { width: 780, icon: 'sparkles', subtitle: 'Import a photo or artwork and get a painterly head start - all results land on new layers you can paint over.' });
  const srcPreview = h('div', { class: 'remake-src checker' }, h('span', null, 'No picture chosen yet'));
  const showSrc = () => {
    srcPreview.innerHTML = '';
    if (!src) { srcPreview.append(h('span', null, 'No picture chosen yet')); return; }
    const c = makeCanvas(Math.round(240 * (src.width / src.height)), 240);
    ctx2d(c).drawImage(src, 0, 0, c.width, c.height);
    srcPreview.append(c, h('span', { class: 'hint' }, `${srcName} · ${src.width} × ${src.height}`));
  };
  const cards = h('div', { class: 'mode-cards' });
  const opts = h('div', { class: 'remake-opts' });
  const progressBar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const progressText = h('div', { class: 'hint' });
  const renderCards = () => {
    cards.innerHTML = '';
    for (const m of MODES) {
      const c = h('button', { class: 'mode-card' + (o.mode === m.id ? ' active' : ''), type: 'button', tip: { title: m.name, desc: m.desc } }, svgIcon(icon(m.icon)), h('strong', null, m.name), h('span', null, m.desc));
      c.addEventListener('click', () => { o.mode = m.id; renderCards(); renderOpts(); });
      cards.append(c);
    }
  };
  const renderOpts = () => {
    opts.innerHTML = '';
    if (o.mode === 'autopaint') opts.append(
      select('Painting style', o.style, [
        { value: 'impressionist', label: 'Impressionist - short dabs' }, { value: 'expressionist', label: 'Expressionist - long bold strokes' },
        { value: 'pointillist', label: 'Pointillist - dots' }, { value: 'watercolor', label: 'Watercolour - soft washes' }, { value: 'sketch', label: 'Sketch - fine lines' },
      ], (v) => (o.style = v), 'The kind of brushwork used.'),
      slider({ label: 'Detail', min: 0, max: 1, step: 0.01, percent: true, value: o.detail, compact: true, onInput: (v) => (o.detail = v), tip: 'More detail = more, smaller strokes at the end (slower).' }),
      slider({ label: 'Speed', min: 0, max: 1, step: 0.01, percent: true, value: o.speed, compact: true, onInput: (v) => (o.speed = v), tip: 'How fast the painting animation runs.' }),
      toggle('Also keep the photo on a layer', o.keepPhoto, (v) => (o.keepPhoto = v), 'Adds the original picture as a hidden adjustable layer for comparison.'),
    );
    if (o.mode === 'blockin' || o.mode === 'numbers') opts.append(
      slider({ label: 'Number of colours', min: 3, max: 32, step: 1, value: o.colors, compact: true, onInput: (v) => (o.colors = v), tip: 'Fewer colours = simpler shapes.' }),
      o.mode === 'blockin' ? slider({ label: 'Detail', min: 0, max: 1, step: 0.01, percent: true, value: o.detail, compact: true, onInput: (v) => (o.detail = v), tip: 'Lower = bigger, simpler shapes.' }) : h('span'),
    );
    if (o.mode === 'values') opts.append(
      slider({ label: 'Number of values', min: 2, max: 7, step: 1, value: o.values, compact: true, onInput: (v) => (o.values = v), tip: '3 = light / mid / dark (notan). 5 is common for painting.' }),
      select('Tint', o.tint, [{ value: 'sepia', label: 'Warm sepia' }, { value: 'blue', label: 'Cool blue-grey' }, { value: 'green', label: 'Green earth' }, { value: 'grey', label: 'Neutral grey' }], (v) => (o.tint = v), 'Colour of the value study.'),
    );
    if (o.mode === 'trace') opts.append(slider({ label: 'Contour detail', min: 0, max: 1, step: 0.01, percent: true, value: o.detail, compact: true, onInput: (v) => (o.detail = v), tip: 'How many edges become contour lines.' }));
    opts.append(select('Placement', o.fit, [{ value: 'fit', label: 'Fit inside canvas' }, { value: 'fill', label: 'Fill canvas (crop edges)' }], (v) => (o.fit = v), 'How the picture is placed on the canvas.'));
  };
  const setSrc = (s: typeof src, name: string) => { src = s; srcName = name; showSrc(); };
  d.body.append(
    h('div', { class: 'remake-top' },
      srcPreview,
      h('div', { class: 'col' },
        button('Choose picture…', { icon: 'upload', primary: true, tip: 'Open an image file from your computer.', onClick: async () => { const [f] = await pickFile('image/*'); if (f) setSrc(await createImageBitmap(f), f.name); } }),
        button('Sample picture…', { icon: 'sparkles', tip: 'Choose one of the built-in sample pictures (landscapes, still life, flowers…).', onClick: async () => { const r = await pickSample('Pick a picture to remake'); if (r) setSrc(r.bitmap, r.sample.name); } }),
        button('Use current painting', { icon: 'image', tip: 'Remake what is on the canvas right now.', onClick: async () => { await app.backend.flush(); setSrc(app.doc.flatten({ background: true }), 'Current painting'); } }),
        button('Use current layer', { icon: 'layers', tip: 'Remake the selected layer (e.g. an imported photo).', onClick: async () => { await app.backend.flush(); setSrc(app.doc.active.canvas, app.doc.active.name); } }),
      )),
    h('div', { class: 'sub-title' }, 'What should it do?'), cards, opts, progressBar, progressText,
  );
  renderCards(); renderOpts();
  let running = false;
  const go = button('Create', { icon: 'sparkles', primary: true, onClick: async () => {
    if (running) { cancelAuto = true; return; }
    if (!src) { app.toast('Choose a picture first.', 'info'); return; }
    const ref = await sourceToDoc(src, o.fit);
    const fill = progressBar.firstElementChild as HTMLElement;
    const prog = (t: number, msg: string) => { fill.style.width = `${Math.round(t * 100)}%`; progressText.textContent = msg; };
    if (o.mode === 'autopaint') {
      running = true; go.querySelector('.btn-label')!.textContent = 'Stop';
      if (o.keepPhoto) { const p = addImageLayer(src, 'Photo (hidden)', o.fit); p.visible = false; app.doc.events.emit('structure', undefined); }
      await autoPaint(ref, o, prog);
      running = false; go.querySelector('.btn-label')!.textContent = 'Create';
      addLayer(app.doc.createLayer('Your touches'), undefined, 'New layer');
      return;
    }
    prog(0.3, 'Working…');
    await new Promise((r) => setTimeout(r, 30));
    if (o.mode === 'blockin') blockIn(ref, o);
    if (o.mode === 'values') valueStudy(ref, o);
    if (o.mode === 'numbers') paintByNumbers(ref, o);
    if (o.mode === 'trace') tracingSetup(src, ref, o);
    prog(1, 'Done! The result is on new layers.');
    timelapse.capture();
  } });
  d.footer.append(button('Close', { onClick: () => { cancelAuto = true; d.close(); } }), go);
}

/** Headless entry point for the automation API. */
export async function remakeHeadless(src: CanvasImageSource & { width: number; height: number }, mode: Mode, opts: Partial<Opts> = {}): Promise<void> {
  const o: Opts = { mode, style: 'impressionist', detail: 0.6, colors: 12, values: 4, tint: 'sepia', fit: 'fit', speed: 1, keepPhoto: false, ...opts };
  const ref = await sourceToDoc(src, o.fit);
  if (mode === 'autopaint') await autoPaint(ref, o, () => {});
  if (mode === 'blockin') blockIn(ref, o);
  if (mode === 'values') valueStudy(ref, o);
  if (mode === 'numbers') paintByNumbers(ref, o);
  if (mode === 'trace') tracingSetup(src, ref, o);
}
