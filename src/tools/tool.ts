import type { ToolEvent, Viewport } from '../app/viewport';
import type { RGB } from '../core/color';
import { app } from '../app/app';

export interface Tool {
  id: string;
  name: string;
  icon: string;
  key?: string;
  /** Tooltip explanation for beginners. */
  desc: string;
  /** Status-bar hint while the tool is active. */
  hint: string;
  cursor?: string;
  /** Uses the brush (shows brush cursor, right-click picks colour). */
  paints?: boolean;
  down?(e: ToolEvent): void;
  move?(e: ToolEvent): void;
  up?(e: ToolEvent): void;
  hover?(e: ToolEvent): void;
  cancel?(): void;
  key_?(e: KeyboardEvent): boolean;
  drawOverlay?(ctx: CanvasRenderingContext2D, vp: Viewport): void;
  options?(): HTMLElement;
  activate?(): void;
  deactivate?(): void;
}

/** Read the colour under a document point. */
export function sampleColor(x: number, y: number, allLayers: boolean, size = 1): RGB | null {
  const doc = app.doc;
  x = Math.floor(x); y = Math.floor(y);
  const r = Math.floor(size / 2);
  const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
  const x1 = Math.min(doc.width, x + r + 1), y1 = Math.min(doc.height, y + r + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  let data: Uint8ClampedArray;
  if (allLayers) {
    const c = doc.flatten({ region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  } else {
    data = doc.active.ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  }
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; R += data[i] * a; G += data[i + 1] * a; B += data[i + 2] * a; A += a; }
  if (A === 0) return allLayers ? [...doc.background.color] as RGB : null;
  return [R / A / 255, G / A / 255, B / A / 255];
}
