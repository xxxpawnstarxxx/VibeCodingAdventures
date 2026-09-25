import type { Adjustments } from '../wasm/wasm';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'hard-light' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity' | 'add';

export const BLEND_MODES: { id: BlendMode; name: string; tip: string }[] = [
  { id: 'normal', name: 'Normal', tip: 'Paint simply covers what is below.' },
  { id: 'multiply', name: 'Multiply', tip: 'Darkens like layering transparent ink or watercolour glazes. White disappears.' },
  { id: 'screen', name: 'Screen', tip: 'Lightens like projecting light. Black disappears.' },
  { id: 'overlay', name: 'Overlay', tip: 'Boosts contrast: darks get darker, lights get lighter.' },
  { id: 'soft-light', name: 'Soft light', tip: 'A gentle version of Overlay, good for shading and glow.' },
  { id: 'hard-light', name: 'Hard light', tip: 'A strong version of Overlay.' },
  { id: 'darken', name: 'Darken', tip: 'Keeps whichever colour is darker.' },
  { id: 'lighten', name: 'Lighten', tip: 'Keeps whichever colour is lighter.' },
  { id: 'color-dodge', name: 'Color dodge', tip: 'Brightens strongly - great for glowing highlights.' },
  { id: 'color-burn', name: 'Color burn', tip: 'Darkens strongly with rich saturated shadows.' },
  { id: 'difference', name: 'Difference', tip: 'Subtracts colours - useful for comparing two images.' },
  { id: 'exclusion', name: 'Exclusion', tip: 'A softer Difference.' },
  { id: 'hue', name: 'Hue', tip: 'Only changes the hue of what is below.' },
  { id: 'saturation', name: 'Saturation', tip: 'Only changes how colourful the layer below is.' },
  { id: 'color', name: 'Color', tip: 'Colourises what is below while keeping its light and shadow - perfect for tinting a greyscale drawing.' },
  { id: 'luminosity', name: 'Luminosity', tip: 'Only changes brightness of what is below.' },
  { id: 'add', name: 'Add (glow)', tip: 'Adds light. Great for fire, sparks and glows.' },
];

export const BLEND_INDEX: Record<BlendMode, number> = Object.fromEntries(BLEND_MODES.map((b, i) => [b.id, i])) as Record<BlendMode, number>;

export function canvasBlendOp(b: BlendMode): GlobalCompositeOperation {
  if (b === 'normal') return 'source-over';
  if (b === 'add') return 'lighter';
  return b as GlobalCompositeOperation;
}

export type LayerKind = 'paint' | 'image' | 'video' | 'animation';

let nextId = 1;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: true })!;
}

export class Layer {
  id = nextId++;
  name: string;
  kind: LayerKind;
  canvas: HTMLCanvasElement;
  opacity = 1;
  blend: BlendMode = 'normal';
  visible = true;
  locked = false;
  /** When on, painting only changes pixels that already have paint (keeps transparent areas transparent). */
  alphaLock = false;
  /** Bumped whenever pixels change - used for thumbnail caching. */
  version = 0;

  // Image layers keep the original so adjustments are non-destructive.
  source?: HTMLCanvasElement;
  adjustments?: Adjustments;

  // Animation layers (rotoscoping): one canvas ("cel") per frame index.
  frames?: Map<number, HTMLCanvasElement>;
  currentFrame = 0;

  // Video layers
  video?: HTMLVideoElement;

  constructor(name: string, w: number, h: number, kind: LayerKind = 'paint') {
    this.name = name;
    this.kind = kind;
    this.canvas = makeCanvas(w, h);
    ctx2d(this.canvas);
  }

  get ctx(): CanvasRenderingContext2D { return ctx2d(this.canvas); }

  get editable(): boolean { return !this.locked && this.kind !== 'video'; }

  /** For animation layers: switch to the cel for the given frame, creating it on demand. */
  setFrame(frame: number, w: number, h: number): void {
    if (!this.frames) return;
    this.currentFrame = frame;
    let c = this.frames.get(frame);
    if (!c) { c = makeCanvas(w, h); ctx2d(c); this.frames.set(frame, c); }
    this.canvas = c;
    this.version++;
  }

  static nextName(existing: Layer[], base = 'Layer'): string {
    let n = existing.length + 1;
    const names = new Set(existing.map((l) => l.name));
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }
}
