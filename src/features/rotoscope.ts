// Rotoscoping: import a video, trace over it frame by frame on an animation layer with onion skinning,
// then export the animation (with or without the video) as a video file or a sprite sheet.
import { app } from '../app/app';
import { Layer, ctx2d, makeCanvas } from '../core/layer';
import { addLayer } from '../app/ops';
import { h, svgIcon } from '../ui/dom';
import { icon } from '../ui/icons';
import { button, select, slider, toggle } from '../ui/controls';
import { download, openDialog } from '../ui/dialog';
import type { Viewport } from '../app/viewport';

interface Roto {
  video: HTMLVideoElement;
  videoLayer: Layer;
  anim: Layer;
  fps: number;
  frames: number;
  frame: number;
  name: string;
}

let roto: Roto | null = null;
let bar: HTMLElement;
const onion = { on: true, before: 2, after: 1, opacity: 0.35 };
let playing = false;
const tintCache = new Map<string, HTMLCanvasElement>();

export function rotoActive(): boolean { return !!roto; }

export function initRotoscope(parent: HTMLElement, vp: Viewport): void {
  bar = h('div', { class: 'roto-bar hidden', 'data-tip-side': 'top' });
  parent.append(bar);
  vp.overlayHooks.push(drawOnion);
  window.addEventListener('keydown', (e) => {
    if (!roto || (e.target as HTMLElement).closest('input,textarea,select')) return;
    if (e.key === ',' ) { e.preventDefault(); void step(-1); }
    if (e.key === '.') { e.preventDefault(); void step(1); }
  });
}

export async function importVideo(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  const video = h('video', { src: url, muted: true, playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
  await new Promise<void>((res, rej) => { video.onloadeddata = () => res(); video.onerror = () => rej(new Error('This video format is not supported by your browser.')); });
  const fps = await askFps(video);
  if (!fps) return;
  const doc = app.doc;
  const vl = new Layer('Video: ' + file.name, doc.width, doc.height, 'video');
  vl.video = video; vl.opacity = 0.6; vl.locked = true;
  addLayer(vl, doc.indexOf(doc.active) + 1, 'Import video');
  const an = new Layer('Animation', doc.width, doc.height, 'animation');
  an.frames = new Map();
  an.frames.set(0, an.canvas);
  addLayer(an, doc.indexOf(vl) + 1, 'Add animation layer');
  roto = { video, videoLayer: vl, anim: an, fps, frames: Math.max(1, Math.floor(video.duration * fps)), frame: 0, name: file.name };
  await setFrame(0);
  renderBar();
  let t = 0;
  app.doc.events.on('pixels', ({ layer }) => { if (roto && layer === roto.anim) { clearTimeout(t); t = window.setTimeout(updateBar, 300); } });
  app.tools.set('brush');
  app.toast('Trace over the video on the "Animation" layer. Use the timeline below (or , and . keys) to step through frames.', 'success');
}

function askFps(video: HTMLVideoElement): Promise<number | null> {
  return new Promise((resolve) => {
    let fps = 12;
    const d = openDialog('Rotoscope a video', { width: 480, icon: 'video', subtitle: `${video.videoWidth} × ${video.videoHeight}, ${video.duration.toFixed(1)} s. The video goes on a locked tracing layer; you draw each frame on the animation layer above it.` });
    d.body.append(
      select('Animation frame rate', '12', [
        { value: '6', label: '6 fps - very choppy, quick to draw' }, { value: '8', label: '8 fps - stylised' },
        { value: '12', label: '12 fps - classic hand-drawn ("on twos")' }, { value: '15', label: '15 fps' },
        { value: '24', label: '24 fps - smooth, film ("on ones")' }, { value: '30', label: '30 fps - very smooth, lots of drawing' },
      ], (v) => (fps = Number(v)), 'How many drawings per second of video. Fewer = less work and a hand-made look.'),
      h('p', { class: 'hint' }, `That is about ${Math.floor(video.duration * 12)} drawings at 12 fps. You don't need to draw every frame - empty frames are skipped when exporting.`),
    );
    let ok = false;
    d.footer.append(button('Cancel', { onClick: () => d.close() }), button('Start tracing', { primary: true, icon: 'check', onClick: () => { ok = true; d.close(); } }));
    d.onClose = () => resolve(ok ? fps : null);
  });
}

async function drawVideoFrame(r: Roto): Promise<void> {
  const v = r.video;
  const t = Math.min(v.duration - 0.001, (r.frame + 0.5) / r.fps);
  if (Math.abs(v.currentTime - t) > 0.001) {
    await new Promise<void>((res) => { const f = () => { v.removeEventListener('seeked', f); res(); }; v.addEventListener('seeked', f); v.currentTime = t; setTimeout(f, 800); });
  }
  const doc = app.doc;
  const c = ctx2d(r.videoLayer.canvas);
  c.clearRect(0, 0, doc.width, doc.height);
  const s = Math.min(doc.width / v.videoWidth, doc.height / v.videoHeight);
  c.drawImage(v, (doc.width - v.videoWidth * s) / 2, (doc.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
  doc.markDirty(r.videoLayer, null);
}

export async function setFrame(i: number): Promise<void> {
  const r = roto; if (!r) return;
  if (!app.doc.layers.includes(r.anim)) { closeRoto(); return; }
  await app.backend.flush();
  r.frame = Math.max(0, Math.min(r.frames - 1, i));
  r.anim.setFrame(r.frame, app.doc.width, app.doc.height);
  app.doc.markDirty(r.anim, null);
  if (app.doc.layers.includes(r.videoLayer)) await drawVideoFrame(r);
  tintCache.clear();
  updateBar();
  app.view.requestRender();
}

/** Which animation frame a cel canvas belongs to. */
export function frameOfCanvas(layer: Layer, canvas: HTMLCanvasElement): number | null {
  if (!layer.frames) return null;
  for (const [k, c] of layer.frames) if (c === canvas) return k;
  return null;
}

async function step(d: number) { if (roto) await setFrame(roto.frame + d); }

const drawn = new Map<HTMLCanvasElement, boolean>();
const probe = makeCanvas(24, 24);
function hasCel(i: number): boolean {
  const c = roto?.anim.frames?.get(i);
  if (!c) return false;
  if (c !== roto!.anim.canvas && drawn.has(c)) return drawn.get(c)!;
  const x = ctx2d(probe);
  x.clearRect(0, 0, 24, 24);
  x.drawImage(c, 0, 0, 24, 24);
  const d = x.getImageData(0, 0, 24, 24).data;
  let any = false;
  for (let k = 3; k < d.length; k += 4) if (d[k]) { any = true; break; }
  drawn.set(c, any);
  return any;
}

function tinted(i: number, rgb: string): HTMLCanvasElement | null {
  const c = roto?.anim.frames?.get(i);
  if (!c) return null;
  const key = i + rgb;
  let t = tintCache.get(key);
  if (!t) {
    t = makeCanvas(c.width, c.height);
    const x = ctx2d(t);
    x.drawImage(c, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = rgb; x.fillRect(0, 0, t.width, t.height);
    tintCache.set(key, t);
  }
  return t;
}

function drawOnion(ctx: CanvasRenderingContext2D, vp: Viewport): void {
  if (!roto || !onion.on) return;
  vp.docTransform(ctx);
  for (let k = onion.before; k >= 1; k--) {
    const t = tinted(roto.frame - k, '#ff3b5c'); if (!t) continue;
    ctx.globalAlpha = onion.opacity * (1 - (k - 1) / (onion.before + 1)); ctx.drawImage(t, 0, 0);
  }
  for (let k = 1; k <= onion.after; k++) {
    const t = tinted(roto.frame + k, '#22c55e'); if (!t) continue;
    ctx.globalAlpha = onion.opacity * (1 - (k - 1) / (onion.after + 1)); ctx.drawImage(t, 0, 0);
  }
  ctx.globalAlpha = 1;
}

let frameSlider: HTMLInputElement, frameLabel: HTMLElement, marks: HTMLElement, playBtn: HTMLButtonElement;

function renderBar(): void {
  const r = roto!;
  bar.innerHTML = '';
  bar.classList.remove('hidden');
  frameSlider = h('input', { type: 'range', min: 0, max: r.frames - 1, value: r.frame, class: 'roto-slider', 'aria-label': 'Frame' });
  frameSlider.addEventListener('input', () => void setFrame(Number(frameSlider.value)));
  frameLabel = h('span', { class: 'roto-label' });
  marks = h('div', { class: 'roto-marks' });
  playBtn = button('Play', { icon: 'play', small: true, tip: { title: 'Play / pause', desc: 'Preview the animation over the video.', key: 'Space' }, onClick: () => togglePlay() });
  bar.append(
    h('div', { class: 'roto-title' }, svgIcon(icon('film')), h('span', null, 'Rotoscope')),
    button('Previous', { icon: 'stepB', small: true, tip: { title: 'Previous frame', key: ',' }, onClick: () => void step(-1) }),
    playBtn,
    button('Next', { icon: 'stepF', small: true, tip: { title: 'Next frame', key: '.' }, onClick: () => void step(1) }),
    h('div', { class: 'roto-track', tip: { title: 'Timeline', desc: 'Drag to scrub through the video. Dots mark frames you have drawn.' } }, marks, frameSlider),
    frameLabel,
    button('Copy previous', { icon: 'copy', small: true, tip: 'Copy the drawing from the previous frame into this one, to adjust it instead of redrawing.', onClick: copyPrev }),
    button('Clear frame', { icon: 'trash', small: true, tip: 'Erase the drawing on this frame.', onClick: () => { const c = ctx2d(r.anim.canvas); c.clearRect(0, 0, c.canvas.width, c.canvas.height); app.doc.markDirty(r.anim, null); updateBar(); } }),
    toggle('Onion skin', onion.on, (v) => { onion.on = v; app.view.requestOverlay(); }, 'Show neighbouring frames faintly: red = before, green = after. Helps keep motion smooth.'),
    slider({ label: 'Onion opacity', min: 0.05, max: 0.8, step: 0.01, percent: true, value: onion.opacity, compact: true, onInput: (v) => { onion.opacity = v; app.view.requestOverlay(); }, tip: 'How visible the neighbouring frames are.' }),
    slider({ label: 'Video opacity', min: 0, max: 1, step: 0.01, percent: true, value: r.videoLayer.opacity, compact: true, onInput: (v) => { r.videoLayer.opacity = v; app.doc.events.emit('structure', undefined); }, tip: 'Fade the video to see your drawing better.' }),
    button('Export…', { icon: 'download', small: true, primary: true, tip: 'Export the animation as a video or sprite sheet.', onClick: exportDialog }),
    button('Close', { icon: 'close', small: true, iconOnly: true, tip: 'Hide the rotoscope timeline (layers stay).', onClick: closeRoto }),
  );
  updateBar();
}

function updateBar(): void {
  const r = roto; if (!r || !frameSlider) return;
  frameSlider.value = String(r.frame);
  const secs = r.frame / r.fps;
  frameLabel.textContent = `Frame ${r.frame + 1} / ${r.frames} · ${secs.toFixed(2)} s`;
  marks.innerHTML = '';
  for (const k of r.anim.frames!.keys()) {
    if (!hasCel(k)) continue;
    marks.append(h('span', { class: 'roto-mark', style: `left:${(k / Math.max(1, r.frames - 1)) * 100}%` }));
  }
}

function copyPrev(): void {
  const r = roto!; const prev = r.anim.frames!.get(r.frame - 1);
  if (!prev) { app.toast('The previous frame is empty.', 'info'); return; }
  const c = ctx2d(r.anim.canvas); c.drawImage(prev, 0, 0);
  app.doc.markDirty(r.anim, null); updateBar();
}

function togglePlay(): void {
  playing = !playing;
  playBtn.querySelector('.btn-label')!.textContent = playing ? 'Pause' : 'Play';
  const tick = async () => {
    if (!playing || !roto) return;
    const t0 = performance.now();
    await setFrame((roto.frame + 1) % roto.frames);
    setTimeout(tick, Math.max(0, 1000 / roto.fps - (performance.now() - t0)));
  };
  if (playing) void tick();
}

export function closeRoto(): void {
  playing = false;
  roto = null;
  bar.classList.add('hidden');
  app.view.requestOverlay();
}

async function exportDialog(): Promise<void> {
  const r = roto!;
  const d = openDialog('Export animation', { width: 480, icon: 'film' });
  let withVideo = false, format = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
  d.body.append(
    toggle('Include the video underneath', withVideo, (v) => (withVideo = v), 'Off: only your drawing (on the paper colour). On: your drawing over the video.'),
    h('p', { class: 'hint' }, `${r.frames} frames at ${r.fps} fps (${(r.frames / r.fps).toFixed(1)} s). Exporting runs in real time.`),
  );
  const renderFrame = async (i: number, target: CanvasRenderingContext2D, w: number, hh: number) => {
    await setFrame(i);
    const layers = app.doc.layers.filter((l) => l !== r.videoLayer || withVideo);
    target.drawImage(app.doc.flatten({ layers, background: true }), 0, 0, w, hh);
  };
  d.footer.append(
    button('Sprite sheet PNG', { icon: 'grid', tip: 'All frames in one image grid - for games and web animation.', onClick: async () => {
      const n = r.frames, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const s = Math.min(1, 8192 / (cols * app.doc.width), 8192 / (rows * app.doc.height));
      const fw = Math.floor(app.doc.width * s), fh = Math.floor(app.doc.height * s);
      const sheet = makeCanvas(cols * fw, rows * fh);
      const sx = ctx2d(sheet);
      for (let i = 0; i < n; i++) {
        const tmp = makeCanvas(fw, fh); await renderFrame(i, ctx2d(tmp), fw, fh);
        sx.drawImage(tmp, (i % cols) * fw, Math.floor(i / cols) * fh);
      }
      sheet.toBlob((b) => b && download(b, 'animation-spritesheet.png'));
      d.close();
    } }),
    button('Export video', { icon: 'download', primary: true, onClick: async () => {
      d.close();
      const c = makeCanvas(app.doc.width - (app.doc.width % 2), app.doc.height - (app.doc.height % 2));
      const x = ctx2d(c);
      const track = c.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const rec = new MediaRecorder(new MediaStream([track]), { mimeType: MediaRecorder.isTypeSupported(format) ? format : 'video/webm', videoBitsPerSecond: 10_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((res) => (rec.onstop = res));
      rec.start();
      app.toast('Rendering animation…', 'info');
      for (let i = 0; i < r.frames; i++) {
        const t0 = performance.now();
        await renderFrame(i, x, c.width, c.height);
        track.requestFrame();
        await new Promise((res) => setTimeout(res, Math.max(0, 1000 / r.fps - (performance.now() - t0))));
      }
      rec.stop(); await stopped;
      download(new Blob(chunks, { type: rec.mimeType }), `animation.${rec.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
      app.toast('Animation exported.', 'success');
    } }),
  );
}

export function rotoInfo() {
  return roto ? { fps: roto.fps, frames: roto.frames, frame: roto.frame, video: roto.name } : null;
}
