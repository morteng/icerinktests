/**
 * SpriteStudioRenderer — standalone GPU renderer for isolated sprite preview.
 * Reuses the same isometric shader pipeline with dummy buffers for scene data.
 * Supports both offscreen render (data URL) and live canvas rendering.
 */

import isoCommon from './shaders/iso_common.wgsl?raw';
import isoSky from './shaders/iso_sky.wgsl?raw';
import isoLighting from './shaders/iso_lighting.wgsl?raw';
import isoSprites from './shaders/iso_sprites.wgsl?raw';
import isoMesh from './shaders/iso_mesh.wgsl?raw';

import { Camera } from './camera';
import { SPRITE_BUFFER_SIZE, MAX_SPRITES } from './sprites';
import { getOrCreateAtlas, getOrCreateHeightAtlas, createAtlasTexture, createAtlasSampler } from './spriteSheet';

const shaderSource = isoCommon + '\n' + isoSky + '\n' + isoLighting + '\n' + isoSprites + '\n' + isoMesh;

const CAMERA_PARAMS_SIZE = 224;
const RENDER_PARAMS_SIZE = 496;

// Virtual grid size for sprite preview
const GRID_W = 8;
const GRID_H = 8;

export interface RenderSpriteOptions {
  spriteType: number;        // 1-16
  team?: number;             // 0-15
  direction: number;         // radians
  frame?: number;            // 0-3
  width?: number;            // canvas px (default 256)
  height?: number;           // canvas px (default 384)
  sunAzimuth?: number;       // radians
  sunElevation?: number;     // radians
  sunColor?: [number, number, number];
  skyColor?: [number, number, number];
  skyBrightness?: number;
  exposure?: number;
  cameraAzimuth?: number;    // radians
  cameraElevation?: number;  // radians
  cameraDistance?: number;
  seed?: number;             // per-sprite tint (0-1)
  heightScale?: number;
  background?: 'transparent' | 'checkerboard' | 'ice' | 'sky';
}

export class SpriteStudioRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Lazily initialized
  private pipeline: GPURenderPipeline | null = null;
  private skyPipeline: GPURenderPipeline | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private spriteBuffer: GPUBuffer | null = null;
  private dummyStateBuffer: GPUBuffer | null = null;
  private dummyMarkingsBuffer: GPUBuffer | null = null;
  private dummyEnvMapBuffer: GPUBuffer | null = null;
  private dummyMaskBuffer: GPUBuffer | null = null;
  private dummyState2Buffer: GPUBuffer | null = null;
  private dummySolidsBuffer: GPUBuffer | null = null;
  private atlasTexture: GPUTexture | null = null;
  private heightAtlasTexture: GPUTexture | null = null;
  private atlasSampler: GPUSampler | null = null;
  private dummyReflectionTexture: GPUTexture | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private camera: Camera | null = null;

  // Offscreen render target
  private offscreenTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private offscreenW = 0;
  private offscreenH = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  private ensureInitialized() {
    if (this.pipeline) return;

    const device = this.device;

    this.camera = new Camera(GRID_W, GRID_H);
    this.camera.setPreset('oblique');

    this.cameraBuffer = device.createBuffer({
      size: CAMERA_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.paramsBuffer = device.createBuffer({
      size: RENDER_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.spriteBuffer = device.createBuffer({
      size: SPRITE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Dummy state buffer: one cell with cold ice
    // vec4f per cell: (temp, ice_mm, water_mm, shavings_mm)
    const stateData = new Float32Array(GRID_W * GRID_H * 4);
    for (let i = 0; i < GRID_W * GRID_H; i++) {
      stateData[i * 4 + 0] = -4.0;  // temperature
      stateData[i * 4 + 1] = 10.0;  // ice_mm
      stateData[i * 4 + 2] = 0.0;   // water_mm
      stateData[i * 4 + 3] = 0.0;   // shavings_mm
    }
    this.dummyStateBuffer = device.createBuffer({
      size: stateData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyStateBuffer, 0, stateData);

    // Dummy markings (all zero)
    const markingsData = new Float32Array(GRID_W * GRID_H);
    this.dummyMarkingsBuffer = device.createBuffer({
      size: markingsData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyMarkingsBuffer, 0, markingsData);

    // Dummy env map (1024×512 vec4f is huge — use minimal)
    // The shader accesses env_map with ENV_W=1024, ENV_H=512
    // We need at least 1024*512 vec4f = 2M floats — too large for a dummy.
    // Instead provide a small buffer; the sprite pipeline doesn't sample env_map.
    const envMapData = new Float32Array(1024 * 512 * 4);
    for (let i = 0; i < envMapData.length; i += 4) {
      envMapData[i] = 0.1;    // R
      envMapData[i + 1] = 0.1; // G
      envMapData[i + 2] = 0.15; // B
      envMapData[i + 3] = 1.0; // A
    }
    this.dummyEnvMapBuffer = device.createBuffer({
      size: envMapData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyEnvMapBuffer, 0, envMapData);

    // Dummy mask (all 1.0 = inside rink)
    const maskData = new Float32Array(GRID_W * GRID_H);
    maskData.fill(1.0);
    this.dummyMaskBuffer = device.createBuffer({
      size: maskData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyMaskBuffer, 0, maskData);

    // Dummy state2 (all zero)
    const state2Data = new Float32Array(GRID_W * GRID_H * 4);
    this.dummyState2Buffer = device.createBuffer({
      size: state2Data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummyState2Buffer, 0, state2Data);

    // Dummy solids (all zero)
    const solidsData = new Float32Array(GRID_W * GRID_H);
    this.dummySolidsBuffer = device.createBuffer({
      size: solidsData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.dummySolidsBuffer, 0, solidsData);

    // Atlas textures
    const atlasCanvas = getOrCreateAtlas();
    this.atlasTexture = createAtlasTexture(device, atlasCanvas);
    const heightCanvas = getOrCreateHeightAtlas();
    this.heightAtlasTexture = createAtlasTexture(device, heightCanvas);
    this.atlasSampler = createAtlasSampler(device);

    // Dummy reflection texture (1x1 transparent — sprite studio doesn't need ice reflections)
    this.dummyReflectionTexture = device.createTexture({
      size: [1, 1],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const module = device.createShaderModule({ code: shaderSource });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 7, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Sprite pipeline (alpha blending)
    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_sprite' },
      fragment: {
        module,
        entryPoint: 'fs_sprite',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // Sky pipeline for background
    this.skyPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_sky' },
      fragment: {
        module,
        entryPoint: 'fs_sky',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    });

    this.rebuildBindGroup();
  }

  private rebuildBindGroup() {
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer! } },
        { binding: 1, resource: { buffer: this.paramsBuffer! } },
        { binding: 2, resource: { buffer: this.dummyStateBuffer! } },
        { binding: 3, resource: { buffer: this.dummyMarkingsBuffer! } },
        { binding: 4, resource: { buffer: this.dummyEnvMapBuffer! } },
        { binding: 5, resource: { buffer: this.dummyMaskBuffer! } },
        { binding: 6, resource: { buffer: this.dummyState2Buffer! } },
        { binding: 7, resource: { buffer: this.dummySolidsBuffer! } },
        { binding: 8, resource: { buffer: this.spriteBuffer! } },
        { binding: 9, resource: this.atlasTexture!.createView() },
        { binding: 10, resource: this.atlasSampler! },
        { binding: 11, resource: this.heightAtlasTexture!.createView() },
        { binding: 12, resource: this.dummyReflectionTexture!.createView() },
      ],
    });
  }

  /** Update atlas textures after injection. Recreates if dimensions changed. */
  refreshAtlasTextures(colorCanvas: HTMLCanvasElement, heightCanvas: HTMLCanvasElement) {
    if (!this.atlasTexture) return;

    const needsResize =
      colorCanvas.width !== this.atlasTexture.width ||
      colorCanvas.height !== this.atlasTexture.height;

    if (needsResize) {
      this.atlasTexture.destroy();
      this.heightAtlasTexture!.destroy();
      this.atlasTexture = createAtlasTexture(this.device, colorCanvas);
      this.heightAtlasTexture = createAtlasTexture(this.device, heightCanvas);
      this.rebuildBindGroup();
    } else {
      this.device.queue.copyExternalImageToTexture(
        { source: colorCanvas },
        { texture: this.atlasTexture },
        [colorCanvas.width, colorCanvas.height],
      );
      this.device.queue.copyExternalImageToTexture(
        { source: heightCanvas },
        { texture: this.heightAtlasTexture! },
        [heightCanvas.width, heightCanvas.height],
      );
    }
  }

  private writeParams(opts: RenderSpriteOptions) {
    const sunAz = opts.sunAzimuth ?? 1.0;
    const sunEl = opts.sunElevation ?? 0.7;
    const sunColor = opts.sunColor ?? [1.0, 0.95, 0.85];
    const skyColor = opts.skyColor ?? [0.4, 0.5, 0.7];
    const skyBrightness = opts.skyBrightness ?? 0.8;
    const exposure = opts.exposure ?? 1.2;

    // Sun direction from azimuth + elevation
    const cosEl = Math.cos(sunEl);
    const sunDirX = Math.cos(sunAz) * cosEl;
    const sunDirY = Math.sin(sunEl);
    const sunDirZ = Math.sin(sunAz) * cosEl;

    // Camera params
    const camAz = opts.cameraAzimuth ?? 0.6;
    const camEl = opts.cameraElevation ?? 0.5;
    const camDist = opts.cameraDistance ?? 12;

    this.camera!.setAzimuth(camAz);
    this.camera!.setElevation(camEl);
    this.camera!.setDistance(camDist);

    const w = opts.width ?? 256;
    const h = opts.height ?? 384;
    this.camera!.update(w, h);

    // Write camera buffer
    const camData = new ArrayBuffer(CAMERA_PARAMS_SIZE);
    const camF32 = new Float32Array(camData);
    camF32.set(this.camera!.getViewMatrix(), 0);
    camF32.set(this.camera!.getProjectionMatrix(), 16);
    camF32.set(this.camera!.getInverseViewProjection(), 32);
    const [cx, cy, cz] = this.camera!.getPosition();
    camF32[48] = cx; camF32[49] = cy; camF32[50] = cz;
    const [brx, bry, brz] = this.camera!.getBillboardRight();
    camF32[52] = brx; camF32[53] = bry; camF32[54] = brz;
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, camData);

    // Write render params
    const data = new ArrayBuffer(RENDER_PARAMS_SIZE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);

    u32[0] = GRID_W;
    u32[1] = GRID_H;
    u32[2] = 0; // no markings
    u32[3] = 1; // outdoor flag (for sky rendering)
    f32[4] = 0.15; f32[5] = 0.15; f32[6] = 0.18; // ground color
    f32[7] = 0.08; // cell size
    f32[8] = sunDirX; f32[9] = sunDirY; f32[10] = sunDirZ;
    f32[11] = 0.5; // time of day
    f32[12] = sunColor[0]; f32[13] = sunColor[1]; f32[14] = sunColor[2];
    f32[15] = skyBrightness;
    f32[16] = skyColor[0]; f32[17] = skyColor[1]; f32[18] = skyColor[2];
    f32[19] = 0.0; // fog density
    f32[20] = 0.0; // cloud cover
    f32[21] = 0.0; // anim time
    u32[22] = 0; // no lights
    f32[23] = exposure;

    this.device.queue.writeBuffer(this.paramsBuffer!, 0, data);

    // Write sprite buffer with single sprite at center
    const spriteData = new ArrayBuffer(SPRITE_BUFFER_SIZE);
    const sF32 = new Float32Array(spriteData);
    const sU32 = new Uint32Array(spriteData);

    // Header: sprite count = 1
    sU32[0] = 1;

    // Sprite at slot 0 (header is 4 u32s)
    const base = 4;
    sF32[base + 0] = GRID_W / 2;  // x
    sF32[base + 1] = GRID_H / 2;  // y
    sF32[base + 2] = opts.direction; // dir (radians)
    const type = opts.spriteType & 0xF;
    const team = (opts.team ?? 0) & 0xF;
    sU32[base + 3] = type | (team << 4); // info
    sF32[base + 4] = 0; // width (auto from type)
    sF32[base + 5] = opts.heightScale ?? 1.0; // height scale
    const frame = (opts.frame ?? 0) / 4; // normalize to 0-1 phase
    sF32[base + 6] = frame; // aux0 = animation phase
    sF32[base + 7] = opts.seed ?? 0.5; // aux1 = tint seed

    this.device.queue.writeBuffer(this.spriteBuffer!, 0, spriteData);
  }

  private ensureOffscreen(w: number, h: number) {
    if (this.offscreenW === w && this.offscreenH === h && this.offscreenTexture) return;

    this.offscreenTexture?.destroy();
    this.depthTexture?.destroy();

    this.offscreenW = w;
    this.offscreenH = h;

    this.offscreenTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private renderInternal(textureView: GPUTextureView, depthView: GPUTextureView, opts: RenderSpriteOptions, w: number, h: number) {
    this.ensureInitialized();
    this.writeParams(opts);

    const bg = opts.background ?? 'sky';

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: bg === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 }
          : bg === 'checkerboard' ? { r: 0.12, g: 0.12, b: 0.16, a: 1 }
          : bg === 'ice' ? { r: 0.85, g: 0.9, b: 0.95, a: 1 }
          : { r: 0.02, g: 0.02, b: 0.04, a: 1 },
      }],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'clear' as GPULoadOp,
        depthStoreOp: 'store' as GPUStoreOp,
        depthClearValue: 1.0,
      },
    });

    // Draw sky if background=sky
    if (bg === 'sky') {
      pass.setPipeline(this.skyPipeline!);
      pass.setBindGroup(0, this.bindGroup!);
      pass.draw(6);
    }

    // Draw sprite billboard
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(MAX_SPRITES * 6);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  /** Render sprite to a canvas (live preview). */
  renderToCanvas(canvas: HTMLCanvasElement, opts: RenderSpriteOptions) {
    this.ensureInitialized();

    const w = opts.width ?? 256;
    const h = opts.height ?? 384;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    // Ensure WebGPU context
    let gpuCtx = canvas.getContext('webgpu') as GPUCanvasContext;
    if (!gpuCtx) return;
    gpuCtx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    const textureView = gpuCtx.getCurrentTexture().createView();

    // Depth texture
    this.ensureOffscreen(w, h);
    const depthView = this.depthTexture!.createView();

    this.renderInternal(textureView, depthView, opts, w, h);
  }

  /** Render sprite offscreen and return PNG data URL. */
  async renderSprite(opts: RenderSpriteOptions): Promise<string> {
    this.ensureInitialized();

    const w = opts.width ?? 256;
    const h = opts.height ?? 384;

    this.ensureOffscreen(w, h);
    const textureView = this.offscreenTexture!.createView();
    const depthView = this.depthTexture!.createView();

    this.renderInternal(textureView, depthView, opts, w, h);

    // Read back pixels
    const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
    const readbackBuffer = this.device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const copyEncoder = this.device.createCommandEncoder();
    copyEncoder.copyTextureToBuffer(
      { texture: this.offscreenTexture! },
      { buffer: readbackBuffer, bytesPerRow },
      [w, h],
    );
    this.device.queue.submit([copyEncoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(readbackBuffer.getMappedRange());

    // Convert to canvas for PNG export
    const canvas2d = document.createElement('canvas');
    canvas2d.width = w;
    canvas2d.height = h;
    const ctx = canvas2d.getContext('2d')!;
    const imgData = ctx.createImageData(w, h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = y * bytesPerRow + x * 4;
        const dstIdx = (y * w + x) * 4;
        // BGRA -> RGBA (WebGPU may use bgra8unorm)
        if (this.format === 'bgra8unorm') {
          imgData.data[dstIdx + 0] = data[srcIdx + 2]; // R from B
          imgData.data[dstIdx + 1] = data[srcIdx + 1]; // G
          imgData.data[dstIdx + 2] = data[srcIdx + 0]; // B from R
        } else {
          imgData.data[dstIdx + 0] = data[srcIdx + 0];
          imgData.data[dstIdx + 1] = data[srcIdx + 1];
          imgData.data[dstIdx + 2] = data[srcIdx + 2];
        }
        imgData.data[dstIdx + 3] = data[srcIdx + 3]; // A
      }
    }

    readbackBuffer.unmap();
    readbackBuffer.destroy();

    ctx.putImageData(imgData, 0, 0);
    return canvas2d.toDataURL('image/png');
  }

  dispose() {
    this.cameraBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.spriteBuffer?.destroy();
    this.dummyStateBuffer?.destroy();
    this.dummyMarkingsBuffer?.destroy();
    this.dummyEnvMapBuffer?.destroy();
    this.dummyMaskBuffer?.destroy();
    this.dummyState2Buffer?.destroy();
    this.dummySolidsBuffer?.destroy();
    this.atlasTexture?.destroy();
    this.heightAtlasTexture?.destroy();
    this.dummyReflectionTexture?.destroy();
    this.offscreenTexture?.destroy();
    this.depthTexture?.destroy();
    this.pipeline = null;
  }
}
