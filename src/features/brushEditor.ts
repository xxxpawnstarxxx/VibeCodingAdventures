// Brush editor: every brush property with explanations, live preview, custom tips, save/import/export.
import { app } from '../app/app';
import { BRUSH_FIELDS, PRESETS, cloneBrush, normalizeBrush, type BrushSettings } from '../engine/brush';
import { h } from '../ui/dom';
import { button, select, slider, textField, toggle } from '../ui/controls';
import { download, openDialog, pickFile, type DialogHandle } from '../ui/dialog';
import { renderBrushPreview, refreshBrushList } from '../ui/panels/brushPanel';
import { ctx2d, makeCanvas } from '../core/layer';

let open: DialogHandle | null = null;

/** Convert an image to a brush tip: dark/opaque = paint. Returns a 128px PNG data URL with alpha = amount. */
export function imageToTip(src: CanvasImageSource, w: number, hh: number): string {
  const S = 128;
  const c = makeCanvas(S, S);
  const x = ctx2d(c);
  const s = Math.min(S / w, S / hh);
  x.drawImage(src, (S - w * s) / 2, (S - hh * s) / 2, w * s, hh * s);
  const img = x.getImageData(0, 0, S, S);
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 250) opaque++;
  const mostlyOpaque = opaque > S * S * 0.9;
  for (let i = 0; i < img.data.length; i += 4) {
    const lum = (img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114) / 255;
    const a = img.data[i + 3] / 255;
    const amt = mostlyOpaque ? 1 - lum : a * (1 - lum * 0.5);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    img.data[i + 3] = Math.round(Math.max(0, Math.min(1, amt)) * 255);
  }
  x.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

export function openBrushEditor(asNew = false): void {
  if (open) { open.close(); }
  const d = openDialog(asNew ? 'Create a brush' : 'Brush editor', { width: 760, icon: 'brush', subtitle: 'Changes apply immediately - try them on the canvas. Save to keep them as your own brush.', modal: false, className: 'brush-editor' });
  open = d;
  d.onClose = () => { open = null; };
  const b = app.brush;
  if (asNew) { b.name = b.name.startsWith('My ') ? b.name : 'My ' + b.name; }

  const preview = h('img', { class: 'be-preview', alt: 'Brush preview' });
  let timer = 0;
  const refresh = () => { clearTimeout(timer); timer = window.setTimeout(() => { preview.src = renderBrushPreview(app.brush, 360, 90).toDataURL(); }, 60); };
  const changed = () => { app.brushChanged(); refresh(); };

  const tipCanvas = h('canvas', { class: 'tip-canvas checker', width: 128, height: 128, tip: { title: 'Brush tip', desc: 'Draw here with the mouse or pen to design your own tip. Dark = paint.' } });
  const tctx = tipCanvas.getContext('2d')!;
  const drawTipPreview = () => {
    tctx.clearRect(0, 0, 128, 128);
    if (app.brush.tipImage) { const im = new Image(); im.onload = () => tctx.drawImage(im, 0, 0, 128, 128); im.src = app.brush.tipImage; }
  };
  let drawing = false;
  tipCanvas.addEventListener('pointerdown', (e) => {
    drawing = true; tipCanvas.setPointerCapture(e.pointerId);
    if (app.brush.tip !== 'texture') { tctx.clearRect(0, 0, 128, 128); }
    paintTip(e);
  });
  const paintTip = (e: PointerEvent) => {
    const r = tipCanvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 128, y = ((e.clientY - r.top) / r.height) * 128;
    const g = tctx.createRadialGradient(x, y, 0, x, y, 9);
    g.addColorStop(0, `rgba(0,0,0,${e.pressure || 0.5})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    tctx.fillStyle = g; tctx.fillRect(x - 10, y - 10, 20, 20);
  };
  tipCanvas.addEventListener('pointermove', (e) => { if (drawing) paintTip(e); });
  tipCanvas.addEventListener('pointerup', () => { drawing = false; setTip(tipCanvas.toDataURL('image/png')); });
  const setTip = (url: string) => { app.brush.tipImage = url; app.brush.tip = 'texture'; tipSel.set('texture'); changed(); drawTipPreview(); };
  const tipSel = select('Tip shape', b.tip, BRUSH_FIELDS.find((f) => f.key === 'tip')!.options! as { value: BrushSettings['tip']; label: string }[], (v) => { app.brush.tip = v; changed(); }, 'The footprint of the brush.');

  const groups = new Map<string, HTMLElement>();
  const controls: HTMLElement[] = [];
  for (const f of BRUSH_FIELDS) {
    if (f.key === 'tip') continue;
    let g = groups.get(f.group);
    if (!g) { g = h('fieldset', { class: 'be-group' }, h('legend', null, f.group)); groups.set(f.group, g); }
    const v = (b as any)[f.key];
    let c: HTMLElement;
    if (f.options) c = select(f.label, String(v), f.options, (nv) => { (app.brush as any)[f.key] = nv; changed(); }, f.tip);
    else if (typeof v === 'boolean') c = toggle(f.label, v, (nv) => { (app.brush as any)[f.key] = nv; changed(); }, f.tip);
    else c = slider({ label: f.label, tip: f.tip, min: f.min!, max: f.max!, step: f.step, unit: f.unit, percent: f.percent, value: v, curve: f.key === 'size' ? 2.2 : 1, onInput: (nv) => { (app.brush as any)[f.key] = nv; changed(); } });
    g.append(c);
    controls.push(c);
  }
  const modeSel = select('Brush type', b.mode, [{ value: 'paint', label: 'Paint' }, { value: 'erase', label: 'Eraser' }, { value: 'smudge', label: 'Smudge' }, { value: 'blend', label: 'Soft blend' }], (v) => { app.brush.mode = v; changed(); }, 'What the brush does: put paint down, remove it, or move existing paint.');
  groups.get('Shape')!.insertBefore(tipSel, groups.get('Shape')!.children[1]);
  groups.get('Shape')!.insertBefore(modeSel, groups.get('Shape')!.children[1]);

  const nameF = textField('Name', b.name, (v) => { app.brush.name = v; app.events.emit('brush', undefined); }, 'Give your brush a name.');
  const tipTools = h('div', { class: 'tip-tools' },
    tipCanvas,
    h('div', { class: 'col' },
      button('Load tip image…', { icon: 'image', small: true, tip: 'Use any image as a brush tip (e.g. a leaf, a sponge texture, a stamp). Dark or opaque areas become paint.', onClick: async () => {
        const [f] = await pickFile('image/*'); if (!f) return;
        const bmp = await createImageBitmap(f); setTip(imageToTip(bmp, bmp.width, bmp.height));
      } }),
      button('Tip from selection', { icon: 'select', small: true, tip: 'Select part of your painting first, then click this to turn it into a brush tip.', onClick: () => {
        const sb = app.doc.selection.bounds;
        if (!sb) { app.toast('Select an area on the canvas first (Select or Lasso tool).', 'info'); return; }
        const c = makeCanvas(sb.w, sb.h); ctx2d(c).drawImage(app.doc.flatten({ region: sb, background: false }), 0, 0);
        setTip(imageToTip(c, sb.w, sb.h));
      } }),
      button('Clear tip', { icon: 'trash', small: true, tip: 'Go back to a round tip.', onClick: () => { app.brush.tipImage = undefined; app.brush.tip = 'round'; tipSel.set('round'); changed(); drawTipPreview(); } }),
    ));

  d.body.append(
    h('div', { class: 'be-top' }, h('div', { class: 'be-prev-wrap checker' }, preview), h('div', { class: 'col grow' }, nameF, h('p', { class: 'hint' }, b.description || 'Adjust the settings below. Hover any setting to see what it does.'))),
    h('div', { class: 'be-grid' }, ...groups.values(), h('fieldset', { class: 'be-group' }, h('legend', null, 'Custom tip'), tipTools)),
  );

  const saveNew = () => {
    const nb = cloneBrush(app.brush);
    nb.id = 'custom-' + Date.now().toString(36);
    nb.custom = true; nb.category = 'Custom';
    app.customBrushes.push(nb);
    app.saveCustom();
    app.selectBrush(nb);
    refreshBrushList();
    app.toast(`Saved "${nb.name}" to your brushes.`, 'success');
  };
  const cur = app.brush;
  const isCustom = app.customBrushes.some((c) => c.id === cur.id);
  d.footer.append(...[
    button('Reset to original', { icon: 'undo', tip: 'Undo all changes to this brush.', onClick: () => {
      const orig = PRESETS.find((p) => p.id === cur.id) ?? app.customBrushes.find((p) => p.id === cur.id);
      if (orig) { app.selectBrush(orig); openBrushEditor(); }
    } }),
    button('Export…', { icon: 'download', tip: 'Download this brush as a file to share it.', onClick: () => download(new Blob([JSON.stringify(app.brush, null, 2)], { type: 'application/json' }), `${app.brush.name.replace(/\W+/g, '-')}.flowbrush.json`) }),
    button('Import…', { icon: 'upload', tip: 'Load a brush file (.flowbrush.json).', onClick: async () => {
      const [f] = await pickFile('.json,application/json'); if (!f) return;
      try { const nb = normalizeBrush(JSON.parse(await f.text())); app.selectBrush(nb); saveNew(); openBrushEditor(); } catch { app.toast('That file is not a valid brush.', 'error'); }
    } }),
    isCustom ? button('Delete brush', { icon: 'trash', danger: true, onClick: () => {
      app.customBrushes = app.customBrushes.filter((c) => c.id !== cur.id); app.saveCustom();
      app.selectBrush(PRESETS[0]); refreshBrushList(); d.close();
    } }) : null,
    isCustom ? button('Update brush', { icon: 'save', tip: 'Save changes to this custom brush.', onClick: () => {
      const i = app.customBrushes.findIndex((c) => c.id === cur.id);
      if (i >= 0) { app.customBrushes[i] = { ...cloneBrush(app.brush), custom: true, category: 'Custom' }; app.saveCustom(); refreshBrushList(); app.toast('Brush updated.', 'success'); }
    } }) : null,
    button('Save as new brush', { icon: 'plus', primary: true, tip: 'Keep these settings as your own brush in the Brushes panel.', onClick: saveNew }),
  ].filter(Boolean) as Node[]);
  refresh();
  drawTipPreview();
}
