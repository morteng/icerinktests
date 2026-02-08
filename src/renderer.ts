import shaderCommon from './shaders/common.wgsl?raw';
import shaderAtmosphere from './shaders/atmosphere.wgsl?raw';
import shaderLighting from './shaders/lighting.wgsl?raw';
import shaderSprites from './shaders/sprites.wgsl?raw';
import shaderFragment from './shaders/fragment.wgsl?raw';

const renderShaderCode = shaderCommon + '\n' + shaderAtmosphere + '\n' + shaderLighting + '\n' + shaderSprites + '\n' + shaderFragment;
import { RinkConfig } from './rink';
import { Simulation } from './simulation';
import { SPRITE_BUFFER_SIZE } from './sprites';
import { LightDef, MAX_LIGHTS } from './lighting';
import { PARTICLE_BUFFER_SIZE } from './particles';

// Buffer layout: 28 scalar fields (112 bytes) + 12 lights × 32 bytes (384) + 2 editor (8)
// + 9 PBR atmosphere fields (36) = 540 bytes → round to 576
const RENDER_PARAMS_SIZE = 576;
const LIGHT_OFFSET = 28; // f32 index where lights array starts

export interface RenderOptions {
  showPipes: boolean;
  showMarkings: boolean;
  crossX: number;
  crossY: number;
  showCrossLine: boolean;
  renderMode: number;
  isOutdoor: boolean;
  isBackyard: boolean;
  simTime: number;
  rinkCx: number;
  rinkCy: number;
  rinkHx: number;
  rinkHy: number;
  rinkCr: number;
  goalOffset: number;
  animTime: number;
  // Lighting fields
  timeOfDay: number;
  lights: LightDef[];
  skyBrightness: number;
  fogDensity: number;
  cloudCover: number;
  groundColor: [number, number, number];
  surfaceGroundColor: [number, number, number];
  // Light editor fields
  selectedLight: number;
  lightToolActive: boolean;
  // PBR atmospheric scattering (computed on CPU)
  sunDir: [number, number, number];
  sunColor: [number, number, number];
  skyColor: [number, number, number];
  moonDir: [number, number, number];
  moonPhase: number;
  renderFlags: number;
  exposure?: number;
  contrast?: number;
  saturation?: number;
  skyMode?: string;  // 'physical' | 'skybox'
  groundType?: number;  // surface ground: 0=concrete, 1=grass, 2=gravel, 3=asphalt
  surroundGroundType?: number;  // surround ground type
  hdSurface?: boolean;
  crowdDensity?: number;  // 0.0-1.0, spectator fill for indoor arena seats
}

export class Renderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private paramsBuffer: GPUBuffer;
  private spriteBuffer: GPUBuffer;
  private particleBuffer: GPUBuffer;
  private bindGroups: [GPUBindGroup, GPUBindGroup];
  private gridW: number;
  private gridH: number;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    config: RinkConfig,
    simulation: Simulation,
    markingsBuffer: GPUBuffer,
    maskBuffer: GPUBuffer,
    scratchBuffer: GPUBuffer,
  ) {
    this.device = device;
    this.gridW = config.gridW;
    this.gridH = config.gridH;

    this.paramsBuffer = device.createBuffer({
      size: RENDER_PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.spriteBuffer = device.createBuffer({
      size: SPRITE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.particleBuffer = device.createBuffer({
      size: PARTICLE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const module = device.createShaderModule({ code: renderShaderCode });

    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const bgl = this.pipeline.getBindGroupLayout(0);
    const [bufA, bufB] = simulation.temperatureBuffers;
    const [s2A, s2B] = simulation.state2BufferPair;
    const pipeBuffer = simulation.pipeLayoutBuffer;

    this.bindGroups = [
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: bufA } },
          { binding: 2, resource: { buffer: pipeBuffer } },
          { binding: 3, resource: { buffer: markingsBuffer } },
          { binding: 4, resource: { buffer: maskBuffer } },
          { binding: 5, resource: { buffer: this.spriteBuffer } },
          { binding: 6, resource: { buffer: scratchBuffer } },
          { binding: 7, resource: { buffer: this.particleBuffer } },
          { binding: 8, resource: { buffer: s2A } },
        ],
      }),
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: bufB } },
          { binding: 2, resource: { buffer: pipeBuffer } },
          { binding: 3, resource: { buffer: markingsBuffer } },
          { binding: 4, resource: { buffer: maskBuffer } },
          { binding: 5, resource: { buffer: this.spriteBuffer } },
          { binding: 6, resource: { buffer: scratchBuffer } },
          { binding: 7, resource: { buffer: this.particleBuffer } },
          { binding: 8, resource: { buffer: s2B } },
        ],
      }),
    ];
  }

  updateSprites(data: Float32Array) {
    this.device.queue.writeBuffer(this.spriteBuffer, 0, data);
  }

  updateParticles(data: Float32Array) {
    this.device.queue.writeBuffer(this.particleBuffer, 0, data);
  }

  render(
    encoder: GPUCommandEncoder,
    textureView: GPUTextureView,
    bufferIndex: number,
    opts: RenderOptions,
  ) {
    const data = new ArrayBuffer(RENDER_PARAMS_SIZE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);

    // Scalar fields (indices 0-23) — layout matches RenderParams struct
    u32[0] = this.gridW;
    u32[1] = this.gridH;
    u32[2] = opts.showPipes ? 1 : 0;
    u32[3] = opts.showMarkings ? 1 : 0;
    u32[4] = opts.crossY;
    u32[5] = opts.showCrossLine ? 1 : 0;
    u32[6] = opts.isBackyard ? 1 : 0;
    f32[7] = opts.cloudCover;
    f32[8] = opts.groundColor[0];
    f32[9] = opts.groundColor[1];
    f32[10] = opts.groundColor[2];
    u32[11] = opts.renderFlags;
    u32[12] = opts.crossX;
    u32[13] = opts.renderMode;
    u32[14] = opts.isOutdoor ? 1 : 0;
    f32[15] = opts.simTime;
    f32[16] = opts.rinkCx;
    f32[17] = opts.rinkCy;
    f32[18] = opts.rinkHx;
    f32[19] = opts.rinkHy;
    f32[20] = opts.rinkCr;
    f32[21] = opts.goalOffset;
    u32[22] = 0;
    f32[23] = opts.animTime;

    // Lighting fields (indices 24-27)
    f32[24] = opts.timeOfDay;
    u32[25] = Math.min(opts.lights.length, MAX_LIGHTS);
    f32[26] = opts.skyBrightness;
    f32[27] = opts.fogDensity;

    // Light array (12 lights × 8 f32 each, starting at index 28)
    const lightCount = Math.min(opts.lights.length, MAX_LIGHTS);
    for (let i = 0; i < lightCount; i++) {
      const base = LIGHT_OFFSET + i * 8;
      const l = opts.lights[i];
      f32[base + 0] = l.x;
      f32[base + 1] = l.y;
      f32[base + 2] = l.z;
      f32[base + 3] = l.intensity;
      f32[base + 4] = l.r;
      f32[base + 5] = l.g;
      f32[base + 6] = l.b;
      f32[base + 7] = l.radius;
    }

    // Light editor fields (indices 124-125, after 12 lights × 8 = 96 starting at 28)
    const i32view = new Int32Array(data);
    i32view[124] = opts.selectedLight;
    u32[125] = opts.lightToolActive ? 1 : 0;

    // PBR atmospheric scattering (indices 126-134)
    f32[126] = opts.sunDir[0];
    f32[127] = opts.sunDir[1];
    f32[128] = opts.sunDir[2];
    f32[129] = opts.sunColor[0];
    f32[130] = opts.sunColor[1];
    f32[131] = opts.sunColor[2];
    f32[132] = opts.skyColor[0];
    f32[133] = opts.skyColor[1];
    f32[134] = opts.skyColor[2];
    // Moon (indices 135-138)
    f32[135] = opts.moonDir[0];
    f32[136] = opts.moonDir[1];
    f32[137] = opts.moonDir[2];
    f32[138] = opts.moonPhase;
    // Surface ground color (rink interior)
    f32[139] = opts.surfaceGroundColor[0];
    f32[140] = opts.surfaceGroundColor[1];
    f32[141] = opts.surfaceGroundColor[2];
    // Post-processing
    f32[142] = opts.contrast ?? 1.35;
    f32[143] = opts.saturation ?? 1.4;

    this.device.queue.writeBuffer(this.paramsBuffer, 0, data);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0.05, g: 0.05, b: 0.1, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[bufferIndex]);
    pass.draw(6);
    pass.end();
  }

  destroy() {
    this.paramsBuffer.destroy();
    this.spriteBuffer.destroy();
    this.particleBuffer.destroy();
  }
}
