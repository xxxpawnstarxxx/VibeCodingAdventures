// Colour panel: HSV picker, main/second colour, hex, sliders, harmonies, swatches, recent colours.
import { app } from '../../app/app';
import { h, svgIcon } from '../dom';
import { icon } from '../icons';
import { segmented } from '../controls';
import { cssRgb, fromOklch, hexToRgb, hsvToRgb, oklch, rgbToHex, rgbToHsv, type RGB } from '../../core/color';

export const PALETTE_PRESETS: { name: string; tip: string; colors: string[] }[] = [
  { name: 'Alpine meadow (gouache)', tip: 'Colours from the sample gouache painting: peach sky, blue-violet peaks, pine greens, turquoise river.', colors: ['#f1e4cf', '#f4c9a8', '#8a8fb8', '#5f7fa6', '#3f5f78', '#2e4a44', '#1f3532', '#9fbf8f', '#6f9a72', '#5fc7c0', '#f6c9a4', '#f2d46b', '#ffffff', '#6b4a3a'] },
  { name: 'Mountain lake (watercolour)', tip: 'Colours from the sample watercolour: orange sunset, lavender mountains, teal water, autumn grass.', colors: ['#efe6d5', '#f7a64a', '#f2c27a', '#d88a7a', '#b89bd6', '#7d65b0', '#5a4a8a', '#6fb8bb', '#3f6f7a', '#3c4a2e', '#c9892f', '#8a6a4a'] },
  { name: 'Classic painter (limited)', tip: 'A traditional limited palette: titanium white, cadmium yellow, yellow ochre, cadmium red, alizarin, ultramarine, phthalo, burnt umber, ivory black.', colors: ['#f7f5ef', '#ffd21f', '#c99a2e', '#e2341d', '#8e1b2c', '#223a8f', '#0f4f5a', '#5b3a24', '#1c1b1a'] },
  { name: 'Earth tones', tip: 'Warm natural browns, ochres, siennas and greens.', colors: ['#f0e3c8', '#d9b77c', '#c28a3e', '#a0522d', '#7b3f1d', '#5b4636', '#6b7a3a', '#3f4a2a', '#2b2320'] },
  { name: 'Pastel dream', tip: 'Soft, light, gentle colours.', colors: ['#fde2e4', '#fad2e1', '#e2ece9', '#bee1e6', '#cddafd', '#dfe7fd', '#fff1c1', '#e9d5ff', '#c7f9cc'] },
  { name: 'Sunset', tip: 'Warm glowing sky colours.', colors: ['#1c1f4a', '#4b2c6f', '#7b3f8c', '#c2477a', '#f06a5c', '#ff9b5a', '#ffc36b', '#fff0c2'] },
  { name: 'Ocean', tip: 'Blues, teals and foam.', colors: ['#03045e', '#023e8a', '#0077b6', '#0096c7', '#00b4d8', '#48cae4', '#90e0ef', '#caf0f8', '#f1faee'] },
  { name: 'Forest', tip: 'Deep greens, moss and bark.', colors: ['#081c15', '#1b4332', '#2d6a4f', '#40916c', '#52b788', '#95d5b2', '#d8f3dc', '#6b4f2a', '#3e2c1c'] },
  { name: 'Skin tones', tip: 'A range of natural skin tones from light to deep.', colors: ['#fde7d6', '#f6d0b1', '#eab48f', '#d8a07a', '#c68863', '#a86b4a', '#8a5236', '#6b3d26', '#4a2a1a', '#2e1a10'] },
  { name: 'Greyscale values', tip: '9 steps from white to black - for value studies.', colors: ['#ffffff', '#e0e0e0', '#c0c0c0', '#a0a0a0', '#808080', '#606060', '#404040', '#202020', '#000000'] },
  { name: 'Neon pop', tip: 'Bright saturated colours for bold, fun art.', colors: ['#ff006e', '#fb5607', '#ffbe0b', '#8ac926', '#00f5d4', '#3a86ff', '#8338ec', '#111111'] },
];

function paletteSelect(): HTMLElement {
  const s = h('select', { class: 'select small-select', 'aria-label': 'Load a preset palette', tip: { title: 'Preset palettes', desc: 'Replace your swatches with a ready-made palette - including colours taken from the two sample paintings.' } });
  s.append(h('option', { value: '' }, 'Load palette…'));
  PALETTE_PRESETS.forEach((p, i) => s.append(h('option', { value: String(i), title: p.tip }, p.name)));
  s.addEventListener('change', () => {
    const p = PALETTE_PRESETS[Number(s.value)];
    if (p) { app.settings.swatches = [...p.colors]; app.saveSettings(); app.toast(`Loaded palette "${p.name}".`, 'success'); }
    s.value = '';
  });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

export function colorPanel(): HTMLElement {
  let [hue, sat, val] = rgbToHsv(app.color);
  let mode: 'hsv' | 'rgb' | 'oklch' = 'hsv';

  const sv = h('canvas', { class: 'sv-square', width: 220, height: 150, tip: { title: 'Shade picker', desc: 'Left-right = how colourful. Up-down = how bright. Drag to choose.' } });
  const hueBar = h('canvas', { class: 'hue-bar', width: 220, height: 14, tip: { title: 'Hue', desc: 'Choose the base colour of the rainbow.' } });
  const fg = h('button', { class: 'swatch-big fg', type: 'button', tip: { title: 'Main colour', desc: 'The colour you paint with. Click to edit with the system colour picker.' } });
  const bg = h('button', { class: 'swatch-big bg', type: 'button', tip: { title: 'Second colour', desc: 'Used by gradients, rainbow gradient brushes and "Fill + outline" shapes. Click to make it the main colour.', key: 'X' } });
  const swap = h('button', { class: 'icon-btn', type: 'button', tip: { title: 'Swap colours', desc: 'Swap main and second colour.', key: 'X' } }, svgIcon(icon('swap')));
  const hex = h('input', { class: 'hex', type: 'text', maxLength: 7, spellcheck: false, 'aria-label': 'Hex colour code' });
  const native = h('input', { type: 'color', style: 'position:absolute;opacity:0;pointer-events:none;width:0;height:0' });
  const sliders = h('div', { class: 'color-sliders' });
  const harmony = h('div', { class: 'harmony' });
  const swatches = h('div', { class: 'swatches' });
  const recent = h('div', { class: 'swatches recent' });

  const svCtx = sv.getContext('2d')!, hueCtx = hueBar.getContext('2d')!;

  function drawHue() {
    const g = hueCtx.createLinearGradient(0, 0, hueBar.width, 0);
    for (let i = 0; i <= 12; i++) g.addColorStop(i / 12, cssRgb(hsvToRgb(i * 30, 1, 1)));
    hueCtx.fillStyle = g; hueCtx.fillRect(0, 0, hueBar.width, hueBar.height);
    const x = (hue / 360) * hueBar.width;
    hueCtx.strokeStyle = '#fff'; hueCtx.lineWidth = 2; hueCtx.strokeRect(x - 3, 1, 6, hueBar.height - 2);
  }
  function drawSV() {
    const W = sv.width, H = sv.height;
    const g1 = svCtx.createLinearGradient(0, 0, W, 0);
    g1.addColorStop(0, '#fff'); g1.addColorStop(1, cssRgb(hsvToRgb(hue, 1, 1)));
    svCtx.fillStyle = g1; svCtx.fillRect(0, 0, W, H);
    const g2 = svCtx.createLinearGradient(0, 0, 0, H);
    g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000');
    svCtx.fillStyle = g2; svCtx.fillRect(0, 0, W, H);
    const x = sat * W, y = (1 - val) * H;
    svCtx.lineWidth = 2; svCtx.strokeStyle = val > 0.5 ? '#000' : '#fff';
    svCtx.beginPath(); svCtx.arc(x, y, 6, 0, Math.PI * 2); svCtx.stroke();
  }

  const commit = () => app.setColor(hsvToRgb(hue, sat, val));
  const drag = (el: HTMLCanvasElement, fn: (u: number, v: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const go = (ev: PointerEvent) => { const r = el.getBoundingClientRect(); fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))); };
      go(e);
      const mv = (ev: PointerEvent) => go(ev);
      const upf = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', upf); app.pushRecent(); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', upf);
    });
  };
  drag(sv, (u, v) => { sat = u; val = 1 - v; commit(); });
  drag(hueBar, (u) => { hue = u * 359.9; commit(); });

  fg.addEventListener('click', () => { native.value = app.colorHex; native.click(); });
  native.addEventListener('input', () => app.setColorHex(native.value));
  bg.addEventListener('click', () => app.swapColors());
  swap.addEventListener('click', () => app.swapColors());
  hex.addEventListener('change', () => { const c = hexToRgb(hex.value); if (c) { app.setColor(c); app.pushRecent(); } else hex.value = app.colorHex; });
  hex.addEventListener('keydown', (e) => e.stopPropagation());

  function channelSlider(label: string, tip: string, get: () => number, set: (v: number) => void, max: number, bgCss: () => string) {
    const input = h('input', { type: 'range', min: 0, max: 1000, class: 'chan', 'aria-label': label });
    const num = h('span', { class: 'chan-val' });
    input.value = String((get() / max) * 1000);
    input.style.background = bgCss();
    num.textContent = String(Math.round(get() * (max > 1 ? 1 : 100)) + (max > 1 ? '' : '%'));
    input.addEventListener('input', () => set((Number(input.value) / 1000) * max));
    input.addEventListener('change', () => app.pushRecent());
    return h('label', { class: 'chan-row', tip: { title: label, desc: tip } }, h('span', { class: 'chan-name' }, label), input, num);
  }

  function renderSliders() {
    sliders.innerHTML = '';
    const c = app.color;
    const grad = (fn: (t: number) => RGB) => `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => cssRgb(fn(t))).join(',')})`;
    if (mode === 'hsv') {
      sliders.append(
        channelSlider('Hue', 'Position on the colour wheel (0-360°).', () => hue, (v) => { hue = v; commit(); }, 360, () => grad((t) => hsvToRgb(t * 360, 1, 1))),
        channelSlider('Colourfulness', 'Saturation: grey (0%) to fully vivid (100%).', () => sat, (v) => { sat = v; commit(); }, 1, () => grad((t) => hsvToRgb(hue, t, val))),
        channelSlider('Brightness', 'Value: black (0%) to full brightness (100%).', () => val, (v) => { val = v; commit(); }, 1, () => grad((t) => hsvToRgb(hue, sat, t))),
      );
    } else if (mode === 'rgb') {
      (['Red', 'Green', 'Blue'] as const).forEach((n, i) => sliders.append(channelSlider(n, `Amount of ${n.toLowerCase()} light (0-255).`, () => c[i] * 255, (v) => { const cc = [...app.color] as RGB; cc[i] = v / 255; app.setColor(cc); }, 255, () => grad((t) => { const cc = [...c] as RGB; cc[i] = t; return cc; }))));
    } else {
      const [L, C, H] = oklch(c);
      sliders.append(
        channelSlider('Lightness', 'Perceived lightness - changes brightness without shifting hue.', () => L, (v) => app.setColor(fromOklch(v, C, H)), 1, () => grad((t) => fromOklch(t, C, H))),
        channelSlider('Chroma', 'Perceived colourfulness.', () => C / 0.37, (v) => app.setColor(fromOklch(L, v * 0.37, H)), 1, () => grad((t) => fromOklch(L, t * 0.37, H))),
        channelSlider('Hue', 'Perceptual hue angle.', () => H, (v) => app.setColor(fromOklch(L, C, v)), 360, () => grad((t) => fromOklch(L, C, t * 360))),
      );
    }
  }

  function swatchBtn(hexc: string, removable: boolean): HTMLElement {
    const b = h('button', { class: 'swatch', type: 'button', style: `background:${hexc}`, tip: { title: hexc, desc: removable ? 'Click: use this colour · Alt+click: set as second colour · Right-click: remove from swatches' : 'Click to use this colour.' } });
    b.addEventListener('click', (e) => { const c = hexToRgb(hexc)!; app.setColor(c, e.altKey); });
    if (removable) b.addEventListener('contextmenu', (e) => { e.preventDefault(); app.settings.swatches = app.settings.swatches.filter((x) => x !== hexc); app.saveSettings(); renderSwatches(); });
    return b;
  }

  function renderSwatches() {
    swatches.innerHTML = '';
    for (const s of app.settings.swatches) swatches.append(swatchBtn(s, true));
    const add = h('button', { class: 'swatch add', type: 'button', tip: { title: 'Add to swatches', desc: 'Save the main colour in your swatch collection.' } }, svgIcon(icon('plus')));
    add.addEventListener('click', () => { if (!app.settings.swatches.includes(app.colorHex)) { app.settings.swatches.push(app.colorHex); app.saveSettings(); renderSwatches(); } });
    swatches.append(add);
    recent.innerHTML = '';
    for (const s of app.settings.recent) recent.append(swatchBtn(s, false));
  }

  function renderHarmony() {
    harmony.innerHTML = '';
    const base = hue;
    const set: [string, number[]][] = [['Complement', [180]], ['Analogous', [-30, 30]], ['Triad', [120, 240]]];
    for (const [name, offs] of set) {
      const row = h('div', { class: 'harmony-row', tip: { title: name + ' colours', desc: name === 'Complement' ? 'The opposite colour on the wheel - maximum contrast.' : name === 'Analogous' ? 'Neighbouring colours - calm, harmonious schemes.' : 'Three evenly spaced colours - lively, balanced schemes.' } }, h('span', null, name));
      for (const o of offs) {
        const c = hsvToRgb(base + o, sat, val);
        const b = h('button', { class: 'swatch small', type: 'button', style: `background:${cssRgb(c)}` });
        b.addEventListener('click', () => app.setColor(c));
        row.append(b);
      }
      harmony.append(row);
    }
  }

  function sync() {
    const [hh, ss, vv] = rgbToHsv(app.color);
    // keep hue when colour is grey so the picker doesn't jump
    if (ss > 0.001 && vv > 0.001) hue = hh;
    sat = ss; val = vv;
    fg.style.background = cssRgb(app.color);
    bg.style.background = cssRgb(app.color2);
    if (document.activeElement !== hex) hex.value = app.colorHex;
    drawHue(); drawSV();
    if (!sliders.contains(document.activeElement)) renderSliders();
    renderHarmony();
  }

  app.events.on('color', sync);
  app.events.on('settings', renderSwatches);

  const el = h('div', { class: 'panel-body color-panel' },
    h('div', { class: 'color-top' },
      h('div', { class: 'fgbg' }, bg, fg, swap),
      h('div', { class: 'hex-wrap', tip: { title: 'Hex code', desc: 'Type or paste a colour code like #3a7bd5.' } }, h('span', null, 'Hex'), hex),
      native,
    ),
    sv, hueBar,
    segmented(mode, [{ value: 'hsv', label: 'Simple', tip: 'Hue, colourfulness and brightness.' }, { value: 'rgb', label: 'RGB', tip: 'Red, green and blue light channels.' }, { value: 'oklch', label: 'Perceptual', tip: 'OKLCH: change lightness without the hue shifting.' }], (v) => { mode = v; renderSliders(); }, 'mini'),
    sliders,
    h('div', { class: 'sub-title' }, 'Matching colours'), harmony,
    h('div', { class: 'row sub-row' }, h('div', { class: 'sub-title' }, 'Swatches'), paletteSelect()), swatches,
    h('div', { class: 'sub-title' }, 'Recently used'), recent,
  );
  renderSwatches();
  sync();
  return el;
}
