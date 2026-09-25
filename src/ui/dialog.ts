import { h, svgIcon } from './dom';
import { icon } from './icons';
import { button } from './controls';

export interface DialogHandle { el: HTMLElement; body: HTMLElement; footer: HTMLElement; close(): void; onClose?: () => void }

/** Modal dialog in app style. */
export function openDialog(title: string, opts: { width?: number; icon?: string; subtitle?: string; modal?: boolean; className?: string } = {}): DialogHandle {
  const body = h('div', { class: 'dialog-body' });
  const footer = h('div', { class: 'dialog-footer' });
  const closeBtn = h('button', { class: 'dialog-close', type: 'button', tip: { title: 'Close', key: 'Esc' } }, svgIcon(icon('close')));
  const box = h('div', { class: 'dialog ' + (opts.className ?? ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: opts.width ? `width:min(${opts.width}px, calc(100vw - 32px))` : '' },
    h('div', { class: 'dialog-head' },
      opts.icon ? svgIcon(icon(opts.icon)) : null,
      h('div', { class: 'dialog-titles' }, h('div', { class: 'dialog-title' }, title), opts.subtitle ? h('div', { class: 'dialog-sub' }, opts.subtitle) : null),
      closeBtn),
    body, footer);
  const back = h('div', { class: 'dialog-backdrop' + (opts.modal === false ? ' modeless' : '') }, box);
  const handle: DialogHandle = {
    el: box, body, footer,
    close() {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      handle.onClose?.();
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && document.body.lastElementChild === back) { e.stopPropagation(); handle.close(); }
  };
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', () => handle.close());
  back.addEventListener('pointerdown', (e) => { if (e.target === back && opts.modal !== false) handle.close(); });
  document.body.append(back);
  return handle;
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', cancelLabel = 'Cancel', extra?: { label: string; value: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const d = openDialog(title, { width: 440 });
    d.body.append(h('p', { class: 'dialog-text' }, message));
    let result: string | null = null;
    d.onClose = () => resolve(result);
    d.footer.append(button(cancelLabel, { onClick: () => d.close() }));
    if (extra) d.footer.append(button(extra.label, { onClick: () => { result = extra.value; d.close(); } }));
    d.footer.append(button(okLabel, { primary: true, onClick: () => { result = 'ok'; d.close(); } }));
  });
}

let toastWrap: HTMLElement | null = null;
export function toast(msg: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3200): void {
  if (!toastWrap) { toastWrap = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastWrap); }
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastWrap.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

/** Pick file(s) from disk. */
export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => { resolve([...(input.files ?? [])]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function download(blobOrUrl: Blob | string, name: string): void {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 5000);
}
