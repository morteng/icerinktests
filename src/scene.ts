import {
  RinkConfig, RinkPreset, GroundType,
  createRinkMask, createPipeLayout, createInitialState,
} from './rink';

const GROUND_TYPE_MAP: Record<GroundType, number> = {
  concrete: 0, grass: 1, gravel: 2, asphalt: 3,
};
import { Simulation, DamageInput, ZamboniInput, SimTunables } from './simulation';
import { Renderer, RenderOptions } from './renderer';
import { CrossSection, computeLayerLayout, LayerLayout } from './crossSection';
import { createMarkings, MarkingLayout } from './markings';
import { createSolidsBuffer } from './solids';
import { InteractionManager } from './interaction';
import { Zamboni, MachineType } from './zamboni';
import { EventScheduler, calculateQualityMetrics, QualityMetrics } from './events';
import { SkaterSimulation } from './skaters';
import { SpriteBuffer } from './sprites';
import { LightingManager, LightDef, computeAtmosphere } from './lighting';
import { ParticleManager, LandedDeposit } from './particles';

/** Inputs from UI → Scene each frame */
export interface SceneInputs {
  ambientTemp: number;
  pipeTemp: number;
  simSecsPerFrame: number;
  showPipes: boolean;
  showMarkings: boolean;
  renderMode: number;
  cursorGridX: number;
  cursorGridY: number;
  timeOfDay: number;
  timeManual: boolean;
  animTime: number;
  lightToolActive: boolean;
  selectedLight: number;
  paintMode: string;
  damageType: string;
  autoMode: boolean;
  paused: boolean;
  weatherAuto: boolean;
  cloudCoverManual: number;
  precipMode: string;  // 'auto' | 'none' | 'rain' | 'snow'
  precipIntensity: number;
  simTunables: SimTunables;
  renderFlags: number;
}

/** Serializable state for save/load */
export interface SceneState {
  preset: RinkPreset;
  customDims?: { lengthM: number; widthM: number; cornerRadiusM: number };
  markingLayout: MarkingLayout;
  simTime: number;
  stateData: Float32Array;
  ambientTemp: number;
  pipeTemp: number;
  timeOfDay: number;
  zamboniActive: boolean;
  zamboniState?: { x: number; y: number; dir: number; pass: number; totalPasses: number };
  machineType: MachineType;
  schedulerState: { currentIndex: number; elapsed: number; autoMode: boolean };
  lightingMode: 'auto' | 'manual';
  manualLights?: LightDef[];
}

export class Scene {
  // Config
  config: RinkConfig;

  // GPU resources (owned, destroyed on dispose)
  private device: GPUDevice;
  maskBuffer: GPUBuffer;
  markingsBuffer: GPUBuffer;
  solidsBuffer: GPUBuffer;
  scratchBuffer: GPUBuffer;

  // CPU data copies
  maskData: Float32Array;
  pipeLayoutData: Float32Array;
  markingsDataCpu: Float32Array;
  solidsData: Float32Array;
  cachedStateData: Float32Array | null = null;

  // Systems
  simulation: Simulation;
  renderer: Renderer;
  crossSection: CrossSection;
  zamboni: Zamboni;
  scheduler: EventScheduler;
  skaterSim: SkaterSimulation;
  lightingMgr: LightingManager;
  spriteBuffer: SpriteBuffer;
  interaction: InteractionManager;
  particleMgr: ParticleManager;

  // Machine type
  machineType: MachineType;

  // Scene state
  simTime = 0;
  pendingFlood = 0;
  pendingSnow = 0;
  frameCount = 0;
  lastEventType = '';

  // Snowball rate limiter
  private _snowballAccum = 0;

  // Cross-section layout cache
  lastLayout: LayerLayout = { paintBot: 0.42, paintTop: 0.42, iceTop: 0.42, waterTop: 0.42, snowTop: 0.42 };
  lastHasMarking = false;

  // Quality readback
  private pendingQuality = false;
  latestMetrics: QualityMetrics | null = null;

  // Marking layout
  markingLayout: MarkingLayout;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    config: RinkConfig,
    interaction: InteractionManager,
    markingLayout: MarkingLayout,
    ambientTemp: number,
  ) {
    this.device = device;
    this.config = config;
    this.markingLayout = markingLayout;
    this.interaction = interaction;
    interaction.updateConfig(config);

    // Create mask
    this.maskData = createRinkMask(config);
    this.maskBuffer = device.createBuffer({
      size: this.maskData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.maskBuffer, 0, this.maskData);

    // Pipe layout
    this.pipeLayoutData = createPipeLayout(config, this.maskData);

    // Solids
    this.solidsData = createSolidsBuffer(config, this.maskData);
    this.solidsBuffer = device.createBuffer({
      size: this.solidsData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.solidsBuffer, 0, this.solidsData);

    // Scratch buffer (u32 per cell, for directional scratch rendering)
    const cellCount = config.gridW * config.gridH;
    this.scratchBuffer = device.createBuffer({
      size: cellCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Initial state
    const startIce = config.isBackyard ? 0 : 12;
    const startWater = 0;
    const startTemp = config.isBackyard ? ambientTemp : -4;
    const initialState = createInitialState(config, startTemp, startWater, this.maskData, startIce);
    this.simulation = new Simulation(device, config, initialState, this.pipeLayoutData, this.maskBuffer, this.solidsBuffer, this.scratchBuffer);

    // Markings
    this.markingsDataCpu = createMarkings(config, this.maskData, markingLayout);
    this.markingsBuffer = device.createBuffer({
      size: this.markingsDataCpu.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.markingsBuffer, 0, this.markingsDataCpu);

    // Renderer & cross-section
    this.renderer = new Renderer(device, format, config, this.simulation, this.markingsBuffer, this.maskBuffer, this.scratchBuffer);
    this.crossSection = new CrossSection(device, format, config, this.simulation, this.markingsBuffer);

    // Game systems
    this.machineType = config.isBackyard ? 'shovel' : 'zamboni';
    this.zamboni = new Zamboni(config, this.maskData, this.machineType, this.solidsData);
    this.scheduler = new EventScheduler(config, this.maskData);
    this.skaterSim = new SkaterSimulation(config, this.maskData, this.solidsData);
    this.spriteBuffer = new SpriteBuffer();
    this.lightingMgr = new LightingManager(config);
    this.particleMgr = new ParticleManager(config.gridW, config.gridH, config.cellSize, this.solidsData);

    // Goal sprites
    const rinkCellsW = config.dims.lengthM / config.cellSize;
    const rinkCellsH = config.dims.widthM / config.cellSize;
    const goalOffM = config.preset === 'olympic' ? 4.0
      : config.isBackyard ? Math.min(2.0, config.dims.lengthM * 0.2)
      : 3.35;
    const goalOff = goalOffM / config.cellSize;
    this.spriteBuffer.setGoals(goalOff, config.gridW / 2, config.gridH / 2, rinkCellsW / 2, rinkCellsH / 2);

    this.lightingMgr.resetToAuto();
  }

  /** Switch the active machine type (zamboni or shovel). */
  switchMachine(type: MachineType) {
    if (this.machineType === type) return;
    this.zamboni.stop();
    this.machineType = type;
    this.zamboni = new Zamboni(this.config, this.maskData, type, this.solidsData);
  }

  /** Rewrite markings buffer (e.g. when layout changes). */
  updateMarkings(layout: MarkingLayout) {
    this.markingLayout = layout;
    this.markingsDataCpu = createMarkings(this.config, this.maskData, layout);
    this.device.queue.writeBuffer(this.markingsBuffer, 0, this.markingsDataCpu);
  }

  /** Paint a circle of markings at grid position. */
  paintAtGrid(gx: number, gy: number, markType: number) {
    const radius = 3;
    let changed = false;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const ix = gx + dx;
        const iy = gy + dy;
        if (ix >= 0 && ix < this.config.gridW && iy >= 0 && iy < this.config.gridH) {
          const canPaint = this.maskData[iy * this.config.gridW + ix] > 0.5 || this.config.isBackyard;
          if (canPaint) {
            this.markingsDataCpu[iy * this.config.gridW + ix] = markType;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      this.device.queue.writeBuffer(this.markingsBuffer, 0, this.markingsDataCpu);
    }
  }

  /** Run simulation + update game objects for one frame. Returns computed timeOfDay. */
  update(inputs: SceneInputs): { timeOfDay: number } {
    const { simSecsPerFrame, paused } = inputs;
    let ambientTemp = inputs.ambientTemp;

    // Event scheduler
    if (this.scheduler.autoMode && !paused) {
      const evt = this.scheduler.currentEvent;
      ambientTemp = evt.ambient;

      // Spawn/clear skaters on event transitions
      const evtKey = `${evt.type}_${evt.name}`;
      if (evtKey !== this.lastEventType) {
        this.lastEventType = evtKey;
        this.skaterSim.clear();
        if (evt.type === 'hockey_practice') {
          this.skaterSim.spawn('hockey', 12);
        } else if (evt.type === 'figure_skating') {
          this.skaterSim.spawn('figure', 6);
        } else if (evt.type === 'public_skate') {
          this.skaterSim.spawn('public', 16);
        }
      }
    } else {
      if (!this.scheduler.autoMode && this.lastEventType !== '') {
        this.lastEventType = '';
        this.skaterSim.clear();
      }
    }

    const encoder = this.device.createCommandEncoder();
    const zp = this.zamboni.getParams();

    if (!paused) {
      this.simulation.updateWind(simSecsPerFrame);
      const { dispatches, dt } = this.simulation.plan(simSecsPerFrame);

      const damageParams = this.interaction.getDamageParams();
      const damageInput: DamageInput | undefined = damageParams.active ? {
        active: true,
        gridX: damageParams.gridX,
        gridY: damageParams.gridY,
        radius: damageParams.radius,
        mode: damageParams.mode,
        amount: damageParams.amount,
        temp: damageParams.temp,
        velocityX: damageParams.velocityX,
        velocityY: damageParams.velocityY,
      } : undefined;

      this.zamboni.update(simSecsPerFrame);
      const zamboniInput: ZamboniInput | undefined = zp.active ? {
        active: true,
        x: zp.x,
        y: zp.y,
        width: zp.width,
        length: zp.length,
        dir: zp.dir,
        waterRate: zp.waterRate,
        heatTemp: zp.heatTemp,
        speed: zp.speed,
        shaveDepth: zp.shaveDepth,
        bladeDown: zp.bladeDown,
        waterOn: zp.waterOn,
      } : undefined;

      // Auto-mode: scheduler triggers zamboni/shovel and auto-damage
      let firstDamage = damageInput;
      if (this.scheduler.autoMode) {
        const result = this.scheduler.update(simSecsPerFrame);
        if (result.triggerZamboni && !this.zamboni.active) {
          if (result.triggerMachineType && result.triggerMachineType !== this.machineType) {
            this.switchMachine(result.triggerMachineType);
          }
          this.zamboni.start();
        }
        if (result.autoDamage && !damageInput) {
          const autoRadius = result.autoDamage.type === 'hockey' ? 5 : 6;
          firstDamage = {
            active: true,
            gridX: result.autoDamage.x,
            gridY: result.autoDamage.y,
            radius: autoRadius,
            mode: 1,
          };
        }
      }

      // Compute rain override based on weather controls
      let rainOverride: number | undefined;
      if (!this.config.isIndoor) {
        const pm = inputs.precipMode;
        const intensity = inputs.precipIntensity;
        if (inputs.weatherAuto) {
          // Auto: default rain logic, but scale by intensity
          if (ambientTemp > 0) {
            rainOverride = 0.008 * ambientTemp * dt * intensity;
          }
          // auto snow: no sim rain (snow is visual only via particles)
        } else if (pm === 'none') {
          rainOverride = 0;
        } else if (pm === 'rain') {
          rainOverride = 0.008 * 5 * dt * intensity; // moderate rain
        } else if (pm === 'snow') {
          rainOverride = 0; // snow is visual, no sim rain
        }
        // 'auto' when !weatherAuto: undefined → uses default in writeParams
      }

      // One-shot events
      const hasOneShot = this.pendingFlood > 0 || this.pendingSnow > 0 || firstDamage !== damageInput;
      if (hasOneShot) {
        this.simulation.writeParams(inputs.pipeTemp, ambientTemp, this.pendingFlood, dt, firstDamage, zamboniInput, this.pendingSnow, rainOverride, inputs.simTunables);
        const oneShotEnc = this.device.createCommandEncoder();
        this.simulation.step(oneShotEnc);
        this.device.queue.submit([oneShotEnc.finish()]);
        this.pendingFlood = 0;
        this.pendingSnow = 0;
      }
      this.simulation.writeParams(inputs.pipeTemp, ambientTemp, 0, dt, damageInput, zamboniInput, 0, rainOverride, inputs.simTunables);
      const normalSteps = hasOneShot ? dispatches - 1 : dispatches;
      for (let i = 0; i < normalSteps; i++) {
        this.simulation.step(encoder);
      }
      this.simTime += simSecsPerFrame;
    } else {
      this.simulation.writeParams(inputs.pipeTemp, ambientTemp, 0, 1, undefined, undefined, 0, undefined, inputs.simTunables);
    }

    // Cloud cover (computed early for weather particle logic)
    let cloudCover = 0;
    if (!this.config.isIndoor) {
      if (inputs.weatherAuto) {
        if (ambientTemp > 0) {
          cloudCover = 0.6 + 0.3 * Math.min(Math.max(ambientTemp / 10, 0), 1);
        } else if (ambientTemp < -5) {
          cloudCover = 0.1;
        } else {
          cloudCover = 0.3;
        }
      } else {
        cloudCover = inputs.cloudCoverManual;
      }
    }

    // Particles: emit + update + apply deposits
    if (!paused) {
      const dp = this.interaction.getDamageParams();
      if (dp.active && (dp.type === 'water_gun' || dp.type === 'snow_gun')) {
        const ptype = dp.type === 'water_gun' ? 'water' as const : 'snow' as const;
        this.particleMgr.emit(dp.gridX, dp.gridY, dp.velocityX, dp.velocityY, ptype, this.interaction.toolSettings);
      }
      // Snowball gun: rate-limited emission using spread slider as rate (1-10)
      if (dp.active && dp.type === 'snowball_gun') {
        const rate = this.interaction.toolSettings.spread; // 1-10 snowballs/sec
        this._snowballAccum += simSecsPerFrame * rate;
        while (this._snowballAccum >= 1) {
          this._snowballAccum -= 1;
          this.particleMgr.emitSnowball(dp.gridX, dp.gridY, dp.velocityX, dp.velocityY, this.interaction.toolSettings);
        }
      } else {
        this._snowballAccum = 0;
      }

      // Weather particles (outdoor only)
      if (!this.config.isIndoor) {
        let weatherType: 'weather_snow' | 'weather_rain' | null = null;
        if (inputs.weatherAuto) {
          if (ambientTemp > 0) weatherType = 'weather_rain';
          else if (ambientTemp < 2 && cloudCover > 0.4) weatherType = 'weather_snow';
        } else {
          const pm = inputs.precipMode;
          if (pm === 'rain') weatherType = 'weather_rain';
          else if (pm === 'snow') weatherType = 'weather_snow';
          // 'none' or 'auto' with manual: auto uses same logic
          else if (pm === 'auto') {
            if (ambientTemp > 0) weatherType = 'weather_rain';
            else if (ambientTemp < 2 && cloudCover > 0.4) weatherType = 'weather_snow';
          }
        }
        if (weatherType) {
          this.particleMgr.emitWeather(
            weatherType,
            this.simulation.windX,
            this.simulation.windY,
            this.config.gridW,
            this.config.gridH,
            inputs.precipIntensity,
          );
        }
      }

      const particleDt = Math.min(simSecsPerFrame, 1 / 30); // cap particle dt
      const deposits = this.particleMgr.update(particleDt, this.simulation.windX, this.simulation.windY);

      // Apply landed deposits to simulation state
      if (deposits.length > 0) {
        this.applyDeposits(deposits);
      }

      // Feed cached state for temperature-dependent landing
      this.particleMgr.setCachedState(this.cachedStateData);
    }
    this.renderer.updateParticles(this.particleMgr.getRenderData());

    // Sprites
    this.spriteBuffer.setZamboni(zp);
    if (!paused && this.skaterSim.count > 0) {
      this.skaterSim.update(simSecsPerFrame);
    }
    this.skaterSim.writeToSpriteBuffer(this.spriteBuffer);
    this.renderer.updateSprites(this.spriteBuffer.getBuffer());

    // Time of day
    let timeOfDay: number;
    if (inputs.timeManual) {
      timeOfDay = inputs.timeOfDay;
    } else {
      timeOfDay = ((this.simTime / 3600) + 6) % 24;
    }

    // Current event for lighting
    const currentEvtType = (this.scheduler.autoMode && !paused) ? this.scheduler.currentEvent.type : undefined;
    const lighting = this.lightingMgr.getLighting(timeOfDay, currentEvtType);

    // Render params
    const rinkCellsW = this.config.dims.lengthM / this.config.cellSize;
    const rinkCellsH = this.config.dims.widthM / this.config.cellSize;

    // Physically-based sun/sky colors from Rayleigh+Mie atmospheric scattering
    const atmosphere = computeAtmosphere(timeOfDay, cloudCover);

    const renderOpts: RenderOptions = {
      showPipes: inputs.showPipes,
      showMarkings: inputs.showMarkings,
      crossX: inputs.cursorGridX,
      crossY: inputs.cursorGridY,
      showCrossLine: true,
      renderMode: inputs.renderMode,
      isOutdoor: !this.config.isIndoor,
      isBackyard: this.config.isBackyard,
      simTime: this.simTime,
      rinkCx: this.config.gridW / 2,
      rinkCy: this.config.gridH / 2,
      rinkHx: rinkCellsW / 2,
      rinkHy: rinkCellsH / 2,
      rinkCr: this.config.dims.cornerRadiusM / this.config.cellSize,
      goalOffset: (this.config.preset === 'olympic' ? 4.0
        : this.config.isBackyard ? Math.min(2.0, this.config.dims.lengthM * 0.2)
        : 3.35) / this.config.cellSize,
      animTime: inputs.animTime,
      timeOfDay,
      lights: lighting.lights,
      skyBrightness: lighting.skyBrightness,
      fogDensity: lighting.fogDensity,
      cloudCover,
      groundColor: this.config.groundColor,
      surfaceGroundColor: this.config.surfaceGroundColor,
      selectedLight: inputs.selectedLight,
      lightToolActive: inputs.lightToolActive,
      sunDir: atmosphere.sunDir,
      sunColor: atmosphere.sunColor,
      skyColor: atmosphere.skyColor,
      moonDir: atmosphere.moonDir,
      moonPhase: atmosphere.moonPhase,
      renderFlags: inputs.renderFlags,
    };

    this.renderOpts = renderOpts;
    this.encoder = encoder;

    return { timeOfDay };
  }

  // Temp storage between update() and render()
  private renderOpts: RenderOptions | null = null;
  private encoder: GPUCommandEncoder | null = null;

  /** Render the scene (main view + cross-section). Call after update(). */
  render(
    mainView: GPUTextureView,
    csView: GPUTextureView,
    csW: number,
    csH: number,
  ) {
    if (!this.encoder || !this.renderOpts) return;

    this.renderer.render(this.encoder, mainView, this.simulation.currentBufferIndex, this.renderOpts);

    this.crossSection.render(
      this.encoder,
      csView,
      this.simulation.currentBufferIndex,
      this.renderOpts.crossX,
      this.renderOpts.crossY,
      csW,
      csH,
      !this.config.isIndoor,
      this.lastHasMarking,
      this.lastLayout,
      GROUND_TYPE_MAP[this.config.surfaceGroundType],
      this.config.hasPipes,
    );

    this.device.queue.submit([this.encoder.finish()]);
    this.encoder = null;

    // Quality readback
    this.frameCount++;
    if (this.frameCount % 60 === 0) {
      this.updateQuality();
    }
  }

  /** Refresh cross-section label data from cached state. */
  getCrossSectionData(cursorGridX: number, cursorGridY: number): {
    iceMm: number; waterMm: number; shavingsMm: number;
    temp: number; flowPos: number; markingType: number;
  } | null {
    if (!this.cachedStateData || !this.pipeLayoutData) return null;
    const idx = cursorGridY * this.config.gridW + cursorGridX;
    if (idx < 0 || idx * 4 + 3 >= this.cachedStateData.length) return null;
    return {
      temp: this.cachedStateData[idx * 4 + 0],
      iceMm: this.cachedStateData[idx * 4 + 1],
      waterMm: this.cachedStateData[idx * 4 + 2],
      shavingsMm: this.cachedStateData[idx * 4 + 3],
      flowPos: this.pipeLayoutData[idx],
      markingType: this.markingsDataCpu ? this.markingsDataCpu[idx] : 0,
    };
  }

  /** Update the stored layout from cross-section data (called from main). */
  updateLayerLayout(iceMm: number, waterMm: number, shavingsMm: number, hasMarking: boolean, cellTemp: number) {
    const isOutdoor = !this.config.isIndoor;
    this.lastLayout = computeLayerLayout(iceMm, waterMm, shavingsMm, hasMarking, isOutdoor, cellTemp);
    this.lastHasMarking = hasMarking;
  }

  /** Prep: instantly set rink to game-ready frozen state. */
  prep() {
    const iceMm = this.config.isBackyard ? 18 : 25;
    const temp = this.config.isBackyard ? -4 : -7;
    const state = createInitialState(this.config, temp, 0, this.maskData, iceMm);
    this.simulation.reset(state);
    // Clear scratch buffer (pristine surface)
    const cellCount = this.config.gridW * this.config.gridH;
    this.device.queue.writeBuffer(this.scratchBuffer, 0, new Uint32Array(cellCount));
    this.cachedStateData = null;
    this.zamboni.stop();
    this.skaterSim.clear();
    this.particleMgr.clear();
  }

  /** Reset the simulation to initial state. */
  reset(ambientTemp: number) {
    const resetIce = this.config.isBackyard ? 0 : 12;
    const resetWater = 0;
    const resetTemp = this.config.isBackyard ? ambientTemp : -4;
    const state = createInitialState(this.config, resetTemp, resetWater, this.maskData, resetIce);
    this.simulation.reset(state);
    // Clear scratch buffer
    const cellCount = this.config.gridW * this.config.gridH;
    this.device.queue.writeBuffer(this.scratchBuffer, 0, new Uint32Array(cellCount));
    this.simTime = 0;
    this.zamboni.stop();
    this.scheduler.reset();
    this.cachedStateData = null;
    this.lastEventType = '';
    this.skaterSim.clear();
    this.particleMgr.clear();
  }

  /** Apply landed particle deposits to the simulation state buffer. */
  private applyDeposits(deposits: LandedDeposit[]) {
    // Accumulate deposits per cell
    const cellDeposits = new Map<number, { heat: number; ice: number; water: number; snow: number }>();
    for (const d of deposits) {
      const existing = cellDeposits.get(d.cellIdx);
      if (existing) {
        existing.heat += d.heatDelta;
        existing.ice += d.iceDelta;
        existing.water += d.waterDelta;
        existing.snow += d.snowDelta;
      } else {
        cellDeposits.set(d.cellIdx, { heat: d.heatDelta, ice: d.iceDelta, water: d.waterDelta, snow: d.snowDelta });
      }
    }

    // Read current state from cache (approximate), write delta to both buffers
    // This is a simple approach: add deposits to the current state buffer via writeBuffer
    const [bufA, bufB] = this.simulation.temperatureBuffers;
    const currentIdx = this.simulation.currentBufferIndex;
    const currentBuf = currentIdx === 0 ? bufA : bufB;

    for (const [cellIdx, dep] of cellDeposits) {
      if (this.cachedStateData && cellIdx * 4 + 3 < this.cachedStateData.length) {
        const data = new Float32Array(4);
        data[0] = this.cachedStateData[cellIdx * 4 + 0] + dep.heat;
        data[1] = Math.max(0, this.cachedStateData[cellIdx * 4 + 1] + dep.ice);
        data[2] = Math.max(0, this.cachedStateData[cellIdx * 4 + 2] + dep.water);
        data[3] = Math.max(0, this.cachedStateData[cellIdx * 4 + 3] + dep.snow);
        this.device.queue.writeBuffer(currentBuf, cellIdx * 16, data);
      }
    }
  }

  /** Async readback for quality metrics. */
  private async updateQuality() {
    if (this.pendingQuality) return;
    this.pendingQuality = true;
    try {
      const data = await this.simulation.readState();
      this.cachedStateData = data;
      this.latestMetrics = calculateQualityMetrics(data, this.config.gridW, this.config.gridH, this.maskData);
    } catch {
      // Ignore readback errors
    }
    this.pendingQuality = false;
  }

  /** Get serializable state snapshot (async due to GPU readback). */
  async getState(ambientTemp: number, pipeTemp: number, timeOfDay: number): Promise<SceneState> {
    const stateData = await this.simulation.readState();
    return {
      preset: this.config.preset,
      customDims: this.config.preset === 'custom' ? { ...this.config.dims } : undefined,
      markingLayout: this.markingLayout,
      simTime: this.simTime,
      stateData,
      ambientTemp,
      pipeTemp,
      timeOfDay,
      zamboniActive: this.zamboni.active,
      machineType: this.machineType,
      schedulerState: {
        currentIndex: 0, // simplified — scheduler doesn't expose internals
        elapsed: 0,
        autoMode: this.scheduler.autoMode,
      },
      lightingMode: this.lightingMgr.mode,
      manualLights: this.lightingMgr.mode === 'manual' ? this.lightingMgr.manualLights.map(l => ({ ...l })) : undefined,
    };
  }

  /** Destroy all GPU resources. */
  dispose() {
    this.simulation.destroy();
    this.renderer.destroy();
    this.crossSection.destroy();
    this.maskBuffer.destroy();
    this.markingsBuffer.destroy();
    this.solidsBuffer.destroy();
    this.scratchBuffer.destroy();
  }
}
