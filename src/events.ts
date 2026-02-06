import { RinkConfig } from './rink';
import { DamageType } from './interaction';
import { MachineType } from './zamboni';

export type EventType = 'hockey_practice' | 'figure_skating' | 'public_skate' | 'maintenance' | 'idle';

export interface ScheduleEvent {
  type: EventType;
  name: string;
  duration: number;   // seconds (sim time)
  damageRate: number;  // damage events per sim-second
  damageType: DamageType;
  ambient: number;     // ambient temp override
  maintenanceMachine?: MachineType;
}

const EVENTS: ScheduleEvent[] = [
  { type: 'hockey_practice', name: 'Hockey Practice', duration: 5400, damageRate: 0.08, damageType: 'hockey', ambient: 15 },
  { type: 'maintenance', name: 'Zamboni', duration: 900, damageRate: 0, damageType: 'none', ambient: 15, maintenanceMachine: 'zamboni' },
  { type: 'figure_skating', name: 'Figure Skating', duration: 3600, damageRate: 0.04, damageType: 'hockey', ambient: 15 },
  { type: 'maintenance', name: 'Zamboni', duration: 900, damageRate: 0, damageType: 'none', ambient: 15, maintenanceMachine: 'zamboni' },
  { type: 'public_skate', name: 'Public Skate', duration: 7200, damageRate: 0.12, damageType: 'hockey', ambient: 18 },
  { type: 'maintenance', name: 'Zamboni', duration: 900, damageRate: 0, damageType: 'none', ambient: 15, maintenanceMachine: 'zamboni' },
  { type: 'hockey_practice', name: 'Hockey Game', duration: 5400, damageRate: 0.15, damageType: 'hockey', ambient: 16 },
  { type: 'maintenance', name: 'Zamboni', duration: 900, damageRate: 0, damageType: 'none', ambient: 15, maintenanceMachine: 'zamboni' },
  { type: 'idle', name: 'Overnight', duration: 28800, damageRate: 0, damageType: 'none', ambient: 12 },
];

// Backyard schedule: includes shoveling maintenance
const BACKYARD_EVENTS: ScheduleEvent[] = [
  { type: 'public_skate', name: 'Skating', duration: 3600, damageRate: 0.05, damageType: 'hockey', ambient: -10 },
  { type: 'maintenance', name: 'Shoveling', duration: 600, damageRate: 0, damageType: 'none', ambient: -10, maintenanceMachine: 'shovel' },
  { type: 'idle', name: 'Idle', duration: 14400, damageRate: 0, damageType: 'none', ambient: -10 },
];

export interface QualityMetrics {
  score: number;
  avgIceMm: number;
  minIceMm: number;
  maxIceMm: number;
  uniformityPct: number;
  bareSpotsPct: number;
  avgWaterMm: number;
  avgIceTemp: number;
  avgSurfaceTemp: number;
  cellsInside: number;
}

export class EventScheduler {
  private config: RinkConfig;
  private mask: Float32Array;
  private schedule: ScheduleEvent[];
  private currentIndex = 0;
  private elapsed = 0;

  autoMode = false;

  constructor(config: RinkConfig, mask: Float32Array) {
    this.config = config;
    this.mask = mask;
    this.schedule = config.isBackyard ? BACKYARD_EVENTS : EVENTS;
  }

  get currentEvent(): ScheduleEvent {
    return this.schedule[this.currentIndex];
  }

  get timeRemaining(): number {
    return Math.max(0, this.currentEvent.duration - this.elapsed);
  }

  get progressFraction(): number {
    return this.elapsed / this.currentEvent.duration;
  }

  update(simSeconds: number): {
    triggerZamboni: boolean;
    triggerMachineType?: MachineType;
    autoDamage: { x: number; y: number; type: DamageType } | null;
  } {
    if (!this.autoMode) return { triggerZamboni: false, autoDamage: null };

    this.elapsed += simSeconds;

    let triggerZamboni = false;
    let triggerMachineType: MachineType | undefined;

    if (this.elapsed >= this.currentEvent.duration) {
      this.elapsed = 0;
      this.currentIndex = (this.currentIndex + 1) % this.schedule.length;

      if (this.currentEvent.type === 'maintenance') {
        triggerZamboni = true;
        triggerMachineType = this.currentEvent.maintenanceMachine;
      }
    }

    let autoDamage: { x: number; y: number; type: DamageType } | null = null;
    const evt = this.currentEvent;
    if (evt.damageRate > 0 && evt.damageType !== 'none') {
      if (Math.random() < evt.damageRate * simSeconds) {
        // Rejection-sample to land inside mask
        let x = 0, y = 0;
        for (let attempt = 0; attempt < 20; attempt++) {
          x = Math.random() * this.config.gridW;
          y = Math.random() * this.config.gridH;
          const ix = Math.floor(x);
          const iy = Math.floor(y);
          if (ix >= 0 && ix < this.config.gridW && iy >= 0 && iy < this.config.gridH
            && this.mask[iy * this.config.gridW + ix] > 0.5) {
            autoDamage = { x, y, type: evt.damageType };
            break;
          }
        }
      }
    }

    return { triggerZamboni, triggerMachineType, autoDamage };
  }

  reset() {
    this.currentIndex = 0;
    this.elapsed = 0;
  }
}

/**
 * Calculate detailed ice quality metrics, only counting cells inside the mask.
 */
export function calculateQualityMetrics(
  stateData: Float32Array,
  gridW: number,
  gridH: number,
  mask: Float32Array,
): QualityMetrics {
  const targetThickness = 25.0;
  let totalIce = 0;
  let totalDeviation = 0;
  let bareCount = 0;
  let totalWater = 0;
  let totalTemp = 0;
  let totalSurfaceTemp = 0;
  let minIce = Infinity;
  let maxIce = -Infinity;
  let cellsInside = 0;

  const cellCount = gridW * gridH;
  for (let i = 0; i < cellCount; i++) {
    if (mask[i] < 0.5) continue;
    cellsInside++;

    const temp = stateData[i * 4 + 0];
    const ice = stateData[i * 4 + 1];
    const water = stateData[i * 4 + 2];

    totalIce += ice;
    totalWater += water;
    totalTemp += temp;
    totalSurfaceTemp += temp;
    if (ice < 1.0) bareCount++;
    if (ice < minIce) minIce = ice;
    if (ice > maxIce) maxIce = ice;
    totalDeviation += Math.abs(ice - targetThickness);
  }

  if (cellsInside === 0) {
    return { score: 0, avgIceMm: 0, minIceMm: 0, maxIceMm: 0, uniformityPct: 0, bareSpotsPct: 100, avgWaterMm: 0, avgIceTemp: 0, avgSurfaceTemp: 0, cellsInside: 0 };
  }

  const avgIce = totalIce / cellsInside;
  const avgDeviation = totalDeviation / cellsInside;
  const bareFraction = bareCount / cellsInside;
  const avgWater = totalWater / cellsInside;
  const avgIceTemp = totalTemp / cellsInside;
  const avgSurfaceTemp = totalSurfaceTemp / cellsInside;

  const thicknessScore = Math.max(0, 100 - Math.abs(avgIce - targetThickness) * 4);
  const uniformityScore = Math.max(0, 100 - avgDeviation * 8);
  const bareScore = Math.max(0, 100 - bareFraction * 500);
  const waterScore = Math.max(0, 100 - avgWater * 20);

  const score = Math.round(
    thicknessScore * 0.3 +
    uniformityScore * 0.3 +
    bareScore * 0.25 +
    waterScore * 0.15
  );

  const uniformityPct = Math.round(Math.max(0, 100 - avgDeviation / targetThickness * 100));

  return {
    score,
    avgIceMm: Math.round(avgIce * 10) / 10,
    minIceMm: Math.round(minIce * 10) / 10,
    maxIceMm: Math.round(maxIce * 10) / 10,
    uniformityPct,
    bareSpotsPct: Math.round(bareFraction * 1000) / 10,
    avgWaterMm: Math.round(avgWater * 10) / 10,
    avgIceTemp: Math.round(avgIceTemp * 10) / 10,
    avgSurfaceTemp: Math.round(avgSurfaceTemp * 10) / 10,
    cellsInside,
  };
}
