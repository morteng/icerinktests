import crossSectionShaderCode from './shaders/crossSection.wgsl?raw';
import { RinkConfig } from './rink';
import { Simulation } from './simulation';

export interface LayerLayout {
  paintBot: number;
  paintTop: number;
  iceTop: number;
  waterTop: number;
  snowTop: number;
}

/** Compute "not to scale" layer positions — each active layer gets a minimum visible height */
export function computeLayerLayout(
  iceMm: number, waterMm: number, shavingsMm: number, hasMarking: boolean,
  isOutdoor: boolean, temp: number,
): LayerLayout {
  const surface = 0.42;
  const maxTop = 0.96;
  const available = maxTop - surface;
  const MIN_H = 0.04;

  const iceBelowMm = hasMarking ? Math.min(iceMm, 6) : 0;
  const iceAboveMm = hasMarking ? Math.max(iceMm - 6, 0) : iceMm;

  const hIceBelow = iceBelowMm > 0.1 ? Math.max(MIN_H, iceBelowMm / 40) : 0;
  const hPaint = hasMarking ? 0.025 : 0;
  const iceForAbove = hasMarking ? iceAboveMm : iceMm;
  const hIceAbove = iceForAbove > 0.1 ? Math.max(MIN_H, iceForAbove / 40) : 0;
  const hWater = waterMm > 0.01 ? Math.max(MIN_H, waterMm / 40) : 0;
  const hSnow = shavingsMm > 0.01 ? Math.max(MIN_H, shavingsMm / 40) : 0;

  let total = hIceBelow + hPaint + hIceAbove + hWater + hSnow;
  const scale = total > available ? available / total : 1;

  let pos = surface;
  pos += hIceBelow * scale;
  const paintBot = pos;
  pos += hPaint * scale;
  const paintTop = pos;
  pos += hIceAbove * scale;
  const iceTop = pos;
  pos += hWater * scale;
  const waterTop = pos;
  pos += hSnow * scale;
  const snowTop = pos;

  return { paintBot, paintTop, iceTop, waterTop, snowTop };
}

export class CrossSection {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private paramsBuffer: GPUBuffer;
  private bindGroups: [GPUBindGroup, GPUBindGroup];
  private gridW: number;
  private gridH: number;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    config: RinkConfig,
    simulation: Simulation,
    markingsBuffer: GPUBuffer,
  ) {
    this.device = device;
    this.gridW = config.gridW;
    this.gridH = config.gridH;

    // CrossParams: 16 fields = 64 bytes
    this.paramsBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const module = device.createShaderModule({ code: crossSectionShaderCode });

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
    const pipeBuffer = simulation.pipeLayoutBuffer;

    this.bindGroups = [
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: bufA } },
          { binding: 2, resource: { buffer: pipeBuffer } },
          { binding: 3, resource: { buffer: markingsBuffer } },
        ],
      }),
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: bufB } },
          { binding: 2, resource: { buffer: pipeBuffer } },
          { binding: 3, resource: { buffer: markingsBuffer } },
        ],
      }),
    ];
  }

  render(
    encoder: GPUCommandEncoder,
    textureView: GPUTextureView,
    bufferIndex: number,
    cursorX: number,
    cursorY: number,
    canvasW: number,
    canvasH: number,
    isOutdoor: boolean,
    hasMarking: boolean,
    layout: LayerLayout,
    groundType = 0,
    hasPipes = true,
  ) {
    const buf = new ArrayBuffer(64);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);

    u32[0] = this.gridW;
    u32[1] = this.gridH;
    u32[2] = Math.max(0, Math.min(cursorX, this.gridW - 1));
    u32[3] = Math.max(0, Math.min(cursorY, this.gridH - 1));
    u32[4] = canvasW;
    u32[5] = canvasH;
    u32[6] = isOutdoor ? 1 : 0;
    u32[7] = hasMarking ? 1 : 0;
    f32[8]  = layout.paintBot;
    f32[9]  = layout.paintTop;
    f32[10] = layout.iceTop;
    f32[11] = layout.waterTop;
    f32[12] = layout.snowTop;
    u32[13] = groundType;
    u32[14] = hasPipes ? 1 : 0;
    f32[15] = 0;

    this.device.queue.writeBuffer(this.paramsBuffer, 0, buf);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[bufferIndex]);
    pass.draw(6);
    pass.end();
  }

  destroy() {
    this.paramsBuffer.destroy();
  }
}
