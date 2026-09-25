// The application shell: menu bar, tool bar, options bar, dock panels, status bar and app dialogs.
import { app } from '../app/app';
import { h, modKey, svgIcon } from './dom';
import { icon } from './icons';
import { menuBar, popover, type Menu } from './menu';
import { button, numberField, segmented, select, slider, toggle } from './controls';
import { openDialog, toast } from './dialog';
import { TOOL_GROUPS } from '../tools/toolManager';
import { colorPanel } from './panels/colorPanel';
import { brushPanel } from './panels/brushPanel';
import { layersPanel } from './panels/layersPanel';
import { historyPanel } from './panels/historyPanel';
import { setTooltipsEnabled } from './tooltip';
import { addLayer, changeSelection, deleteLayer, duplicateLayer, editPixels, mergeDown, pushEntry, remapDocument, resizeDocument, setLayerProps } from '../app/ops';
import { pickSample, sampleUrl } from '../features/samples';
import { openSample } from '../features/io';
import { copySelection, exportDialog, importImage, openAny, openNewDocDialog, pasteImage, restoreAutosave, saveProject } from '../features/io';
import { FILTERS, openFilter } from '../features/filters';
import { openAdjustDialog } from '../features/adjust';
import { openPaletteDialog } from '../features/palette';
import { openAsciiDialog } from '../features/ascii';
import { openRemakeDialog } from '../features/remake';
import { references } from '../features/references';
import { timelapse } from '../features/timelapse';
import { pickFile } from './dialog';
import { importVideo } from '../features/rotoscope';
import { describe as apiDescribe, run as apiRun } from '../api/agentApi';
import { applyCrop } from '../tools/transformTools';
import { cssRgb, hexToRgb, rgbToHex } from '../core/color';
import { ctx2d } from '../core/layer';

export interface Shell { root: HTMLElement; viewportHost: HTMLElement; bottom: HTMLElement; refHost: HTMLElement }

export function buildShell(): Shell {
  const viewportHost = h('div', { class: 'viewport-host' });
  const refHost = h('div', { class: 'ref-host' });
  const bottom = h('div', { class: 'bottom-host' });
  const root = h('div', { class: 'app' },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand', tip: { title: 'Flowpaint Studio', desc: 'Liquid painting for everyone.' } }, h('span', { class: 'logo' }), h('span', null, 'Flowpaint')),
      menuBar(menus()),
      h('div', { class: 'grow' }),
      quickActions(),
    ),
    optionsBar(),
    h('main', { class: 'workspace' },
      toolbar(),
      h('div', { class: 'center' }, viewportHost, refHost, bottom),
      dock(),
    ),
    statusBar(),
  );
  document.body.append(root);
  return { root, viewportHost, bottom, refHost };
}

// ------------------------------------------------------------------------------------ menus
function menus(): Menu[] {
  const hasSel = () => !app.doc?.selection.active;
  return [
    { label: 'File', items: [
      { label: 'New painting…', icon: 'new', key: `${modKey}+N`, tip: 'Start a new canvas. Choose from paper sizes (A4…), screen sizes or an infinite canvas.', action: () => openNewDocDialog() },
      { label: 'Open…', icon: 'folder', key: `${modKey}+O`, tip: 'Open a Flowpaint project (.flowpaint) or any image as a new painting.', action: () => void openAny() },
      { label: 'Continue last painting', icon: 'history', tip: 'Restore the automatically saved painting from this browser.', action: () => void restoreAutosave() },
      { sep: true, label: '' },
      { label: 'Save project', icon: 'save', key: `${modKey}+S`, tip: 'Download a .flowpaint file with all layers, references and guides - reopen it later to keep working.', action: () => void saveProject() },
      { label: 'Export image…', icon: 'download', key: `${modKey}+Shift+E`, tip: 'Save a flat PNG, JPEG or WebP picture to share or print.', action: () => void exportDialog() },
      { sep: true, label: '' },
      { label: 'Open sample picture…', icon: 'sparkles', tip: 'Start a painting from one of the built-in pictures: two original paintings (gouache meadow, watercolour lake), still life, sunset, city, flowers, abstract.', action: () => void openSample() },
      { label: 'Import sample picture as layer…', icon: 'image', tip: 'Add a built-in sample picture as an adjustable photo layer.', action: () => void openSample(true) },
      { label: 'Import image as layer…', icon: 'image', key: `${modKey}+Shift+O`, tip: 'Add a photo or picture as a new adjustable layer (brightness, saturation…). You can also drag & drop or paste images.', action: () => void importImage() },
      { label: 'Rotoscope a video…', icon: 'video', tip: 'Import a video and trace over it frame by frame to make an animation.', action: async () => { const [f] = await pickFile('video/*'); if (f) await importVideo(f); } },
      { label: 'Timelapse…', icon: 'timer', tip: 'Replay how your painting was made and export it as a video.', action: () => void timelapse.openPlayer() },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', icon: 'undo', key: `${modKey}+Z`, tip: 'Step back. Unlimited.', action: () => void app.history.undo(), disabled: () => !app.history.canUndo },
      { label: 'Redo', icon: 'redo', key: `${modKey}+Shift+Z`, tip: 'Step forward.', action: () => void app.history.redo(), disabled: () => !app.history.canRedo },
      { sep: true, label: '' },
      { label: 'Cut', key: `${modKey}+X`, tip: 'Copy the selection (or layer) and erase it.', action: () => void copySelection(true) },
      { label: 'Copy', icon: 'copy', key: `${modKey}+C`, tip: 'Copy the selected area of the current layer.', action: () => void copySelection(false) },
      { label: 'Paste', key: `${modKey}+V`, tip: 'Paste an image as a new layer.', action: () => void pasteImage() },
      { label: 'Delete selected area', icon: 'trash', key: 'Delete', tip: 'Erase what is inside the selection on the current layer.', action: () => void clearSelection() },
      { label: 'Fill selection with colour', icon: 'bucket', key: 'Shift+Backspace', tip: 'Fill the selection (or whole layer) with the main colour.', action: () => void fillSelection() },
      { sep: true, label: '' },
      { label: 'Preferences…', icon: 'settings', key: `${modKey}+,`, tip: 'Pen pressure, colour mixing, interface and saving options.', action: openPreferences },
    ] },
    { label: 'Image', items: [
      { label: 'Canvas size…', icon: 'crop', tip: 'Add or remove space around the picture without stretching it.', action: canvasSizeDialog },
      { label: 'Image size…', icon: 'fit', tip: 'Scale the whole picture up or down.', action: imageSizeDialog },
      { label: 'Crop to selection', icon: 'crop', tip: 'Cut the canvas down to the selected area.', action: () => { const b = app.doc.selection.bounds; if (b) void applyCrop(b); else toast('Select an area first.'); }, disabled: hasSel },
      { label: 'Trim empty edges', tip: 'Remove fully transparent borders around your painting.', action: () => void trim() },
      { sep: true, label: '' },
      { label: 'Rotate canvas 90° right', icon: 'rotate', action: () => void rotateCanvas(1) },
      { label: 'Rotate canvas 90° left', icon: 'rotate', action: () => void rotateCanvas(-1) },
      { label: 'Flip canvas horizontally', icon: 'flip', tip: 'Mirror the whole picture left ↔ right (tip: great for spotting drawing mistakes).', action: () => void flipCanvas(true) },
      { label: 'Flip canvas vertically', icon: 'flip', action: () => void flipCanvas(false) },
      { sep: true, label: '' },
      { label: 'Paper colour…', icon: 'paper', tip: 'Change the background paper colour or make it transparent.', action: paperDialog },
      { label: 'Infinite canvas', checked: () => app.doc.infinite, tip: 'When on, the canvas grows automatically as you paint near its edges.', action: () => { app.doc.infinite = !app.doc.infinite; app.view.requestOverlay(); toast(app.doc.infinite ? 'Infinite canvas on - paint past the edges to grow it.' : 'Infinite canvas off.'); } },
    ] },
    { label: 'Layer', items: [
      { label: 'New layer', icon: 'plus', key: `${modKey}+Shift+N`, action: () => addLayer() },
      { label: 'Duplicate layer', icon: 'copy', key: `${modKey}+J`, action: () => duplicateLayer(app.doc.active) },
      { label: 'Delete layer', icon: 'trash', action: () => deleteLayer(app.doc.active) },
      { label: 'Merge down', icon: 'merge', key: `${modKey}+E`, action: () => void mergeDown(app.doc.active) },
      { label: 'Flatten image', icon: 'layers', tip: 'Combine all visible layers into one.', action: () => void flatten() },
      { sep: true, label: '' },
      { label: 'Adjust colours / photo…', icon: 'adjust', key: `${modKey}+U`, tip: 'Brightness, contrast, saturation, warmth and more.', action: () => openAdjustDialog(app.doc.active) },
      { label: 'Clear layer', tip: 'Erase everything on the current layer.', action: () => void editPixels(app.doc.active, null, 'Clear layer', 'trash', (c) => c.clearRect(0, 0, app.doc.width, app.doc.height)) },
      { label: 'Lock / unlock layer', icon: 'lock', action: () => setLayerProps(app.doc.active, { locked: !app.doc.active.locked }) },
      { label: 'Lock transparency', icon: 'alphaLock', tip: 'Only paint where there is already paint.', action: () => setLayerProps(app.doc.active, { alphaLock: !app.doc.active.alphaLock }) },
    ] },
    { label: 'Select', items: [
      { label: 'Select all', key: `${modKey}+A`, action: () => changeSelection((s) => s.selectAll(), 'Select all') },
      { label: 'Deselect', key: `${modKey}+D`, action: () => changeSelection((s) => s.clear(), 'Deselect'), disabled: hasSel },
      { label: 'Invert selection', key: `${modKey}+Shift+I`, tip: 'Select everything that was not selected.', action: () => changeSelection((s) => s.invert(), 'Invert selection') },
      { label: 'Select layer content', tip: 'Select everything painted on the current layer.', action: async () => { await app.backend.flush(); const img = ctx2d(app.doc.active.canvas).getImageData(0, 0, app.doc.width, app.doc.height); changeSelection((s) => s.fromAlpha(img), 'Select layer content'); } },
      { sep: true, label: '' },
      { label: 'Feather (soften edge)…', tip: 'Soften the selection edge.', action: () => amountDialog('Feather selection', 'Softness', 12, (v) => changeSelection((s) => s.feather(v), 'Feather selection')), disabled: hasSel },
      { label: 'Grow…', action: () => amountDialog('Grow selection', 'Grow by', 8, (v) => changeSelection((s) => s.growShrink(v), 'Grow selection')), disabled: hasSel },
      { label: 'Shrink…', action: () => amountDialog('Shrink selection', 'Shrink by', 8, (v) => changeSelection((s) => s.growShrink(-v), 'Shrink selection')), disabled: hasSel },
    ] },
    { label: 'Effects', items: FILTERS.map((f) => ({ label: f.name + '…', icon: f.icon, tip: f.desc, action: () => openFilter(f) })) },
    { label: 'Create', items: [
      { label: 'Remake a picture…', icon: 'sparkles', tip: 'Import a picture and let Flowpaint repaint it with brush strokes, simplify it into colour shapes, make a value study or paint-by-numbers.', action: () => openRemakeDialog() },
      { label: 'Extract colour palette…', icon: 'palette', tip: 'Find the main colours of a picture and what % of it each colour covers.', action: openPaletteDialog },
      { label: 'Coloured ASCII art…', icon: 'ascii', tip: 'Turn a picture into coloured text characters.', action: openAsciiDialog },
      { sep: true, label: '' },
      { label: 'Pin sample reference…', icon: 'pin', tip: 'Pin one of the built-in sample pictures as a floating reference.', action: async () => { const r = await pickSample('Pin a sample reference'); if (r) references.add(sampleUrl(r.sample), r.sample.name); } },
      { label: 'Pin reference image…', icon: 'pin', tip: 'Float a reference picture over your workspace. Zoom, flip, check values and pick colours from it.', action: () => void references.addFromFile() },
      { label: 'Pin snapshot of canvas', icon: 'pin', tip: 'Pin the current state of your painting as a reference to compare against later.', action: () => references.addCanvasSnapshot() },
    ] },
    { label: 'View', items: [
      { label: 'Zoom in', icon: 'zoom', key: '+', action: () => app.view.zoomAt(app.view.view.zoom * 1.25) },
      { label: 'Zoom out', key: '−', action: () => app.view.zoomAt(app.view.view.zoom / 1.25) },
      { label: 'Fit to screen', icon: 'fit', key: '0', action: () => app.view.fit() },
      { label: 'Actual pixels (100%)', key: '1', action: () => app.view.zoomAt(1) },
      { label: 'Rotate view left', icon: 'rotate', key: 'Shift+R', tip: 'Turn the canvas like a sheet of paper. Hold R and drag for free rotation.', action: () => app.view.setRotation(app.view.view.rotation - Math.PI / 12) },
      { label: 'Rotate view right', icon: 'rotate', action: () => app.view.setRotation(app.view.view.rotation + Math.PI / 12) },
      { label: 'Reset rotation', action: () => app.view.setRotation(0) },
      { sep: true, label: '' },
      { label: 'Paper texture', checked: () => app.settings.showPaper, action: () => { app.settings.showPaper = !app.settings.showPaper; app.saveSettings(); app.doc.events.emit('background', undefined); } },
      { label: 'Pixel grid when zoomed in', checked: () => app.settings.pixelGrid, action: () => { app.settings.pixelGrid = !app.settings.pixelGrid; app.saveSettings(); app.requestRender(); } },
      { label: 'Grid', checked: () => app.settings.guides.showGrid, action: () => { app.settings.guides.showGrid = !app.settings.guides.showGrid; app.saveSettings(); app.view.requestOverlay(); } },
      { label: 'Brush outline cursor', checked: () => app.settings.showBrushCursor, action: () => { app.settings.showBrushCursor = !app.settings.showBrushCursor; app.saveSettings(); app.view.updateCursor(); } },
      { label: 'Hide panels', key: 'Tab', tip: 'Focus mode: hide everything except the canvas.', action: () => document.body.classList.toggle('focus-mode') },
      { label: 'Full screen', key: 'F11', action: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); } },
    ] },
    { label: 'Help', items: [
      { label: 'Quick start', icon: 'help', key: 'F1', action: quickStart },
      { label: 'Keyboard shortcuts', icon: 'mouse', action: shortcutsDialog },
      { label: 'AI / automation API', icon: 'robot', tip: 'Control Flowpaint from scripts or AI agents: window.flowpaint.run(...)', action: apiDialog },
      { label: 'About Flowpaint', icon: 'heart', action: about },
    ] },
  ];
}

function quickActions(): HTMLElement {
  const undo = button('Undo', { icon: 'undo', small: true, tip: { title: 'Undo', desc: 'Step back. Unlimited.', key: `${modKey}+Z` }, onClick: () => void app.history.undo() });
  const redo = button('Redo', { icon: 'redo', small: true, tip: { title: 'Redo', desc: 'Step forward again.', key: `${modKey}+Shift+Z` }, onClick: () => void app.history.redo() });
  const upd = () => { undo.disabled = !app.history.canUndo; redo.disabled = !app.history.canRedo; };
  app.history.events.on('change', upd);
  upd();
  return h('div', { class: 'quick' },
    undo, redo,
    button('Import', { icon: 'image', small: true, tip: { title: 'Import image', desc: 'Add a picture as a new adjustable layer.', key: `${modKey}+Shift+O` }, onClick: () => void importImage() }),
    button('Save', { icon: 'save', small: true, tip: { title: 'Save project', desc: 'Download your painting with all layers.', key: `${modKey}+S` }, onClick: () => void saveProject() }),
    button('Export', { icon: 'download', small: true, primary: true, tip: { title: 'Export image', desc: 'Save as PNG/JPEG/WebP.', key: `${modKey}+Shift+E` }, onClick: () => void exportDialog() }),
  );
}

// ------------------------------------------------------------------------------------ toolbar
function toolbar(): HTMLElement {
  const bar = h('nav', { class: 'toolbar', 'data-tip-side': 'right', 'aria-label': 'Tools' });
  const btns = new Map<string, HTMLElement>();
  TOOL_GROUPS.forEach((g, gi) => {
    if (gi) bar.append(h('div', { class: 'tool-sep' }));
    for (const id of g) {
      const t = app.tools.get(id)!;
      const b = h('button', { class: 'tool', type: 'button', tip: { title: t.name, desc: t.desc, key: t.key } }, svgIcon(icon(t.icon)), h('span', { class: 'tool-label' }, t.name));
      b.addEventListener('click', () => app.tools.set(id));
      btns.set(id, b);
      bar.append(b);
    }
  });
  const colorChip = h('button', { class: 'tool color-chip', type: 'button', tip: { title: 'Colours', desc: 'Main colour (front) and second colour (back). Click to swap.', key: 'X' } }, h('span', { class: 'chip bg' }), h('span', { class: 'chip fg' }));
  colorChip.addEventListener('click', () => app.swapColors());
  bar.append(h('div', { class: 'grow' }), colorChip);
  const sync = () => {
    btns.forEach((b, id) => b.classList.toggle('active', app.tools.current.id === id));
    (colorChip.querySelector('.fg') as HTMLElement).style.background = cssRgb(app.color);
    (colorChip.querySelector('.bg') as HTMLElement).style.background = cssRgb(app.color2);
  };
  app.events.on('tool', sync);
  app.events.on('color', sync);
  queueMicrotask(sync);
  return bar;
}

// ------------------------------------------------------------------------------------ options bar
function optionsBar(): HTMLElement {
  const title = h('div', { class: 'opt-title' });
  const host = h('div', { class: 'opt-host' });
  const render = () => {
    const t = app.tools.current;
    title.innerHTML = '';
    title.append(svgIcon(icon(t.icon)), h('span', null, t.name));
    title.dataset.tipTitle = t.name; title.dataset.tip = t.desc; if (t.key) title.dataset.tipKey = t.key;
    host.innerHTML = '';
    if (t.options) host.append(t.options());
  };
  app.events.on('tool', render);
  app.events.on('brush', () => { if (app.tools.current.paints && !host.contains(document.activeElement) && !document.querySelector('.slider-range:active')) render(); });
  queueMicrotask(render);
  return h('div', { class: 'optionsbar' }, title, host, h('div', { class: 'grow' }), assist());
}

function assist(): HTMLElement {
  const st = app.settings;
  const stabBtn = button('Stabilizer', { icon: 'stabilizer', small: true, tip: { title: 'Stabilizer', desc: 'Smooths shaky lines. Stronger = smoother but the line trails behind a little. "Predictive" keeps fast strokes responsive.' } });
  const symBtn = button('Symmetry', { icon: 'symmetry', small: true, tip: { title: 'Symmetry', desc: 'Mirror your strokes live: left/right, top/bottom, 4-way or kaleidoscope. Drag the pink dot on the canvas to move the centre.' } });
  const guideBtn = button('Guides', { icon: 'magnet', small: true, tip: { title: 'Magnetic guides', desc: 'Rulers and perspective that gently pull your strokes straight while still feeling hand-drawn. Set them up with the Guides tool.' } });
  const sync = () => {
    stabBtn.classList.toggle('on', st.stabilizer.mode !== 'off' && st.stabilizer.strength > 0);
    (stabBtn.querySelector('.btn-label') as HTMLElement).textContent = st.stabilizer.mode === 'off' ? 'Stabilizer: off' : `Stabilizer: ${Math.round(st.stabilizer.strength)}`;
    symBtn.classList.toggle('on', st.symmetry.mode !== 'off');
    (symBtn.querySelector('.btn-label') as HTMLElement).textContent = st.symmetry.mode === 'off' ? 'Symmetry: off' : `Symmetry: ${st.symmetry.mode}`;
    guideBtn.classList.toggle('on', st.guides.enabled);
    (guideBtn.querySelector('.btn-label') as HTMLElement).textContent = st.guides.enabled ? 'Guides: on' : 'Guides: off';
  };
  stabBtn.addEventListener('click', () => {
    const s = st.stabilizer;
    popover(stabBtn, h('div', { class: 'pop-body' },
      h('div', { class: 'pop-title' }, 'Stabilizer'),
      segmented(s.mode, [
        { value: 'off', label: 'Off', tip: 'Raw input.' },
        { value: 'smooth', label: 'Smooth', tip: 'Adaptive smoothing: removes jitter on slow careful lines, stays quick on fast ones.' },
        { value: 'rope', label: 'Pulled string', tip: 'The line follows your pen like it is pulled on a string - perfect for super clean curves.' },
      ], (v) => { s.mode = v; app.saveSettings(); sync(); }),
      slider({ label: 'Strength', min: 0, max: 100, step: 1, value: s.strength, onInput: (v) => { s.strength = v; app.saveSettings(); sync(); }, tip: 'How much smoothing is applied.' }),
      toggle('Predictive catch-up', s.predictive, (v) => { s.predictive = v; app.saveSettings(); }, 'Predicts where your pen is going so fast strokes do not lag behind.'),
      toggle('Finish line at pen', s.catchUp, (v) => { s.catchUp = v; app.saveSettings(); }, 'When you lift the pen, the line catches up to exactly where you stopped.'),
    ));
  });
  symBtn.addEventListener('click', () => {
    const s = st.symmetry;
    popover(symBtn, h('div', { class: 'pop-body' },
      h('div', { class: 'pop-title' }, 'Symmetry'),
      segmented(s.mode, [
        { value: 'off', label: 'Off' },
        { value: 'vertical', label: 'Left | Right', tip: 'Mirror across a vertical line - faces, butterflies, vases.' },
        { value: 'horizontal', label: 'Top / Bottom', tip: 'Mirror across a horizontal line - reflections in water.' },
        { value: 'quad', label: '4-way', tip: 'Mirror both ways at once.' },
        { value: 'radial', label: 'Radial', tip: 'Repeat around the centre - mandalas, flowers, snowflakes.' },
      ], (v) => { s.mode = v; app.saveSettings(); sync(); app.view.requestOverlay(); }),
      slider({ label: 'Radial copies', min: 2, max: 32, step: 1, value: s.count, onInput: (v) => { s.count = v; app.saveSettings(); app.view.requestOverlay(); }, tip: 'Number of repeats around the centre (radial mode).' }),
      toggle('Kaleidoscope (mirror each copy)', s.mirror, (v) => { s.mirror = v; app.saveSettings(); }, 'Mirror every radial copy too - a true kaleidoscope.'),
      button('Centre on canvas', { icon: 'fit', small: true, onClick: () => { s.cx = app.doc.width / 2; s.cy = app.doc.height / 2; app.saveSettings(); app.view.requestOverlay(); } }),
    ));
  });
  guideBtn.addEventListener('click', () => {
    const g = st.guides;
    popover(guideBtn, h('div', { class: 'pop-body' },
      h('div', { class: 'pop-title' }, 'Magnetic guides'),
      toggle('Guides on', g.enabled, (v) => { g.enabled = v; app.saveSettings(); sync(); app.view.requestOverlay(); }, 'Strokes that start along a ruler or toward a vanishing point get gently pulled onto it.'),
      slider({ label: 'Magnet strength', min: 0, max: 1, step: 0.01, percent: true, value: g.magnet, onInput: (v) => { g.magnet = v; app.saveSettings(); }, tip: '100% = perfectly straight; lower keeps natural hand wobble.' }),
      h('p', { class: 'hint' }, `${g.rulers.length} ruler(s), ${g.perspective.length} vanishing point(s).`),
      button('Edit guides (Guides tool)', { icon: 'ruler', small: true, onClick: () => app.tools.set('guides') }),
    ));
  });
  app.events.on('settings', sync);
  sync();
  return h('div', { class: 'assist' }, stabBtn, symBtn, guideBtn);
}

// ------------------------------------------------------------------------------------ dock
function dock(): HTMLElement {
  const tabs = (items: { id: string; label: string; icon: string; tip: string; el: () => HTMLElement }[], cls: string) => {
    const head = h('div', { class: 'tabs', role: 'tablist' });
    const body = h('div', { class: 'tab-body' });
    const built = new Map<string, HTMLElement>();
    const show = (id: string) => {
      head.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.id === id));
      let el = built.get(id);
      if (!el) { el = items.find((i) => i.id === id)!.el(); built.set(id, el); body.append(el); }
      built.forEach((e, k) => (e.style.display = k === id ? '' : 'none'));
    };
    for (const it of items) {
      const t = h('button', { class: 'tab', type: 'button', role: 'tab', dataset: { id: it.id }, tip: { title: it.label, desc: it.tip } }, svgIcon(icon(it.icon)), h('span', null, it.label));
      t.addEventListener('click', () => show(it.id));
      head.append(t);
    }
    show(items[0].id);
    return h('section', { class: 'dock-section ' + cls }, head, body);
  };
  return h('aside', { class: 'dock', 'data-tip-side': 'left' },
    tabs([
      { id: 'color', label: 'Colour', icon: 'palette', tip: 'Choose colours, save swatches, see matching colours.', el: colorPanel },
      { id: 'brushes', label: 'Brushes', icon: 'brush', tip: 'Pick a brush: watercolour, oil, ink, pencil, blenders, erasers and your own.', el: brushPanel },
    ], 'top'),
    tabs([
      { id: 'layers', label: 'Layers', icon: 'layers', tip: 'Stack of transparent sheets. Paint on separate layers so you can change parts without ruining others.', el: layersPanel },
      { id: 'history', label: 'History', icon: 'history', tip: 'Every step you took. Click any step to go back to it. Unlimited.', el: historyPanel },
    ], 'bottom'),
  );
}

// ------------------------------------------------------------------------------------ status bar
function statusBar(): HTMLElement {
  const hint = h('span', { class: 'status-hint' });
  const pos = h('span', { class: 'status-pos', tip: 'Cursor position in pixels' });
  const zoomLbl = h('button', { class: 'status-zoom', type: 'button', tip: { title: 'Zoom', desc: 'Click to fit the canvas to the screen.', key: '0' } });
  zoomLbl.addEventListener('click', () => app.view.fit());
  const size = h('span', { class: 'status-size', tip: 'Canvas size' });
  const backend = h('span', { class: 'status-backend' });
  const saved = h('span', { class: 'status-saved' });
  let hintText = '';
  app.events.on('status', (m) => {
    if (m === 'Auto-saved') { saved.textContent = '✓ Auto-saved'; setTimeout(() => (saved.textContent = ''), 2500); return; }
    if (m) { hintText = m; hint.textContent = m; }
    const hv = app.view?.hover;
    pos.textContent = hv ? `${Math.round(hv.x)}, ${Math.round(hv.y)}` : '';
  });
  const upd = () => {
    if (!app.doc) return;
    zoomLbl.textContent = `${Math.round(app.view.view.zoom * 100)}%` + (app.view.view.rotation ? ` · ${Math.round((app.view.view.rotation * 180) / Math.PI)}°` : '');
    size.textContent = `${app.doc.width} × ${app.doc.height} px${app.doc.infinite ? ' · infinite' : ''}`;
    backend.textContent = app.backend.label;
    backend.dataset.tipTitle = app.backend.kind === 'webgpu' ? 'GPU painting' : 'CPU painting';
    backend.dataset.tip = app.backend.kind === 'webgpu' ? 'The liquid paint simulation runs on your graphics card with WebGPU.' : 'WebGPU is not available in this browser, so paint is simulated on the CPU. It works, but big wet brushes are slower. Try a recent Chrome or Edge.';
    if (!hint.textContent) hint.textContent = hintText || app.tools.current.hint;
  };
  app.events.on('view', upd);
  app.events.on('document', upd);
  app.doc && upd();
  queueMicrotask(upd);
  setInterval(upd, 1000);
  return h('footer', { class: 'statusbar', 'data-tip-side': 'top' },
    hint, h('div', { class: 'grow' }), saved, pos,
    button('Zoom out', { icon: 'minus', small: true, iconOnly: true, tip: { title: 'Zoom out', key: '−' }, onClick: () => app.view.zoomAt(app.view.view.zoom / 1.25) }),
    zoomLbl,
    button('Zoom in', { icon: 'plus', small: true, iconOnly: true, tip: { title: 'Zoom in', key: '+' }, onClick: () => app.view.zoomAt(app.view.view.zoom * 1.25) }),
    button('Fit', { icon: 'fit', small: true, tip: { title: 'Fit to screen', key: '0' }, onClick: () => app.view.fit() }),
    size, backend);
}

// ------------------------------------------------------------------------------------ actions
async function clearSelection() {
  const b = app.doc.selection.bounds;
  await editPixels(app.doc.active, b, 'Delete', 'trash', (c) => c.clearRect(0, 0, app.doc.width, app.doc.height));
}
async function fillSelection() {
  await editPixels(app.doc.active, app.doc.selection.bounds, 'Fill with colour', 'bucket', (c) => { c.fillStyle = cssRgb(app.color); c.fillRect(0, 0, app.doc.width, app.doc.height); });
}
async function flatten() {
  const doc = app.doc;
  await app.backend.flush();
  const flat = doc.flatten({ background: !doc.background.transparent });
  const l = doc.createLayer('Flattened');
  ctx2d(l.canvas).drawImage(flat, 0, 0);
  const old = [...doc.layers], oldActive = doc.activeId;
  const apply = (layers: typeof old, active: number) => { doc.layers = [...layers]; doc.activeId = active; doc.events.emit('structure', undefined); doc.events.emit('active', doc.active); };
  apply([l], l.id);
  pushEntry({ label: 'Flatten image', icon: 'layers', undo: () => apply(old, oldActive), redo: () => apply([l], l.id) });
}
async function trim() {
  const doc = app.doc;
  await app.backend.flush();
  const img = ctx2d(doc.flatten({ background: false })).getImageData(0, 0, doc.width, doc.height).data;
  let x0 = doc.width, y0 = doc.height, x1 = -1, y1 = -1;
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) if (img[(y * doc.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  if (x1 < 0) { toast('Nothing painted yet.'); return; }
  await applyCrop({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}
async function rotateCanvas(dir: 1 | -1) {
  const d = app.doc; const W = d.width, H = d.height;
  await remapDocument(H, W, dir > 0 ? 'Rotate canvas right' : 'Rotate canvas left', (c, src) => {
    c.translate(H / 2, W / 2); c.rotate((dir * Math.PI) / 2); c.drawImage(src, -W / 2, -H / 2);
  });
  app.view.fit();
}
async function flipCanvas(hor: boolean) {
  const d = app.doc; const W = d.width, H = d.height;
  await remapDocument(W, H, hor ? 'Flip canvas horizontally' : 'Flip canvas vertically', (c, src) => {
    if (hor) { c.translate(W, 0); c.scale(-1, 1); } else { c.translate(0, H); c.scale(1, -1); }
    c.drawImage(src, 0, 0);
  });
}

function amountDialog(title: string, label: string, def: number, fn: (v: number) => void) {
  let v = def;
  const d = openDialog(title, { width: 380 });
  d.body.append(slider({ label, min: 1, max: 200, step: 1, unit: 'px', value: def, onInput: (x) => (v = x) }));
  d.footer.append(button('Cancel', { onClick: () => d.close() }), button('OK', { primary: true, onClick: () => { fn(v); d.close(); } }));
}

function canvasSizeDialog() {
  const d0 = app.doc;
  let w = d0.width, hh = d0.height, ax = 0.5, ay = 0.5;
  const d = openDialog('Canvas size', { width: 460, icon: 'crop', subtitle: 'Add or remove space around the picture. Nothing gets stretched.' });
  const anchor = h('div', { class: 'anchor-grid', tip: { title: 'Anchor', desc: 'Where the existing picture stays. E.g. top-left adds new space to the right and bottom.' } });
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const b = h('button', { class: 'anchor' + (i === 1 && j === 1 ? ' active' : ''), type: 'button' });
    b.addEventListener('click', () => { ax = i / 2; ay = j / 2; anchor.querySelectorAll('.anchor').forEach((x) => x.classList.remove('active')); b.classList.add('active'); });
    anchor.append(b);
  }
  d.body.append(h('div', { class: 'row wrap' },
    numberField('Width', w, (v) => (w = v), { min: 1, max: 16384, unit: 'px' }),
    numberField('Height', hh, (v) => (hh = v), { min: 1, max: 16384, unit: 'px' }), anchor));
  d.footer.append(button('Cancel', { onClick: () => d.close() }), button('Apply', { primary: true, onClick: async () => {
    d.close();
    await resizeDocument(w, hh, Math.round((w - d0.width) * ax), Math.round((hh - d0.height) * ay), false, 'Canvas size');
    app.view.fit();
  } }));
}

function imageSizeDialog() {
  const d0 = app.doc;
  let w = d0.width, hh = d0.height, keep = true;
  const d = openDialog('Image size', { width: 420, icon: 'fit', subtitle: 'Scale the whole picture. Making it bigger than the original will look softer.' });
  const wf = numberField('Width', w, (v) => { w = v; if (keep) { hh = Math.round((v * d0.height) / d0.width); hf.input.value = String(hh); } }, { min: 1, max: 16384, unit: 'px' });
  const hf = numberField('Height', hh, (v) => { hh = v; if (keep) { w = Math.round((v * d0.width) / d0.height); wf.input.value = String(w); } }, { min: 1, max: 16384, unit: 'px' });
  d.body.append(h('div', { class: 'row wrap' }, wf, hf, toggle('Keep proportions', keep, (v) => (keep = v))));
  d.footer.append(button('Cancel', { onClick: () => d.close() }), button('Apply', { primary: true, onClick: async () => { d.close(); await resizeDocument(w, hh, 0, 0, true, 'Image size'); app.view.fit(); } }));
}

function paperDialog() {
  const bg = app.doc.background;
  const d = openDialog('Paper', { width: 420, icon: 'paper' });
  const col = h('input', { type: 'color', value: rgbToHex(bg.color), class: 'color-input' });
  col.addEventListener('input', () => { bg.color = hexToRgb(col.value)!; app.doc.events.emit('background', undefined); });
  d.body.append(
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Paper colour'), col),
    toggle('Transparent (no paper)', bg.transparent, (v) => { bg.transparent = v; app.doc.events.emit('background', undefined); }, 'Transparent areas stay see-through in PNG/WebP exports.'),
    slider({ label: 'Paper texture', min: 0, max: 1, step: 0.01, percent: true, value: bg.paper, onInput: (v) => { bg.paper = v; app.doc.events.emit('background', undefined); }, tip: 'Visible grain in the paper.' }),
  );
  d.footer.append(button('Done', { primary: true, onClick: () => d.close() }));
}

function openPreferences() {
  const s = app.settings;
  const d = openDialog('Preferences', { width: 520, icon: 'settings' });
  const curve = h('canvas', { width: 120, height: 120, class: 'pressure-curve', tip: { title: 'Pressure curve', desc: 'How pen pressure maps to paint. Bulging up = light touch gives a lot.' } });
  const drawCurve = () => {
    const x = curve.getContext('2d')!;
    x.clearRect(0, 0, 120, 120); x.strokeStyle = '#555'; x.strokeRect(0.5, 0.5, 119, 119);
    x.strokeStyle = '#7aa2ff'; x.lineWidth = 2; x.beginPath();
    for (let i = 0; i <= 40; i++) { const p = i / 40; const y = Math.pow(p, s.pressureGamma); if (i) x.lineTo(p * 120, 120 - y * 120); else x.moveTo(0, 120); }
    x.stroke();
  };
  const test = h('div', { class: 'pressure-test', tip: { title: 'Pressure test', desc: 'Press here with your pen to see your pressure.' } }, 'Press here with your pen');
  test.addEventListener('pointermove', (e) => { if (e.buttons) test.textContent = `Pressure: ${Math.round(e.pressure * 100)}%  (${e.pointerType})`; });
  d.body.append(
    h('div', { class: 'sub-title' }, 'Pen / stylus'),
    h('div', { class: 'row' }, curve, h('div', { class: 'col grow' },
      slider({ label: 'Pressure softness', min: 0.3, max: 3, step: 0.01, value: s.pressureGamma, tip: 'Below 1 = soft (light touch gives more paint). Above 1 = firm (you need to press harder).', onInput: (v) => { s.pressureGamma = v; drawCurve(); app.saveSettings(); } }),
      test)),
    toggle('Fingers only pan & zoom (palm rejection)', s.penOnlyDrawing, (v) => { s.penOnlyDrawing = v; app.saveSettings(); }, 'Recommended on tablets: only the pen paints, touch moves the canvas.'),
    h('div', { class: 'sub-title' }, 'Paint'),
    toggle('Realistic pigment mixing', s.spectral, (v) => { s.spectral = v; app.saveSettings(); }, 'Mix colours like real paint (blue + yellow = green) using spectral Kubelka-Munk mixing. Off = plain digital RGB mixing.'),
    h('div', { class: 'sub-title' }, 'Interface'),
    toggle('Show tooltips', true, (v) => setTooltipsEnabled(v), 'Explanations when you hover over buttons.'),
    toggle('Record timelapse', s.timelapse, (v) => { s.timelapse = v; app.saveSettings(); }, 'Keep recording frames for the timelapse video.'),
    toggle('Auto-save in this browser', s.autosave, (v) => { s.autosave = v; app.saveSettings(); }, 'Saves your painting every few seconds so you can continue after closing the tab.'),
    h('p', { class: 'hint' }, `Painting engine: ${app.backend.label}. Add ?backend=cpu to the address to force the CPU engine.`),
  );
  drawCurve();
  d.footer.append(button('Done', { primary: true, onClick: () => d.close() }));
}

export function shortcutsDialog() {
  const d = openDialog('Keyboard shortcuts', { width: 640, icon: 'mouse' });
  const rows: [string, string][] = [
    ['B / E / S', 'Brush / Eraser / Blend'], ['G / Shift+G', 'Fill / Gradient'], ['I', 'Colour picker (or Alt+click while painting)'], ['U', 'Shapes'],
    ['M / L / W', 'Select / Lasso / Magic wand'], ['V', 'Move & transform'], ['C', 'Crop'], ['K', 'Guides'], ['H / Space (hold)', 'Pan the canvas'], ['Z', 'Zoom tool'],
    ['R (hold) + drag', 'Rotate the view'], ['[ and ]', 'Brush smaller / bigger'], ['Shift+[ / Shift+]', 'Softer / harder brush edge'], ['1…9 (with Brush)', 'Opacity 10%…90%, 0 = 100%'],
    ['X', 'Swap main / second colour'], ['Shift+click', 'Straight line from last point'], ['Right-click', 'Pick colour while painting'],
    [`${modKey}+Z / ${modKey}+Shift+Z`, 'Undo / redo (unlimited)'], [`${modKey}+N / O / S`, 'New / open / save project'], [`${modKey}+Shift+E`, 'Export image'],
    [`${modKey}+A / D / Shift+I`, 'Select all / deselect / invert'], [`${modKey}+C / X / V`, 'Copy / cut / paste'], [`${modKey}+J / E`, 'Duplicate layer / merge down'], [`${modKey}+U`, 'Adjust colours'],
    ['0 / 1 / + / −', 'Fit / 100% / zoom in / out'], [', and .', 'Previous / next frame (rotoscope)'], ['Tab', 'Hide panels (focus mode)'], ['F1', 'Quick start'],
    ['Two fingers', 'Pan, pinch-zoom and rotate on touch screens'],
  ];
  d.body.append(h('div', { class: 'shortcut-grid' }, ...rows.flatMap(([k, v]) => [h('span', { class: 'kbd' }, k), h('span', null, v)])));
}

export function quickStart() {
  const d = openDialog('Quick start', { width: 640, icon: 'help', subtitle: 'Flowpaint works like real paint, minus the mess.' });
  const steps: [string, string, string][] = [
    ['brush', 'Paint', 'Pick a brush in the Brushes panel (watercolour, oil, ink…) and a colour in the Colour panel. Drag on the canvas. With a pen, pressing harder paints thicker.'],
    ['smudge', 'Blend', 'Wet brushes mix with the colour underneath automatically. Use the Blend tool to smudge colours together like a finger.'],
    ['layers', 'Use layers', 'Paint different parts (sky, trees, figure) on separate layers - then you can change one without ruining the others.'],
    ['undo', 'Undo anything', `Unlimited undo (${modKey}+Z). The History panel lets you jump back to any step.`],
    ['image', 'Work from photos', 'Import or drag in a photo, adjust it, pin references, or use Create → Remake a picture for an automatic painterly start.'],
    ['stabilizer', 'Clean lines', 'Turn up the Stabilizer (top right) for smooth lines, Symmetry for mirrored drawing, Guides for straight & perspective lines.'],
    ['download', 'Save & share', 'Save project keeps layers. Export image makes a PNG/JPEG. Everything auto-saves in your browser too.'],
  ];
  d.body.append(h('div', { class: 'qs' }, ...steps.map(([ic, t, s]) => h('div', { class: 'qs-step' }, svgIcon(icon(ic)), h('div', null, h('strong', null, t), h('p', null, s))))));
  d.footer.append(button('Keyboard shortcuts', { onClick: () => { d.close(); shortcutsDialog(); } }), button('Start painting', { primary: true, onClick: () => d.close() }));
}

function apiDialog() {
  const d = openDialog('AI / automation API', { width: 820, icon: 'robot', subtitle: 'Every action in Flowpaint can be driven from code - by you, a script, a browser extension or an AI agent.' });
  const ta = h('textarea', { class: 'api-input', spellcheck: false, value: JSON.stringify({ command: 'stroke', args: { points: [[200, 300, 0.3], [400, 250, 1], [600, 320, 0.4]], color: '#1d4ed8', brush: 'watercolor', size: 50 } }, null, 2) });
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  const out = h('pre', { class: 'api-output' });
  const list = h('div', { class: 'api-list' });
  for (const c of apiDescribe()) {
    const item = h('button', { class: 'api-cmd', type: 'button', tip: { title: c.name, desc: c.description } }, h('strong', null, c.name), h('span', null, c.description));
    item.addEventListener('click', () => { ta.value = JSON.stringify({ command: c.name, args: c.example ?? Object.fromEntries(Object.keys(c.params).map((k) => [k, null])) }, null, 2); out.textContent = Object.entries(c.params).map(([k, v]) => `${k}: ${v}`).join('\n') || '(no parameters)'; });
    list.append(item);
  }
  d.body.append(
    h('pre', { class: 'api-usage' }, `// In the browser console, a script, or an agent with page access:
await flowpaint.run('setColor', { color: '#e11d48' });
await flowpaint.run('stroke', { points: [[100,100,0.2],[400,200,1]], brush: 'oil', size: 30 });
const state = await flowpaint.getState();        // layers, colours, brush, history…
const png = await flowpaint.snapshot({ maxSize: 512 }); // image for vision models
flowpaint.help();                                  // every command with parameter docs

// From another frame / extension:
window.postMessage({ type: 'flowpaint', id: 1, command: 'getState' }, '*');`),
    h('div', { class: 'api-layout' }, list, h('div', { class: 'col grow' }, ta, out)),
  );
  d.footer.append(button('Run', { icon: 'play', primary: true, onClick: async () => {
    try { const j = JSON.parse(ta.value); const r = await apiRun(j.command, j.args); out.textContent = typeof r === 'string' && r.startsWith('data:') ? r.slice(0, 120) + '…' : JSON.stringify(r, null, 2); }
    catch (e) { out.textContent = 'Error: ' + (e as Error).message; }
  } }));
}

function about() {
  const d = openDialog('About Flowpaint Studio', { width: 520, icon: 'heart' });
  d.body.append(h('p', { class: 'dialog-text' }, 'A stylus-first 2D painting studio with a real-time liquid paint simulation (WebGPU compute shaders, CPU fallback), spectral Kubelka-Munk pigment mixing, unlimited history, and WebAssembly image processing. Everything runs locally in your browser - nothing is uploaded.'),
    h('p', { class: 'hint' }, `Engine: ${app.backend.label}`));
}

export { toast };
export { select };
