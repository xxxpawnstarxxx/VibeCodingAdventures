import { app } from '../app/app';
import type { ToolEvent } from '../app/viewport';
import type { Tool } from './tool';
import { makePaintTools, pickAt } from './paintTools';
import { bucketTool, gradientTool, pickerTool } from './fillTools';
import { shapeTool } from './shapeTool';
import { lassoTool, selectTool, wandTool } from './selectTools';
import { cropTool, guidesTool, handTool, moveTool, zoomTool } from './transformTools';
import type { Pt } from '../core/geom';

/** Tool groups for the toolbar (separators between groups). */
export const TOOL_GROUPS = [['brush', 'eraser', 'smudge', 'fill', 'gradient', 'picker'], ['shapes', 'select', 'lasso', 'wand', 'move', 'crop'], ['guides', 'hand', 'zoom']];

export class ToolManager {
  tools: Tool[];
  current: Tool;
  private active = false;

  constructor() {
    this.tools = [...makePaintTools(), bucketTool, gradientTool, pickerTool, shapeTool, selectTool, lassoTool, wandTool, moveTool, cropTool, guidesTool, handTool, zoomTool];
    this.current = this.tools[0];
  }

  get(id: string): Tool | undefined { return this.tools.find((t) => t.id === id); }

  set(id: string): void {
    const t = this.get(id);
    if (!t || t === this.current) return;
    this.current.deactivate?.();
    this.current = t;
    t.activate?.();
    app.view.updateCursor();
    app.view.requestOverlay();
    app.events.emit('tool', id);
    app.status(t.hint);
  }

  down(e: ToolEvent) { this.active = true; this.current.down?.(e); }
  move(e: ToolEvent) { if (this.active) this.current.move?.(e); }
  up(e: ToolEvent) { if (!this.active) return; this.active = false; this.current.up?.(e); }
  hover(e: ToolEvent) { this.current.hover?.(e); }
  cancel() { this.active = false; this.current.cancel?.(); }

  pickColorAt(p: Pt, secondary: boolean) { pickAt(p, secondary); }

  handleKey(e: KeyboardEvent): boolean { return !!this.current.key_?.(e); }
}
