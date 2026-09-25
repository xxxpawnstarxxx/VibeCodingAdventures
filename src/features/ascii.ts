// Image -> coloured ASCII art. Output as a layer, PNG, plain text, or coloured HTML.
import { app } from '../app/app';
import { ctx2d, makeCanvas } from '../core/layer';
import { addLayer } from '../app/ops';
import { h } from '../ui/dom';
import { button, select, slider, toggle } from '../ui/controls';
import { download, openDialog, pickFile } from '../ui/dialog';
import { pickSample } from './samples';

export const CHARSETS: Record<string, string> = {
  classic: ' .:-=+*#%@',
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks: ' ░▒▓█',
  dots: ' ⠁⠃⠇⡇⣇⣧⣷⣿',
  letters: ' ilcoaeOQ@',
};

export interface AsciiOpts { columns: number; charset: string; custom: string; colored: boolean; invert: boolean; background: string; fontSize: number; contrast: number }

export interface AsciiResult { text: string; cells: { ch: string; color: string }[][]; cols: number; rows: number }

export function toAscii(src: CanvasImageSource & { width: number; height: number }, o: AsciiOpts): AsciiResult {
  const chars = o.charset === 'custom' ? (o.custom || ' .#') : CHARSETS[o.charset];
  const cols = Math.max(8, Math.round(o.columns));
  const aspect = 0.5; // character cells are about twice as tall as wide
  const rows = Math.max(4, Math.round((src.height / src.width) * cols * aspect));
  const c = makeCanvas(cols, rows);
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, cols, rows);
  const d = x.getImageData(0, 0, cols, rows).data;
  const cells: { ch: string; color: string }[][] = [];
  let text = '';
  for (let r = 0; r < rows; r++) {
    const row: { ch: string; color: string }[] = [];
    for (let q = 0; q < cols; q++) {
      const i = (r * cols + q) * 4;
      const a = d[i + 3] / 255;
      let l = ((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255) * a + (1 - a);
      l = Math.min(1, Math.max(0, (l - 0.5) * o.contrast + 0.5));
      // dark background -> bright pixels get dense chars; light background -> dark pixels dense
      const density = o.invert ? l : 1 - l;
      const ch = chars[Math.min(chars.length - 1, Math.floor(density * chars.length))];
      row.push({ ch, color: `rgb(${d[i]},${d[i + 1]},${d[i + 2]})` });
      text += ch;
    }
    cells.push(row);
    text += '\n';
  }
  return { text, cells, cols, rows };
}

export function renderAscii(res: AsciiResult, o: AsciiOpts, width?: number): HTMLCanvasElement {
  const fs = o.fontSize;
  const cw = fs * 0.6, lh = fs * 1.2;
  let w = Math.ceil(res.cols * cw), hh = Math.ceil(res.rows * lh);
  const scale = width ? width / w : 1;
  w = Math.ceil(w * scale); hh = Math.ceil(hh * scale);
  const c = makeCanvas(w, hh);
  const x = ctx2d(c);
  x.scale(scale, scale);
  if (o.background !== 'transparent') { x.fillStyle = o.background; x.fillRect(0, 0, w / scale, hh / scale); }
  x.font = `${fs}px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;
  x.textBaseline = 'top';
  const mono = o.background === '#000000' ? '#e8e8e8' : '#111';
  for (let r = 0; r < res.rows; r++) for (let q = 0; q < res.cols; q++) {
    const cell = res.cells[r][q];
    if (cell.ch === ' ') continue;
    x.fillStyle = o.colored ? cell.color : mono;
    x.fillText(cell.ch, q * cw, r * lh);
  }
  return c;
}

export function asciiHTML(res: AsciiResult, o: AsciiOpts): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let body = '';
  for (const row of res.cells) {
    for (const c of row) body += o.colored && c.ch !== ' ' ? `<span style="color:${c.color}">${esc(c.ch)}</span>` : esc(c.ch);
    body += '\n';
  }
  return `<!doctype html><meta charset="utf-8"><title>ASCII art</title><body style="margin:0;background:${o.background === 'transparent' ? '#fff' : o.background}"><pre style="font:${o.fontSize}px/1.2 ui-monospace,Menlo,Consolas,monospace;margin:16px">${body}</pre></body>`;
}

export function openAsciiDialog(): void {
  const o: AsciiOpts = { columns: 120, charset: 'detailed', custom: '', colored: true, invert: false, background: '#ffffff', fontSize: 10, contrast: 1.1 };
  let source: 'picture' | 'layer' | 'file' = 'picture';
  let fileImg: ImageBitmap | null = null;
  let res: AsciiResult | null = null;
  const d = openDialog('Coloured ASCII art', { width: 820, icon: 'ascii', subtitle: 'Turns a picture into text characters, each coloured like the original. Place it on the canvas or download it.' });
  const view = h('div', { class: 'ascii-view' });
  let timer = 0;
  const run = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      await app.backend.flush();
      const src = source === 'file' && fileImg ? fileImg : source === 'layer' ? app.doc.active.canvas : app.doc.flatten({ background: true });
      res = toAscii(src, o);
      const c = renderAscii(res, o, 760);
      view.innerHTML = '';
      view.append(c);
    }, 80);
  };
  d.body.append(
    h('div', { class: 'row wrap' },
      select('Picture', source, [{ value: 'picture', label: 'Whole picture' }, { value: 'layer', label: 'Current layer' }, { value: 'file', label: 'An image file…' }, { value: 'sample' as 'file', label: 'A sample picture…' }], async (v) => {
        if ((v as string) === 'sample') { const r = await pickSample(); if (r) fileImg = r.bitmap; source = 'file'; run(); return; }
        source = v; if (v === 'file') { const [f] = await pickFile('image/*'); if (f) fileImg = await createImageBitmap(f); } run();
      }, 'Which picture to convert.'),
      select('Characters', o.charset, [{ value: 'detailed', label: 'Detailed (70 chars)' }, { value: 'classic', label: 'Classic  .:-=+*#%@' }, { value: 'blocks', label: 'Blocks ░▒▓█' }, { value: 'dots', label: 'Braille dots' }, { value: 'letters', label: 'Letters' }, { value: 'custom', label: 'Custom…' }], (v) => {
        o.charset = v; if (v === 'custom') { o.custom = prompt('Characters from light to dark (start with a space):', ' .oO@') ?? ' .#'; } run();
      }, 'The set of characters used, from empty to dense.'),
      select('Background', o.background, [{ value: '#000000', label: 'Black' }, { value: '#ffffff', label: 'White' }, { value: 'transparent', label: 'Transparent' }], (v) => { o.background = v; o.invert = v === '#000000'; run(); }, 'Background behind the characters.'),
    ),
    h('div', { class: 'row wrap' },
      slider({ label: 'Width in characters', min: 20, max: 400, step: 1, value: o.columns, compact: true, onInput: (v) => { o.columns = v; run(); }, tip: 'More characters = more detail.' }),
      slider({ label: 'Font size', min: 4, max: 32, step: 1, value: o.fontSize, unit: 'px', compact: true, onInput: (v) => { o.fontSize = v; run(); }, tip: 'Character size in the output image.' }),
      slider({ label: 'Contrast', min: 0.5, max: 3, step: 0.05, value: o.contrast, compact: true, onInput: (v) => { o.contrast = v; run(); }, tip: 'Boost to make the shapes pop.' }),
      toggle('Coloured', o.colored, (v) => { o.colored = v; run(); }, 'Colour each character like the original pixel.'),
    ),
    view,
  );
  d.footer.append(
    button('Copy text', { icon: 'copy', tip: 'Copy the plain characters (no colour) for chats and code.', onClick: () => { if (res) void navigator.clipboard?.writeText(res.text); app.toast('ASCII text copied.', 'success'); } }),
    button('Download .txt', { icon: 'download', onClick: () => res && download(new Blob([res.text], { type: 'text/plain' }), 'ascii-art.txt') }),
    button('Download coloured .html', { icon: 'download', tip: 'A web page with every character in colour.', onClick: () => res && download(new Blob([asciiHTML(res, o)], { type: 'text/html' }), 'ascii-art.html') }),
    button('Download PNG', { icon: 'image', onClick: () => res && renderAscii(res, o).toBlob((b) => b && download(b, 'ascii-art.png')) }),
    button('Place on canvas', { icon: 'layers', primary: true, tip: 'Add the ASCII art as a new layer, fitted to the canvas.', onClick: () => {
      if (!res) return;
      const c = renderAscii(res, o);
      const l = app.doc.createLayer('ASCII art');
      const s = Math.min(app.doc.width / c.width, app.doc.height / c.height);
      ctx2d(l.canvas).drawImage(c, (app.doc.width - c.width * s) / 2, (app.doc.height - c.height * s) / 2, c.width * s, c.height * s);
      addLayer(l, undefined, 'ASCII art');
      d.close();
    } }),
  );
  run();
}
