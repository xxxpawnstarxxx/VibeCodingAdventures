// Automation / AI agent API.
//
//   window.flowpaint.help()                          -> list of commands with parameter docs
//   await window.flowpaint.run('stroke', { points: [[100,100],[300,200,0.5]] })
//   await window.flowpaint.batch([{ command: 'setColor', args: { color: '#ff0000' } }, ...])
//   await window.flowpaint.snapshot({ maxSize: 512 })  -> PNG data URL for vision models
//
// Also reachable via window.postMessage({ type: 'flowpaint', id, command, args }) from a parent
// frame or browser extension; the reply is posted back as { type: 'flowpaint-result', id, ok, result|error }.
// Every command is recorded in the normal undo history, exactly like manual edits.
import { app } from '../app/app';
import { parseColor, rgbToHex, type RGB } from '../core/color';
import { BLEND_MODES, type BlendMode } from '../core/layer';
import { addLayer, changeSelection, deleteLayer, duplicateLayer, mergeDown, moveLayer, resizeDocument, setLayerProps } from '../app/ops';
import { BRUSH_FIELDS, cloneBrush } from '../engine/brush';
import { StrokeBuilder } from '../engine/stroke';
import { tipIndex } from '../engine/types';
import { commitShape, shapeOpts, type ShapeKind } from '../tools/shapeTool';
import { drawGradient } from '../tools/fillTools';
import { floodFillMask } from '../wasm/wasm';
import { ctx2d, makeCanvas } from '../core/layer';
import { editPixels } from '../app/ops';
import { FILTERS, applyFilterNow } from '../features/filters';
import { downscale, extractPalette } from '../features/palette';
import { toAscii } from '../features/ascii';
import { remakeHeadless } from '../features/remake';
import { addImageLayer, renderImageLayer } from '../features/adjust';
import { newDocument, exportImageDataURL, serialize, deserialize, DOC_PRESETS } from '../features/io';
import { references } from '../features/references';
import { sampleColor } from '../tools/tool';
import { setPerspective } from '../tools/transformTools';
import { importVideo, rotoInfo, setFrame } from '../features/rotoscope';

type Args = Record<string, any>;
interface Command { description: string; params: Record<string, string>; example?: Args; run(a: Args): unknown | Promise<unknown> }

async function loadImage(src: string): Promise<ImageBitmap> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Could not load image (${res.status})`);
  return createImageBitmap(await res.blob());
}

function layerInfo(l = app.doc.active) {
  return { id: l.id, name: l.name, kind: l.kind, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, alphaLock: l.alphaLock, index: app.doc.indexOf(l) };
}

function findLayer(a: Args) {
  const doc = app.doc;
  const l = a.layer === undefined ? doc.active : typeof a.layer === 'number' ? doc.getLayer(a.layer) ?? doc.layers[a.layer] : doc.layers.find((x) => x.name === a.layer);
  if (!l) throw new Error(`Layer not found: ${a.layer}`);
  return l;
}

function color(v: unknown, fallback: RGB): RGB {
  if (v === undefined) return fallback;
  const c = parseColor(v);
  if (!c) throw new Error(`Unrecognised colour: ${JSON.stringify(v)} (use "#rrggbb", "rgb(r,g,b)", [r,g,b] or a basic colour name)`);
  return c;
}

/** Paint a stroke through the real liquid brush engine. */
async function stroke(a: Args): Promise<unknown> {
  const pts: number[][] = a.points;
  if (!Array.isArray(pts) || pts.length < 1) throw new Error('points must be an array of [x, y, pressure?]');
  if (a.tool) app.tools.set(a.tool);
  if (a.brush) { const b = app.allBrushes.find((x) => x.id === a.brush || x.name.toLowerCase() === String(a.brush).toLowerCase()); if (!b) throw new Error(`Unknown brush ${a.brush}`); app.selectBrush(b); }
  const brush = { ...cloneBrush(app.brush), ...(a.settings ?? {}) };
  if (a.size) brush.size = a.size;
  const layer = findLayer(a);
  if (!layer.editable) throw new Error(`Layer "${layer.name}" is locked or not paintable`);
  const col = color(a.color, app.color);
  const sb = new StrokeBuilder({
    brush, color: col, color2: app.color2,
    stabilizer: a.smooth ? app.settings.stabilizer : { mode: 'off', strength: 0, predictive: false, catchUp: false },
    symmetry: a.symmetry === false ? { ...app.settings.symmetry, mode: 'off' } : app.settings.symmetry,
    guides: { ...app.settings.guides, enabled: false }, zoom: 1, isPen: true, pressureGamma: 1,
  });
  app.backend.beginStroke(layer, {
    mode: brush.mode, opacity: brush.opacity, wetness: brush.wetness, viscosity: brush.viscosity, pickup: brush.pickup, load: brush.load,
    transparency: brush.transparency, wetEdge: brush.wetEdge, impasto: brush.impasto, grain: brush.grain, grainScale: brush.grainScale,
    bristles: brush.bristles, tip: tipIndex(brush.tip), settle: a.settle ?? brush.settle, spectral: app.settings.spectral, alphaLock: layer.alphaLock,
    seed: (Math.random() * 1e9) | 0,
  }, app.doc.selection.mask, `${brush.name} stroke (API)`);
  let t = performance.now();
  // densify so long segments get proper interpolation
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const pr = p[2] ?? 1;
    app.backend.addDabs(sb.push({ x: p[0], y: p[1], p: pr, tiltX: 0, tiltY: 0, t: (t += 8) }));
    if (q) {
      const n = Math.floor(Math.hypot(q[0] - p[0], q[1] - p[1]) / 4);
      for (let k = 1; k < n; k++) {
        const u = k / n;
        app.backend.addDabs(sb.push({ x: p[0] + (q[0] - p[0]) * u, y: p[1] + (q[1] - p[1]) * u, p: pr + ((q[2] ?? 1) - pr) * u, tiltX: 0, tiltY: 0, t: (t += 8) }));
      }
    }
  }
  app.backend.addDabs(sb.finish());
  app.backend.endStroke();
  if (a.wait !== false) { await new Promise((r) => setTimeout(r, Math.min(3000, brush.settle + 50))); await app.backend.flush(); }
  return { ok: true, layer: layer.name };
}

export const COMMANDS: Record<string, Command> = {
  help: { description: 'List all commands with their parameters.', params: {}, run: () => describe() },
  getState: {
    description: 'Current document, layers, tool, colours, brush, selection, view and history.',
    params: {},
    run: () => ({
      document: { name: app.doc.name, width: app.doc.width, height: app.doc.height, infinite: app.doc.infinite, background: { color: rgbToHex(app.doc.background.color), transparent: app.doc.background.transparent } },
      layers: app.doc.layers.map((l) => layerInfo(l)), activeLayer: layerInfo(),
      tool: app.tools.current.id, color: rgbToHex(app.color), secondaryColor: rgbToHex(app.color2),
      brush: { id: app.brush.id, name: app.brush.name, size: app.brush.size, opacity: app.brush.opacity, flow: app.brush.flow, wetness: app.brush.wetness },
      selection: app.doc.selection.bounds, backend: app.backend.label,
      history: { position: app.history.index, total: app.history.entries.length, recent: app.history.entries.slice(-10).map((e) => e.label) },
      view: { ...app.view.view }, symmetry: app.settings.symmetry, stabilizer: app.settings.stabilizer,
    }),
  },
  newDocument: {
    description: 'Start a new painting (clears history).',
    params: { width: 'number px', height: 'number px', preset: `optional preset id: ${DOC_PRESETS.map((p) => p.id).join(', ')}`, background: 'colour (default white)', transparent: 'boolean', infinite: 'boolean - grows when painting near edges' },
    example: { preset: 'square' },
    run(a) {
      const p = DOC_PRESETS.find((x) => x.id === a.preset);
      newDocument(a.width ?? p?.w ?? 2048, a.height ?? p?.h ?? 2048, { background: color(a.background, [1, 1, 1]), transparent: !!a.transparent, infinite: a.infinite ?? p?.infinite });
      return { width: app.doc.width, height: app.doc.height };
    },
  },
  listTools: { description: 'Available tools.', params: {}, run: () => app.tools.tools.map((t) => ({ id: t.id, name: t.name, key: t.key, description: t.desc })) },
  setTool: { description: 'Switch the active tool.', params: { tool: 'tool id (see listTools)' }, example: { tool: 'brush' }, run(a) { if (!app.tools.get(a.tool)) throw new Error('Unknown tool'); app.tools.set(a.tool); return a.tool; } },
  setColor: { description: 'Set the main (or second) colour.', params: { color: '"#rrggbb" | "rgb(...)" | [r,g,b] | name', secondary: 'boolean' }, example: { color: '#2a6fdb' }, run(a) { app.setColor(color(a.color, app.color), !!a.secondary); return rgbToHex(a.secondary ? app.color2 : app.color); } },
  listBrushes: { description: 'All brush presets and custom brushes.', params: {}, run: () => app.allBrushes.map((b) => ({ id: b.id, name: b.name, category: b.category, mode: b.mode, description: b.description })) },
  setBrush: {
    description: 'Choose a brush and/or change its settings.',
    params: { brush: 'brush id or name (optional)', ...Object.fromEntries(BRUSH_FIELDS.map((f) => [f.key, `${f.label}: ${f.tip}${f.min !== undefined ? ` (${f.min}..${f.max})` : ''}`])) },
    example: { brush: 'oil', size: 40, wetness: 0.4 },
    run(a) {
      if (a.brush) { const b = app.allBrushes.find((x) => x.id === a.brush || x.name.toLowerCase() === String(a.brush).toLowerCase()); if (!b) throw new Error(`Unknown brush ${a.brush}`); app.selectBrush(b); app.tools.set(app.brushSlot === 'brush' ? 'brush' : app.brushSlot === 'eraser' ? 'eraser' : 'smudge'); }
      for (const f of BRUSH_FIELDS) if (a[f.key] !== undefined) (app.brush as any)[f.key] = a[f.key];
      app.brushChanged();
      return { ...app.brush, tipImage: app.brush.tipImage ? '(image)' : undefined };
    },
  },
  stroke: {
    description: 'Paint a stroke with the real liquid brush engine (wet mixing, flow, pickup). Uses the current brush unless overridden.',
    params: { points: '[[x, y, pressure?], ...] in document pixels (pressure 0..1)', color: 'optional colour', brush: 'optional brush id', size: 'optional size px', settings: 'optional brush setting overrides {wetness: 0.8, ...}', layer: 'optional layer id/name/index', tool: 'optional: brush | eraser | smudge', smooth: 'apply stabilizer (default false)', symmetry: 'apply symmetry (default true)', wait: 'wait for paint to settle (default true)' },
    example: { points: [[200, 300, 0.3], [400, 260, 1], [600, 320, 0.4]], color: '#1d4ed8', brush: 'watercolor', size: 40 },
    run: stroke,
  },
  drawShape: {
    description: 'Draw a geometric shape.',
    params: { shape: 'line | arrow | rect | ellipse | polygon | star', x0: 'start x', y0: 'start y', x1: 'end x', y1: 'end y', style: 'fill | outline | both', width: 'outline width', color: 'optional colour', sides: 'polygon sides / star points', radius: 'corner radius', brushOutline: 'paint outline with current brush' },
    example: { shape: 'ellipse', x0: 100, y0: 100, x1: 400, y1: 300, style: 'fill', color: '#f59e0b' },
    async run(a) {
      const prev = { ...shapeOpts };
      Object.assign(shapeOpts, { style: a.style ?? shapeOpts.style, width: a.width ?? shapeOpts.width, sides: a.sides ?? shapeOpts.sides, radius: a.radius ?? shapeOpts.radius, brushOutline: !!a.brushOutline });
      const old = app.color;
      if (a.color) app.color = color(a.color, app.color);
      await commitShape(a.shape as ShapeKind, { x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 });
      app.color = old; Object.assign(shapeOpts, prev);
      return true;
    },
  },
  fill: {
    description: 'Paint-bucket fill at a point.',
    params: { x: 'number', y: 'number', color: 'optional colour', tolerance: '0..255 (default 32)', contiguous: 'boolean (default true)', allLayers: 'boolean (default true)' },
    example: { x: 50, y: 50, color: '#fde68a' },
    async run(a) {
      const doc = app.doc; await app.backend.flush();
      const src = a.allLayers === false ? doc.active.canvas : doc.flatten({ background: false });
      const mask = floodFillMask(ctx2d(src).getImageData(0, 0, doc.width, doc.height), a.x, a.y, a.tolerance ?? 32, a.contiguous !== false);
      const c = color(a.color, app.color);
      const tmp = makeCanvas(doc.width, doc.height); const t = ctx2d(tmp); const img = t.createImageData(doc.width, doc.height);
      for (let i = 0; i < mask.length; i++) if (mask[i]) { img.data[i * 4] = c[0] * 255; img.data[i * 4 + 1] = c[1] * 255; img.data[i * 4 + 2] = c[2] * 255; img.data[i * 4 + 3] = 255; }
      t.putImageData(img, 0, 0);
      await editPixels(doc.active, null, 'Fill (API)', 'bucket', (ctx) => ctx.drawImage(tmp, 0, 0));
      return true;
    },
  },
  gradient: {
    description: 'Fill the current layer (or selection) with a gradient from main to second colour.',
    params: { x0: 'start x', y0: 'start y', x1: 'end x', y1: 'end y', from: 'colour (default main)', to: 'colour (default second)' },
    example: { x0: 0, y0: 0, x1: 0, y1: 800, from: '#87ceeb', to: '#ffffff' },
    async run(a) {
      const o1 = app.color, o2 = app.color2;
      app.color = color(a.from, app.color); app.color2 = color(a.to, app.color2);
      await drawGradient({ x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 });
      app.color = o1; app.color2 = o2;
      return true;
    },
  },
  pickColor: { description: 'Read the visible colour at a point.', params: { x: 'number', y: 'number', allLayers: 'boolean (default true)' }, run(a) { const c = sampleColor(a.x, a.y, a.allLayers !== false, 1); return c ? rgbToHex(c) : null; } },
  addLayer: { description: 'Add a new empty layer above the active one.', params: { name: 'optional name', blend: `optional blend: ${BLEND_MODES.map((b) => b.id).join(', ')}`, opacity: '0..1' }, run(a) { const l = addLayer(app.doc.createLayer(a.name)); if (a.blend || a.opacity !== undefined) setLayerProps(l, { blend: (a.blend ?? l.blend) as BlendMode, opacity: a.opacity ?? l.opacity }); return layerInfo(l); } },
  selectLayer: { description: 'Make a layer active.', params: { layer: 'id, name or index' }, run(a) { const l = findLayer(a); app.doc.setActive(l); return layerInfo(l); } },
  setLayer: { description: 'Change layer properties.', params: { layer: 'id/name/index (default active)', name: 'string', opacity: '0..1', blend: 'blend mode', visible: 'boolean', locked: 'boolean', alphaLock: 'boolean' }, run(a) { const l = findLayer(a); const p: any = {}; for (const k of ['name', 'opacity', 'blend', 'visible', 'locked', 'alphaLock']) if (a[k] !== undefined) p[k] = a[k]; setLayerProps(l, p); return layerInfo(l); } },
  deleteLayer: { description: 'Delete a layer.', params: { layer: 'id/name/index (default active)' }, run(a) { deleteLayer(findLayer(a)); return true; } },
  duplicateLayer: { description: 'Duplicate a layer.', params: { layer: 'id/name/index (default active)' }, run(a) { return layerInfo(duplicateLayer(findLayer(a))); } },
  mergeDown: { description: 'Merge a layer into the one below.', params: { layer: 'id/name/index (default active)' }, async run(a) { await mergeDown(findLayer(a)); return true; } },
  moveLayer: { description: 'Move a layer to a new stack index (0 = bottom).', params: { layer: 'id/name/index', to: 'index' }, run(a) { moveLayer(findLayer(a), a.to); return true; } },
  select: {
    description: 'Change the selection.',
    params: { shape: 'rect | ellipse | polygon | all | none | invert', x: 'rect x', y: 'rect y', w: 'width', h: 'height', points: '[[x,y],...] for polygon', mode: 'replace | add | subtract | intersect', feather: 'px' },
    example: { shape: 'ellipse', x: 100, y: 100, w: 300, h: 200 },
    run(a) {
      const mode = a.mode ?? 'replace';
      changeSelection((s) => {
        if (a.shape === 'all') s.selectAll();
        else if (a.shape === 'none') s.clear();
        else if (a.shape === 'invert') s.invert();
        else if (a.shape === 'polygon') s.applyShape({ type: 'polygon', points: a.points.map((p: number[]) => ({ x: p[0], y: p[1] })) }, mode, a.feather ?? 0);
        else s.applyShape({ type: a.shape === 'ellipse' ? 'ellipse' : 'rect', rect: { x: a.x, y: a.y, w: a.w, h: a.h } }, mode, a.feather ?? 0);
      }, 'Select (API)');
      return app.doc.selection.bounds;
    },
  },
  clearSelectionPixels: { description: 'Erase what is inside the selection on the active layer.', params: {}, async run() { await editPixels(app.doc.active, app.doc.selection.bounds, 'Delete', 'trash', (ctx) => ctx.clearRect(0, 0, app.doc.width, app.doc.height)); return true; } },
  listFilters: { description: 'Available effects and their parameters.', params: {}, run: () => FILTERS.map((f) => ({ id: f.id, name: f.name, description: f.desc, params: f.params.map((p) => ({ key: p.key, min: p.min, max: p.max, default: p.value, tip: p.tip })) })) },
  applyFilter: { description: 'Apply an effect to the active layer (inside the selection if any).', params: { filter: 'filter id (see listFilters)', params: 'object of parameter values' }, example: { filter: 'grain', params: { amount: 0.2 } }, async run(a) { await applyFilterNow(a.filter, a.params ?? {}); return true; } },
  adjustImage: {
    description: 'Non-destructive adjustments on a photo layer (brightness, contrast, saturation, vibrance, hue, temperature, tint, exposure, gamma, grayscale, sepia, invert, posterize, highlights, shadows).',
    params: { layer: 'photo layer id/name (default active)', brightness: '-1..1', contrast: '-1..1', saturation: '-1..1', hue: '-180..180', temperature: '-1..1', exposure: '-3..3' },
    run(a) {
      const l = findLayer(a);
      if (!l.adjustments) throw new Error('Not an adjustable photo layer (import an image first)');
      for (const k of Object.keys(l.adjustments)) if (a[k] !== undefined) (l.adjustments as any)[k] = a[k];
      renderImageLayer(l);
      return l.adjustments;
    },
  },
  importImage: { description: 'Import an image (URL or data URL) as a new adjustable photo layer.', params: { src: 'URL or data URL', name: 'layer name', fit: 'fit | fill | actual' }, async run(a) { const bmp = await loadImage(a.src); return layerInfo(addImageLayer(bmp, a.name ?? 'Imported image', a.fit ?? 'fit')); } },
  extractPalette: { description: 'Dominant colours with the % of the image each covers.', params: { count: 'number of colours (default 8)', source: 'picture | layer | URL/data URL' }, async run(a) {
    await app.backend.flush();
    const src = a.source && a.source !== 'picture' && a.source !== 'layer' ? await loadImage(a.source) : a.source === 'layer' ? app.doc.active.canvas : app.doc.flatten({ background: true });
    return extractPalette(downscale(src, 400), a.count ?? 8).map((e) => ({ hex: e.hex, percent: Math.round(e.percent * 10) / 10 }));
  } },
  asciiArt: { description: 'Convert the picture to ASCII art text.', params: { columns: 'width in characters (default 80)', charset: 'classic | detailed | blocks | dots | letters' }, async run(a) {
    await app.backend.flush();
    return toAscii(app.doc.flatten({ background: true }), { columns: a.columns ?? 80, charset: a.charset ?? 'classic', custom: '', colored: false, invert: false, background: '#fff', fontSize: 10, contrast: 1.1 }).text;
  } },
  remake: { description: 'Remake a picture: autopaint | blockin | values | numbers | trace.', params: { mode: 'autopaint | blockin | values | numbers | trace', src: 'optional image URL/data URL (default: current picture)', style: 'autopaint style: impressionist | expressionist | pointillist | watercolor | sketch', detail: '0..1', colors: 'number of colours' }, async run(a) {
    await app.backend.flush();
    const src = a.src ? await loadImage(a.src) : app.doc.flatten({ background: true });
    await remakeHeadless(src, a.mode, a);
    return true;
  } },
  symmetry: { description: 'Configure symmetry painting.', params: { mode: 'off | vertical | horizontal | quad | radial', count: 'radial copies', mirror: 'boolean (radial kaleidoscope)', cx: 'centre x', cy: 'centre y' }, run(a) { Object.assign(app.settings.symmetry, a); app.saveSettings(); app.view.requestOverlay(); return app.settings.symmetry; } },
  stabilizer: { description: 'Configure the stroke stabilizer.', params: { mode: 'off | smooth | rope', strength: '0..100', predictive: 'boolean', catchUp: 'boolean' }, run(a) { Object.assign(app.settings.stabilizer, a); app.saveSettings(); return app.settings.stabilizer; } },
  guides: { description: 'Magnetic guides / perspective.', params: { enabled: 'boolean', magnet: '0..1', perspective: '0 | 1 | 2 | 3 (preset vanishing points)', grid: 'boolean', gridSize: 'px' }, run(a) {
    const g = app.settings.guides;
    if (a.perspective !== undefined) setPerspective(a.perspective);
    if (a.enabled !== undefined) g.enabled = a.enabled; if (a.magnet !== undefined) g.magnet = a.magnet;
    if (a.grid !== undefined) g.showGrid = a.grid; if (a.gridSize) g.gridSize = a.gridSize;
    app.saveSettings(); app.view.requestOverlay(); return g;
  } },
  resizeCanvas: { description: 'Change canvas size (content is not scaled).', params: { width: 'px', height: 'px', anchorX: '0..1 (0.5 = centre)', anchorY: '0..1' }, async run(a) { const d = app.doc; await resizeDocument(a.width, a.height, Math.round((a.width - d.width) * (a.anchorX ?? 0.5)), Math.round((a.height - d.height) * (a.anchorY ?? 0.5)), false, 'Canvas size (API)'); return { width: app.doc.width, height: app.doc.height }; } },
  scaleImage: { description: 'Resize the whole image (content scaled).', params: { width: 'px', height: 'px' }, async run(a) { await resizeDocument(a.width, a.height, 0, 0, true, 'Image size (API)'); return true; } },
  crop: { description: 'Crop to a rectangle.', params: { x: 'px', y: 'px', w: 'px', h: 'px' }, async run(a) { await resizeDocument(a.w, a.h, -a.x, -a.y, false, 'Crop (API)'); app.view.fit(); return true; } },
  undo: { description: 'Undo steps.', params: { steps: 'default 1' }, async run(a) { for (let i = 0; i < (a.steps ?? 1); i++) await app.history.undo(); return app.history.index; } },
  redo: { description: 'Redo steps.', params: { steps: 'default 1' }, async run(a) { for (let i = 0; i < (a.steps ?? 1); i++) await app.history.redo(); return app.history.index; } },
  history: { description: 'List history entries.', params: {}, run: () => ({ position: app.history.index, entries: app.history.entries.map((e, i) => ({ index: i + 1, label: e.label, time: e.time })) }) },
  jumpHistory: { description: 'Jump to a history position (number of applied steps).', params: { position: 'number' }, async run(a) { await app.history.jumpTo(a.position); return app.history.index; } },
  view: { description: 'Change the view.', params: { zoom: 'scale (1 = 100%)', fit: 'boolean', rotation: 'degrees' }, run(a) { if (a.fit) app.view.fit(); if (a.zoom) app.view.zoomAt(a.zoom); if (a.rotation !== undefined) app.view.setRotation((a.rotation * Math.PI) / 180); return app.view.view; } },
  exportImage: { description: 'Export the flattened picture as a data URL.', params: { format: 'png | jpeg | webp', scale: 'default 1', background: 'include background (default true)' }, async run(a) { return exportImageDataURL(`image/${a.format ?? 'png'}`, a.scale ?? 1, a.background !== false); } },
  snapshot: { description: 'Small JPEG preview of the picture for vision models.', params: { maxSize: 'longest side px (default 768)' }, async run(a) { await app.backend.flush(); const d = app.doc; const s = Math.min(1, (a.maxSize ?? 768) / Math.max(d.width, d.height)); return d.flatten({ scale: s, background: true }).toDataURL('image/jpeg', 0.85); } },
  saveProject: { description: 'Serialise the whole project (layers as PNG data URLs) to JSON.', params: {}, run: () => serialize(false) },
  loadProject: { description: 'Load a project JSON produced by saveProject.', params: { project: 'object' }, async run(a) { await deserialize(a.project); return true; } },
  importVideo: { description: 'Start rotoscoping: import a video (URL / data URL / blob URL). Shows the frame-rate dialog.', params: { src: 'video URL', name: 'file name' }, async run(a) {
    const blob = await (await fetch(a.src)).blob();
    await importVideo(new File([blob], a.name ?? 'video.webm', { type: blob.type || 'video/webm' }));
    return rotoInfo();
  } },
  animation: { description: 'Rotoscope timeline: go to a frame, or read the state.', params: { frame: 'frame index to show (optional)' }, async run(a) { if (a.frame !== undefined) await setFrame(a.frame); return rotoInfo(); } },
  pinReference: { description: 'Pin a reference image window.', params: { src: 'URL or data URL', name: 'title' }, run(a) { references.add(a.src, a.name ?? 'Reference'); return true; } },
};

export function describe() {
  return Object.entries(COMMANDS).map(([name, c]) => ({ name, description: c.description, params: c.params, example: c.example }));
}

export async function run(command: string, args: Args = {}): Promise<unknown> {
  const c = COMMANDS[command];
  if (!c) throw new Error(`Unknown command "${command}". Call flowpaint.help() for the list.`);
  const result = await c.run(args ?? {});
  app.requestRender();
  return result;
}

export function installApi(): void {
  const api = {
    version: '1.0',
    help: describe,
    commands: () => Object.keys(COMMANDS),
    run,
    async batch(list: { command: string; args?: Args }[]) { const out = []; for (const x of list) out.push(await run(x.command, x.args)); return out; },
    snapshot: (args: Args = {}) => run('snapshot', args),
    getState: () => run('getState'),
    stroke: (args: Args) => run('stroke', args),
  };
  (window as any).flowpaint = api;
  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (!m || m.type !== 'flowpaint' || !m.command) return;
    const reply = (payload: object) => (e.source as Window | null)?.postMessage({ type: 'flowpaint-result', id: m.id, ...payload }, { targetOrigin: e.origin || '*' });
    try { reply({ ok: true, result: await run(m.command, m.args) }); } catch (err) { reply({ ok: false, error: (err as Error).message }); }
  });
}
