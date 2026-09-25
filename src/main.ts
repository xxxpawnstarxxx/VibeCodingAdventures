import './styles.css';
import { app } from './app/app';
import { initWasm } from './wasm/wasm';
import { initTooltips } from './ui/tooltip';
import { buildShell } from './ui/shell';
import { Viewport } from './app/viewport';
import { ToolManager } from './tools/toolManager';
import { CanvasBackend } from './engine/canvasBackend';
import { GpuBackend } from './engine/gpu/gpuBackend';
import type { PaintBackend } from './engine/types';
import { hasAutosave, installDropHandler, newDocument, openNewDocDialog, scheduleAutosave } from './features/io';
import { recordPixels } from './app/ops';
import { installShortcuts } from './app/shortcuts';
import { toast } from './ui/dialog';
import { references } from './features/references';
import { initRotoscope } from './features/rotoscope';
import { timelapse } from './features/timelapse';
import { installApi } from './api/agentApi';

async function createBackend(): Promise<PaintBackend> {
  const want = new URLSearchParams(location.search).get('backend');
  if (want !== 'cpu') {
    try {
      const g = await GpuBackend.create();
      if (g) return g;
    } catch (e) { console.warn('WebGPU unavailable, using CPU painter:', e); }
  }
  return new CanvasBackend();
}

async function boot() {
  const splash = document.getElementById('splash');
  await initWasm();
  initTooltips();
  app.tools = new ToolManager();
  app.backend = await createBackend();
  const shell = buildShell();
  app.view = new Viewport(shell.viewportHost);
  app.view.attachBackend(app.backend);
  app.backend.onChange = () => app.view.requestRender();
  app.backend.onCommit = ({ layer, rect, before, label }) => {
    const icon = /erase/i.test(label) ? 'eraser' : /smudge|blend|knife/i.test(label) ? 'smudge' : 'brush';
    recordPixels(layer, rect, before, label, icon);
  };
  references.init(shell.refHost);
  initRotoscope(shell.bottom, app.view);
  app.events.on('toast', ({ msg, kind }) => toast(msg, kind));
  app.history.events.on('change', () => { scheduleAutosave(); timelapse.capture(); app.requestRender(); });
  installShortcuts();
  installDropHandler();
  installApi();
  newDocument(2048, 1536);
  app.tools.set('smudge');
  app.tools.set('brush');
  app.applyTip();
  splash?.remove();
  if (!new URLSearchParams(location.search).has('nowelcome')) openNewDocDialog(true, await hasAutosave());
  if (app.backend.kind === 'canvas2d') toast('WebGPU is not available here - painting runs on the CPU. For the full liquid simulation use a recent Chrome, Edge or Safari.', 'info', 7000);
  window.addEventListener('beforeunload', () => { void app.backend.flush(); });
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div class="fatal"><h1>Flowpaint could not start</h1><p>${(e as Error).message}</p></div>`;
});
