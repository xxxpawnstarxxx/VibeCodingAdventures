// Labelled, tooltip-equipped controls. Every control shows its name as text (not just an icon).
import { h, svgIcon, type Tip } from './dom';
import { icon } from './icons';

export function button(label: string, opts: { icon?: string; tip?: Tip | string; onClick?: (e: MouseEvent) => void; primary?: boolean; small?: boolean; iconOnly?: boolean; danger?: boolean; class?: string } = {}): HTMLButtonElement {
  const b = h('button', {
    class: ['btn', opts.primary && 'primary', opts.small && 'small', opts.iconOnly && 'icon-only', opts.danger && 'danger', opts.class].filter(Boolean).join(' '),
    type: 'button',
    tip: opts.tip ?? (opts.iconOnly ? label : undefined),
  });
  if (opts.icon) b.append(svgIcon(icon(opts.icon)));
  if (!opts.iconOnly) b.append(h('span', { class: 'btn-label' }, label));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export interface SliderOpts {
  label: string;
  tip?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  percent?: boolean;
  /** Non-linear feel for wide ranges like brush size. */
  curve?: number;
  onInput: (v: number) => void;
  onChange?: (v: number) => void;
  compact?: boolean;
}

/** A slider with its name, a numeric readout you can type into, and a tooltip. */
export function slider(o: SliderOpts): HTMLElement & { set(v: number): void } {
  const curve = o.curve ?? 1;
  const toT = (v: number) => Math.pow((v - o.min) / (o.max - o.min), 1 / curve);
  const fromT = (t: number) => o.min + Math.pow(t, curve) * (o.max - o.min);
  const fmt = (v: number) => (o.percent ? Math.round(v * 100) + '%' : (Number.isInteger(o.step ?? 1) ? Math.round(v) : v.toFixed(2)) + (o.unit ?? ''));
  const range = h('input', { type: 'range', min: '0', max: '1000', step: '1', class: 'slider-range', 'aria-label': o.label });
  const num = h('input', { type: 'text', class: 'slider-num', inputMode: 'decimal', 'aria-label': o.label + ' value' });
  const wrap = h('div', { class: 'slider' + (o.compact ? ' compact' : ''), tip: o.tip ? { title: o.label, desc: o.tip } : undefined },
    h('div', { class: 'slider-top' }, h('label', { class: 'slider-label' }, o.label), num),
    range,
  ) as unknown as HTMLElement & { set(v: number): void };
  let value = o.value;
  const snap = (v: number) => { const s = o.step ?? 0; return s ? Math.round(v / s) * s : v; };
  const sync = () => {
    range.value = String(Math.round(toT(value) * 1000));
    if (document.activeElement !== num) num.value = fmt(value);
    range.style.setProperty('--fill', `${toT(value) * 100}%`);
  };
  range.addEventListener('input', () => { value = snap(fromT(Number(range.value) / 1000)); sync(); o.onInput(value); });
  range.addEventListener('change', () => o.onChange?.(value));
  num.addEventListener('change', () => {
    let v = parseFloat(num.value.replace(',', '.'));
    if (Number.isNaN(v)) { sync(); return; }
    if (o.percent) v /= 100;
    value = Math.min(o.max, Math.max(o.min, snap(v)));
    num.blur();
    sync();
    o.onInput(value);
    o.onChange?.(value);
  });
  num.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') num.dispatchEvent(new Event('change')); });
  // wheel to fine-tune
  wrap.addEventListener('wheel', (e) => {
    if (!(e.target as HTMLElement).closest('.slider')) return;
    e.preventDefault();
    const t = Math.min(1, Math.max(0, toT(value) - Math.sign(e.deltaY) * 0.01));
    value = snap(fromT(t)); sync(); o.onInput(value); o.onChange?.(value);
  }, { passive: false });
  wrap.set = (v: number) => { value = v; sync(); };
  sync();
  return wrap;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, tip?: string): HTMLElement & { set(v: boolean): void } {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label', { class: 'toggle', tip: tip ? { title: label, desc: tip } : undefined }, input, h('span', { class: 'toggle-track' }), h('span', { class: 'toggle-label' }, label)) as unknown as HTMLElement & { set(v: boolean): void };
  el.set = (v: boolean) => { input.checked = v; };
  return el;
}

export function select<T extends string>(label: string, value: T, options: { value: T; label: string; tip?: string }[], onChange: (v: T) => void, tip?: string): HTMLElement & { set(v: T): void } {
  const s = h('select', { class: 'select', 'aria-label': label });
  for (const o of options) s.append(h('option', { value: o.value, title: o.tip ?? '' }, o.label));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  s.addEventListener('keydown', (e) => e.stopPropagation());
  const el = h('label', { class: 'field', tip: tip ? { title: label, desc: tip } : undefined }, h('span', { class: 'field-label' }, label), s) as unknown as HTMLElement & { set(v: T): void };
  el.set = (v: T) => { s.value = v; };
  return el;
}

/** Segmented choice with icon + text for each option. */
export function segmented<T extends string>(value: T, options: { value: T; label: string; icon?: string; tip?: string; key?: string }[], onChange: (v: T) => void, cls = ''): HTMLElement & { set(v: T): void } {
  const el = h('div', { class: 'segmented ' + cls, role: 'radiogroup' }) as unknown as HTMLElement & { set(v: T): void };
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', class: 'seg', role: 'radio', tip: { title: o.label, desc: o.tip, key: o.key } });
    if (o.icon) b.append(svgIcon(icon(o.icon)));
    b.append(h('span', null, o.label));
    b.addEventListener('click', () => { el.set(o.value); onChange(o.value); });
    el.append(b);
    return b;
  });
  el.set = (v: T) => btns.forEach((b, i) => { b.classList.toggle('active', options[i].value === v); b.setAttribute('aria-checked', String(options[i].value === v)); });
  el.set(value);
  return el;
}

export function numberField(label: string, value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number; tip?: string; unit?: string } = {}): HTMLElement & { input: HTMLInputElement } {
  const input = h('input', { type: 'number', class: 'num', value: String(value), min: opts.min, max: opts.max, step: opts.step ?? 1 });
  input.addEventListener('change', () => onChange(Number(input.value)));
  input.addEventListener('keydown', (e) => e.stopPropagation());
  const el = h('label', { class: 'field', tip: opts.tip ? { title: label, desc: opts.tip } : undefined }, h('span', { class: 'field-label' }, label), input, opts.unit ? h('span', { class: 'unit' }, opts.unit) : null) as unknown as HTMLElement & { input: HTMLInputElement };
  el.input = input;
  return el;
}

export function textField(label: string, value: string, onChange: (v: string) => void, tip?: string): HTMLElement & { input: HTMLInputElement } {
  const input = h('input', { type: 'text', class: 'text', value });
  input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('keydown', (e) => e.stopPropagation());
  const el = h('label', { class: 'field', tip: tip ? { title: label, desc: tip } : undefined }, h('span', { class: 'field-label' }, label), input) as unknown as HTMLElement & { input: HTMLInputElement };
  el.input = input;
  return el;
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('div', { class: 'section' }, h('div', { class: 'section-title' }, title), ...children);
}
