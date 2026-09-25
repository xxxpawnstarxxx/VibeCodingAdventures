# Flowpaint Studio

A stylus-first 2D painting app with a real-time **liquid paint simulation**. Paint mixes, flows and
forms wet edges like real paint, but it never dries on you, never smudges by accident, and every step can
be undone. It's built with **TypeScript + Vite**, **WebGPU** compute shaders (with an automatic CPU
fallback), and **WebAssembly** image-processing kernels.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # rebuilds the WASM kernels, type-checks, bundles to dist/
```

For the full GPU simulation, use a browser with WebGPU (recent Chrome, Edge or Safari). Other browsers
get the same paint model on the CPU automatically. You can force it with `?backend=cpu`.

---

## What's in it

| Area | Features |
| --- | --- |
| **Liquid paint** | Wetness (water), thickness (viscosity), colour pickup and mixing, paint refill, glazing vs opaque paint, wet-edge darkening, watercolour granulation, adjustable flow time, impasto relief, bristle streaks, paper grain |
| **Colour mixing** | Spectral Kubelka–Munk pigment mixing (blue + yellow = green). You can switch it off for plain RGB. |
| **Brushes** | 22 presets: watercolour, wash, oil, gouache, flat, fan, airbrush, pencil, chalk, dry brush, ink, brush pen, marker, smudge, soft blender, palette knife, 3 erasers, rainbow ribbon, rainbow watercolour, sparkle spray |
| **Custom brushes** | Full brush editor with a live preview. Load a tip image, make a tip from a selection, or draw one. Save, import and export `.flowbrush.json` files. |
| **Rainbow and colour modes** | Solid, rainbow (hue cycles along the stroke), main→second-colour gradient along the stroke, random hue/saturation/brightness variation |
| **Stylus** | Pressure (with a curve and a test pad), tilt, coalesced high-rate events, palm rejection ("fingers only pan & zoom"), two-finger pinch/rotate |
| **Stabilizer** | Adaptive smoothing (one-euro filter) or pulled-string mode, predictive catch-up, and a line that finishes at the pen |
| **Assists** | Symmetry (left/right, top/bottom, 4-way, radial, kaleidoscope) with a draggable centre. Magnetic rulers and 1/2/3-point perspective that pull strokes straight but keep your hand-drawn wobble. Grid with snapping. |
| **Tools** | Brush, eraser, blend/smudge, fill bucket (tolerance, grow edge, look at all layers, rainbow fill), gradient (linear/radial/angle/mirror/diamond; perceptual, paint-like or RGB blending; dithered), colour picker with loupe, shapes (line, arrow, rectangle with rounded corners, ellipse, polygon, star; filled, outlined or brush-painted), select box/ellipse, freehand and polygon lasso, magic wand, move/scale/rotate/flip, crop with aspect presets, guides, hand, zoom |
| **Selections** | New, add, subtract and intersect, plus feather, grow/shrink, invert, and select layer content. Every tool and effect respects the selection. |
| **Layers** | Blend modes (17), opacity, lock, lock transparency, rename, drag to reorder, duplicate, merge, flatten. Photo layers stay adjustable. |
| **Sample pictures** | Built-in gallery: your two original paintings (gouache alpine meadow, watercolour mountain lake) plus still life, ocean sunset, night city, sunflowers and abstract shapes. Open as a painting, import as a layer, pin as a reference, or use as the source for Remake, palette extraction and ASCII art. |
| **Preset palettes** | 11 ready-made swatch palettes (including colours from the two sample paintings, classic limited palette, earth, pastel, sunset, ocean, forest, skin tones, greyscale values, neon). |
| **Import / export** | Open or drag & drop images, paste from the clipboard, `.flowpaint` projects (all layers, references and guides). Export PNG/JPEG/WebP at any scale, the current layer only, or the selection. Copy to clipboard. Autosave to IndexedDB. |
| **Photo adjustments** | Exposure, brightness, contrast, highlights, shadows, saturation, vibrance, hue, warmth, tint, mid-tones, black & white, sepia, invert, posterize, plus an Auto button. Adjustments stay non-destructive on photo layers. |
| **Remake a picture** | *Auto-paint* repaints an image stroke by stroke (impressionist, expressionist, pointillist, watercolour, sketch) as an animation. Also *colour block-in*, *value study*, *paint by numbers* (regions, numbers and a colour key) and *tracing setup* (faded photo, a colour contour guide and a grid). |
| **Palette extraction** | Dominant colours with the **% of the image** each one covers. Shown as a stacked bar and a list. Add them to your swatches or paint a palette card. |
| **ASCII art** | Coloured ASCII from any picture. Place it on the canvas, or save it as PNG, `.txt` or coloured `.html`. |
| **References** | Pin floating reference windows with zoom/pan, flip, greyscale value check, opacity, collapse, colour picking, and "place in painting". Pin a snapshot of the canvas. |
| **Rotoscoping** | Import a video, trace frame by frame on an animation layer (6–30 fps) with onion skinning (red = before, green = after). Copy the previous frame, play back, and export to video (with or without the footage) or a sprite sheet. |
| **Timelapse** | Records automatically. Replay it with a scrubber and export to MP4/WebM with a hold on the final image. |
| **Unlimited history** | A timeline panel with thumbnails, a scrubber and click-to-jump. Old steps are compacted to PNG blobs, so undo never runs out. |
| **Effects** | Film grain, paper texture, blur, sharpen, oil-paint look (Kuwahara), watercolour wash, pixelate, posterize, vignette, glow/bloom, chromatic aberration, halftone, emboss. All have live previews. |
| **Canvas** | Presets (screen, A5/A4/A3 at 150/300 dpi, Letter, postcard) or a custom size, plus an **infinite canvas** that grows as you paint near an edge. Canvas size with anchor, image size, crop, trim, rotate and flip, paper colour and texture. |
| **UI** | Built like a desktop app, not a website. Every tool and button has a **text label** and a **rich tooltip** (name, explanation and shortcut). There's a status-bar hint for the current tool, a quick-start guide and a shortcuts sheet. |

## AI / automation API

Everything can be driven from code. Every command lands in the normal undo history, just like a manual
edit.

```js
flowpaint.help();                                         // all commands + parameter docs
await flowpaint.run('newDocument', { preset: 'a4-150' });
await flowpaint.run('setColor', { color: '#1d4ed8' });
await flowpaint.run('stroke', { points: [[200,300,0.3],[500,260,1],[800,320,0.4]], brush: 'watercolor', size: 60 });
await flowpaint.run('remake', { mode: 'autopaint', src: 'https://…/photo.jpg', style: 'impressionist' });
const palette = await flowpaint.run('extractPalette', { count: 8 });   // [{hex, percent}]
const state   = await flowpaint.getState();                            // layers, brush, history…
const image   = await flowpaint.snapshot({ maxSize: 512 });            // JPEG data URL for vision models
await flowpaint.batch([{ command: 'addLayer', args: { name: 'Sky' } }, { command: 'gradient', args: { x0: 0, y0: 0, x1: 0, y1: 800 } }]);
```

It's also reachable from another frame or a browser extension through `postMessage`:
`{ type: 'flowpaint', id, command, args }` gets the reply `{ type: 'flowpaint-result', id, ok, result | error }`.
The in-app **Help → AI / automation API** console lists every command and can run them.

Commands include: `getState, newDocument, listTools, setTool, setColor, listBrushes, setBrush, stroke,
drawShape, fill, gradient, pickColor, addLayer, selectLayer, setLayer, deleteLayer, duplicateLayer, mergeDown,
moveLayer, select, clearSelectionPixels, listFilters, applyFilter, adjustImage, importImage, extractPalette,
asciiArt, remake, importVideo, animation, symmetry, stabilizer, guides, resizeCanvas, scaleImage, crop, undo,
redo, history, jumpHistory, listSamples, loadPalette, view, exportImage, snapshot, saveProject, loadProject, pinReference`.

## Architecture

```
src/
  main.ts               boot: WASM, backend (WebGPU → CPU fallback), UI shell, API
  app/                  app state, viewport (pan/zoom/rotate, pen input, overlay), undoable ops, shortcuts
  core/                 document & layers, selection masks, unlimited history, colour science
  engine/
    brush.ts            brush model + presets + field docs (drives the editor and tooltips)
    stroke.ts           input → stabilizer → magnetic guides → symmetry → spacing → dab dynamics
    paintModel.ts       the liquid paint model (CPU reference)
    cpuPainter.ts       tile-based CPU implementation (fallback + brush previews)
    canvasBackend.ts    CPU painting + Canvas2D compositing
    gpu/shaders.ts      WGSL: dab deposit, reservoir pickup, flow, composite, 17 blend modes, screen pass
    gpu/gpuBackend.ts   WebGPU resources, per-frame simulation, compositing, async readback/commit
  tools/                every tool (paint, fill, gradient, picker, shapes, selection, move, crop, guides…)
  features/             io, adjustments, filters, palette, ascii, remake, references, rotoscope, timelapse, brush editor
  ui/                   DOM helpers, icons, tooltips, controls, dialogs, menus, panels, shell
  api/agentApi.ts       automation API
wasm/assembly/          AssemblyScript kernels → src/wasm/imgproc.wasm
```

### The liquid paint model

Each pixel of the wet layer stores premultiplied pigment `P = (m·r, m·g, m·b, m)` in linear RGB, plus water `w`.

1. **Dabs** move `P` *toward* the brush reservoir colour. They don't add to it, with strength = footprint × flow.
   That keeps paint from piling up into mud or blowing out. The footprint includes the tip shape (round,
   flat superellipse, filbert, fan, or a custom image), hardness, smooth irregular bristle profiles, and paper
   grain.
2. **The reservoir** (one per symmetry strand) samples the canvas under each dab. On the GPU this is a
   64-thread workgroup reduction. The reservoir picks that colour up with spectral mixing and refills toward
   the loaded colour at the *refill* rate. That's how you get wet-into-wet blending, colour dragging,
   smudging and palette-knife smears.
3. **Flow** runs red-black relaxation over the stroke's bounding box. Wet neighbours exchange pigment,
   scaled by `(1 − viscosity)²`. Pigment drifts toward drier cells (the wet edge), and very wet runny paint
   bleeds a little into dry paper. Water evaporates over the brush's *flow time*, then the stroke settles
   and commits. Nothing keeps changing after that.
4. **Composite**: coverage = `opacity · (1 − e^{−3m})`. The result blends opaque covering (spectral
   Kubelka–Munk mix) with glazing, which acts as a multiplicative filter like watercolour. Then it applies
   granulation and wet-edge darkening (pigment density relative to its neighbourhood), plus impasto
   lighting from the pigment height field.

**Spectral mixing**: RGB is lifted to a 10-band reflectance curve with Smits' basis spectra. The two paints
are mixed per band using the Kubelka–Munk K/S ratio, then projected back through the minimum-norm inverse of
the basis, so unmixed colours round-trip exactly. Lightness is partly corrected in OKLab, because single-constant
K–M over-darkens tints.

The WebGPU backend runs all of this in compute shaders, using a packed-f16 wet buffer that's `read_write`
storage, and composites the layers on the GPU. When a stroke commits, the result is copied into the layer
texture and read back asynchronously into the layer's canvas. That canvas is the source of truth used for
history, export and CPU tools. The CPU backend runs the same model on lazily allocated 64-pixel tiles. Both
produce matching pixels.

### WebAssembly

`wasm/assembly/index.ts` (AssemblyScript) provides the heavy image kernels: scanline flood fill (fill and magic wand),
the 15-bit colour histogram (palette extraction), photo adjustments, the alpha-aware box/gaussian blur,
selection feathering, film grain, the Kuwahara filter and Sobel gradients (auto-paint stroke direction).
The compiled `src/wasm/imgproc.wasm` is committed, so `npm run dev` works right after `npm install`.
`npm run build:wasm` rebuilds it.

## Keyboard shortcuts

`B` brush · `E` eraser · `S` blend · `G` fill · `Shift+G` gradient · `I` picker · `U` shapes · `M` select · `L` lasso ·
`W` wand · `V` move · `C` crop · `K` guides · `H`/Space pan · `Z` zoom · hold `R` + drag rotates the view ·
`[` `]` size · `Shift+[` `]` hardness · `1–0` opacity · `X` swap colours · Shift+click draws a straight line ·
right-click or Alt+click picks a colour · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `,` `.` previous/next frame · `Tab` focus mode · `F1` help.
