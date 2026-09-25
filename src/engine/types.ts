import type { RGB } from '../core/color';
import type { Layer } from '../core/layer';
import type { PaintDocument } from '../core/document';
import type { Rect } from '../core/geom';
import type { BrushMode } from './brush';

/** One brush stamp, in document pixels. Colour is LINEAR sRGB. */
export interface Dab {
  x: number;
  y: number;
  r: number;
  angle: number; // radians
  roundness: number;
  hardness: number;
  flow: number;
  color: RGB;
  strand: number; // symmetry copy index; each has its own paint reservoir
  seed: number;
  first: boolean; // first dab of the strand (reservoir initialises from canvas)
}

export interface StrokeParams {
  mode: BrushMode;
  opacity: number;
  wetness: number;
  viscosity: number;
  pickup: number;
  load: number;
  transparency: number;
  wetEdge: number;
  impasto: number;
  grain: number;
  grainScale: number;
  bristles: number;
  tip: number; // 0 round, 1 flat, 2 filbert, 3 fan, 4 texture
  settle: number;
  spectral: boolean;
  alphaLock: boolean;
  /** Stroke seed for bristle pattern. */
  seed: number;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
  rotation: number; // radians
}

export interface RenderOptions {
  view: View;
  width: number; // css px
  height: number;
  dpr: number;
  showPaper: boolean;
  pixelGrid: boolean;
  /** Layers hidden temporarily (e.g. floating selection preview). */
  exclude?: Set<number>;
}

export interface CommitInfo {
  layer: Layer;
  rect: Rect;
  before: ImageData;
  label: string;
}

export interface PaintBackend {
  readonly kind: 'webgpu' | 'canvas2d';
  readonly label: string;
  /** The on-screen canvas the backend draws into. */
  readonly canvas: HTMLCanvasElement;
  setDocument(doc: PaintDocument): void;
  beginStroke(layer: Layer, params: StrokeParams, selection: Uint8Array | null, label: string): void;
  addDabs(dabs: Dab[]): void;
  /** Pen lifted. Paint keeps flowing for params.settle ms then commits. */
  endStroke(): void;
  /** Settle any flowing paint immediately and wait until layer canvases are up to date. */
  flush(): Promise<void>;
  readonly stroking: boolean;
  setTipImage(img: ImageData | null): void;
  render(opts: RenderOptions): void;
  /** Request continuous animation (wet paint flowing). */
  readonly animating: boolean;
  onCommit: (c: CommitInfo) => void;
  onChange: () => void;
  destroy(): void;
}

export function tipIndex(t: string): number {
  return ({ round: 0, flat: 1, filbert: 2, fan: 3, texture: 4 } as Record<string, number>)[t] ?? 0;
}
