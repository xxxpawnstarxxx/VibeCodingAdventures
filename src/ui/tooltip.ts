// Global rich tooltips: any element with data-tip-title gets one (title, explanation, shortcut).
let tipEl: HTMLDivElement;
let timer = 0;
let current: HTMLElement | null = null;
let enabled = true;

export function setTooltipsEnabled(on: boolean) { enabled = on; if (!on) hide(); }

export function initTooltips(): void {
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.append(tipEl);

  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'pen' && (e.target as HTMLElement)?.closest?.('.viewport')) return;
    const t = (e.target as HTMLElement)?.closest?.('[data-tip-title]') as HTMLElement | null;
    if (t === current) return;
    current = t;
    clearTimeout(timer);
    if (!t || !enabled) { hide(); return; }
    // Faster when moving between tips that are already visible.
    const delay = tipEl.classList.contains('show') ? 60 : 450;
    timer = window.setTimeout(() => show(t), delay);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(timer); hide(); }, true);
  document.addEventListener('keydown', () => hide(), true);
  document.addEventListener('focusin', (e) => {
    const t = (e.target as HTMLElement)?.closest?.('[data-tip-title]') as HTMLElement | null;
    if (t && (e.target as HTMLElement).matches(':focus-visible')) { current = t; show(t); }
  });
  document.addEventListener('focusout', () => hide());
}

function show(t: HTMLElement): void {
  if (!document.body.contains(t)) return;
  const title = t.dataset.tipTitle ?? '';
  const desc = t.dataset.tip ?? '';
  const key = t.dataset.tipKey ?? '';
  tipEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'tooltip-head';
  const tt = document.createElement('strong');
  tt.textContent = title;
  head.append(tt);
  if (key) {
    const k = document.createElement('span');
    k.className = 'kbd';
    k.textContent = key;
    head.append(k);
  }
  tipEl.append(head);
  if (desc) {
    const d = document.createElement('div');
    d.className = 'tooltip-desc';
    d.textContent = desc;
    tipEl.append(d);
  }
  tipEl.classList.add('show');
  const r = t.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  // prefer right side for vertical toolbars, below otherwise
  let x: number, y: number;
  const side = t.closest('[data-tip-side]')?.getAttribute('data-tip-side');
  if (side === 'right') { x = r.right + 10; y = r.top + r.height / 2 - tr.height / 2; }
  else if (side === 'left') { x = r.left - tr.width - 10; y = r.top + r.height / 2 - tr.height / 2; }
  else if (side === 'top') { x = r.left + r.width / 2 - tr.width / 2; y = r.top - tr.height - 8; }
  else { x = r.left + r.width / 2 - tr.width / 2; y = r.bottom + 8; if (y + tr.height > vh - 8) y = r.top - tr.height - 8; }
  x = Math.max(8, Math.min(vw - tr.width - 8, x));
  y = Math.max(8, Math.min(vh - tr.height - 8, y));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function hide(): void { tipEl?.classList.remove('show'); }
