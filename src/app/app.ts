// Central application state. A single `app` instance is shared by all modules.
import { PaintDocument } from '../core/document';
import { History } from '../core/history';
import { Emitter } from '../core/events';
import type { RGB } from '../core/color';
import { hexToRgb, rgbToHex } from '../core/color';
import type { PaintBackend } from '../engine/types';
import { PRESETS, cloneBrush, loadCustomBrushes, saveCustomBrushes, type BrushSettings } from '../engine/brush';
import { loadSettings, saveSettings, type Settings } from './settings';
import type { Viewport } from './viewport';
import type { ToolManager } from '../tools/toolManager';

export interface AppEvents extends Record<string, unknown> {
  color: void;
  brush: void;
  tool: string;
  settings: void;
  document: void;
  status: string;
  view: void;
  toast: { msg: string; kind?: 'info' | 'error' | 'success' };
}

export type BrushSlot = 'brush' | 'eraser' | 'smudge';

class App {
  doc!: PaintDocument;
  history = new History();
  backend!: PaintBackend;
  view!: Viewport;
  tools!: ToolManager;
  settings: Settings = loadSettings();
  events = new Emitter<AppEvents>();
  color: RGB = [0.11, 0.2, 0.55];
  color2: RGB = [1, 1, 1];
  customBrushes: BrushSettings[] = loadCustomBrushes();
  brushes: Record<BrushSlot, BrushSettings> = {
    brush: cloneBrush(PRESETS.find((b) => b.id === 'watercolor')!),
    eraser: cloneBrush(PRESETS.find((b) => b.id === 'eraser')!),
    smudge: cloneBrush(PRESETS.find((b) => b.id === 'smudge')!),
  };
  brushSlot: BrushSlot = 'brush';
  /** Currently shown tip image for custom 'texture' tips (data URL -> ImageData cache). */
  private tipCache = new Map<string, ImageData>();

  get allBrushes(): BrushSettings[] { return [...PRESETS, ...this.customBrushes]; }
  get brush(): BrushSettings { return this.brushes[this.brushSlot]; }

  setColor(c: RGB, secondary = false): void {
    if (secondary) this.color2 = [...c] as RGB; else this.color = [...c] as RGB;
    this.events.emit('color', undefined);
  }
  swapColors(): void { [this.color, this.color2] = [this.color2, this.color]; this.events.emit('color', undefined); }
  pushRecent(c: RGB = this.color): void {
    const hex = rgbToHex(c);
    const r = this.settings.recent.filter((x) => x !== hex);
    r.unshift(hex);
    this.settings.recent = r.slice(0, 16);
    this.saveSettings();
  }
  get colorHex() { return rgbToHex(this.color); }
  setColorHex(h: string) { const c = hexToRgb(h); if (c) this.setColor(c); }

  selectBrush(b: BrushSettings, slot: BrushSlot = this.slotFor(b)): void {
    this.brushes[slot] = cloneBrush(b);
    this.brushSlot = slot;
    this.applyTip();
    // picking an eraser / blender brush switches to the matching tool so it just works
    const tool = slot === 'brush' ? 'brush' : slot === 'eraser' ? 'eraser' : 'smudge';
    if (this.tools && this.tools.current.id !== tool) this.tools.set(tool);
    this.events.emit('brush', undefined);
  }
  slotFor(b: BrushSettings): BrushSlot { return b.mode === 'erase' ? 'eraser' : b.mode === 'smudge' || b.mode === 'blend' ? 'smudge' : 'brush'; }
  brushChanged(): void { this.applyTip(); this.events.emit('brush', undefined); }

  applyTip(): void {
    const b = this.brush;
    if (b.tip !== 'texture' || !b.tipImage) { this.backend?.setTipImage(null); return; }
    const cached = this.tipCache.get(b.tipImage);
    if (cached) { this.backend.setTipImage(cached); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d')!;
      x.drawImage(img, 0, 0);
      const data = x.getImageData(0, 0, c.width, c.height);
      this.tipCache.set(b.tipImage!, data);
      if (this.brush.tipImage === b.tipImage) this.backend.setTipImage(data);
    };
    img.src = b.tipImage;
  }

  saveCustom(): void { saveCustomBrushes(this.customBrushes); }
  saveSettings(): void { saveSettings(this.settings); this.events.emit('settings', undefined); }

  toast(msg: string, kind: 'info' | 'error' | 'success' = 'info') { this.events.emit('toast', { msg, kind }); }
  status(msg: string) { this.events.emit('status', msg); }
  requestRender() { this.view?.requestRender(); }
}

export const app = new App();
(window as any).__flowpaintApp = app;
