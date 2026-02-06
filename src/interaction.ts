import { RinkConfig } from './rink';

export type DamageType = 'none' | 'hockey' | 'water_gun' | 'snow_gun' | 'snowball_gun';

export interface DamageParams {
  active: boolean;
  gridX: number;
  gridY: number;
  type: DamageType;
  radius: number; // in grid cells
  // For simulation: 1=damage ice, 2=add water, 3=add snow
  mode: number;
  amount: number;   // configurable mm per application
  temp: number;     // water temperature for mode 2
  velocityX: number; // grid cells/s mouse velocity
  velocityY: number;
}

export interface ToolSettings {
  radius: number;
  amount: number;    // mm per application
  temp: number;      // for water gun
  pressure: number;  // particle velocity multiplier
  spread: number;    // cone angle multiplier
}

export class InteractionManager {
  private canvas: HTMLCanvasElement;
  private config: RinkConfig;
  private mouseDown = false;
  private lastGridX = 0;
  private lastGridY = 0;
  damageType: DamageType = 'none';
  toolSettings: ToolSettings = { radius: 6, amount: 0.8, temp: 20, pressure: 5, spread: 5 };

  private _damageActive = false;

  // Mouse velocity tracking
  private prevGridX = 0;
  private prevGridY = 0;
  private prevMoveTime = 0;
  velocityX = 0;
  velocityY = 0;

  constructor(canvas: HTMLCanvasElement, config: RinkConfig) {
    this.canvas = canvas;
    this.config = config;

    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('mouseup', () => this.onMouseUp());
    canvas.addEventListener('mouseleave', () => this.onMouseUp());
  }

  updateConfig(config: RinkConfig) {
    this.config = config;
  }

  private screenToGrid(e: MouseEvent): { gx: number; gy: number } {
    const rect = this.canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    return {
      gx: Math.floor(nx * this.config.gridW),
      gy: Math.floor(ny * this.config.gridH),
    };
  }

  private updateVelocity(gx: number, gy: number) {
    const now = performance.now();
    const dt = (now - this.prevMoveTime) / 1000;
    if (dt > 0.001 && dt < 0.5) {
      this.velocityX = (gx - this.prevGridX) / dt;
      this.velocityY = (gy - this.prevGridY) / dt;
    }
    this.prevGridX = gx;
    this.prevGridY = gy;
    this.prevMoveTime = now;
  }

  private onMouseDown(e: MouseEvent) {
    if (this.damageType === 'none') return;
    this.mouseDown = true;
    const { gx, gy } = this.screenToGrid(e);
    this.lastGridX = gx;
    this.lastGridY = gy;
    this.prevGridX = gx;
    this.prevGridY = gy;
    this.prevMoveTime = performance.now();
    this.velocityX = 0;
    this.velocityY = 0;
    this._damageActive = true;
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.mouseDown || this.damageType === 'none') return;
    const { gx, gy } = this.screenToGrid(e);
    this.updateVelocity(gx, gy);
    this.lastGridX = gx;
    this.lastGridY = gy;
    this._damageActive = true;
  }

  private onMouseUp() {
    this.mouseDown = false;
    this._damageActive = false;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  getDamageParams(): DamageParams {
    let radius = this.toolSettings.radius;
    let mode = 0;
    let amount = this.toolSettings.amount;
    let temp = this.toolSettings.temp;
    switch (this.damageType) {
      case 'hockey':
        mode = 1;    // damage ice
        break;
      case 'water_gun':
        mode = 2;    // add water
        break;
      case 'snow_gun':
        mode = 3;    // add snow
        break;
      case 'snowball_gun':
        mode = 4;    // snowball (handled by particles only)
        break;
    }
    const active = this._damageActive && this.damageType !== 'none';
    return {
      active,
      gridX: this.lastGridX,
      gridY: this.lastGridY,
      type: this.damageType,
      radius,
      mode,
      amount,
      temp,
      velocityX: this.velocityX,
      velocityY: this.velocityY,
    };
  }
}
