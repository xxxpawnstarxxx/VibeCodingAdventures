// WebGPU backend: liquid paint simulation in compute shaders + GPU layer compositing.
//
// Frame flow while painting:
//   for each queued dab: cs_sample (reservoir pickup, 1 workgroup) -> cs_deposit (dab footprint)
//   cs_flow x2 (red/black relaxation of water + pigment) while the paint is wet
//   cs_composite (layer + wet paint -> strokeTex, dirty rect only)
//   compose passes (background + every layer with blend modes, scissored to the dirty rect)
//   screen pass (pan / zoom / rotate, checkerboard, pixel grid)
// On commit, strokeTex is copied into the layer texture and read back into the layer's canvas.
import type { PaintDocument } from '../../core/document';
import type { Layer } from '../../core/layer';
import { BLEND_INDEX } from '../../core/layer';
import type { Rect } from '../../core/geom';
import { rectUnion } from '../../core/geom';
import type { CommitInfo, Dab, PaintBackend, RenderOptions, StrokeParams } from '../types';
import { COMPOSE, PAINT, SCREEN } from './shaders';

const SLOT = 256;
const MAX_SLOTS = 4096;
const WS: [number, number, number, number] = [0.13, 0.135, 0.15, 1];

interface LayerGpu { tex: GPUTexture; w: number; h: number }

interface StrokeState {
  layer: Layer;
  params: StrokeParams;
  label: string;
  bind: GPUBindGroup;
  bbox: Rect | null;
  frameDirty: Rect | null;
  lifted: boolean;
  settleLeft: number;
  lastT: number;
  canvas: HTMLCanvasElement;
}

export class GpuBackend implements PaintBackend {
  readonly kind = 'webgpu' as const;
  readonly label: string;
  readonly canvas: HTMLCanvasElement;
  private ctx: GPUCanvasContext;
  private format: GPUTextureFormat;
  private doc!: PaintDocument;
  private layers = new Map<number, LayerGpu>();
  private strokeTex!: GPUTexture;
  private accA!: GPUTexture;
  private accB!: GPUTexture;
  private compTex!: GPUTexture;
  private maskTex!: GPUTexture;
  private dummyMask: GPUTexture;
  private tipTex: GPUTexture;
  private hasTip = false;
  private wet!: GPUBuffer;
  private wetOrigin = { x: 0, y: 0 };
  private wetSize = { w: 0, h: 0 };
  private res: GPUBuffer;
  private strokeU: GPUBuffer;
  private passU: GPUBuffer;
  private layerU: GPUBuffer;
  private screenU: GPUBuffer;
  private passData = new ArrayBuffer(SLOT * MAX_SLOTS);
  private passSlots = 0;
  private layerData = new ArrayBuffer(SLOT * 256);
  private pipes!: { sample: GPUComputePipeline; deposit: GPUComputePipeline; flow: GPUComputePipeline; composite: GPUComputePipeline; clear: GPUComputePipeline };
  private paintLayout!: GPUBindGroupLayout;
  private composePipe!: GPURenderPipeline;
  private composeLayout!: GPUBindGroupLayout;
  private screenPipe!: GPURenderPipeline;
  private screenBind: GPUBindGroup | null = null;
  private sampLinear: GPUSampler;
  private queue: Dab[] = [];
  private stroke: StrokeState | null = null;
  private composeDirty: Rect | null = null;
  private pending: Promise<void> = Promise.resolve();
  private suppress = false;
  private exclude = new Set<number>();
  onCommit: (c: CommitInfo) => void = () => {};
  onChange: () => void = () => {};

  static async create(): Promise<GpuBackend | null> {
    if (!('gpu' in navigator) || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const limits: Record<string, number> = {};
    limits.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
    limits.maxBufferSize = adapter.limits.maxBufferSize;
    limits.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
    const device = await adapter.requestDevice({ requiredLimits: limits });
    const info = (adapter as any).info as GPUAdapterInfo | undefined;
    return new GpuBackend(device, info ? [info.vendor, info.architecture].filter(Boolean).join(' ') : '');
  }

  constructor(private device: GPUDevice, adapterName: string) {
    this.label = 'WebGPU' + (adapterName ? ` (${adapterName})` : '');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'paint-surface';
    this.ctx = this.canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    device.lost.then((i) => console.error('WebGPU device lost:', i.message));
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));

    const U = GPUBufferUsage;
    this.res = device.createBuffer({ size: 64 * 2 * 16, usage: U.STORAGE | U.COPY_DST });
    this.strokeU = device.createBuffer({ size: 112, usage: U.UNIFORM | U.COPY_DST });
    this.passU = device.createBuffer({ size: SLOT * MAX_SLOTS, usage: U.UNIFORM | U.COPY_DST });
    this.layerU = device.createBuffer({ size: SLOT * 256, usage: U.UNIFORM | U.COPY_DST });
    this.screenU = device.createBuffer({ size: 64, usage: U.UNIFORM | U.COPY_DST });
    this.dummyMask = this.tex2d(1, 1, 'r8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: this.dummyMask }, new Uint8Array([255]), { bytesPerRow: 256 }, [1, 1]);
    this.tipTex = this.tex2d(1, 1, 'r8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.sampLinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.buildPipelines();
  }

  private tex2d(w: number, h: number, format: GPUTextureFormat, usage: number): GPUTexture {
    return this.device.createTexture({ size: [Math.max(1, w), Math.max(1, h)], format, usage });
  }

  private buildPipelines(): void {
    const d = this.device;
    const paintMod = d.createShaderModule({ code: PAINT, label: 'paint' });
    const S = GPUShaderStage.COMPUTE;
    this.paintLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S, buffer: { type: 'uniform' } },
        { binding: 1, visibility: S, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 } },
        { binding: 2, visibility: S, buffer: { type: 'storage' } },
        { binding: 3, visibility: S, texture: { sampleType: 'float' } },
        { binding: 4, visibility: S, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 5, visibility: S, texture: { sampleType: 'float' } },
        { binding: 6, visibility: S, texture: { sampleType: 'float' } },
        { binding: 7, visibility: S, buffer: { type: 'storage' } },
      ],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.paintLayout] });
    const cp = (entryPoint: string) => d.createComputePipeline({ layout, compute: { module: paintMod, entryPoint } });
    this.pipes = { sample: cp('cs_sample'), deposit: cp('cs_deposit'), flow: cp('cs_flow'), composite: cp('cs_composite'), clear: cp('cs_clear') };

    const F = GPUShaderStage.FRAGMENT;
    this.composeLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float' } },
      ],
    });
    const compMod = d.createShaderModule({ code: COMPOSE, label: 'compose' });
    this.composePipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.composeLayout] }),
      vertex: { module: compMod, entryPoint: 'vs' },
      fragment: { module: compMod, entryPoint: 'fs_layer', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const scrMod = d.createShaderModule({ code: SCREEN, label: 'screen' });
    this.screenPipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: scrMod, entryPoint: 'vs' },
      fragment: { module: scrMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ------------------------------------------------------------------------ document / textures
  setDocument(doc: PaintDocument): void {
    this.doc = doc;
    this.allocDoc();
    doc.events.on('pixels', ({ layer, rect }) => {
      if (this.suppress) return;
      this.upload(layer, rect);
    });
    doc.events.on('structure', () => { this.syncLayers(); this.markAll(); });
    doc.events.on('background', () => this.markAll());
    doc.events.on('selection', () => this.uploadMask());
    doc.events.on('resize', () => { this.allocDoc(); });
  }

  private markAll() { this.composeDirty = { x: 0, y: 0, w: this.doc.width, h: this.doc.height }; this.onChange(); }

  private allocDoc(): void {
    const { width: W, height: H } = this.doc;
    const T = GPUTextureUsage;
    for (const l of this.layers.values()) l.tex.destroy();
    this.layers.clear();
    this.strokeTex?.destroy(); this.accA?.destroy(); this.accB?.destroy(); this.compTex?.destroy(); this.maskTex?.destroy(); this.wet?.destroy();
    this.strokeTex = this.tex2d(W, H, 'rgba8unorm', T.STORAGE_BINDING | T.TEXTURE_BINDING | T.COPY_SRC | T.COPY_DST);
    this.accA = this.tex2d(W, H, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC);
    this.accB = this.tex2d(W, H, 'rgba16float', T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC);
    this.compTex = this.tex2d(W, H, 'rgba16float', T.TEXTURE_BINDING | T.COPY_DST);
    this.maskTex = this.tex2d(W, H, 'r8unorm', T.TEXTURE_BINDING | T.COPY_DST);
    // Wet buffer: whole document when the GPU allows it, otherwise a window placed at stroke start.
    const maxBytes = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize, 512 * 1024 * 1024);
    const maxPx = Math.floor(maxBytes / 12);
    let ww = W, wh = H;
    if (ww * wh > maxPx) { const s = Math.sqrt(maxPx / (ww * wh)); ww = Math.floor(ww * s); wh = Math.floor(wh * s); }
    this.wetSize = { w: ww, h: wh };
    this.wetOrigin = { x: 0, y: 0 };
    this.wet = this.device.createBuffer({ size: ww * wh * 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.screenBind = null;
    this.syncLayers();
    for (const l of this.doc.layers) this.upload(l, null);
    this.uploadMask();
    this.markAll();
  }

  private syncLayers(): void {
    const ids = new Set(this.doc.layers.map((l) => l.id));
    for (const [id, g] of this.layers) if (!ids.has(id)) { g.tex.destroy(); this.layers.delete(id); }
    for (const l of this.doc.layers) if (!this.layers.has(l.id)) this.upload(l, null);
  }

  private layerTex(l: Layer): GPUTexture {
    let g = this.layers.get(l.id);
    if (!g || g.w !== this.doc.width || g.h !== this.doc.height) {
      g?.tex.destroy();
      const T = GPUTextureUsage;
      g = { tex: this.tex2d(this.doc.width, this.doc.height, 'rgba8unorm', T.TEXTURE_BINDING | T.COPY_DST | T.COPY_SRC | T.RENDER_ATTACHMENT), w: this.doc.width, h: this.doc.height };
      this.layers.set(l.id, g);
      this.copyCanvas(l, g.tex, null);
    }
    return g.tex;
  }

  private copyCanvas(l: Layer, tex: GPUTexture, rect: Rect | null): void {
    const W = Math.min(this.doc.width, l.canvas.width), H = Math.min(this.doc.height, l.canvas.height);
    let r = rect ?? { x: 0, y: 0, w: W, h: H };
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const w = Math.min(W, Math.ceil(r.x + r.w)) - x, h = Math.min(H, Math.ceil(r.y + r.h)) - y;
    if (w <= 0 || h <= 0) return;
    this.device.queue.copyExternalImageToTexture(
      { source: l.canvas, origin: { x, y } },
      { texture: tex, origin: { x, y }, premultipliedAlpha: false },
      [w, h],
    );
  }

  private upload(l: Layer, rect: Rect | null): void {
    if (!this.doc.layers.includes(l)) return;
    const had = this.layers.has(l.id);
    const tex = this.layerTex(l);
    if (had) this.copyCanvas(l, tex, rect);
    this.composeDirty = rectUnion(this.composeDirty, rect ?? { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
    this.onChange();
  }

  private uploadMask(): void {
    const m = this.doc.selection.mask;
    if (!m) return;
    const W = this.doc.width, H = this.doc.height;
    const bpr = Math.ceil(W / 256) * 256;
    if (bpr === W) this.device.queue.writeTexture({ texture: this.maskTex }, m as Uint8Array<ArrayBuffer>, { bytesPerRow: W }, [W, H]);
    else {
      const padded = new Uint8Array(bpr * H);
      for (let y = 0; y < H; y++) padded.set(m.subarray(y * W, (y + 1) * W), y * bpr);
      this.device.queue.writeTexture({ texture: this.maskTex }, padded, { bytesPerRow: bpr }, [W, H]);
    }
  }

  setTipImage(img: ImageData | null): void {
    if (!img) { this.hasTip = false; return; }
    this.tipTex.destroy();
    this.tipTex = this.tex2d(img.width, img.height, 'r8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const bpr = Math.ceil(img.width / 256) * 256;
    const a = new Uint8Array(bpr * img.height);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) a[y * bpr + x] = img.data[(y * img.width + x) * 4 + 3];
    this.device.queue.writeTexture({ texture: this.tipTex }, a, { bytesPerRow: bpr }, [img.width, img.height]);
    this.hasTip = true;
  }

  // ------------------------------------------------------------------------ strokes
  get stroking() { return !!this.stroke; }
  get animating() { return !!this.stroke; }

  beginStroke(layer: Layer, params: StrokeParams, selection: Uint8Array | null, label: string): void {
    if (this.stroke) this.commit();
    const W = this.doc.width, H = this.doc.height;
    this.layerTex(layer);
    // If the wet buffer is smaller than the document, centre its window on the first dab later.
    this.wetOrigin = { x: 0, y: 0 };
    const hasMask = !!selection;
    const u = new ArrayBuffer(112);
    const i32 = new Int32Array(u), u32 = new Uint32Array(u), f32 = new Float32Array(u);
    i32[0] = W; i32[1] = H; i32[2] = 0; i32[3] = 0; i32[4] = this.wetSize.w; i32[5] = this.wetSize.h;
    u32[8] = ({ paint: 0, erase: 1, smudge: 2, blend: 3 } as const)[params.mode];
    u32[9] = params.tip; u32[10] = params.spectral ? 1 : 0; u32[11] = params.alphaLock ? 1 : 0;
    f32[12] = params.opacity; f32[13] = params.wetness; f32[14] = params.viscosity; f32[15] = params.pickup;
    f32[16] = params.load; f32[17] = params.transparency; f32[18] = params.wetEdge; f32[19] = params.impasto;
    f32[20] = params.grain; f32[21] = params.grainScale; f32[22] = params.bristles; f32[23] = 0.002;
    u32[24] = params.seed >>> 0; u32[25] = hasMask ? 1 : 0; u32[26] = this.hasTip ? 1 : 0;
    this.device.queue.writeBuffer(this.strokeU, 0, u);
    this.device.queue.writeBuffer(this.res, 0, new Float32Array(64 * 2 * 4));
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: this.layerTex(layer) }, { texture: this.strokeTex }, [W, H]);
    this.device.queue.submit([enc.finish()]);
    const bind = this.device.createBindGroup({
      layout: this.paintLayout,
      entries: [
        { binding: 0, resource: { buffer: this.strokeU } },
        { binding: 1, resource: { buffer: this.passU, size: 80 } },
        { binding: 2, resource: { buffer: this.wet } },
        { binding: 3, resource: this.layerTex(layer).createView() },
        { binding: 4, resource: this.strokeTex.createView() },
        { binding: 5, resource: (hasMask ? this.maskTex : this.dummyMask).createView() },
        { binding: 6, resource: this.tipTex.createView() },
        { binding: 7, resource: { buffer: this.res } },
      ],
    });
    this.stroke = { layer, params, label, bind, bbox: null, frameDirty: null, lifted: false, settleLeft: 0, lastT: performance.now(), canvas: layer.canvas };
    this.queue = [];
  }

  addDabs(dabs: Dab[]): void {
    if (!this.stroke) return;
    if (this.wetSize.w < this.doc.width || this.wetSize.h < this.doc.height) {
      if (!this.stroke.bbox && dabs.length) {
        const d = dabs[0];
        this.wetOrigin = {
          x: Math.max(0, Math.min(this.doc.width - this.wetSize.w, Math.round(d.x - this.wetSize.w / 2))),
          y: Math.max(0, Math.min(this.doc.height - this.wetSize.h, Math.round(d.y - this.wetSize.h / 2))),
        };
        this.device.queue.writeBuffer(this.strokeU, 8, new Int32Array([this.wetOrigin.x, this.wetOrigin.y]));
      }
    }
    for (const d of dabs) {
      this.queue.push(d);
      const ext = d.r * (this.stroke.params.tip === 1 || this.stroke.params.tip === 4 ? 1.5 : 1) + 2;
      const r = { x: Math.floor(d.x - ext), y: Math.floor(d.y - ext), w: Math.ceil(ext * 2) + 1, h: Math.ceil(ext * 2) + 1 };
      this.stroke.bbox = rectUnion(this.stroke.bbox, r);
      this.stroke.frameDirty = rectUnion(this.stroke.frameDirty, r);
    }
    this.onChange();
  }

  endStroke(): void {
    const s = this.stroke;
    if (!s || s.lifted) return;
    s.lifted = true;
    s.settleLeft = s.params.wetness > 0.01 && s.params.mode === 'paint' ? s.params.settle : 0;
    this.onChange();
  }

  async flush(): Promise<void> {
    if (this.stroke) this.commit();
    await this.pending;
  }

  private clip(r: Rect): Rect | null {
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    const w = Math.min(this.doc.width, r.x + r.w) - x, h = Math.min(this.doc.height, r.y + r.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  private slot(r: Rect, extra?: (f32: Float32Array, u32: Uint32Array) => void, parity = 0): number {
    if (this.passSlots >= MAX_SLOTS) return -1;
    const off = this.passSlots++ * SLOT;
    const i32 = new Int32Array(this.passData, off, 20), u32 = new Uint32Array(this.passData, off, 20), f32 = new Float32Array(this.passData, off, 20);
    i32[0] = r.x; i32[1] = r.y; i32[2] = r.x + r.w - 1; i32[3] = r.y + r.h - 1;
    u32[4] = parity;
    extra?.(f32, u32);
    return off;
  }

  private dispatchRect(pass: GPUComputePassEncoder, pipe: GPUComputePipeline, bind: GPUBindGroup, off: number, r: Rect) {
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind, [off]);
    pass.dispatchWorkgroups(Math.ceil(r.w / 8), Math.ceil(r.h / 8));
  }

  /** Encode simulation work for this frame into enc. Returns the rect whose preview changed. */
  private simulate(enc: GPUCommandEncoder): Rect | null {
    const s = this.stroke!;
    const now = performance.now();
    const dt = Math.min(64, now - s.lastT);
    s.lastT = now;
    let evap = 0.002;
    if (s.lifted) {
      evap = s.settleLeft > 0 ? Math.min(1, dt / Math.max(16, s.settleLeft)) : 1;
      s.settleLeft -= dt;
    }
    this.device.queue.writeBuffer(this.strokeU, 23 * 4, new Float32Array([evap]));
    const pass = enc.beginComputePass();
    // dabs
    while (this.queue.length && this.passSlots < MAX_SLOTS - 16) {
      const d = this.queue.shift()!;
      const ext = d.r * (s.params.tip === 1 || s.params.tip === 4 ? 1.5 : 1) + 2;
      const r = this.clip({ x: Math.floor(d.x - ext), y: Math.floor(d.y - ext), w: Math.ceil(ext * 2) + 1, h: Math.ceil(ext * 2) + 1 });
      const off = this.slot(r ?? { x: 0, y: 0, w: 1, h: 1 }, (f, u) => {
        u[5] = d.strand % 64; u[6] = d.first ? 1 : 0;
        f[8] = d.x; f[9] = d.y; f[10] = d.r; f[11] = d.angle; f[12] = d.roundness; f[13] = d.hardness; f[14] = d.flow;
        f[16] = d.color[0]; f[17] = d.color[1]; f[18] = d.color[2]; f[19] = 1;
      });
      if (off < 0) break;
      if (s.params.mode !== 'erase') {
        pass.setPipeline(this.pipes.sample);
        pass.setBindGroup(0, s.bind, [off]);
        pass.dispatchWorkgroups(1);
      }
      if (r) this.dispatchRect(pass, this.pipes.deposit, s.bind, off, r);
    }
    let dirty = s.frameDirty;
    s.frameDirty = null;
    // flow
    const flowing = s.params.mode === 'paint' && s.params.wetness > 0.01 && s.params.viscosity < 0.995 && s.bbox;
    if (flowing) {
      // let very wet paint creep outward a little each frame
      s.bbox = { x: s.bbox!.x - 1, y: s.bbox!.y - 1, w: s.bbox!.w + 2, h: s.bbox!.h + 2 };
      const r = this.clip(s.bbox!);
      if (r) {
        for (let it = 0; it < 2; it++) {
          for (let parity = 0; parity < 2; parity++) {
            const off = this.slot(r, undefined, parity);
            if (off >= 0) this.dispatchRect(pass, this.pipes.flow, s.bind, off, r);
          }
        }
        dirty = rectUnion(dirty, r);
      }
    }
    if (dirty) {
      const r = this.clip(dirty);
      if (r) {
        const off = this.slot(r);
        if (off >= 0) this.dispatchRect(pass, this.pipes.composite, s.bind, off, r);
      }
      dirty = r;
    }
    pass.end();
    return dirty;
  }

  /** Copy the stroke result into the layer and read it back to the CPU canvas. */
  private commit(): void {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    const bbox = s.bbox ? this.clip(s.bbox) : null;
    const enc = this.device.createCommandEncoder();
    this.passSlots = 0;
    // finish pending dabs + final composite
    if (this.queue.length || bbox) {
      this.stroke = s;
      s.lifted = true; s.settleLeft = 0;
      s.frameDirty = bbox;
      this.simulate(enc);
      this.stroke = null;
    }
    this.queue = [];
    if (!bbox) { this.flushPassData(); this.device.queue.submit([enc.finish()]); return; }
    const layerTex = this.layerTex(s.layer);
    enc.copyTextureToTexture({ texture: this.strokeTex, origin: { x: bbox.x, y: bbox.y } }, { texture: layerTex, origin: { x: bbox.x, y: bbox.y } }, [bbox.w, bbox.h]);
    const bpr = Math.ceil((bbox.w * 4) / 256) * 256;
    const rb = this.device.createBuffer({ size: bpr * bbox.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: layerTex, origin: { x: bbox.x, y: bbox.y } }, { buffer: rb, bytesPerRow: bpr }, [bbox.w, bbox.h]);
    // clear the wet buffer for the next stroke
    const cp = enc.beginComputePass();
    const clearR = { x: bbox.x - 2, y: bbox.y - 2, w: bbox.w + 4, h: bbox.h + 4 };
    const off = this.slot(clearR);
    if (off >= 0) this.dispatchRect(cp, this.pipes.clear, s.bind, off, clearR);
    cp.end();
    this.flushPassData();
    this.device.queue.submit([enc.finish()]);
    this.composeDirty = rectUnion(this.composeDirty, bbox);
    const layer = s.layer;
    const target = s.canvas;
    this.pending = this.pending.then(async () => {
      await rb.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(rb.getMappedRange());
      const img = new ImageData(bbox.w, bbox.h);
      for (let y = 0; y < bbox.h; y++) img.data.set(src.subarray(y * bpr, y * bpr + bbox.w * 4), y * bbox.w * 4);
      rb.unmap(); rb.destroy();
      const ctx = target.getContext('2d', { willReadFrequently: true })!;
      const before = ctx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
      ctx.putImageData(img, bbox.x, bbox.y);
      this.suppress = true;
      try { this.doc.markDirty(layer, bbox); } finally { this.suppress = false; }
      this.onCommit({ layer, rect: bbox, before, label: s.label });
    });
    this.onChange();
  }

  private flushPassData(): void {
    if (this.passSlots > 0) this.device.queue.writeBuffer(this.passU, 0, this.passData, 0, this.passSlots * SLOT);
    this.passSlots = 0;
  }

  // ------------------------------------------------------------------------ rendering
  render(o: RenderOptions): void {
    const d = this.device;
    const dpr = o.dpr;
    const W = Math.max(1, Math.round(o.width * dpr)), H = Math.max(1, Math.round(o.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const exKey = [...(o.exclude ?? [])].join(',');
    if (exKey !== [...this.exclude].join(',')) { this.exclude = new Set(o.exclude ?? []); this.markAll(); }
    this.passSlots = 0;
    const enc = d.createCommandEncoder();
    if (this.stroke) {
      const r = this.simulate(enc);
      if (r) this.composeDirty = rectUnion(this.composeDirty, r);
      if (this.stroke.lifted && this.stroke.settleLeft <= 0 && !this.queue.length) {
        this.flushPassData();
        d.queue.submit([enc.finish()]);
        this.commit();
        this.render(o);
        return;
      }
    }
    this.flushPassData();
    if (this.composeDirty) {
      const r = this.clip({ x: Math.floor(this.composeDirty.x), y: Math.floor(this.composeDirty.y), w: Math.ceil(this.composeDirty.w) + 1, h: Math.ceil(this.composeDirty.h) + 1 });
      this.composeDirty = null;
      if (r) this.compose(enc, r, o.showPaper);
    }
    // screen
    const tex = this.ctx.getCurrentTexture();
    const v = o.view;
    const k = v.zoom * dpr;
    const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
    const a = c / k, b = -s / k, cc = s / k, dd = c / k;
    const tx = v.x * dpr, ty = v.y * dpr;
    const u = new Float32Array(16);
    u.set([a, b, cc, dd, -(a * tx + cc * ty), -(b * tx + dd * ty), k, this.doc.background.transparent ? 1 : 0, this.doc.width, this.doc.height, o.pixelGrid ? 1 : 0, 0, ...WS]);
    d.queue.writeBuffer(this.screenU, 0, u);
    if (!this.screenBind) {
      this.screenBind = d.createBindGroup({
        layout: this.screenPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.screenU } },
          { binding: 1, resource: this.compTex.createView() },
          { binding: 2, resource: this.sampLinear },
        ],
      });
    }
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: WS[0], g: WS[1], b: WS[2], a: 1 } }] });
    rp.setPipeline(this.screenPipe);
    rp.setBindGroup(0, this.screenBind);
    rp.draw(3);
    rp.end();
    d.queue.submit([enc.finish()]);
  }

  private compose(enc: GPUCommandEncoder, r: Rect, showPaper: boolean): void {
    const d = this.device;
    const doc = this.doc;
    const layers = doc.layers.filter((l) => l.visible && l.opacity > 0 && !this.exclude.has(l.id));
    const f32 = new Float32Array(this.layerData), u32 = new Uint32Array(this.layerData);
    // slot 0: background
    const bg = doc.background;
    f32[0] = 1; u32[1] = 0; u32[2] = 1; f32[3] = showPaper ? bg.paper : 0;
    f32.set([...bg.color, bg.transparent ? 0 : 1], 4);
    layers.forEach((l, i) => {
      const o = ((i + 1) * SLOT) / 4;
      if (i + 1 >= 256) return;
      f32[o] = l.opacity; u32[o + 1] = BLEND_INDEX[l.blend]; u32[o + 2] = 0; f32[o + 3] = 0;
    });
    d.queue.writeBuffer(this.layerU, 0, this.layerData, 0, (Math.min(255, layers.length) + 1) * SLOT);
    let src = this.accB, dst = this.accA;
    const pass = (texIn: GPUTexture, layerTexture: GPUTexture, slotIdx: number, target: GPUTexture) => {
      const bind = d.createBindGroup({
        layout: this.composeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.layerU, size: 32 } },
          { binding: 1, resource: texIn.createView() },
          { binding: 2, resource: layerTexture.createView() },
        ],
      });
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'load', storeOp: 'store' }] });
      rp.setPipeline(this.composePipe);
      rp.setBindGroup(0, bind, [slotIdx * SLOT]);
      rp.setScissorRect(r.x, r.y, r.w, r.h);
      rp.draw(3);
      rp.end();
    };
    pass(src, this.dummyTexFor(), 0, dst);
    layers.slice(0, 255).forEach((l, i) => {
      [src, dst] = [dst, src];
      const lt = this.stroke && this.stroke.layer === l ? this.strokeTex : this.layerTex(l);
      pass(src, lt, i + 1, dst);
    });
    enc.copyTextureToTexture({ texture: dst, origin: { x: r.x, y: r.y } }, { texture: this.compTex, origin: { x: r.x, y: r.y } }, [r.w, r.h]);
  }

  private dummy: GPUTexture | null = null;
  private dummyTexFor(): GPUTexture {
    if (!this.dummy) this.dummy = this.tex2d(1, 1, 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING);
    return this.dummy;
  }

  destroy(): void { this.device.destroy(); this.canvas.remove(); }
}
