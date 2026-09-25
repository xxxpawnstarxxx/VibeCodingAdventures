import { app } from './app';
import { isTyping } from './viewport';
import { addLayer, changeSelection, duplicateLayer, editPixels, mergeDown } from './ops';
import { copySelection, exportDialog, importImage, openAny, openNewDocDialog, pasteImage, saveProject } from '../features/io';
import { openAdjustDialog } from '../features/adjust';
import { quickStart } from '../ui/shell';
import { cssRgb } from '../core/color';
import { moveLayer } from './ops';

export function installShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    (window as any).__shiftHeld = e.shiftKey;
    if (isTyping(e) || document.querySelector('.dialog-backdrop:not(.modeless)')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (app.tools.handleKey(e)) { e.preventDefault(); return; }
    const run = (fn: () => unknown) => { e.preventDefault(); fn(); };
    if (mod) {
      if (k === 'z' && e.shiftKey) return run(() => app.history.redo());
      if (k === 'z') return run(() => app.history.undo());
      if (k === 'y') return run(() => app.history.redo());
      if (k === 'n' && e.shiftKey) return run(() => addLayer());
      if (k === 'n') return run(() => openNewDocDialog());
      if (k === 'o' && e.shiftKey) return run(() => importImage());
      if (k === 'o') return run(() => openAny());
      if (k === 's') return run(() => saveProject());
      if (k === 'e' && e.shiftKey) return run(() => exportDialog());
      if (k === 'e') return run(() => mergeDown(app.doc.active));
      if (k === 'j') return run(() => duplicateLayer(app.doc.active));
      if (k === 'a') return run(() => changeSelection((s) => s.selectAll(), 'Select all'));
      if (k === 'd') return run(() => changeSelection((s) => s.clear(), 'Deselect'));
      if (k === 'i' && e.shiftKey) return run(() => changeSelection((s) => s.invert(), 'Invert selection'));
      if (k === 'c') return run(() => copySelection(false));
      if (k === 'x') return run(() => copySelection(true));
      if (k === 'u') return run(() => openAdjustDialog(app.doc.active));
      if (k === ']') return run(() => moveLayer(app.doc.active, app.doc.indexOf(app.doc.active) + 1));
      if (k === '[') return run(() => moveLayer(app.doc.active, app.doc.indexOf(app.doc.active) - 1));
      if (k === '0') return run(() => app.view.fit());
      if (k === ',') return run(() => (document.querySelector('.menu-btn') as HTMLElement)?.click());
      return;
    }
    if (e.altKey) return;
    // tool keys
    const toolKeys: Record<string, string> = { b: 'brush', e: 'eraser', s: 'smudge', i: 'picker', u: 'shapes', m: 'select', l: 'lasso', w: 'wand', v: 'move', c: 'crop', k: 'guides', h: 'hand', z: 'zoom' };
    if (k === 'g') return run(() => app.tools.set(e.shiftKey ? 'gradient' : 'fill'));
    if (toolKeys[k] && !e.shiftKey) return run(() => app.tools.set(toolKeys[k]));
    if (k === 'r' && e.shiftKey) return run(() => app.view.setRotation(app.view.view.rotation - Math.PI / 12));
    if (k === 'x') return run(() => app.swapColors());
    if (k === 'tab') return run(() => document.body.classList.toggle('focus-mode'));
    if (e.key === 'F1') return run(() => quickStart());
    if (e.key === '+' || e.key === '=') return run(() => app.view.zoomAt(app.view.view.zoom * 1.25));
    if (e.key === '-' || e.key === '_') return run(() => app.view.zoomAt(app.view.view.zoom / 1.25));
    if (e.key === '[' || e.key === '{') return run(() => {
      const b = app.brush;
      if (e.shiftKey) b.hardness = Math.max(0, b.hardness - 0.1); else b.size = Math.max(1, Math.round(b.size / 1.15));
      app.brushChanged(); app.view.requestOverlay();
    });
    if (e.key === ']' || e.key === '}') return run(() => {
      const b = app.brush;
      if (e.shiftKey) b.hardness = Math.min(1, b.hardness + 0.1); else b.size = Math.min(600, Math.round(b.size * 1.15 + 1));
      app.brushChanged(); app.view.requestOverlay();
    });
    if (/^[0-9]$/.test(e.key) && app.tools.current.paints) return run(() => { app.brush.opacity = e.key === '0' ? 1 : Number(e.key) / 10; app.brushChanged(); app.toast(`Opacity ${Math.round(app.brush.opacity * 100)}%`); });
    if (e.key === '0') return run(() => app.view.fit());
    if (e.key === '1') return run(() => app.view.zoomAt(1));
    if (e.key === 'Delete' || (e.key === 'Backspace' && !e.shiftKey)) return run(() => editPixels(app.doc.active, app.doc.selection.bounds, 'Delete', 'trash', (c) => c.clearRect(0, 0, app.doc.width, app.doc.height)));
    if (e.key === 'Backspace' && e.shiftKey) return run(() => editPixels(app.doc.active, app.doc.selection.bounds, 'Fill with colour', 'bucket', (c) => { c.fillStyle = cssRgb(app.color); c.fillRect(0, 0, app.doc.width, app.doc.height); }));
  });
  window.addEventListener('keyup', (e) => { (window as any).__shiftHeld = e.shiftKey; });
  window.addEventListener('paste', (e) => { if (!isTyping(e)) { e.preventDefault(); void pasteImage(e); } });
}
