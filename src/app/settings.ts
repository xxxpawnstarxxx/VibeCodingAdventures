import type { GuideSettings, StabilizerSettings, SymmetrySettings } from '../engine/stroke';

export interface Settings {
  stabilizer: StabilizerSettings;
  symmetry: SymmetrySettings;
  guides: GuideSettings;
  /** Exponent applied to pen pressure: <1 = softer (light touch gives more), >1 = firmer. */
  pressureGamma: number;
  /** Spectral (real pigment) mixing vs plain RGB. */
  spectral: boolean;
  showPaper: boolean;
  pixelGrid: boolean;
  /** Ignore touch for drawing; fingers pan/zoom (palm rejection). */
  penOnlyDrawing: boolean;
  showBrushCursor: boolean;
  timelapse: boolean;
  autosave: boolean;
  swatches: string[];
  recent: string[];
  uiScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  stabilizer: { mode: 'smooth', strength: 25, predictive: true, catchUp: true },
  symmetry: { mode: 'off', count: 6, mirror: true, cx: 0, cy: 0 },
  guides: { enabled: false, magnet: 0.85, rulers: [], perspective: [], gridSnap: false, gridSize: 64, showGrid: false },
  pressureGamma: 1,
  spectral: true,
  showPaper: true,
  pixelGrid: true,
  penOnlyDrawing: false,
  showBrushCursor: true,
  timelapse: true,
  autosave: true,
  swatches: [
    '#1b1b1f', '#ffffff', '#7d7d85', '#e3342f', '#f6993f', '#ffed4a', '#38c172', '#4dc0b5', '#3490dc', '#6574cd',
    '#9561e2', '#f66d9b', '#8b5a2b', '#e8c39e', '#2d4a22', '#1d3557', '#c9184a', '#ffb703', '#023047', '#f4a261',
  ],
  recent: [],
  uiScale: 1,
};

const KEY = 'flowpaint.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS), ...s,
      stabilizer: { ...DEFAULT_SETTINGS.stabilizer, ...s.stabilizer },
      symmetry: { ...DEFAULT_SETTINGS.symmetry, ...s.symmetry },
      guides: { ...DEFAULT_SETTINGS.guides, ...s.guides },
    };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
