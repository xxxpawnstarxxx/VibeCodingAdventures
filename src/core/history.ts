import { Emitter } from './events';

export interface HistoryEntry {
  label: string;
  icon: string;
  time: number;
  thumb?: string;
  undo(): Promise<void> | void;
  redo(): Promise<void> | void;
  /** Called when the entry becomes old - it may compress its data. */
  compact?(): Promise<void>;
  /** Called when the entry is discarded (redo branch cut). */
  dispose?(): void;
  bytes?: number;
}

interface HistoryEvents extends Record<string, unknown> { change: void }

/**
 * Unlimited linear undo/redo. Old pixel entries are compacted to PNG blobs (which browsers can page to
 * disk), so the history has no fixed length. `index` = number of entries currently applied.
 */
export class History {
  entries: HistoryEntry[] = [];
  index = 0;
  busy = false;
  events = new Emitter<HistoryEvents>();
  /** Entries more recent than this stay uncompressed for instant undo. */
  hotCount = 24;
  private queue: Promise<void> = Promise.resolve();

  get canUndo() { return this.index > 0 && !this.busy; }
  get canRedo() { return this.index < this.entries.length && !this.busy; }

  push(e: HistoryEntry): void {
    const cut = this.entries.splice(this.index);
    cut.forEach((x) => x.dispose?.());
    this.entries.push(e);
    this.index = this.entries.length;
    const old = this.entries[this.entries.length - 1 - this.hotCount];
    if (old?.compact) old.compact().catch(() => {});
    this.events.emit('change', undefined);
  }

  /** Serialise history operations so async undo/redo never interleave. */
  private run(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      this.busy = true;
      try { await fn(); } finally { this.busy = false; this.events.emit('change', undefined); }
    });
    return this.queue;
  }

  undo(): Promise<void> {
    return this.run(async () => {
      if (this.index <= 0) return;
      this.index--;
      await this.entries[this.index].undo();
    });
  }

  redo(): Promise<void> {
    return this.run(async () => {
      if (this.index >= this.entries.length) return;
      await this.entries[this.index].redo();
      this.index++;
    });
  }

  /** Jump so that `target` entries are applied. */
  jumpTo(target: number): Promise<void> {
    return this.run(async () => {
      target = Math.max(0, Math.min(this.entries.length, target));
      while (this.index > target) { this.index--; await this.entries[this.index].undo(); }
      while (this.index < target) { await this.entries[this.index].redo(); this.index++; }
    });
  }

  clear(): void {
    this.entries.forEach((e) => e.dispose?.());
    this.entries = [];
    this.index = 0;
    this.events.emit('change', undefined);
  }
}

/** Pixel data that can be compacted into a PNG blob and restored later. */
export class PixelStore {
  private img: ImageData | null;
  private blob: Blob | null = null;
  readonly w: number;
  readonly h: number;
  constructor(img: ImageData) { this.img = img; this.w = img.width; this.h = img.height; }

  get bytes() { return this.img ? this.img.data.length : this.blob?.size ?? 0; }

  async get(): Promise<ImageData> {
    if (this.img) return this.img;
    const bmp = await createImageBitmap(this.blob!, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(bmp, 0, 0);
    bmp.close();
    return x.getImageData(0, 0, this.w, this.h);
  }

  async compact(): Promise<void> {
    if (!this.img || this.img.data.length < 64 * 1024) return;
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    c.getContext('2d')!.putImageData(this.img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (blob) { this.blob = blob; this.img = null; }
  }
}
