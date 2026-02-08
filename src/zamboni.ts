import { RinkConfig } from './rink';

export type MachineType = 'zamboni' | 'shovel' | 'water_tank';

export type MachineState =
  | 'idle'
  | 'entering'
  | 'blade_down'
  | 'forward'
  | 'stopping'
  | 'blade_up'
  | 'turning'
  | 'exiting';

export interface ZamboniParams {
  active: boolean;
  x: number;
  y: number;
  width: number;     // in grid cells (across rink)
  length: number;    // in grid cells (along travel direction)
  dir: number;       // +1 = right, -1 = left
  heading: number;   // radians (0=+X, PI=-X)
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
  private heading = 0; // radians (0=+X, PI=-X)
  private pass = 0;
  private totalPasses: number;

  // Turning arc state
  private arcAngle = 0;        // current angle through the U-turn (0→PI)
  private arcCenterX = 0;      // center of the turning arc
  private arcCenterY = 0;
  private arcRadius = 0;       // radius of the turning arc
  private arcStartHeading = 0; // heading at start of turn

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
  private firstPassY = 0;
  private lastPassY = 0;

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

    // Pre-compute per-row extents, inset by the larger of body half-length
    // or turn radius + margin, so the entire body stays on ice during both
    // straight passes and U-turns
    const inset = Math.ceil(Math.max(this.bodyLength / 2, this.sweepOffset / 2)) + 2;
    for (let y = 0; y < config.gridH; y++) {
      let left = config.gridW, right = -1;
      for (let x = 0; x < config.gridW; x++) {
        if (mask[y * config.gridW + x] > 0.5) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
      // Inset so body stays fully on ice
      if (right >= 0) {
        left += inset;
        right -= inset;
        if (left > right) {
          left = config.gridW;
          right = -1; // row too narrow
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

    // Find first and last rows that are inside the rink, inset by body width margin
    // so turns don't extend into the fence
    const yInset = Math.ceil(this.bodyWidth / 2) + 2;
    let firstValidY = 0;
    let lastValidY = config.gridH - 1;
    for (let y = 0; y < config.gridH; y++) {
      if (this.rowExtents[y].right >= 0) { firstValidY = y + yInset; break; }
    }
    for (let y = config.gridH - 1; y >= 0; y--) {
      if (this.rowExtents[y].right >= 0) { lastValidY = y - yInset; break; }
    }
    this.firstPassY = Math.max(firstValidY, 0);
    this.lastPassY = Math.min(lastValidY, config.gridH - 1);

    this.totalPasses = 0;
    for (let y = this.firstPassY; y <= this.lastPassY; y += this.sweepOffset) {
      const ext = this.rowExtents[Math.min(y, config.gridH - 1)];
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
    this.heading = 0; // facing +X
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
    this.heading = 0;
  }

  private moveToPass(passIndex: number) {
    let count = 0;
    for (let y = this.firstPassY; y <= this.lastPassY; y += this.sweepOffset) {
      const clampedY = Math.min(y, this.config.gridH - 1);
      const ext = this.rowExtents[clampedY];
      if (ext.right < 0) continue;
      if (count === passIndex) {
        this.y = clampedY;
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
        this.x += enterSpeed * simSeconds * Math.cos(this.heading);
        this.y += enterSpeed * simSeconds * Math.sin(this.heading);

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
        this.x += this.currentSpeed * simSeconds * Math.cos(this.heading);
        this.y += this.currentSpeed * simSeconds * Math.sin(this.heading);

        // Check row end
        const rowY2 = Math.max(0, Math.min(Math.round(this.y), this.config.gridH - 1));
        const ext2 = this.rowExtents[rowY2];
        if (ext2.right < 0) {
          this.transitionTo('exiting');
          break;
        }

        const reachedEnd = this.dir > 0 ? this.x >= ext2.right : this.x <= ext2.left;
        if (reachedEnd) {
          this.x = this.dir > 0 ? ext2.right : ext2.left;
          this.transitionTo('stopping');
        }
        break;
      }

      case 'stopping': {
        // Decelerate to 0
        this.currentSpeed = Math.max(0, this.currentSpeed - this.targetSpeed / Math.max(this.accelTime, 0.1) * simSeconds);
        this.x += this.currentSpeed * simSeconds * Math.cos(this.heading);
        this.y += this.currentSpeed * simSeconds * Math.sin(this.heading);
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
            this.transitionTo('turning');
          }
        }
        break;
      }

      case 'turning': {
        // Smooth semicircular U-turn between rows
        // On first frame of turning state, set up arc parameters
        if (this.stateTimer === simSeconds) {
          // Arc radius = half the row spacing (sweepOffset / 2)
          this.arcRadius = this.sweepOffset / 2;
          this.arcAngle = 0;
          this.arcStartHeading = this.heading;
          // Arc center is offset perpendicular to current heading (toward next row)
          // Next row is always in +Y direction (rows increment in Y)
          this.arcCenterX = this.x;
          this.arcCenterY = this.y + this.arcRadius;
        }

        // Turn speed: 40% of target speed
        const turnSpeed = this.targetSpeed * 0.4;
        this.currentSpeed = turnSpeed;

        // Angular velocity = linear speed / radius
        const angularVel = turnSpeed / Math.max(this.arcRadius, 1);
        this.arcAngle += angularVel * simSeconds;

        if (this.arcAngle >= Math.PI) {
          // Turn complete: snap to next row position
          this.arcAngle = Math.PI;
          this.dir = this.dir > 0 ? -1 : 1;
          this.heading = this.dir > 0 ? 0 : Math.PI;
          // Position at end of arc
          this.x = this.arcCenterX;
          this.y = this.arcCenterY + this.arcRadius;
          this.currentSpeed = 0;
          this.transitionTo('blade_down');
        } else {
          // Interpolate position on semicircular arc
          // Arc center is at (x, y + radius). Start is always at bottom of circle (-PI/2).
          // dir=+1 (going right): sweep counterclockwise (-PI/2 → +PI/2), heading 0→PI
          // dir=-1 (going left): sweep clockwise (-PI/2 → -3PI/2), heading PI→0 (2PI)
          const startAngleOnCircle = -Math.PI / 2;
          const turnDirection = this.dir > 0 ? 1 : -1;
          const currentAngleOnCircle = startAngleOnCircle + turnDirection * this.arcAngle;

          this.x = this.arcCenterX + this.arcRadius * Math.cos(currentAngleOnCircle);
          this.y = this.arcCenterY + this.arcRadius * Math.sin(currentAngleOnCircle);
          this.heading = this.arcStartHeading + this.arcAngle * turnDirection;
          // Normalize heading to [0, 2PI)
          this.heading = ((this.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        }
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
      heading: this.heading,
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
