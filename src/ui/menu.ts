// Menu bar with dropdowns. Every item has a visible label, optional shortcut and a tooltip.
import { h, svgIcon } from './dom';
import { icon } from './icons';

export interface MenuItem {
  label: string;
  icon?: string;
  key?: string;
  tip?: string;
  action?: () => void;
  checked?: () => boolean;
  disabled?: () => boolean;
  sep?: boolean;
}
export interface Menu { label: string; items: MenuItem[] }

let openMenu: HTMLElement | null = null;

export function menuBar(menus: Menu[]): HTMLElement {
  const bar = h('nav', { class: 'menus', role: 'menubar' });
  const close = () => { openMenu?.classList.remove('open'); openMenu = null; };
  document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.contains(e.target as Node)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  for (const m of menus) {
    const btn = h('button', { class: 'menu-btn', type: 'button', role: 'menuitem', 'aria-haspopup': 'true' }, m.label);
    const drop = h('div', { class: 'menu-drop', role: 'menu', 'data-tip-side': 'right' });
    const wrap = h('div', { class: 'menu' }, btn, drop);
    const build = () => {
      drop.innerHTML = '';
      for (const it of m.items) {
        if (it.sep) { drop.append(h('div', { class: 'menu-sep' })); continue; }
        const dis = it.disabled?.() ?? false;
        const chk = it.checked?.();
        const row = h('button', { class: 'menu-item' + (dis ? ' disabled' : ''), type: 'button', role: 'menuitem', disabled: dis, tip: it.tip ? { title: it.label, desc: it.tip, key: it.key } : undefined },
          h('span', { class: 'mi-icon' }, chk !== undefined ? (chk ? svgIcon(icon('check')) : '') : it.icon ? svgIcon(icon(it.icon)) : ''),
          h('span', { class: 'mi-label' }, it.label),
          h('span', { class: 'mi-key' }, it.key ?? ''));
        row.addEventListener('click', () => { close(); it.action?.(); });
        drop.append(row);
      }
    };
    btn.addEventListener('click', () => {
      if (openMenu === wrap) { close(); return; }
      close(); build(); wrap.classList.add('open'); openMenu = wrap;
    });
    btn.addEventListener('pointerenter', () => { if (openMenu && openMenu !== wrap) { close(); build(); wrap.classList.add('open'); openMenu = wrap; } });
    bar.append(wrap);
  }
  return bar;
}

/** Small popover anchored to an element. */
export function popover(anchor: HTMLElement, content: HTMLElement): () => void {
  const pop = h('div', { class: 'popover' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.right - pr.width)) + 'px';
  pop.style.top = r.bottom + 6 + 'px';
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', onDown, true); };
  const onDown = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  return close;
}
