// Brush definitions: every property a non-painter might want, with human descriptions for tooltips.

export type BrushMode = 'paint' | 'erase' | 'smudge' | 'blend';
export type TipShape = 'round' | 'flat' | 'filbert' | 'fan' | 'texture';
export type ColorMode = 'solid' | 'rainbow' | 'gradient' | 'jitter';
export type AngleMode = 'fixed' | 'direction' | 'tilt';

export interface BrushSettings {
  id: string;
  name: string;
  description: string;
  category: 'Paint' | 'Dry' | 'Ink' | 'Blend' | 'Eraser' | 'Fun' | 'Custom';
  custom?: boolean;
  mode: BrushMode;
  size: number;
  minSize: number;
  opacity: number;
  flow: number;
  hardness: number;
  spacing: number;
  roundness: number;
  angle: number;
  angleMode: AngleMode;
  tip: TipShape;
  tipImage?: string;
  bristles: number;
  grain: number;
  grainScale: number;
  scatter: number;
  sizeJitter: number;
  angleJitter: number;
  pressureSize: boolean;
  pressureFlow: boolean;
  wetness: number;
  viscosity: number;
  pickup: number;
  load: number;
  transparency: number;
  wetEdge: number;
  impasto: number;
  settle: number;
  colorMode: ColorMode;
  rainbowSpeed: number;
  hueJitter: number;
  satJitter: number;
  valJitter: number;
}

/** Metadata for building the brush editor + tooltips. */
export const BRUSH_FIELDS: {
  key: keyof BrushSettings; label: string; group: string; tip: string;
  min?: number; max?: number; step?: number; unit?: string; percent?: boolean;
  options?: { value: string; label: string }[];
}[] = [
  { key: 'size', label: 'Size', group: 'Shape', tip: 'Brush diameter in pixels. Shortcut: [ and ].', min: 1, max: 600, step: 1, unit: 'px' },
  { key: 'minSize', label: 'Light-pressure size', group: 'Shape', tip: 'How thin the stroke gets when you press lightly with a pen. 100% = pressure does not change size.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'hardness', label: 'Edge hardness', group: 'Shape', tip: 'Soft = fuzzy airbrush edge. Hard = crisp edge like a pen.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'roundness', label: 'Roundness', group: 'Shape', tip: 'Squash the tip into an oval or flat chisel shape.', min: 0.05, max: 1, step: 0.01, percent: true },
  { key: 'angle', label: 'Tip angle', group: 'Shape', tip: 'Rotation of a non-round tip (degrees).', min: 0, max: 180, step: 1, unit: '°' },
  { key: 'angleMode', label: 'Tip follows', group: 'Shape', tip: 'Whether a flat tip keeps a fixed angle, turns with your stroke like a real brush, or follows pen tilt.', options: [{ value: 'fixed', label: 'Fixed angle' }, { value: 'direction', label: 'Stroke direction' }, { value: 'tilt', label: 'Pen tilt' }] },
  { key: 'tip', label: 'Tip shape', group: 'Shape', tip: 'The footprint of the brush.', options: [{ value: 'round', label: 'Round' }, { value: 'flat', label: 'Flat' }, { value: 'filbert', label: 'Filbert (oval)' }, { value: 'fan', label: 'Fan (bristles)' }, { value: 'texture', label: 'Custom image' }] },
  { key: 'spacing', label: 'Spacing', group: 'Shape', tip: 'Distance between brush stamps as a fraction of size. Small = smooth; large = dotted.', min: 0.02, max: 2, step: 0.01, percent: true },
  { key: 'opacity', label: 'Opacity', group: 'Paint', tip: 'Maximum coverage of a single stroke. Lower = see-through.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'flow', label: 'Flow', group: 'Paint', tip: 'How quickly paint builds up while you drag. Low flow lets you build colour gently.', min: 0.01, max: 1, step: 0.01, percent: true },
  { key: 'pressureSize', label: 'Pressure → size', group: 'Paint', tip: 'Pressing harder with a pen makes the stroke thicker.' },
  { key: 'pressureFlow', label: 'Pressure → flow', group: 'Paint', tip: 'Pressing harder with a pen puts down more paint.' },
  { key: 'wetness', label: 'Wetness (water)', group: 'Liquid', tip: 'How much water is in the paint. Wet paint flows, softens and blends with itself.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'viscosity', label: 'Thickness (viscosity)', group: 'Liquid', tip: 'Runny like watercolour (low) or thick like oil / honey (high). Thick paint does not spread.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'pickup', label: 'Colour mixing', group: 'Liquid', tip: 'How much the brush picks up colours already on the canvas and mixes them in, like a real wet brush.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'load', label: 'Paint refill', group: 'Liquid', tip: 'How quickly the brush re-loads clean paint. Lower = picked-up colours are dragged further along the stroke.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'transparency', label: 'Glaze (transparency)', group: 'Liquid', tip: 'Opaque paint covers (gouache, oil). Glazing paint tints like stained glass (watercolour, ink): layers darken and mix.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'wetEdge', label: 'Wet edges', group: 'Liquid', tip: 'Pigment gathers at the edge of wet strokes, making the soft dark rim of real watercolour.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'settle', label: 'Flow time', group: 'Liquid', tip: 'How long (ms) paint keeps flowing after you lift the pen before it settles. 0 = settles instantly. Paint never dries in a way that blocks you.', min: 0, max: 3000, step: 50, unit: 'ms' },
  { key: 'impasto', label: 'Impasto (thick relief)', group: 'Liquid', tip: 'Adds light and shadow to thick paint so strokes look raised, like oil paint.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'bristles', label: 'Bristle streaks', group: 'Texture', tip: 'Fine lines left by individual bristles.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'grain', label: 'Paper grain', group: 'Texture', tip: 'Paint catches on the paper texture, like pencil, chalk or dry brush.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'grainScale', label: 'Grain size', group: 'Texture', tip: 'Size of the paper texture.', min: 0.2, max: 4, step: 0.05, unit: '×' },
  { key: 'scatter', label: 'Scatter', group: 'Texture', tip: 'Randomly spreads stamps sideways - good for foliage, sparkles, spray.', min: 0, max: 3, step: 0.01, percent: true },
  { key: 'sizeJitter', label: 'Size jitter', group: 'Texture', tip: 'Random size variation per stamp.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'angleJitter', label: 'Angle jitter', group: 'Texture', tip: 'Random rotation per stamp.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'colorMode', label: 'Colour mode', group: 'Colour', tip: 'Solid colour, rainbow that cycles as you paint, a gradient from main to second colour, or random variations.', options: [{ value: 'solid', label: 'Solid' }, { value: 'rainbow', label: 'Rainbow' }, { value: 'gradient', label: 'Main → second colour' }, { value: 'jitter', label: 'Random variation' }] },
  { key: 'rainbowSpeed', label: 'Rainbow / gradient length', group: 'Colour', tip: 'How fast the rainbow cycles (hue degrees per 100 px). For gradient mode: how long until the second colour is reached.', min: 1, max: 360, step: 1, unit: '°' },
  { key: 'hueJitter', label: 'Hue variation', group: 'Colour', tip: 'Random hue changes per stamp (for Random variation mode, or added on top).', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'satJitter', label: 'Saturation variation', group: 'Colour', tip: 'Random saturation changes per stamp.', min: 0, max: 1, step: 0.01, percent: true },
  { key: 'valJitter', label: 'Brightness variation', group: 'Colour', tip: 'Random brightness changes per stamp.', min: 0, max: 1, step: 0.01, percent: true },
];

const base: BrushSettings = {
  id: 'base', name: 'Base', description: '', category: 'Paint', mode: 'paint',
  size: 30, minSize: 0.25, opacity: 1, flow: 0.6, hardness: 0.6, spacing: 0.12, roundness: 1, angle: 0,
  angleMode: 'fixed', tip: 'round', bristles: 0, grain: 0, grainScale: 1, scatter: 0, sizeJitter: 0, angleJitter: 0,
  pressureSize: true, pressureFlow: true, wetness: 0.3, viscosity: 0.5, pickup: 0.3, load: 0.8, transparency: 0,
  wetEdge: 0, impasto: 0, settle: 0, colorMode: 'solid', rainbowSpeed: 40, hueJitter: 0, satJitter: 0, valJitter: 0,
};

const p = (o: Partial<BrushSettings> & Pick<BrushSettings, 'id' | 'name' | 'description' | 'category'>): BrushSettings => ({ ...base, ...o });

export const PRESETS: BrushSettings[] = [
  p({ id: 'watercolor', name: 'Watercolour', category: 'Paint', description: 'Transparent, runny paint that blends softly and forms gentle darker edges. Layers glaze like real watercolour.', size: 48, hardness: 0.45, flow: 0.45, wetness: 0.85, viscosity: 0.12, pickup: 0.45, load: 0.7, transparency: 0.85, wetEdge: 0.7, settle: 900, grain: 0.1, minSize: 0.4, opacity: 0.8 }),
  p({ id: 'wash', name: 'Watercolour wash', category: 'Paint', description: 'A big, very wet brush for skies and backgrounds. Spreads out and softens by itself.', size: 140, hardness: 0.1, flow: 0.35, wetness: 1, viscosity: 0.02, pickup: 0.55, load: 0.6, transparency: 0.9, wetEdge: 0.45, settle: 1200, grain: 0.15, opacity: 0.6, minSize: 0.6 }),
  p({ id: 'oil', name: 'Oil paint', category: 'Paint', description: 'Thick, buttery, opaque paint with bristle marks and raised relief. Mixes with wet colour under it.', size: 36, hardness: 0.75, flow: 0.8, wetness: 0.2, viscosity: 0.9, pickup: 0.55, load: 0.45, transparency: 0, bristles: 0.55, impasto: 0.5, roundness: 0.8, angleMode: 'direction', tip: 'filbert', minSize: 0.45, spacing: 0.08 }),
  p({ id: 'gouache', name: 'Gouache / acrylic', category: 'Paint', description: 'Flat, matte, opaque colour that covers cleanly. Great for illustration and poster styles.', size: 32, hardness: 0.8, flow: 0.75, wetness: 0.25, viscosity: 0.6, pickup: 0.2, load: 0.9, transparency: 0, bristles: 0.12, minSize: 0.35 }),
  p({ id: 'flat', name: 'Flat brush', category: 'Paint', description: 'Wide chisel brush that turns with your stroke: thick one way, thin the other. Good for blocky shapes.', size: 44, hardness: 0.85, flow: 0.8, wetness: 0.2, viscosity: 0.8, pickup: 0.45, load: 0.6, tip: 'flat', roundness: 0.28, angleMode: 'direction', bristles: 0.45, impasto: 0.3, spacing: 0.06 }),
  p({ id: 'fan', name: 'Fan brush', category: 'Paint', description: 'Spread bristles for grass, hair, fur and foliage texture.', size: 50, hardness: 0.7, flow: 0.55, wetness: 0.2, viscosity: 0.75, pickup: 0.35, load: 0.7, tip: 'fan', roundness: 0.35, angleMode: 'direction', bristles: 0.9, spacing: 0.05 }),
  p({ id: 'airbrush', name: 'Airbrush', category: 'Paint', description: 'Very soft spray for smooth shading and glows. Builds up gradually.', size: 110, hardness: 0, flow: 0.12, wetness: 0, viscosity: 1, pickup: 0, load: 1, transparency: 0, pressureSize: false, minSize: 1, spacing: 0.08 }),
  p({ id: 'pencil', name: 'Pencil', category: 'Dry', description: 'Thin grainy lines for sketching. Press harder for darker lines.', size: 5, hardness: 0.9, flow: 0.7, opacity: 0.9, wetness: 0, viscosity: 1, pickup: 0, load: 1, grain: 0.75, grainScale: 0.6, minSize: 0.5, spacing: 0.1 }),
  p({ id: 'chalk', name: 'Chalk pastel', category: 'Dry', description: 'Dusty, textured, opaque colour that catches on the paper grain.', size: 36, hardness: 0.7, flow: 0.65, wetness: 0, viscosity: 1, pickup: 0.15, load: 1, grain: 0.85, grainScale: 1.4, roundness: 0.7, angleMode: 'direction', minSize: 0.5 }),
  p({ id: 'drybrush', name: 'Dry brush', category: 'Dry', description: 'Scratchy broken strokes, like a brush with almost no paint left.', size: 40, hardness: 0.8, flow: 0.7, wetness: 0, viscosity: 1, pickup: 0.2, load: 0.8, bristles: 0.8, grain: 0.7, grainScale: 1.8, tip: 'flat', roundness: 0.4, angleMode: 'direction' }),
  p({ id: 'ink', name: 'Ink pen', category: 'Ink', description: 'Smooth, crisp line art. Thickness follows pen pressure. No mixing.', size: 8, hardness: 0.97, flow: 1, wetness: 0, viscosity: 1, pickup: 0, load: 1, transparency: 0, minSize: 0.15, spacing: 0.06 }),
  p({ id: 'brushpen', name: 'Brush pen', category: 'Ink', description: 'Expressive ink brush with tapered lines and a slightly wet feel.', size: 16, hardness: 0.85, flow: 0.95, wetness: 0.25, viscosity: 0.7, pickup: 0.05, load: 1, transparency: 0.6, minSize: 0.05, spacing: 0.05, wetEdge: 0.2, settle: 150 }),
  p({ id: 'marker', name: 'Marker', category: 'Ink', description: 'Even, slightly see-through colour that darkens where strokes overlap - like alcohol markers.', size: 24, hardness: 0.85, flow: 0.9, opacity: 0.6, wetness: 0.1, viscosity: 0.9, pickup: 0, load: 1, transparency: 1, pressureSize: false, minSize: 1, tip: 'flat', roundness: 0.55, angle: 45 }),
  p({ id: 'smudge', name: 'Smudge', category: 'Blend', description: 'Drags existing paint along like a finger through wet paint.', mode: 'smudge', size: 40, hardness: 0.4, flow: 0.8, pickup: 0.9, load: 0, wetness: 0, spacing: 0.06, minSize: 0.6, pressureSize: false }),
  p({ id: 'blender', name: 'Soft blender', category: 'Blend', description: 'Softly melts colours together without moving them far. Great for smooth skin and skies.', mode: 'blend', size: 60, hardness: 0.1, flow: 0.35, pickup: 0.6, load: 0, wetness: 0, spacing: 0.08, pressureSize: false }),
  p({ id: 'knife', name: 'Palette knife', category: 'Blend', description: 'Flat blade that scrapes and smears paint in bold sharp-edged swipes.', mode: 'smudge', size: 60, hardness: 0.95, flow: 1, pickup: 0.95, load: 0, tip: 'flat', roundness: 0.18, angleMode: 'direction', spacing: 0.04, pressureSize: false, impasto: 0.4 }),
  p({ id: 'eraser', name: 'Eraser', category: 'Eraser', description: 'Removes paint. Soft edges.', mode: 'erase', size: 50, hardness: 0.5, flow: 0.9, opacity: 1, pressureSize: false, minSize: 1, wetness: 0 }),
  p({ id: 'eraser-hard', name: 'Hard eraser', category: 'Eraser', description: 'Removes paint with a crisp edge.', mode: 'erase', size: 20, hardness: 1, flow: 1, opacity: 1, pressureSize: false, minSize: 1, wetness: 0 }),
  p({ id: 'lift', name: 'Lift paint (sponge)', category: 'Eraser', description: 'Gently lifts some paint off, like dabbing wet watercolour with a tissue.', mode: 'erase', size: 70, hardness: 0.2, flow: 0.25, opacity: 0.5, pressureSize: false, minSize: 1, grain: 0.3 }),
  p({ id: 'rainbow', name: 'Rainbow ribbon', category: 'Fun', description: 'Cycles through every colour of the rainbow as you paint.', size: 26, hardness: 0.8, flow: 0.9, wetness: 0.3, viscosity: 0.5, pickup: 0.1, load: 1, colorMode: 'rainbow', rainbowSpeed: 30 }),
  p({ id: 'rainbow-water', name: 'Rainbow watercolour', category: 'Fun', description: 'Runny transparent rainbow paint that bleeds softly between colours.', size: 60, hardness: 0.3, flow: 0.5, wetness: 0.9, viscosity: 0.1, pickup: 0.4, load: 0.8, transparency: 0.8, wetEdge: 0.5, settle: 800, colorMode: 'rainbow', rainbowSpeed: 20 }),
  p({ id: 'sparkle', name: 'Sparkle spray', category: 'Fun', description: 'Scattered dots with colour variation - stars, snow, glitter, leaves.', size: 10, hardness: 0.9, flow: 1, wetness: 0, viscosity: 1, pickup: 0, load: 1, scatter: 2.5, sizeJitter: 0.8, spacing: 0.9, colorMode: 'jitter', hueJitter: 0.15, valJitter: 0.3, pressureSize: false }),
];

export function cloneBrush(b: BrushSettings): BrushSettings { return JSON.parse(JSON.stringify(b)); }

const LS_KEY = 'flowpaint.customBrushes';
export function loadCustomBrushes(): BrushSettings[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as BrushSettings[]).map((b) => ({ ...base, ...b, custom: true, category: 'Custom' as const }));
  } catch { return []; }
}
export function saveCustomBrushes(list: BrushSettings[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ }
}
export function normalizeBrush(b: Partial<BrushSettings>): BrushSettings { return { ...base, ...b } as BrushSettings; }
