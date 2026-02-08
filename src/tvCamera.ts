import { Camera, CameraState } from './camera';

/** Context passed to TV camera each frame */
export interface TVContext {
  zamboniActive: boolean;
  zamboniX: number;
  zamboniY: number;
  zamboniDir: number;
  skaterPositions: { x: number; y: number }[];
  stateData: Float32Array | null;
  gridW: number;
  gridH: number;
}

type ShotType =
  | 'ORBIT_WIDE'
  | 'ORBIT_CLOSE'
  | 'ZAMBONI_TRACK'
  | 'SKATER_TRACK'
  | 'DAMAGE_CLOSEUP'
  | 'GOAL_SHOT'
  | 'SWEEP'
  | 'CORNER';

interface Shot {
  type: ShotType;
  duration: number;
  // Target camera state at start (interpolated from previous)
  targetAzimuth: number;
  targetElevation: number;
  targetDistance: number;
  targetX: number;
  targetZ: number;
  // For animated shots
  azimuthRate: number; // radians/sec for orbit shots
  trackSubjectIdx: number; // -1 = none, index into skater array
}

const DEG = Math.PI / 180;

// Minimum elevation to avoid ugly low angles
const MIN_ELEV = 20 * DEG;

// Transition duration (seconds)
const TRANSITION_DUR = 1.5;

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function lerpAngle(a: number, b: number, t: number): number {
  // Shortest path around circle
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class TVCameraController {
  private camera: Camera;
  private _active = false;
  private currentShot: Shot | null = null;
  private shotTimer = 0;
  private transitionTimer = 0;
  private transitionFrom: CameraState | null = null;
  private savedCameraState: CameraState | null = null;
  private deactivating = false;
  private deactivateTimer = 0;
  private lastShotType: ShotType | null = null;
  private rinkScale: number;
  private gridW: number;
  private gridH: number;
  private cachedDamagePos: { x: number; y: number } | null = null;
  private damageUpdateCounter = 0;

  constructor(camera: Camera, gridW: number, gridH: number) {
    this.camera = camera;
    this.gridW = gridW;
    this.gridH = gridH;
    this.rinkScale = Math.max(gridW, gridH);
  }

  get active(): boolean { return this._active; }

  activate() {
    if (this._active) return;
    this._active = true;
    this.deactivating = false;
    this.savedCameraState = this.camera.getFullState();
    this.camera.tvActive = true;
    this.camera.ortho = false;
    this.camera.locked = false;
    this.currentShot = null;
    this.shotTimer = 0;
    this.transitionTimer = 0;
    this.lastShotType = null;
  }

  deactivate() {
    if (!this._active || this.deactivating) return;
    // Start smooth return to saved state
    this.deactivating = true;
    this.deactivateTimer = 0;
    this.transitionFrom = this.camera.getFullState();
  }

  /** Force-stop without smooth transition */
  forceStop() {
    this._active = false;
    this.deactivating = false;
    this.camera.tvActive = false;
    if (this.savedCameraState) {
      this.camera.setState(this.savedCameraState);
      this.savedCameraState = null;
    }
  }

  isActive(): boolean { return this._active; }

  update(dt: number, context: TVContext) {
    if (!this._active) return;

    // Handle deactivation transition
    if (this.deactivating) {
      this.deactivateTimer += dt;
      const t = smoothstep(this.deactivateTimer / 2.0); // 2 second ease back
      if (t >= 1 || !this.savedCameraState || !this.transitionFrom) {
        // Done
        this._active = false;
        this.deactivating = false;
        this.camera.tvActive = false;
        if (this.savedCameraState) {
          this.camera.setState(this.savedCameraState);
          this.savedCameraState = null;
        }
        return;
      }
      this.interpolateCamera(this.transitionFrom, this.savedCameraState, t);
      return;
    }

    // Update damage position periodically
    this.damageUpdateCounter++;
    if (this.damageUpdateCounter % 60 === 0) {
      this.cachedDamagePos = this.findWorstDamage(context);
    }

    // Check if we need a new shot
    if (!this.currentShot || this.shotTimer >= this.currentShot.duration) {
      this.transitionFrom = this.camera.getFullState();
      this.currentShot = this.pickNextShot(context);
      this.shotTimer = 0;
      this.transitionTimer = 0;
    }

    this.shotTimer += dt;
    this.transitionTimer += dt;

    this.updateShot(dt, context);
  }

  private pickNextShot(context: TVContext): Shot {
    const candidates = this.getCandidates(context);

    // Filter out repeat of last shot type
    let filtered = candidates.filter(c => c !== this.lastShotType);
    if (filtered.length === 0) filtered = candidates;

    const type = filtered[Math.floor(Math.random() * filtered.length)];
    this.lastShotType = type;

    return this.buildShot(type, context);
  }

  private getCandidates(context: TVContext): ShotType[] {
    if (context.zamboniActive) {
      return this.weightedPick([
        ['ZAMBONI_TRACK', 40],
        ['ORBIT_WIDE', 25],
        ['GOAL_SHOT', 15],
        ['ORBIT_CLOSE', 10],
        ['CORNER', 10],
      ]);
    }
    if (context.skaterPositions.length > 0) {
      return this.weightedPick([
        ['SKATER_TRACK', 30],
        ['DAMAGE_CLOSEUP', 20],
        ['ORBIT_WIDE', 20],
        ['ORBIT_CLOSE', 10],
        ['SWEEP', 10],
        ['CORNER', 10],
      ]);
    }
    // Idle
    return this.weightedPick([
      ['ORBIT_WIDE', 50],
      ['SWEEP', 25],
      ['CORNER', 25],
    ]);
  }

  /** Return array with entries repeated by weight for random selection */
  private weightedPick(weights: [ShotType, number][]): ShotType[] {
    const result: ShotType[] = [];
    for (const [type, weight] of weights) {
      for (let i = 0; i < weight; i++) result.push(type);
    }
    return result;
  }

  private buildShot(type: ShotType, context: TVContext): Shot {
    const cx = this.gridW / 2;
    const cz = this.gridH / 2;

    switch (type) {
      case 'ORBIT_WIDE':
        return {
          type,
          duration: randRange(12, 18),
          targetAzimuth: Math.random() * Math.PI * 2,
          targetElevation: randRange(25, 35) * DEG,
          targetDistance: this.rinkScale * 0.9,
          targetX: cx,
          targetZ: cz,
          azimuthRate: (Math.random() > 0.5 ? 1 : -1) * randRange(0.05, 0.12),
          trackSubjectIdx: -1,
        };

      case 'ORBIT_CLOSE':
        return {
          type,
          duration: randRange(8, 12),
          targetAzimuth: Math.random() * Math.PI * 2,
          targetElevation: randRange(20, 30) * DEG,
          targetDistance: this.rinkScale * 0.6,
          targetX: cx,
          targetZ: cz,
          azimuthRate: (Math.random() > 0.5 ? 1 : -1) * randRange(0.08, 0.15),
          trackSubjectIdx: -1,
        };

      case 'ZAMBONI_TRACK': {
        const behindAngle = context.zamboniDir + Math.PI + randRange(-0.3, 0.3);
        return {
          type,
          duration: randRange(6, 10),
          targetAzimuth: behindAngle,
          targetElevation: randRange(30, 40) * DEG,
          targetDistance: this.rinkScale * 0.25,
          targetX: context.zamboniX,
          targetZ: context.zamboniY,
          azimuthRate: 0,
          trackSubjectIdx: -1,
        };
      }

      case 'SKATER_TRACK': {
        const positions = context.skaterPositions;
        const idx = positions.length > 0 ? Math.floor(Math.random() * positions.length) : -1;
        const target = idx >= 0 ? positions[idx] : { x: cx, y: cz };
        return {
          type,
          duration: randRange(5, 8),
          targetAzimuth: Math.random() * Math.PI * 2,
          targetElevation: randRange(25, 35) * DEG,
          targetDistance: this.rinkScale * 0.18,
          targetX: target.x,
          targetZ: target.y,
          azimuthRate: randRange(-0.05, 0.05),
          trackSubjectIdx: idx,
        };
      }

      case 'DAMAGE_CLOSEUP': {
        const dp = this.cachedDamagePos || { x: cx, y: cz };
        return {
          type,
          duration: randRange(4, 6),
          targetAzimuth: Math.random() * Math.PI * 2,
          targetElevation: randRange(35, 50) * DEG,
          targetDistance: this.rinkScale * 0.1,
          targetX: dp.x,
          targetZ: dp.y,
          azimuthRate: randRange(-0.03, 0.03),
          trackSubjectIdx: -1,
        };
      }

      case 'GOAL_SHOT': {
        // Pick one of the two goals (along X axis)
        const goalEnd = Math.random() > 0.5 ? 0.15 : 0.85;
        return {
          type,
          duration: randRange(5, 8),
          targetAzimuth: goalEnd < 0.5 ? Math.PI * 0.75 : -Math.PI * 0.25,
          targetElevation: randRange(20, 30) * DEG,
          targetDistance: this.rinkScale * 0.35,
          targetX: this.gridW * goalEnd,
          targetZ: cz,
          azimuthRate: 0,
          trackSubjectIdx: -1,
        };
      }

      case 'SWEEP': {
        return {
          type,
          duration: randRange(4, 6),
          targetAzimuth: randRange(-0.2, 0.2),
          targetElevation: 20 * DEG,
          targetDistance: this.rinkScale * 0.55,
          targetX: this.gridW * 0.1,
          targetZ: cz,
          azimuthRate: 0,
          trackSubjectIdx: -1,
        };
      }

      case 'CORNER':
      default: {
        // Pick a random corner
        const corners = [
          { x: this.gridW * 0.15, z: this.gridH * 0.15, az: Math.PI * 0.25 },
          { x: this.gridW * 0.85, z: this.gridH * 0.15, az: -Math.PI * 0.25 },
          { x: this.gridW * 0.85, z: this.gridH * 0.85, az: -Math.PI * 0.75 },
          { x: this.gridW * 0.15, z: this.gridH * 0.85, az: Math.PI * 0.75 },
        ];
        const c = corners[Math.floor(Math.random() * corners.length)];
        return {
          type,
          duration: randRange(6, 10),
          targetAzimuth: c.az + randRange(-0.2, 0.2),
          targetElevation: randRange(20, 25) * DEG,
          targetDistance: this.rinkScale * 0.55,
          targetX: c.x,
          targetZ: c.z,
          azimuthRate: randRange(-0.02, 0.02),
          trackSubjectIdx: -1,
        };
      }
    }
  }

  private updateShot(dt: number, context: TVContext) {
    const shot = this.currentShot!;

    // Smooth transition for the first TRANSITION_DUR seconds
    const transT = smoothstep(Math.min(this.transitionTimer / TRANSITION_DUR, 1));

    // Get the target state for this shot
    let azimuth = shot.targetAzimuth + shot.azimuthRate * this.shotTimer;
    let elevation = shot.targetElevation;
    let distance = shot.targetDistance;
    let tx = shot.targetX;
    let tz = shot.targetZ;

    // Tracking shots: follow subject
    if (shot.type === 'ZAMBONI_TRACK' && context.zamboniActive) {
      tx = context.zamboniX;
      tz = context.zamboniY;
      // Update azimuth to stay behind zamboni
      const behindAngle = context.zamboniDir + Math.PI;
      azimuth = lerpAngle(azimuth, behindAngle, 0.03);
      shot.targetAzimuth = azimuth - shot.azimuthRate * this.shotTimer;
    } else if (shot.type === 'SKATER_TRACK' && shot.trackSubjectIdx >= 0) {
      const positions = context.skaterPositions;
      if (shot.trackSubjectIdx < positions.length) {
        tx = positions[shot.trackSubjectIdx].x;
        tz = positions[shot.trackSubjectIdx].y;
      }
    } else if (shot.type === 'SWEEP') {
      // Animate X across rink
      const sweepProgress = this.shotTimer / shot.duration;
      tx = lerp(this.gridW * 0.1, this.gridW * 0.9, sweepProgress);
    }

    // Clamp elevation
    elevation = Math.max(MIN_ELEV, elevation);

    if (this.transitionFrom && transT < 1) {
      // Interpolate from previous state
      this.camera.setAzimuth(lerpAngle(this.transitionFrom.azimuth, azimuth, transT));
      this.camera.setElevation(lerp(this.transitionFrom.elevation, elevation, transT));
      this.camera.setDistance(lerp(this.transitionFrom.distance, distance, transT));
      this.camera.setTarget(
        lerp(this.transitionFrom.targetX, tx, transT),
        0,
        lerp(this.transitionFrom.targetZ, tz, transT),
      );
    } else {
      // Full shot control
      this.camera.setAzimuth(azimuth);
      this.camera.setElevation(elevation);
      this.camera.setDistance(distance);
      this.camera.setTarget(tx, 0, tz);
    }
  }

  private interpolateCamera(from: CameraState, to: CameraState, t: number) {
    this.camera.setAzimuth(lerpAngle(from.azimuth, to.azimuth, t));
    this.camera.setElevation(lerp(from.elevation, to.elevation, t));
    this.camera.setDistance(lerp(from.distance, to.distance, t));
    this.camera.setTarget(
      lerp(from.targetX, to.targetX, t),
      lerp(from.targetY, to.targetY, t),
      lerp(from.targetZ, to.targetZ, t),
    );
    // Restore ortho/locked at the end
    if (t >= 0.99) {
      this.camera.ortho = to.ortho;
      this.camera.locked = to.locked;
    }
  }

  private findWorstDamage(context: TVContext): { x: number; y: number } | null {
    const data = context.stateData;
    if (!data) return null;

    const gw = context.gridW;
    const gh = context.gridH;
    const step = 4; // sample every 4th cell for performance
    let worstIce = 100;
    let worstX = gw / 2;
    let worstY = gh / 2;

    for (let y = 10; y < gh - 10; y += step) {
      for (let x = 10; x < gw - 10; x += step) {
        const idx = y * gw + x;
        const ice = data[idx * 4 + 1]; // ice thickness
        if (ice > 0.5 && ice < worstIce) {
          worstIce = ice;
          worstX = x;
          worstY = y;
        }
      }
    }

    return { x: worstX, y: worstY };
  }
}
