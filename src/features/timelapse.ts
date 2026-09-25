// Timelapse: records a small frame after every change; replay and export as a video.
import { app } from '../app/app';
import { h } from '../ui/dom';
import { button, select, slider, toggle } from '../ui/controls';
import { download, openDialog } from '../ui/dialog';

const MAX_SIDE = 1080;

class Timelapse {
  frames: Blob[] = [];
  private busy = false;
  private queued = false;
  private last = 0;

  reset() { this.frames = []; }

  /** Capture a frame (throttled). */
  capture(): void {
    if (!app.settings.timelapse || !app.doc) return;
    const now = performance.now();
    if (this.busy) { this.queued = true; return; }
    if (now - this.last < 250) { if (!this.queued) { this.queued = true; setTimeout(() => { this.queued = false; this.capture(); }, 260); } return; }
    this.last = now;
    this.busy = true;
    const d = app.doc;
    const s = Math.min(1, MAX_SIDE / Math.max(d.width, d.height));
    const c = d.flatten({ scale: s, background: true });
    c.toBlob((b) => {
      if (b) this.frames.push(b);
      this.busy = false;
      if (this.queued) { this.queued = false; setTimeout(() => this.capture(), 50); }
    }, 'image/jpeg', 0.85);
  }

  async openPlayer(): Promise<void> {
    if (this.frames.length < 2) { app.toast('Paint a little first - the timelapse records automatically as you work.', 'info'); return; }
    const d = openDialog('Timelapse', { width: 760, icon: 'timer', subtitle: `${this.frames.length} frames recorded. Every stroke and change is captured automatically.` });
    const canvas = h('canvas', { class: 'tl-canvas' });
    const ctx = canvas.getContext('2d')!;
    const first = await createImageBitmap(this.frames[0]);
    canvas.width = first.width; canvas.height = first.height;
    ctx.drawImage(first, 0, 0);
    let fps = 24, hold = 2, playing = false, idx = 0, raf = 0;
    const pos = h('input', { type: 'range', min: 0, max: this.frames.length - 1, value: 0, class: 'tl-pos', 'aria-label': 'Frame' });
    const show = async (i: number) => { const b = await createImageBitmap(this.frames[i]); ctx.drawImage(b, 0, 0, canvas.width, canvas.height); b.close(); pos.value = String(i); };
    pos.addEventListener('input', () => { idx = Number(pos.value); void show(idx); });
    const play = () => {
      playing = !playing;
      playBtn.querySelector('.btn-label')!.textContent = playing ? 'Pause' : 'Play';
      let t0 = performance.now();
      const loop = async (t: number) => {
        if (!playing) return;
        if (t - t0 >= 1000 / fps) { t0 = t; idx = (idx + 1) % this.frames.length; await show(idx); }
        raf = requestAnimationFrame(loop);
      };
      if (playing) raf = requestAnimationFrame(loop);
    };
    const playBtn = button('Play', { icon: 'play', primary: true, onClick: play });
    let format = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    const formats = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].filter((f) => MediaRecorder.isTypeSupported(f));
    d.body.append(h('div', { class: 'tl-wrap checker' }, canvas), pos,
      h('div', { class: 'row wrap' },
        playBtn,
        slider({ label: 'Speed (frames per second)', min: 2, max: 60, step: 1, value: fps, unit: ' fps', compact: true, onInput: (v) => (fps = v), tip: 'How fast the timelapse plays.' }),
        slider({ label: 'Hold final image', min: 0, max: 8, step: 0.5, value: hold, unit: ' s', compact: true, onInput: (v) => (hold = v), tip: 'Seconds to show the finished painting at the end of the video.' }),
        formats.length ? select('Video format', formats.includes(format) ? format : formats[0], formats.map((f) => ({ value: f, label: f.includes('mp4') ? 'MP4' : f.includes('vp9') ? 'WebM (VP9)' : 'WebM' })), (v) => (format = v), 'MP4 plays everywhere; WebM is smaller.') : h('span', null, 'Video export not supported in this browser.'),
      ));
    d.footer.append(
      toggle('Keep recording', app.settings.timelapse, (v) => { app.settings.timelapse = v; app.saveSettings(); }, 'Record timelapse frames while you paint.'),
      button('Clear recording', { icon: 'trash', onClick: () => { this.frames = this.frames.slice(-1); d.close(); app.toast('Timelapse cleared.', 'info'); } }),
      button('Export video', { icon: 'download', primary: true, tip: 'Render the timelapse to a video file (plays in real time while recording).', onClick: async () => {
        playing = false; cancelAnimationFrame(raf);
        await this.exportVideo(canvas, fps, hold, formats.includes(format) ? format : formats[0], (p) => { pos.value = String(Math.round(p * (this.frames.length - 1))); });
      } }),
    );
    d.onClose = () => { playing = false; cancelAnimationFrame(raf); };
  }

  async exportVideo(canvas: HTMLCanvasElement, fps: number, hold: number, mime: string, progress: (p: number) => void): Promise<void> {
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    app.toast('Rendering video… keep this tab open.', 'info');
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < this.frames.length; i++) {
      const b = await createImageBitmap(this.frames[i]);
      ctx.drawImage(b, 0, 0, canvas.width, canvas.height); b.close();
      track.requestFrame();
      progress(i / (this.frames.length - 1));
      await wait(1000 / fps);
    }
    const holdFrames = Math.round(hold * fps);
    for (let i = 0; i < holdFrames; i++) { track.requestFrame(); await wait(1000 / fps); }
    rec.stop();
    await done;
    download(new Blob(chunks, { type: mime }), `timelapse.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
    app.toast('Timelapse video saved.', 'success');
  }
}

export const timelapse = new Timelapse();
