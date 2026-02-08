import heatShaderCode from './shaders/heat.wgsl?raw';
import { RinkConfig } from './rink';

const ICE_DIFFUSIVITY = 1.02e-6;
const PIPE_TAU = 1500.0;
const AIR_TAU_INDOOR = 80000.0;
const AIR_TAU_OUTDOOR = 10000.0;

// Physical rates (per second)
const FREEZE_RATE = 0.001;   // mm/s per °C below zero
const MELT_RATE = 0.001;     // mm/s per °C above zero
const LATENT_FACTOR = 5.0;   // °C per mm of ice (independent of dt)
const RETURN_DELTA = 3.0;    // °C warmer at return end vs supply

// Water physics
const EVAP_RATE = 0.0001;    // mm/s per °C above zero
const DRAIN_RATE = 0.05;     // fraction per second near board edges

// Snow physics
const SNOW_REPOSE_THRESHOLD = 40;   // mm height diff before sliding (at 80mm/cell baseline)
const SNOW_TRANSFER_FRAC = 0.3;     // fraction of excess transferred per step

const MAX_DISPATCHES = 20;   // cap GPU work per frame

export interface SimTunables {
  freezeRate: number;   // mm/s per °C below zero
  meltRate: number;     // mm/s per °C above zero
  latentFactor: number; // °C per mm of ice
  airTau: number;       // air coupling time constant (s)
  evapRate: number;     // mm/s per °C above zero
  drainRate: number;    // fraction per second
  snowRepose: number;   // mm height diff before sliding
  snowTransfer: number; // fraction of excess transferred
}

export const DEFAULT_SIM_TUNABLES_INDOOR: SimTunables = {
  freezeRate: FREEZE_RATE,
  meltRate: MELT_RATE,
  latentFactor: LATENT_FACTOR,
  airTau: AIR_TAU_INDOOR,
  evapRate: EVAP_RATE,
  drainRate: DRAIN_RATE,
  snowRepose: SNOW_REPOSE_THRESHOLD,
  snowTransfer: SNOW_TRANSFER_FRAC,
};

export const DEFAULT_SIM_TUNABLES_OUTDOOR: SimTunables = {
  ...DEFAULT_SIM_TUNABLES_INDOOR,
  airTau: AIR_TAU_OUTDOOR,
};

// Params buffer layout (160 bytes = 40 f32/u32):
// [0]  width (u32)
// [1]  height (u32)
// [2]  pipe_temp (f32)
// [3]  ambient_temp (f32)
// [4]  alpha_dt_dx2 (f32)
// [5]  pipe_coupling (f32)
// [6]  air_coupling (f32)
// [7]  freeze_rate (f32)
// [8]  melt_rate (f32)
// [9]  latent_factor (f32)
// [10] flood_amount (f32)
// [11] return_delta (f32)
// [12] damage_x (f32)
// [13] damage_y (f32)
// [14] damage_radius (f32)
// [15] damage_mode (u32) — 0=none, 1=damage, 2=water, 3=snow
// [16] zamboni_x (f32)
// [17] zamboni_y (f32)
// [18] zamboni_width (f32)
// [19] zamboni_active (u32)
// [20] zamboni_length (f32)
// [21] zamboni_dir (f32)
// [22] sim_dt (f32)
// [23] water_coupling (f32) — repurposed as snow_insulation_factor (5.0)
// [24] evap_rate (f32)
// [25] drain_rate (f32)
// [26] snow_amount (f32)
// [27] rain_rate (f32)
// [28] zamboni_water_rate (f32) — mm water per crossing
// [29] zamboni_heat_temp (f32) — water temperature °C
// [30] zamboni_speed (f32) — cells/s travel speed
// [31] zamboni_shave_depth (f32) — mm ice removed per crossing
// [32] water_gravity_coupling (f32) — height-field flow coupling
// [33] water_damping (f32) — transfer damping factor
// [34] snow_repose_threshold (f32) — height diff for sliding
// [35] snow_transfer_frac (f32) — fraction of excess transferred
// [36] cell_size_m (f32) — cell size in meters
// [37] damage_amount (f32) — configurable mm per application
// [38] damage_temp (f32) — water temperature for damage mode 2
// [39] damage_dir (f32) — packed angle of mouse movement for scratch direction

export interface DamageInput {
  active: boolean;
  gridX: number;
  gridY: number;
  radius: number;
  mode: number; // 0=none, 1=damage ice, 2=add water, 3=add snow
  amount?: number;  // configurable mm per application (default: 0.8/0.5/0.3)
  temp?: number;    // water temperature for mode 2 (default: 20°C)
  velocityX?: number; // mouse velocity for scratch direction
  velocityY?: number;
}

export interface ZamboniInput {
  active: boolean;
  x: number;
  y: number;
  width: number;
  length: number;
  dir: number;
  waterRate: number;
  heatTemp: number;
  speed: number;
  shaveDepth: number;
  bladeDown: boolean;
  waterOn: boolean;
}

export class Simulation {
  private device: GPUDevice;
  private gridW: number;
  private gridH: number;
  private cellSize: number;
  private airTau: number;
  private isOutdoor: boolean;
  private isBackyard: boolean;

  // Wind state (outdoor only)
  private _windX = 0;
  private _windY = 0;
  private windTargetX = 0;
  private windTargetY = 0;
  private windTimer = 0;
  private windNextChange = 30 + Math.random() * 60;
  private noiseSeed = 0;

  private buffers: [GPUBuffer, GPUBuffer];
  private state2Buffers: [GPUBuffer, GPUBuffer];
  private pipeBuffer: GPUBuffer;
  private paramsBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;
  private readbackBuffer2: GPUBuffer;

  private pipeline: GPUComputePipeline;
  private bindGroups: [GPUBindGroup, GPUBindGroup];
  private ownedSpriteBuffer: GPUBuffer | null = null; // only if we created a dummy

  private current = 0;
  private workgroupsX: number;
  private workgroupsY: number;

  constructor(
    device: GPUDevice,
    config: RinkConfig,
    initialState: Float32Array,
    initialState2: Float32Array,
    pipeLayout: Float32Array,
    maskBuffer: GPUBuffer,
    solidsBuffer: GPUBuffer,
    scratchBuffer: GPUBuffer,
    spriteBuffer?: GPUBuffer,
  ) {
    this.device = device;
    this.gridW = config.gridW;
    this.gridH = config.gridH;
    this.cellSize = config.cellSize;
    this.airTau = config.isIndoor ? AIR_TAU_INDOOR : AIR_TAU_OUTDOOR;
    this.isOutdoor = !config.isIndoor;
    this.isBackyard = config.isBackyard;

    const cellCount = config.gridW * config.gridH;
    const stateSize = cellCount * 16;
    const pipeSize = cellCount * 4;

    this.buffers = [
      device.createBuffer({ size: stateSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
      device.createBuffer({ size: stateSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
    ];
    device.queue.writeBuffer(this.buffers[0], 0, initialState);
    device.queue.writeBuffer(this.buffers[1], 0, initialState);

    // State2: vec4f per cell (snow_density, snow_lwc, mud_amount, reserved)
    this.state2Buffers = [
      device.createBuffer({ size: stateSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
      device.createBuffer({ size: stateSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
    ];
    device.queue.writeBuffer(this.state2Buffers[0], 0, initialState2);
    device.queue.writeBuffer(this.state2Buffers[1], 0, initialState2);

    this.pipeBuffer = device.createBuffer({ size: pipeSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.pipeBuffer, 0, pipeLayout);

    this.paramsBuffer = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Readback buffers for quality metrics
    this.readbackBuffer = device.createBuffer({ size: stateSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.readbackBuffer2 = device.createBuffer({ size: stateSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    // Sprite buffer for GPU-side skater interaction (damage, snow tracks)
    let spriteBuf = spriteBuffer;
    if (!spriteBuf) {
      // Create a minimal dummy sprite buffer (header only, zero sprites)
      spriteBuf = device.createBuffer({
        size: 16 + 64 * 32, // header + max sprites
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.ownedSpriteBuffer = spriteBuf;
    }

    const module = device.createShaderModule({ code: heatShaderCode });
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const bgl = this.pipeline.getBindGroupLayout(0);
    this.bindGroups = [
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.buffers[0] } },
          { binding: 2, resource: { buffer: this.buffers[1] } },
          { binding: 3, resource: { buffer: this.pipeBuffer } },
          { binding: 4, resource: { buffer: maskBuffer } },
          { binding: 5, resource: { buffer: solidsBuffer } },
          { binding: 6, resource: { buffer: scratchBuffer } },
          { binding: 7, resource: { buffer: this.state2Buffers[0] } },
          { binding: 8, resource: { buffer: this.state2Buffers[1] } },
          { binding: 9, resource: { buffer: spriteBuf } },
        ],
      }),
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.buffers[1] } },
          { binding: 2, resource: { buffer: this.buffers[0] } },
          { binding: 3, resource: { buffer: this.pipeBuffer } },
          { binding: 4, resource: { buffer: maskBuffer } },
          { binding: 5, resource: { buffer: solidsBuffer } },
          { binding: 6, resource: { buffer: scratchBuffer } },
          { binding: 7, resource: { buffer: this.state2Buffers[1] } },
          { binding: 8, resource: { buffer: this.state2Buffers[0] } },
          { binding: 9, resource: { buffer: spriteBuf } },
        ],
      }),
    ];

    this.workgroupsX = Math.ceil(config.gridW / 16);
    this.workgroupsY = Math.ceil(config.gridH / 16);
  }

  /** Update wind model (outdoor only). Call once per frame before writeParams. */
  updateWind(dt: number) {
    if (!this.isOutdoor) {
      this._windX = 0;
      this._windY = 0;
      return;
    }
    this.windTimer += dt;
    if (this.windTimer >= this.windNextChange) {
      this.windTimer = 0;
      this.windNextChange = 30 + Math.random() * 60;
      const angle = Math.random() * Math.PI * 2;
      const strength = Math.random() * 3; // 0-3 cells/s
      this.windTargetX = Math.cos(angle) * strength;
      this.windTargetY = Math.sin(angle) * strength;
    }
    // Exponential lerp (τ≈3s) + sinusoidal gusts
    const tau = 3.0;
    const blend = 1 - Math.exp(-dt / tau);
    this._windX += blend * (this.windTargetX - this._windX);
    this._windY += blend * (this.windTargetY - this._windY);
    // Turbulent gusts
    const t = this.windTimer;
    this._windX += Math.sin(t * 1.7) * 0.3 * dt;
    this._windY += Math.cos(t * 2.3) * 0.3 * dt;
  }

  get windX(): number { return this._windX; }
  get windY(): number { return this._windY; }

  plan(simSecondsPerFrame: number): { dispatches: number; dt: number } {
    const dispatches = Math.min(Math.max(Math.round(simSecondsPerFrame), 1), MAX_DISPATCHES);
    const dt = simSecondsPerFrame / dispatches;
    return { dispatches, dt };
  }

  writeParams(
    pipeTemp: number,
    ambientTemp: number,
    floodAmount: number,
    dt: number,
    damage?: DamageInput,
    zamboni?: ZamboniInput,
    snowAmount = 0,
    rainOverride?: number,
    tunables?: SimTunables,
  ) {
    const t = tunables ?? (this.isOutdoor ? DEFAULT_SIM_TUNABLES_OUTDOOR : DEFAULT_SIM_TUNABLES_INDOOR);
    const dx2 = this.cellSize * this.cellSize;
    const data = new ArrayBuffer(208);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);

    u32[0] = this.gridW;
    u32[1] = this.gridH;
    f32[2] = pipeTemp;
    f32[3] = ambientTemp;
    f32[4] = ICE_DIFFUSIVITY * dt / dx2;
    f32[5] = 1 - Math.exp(-dt / PIPE_TAU);
    f32[6] = 1 - Math.exp(-dt / t.airTau);
    f32[7] = t.freezeRate * dt;
    f32[8] = t.meltRate * dt;
    f32[9] = t.latentFactor;
    f32[10] = floodAmount;
    f32[11] = RETURN_DELTA;

    // Damage params (mode: 0=none, 1=damage, 2=water, 3=snow)
    f32[12] = damage?.gridX ?? 0;
    f32[13] = damage?.gridY ?? 0;
    f32[14] = damage?.radius ?? 0;
    u32[15] = damage?.active ? (damage.mode ?? 1) : 0;

    // Zamboni params
    f32[16] = zamboni?.x ?? 0;
    f32[17] = zamboni?.y ?? 0;
    f32[18] = zamboni?.width ?? 0;
    u32[19] = (zamboni?.active ? 1 : 0);
    f32[20] = zamboni?.length ?? 0;
    f32[21] = zamboni?.dir ?? 1;
    f32[22] = dt;

    // Snow insulation factor (repurposed from legacy water_coupling)
    // ~5.0: 1mm snow reduces air coupling by ~83%, 2mm by ~91%
    f32[23] = 5.0;
    f32[24] = t.evapRate * dt;                         // evap_rate
    f32[25] = t.drainRate * dt;                       // drain_rate
    f32[26] = snowAmount;                              // snow_amount
    // Rain: outdoor rinks get rain when ambient > 0°C (~0.5mm/min light rain)
    const autoRain = (this.isOutdoor && ambientTemp > 0) ? 0.008 * ambientTemp * dt : 0;
    f32[27] = rainOverride !== undefined ? rainOverride : autoRain; // rain_rate
    f32[28] = zamboni?.waterRate ?? 0;                  // zamboni_water_rate (mm/s)
    f32[29] = zamboni?.heatTemp ?? 0;                   // zamboni_heat_temp
    f32[30] = zamboni?.speed ?? 0;                      // zamboni_speed
    f32[31] = zamboni?.shaveDepth ?? 0;                 // zamboni_shave_depth

    // New height-field water + falling-sand snow params
    f32[32] = Math.min(9.81 * dt / (this.cellSize * 1000), 0.20);  // water_gravity_coupling
    f32[33] = 0.85;                                     // water_damping
    f32[34] = t.snowRepose;                              // snow_repose_threshold (mm)
    f32[35] = t.snowTransfer;                            // snow_transfer_frac
    f32[36] = this.cellSize;                             // cell_size_m
    f32[37] = damage?.amount ?? 0;                        // damage_amount
    f32[38] = damage?.temp ?? 20;                         // damage_temp
    // Pack mouse velocity direction as angle for scratch system
    const vx = damage?.velocityX ?? 0;
    const vy = damage?.velocityY ?? 0;
    const speed = Math.sqrt(vx * vx + vy * vy);
    f32[39] = speed > 1 ? Math.atan2(vy, vx) : -99;     // damage_dir (-99 = no direction)
    u32[40] = this.isOutdoor ? 1 : 0;                     // is_outdoor
    u32[41] = this.isBackyard ? 1 : 0;                    // is_backyard
    u32[42] = (zamboni?.bladeDown ? 1 : 0);                // blade_down
    u32[43] = (zamboni?.waterOn ? 1 : 0);                  // water_on
    f32[44] = this._windX;                                   // wind_x
    f32[45] = this._windY;                                   // wind_y
    this.noiseSeed = (this.noiseSeed + 1) & 0xFFFFFFFF;
    u32[46] = this.noiseSeed;                                // noise_seed
    f32[47] = 0;                                             // _pad47

    this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
  }

  step(encoder: GPUCommandEncoder) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[this.current]);
    pass.dispatchWorkgroups(this.workgroupsX, this.workgroupsY);
    pass.end();
    this.current = 1 - this.current;
  }

  reset(initialState: Float32Array, initialState2?: Float32Array) {
    this.device.queue.writeBuffer(this.buffers[0], 0, initialState);
    this.device.queue.writeBuffer(this.buffers[1], 0, initialState);
    if (initialState2) {
      this.device.queue.writeBuffer(this.state2Buffers[0], 0, initialState2);
      this.device.queue.writeBuffer(this.state2Buffers[1], 0, initialState2);
    } else {
      // Zero out state2
      const zeros = new Float32Array(initialState.length);
      this.device.queue.writeBuffer(this.state2Buffers[0], 0, zeros);
      this.device.queue.writeBuffer(this.state2Buffers[1], 0, zeros);
    }
    this.current = 0;
  }

  async readState(): Promise<Float32Array> {
    const currentBuffer = this.buffers[this.current];
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(currentBuffer, 0, this.readbackBuffer, 0, this.readbackBuffer.size);
    this.device.queue.submit([encoder.finish()]);

    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(this.readbackBuffer.getMappedRange().slice(0));
    this.readbackBuffer.unmap();
    return data;
  }

  async readState2(): Promise<Float32Array> {
    const currentBuffer = this.state2Buffers[this.current];
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(currentBuffer, 0, this.readbackBuffer2, 0, this.readbackBuffer2.size);
    this.device.queue.submit([encoder.finish()]);

    await this.readbackBuffer2.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(this.readbackBuffer2.getMappedRange().slice(0));
    this.readbackBuffer2.unmap();
    return data;
  }

  get temperatureBuffers(): readonly [GPUBuffer, GPUBuffer] { return this.buffers; }
  get state2BufferPair(): readonly [GPUBuffer, GPUBuffer] { return this.state2Buffers; }
  get pipeLayoutBuffer(): GPUBuffer { return this.pipeBuffer; }
  get currentBufferIndex(): number { return this.current; }

  destroy() {
    this.buffers[0].destroy();
    this.buffers[1].destroy();
    this.state2Buffers[0].destroy();
    this.state2Buffers[1].destroy();
    this.pipeBuffer.destroy();
    this.paramsBuffer.destroy();
    this.readbackBuffer.destroy();
    this.readbackBuffer2.destroy();
    this.ownedSpriteBuffer?.destroy();
  }
}
