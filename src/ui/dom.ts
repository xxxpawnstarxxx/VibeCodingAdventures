// Tiny DOM helper. h('div', { class: 'x', tip: {...}, onclick }, children...)
export interface Tip { title: string; desc?: string; key?: string }

type Child = Node | string | number | null | undefined | false | Child[];
type Props = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  tip?: Tip | string;
  html?: string;
  dataset?: Record<string, string>;
  [k: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k === 'tip') setTip(el, v as Tip | string);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && k !== 'list' && k !== 'form') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function setTip(el: HTMLElement, tip: Tip | string): void {
  const t = typeof tip === 'string' ? { title: tip } : tip;
  el.dataset.tipTitle = t.title;
  if (t.desc) el.dataset.tip = t.desc; else delete el.dataset.tip;
  if (t.key) el.dataset.tipKey = t.key; else delete el.dataset.tipKey;
  el.setAttribute('aria-label', t.title + (t.desc ? '. ' + t.desc : ''));
}

export function clear(el: Element): void { while (el.firstChild) el.firstChild.remove(); }

export function svgIcon(markup: string, cls = 'icon'): HTMLElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = markup;
  return s;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
