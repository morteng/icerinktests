import isoCommon from './shaders/iso_common.wgsl?raw';
import isoSky from './shaders/iso_sky.wgsl?raw';
import isoLighting from './shaders/iso_lighting.wgsl?raw';
import isoSprites from './shaders/iso_sprites.wgsl?raw';
import isoMesh from './shaders/iso_mesh.wgsl?raw';

const shaderIsometric = isoCommon + '\n' + isoSky + '\n' + isoLighting + '\n' + isoSprites + '\n' + isoMesh;
import { Camera } from './camera';
import { RinkConfig } from './rink';
import { Simulation } from './simulation';
import { RenderOptions } from './renderer';
import { SPRITE_BUFFER_SIZE, MAX_SPRITES } from './sprites';
import { getOrCreateAtlas, getOrCreateHeightAtlas, createAtlasTexture, createAtlasSampler } from './spriteSheet';

// mat4x4 (64) + mat4x4 (64) + mat4x4 (64) + vec3 (12) + pad (4) + vec3 (12) + pad (4) = 224
const CAMERA_PARAMS_SIZE = 224;
// Params layout: 24 scalars (96 bytes) + 12 lights × 32 bytes (384) + surround(12)+contrast(4)+sat(4)+arena(28)+pad(4) = 544 bytes
const RENDER_PARAMS_SIZE = 544;

export class IsometricRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private meshPipeline: GPURenderPipeline;
  private skyPipeline: GPURenderPipeline;
  private spritePipeline: GPURenderPipeline;
  private cameraBuffer: GPUBuffer;
  private paramsBuffer: GPUBuffer;
  private spriteBuffer: GPUBuffer;
  private atlasTexture: GPUTexture;
  private heightAtlasTexture: GPUTexture;
  private atlasSampler: GPUSampler;
  private bindGroups!: [GPUBindGroup, GPUBindGroup];
  private bindGroupLayout!: GPUBindGroupLayout;
  // Stored for bind group rebuilds (atlas texture resize)
  private stateBuffers!: [GPUBuffer, GPUBuffer];
  private state2Buffers!: [GPUBuffer, GPUBuffer];
  private markingsBuffer!: GPUBuffer;
  private envMapBuffer!: GPUBuffer;
  private maskBuffer!: GPUBuffer;
  private solidsBuffer!: GPUBuffer;
  private depthTexture: GPUTexture;
  private depthView: GPUTextureView;
  private depthW = 0;
  private depthH = 0;
  // Reflection pass textures (sprites rendered to offscreen for ice reflections)
  private reflectionTexture: GPUTexture;
  private reflectionView: GPUTextureView;
  private reflectionDepth: GPUTexture;
  private reflectionDepthView: GPUTextureView;
  private reflW = 0;
  private reflH = 0;
  // 1x1 dummy texture used in reflection pass bind group to avoid texture usage conflict
  private dummyReflTex: GPUTexture;
  // Separate bind groups for reflection pass (uses dummy tex at binding 12)
  private reflBindGroups!: [GPUBindGroup, GPUBindGroup];
  private gridW: number;
  private gridH: number;
  private vertexCount: number;
  private cellSize: number;
  public camera: Camera;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    config: RinkConfig,
    simulation: Simulation,
    markingsBuffer: GPUBuffer,
    envMapBuffer: GPUBuffer,
    maskBuffer: GPUBuffer,
    solidsBuffer: GPUBuffer,
    private scratchBuffer: GPUBuffer,
  ) {
    this.device = device;
    this.format = format;
    this.gridW = config.gridW;
    this.gridH = config.gridH;
    this.cellSize = config.cellSize;

    this.camera = new Camera(config.gridW, config.gridH);
    this.camera.setPreset('oblique');

    // Calculate vertex count (6 per quad, subsample to stay under ~300k vertices)
    const maxQuads = 50000;
    let subsample = 1;
    for (let s = 2; s <= 16; s++) {
      if (Math.floor(config.gridW / s) * Math.floor(config.gridH / s) < maxQuads) {
        subsample = s;
        break;
      }
    }
    const quadsW = Math.floor(config.gridW / subsample);
    const quadsH = Math.floor(config.gridH / subsample);
    this.vertexCount = quadsW * quadsH * 6;

    this.cameraBuffer = device.createBuffer({
      size: CAMERA_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.paramsBuffer = device.createBuffer({
      size: RENDER_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Sprite buffer (same format as 2D renderer)
    this.spriteBuffer = device.createBuffer({
      size: SPRITE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Sprite atlas textures (color + height)
    const atlasCanvas = getOrCreateAtlas();
    this.atlasTexture = createAtlasTexture(device, atlasCanvas);
    const heightCanvas = getOrCreateHeightAtlas();
    this.heightAtlasTexture = createAtlasTexture(device, heightCanvas);
    this.atlasSampler = createAtlasSampler(device);

    // Initial depth texture
    this.depthW = config.gridW;
    this.depthH = config.gridH;
    this.depthTexture = device.createTexture({
      size: [this.depthW, this.depthH],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // Reflection pass textures (sprites rendered offscreen for ice reflections)
    this.reflW = config.gridW;
    this.reflH = config.gridH;
    this.reflectionTexture = device.createTexture({
      size: [this.reflW, this.reflH],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.reflectionView = this.reflectionTexture.createView();
    this.reflectionDepth = device.createTexture({
      size: [this.reflW, this.reflH],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.reflectionDepthView = this.reflectionDepth.createView();

    const module = device.createShaderModule({ code: shaderIsometric });

    // Explicit bind group layout shared between mesh, sky, and sprite pipelines
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
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    // Mesh pipeline (depth write enabled, depth compare less)
    this.meshPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_iso' },
      fragment: {
        module,
        entryPoint: 'fs_iso',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // Sky pipeline (no depth write, depth compare less-equal so sky renders at max depth)
    this.skyPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_sky' },
      fragment: {
        module,
        entryPoint: 'fs_sky',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    });

    // Sprite pipeline (alpha blending, depth write+test, no cull)
    this.spritePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_sprite' },
      fragment: {
        module,
        entryPoint: 'fs_sprite',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // Store buffer references for bind group rebuilds
    this.stateBuffers = simulation.temperatureBuffers as [GPUBuffer, GPUBuffer];
    this.state2Buffers = simulation.state2BufferPair as [GPUBuffer, GPUBuffer];
    this.markingsBuffer = markingsBuffer;
    this.envMapBuffer = envMapBuffer;
    this.maskBuffer = maskBuffer;
    this.solidsBuffer = solidsBuffer;

    // Dummy 1x1 texture used in reflection pass bind groups (avoids texture usage conflict)
    this.dummyReflTex = device.createTexture({
      size: [1, 1],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    this.rebuildBindGroups();
  }

  private rebuildBindGroups() {
    const [bufA, bufB] = this.stateBuffers;
    const [s2A, s2B] = this.state2Buffers;
    const heightView = this.heightAtlasTexture.createView();
    const reflView = this.reflectionTexture.createView();
    const dummyReflView = this.dummyReflTex.createView();

    const makeEntries = (stateBuf: GPUBuffer, s2Buf: GPUBuffer, reflTex: GPUTextureView) => [
      { binding: 0, resource: { buffer: this.cameraBuffer } },
      { binding: 1, resource: { buffer: this.paramsBuffer } },
      { binding: 2, resource: { buffer: stateBuf } },
      { binding: 3, resource: { buffer: this.markingsBuffer } },
      { binding: 4, resource: { buffer: this.envMapBuffer } },
      { binding: 5, resource: { buffer: this.maskBuffer } },
      { binding: 6, resource: { buffer: s2Buf } },
      { binding: 7, resource: { buffer: this.solidsBuffer } },
      { binding: 8, resource: { buffer: this.spriteBuffer } },
      { binding: 9, resource: this.atlasTexture.createView() },
      { binding: 10, resource: this.atlasSampler },
      { binding: 11, resource: heightView },
      { binding: 12, resource: reflTex },
      { binding: 13, resource: { buffer: this.scratchBuffer } },
    ];

    // Main pass bind groups (use actual reflection texture for ice reflections)
    this.bindGroups = [
      this.device.createBindGroup({ layout: this.bindGroupLayout, entries: makeEntries(bufA, s2A, reflView) }),
      this.device.createBindGroup({ layout: this.bindGroupLayout, entries: makeEntries(bufB, s2B, reflView) }),
    ];

    // Reflection pass bind groups (use dummy texture at binding 12 to avoid conflict
    // with reflection texture being used as render target in the same pass)
    this.reflBindGroups = [
      this.device.createBindGroup({ layout: this.bindGroupLayout, entries: makeEntries(bufA, s2A, dummyReflView) }),
      this.device.createBindGroup({ layout: this.bindGroupLayout, entries: makeEntries(bufB, s2B, dummyReflView) }),
    ];
  }

  updateSprites(data: Float32Array) {
    this.device.queue.writeBuffer(this.spriteBuffer, 0, data);
  }

  /** Update atlas textures from canvas data (after sprite injection).
   *  Recreates textures + bind groups if canvas dimensions changed. */
  refreshAtlasTextures(colorCanvas: HTMLCanvasElement, heightCanvas: HTMLCanvasElement) {
    const needsResize =
      colorCanvas.width !== this.atlasTexture.width ||
      colorCanvas.height !== this.atlasTexture.height;

    if (needsResize) {
      this.atlasTexture.destroy();
      this.heightAtlasTexture.destroy();
      this.atlasTexture = createAtlasTexture(this.device, colorCanvas);
      this.heightAtlasTexture = createAtlasTexture(this.device, heightCanvas);
      // Bind groups reference the old texture views — must rebuild
      this.rebuildBindGroups();
    } else {
      this.device.queue.copyExternalImageToTexture(
        { source: colorCanvas },
        { texture: this.atlasTexture },
        [colorCanvas.width, colorCanvas.height],
      );
      this.device.queue.copyExternalImageToTexture(
        { source: heightCanvas },
        { texture: this.heightAtlasTexture },
        [heightCanvas.width, heightCanvas.height],
      );
    }
  }

  private ensureDepthTexture(w: number, h: number) {
    if (w === this.depthW && h === this.depthH) return;
    this.depthTexture.destroy();
    this.depthW = w;
    this.depthH = h;
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();

    // Also resize reflection textures (same dimensions as main)
    this.ensureReflectionTextures(w, h);
  }

  private ensureReflectionTextures(w: number, h: number) {
    if (w === this.reflW && h === this.reflH) return;
    this.reflectionTexture.destroy();
    this.reflectionDepth.destroy();
    this.reflW = w;
    this.reflH = h;
    this.reflectionTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.reflectionView = this.reflectionTexture.createView();
    this.reflectionDepth = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.reflectionDepthView = this.reflectionDepth.createView();
    // Bind groups reference the reflection texture view — must rebuild
    this.rebuildBindGroups();
  }

  render(
    encoder: GPUCommandEncoder,
    textureView: GPUTextureView,
    bufferIndex: number,
    opts: RenderOptions,
    canvasWidth: number,
    canvasHeight: number,
  ) {
    this.ensureDepthTexture(canvasWidth, canvasHeight);
    this.camera.update(canvasWidth, canvasHeight);

    // Write camera buffer (224 bytes: view + proj + inv_view_proj + cam_pos + pad + billboard_right + pad)
    const camData = new ArrayBuffer(CAMERA_PARAMS_SIZE);
    const camF32 = new Float32Array(camData);
    camF32.set(this.camera.getViewMatrix(), 0);           // offset 0: view mat4x4
    camF32.set(this.camera.getProjectionMatrix(), 16);     // offset 16: proj mat4x4
    camF32.set(this.camera.getInverseViewProjection(), 32); // offset 32: inv_view_proj mat4x4
    const [cx, cy, cz] = this.camera.getPosition();
    camF32[48] = cx;  // offset 48: cam_pos.x
    camF32[49] = cy;  // cam_pos.y
    camF32[50] = cz;  // cam_pos.z
    // camF32[51] = 0 (padding)
    const [brx, bry, brz] = this.camera.getBillboardRight();
    camF32[52] = brx;  // offset 52: billboard_right.x
    camF32[53] = bry;  // billboard_right.y
    camF32[54] = brz;  // billboard_right.z
    // camF32[55] = 0 (padding)
    this.device.queue.writeBuffer(this.cameraBuffer, 0, camData);

    // Write render params (496 bytes)
    const data = new ArrayBuffer(RENDER_PARAMS_SIZE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);

    // Scalars (bytes 0-95, indices 0-23)
    u32[0] = this.gridW;
    u32[1] = this.gridH;
    u32[2] = opts.showMarkings ? 1 : 0;
    // flags: bit0=outdoor, bit1=backyard, bit2=skybox, bits3-4=surface_ground_type, bits5-6=surround_ground_type, bit7=hd_surface
    const surfGt = opts.groundType ?? 0;
    const surrGt = opts.surroundGroundType ?? 0;
    u32[3] = (opts.isOutdoor ? 1 : 0) | (opts.isBackyard ? 2 : 0) | (opts.skyMode === 'skybox' ? 4 : 0) | ((surfGt & 3) << 3) | ((surrGt & 3) << 5) | (opts.hdSurface ? 128 : 0);
    // Surface ground color (inside rink mask — what shows through ice)
    f32[4] = opts.surfaceGroundColor[0];
    f32[5] = opts.surfaceGroundColor[1];
    f32[6] = opts.surfaceGroundColor[2];
    f32[7] = this.cellSize;
    // Swap y<->z: CPU uses z-up, 3D shader uses y-up (same swap as lights)
    f32[8] = opts.sunDir[0];
    f32[9] = opts.sunDir[2];   // CPU z (elevation) -> shader y (up)
    f32[10] = opts.sunDir[1];  // CPU y (depth) -> shader z (grid y)
    f32[11] = opts.timeOfDay;
    f32[12] = opts.sunColor[0];
    f32[13] = opts.sunColor[1];
    f32[14] = opts.sunColor[2];
    f32[15] = opts.skyBrightness;
    f32[16] = opts.skyColor[0];
    f32[17] = opts.skyColor[1];
    f32[18] = opts.skyColor[2];
    f32[19] = opts.fogDensity;
    f32[20] = opts.cloudCover;
    f32[21] = opts.animTime;
    const lightCount = Math.min(opts.lights.length, 12);
    u32[22] = lightCount;
    f32[23] = opts.exposure ?? 1.0;

    // Lights (bytes 96-479, index 24+)
    // Each light: 8 f32 (pos.xyz, intensity, color.rgb, radius)
    // Light coords: LightDef (x=cellX, y=cellY, z=height) -> 3D world (x, z_as_y, y_as_z)
    for (let i = 0; i < lightCount; i++) {
      const li = 24 + i * 8;
      const light = opts.lights[i];
      f32[li + 0] = light.x;         // world x = cell x
      f32[li + 1] = light.z;         // world y = height (LightDef z)
      f32[li + 2] = light.y;         // world z = cell y (LightDef y)
      f32[li + 3] = light.intensity;
      f32[li + 4] = light.r;
      f32[li + 5] = light.g;
      f32[li + 6] = light.b;
      f32[li + 7] = light.radius;
    }

    // Surround ground color (bytes 480-495, index 120+)
    f32[120] = opts.groundColor[0];
    f32[121] = opts.groundColor[1];
    f32[122] = opts.groundColor[2];
    f32[123] = opts.contrast ?? 1.35;
    f32[124] = opts.saturation ?? 1.4;
    // Arena geometry + crowd density
    f32[125] = opts.rinkCx;
    f32[126] = opts.rinkCy;
    f32[127] = opts.rinkHx;
    f32[128] = opts.rinkHy;
    f32[129] = opts.rinkCr;
    f32[130] = opts.goalOffset;
    f32[131] = opts.crowdDensity ?? 0.0;
    // f32[132-135] = padding (already zero)

    this.device.queue.writeBuffer(this.paramsBuffer, 0, data);

    // Sky-tinted background (used as clear color)
    const skyR = Math.max(opts.skyColor[0] * 0.15, 0.02);
    const skyG = Math.max(opts.skyColor[1] * 0.15, 0.02);
    const skyB = Math.max(opts.skyColor[2] * 0.15, 0.04);

    // --- Pass 1: Render sprites to offscreen reflection texture (separate encoder) ---
    // Must be a separate submission because the reflection texture is both
    // a render target here and a texture binding in the main pass.
    {
      const reflEncoder = this.device.createCommandEncoder();
      const reflPass = reflEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.reflectionView,
          loadOp: 'clear' as GPULoadOp,
          storeOp: 'store' as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
        depthStencilAttachment: {
          view: this.reflectionDepthView,
          depthLoadOp: 'clear' as GPULoadOp,
          depthStoreOp: 'store' as GPUStoreOp,
          depthClearValue: 1.0,
        },
      });
      reflPass.setPipeline(this.spritePipeline);
      reflPass.setBindGroup(0, this.reflBindGroups[bufferIndex]);
      reflPass.draw(MAX_SPRITES * 6);
      reflPass.end();
      this.device.queue.submit([reflEncoder.finish()]);
    }

    // --- Pass 2: Main render (sky + mesh + sprites) ---
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: skyR, g: skyG, b: skyB, a: 1 },
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthLoadOp: 'clear' as GPULoadOp,
        depthStoreOp: 'store' as GPUStoreOp,
        depthClearValue: 1.0,
      },
    });

    // Always draw sky dome (both HDRI and physical modes) — no depth write, renders at max depth
    pass.setPipeline(this.skyPipeline);
    pass.setBindGroup(0, this.bindGroups[bufferIndex]);
    pass.draw(6);

    // Draw mesh on top (depth write enabled, will occlude sky)
    // Mesh shader samples reflection texture for ice reflections
    pass.setPipeline(this.meshPipeline);
    pass.setBindGroup(0, this.bindGroups[bufferIndex]);
    pass.draw(this.vertexCount);

    // Draw billboard sprites (alpha blended, depth tested against mesh)
    pass.setPipeline(this.spritePipeline);
    pass.setBindGroup(0, this.bindGroups[bufferIndex]);
    pass.draw(MAX_SPRITES * 6);

    pass.end();
  }

  destroy() {
    this.cameraBuffer.destroy();
    this.paramsBuffer.destroy();
    this.spriteBuffer.destroy();
    this.atlasTexture.destroy();
    this.heightAtlasTexture.destroy();
    this.depthTexture.destroy();
    this.reflectionTexture.destroy();
    this.reflectionDepth.destroy();
    this.dummyReflTex.destroy();
  }
}
