import {
  RinkConfig, RinkPreset, GroundType,
  createRinkMask, createPipeLayout, createInitialState, createInitialState2,
} from './rink';

const GROUND_TYPE_MAP: Record<GroundType, number> = {
  concrete: 0, grass: 1, gravel: 2, asphalt: 3,
};
import { Simulation, DamageInput, ZamboniInput, SimTunables } from './simulation';
import { Renderer, RenderOptions } from './renderer';
import { IsometricRenderer } from './isometricRenderer';
import { CrossSection, computeLayerLayout, LayerLayout } from './crossSection';
import { createMarkings, MarkingLayout } from './markings';
import { createSolidsBuffer, addFenceToSolids } from './solids';
import { InteractionManager } from './interaction';
import { Zamboni, MachineType } from './zamboni';
import { EventScheduler, calculateQualityMetrics, QualityMetrics } from './events';
import { SkaterSimulation } from './skaters';
import { SpriteBuffer, SPRITE_BUFFER_SIZE } from './sprites';
import { LightingManager, LightDef, computeAtmosphere } from './lighting';
import { ParticleManager, LandedDeposit } from './particles';
import { EnvironmentMap, EnvLighting } from './envMap';
import { TVCameraController, TVContext } from './tvCamera';

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
  exposure: number;
  contrast: number;
  saturation: number;
  skyMode: 'physical' | 'skybox';
  hdSurface: boolean;
  damageVis: number;
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
  spriteGpuBuffer: GPUBuffer; // shared sprite buffer for compute shader

  // CPU data copies
  maskData: Float32Array;
  pipeLayoutData: Float32Array;
  markingsDataCpu: Float32Array;
  solidsData: Float32Array;
  cachedStateData: Float32Array | null = null;
  cachedState2Data: Float32Array | null = null;

  // Systems
  simulation: Simulation;
  renderer: Renderer;
  isoRenderer: IsometricRenderer;
  crossSection: CrossSection;
  zamboni: Zamboni;
  scheduler: EventScheduler;
  skaterSim: SkaterSimulation;
  lightingMgr: LightingManager;
  spriteBuffer: SpriteBuffer;
  interaction: InteractionManager;
  particleMgr: ParticleManager;
  envMap: EnvironmentMap;
  tvCamera: TVCameraController;

  // Machine type
  machineType: MachineType;

  // Fence state
  fenceEnabled = false;

  // Scene state
  simTime = 0;
  pendingFlood = 0;
  pendingSnow = 0;
  frameCount = 0;
  lastEventType = '';

  // Crowd density (0.0-1.0, spectator fill for indoor arena seats)
  crowdDensity = 0;
  private _crowdTarget = 0;

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

    // Shared GPU sprite buffer (read by compute shader for skater effects)
    this.spriteGpuBuffer = device.createBuffer({
      size: SPRITE_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Initial state
    const startIce = config.isBackyard ? 0 : 12;
    const startWater = 0;
    const startTemp = config.isBackyard ? ambientTemp : -4;
    const initialState = createInitialState(config, startTemp, startWater, this.maskData, startIce);
    const initialState2 = createInitialState2(config, initialState);
    this.simulation = new Simulation(device, config, initialState, initialState2, this.pipeLayoutData, this.maskBuffer, this.solidsBuffer, this.scratchBuffer, this.spriteGpuBuffer);

    // Markings
    this.markingsDataCpu = createMarkings(config, this.maskData, markingLayout);
    this.markingsBuffer = device.createBuffer({
      size: this.markingsDataCpu.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.markingsBuffer, 0, this.markingsDataCpu);

    // Environment map (HDRI for 3D view reflections)
    this.envMap = new EnvironmentMap(device);

    // Renderers & cross-section
    this.renderer = new Renderer(device, format, config, this.simulation, this.markingsBuffer, this.maskBuffer, this.scratchBuffer);
    this.isoRenderer = new IsometricRenderer(device, format, config, this.simulation, this.markingsBuffer, this.envMap.buffer, this.maskBuffer, this.solidsBuffer, this.scratchBuffer);
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

    // TV broadcast camera
    this.tvCamera = new TVCameraController(this.isoRenderer.camera, config.gridW, config.gridH);
  }

  /** Switch the active machine type (zamboni or shovel). */
  switchMachine(type: MachineType) {
    if (this.machineType === type) return;
    this.zamboni.stop();
    this.machineType = type;
    this.zamboni = new Zamboni(this.config, this.maskData, type, this.solidsData);
  }

  /** Toggle fence around backyard rink. */
  toggleFence(enabled: boolean) {
    this.fenceEnabled = enabled;
    // Rebuild solids: start fresh from goals, optionally add fence
    this.solidsData = createSolidsBuffer(this.config, this.maskData);
    if (enabled && this.config.isBackyard) {
      addFenceToSolids(this.solidsData, this.config, this.maskData);
    }
    this.device.queue.writeBuffer(this.solidsBuffer, 0, this.solidsData);
    // Rebuild zamboni/skater systems that reference solids
    this.zamboni = new Zamboni(this.config, this.maskData, this.machineType, this.solidsData);
    this.particleMgr = new ParticleManager(this.config.gridW, this.config.gridH, this.config.cellSize, this.solidsData);
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

    // Crowd density: ramp toward target based on event type
    if (this.scheduler.autoMode && !paused && this.config.isIndoor) {
      const evt = this.scheduler.currentEvent;
      switch (evt.type) {
        case 'hockey_practice': this._crowdTarget = evt.name.includes('Game') ? 0.9 : 0.7; break;
        case 'figure_skating': this._crowdTarget = 0.5; break;
        case 'public_skate': this._crowdTarget = 0.4; break;
        case 'maintenance': this._crowdTarget = 0.05; break;
        case 'idle': this._crowdTarget = 0; break;
      }
      // Smooth ramp: 30-min ramp up (1800s), 15-min ramp down (900s)
      const rampSpeed = this.crowdDensity < this._crowdTarget ? simSecsPerFrame / 1800 : simSecsPerFrame / 900;
      if (Math.abs(this.crowdDensity - this._crowdTarget) < rampSpeed) {
        this.crowdDensity = this._crowdTarget;
      } else if (this.crowdDensity < this._crowdTarget) {
        this.crowdDensity += rampSpeed;
      } else {
        this.crowdDensity -= rampSpeed;
      }
      this.crowdDensity = Math.max(0, Math.min(1, this.crowdDensity));
    } else if (!this.scheduler.autoMode) {
      this.crowdDensity = 0;
      this._crowdTarget = 0;
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

      // Skater surface damage: handled GPU-side in heat.wgsl via sprite buffer (binding 9)

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
    const particleData = this.particleMgr.getRenderData();
    this.renderer.updateParticles(particleData);
    // Note: isoRenderer doesn't render particles yet

    // Sprites
    this.spriteBuffer.setZamboni(zp);
    if (!paused && this.skaterSim.count > 0) {
      this.skaterSim.update(simSecsPerFrame);
    }
    this.skaterSim.writeToSpriteBuffer(this.spriteBuffer);

    // TV camera update
    if (this.tvCamera.active && !paused) {
      const tvContext: TVContext = {
        zamboniActive: zp.active,
        zamboniX: zp.x,
        zamboniY: zp.y,
        zamboniDir: zp.dir,
        skaterPositions: this.skaterSim.getPositions(),
        stateData: this.cachedStateData,
        gridW: this.config.gridW,
        gridH: this.config.gridH,
      };
      this.tvCamera.update(simSecsPerFrame, tvContext);
    }
    const spriteData = this.spriteBuffer.getBuffer();
    this.renderer.updateSprites(spriteData);
    this.isoRenderer.updateSprites(spriteData);
    // Update compute shader sprite buffer (for GPU-side skater damage/snow interaction)
    this.device.queue.writeBuffer(this.spriteGpuBuffer, 0, spriteData);

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

    // In skybox mode (3D view), override sun/sky with HDRI-matched lighting
    // so the directional lighting matches the sky dome photograph
    // Indoor arenas always use 'clear' HDRI — they have their own lights, time shouldn't affect them
    const envPreset = this.config.isIndoor ? 'clear' as const : EnvironmentMap.presetForTime(timeOfDay, cloudCover);
    const useSkyboxLighting = inputs.skyMode === 'skybox' && inputs.renderMode === 3;
    let sunDir = atmosphere.sunDir;
    let sunColor = atmosphere.sunColor;
    let skyColor = atmosphere.skyColor;
    let skyBrightness = lighting.skyBrightness;

    if (useSkyboxLighting) {
      const envLighting = EnvironmentMap.lightingForPreset(envPreset);
      sunDir = envLighting.sunDir;
      sunColor = envLighting.sunColor;
      skyColor = envLighting.skyColor;
      skyBrightness = envLighting.skyBrightness;
    }

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
      skyBrightness,
      fogDensity: lighting.fogDensity,
      cloudCover,
      groundColor: this.config.groundColor,
      surfaceGroundColor: this.config.surfaceGroundColor,
      selectedLight: inputs.selectedLight,
      lightToolActive: inputs.lightToolActive,
      sunDir,
      sunColor,
      skyColor,
      moonDir: atmosphere.moonDir,
      moonPhase: atmosphere.moonPhase,
      renderFlags: inputs.renderFlags,
      exposure: inputs.exposure * this.computeAutoExposure(skyBrightness, sunColor, skyColor, timeOfDay, cloudCover),
      contrast: inputs.contrast,
      saturation: inputs.saturation,
      skyMode: inputs.skyMode,
      groundType: GROUND_TYPE_MAP[this.config.surfaceGroundType],
      surroundGroundType: GROUND_TYPE_MAP[this.config.groundType],
      hdSurface: inputs.hdSurface,
      crowdDensity: this.crowdDensity,
      damageVis: inputs.damageVis,
    };

    this.renderOpts = renderOpts;
    this.encoder = encoder;

    // Load appropriate HDRI env map for current conditions (async, non-blocking)
    // Also load for indoor rinks when skybox mode is active (for sky dome rendering)
    if (!this.config.isIndoor || inputs.skyMode === 'skybox') {
      this.envMap.load(envPreset);
    }

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
    mainW?: number,
    mainH?: number,
  ) {
    if (!this.encoder || !this.renderOpts) return;

    // Use grid dimensions if main canvas size not provided
    const canvasW = mainW ?? this.config.gridW;
    const canvasH = mainH ?? this.config.gridH;

    // Choose renderer based on mode (3 = isometric)
    if (this.renderOpts.renderMode === 3) {
      this.isoRenderer.render(this.encoder, mainView, this.simulation.currentBufferIndex, this.renderOpts, canvasW, canvasH);
    } else {
      this.renderer.render(this.encoder, mainView, this.simulation.currentBufferIndex, this.renderOpts);
    }

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
    snowDensity: number; snowLwc: number; mudAmount: number;
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
      snowDensity: this.cachedState2Data ? this.cachedState2Data[idx * 4 + 0] : 0,
      snowLwc: this.cachedState2Data ? this.cachedState2Data[idx * 4 + 1] : 0,
      mudAmount: this.cachedState2Data ? this.cachedState2Data[idx * 4 + 2] : 0,
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
    const state2 = createInitialState2(this.config, state);
    this.simulation.reset(state, state2);
    // Clear scratch buffer (pristine surface)
    const cellCount = this.config.gridW * this.config.gridH;
    this.device.queue.writeBuffer(this.scratchBuffer, 0, new Uint32Array(cellCount));
    this.cachedStateData = null;
    this.cachedState2Data = null;
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
    const state2 = createInitialState2(this.config, state);
    this.simulation.reset(state, state2);
    // Clear scratch buffer
    const cellCount = this.config.gridW * this.config.gridH;
    this.device.queue.writeBuffer(this.scratchBuffer, 0, new Uint32Array(cellCount));
    this.simTime = 0;
    this.zamboni.stop();
    this.scheduler.reset();
    this.cachedStateData = null;
    this.cachedState2Data = null;
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
      // Also read state2 for cross-section display
      const data2 = await this.simulation.readState2();
      this.cachedState2Data = data2;
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

  /** Compute auto-exposure so slider=0 looks correct across all conditions. */
  private computeAutoExposure(
    skyBrightness: number, sunColor: number[], skyColor: number[],
    _timeOfDay: number, cloudCover: number,
  ): number {
    if (this.config.isIndoor) {
      // Indoor: skyBrightness drives arena light panel intensity (panels = brightness*2.0)
      // Full event (~1.0) → 0.30, maintenance (~0.3) → 1.0, off (~0.1) → 3.0
      return 0.30 / Math.max(skyBrightness, 0.05);
    }

    // Outdoor: single formula driven by sun + sky luminance
    const sunLum = sunColor[0] * 0.2126 + sunColor[1] * 0.7152 + sunColor[2] * 0.0722;
    const skyLum = skyColor[0] * 0.2126 + skyColor[1] * 0.7152 + skyColor[2] * 0.0722;

    // Combined scene estimate — sky weighted heavier so twilight/overcast stay balanced
    const sceneLum = sunLum * 0.25 + skyLum * 0.20;

    // Clouds dim direct sun, compensate slightly
    const cloudDim = 1.0 + cloudCover * 0.2;

    // Simple inverse, capped so night stays dark (no artificial lights = dark rink)
    const auto = 0.15 / Math.max(sceneLum + 0.06, 0.06);
    return Math.min(auto * cloudDim, 2.0);
  }

  /** Destroy all GPU resources. */
  dispose() {
    this.simulation.destroy();
    this.renderer.destroy();
    this.isoRenderer.destroy();
    this.crossSection.destroy();
    this.envMap.destroy();
    this.maskBuffer.destroy();
    this.markingsBuffer.destroy();
    this.solidsBuffer.destroy();
    this.scratchBuffer.destroy();
    this.spriteGpuBuffer.destroy();
  }
}
