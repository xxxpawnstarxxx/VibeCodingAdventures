// Layers panel.
import { app } from '../../app/app';
import { h, svgIcon } from '../dom';
import { icon } from '../icons';
import { button, select, slider } from '../controls';
import { BLEND_MODES, type BlendMode, type Layer } from '../../core/layer';
import { addLayer, deleteLayer, duplicateLayer, mergeDown, moveLayer, setLayerProps } from '../../app/ops';
import { openAdjustDialog } from '../../features/adjust';

export function layersPanel(): HTMLElement {
  const list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'Layers' });
  const thumbs = new Map<number, HTMLCanvasElement>();
  const blend = select<BlendMode>('Blend', 'normal', BLEND_MODES.map((b) => ({ value: b.id, label: b.name, tip: b.tip })), (v) => setLayerProps(app.doc.active, { blend: v }),
    'How this layer mixes with the layers below it. Multiply = darken like ink, Screen = lighten like light, Color = tint.');
  const opacity = slider({ label: 'Layer opacity', min: 0, max: 1, step: 0.01, percent: true, value: 1, compact: true, tip: 'Make the whole layer more see-through.', onInput: (v) => setLayerProps(app.doc.active, { opacity: v }) });
  const adjustBtn = button('Adjust image…', { icon: 'adjust', small: true, tip: { title: 'Adjust image', desc: 'Brightness, contrast, saturation, colour temperature and more for this layer. Photo layers stay adjustable.' }, onClick: () => openAdjustDialog(app.doc.active) });

  function drawThumb(l: Layer) {
    const c = thumbs.get(l.id);
    if (!c) return;
    const x = c.getContext('2d')!;
    const doc = app.doc;
    const s = Math.min(c.width / doc.width, c.height / doc.height);
    x.clearRect(0, 0, c.width, c.height);
    const w = doc.width * s, hh = doc.height * s;
    x.drawImage(l.canvas, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
  }

  let pendingThumbs = new Set<Layer>();
  let thumbTimer = 0;

  function row(l: Layer): HTMLElement {
    const active = app.doc.active === l;
    const t = h('canvas', { class: 'layer-thumb checker', width: 48, height: 36 });
    thumbs.set(l.id, t);
    const eye = h('button', { class: 'icon-btn', type: 'button', tip: { title: l.visible ? 'Hide layer' : 'Show layer', desc: 'Toggle whether this layer is visible.' } }, svgIcon(icon(l.visible ? 'eye' : 'eyeOff')));
    eye.addEventListener('click', (e) => { e.stopPropagation(); setLayerProps(l, { visible: !l.visible }); });
    const lock = h('button', { class: 'icon-btn' + (l.locked ? ' on' : ''), type: 'button', tip: { title: l.locked ? 'Unlock layer' : 'Lock layer', desc: 'A locked layer cannot be painted on or changed - protects finished work.' } }, svgIcon(icon(l.locked ? 'lock' : 'unlock')));
    lock.addEventListener('click', (e) => { e.stopPropagation(); setLayerProps(l, { locked: !l.locked }); });
    const alock = h('button', { class: 'icon-btn' + (l.alphaLock ? ' on' : ''), type: 'button', tip: { title: 'Lock transparency', desc: 'When on, you can only paint over what is already painted on this layer - perfect for shading inside shapes without going outside the lines.' } }, svgIcon(icon('alphaLock')));
    alock.addEventListener('click', (e) => { e.stopPropagation(); setLayerProps(l, { alphaLock: !l.alphaLock }); });
    const name = h('span', { class: 'layer-name', tip: { title: l.name, desc: 'Double-click to rename.' } }, l.name);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = h('input', { class: 'rename', value: l.name });
      name.replaceWith(input);
      input.focus(); input.select();
      const done = () => { if (input.value.trim() && input.value !== l.name) setLayerProps(l, { name: input.value.trim() }); else render(); };
      input.addEventListener('blur', done);
      input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = l.name; input.blur(); } });
    });
    const badges: Record<string, string> = { image: 'Photo', video: 'Video', animation: 'Frames' };
    const r = h('div', { class: 'layer-row' + (active ? ' active' : '') + (l.visible ? '' : ' hidden'), role: 'option', 'aria-selected': String(active), draggable: true },
      eye, t,
      h('div', { class: 'layer-info' }, name, h('span', { class: 'layer-meta' }, [badges[l.kind] ? h('span', { class: 'badge' }, badges[l.kind]) : null, `${Math.round(l.opacity * 100)}%`, l.blend !== 'normal' ? ' · ' + BLEND_MODES.find((b) => b.id === l.blend)!.name : ''])),
      alock, lock);
    r.addEventListener('click', () => { if (app.doc.active !== l) app.doc.setActive(l); });
    r.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/layer', String(l.id)); r.classList.add('dragging'); });
    r.addEventListener('dragend', () => r.classList.remove('dragging'));
    r.addEventListener('dragover', (e) => { e.preventDefault(); r.classList.add('drop'); });
    r.addEventListener('dragleave', () => r.classList.remove('drop'));
    r.addEventListener('drop', (e) => {
      e.preventDefault(); r.classList.remove('drop');
      const id = Number(e.dataTransfer!.getData('text/layer'));
      const src = app.doc.getLayer(id);
      if (src && src !== l) moveLayer(src, app.doc.indexOf(l));
    });
    queueMicrotask(() => drawThumb(l));
    return r;
  }

  function render() {
    list.innerHTML = '';
    thumbs.clear();
    const doc = app.doc;
    for (let i = doc.layers.length - 1; i >= 0; i--) list.append(row(doc.layers[i]));
    const a = doc.active;
    blend.set(a.blend);
    opacity.set(a.opacity);
    adjustBtn.style.display = a.kind === 'image' || a.kind === 'paint' ? '' : 'none';
    (adjustBtn.querySelector('.btn-label') as HTMLElement).textContent = a.kind === 'image' ? 'Adjust photo…' : 'Adjust colours…';
  }

  const hook = () => {
    app.doc.events.on('structure', render);
    app.doc.events.on('pixels', ({ layer }) => {
      pendingThumbs.add(layer);
      if (!thumbTimer) thumbTimer = window.setTimeout(() => { thumbTimer = 0; pendingThumbs.forEach(drawThumb); pendingThumbs = new Set(); }, 250);
    });
    app.doc.events.on('resize', render);
    render();
  };
  app.events.on('document', hook);

  const el = h('div', { class: 'panel-body layers-panel' },
    h('div', { class: 'layer-props' }, blend, opacity),
    list,
    h('div', { class: 'layer-actions' },
      button('New', { icon: 'plus', small: true, tip: { title: 'New layer', desc: 'Add an empty transparent layer above the current one. Layers let you paint parts separately without messing up the rest.', key: 'Ctrl+Shift+N' }, onClick: () => addLayer() }),
      button('Copy', { icon: 'copy', small: true, tip: { title: 'Duplicate layer', desc: 'Make a copy of the current layer.', key: 'Ctrl+J' }, onClick: () => duplicateLayer(app.doc.active) }),
      button('Merge', { icon: 'merge', small: true, tip: { title: 'Merge down', desc: 'Combine this layer into the layer below it.', key: 'Ctrl+E' }, onClick: () => void mergeDown(app.doc.active) }),
      button('Up', { icon: 'up', small: true, iconOnly: true, tip: { title: 'Move layer up', desc: 'Move the layer above the next one.', key: 'Ctrl+]' }, onClick: () => moveLayer(app.doc.active, app.doc.indexOf(app.doc.active) + 1) }),
      button('Down', { icon: 'down', small: true, iconOnly: true, tip: { title: 'Move layer down', desc: 'Move the layer below the previous one.', key: 'Ctrl+[' }, onClick: () => moveLayer(app.doc.active, app.doc.indexOf(app.doc.active) - 1) }),
      button('Delete', { icon: 'trash', small: true, iconOnly: true, danger: true, tip: { title: 'Delete layer', desc: 'Remove the current layer. (You can undo this.)' }, onClick: () => deleteLayer(app.doc.active) }),
    ),
    adjustBtn,
  );
  return el;
}
