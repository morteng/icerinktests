import { RinkConfig } from './rink';

export type MachineType = 'zamboni' | 'shovel' | 'water_tank';

export type MachineState =
  | 'idle'
  | 'entering'
  | 'blade_down'
  | 'forward'
  | 'stopping'
  | 'blade_up'
  | 'repositioning'
  | 'exiting';

export interface ZamboniParams {
  active: boolean;
  x: number;
  y: number;
  width: number;     // in grid cells (across rink)
  length: number;    // in grid cells (along travel direction)
  dir: number;       // +1 = right, -1 = left
  waterRate: number; // mm/s water deposited to each cell in water zone while active
  heatTemp: number;  // water temperature °C (65 zamboni, 0 shovel)
  speed: number;     // cells per sim-second
  shaveDepth: number; // mm ice removed per crossing (0.8 zamboni, 0 shovel)
  machineType: MachineType;
  bladeDown: boolean;
  waterOn: boolean;
}

export class Zamboni {
  private config: RinkConfig;
  private mask: Float32Array;
  private solids: Float32Array | null;
  private _machineType: MachineType;

  private _active = false;
  private x = 0;
  private y = 0;
  private dir = 1;  // +1 right, -1 left
  private pass = 0;
  private totalPasses: number;

  // Dimensions in grid cells (set in constructor based on machine type)
  private bodyWidth: number;
  private bodyLength: number;
  private sweepOffset: number;
  private targetSpeed: number;
  private currentSpeed = 0;

  // Resurfacing behavior
  private _waterRate: number;   // mm/s water flow rate
  private _heatTemp: number;    // °C
  private _shaveDepth: number;  // mm per crossing

  // State machine
  private _state: MachineState = 'idle';
  private _bladeDown = false;
  private _waterOn = false;
  private stateTimer = 0;
  private accelTime: number;
  private bladeActuateTime: number;

  // Pre-computed per-row sweep extents from mask
  private rowExtents: { left: number; right: number }[] = [];

  constructor(config: RinkConfig, mask: Float32Array, machineType: MachineType, solids: Float32Array | null = null) {
    this.config = config;
    this.mask = mask;
    this.solids = solids;
    this._machineType = machineType;

    if (machineType === 'shovel') {
      this.bodyWidth = Math.max(Math.round(0.6 / config.cellSize), 4);
      this.bodyLength = Math.max(Math.round(0.3 / config.cellSize), 3);
      this.sweepOffset = this.bodyWidth;
      this.targetSpeed = Math.round(0.8 / config.cellSize);
      this._waterRate = 0;
      this._heatTemp = 0;
      this._shaveDepth = 0;
      this.accelTime = 0.3;
      this.bladeActuateTime = 0; // shovel: skip blade states
    } else if (machineType === 'water_tank') {
      this.bodyWidth = Math.max(Math.round(1.2 / config.cellSize), 6);
      this.bodyLength = Math.max(Math.round(2.0 / config.cellSize), 8);
      this.sweepOffset = this.bodyWidth;
      this.targetSpeed = Math.round(1.5 / config.cellSize);
      this._waterRate = 1.2;
      this._heatTemp = 65;
      this._shaveDepth = 0;
      this.accelTime = 1.0;
      this.bladeActuateTime = 0; // water tank: skip blade states
    } else {
      // Zamboni
      this.bodyWidth = Math.round(1.96 / config.cellSize);
      this.bodyLength = Math.round(3.0 / config.cellSize);
      this.sweepOffset = this.bodyWidth;
      this.targetSpeed = Math.round(2.0 / config.cellSize);
      this._waterRate = 1.7;
      this._heatTemp = 65.0;
      this._shaveDepth = 0.8;
      this.accelTime = 0.5;
      this.bladeActuateTime = 0.5;
    }

    // Pre-compute per-row extents
    for (let y = 0; y < config.gridH; y++) {
      let left = config.gridW, right = -1;
      for (let x = 0; x < config.gridW; x++) {
        if (mask[y * config.gridW + x] > 0.5) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
      this.rowExtents.push({ left, right });
    }

    // Trim extents around goal solids so zamboni stops short of goals
    if (solids) {
      for (let y = 0; y < config.gridH; y++) {
        const ext = this.rowExtents[y];
        if (ext.right < 0) continue;
        while (ext.left < ext.right && solids[y * config.gridW + ext.left] >= 0.5) ext.left++;
        while (ext.right > ext.left && solids[y * config.gridW + ext.right] >= 0.5) ext.right--;
      }
    }

    this.totalPasses = 0;
    for (let y = 0; y < config.gridH; y += this.sweepOffset) {
      const ext = this.rowExtents[y];
      if (ext.right >= 0) this.totalPasses++;
    }
  }

  get active(): boolean { return this._active; }
  get type(): MachineType { return this._machineType; }
  get state(): MachineState { return this._state; }
  get bladeDown(): boolean { return this._bladeDown; }
  get waterOn(): boolean { return this._waterOn; }

  set waterRate(v: number) { this._waterRate = v; }
  get waterRate(): number { return this._waterRate; }
  set heatTemp(v: number) { this._heatTemp = v; }
  get heatTemp(): number { return this._heatTemp; }
  set shaveDepth(v: number) { this._shaveDepth = v; }
  get shaveDepth(): number { return this._shaveDepth; }
  set machineSpeed(v: number) { this.targetSpeed = v / this.config.cellSize; }
  get machineSpeed(): number { return this.targetSpeed * this.config.cellSize; }

  start() {
    if (this._active) return;
    this._active = true;
    this.pass = 0;
    this.dir = 1;
    this.currentSpeed = 0;
    this._bladeDown = false;
    this._waterOn = false;
    this._state = 'entering';
    this.stateTimer = 0;
    this.moveToPass(0);
  }

  stop() {
    this._active = false;
    this._bladeDown = false;
    this._waterOn = false;
    this._state = 'idle';
    this.currentSpeed = 0;
  }

  private moveToPass(passIndex: number) {
    let count = 0;
    for (let y = 0; y < this.config.gridH; y += this.sweepOffset) {
      const ext = this.rowExtents[y];
      if (ext.right < 0) continue;
      if (count === passIndex) {
        this.y = y;
        this.x = this.dir > 0 ? ext.left : ext.right;
        return;
      }
      count++;
    }
  }

  private transitionTo(state: MachineState) {
    this._state = state;
    this.stateTimer = 0;
  }

  update(simSeconds: number) {
    if (!this._active) return;

    this.stateTimer += simSeconds;

    switch (this._state) {
      case 'entering': {
        // Move to first row at 50% speed, blade/water off
        const enterSpeed = this.targetSpeed * 0.5;
        this.currentSpeed = enterSpeed;
        this.x += enterSpeed * simSeconds * this.dir;

        // Check if we've reached the starting position of the first row
        const rowY = Math.max(0, Math.min(Math.round(this.y), this.config.gridH - 1));
        const ext = this.rowExtents[rowY];
        const atStart = this.dir > 0 ? this.x >= ext.left + this.bodyLength : this.x <= ext.right - this.bodyLength;
        if (atStart || this.stateTimer > 2.0) {
          this.transitionTo('blade_down');
        }
        break;
      }

      case 'blade_down': {
        // Wait bladeActuateTime, then lower blade and turn on water
        this.currentSpeed = 0;
        if (this.bladeActuateTime <= 0 || this.stateTimer >= this.bladeActuateTime) {
          this._bladeDown = true;
          this._waterOn = true;
          this.transitionTo('forward');
        }
        break;
      }

      case 'forward': {
        // Accelerate to target speed, advance along row
        if (this.currentSpeed < this.targetSpeed) {
          this.currentSpeed = Math.min(this.targetSpeed, this.currentSpeed + this.targetSpeed / Math.max(this.accelTime, 0.1) * simSeconds);
        }
        this.x += this.currentSpeed * simSeconds * this.dir;

        // Check row end
        const rowY = Math.max(0, Math.min(Math.round(this.y), this.config.gridH - 1));
        const ext = this.rowExtents[rowY];
        if (ext.right < 0) {
          this.transitionTo('exiting');
          break;
        }

        const reachedEnd = this.dir > 0 ? this.x >= ext.right : this.x <= ext.left;
        if (reachedEnd) {
          this.x = this.dir > 0 ? ext.right : ext.left;
          this.transitionTo('stopping');
        }
        break;
      }

      case 'stopping': {
        // Decelerate to 0
        this.currentSpeed = Math.max(0, this.currentSpeed - this.targetSpeed / Math.max(this.accelTime, 0.1) * simSeconds);
        this.x += this.currentSpeed * simSeconds * this.dir;
        if (this.currentSpeed <= 0.01) {
          this.currentSpeed = 0;
          this.transitionTo('blade_up');
        }
        break;
      }

      case 'blade_up': {
        // Raise blade and turn off water, wait bladeActuateTime
        this._bladeDown = false;
        this._waterOn = false;
        this.currentSpeed = 0;
        if (this.bladeActuateTime <= 0 || this.stateTimer >= this.bladeActuateTime) {
          // Advance to next pass
          this.pass++;
          if (this.pass >= this.totalPasses) {
            this.transitionTo('exiting');
          } else {
            this.transitionTo('repositioning');
          }
        }
        break;
      }

      case 'repositioning': {
        // Flip direction, move to next pass row
        this.dir = this.dir > 0 ? -1 : 1;
        this.moveToPass(this.pass);
        this.transitionTo('blade_down');
        break;
      }

      case 'exiting': {
        this._bladeDown = false;
        this._waterOn = false;
        this._active = false;
        this._state = 'idle';
        this.currentSpeed = 0;
        break;
      }
    }
  }

  getParams(): ZamboniParams {
    return {
      active: this._active,
      x: this.x,
      y: this.y,
      width: this.bodyWidth,
      length: this.bodyLength,
      dir: this.dir,
      waterRate: this._waterRate,
      heatTemp: this._heatTemp,
      speed: this.currentSpeed,
      shaveDepth: this._shaveDepth,
      machineType: this._machineType,
      bladeDown: this._bladeDown,
      waterOn: this._waterOn,
    };
  }
}
