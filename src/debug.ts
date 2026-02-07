/**
 * Debug console API — accessible via window.iceDebug in the browser console.
 * Provides read/write access to simulation state for inspection and control.
 */
import { SceneManager } from './sceneManager';
import { Scene } from './scene';

export interface DebugCallbacks {
  setAmbient: (temp: number) => void;
  togglePause: () => void;
  triggerFlood: () => void;
  triggerZamboni: () => void;
  triggerShovel: () => void;
  addSnow: (mm: number) => void;
}

export class IceDebug {
  private sceneManager: SceneManager;
  private canvas: HTMLCanvasElement;
  private cb: DebugCallbacks;

  constructor(sceneManager: SceneManager, canvas: HTMLCanvasElement, callbacks: DebugCallbacks) {
    this.sceneManager = sceneManager;
    this.canvas = canvas;
    this.cb = callbacks;
    console.log('[IceDebug] Debug API ready. Try: iceDebug.help()');
  }

  private get scene(): Scene {
    return this.sceneManager.activeScene!;
  }

  // ==================== READ METHODS ====================

  /** Print available commands. */
  help(): string[] {
    return [
      'READ:',
      '  getCell(x, y)       — cell state at grid position',
      '  getCellRange(x0,y0,x1,y1) — batch cell query',
      '  getMetrics()        — ice quality metrics',
      '  getConfig()         — rink configuration',
      '  getSimTime()        — simulation time in seconds',
      '  getZamboni()        — zamboni/machine state',
      '  getSkaters()        — active skater positions',
      '  getCamera()         — camera state (3D view)',
      '  getWind()           — wind vector',
      '  getEvent()          — current event (auto mode)',
      'WRITE:',
      '  setAmbient(temp)    — set ambient temperature',
      '  togglePause()       — toggle pause',
      '  triggerZamboni()    — start zamboni',
      '  triggerShovel()     — start shovel',
      '  triggerFlood()      — add flood water',
      '  addSnow(mm)         — add snow/shavings',
      '  setCameraPreset(p)  — corner|top|front|side|tv|oblique',
      '  screenshot()        — return canvas data URL',
      '  readFullState()     — async GPU readback of full state',
    ];
  }

  /** Get all state for a single cell. */
  getCell(x: number, y: number): object | null {
    const s = this.scene;
    if (x < 0 || x >= s.config.gridW || y < 0 || y >= s.config.gridH) {
      return null;
    }
    const idx = y * s.config.gridW + x;
    const state = s.cachedStateData;
    const result: any = { x, y, idx };

    if (state && idx * 4 + 3 < state.length) {
      result.temperature = state[idx * 4 + 0];
      result.ice_mm = state[idx * 4 + 1];
      result.water_mm = state[idx * 4 + 2];
      result.shavings_mm = state[idx * 4 + 3];
    } else {
      result.state = '(no cached data — wait for readback)';
    }

    result.mask = s.maskData[idx];
    result.pipe = s.pipeLayoutData[idx];
    result.marking = s.markingsDataCpu ? s.markingsDataCpu[idx] : 0;
    result.solid = s.solidsData[idx];

    return result;
  }

  /** Batch cell query over a rectangle. */
  getCellRange(x0: number, y0: number, x1: number, y1: number): object[] {
    const cells: object[] = [];
    const cx0 = Math.max(0, x0);
    const cy0 = Math.max(0, y0);
    const cx1 = Math.min(this.scene.config.gridW - 1, x1);
    const cy1 = Math.min(this.scene.config.gridH - 1, y1);
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const cell = this.getCell(x, y);
        if (cell) cells.push(cell);
      }
    }
    return cells;
  }

  /** Get latest quality metrics. */
  getMetrics(): object | null {
    return this.scene.latestMetrics;
  }

  /** Get rink configuration summary. */
  getConfig(): object {
    const c = this.scene.config;
    return {
      preset: c.preset,
      gridW: c.gridW,
      gridH: c.gridH,
      cellSize: c.cellSize,
      lengthM: c.dims.lengthM,
      widthM: c.dims.widthM,
      cornerRadiusM: c.dims.cornerRadiusM,
      isIndoor: c.isIndoor,
      isBackyard: c.isBackyard,
      hasPipes: c.hasPipes,
      groundType: c.groundType,
      surfaceGroundType: c.surfaceGroundType,
    };
  }

  /** Get simulation time in seconds. */
  getSimTime(): number {
    return this.scene.simTime;
  }

  /** Get zamboni/machine state. */
  getZamboni(): object {
    const s = this.scene;
    const z = s.zamboni;
    const p = z.getParams();
    return {
      active: z.active,
      machineType: s.machineType,
      x: p.x,
      y: p.y,
      dir: p.dir,
      bladeDown: p.bladeDown,
      waterOn: p.waterOn,
      width: p.width,
      length: p.length,
      speed: p.speed,
      shaveDepth: p.shaveDepth,
      waterRate: p.waterRate,
      heatTemp: p.heatTemp,
    };
  }

  /** Get active skater positions and info. */
  getSkaters(): object[] {
    return this.scene.skaterSim.getActiveSkaters();
  }

  /** Get camera state (3D view). */
  getCamera(): object {
    return this.scene.isoRenderer.camera.getState();
  }

  /** Get wind vector. */
  getWind(): object {
    const s = this.scene;
    const wx = s.simulation.windX;
    const wy = s.simulation.windY;
    return {
      windX: wx,
      windY: wy,
      speed_ms: Math.sqrt(wx * wx + wy * wy) * s.config.cellSize,
      direction_deg: (Math.atan2(-wx, -wy) * 180 / Math.PI + 360) % 360,
    };
  }

  /** Get current event (auto mode). */
  getEvent(): object {
    const sched = this.scene.scheduler;
    return {
      autoMode: sched.autoMode,
      event: sched.currentEvent,
      timeRemaining: sched.timeRemaining,
      progress: sched.progressFraction,
    };
  }

  // ==================== WRITE METHODS ====================

  /** Set ambient temperature. */
  setAmbient(temp: number) {
    this.cb.setAmbient(temp);
  }

  /** Toggle pause. */
  togglePause() {
    this.cb.togglePause();
  }

  /** Start zamboni. */
  triggerZamboni() {
    this.cb.triggerZamboni();
  }

  /** Start shovel. */
  triggerShovel() {
    this.cb.triggerShovel();
  }

  /** Add flood water. */
  triggerFlood() {
    this.cb.triggerFlood();
  }

  /** Add snow/shavings (mm). */
  addSnow(mm: number = 1.5) {
    this.cb.addSnow(mm);
  }

  /** Set camera to a named preset. */
  setCameraPreset(preset: 'corner' | 'top' | 'front' | 'side' | 'tv' | 'oblique') {
    this.scene.isoRenderer.camera.setPreset(preset);
  }

  /** Return canvas as data URL (PNG). */
  screenshot(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Async: full GPU readback of simulation state. */
  async readFullState(): Promise<Float32Array> {
    return await this.scene.simulation.readState();
  }
}
