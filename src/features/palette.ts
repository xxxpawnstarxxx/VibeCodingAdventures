// Palette extraction: dominant colours with the % of the image each one covers.
// WASM histogram (15-bit) -> weighted k-means++ in OKLab -> sorted by coverage.
import { app } from '../app/app';
import { colorHistogram } from '../wasm/wasm';
import { oklabToSrgb, rgbToHex, srgbToOklab, type RGB } from '../core/color';
import { ctx2d, makeCanvas } from '../core/layer';
import { addLayer } from '../app/ops';
import { h } from '../ui/dom';
import { button, select, slider } from '../ui/controls';
import { openDialog, pickFile } from '../ui/dialog';
import { pickSample } from './samples';

export interface PaletteEntry { hex: string; rgb: RGB; percent: number }

export function downscale(src: CanvasImageSource & { width: number; height: number }, max = 400): ImageData {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = makeCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height);
}

export function extractPalette(img: ImageData, k: number): PaletteEntry[] {
  const { bins, total } = colorHistogram(img);
  if (!total) return [];
  const pts: { lab: [number, number, number]; w: number }[] = [];
  for (let i = 0; i < 32768; i++) {
    if (!bins[i]) continue;
    const r = (((i >> 10) & 31) + 0.5) / 32, g = (((i >> 5) & 31) + 0.5) / 32, b = ((i & 31) + 0.5) / 32;
    pts.push({ lab: srgbToOklab([r, g, b]), w: bins[i] });
  }
  k = Math.max(1, Math.min(k, pts.length));
  // weighted k-means++ init (deterministic seed)
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centers: [number, number, number][] = [];
  let best = pts[0];
  for (const p of pts) if (p.w > best.w) best = p;
  centers.push([...best.lab]);
  const dist = pts.map((p) => d2(p.lab, centers[0]));
  while (centers.length < k) {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) sum += dist[i] * pts[i].w;
    let r = rand() * sum, pick = 0;
    for (let i = 0; i < pts.length; i++) { r -= dist[i] * pts[i].w; if (r <= 0) { pick = i; break; } }
    centers.push([...pts[pick].lab]);
    for (let i = 0; i < pts.length; i++) dist[i] = Math.min(dist[i], d2(pts[i].lab, centers[centers.length - 1]));
  }
  const assign = new Int32Array(pts.length);
  const weights = new Float64Array(k);
  for (let it = 0; it < 16; it++) {
    const acc = Array.from({ length: k }, () => [0, 0, 0]);
    weights.fill(0);
    for (let i = 0; i < pts.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = d2(pts[i].lab, centers[c]); if (dd < bd) { bd = dd; bi = c; } }
      assign[i] = bi;
      const w = pts[i].w;
      acc[bi][0] += pts[i].lab[0] * w; acc[bi][1] += pts[i].lab[1] * w; acc[bi][2] += pts[i].lab[2] * w;
      weights[bi] += w;
    }
    for (let c = 0; c < k; c++) if (weights[c] > 0) centers[c] = [acc[c][0] / weights[c], acc[c][1] / weights[c], acc[c][2] / weights[c]];
  }
  const out: PaletteEntry[] = [];
  for (let c = 0; c < k; c++) {
    if (!weights[c]) continue;
    const rgb = oklabToSrgb(centers[c]).map((v) => Math.min(1, Math.max(0, v))) as RGB;
    out.push({ rgb, hex: rgbToHex(rgb), percent: (weights[c] / total) * 100 });
  }
  return out.sort((a, b) => b.percent - a.percent);
}

/** Draw a palette card (swatches + percentages). */
export function paletteCard(entries: PaletteEntry[], w = 900): HTMLCanvasElement {
  const rowH = 44, pad = 24;
  const c = makeCanvas(w, pad * 2 + 60 + entries.length * rowH);
  const x = ctx2d(c);
  x.fillStyle = '#fbfaf7'; x.fillRect(0, 0, c.width, c.height);
  let px = pad;
  for (const e of entries) { const ww = ((w - pad * 2) * e.percent) / 100; x.fillStyle = e.hex; x.fillRect(px, pad, ww, 40); px += ww; }
  x.font = '600 18px system-ui, sans-serif';
  entries.forEach((e, i) => {
    const y = pad + 60 + i * rowH;
    x.fillStyle = e.hex; x.fillRect(pad, y, 60, 34);
    x.strokeStyle = 'rgba(0,0,0,0.15)'; x.strokeRect(pad + 0.5, y + 0.5, 59, 33);
    x.fillStyle = '#222'; x.fillText(`${e.hex.toUpperCase()}`, pad + 76, y + 23);
    x.fillText(`${e.percent.toFixed(1)}%`, pad + 200, y + 23);
    x.fillStyle = e.hex; x.fillRect(pad + 290, y + 8, ((w - pad * 2 - 290) * e.percent) / Math.max(...entries.map((q) => q.percent)), 18);
  });
  return c;
}

export function openPaletteDialog(): void {
  let count = 8;
  let source: 'picture' | 'layer' | 'file' = 'picture';
  let fileImg: ImageBitmap | null = null;
  let entries: PaletteEntry[] = [];
  const d = openDialog('Extract colour palette', { width: 620, icon: 'palette', subtitle: 'Finds the main colours in a picture and how much of the picture each one covers.' });
  const bar = h('div', { class: 'pal-bar' });
  const list = h('div', { class: 'pal-list' });
  const preview = h('canvas', { class: 'pal-src checker' });
  const run = async () => {
    await app.backend.flush();
    let src: HTMLCanvasElement | ImageBitmap;
    if (source === 'file' && fileImg) src = fileImg;
    else if (source === 'layer') src = app.doc.active.canvas;
    else src = app.doc.flatten({ background: true });
    const img = downscale(src, 420);
    preview.width = img.width; preview.height = img.height;
    ctx2d(preview).putImageData(img, 0, 0);
    entries = extractPalette(img, count);
    render();
  };
  const render = () => {
    bar.innerHTML = ''; list.innerHTML = '';
    for (const e of entries) {
      const seg = h('button', { class: 'pal-seg', type: 'button', style: `background:${e.hex};flex:${e.percent}`, tip: { title: `${e.hex} · ${e.percent.toFixed(1)}%`, desc: 'Click to paint with this colour.' } });
      seg.addEventListener('click', () => app.setColor(e.rgb));
      bar.append(seg);
      const row = h('button', { class: 'pal-row', type: 'button', tip: { title: e.hex, desc: `Covers ${e.percent.toFixed(1)}% of the picture. Click to use it.` } },
        h('span', { class: 'swatch', style: `background:${e.hex}` }),
        h('span', { class: 'pal-hex' }, e.hex.toUpperCase()),
        h('span', { class: 'pal-pct' }, e.percent.toFixed(1) + '%'),
        h('span', { class: 'pal-meter' }, h('span', { style: `width:${(e.percent / entries[0].percent) * 100}%;background:${e.hex}` })));
      row.addEventListener('click', () => { app.setColor(e.rgb); app.pushRecent(); });
      list.append(row);
    }
  };
  const srcSel = select('Colours from', source, [{ value: 'picture', label: 'Whole picture' }, { value: 'layer', label: 'Current layer' }, { value: 'file', label: 'An image file…' }, { value: 'sample' as 'file', label: 'A sample picture…' }], async (v) => {
    if ((v as string) === 'sample') { const r = await pickSample(); if (r) fileImg = r.bitmap; source = 'file'; void run(); return; }
    source = v;
    if (v === 'file') { const [f] = await pickFile('image/*'); if (!f) return; fileImg = await createImageBitmap(f); }
    void run();
  }, 'Which picture to analyse.');
  d.body.append(
    h('div', { class: 'row wrap' }, srcSel, slider({ label: 'Number of colours', min: 2, max: 24, step: 1, value: count, compact: true, onInput: (v) => { count = v; void run(); }, tip: 'How many main colours to find.' })),
    h('div', { class: 'pal-layout' }, h('div', { class: 'pal-src-wrap' }, preview), h('div', { class: 'grow' }, bar, list)),
  );
  d.footer.append(
    button('Copy as text', { icon: 'copy', tip: 'Copy the list (hex codes and percentages).', onClick: () => { void navigator.clipboard?.writeText(entries.map((e) => `${e.hex}  ${e.percent.toFixed(1)}%`).join('\n')); app.toast('Palette copied.', 'success'); } }),
    button('Palette card layer', { icon: 'layers', tip: 'Paint a palette card with the colours and percentages onto a new layer.', onClick: () => {
      const card = paletteCard(entries, Math.min(900, app.doc.width - 40));
      const l = app.doc.createLayer('Palette card');
      ctx2d(l.canvas).drawImage(card, 20, 20);
      addLayer(l, undefined, 'Palette card');
    } }),
    button('Replace swatches', { icon: 'swap', tip: 'Replace your swatches with these colours.', onClick: () => { app.settings.swatches = entries.map((e) => e.hex); app.saveSettings(); app.toast('Swatches replaced.', 'success'); } }),
    button('Add to swatches', { icon: 'plus', primary: true, tip: 'Add these colours to your swatches in the Colour panel.', onClick: () => { for (const e of entries) if (!app.settings.swatches.includes(e.hex)) app.settings.swatches.push(e.hex); app.saveSettings(); app.toast('Added to swatches.', 'success'); } }),
  );
  void run();
}
