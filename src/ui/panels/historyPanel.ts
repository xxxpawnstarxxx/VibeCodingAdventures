// History / timeline panel: every step ever taken, click to jump anywhere.
import { app } from '../../app/app';
import { h, svgIcon } from '../dom';
import { icon } from '../icons';
import { button } from '../controls';

export function historyPanel(): HTMLElement {
  const list = h('div', { class: 'history-list', role: 'listbox', 'aria-label': 'History' });
  const scrub = h('input', { type: 'range', class: 'history-scrub', min: 0, max: 0, value: 0, 'aria-label': 'History position' });
  const info = h('div', { class: 'history-info' });
  let scheduled = false;

  function render() {
    scheduled = false;
    const hist = app.history;
    list.innerHTML = '';
    const start = h('button', { class: 'hist-item' + (hist.index === 0 ? ' current' : ''), type: 'button', tip: { title: 'Starting point', desc: 'Go back to how the document was when opened.' } },
      svgIcon(icon('new')), h('span', { class: 'hist-label' }, 'Start'));
    start.addEventListener('click', () => void hist.jumpTo(0));
    list.append(start);
    // show the most recent 400 entries for speed; the scrubber reaches everything
    const from = Math.max(0, hist.entries.length - 400);
    for (let i = from; i < hist.entries.length; i++) {
      const e = hist.entries[i];
      const applied = i < hist.index;
      const it = h('button', { class: 'hist-item' + (i === hist.index - 1 ? ' current' : '') + (applied ? '' : ' undone'), type: 'button', tip: { title: e.label, desc: `Step ${i + 1} · ${new Date(e.time).toLocaleTimeString()}. Click to jump here - later steps stay available until you paint something new.` } },
        e.thumb ? h('img', { class: 'hist-thumb', src: e.thumb, alt: '' }) : svgIcon(icon(e.icon)),
        h('span', { class: 'hist-label' }, e.label),
        h('span', { class: 'hist-n' }, String(i + 1)));
      it.addEventListener('click', () => void hist.jumpTo(i + 1));
      list.append(it);
    }
    scrub.max = String(hist.entries.length);
    scrub.value = String(hist.index);
    info.textContent = `${hist.index} of ${hist.entries.length} steps · unlimited undo`;
    const cur = list.querySelector('.current');
    cur?.scrollIntoView({ block: 'nearest' });
  }
  app.history.events.on('change', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(render); } });
  scrub.addEventListener('input', () => void app.history.jumpTo(Number(scrub.value)));

  const el = h('div', { class: 'panel-body history-panel' },
    h('div', { class: 'row' },
      button('Undo', { icon: 'undo', small: true, tip: { title: 'Undo', desc: 'Step back. There is no limit.', key: 'Ctrl+Z' }, onClick: () => void app.history.undo() }),
      button('Redo', { icon: 'redo', small: true, tip: { title: 'Redo', desc: 'Step forward again.', key: 'Ctrl+Shift+Z' }, onClick: () => void app.history.redo() }),
    ),
    h('label', { class: 'scrub-wrap', tip: { title: 'Timeline scrubber', desc: 'Drag to travel back and forth through every step of your painting.' } }, scrub),
    info,
    list);
  render();
  return el;
}
