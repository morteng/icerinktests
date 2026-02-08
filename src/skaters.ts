import { RinkConfig } from './rink';
import { SpriteBuffer, SpriteType, SLOT_SKATER_BASE, MAX_SKATERS } from './sprites';
import { ZamboniParams } from './zamboni';

export { MAX_SKATERS };

export type SkaterType = 'hockey' | 'figure' | 'public';

/** Zamboni info relevant to skater avoidance */
interface ZamboniAvoidance {
  x: number;
  y: number;
  width: number;   // cells perpendicular
  length: number;  // cells along travel
  heading: number;  // radians
  active: boolean;
}

/**
 * Signed distance from point to an axis-aligned rectangle rotated by `heading`.
 * Returns distance (negative = inside).
 */
function distToRotatedRect(
  px: number, py: number,
  rx: number, ry: number,
  halfW: number, halfL: number,
  heading: number,
): number {
  // Transform point into rectangle's local space
  const dx = px - rx;
  const dy = py - ry;
  const ch = Math.cos(-heading);
  const sh = Math.sin(-heading);
  const localX = dx * ch - dy * sh;
  const localY = dx * sh + dy * ch;

  // SDF for axis-aligned rectangle in local space
  const qx = Math.abs(localX) - halfL;
  const qy = Math.abs(localY) - halfW;

  if (qx <= 0 && qy <= 0) {
    // Inside: negative distance
    return Math.max(qx, qy);
  }
  // Outside: Euclidean distance to nearest edge
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy);
}

interface Skater {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: number;      // facing angle (radians)
  speed: number;    // desired speed (m/s)
  type: number;      // 0=hockey, 1=figure, 2=public
  team: number;      // 0=home, 1=away (hockey only)
  active: boolean;
  phase: number;     // animation phase (0-1 cycling) for leg/arm stride
  seed: number;      // random seed (0-1) for appearance variation (color, height)
  heightScale: number; // billboard height multiplier (0.85-1.15)
  // Steering target
  targetX: number;
  targetY: number;
  stuckTimer: number; // time since last significant movement
  // Figure skating: arc parameters
  arcCenter?: { x: number; y: number };
  arcRadius?: number;
  arcSpeed?: number;
}

// Map internal type number to SpriteType enum
const TYPE_TO_SPRITE: SpriteType[] = [
  SpriteType.SKATER_HOCKEY,
  SpriteType.SKATER_FIGURE,
  SpriteType.SKATER_PUBLIC,
];

// Separation distance in cells
const SEPARATION_DIST = 8;
const SEPARATION_FORCE = 3.0;
// Wall avoidance: start steering away when this many cells from boundary
const WALL_SENSE_DIST = 6;
const WALL_FORCE = 5.0;
// Steering smoothness (higher = snappier turns)
const STEER_RATE = 3.0;

export class SkaterSimulation {
  private config: RinkConfig;
  private mask: Float32Array;
  private solids: Float32Array | null;
  private skaters: Skater[] = [];
  private rinkBounds: { left: number; right: number; top: number; bottom: number };
  private zamboniAvoid: ZamboniAvoidance | null = null;
  private benchDoors: { x: number; y: number }[] = [];

  constructor(config: RinkConfig, mask: Float32Array, solids: Float32Array | null = null) {
    this.config = config;
    this.mask = mask;
    this.solids = solids;

    // Compute rink interior bounds from mask
    let left = config.gridW, right = 0, top = config.gridH, bottom = 0;
    for (let y = 0; y < config.gridH; y++) {
      for (let x = 0; x < config.gridW; x++) {
        if (mask[y * config.gridW + x] > 0.5) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    this.rinkBounds = { left: left + 3, right: right - 3, top: top + 3, bottom: bottom - 3 };

    // Compute bench door positions (near side = high Y, 4 doors)
    // These match classifySegment() in stadiumGeometry.ts:
    //   Home doors: bxRel ≈ -0.10, -0.25
    //   Away doors: bxRel ≈ +0.10, +0.25
    const rinkCx = config.gridW / 2;
    const rinkCy = config.gridH / 2;
    const rinkHx = config.dims.lengthM / config.cellSize / 2;
    const rinkHy = config.dims.widthM / config.cellSize / 2;
    const doorBxRels = [-0.25, -0.10, 0.10, 0.25];
    for (const bxRel of doorBxRels) {
      this.benchDoors.push({
        x: rinkCx + rinkHx * bxRel,
        y: rinkCy + rinkHy - 3, // near side, slightly inward
      });
    }
  }

  /** Update zamboni state for skater avoidance. Call each frame from scene.ts. */
  setZamboniParams(zp: ZamboniParams | null) {
    if (!zp || !zp.active) {
      this.zamboniAvoid = null;
      return;
    }
    this.zamboniAvoid = {
      x: zp.x,
      y: zp.y,
      width: zp.width,
      length: zp.length,
      heading: zp.heading,
      active: true,
    };
  }

  private isInside(x: number, y: number): boolean {
    const gx = Math.round(x);
    const gy = Math.round(y);
    if (gx < 0 || gx >= this.config.gridW || gy < 0 || gy >= this.config.gridH) return false;
    return this.mask[gy * this.config.gridW + gx] > 0.5;
  }

  /** Check if a position is inside the rink AND not blocked by solids (goal frames). */
  private isPassable(x: number, y: number): boolean {
    if (!this.isInside(x, y)) return false;
    if (!this.solids) return true;
    const gx = Math.round(x);
    const gy = Math.round(y);
    const idx = gy * this.config.gridW + gx;
    return this.solids[idx] < 0.5;
  }

  private randomInsidePos(): { x: number; y: number } {
    const b = this.rinkBounds;
    for (let i = 0; i < 100; i++) {
      const x = b.left + Math.random() * (b.right - b.left);
      const y = b.top + Math.random() * (b.bottom - b.top);
      if (this.isPassable(x, y)) return { x, y };
    }
    return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  }

  /** Pick a new random target within the rink, biased toward open areas. */
  private pickTarget(sk: Skater): { x: number; y: number } {
    // Try a few times to find a passable target that's reasonably far away
    for (let i = 0; i < 10; i++) {
      const pos = this.randomInsidePos();
      const dx = pos.x - sk.x;
      const dy = pos.y - sk.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 20) return pos; // At least 20 cells away
    }
    return this.randomInsidePos();
  }

  /** Compute distance to nearest non-passable cell along a direction. */
  private wallDistance(x: number, y: number, dx: number, dy: number): number {
    for (let step = 1; step <= WALL_SENSE_DIST; step++) {
      if (!this.isPassable(x + dx * step, y + dy * step)) {
        return step;
      }
    }
    return WALL_SENSE_DIST + 1;
  }

  spawn(type: SkaterType, count: number) {
    const typeNum = type === 'hockey' ? 0 : type === 'figure' ? 1 : 2;

    for (let i = 0; i < count && this.skaters.length < MAX_SKATERS; i++) {
      const pos = this.randomInsidePos();
      const angle = Math.random() * Math.PI * 2;
      const speed = type === 'hockey' ? 4.0 + Math.random() * 3.0 :
                    type === 'figure' ? 2.0 + Math.random() * 1.5 :
                    1.5 + Math.random() * 2.0;

      const seed = Math.random();
      const variedSpeed = speed * (0.8 + seed * 0.4);

      const skater: Skater = {
        x: pos.x, y: pos.y,
        vx: Math.cos(angle) * variedSpeed,
        vy: Math.sin(angle) * variedSpeed,
        dir: angle,
        speed: variedSpeed,
        type: typeNum,
        team: i % 2,
        active: true,
        phase: Math.random(),
        seed,
        heightScale: 0.85 + seed * 0.30,
        targetX: 0, targetY: 0,
        stuckTimer: 0,
      };

      // Set initial target
      const target = this.pickTarget(skater);
      skater.targetX = target.x;
      skater.targetY = target.y;

      // Figure skaters: set up arc path
      if (type === 'figure') {
        const arcR = 15 + Math.random() * 25;
        skater.arcCenter = {
          x: pos.x + Math.cos(angle + Math.PI / 2) * arcR,
          y: pos.y + Math.sin(angle + Math.PI / 2) * arcR,
        };
        skater.arcRadius = arcR;
        skater.arcSpeed = (Math.random() > 0.5 ? 1 : -1) * speed / arcR;
      }

      this.skaters.push(skater);
    }
  }

  clear() {
    this.skaters = [];
  }

  get count(): number {
    return this.skaters.filter(s => s.active).length;
  }

  update(dt: number) {
    const cellsPerM = 1 / this.config.cellSize;
    const active = this.skaters.filter(s => s.active);

    for (const sk of active) {
      // Cycle animation phase proportional to movement speed
      const spd = Math.sqrt(sk.vx * sk.vx + sk.vy * sk.vy);
      sk.phase = (sk.phase + spd * dt * 0.5) % 1.0;

      if (sk.type === 1 && sk.arcCenter && sk.arcRadius && sk.arcSpeed) {
        // Figure skater: check zamboni proximity — switch to steering if too close
        let figureFleeZamboni = false;
        if (this.zamboniAvoid && this.zamboniAvoid.active) {
          const za = this.zamboniAvoid;
          const dist = distToRotatedRect(
            sk.x, sk.y, za.x, za.y,
            za.width / 2, za.length / 2, za.heading,
          );
          if (dist < 25) {
            figureFleeZamboni = true;
          }
        }

        if (figureFleeZamboni) {
          // Use steering-based movement to flee (same as hockey/public)
          this.updateSteering(sk, active, dt, cellsPerM);
        } else {
        // Figure skater: follow arc path with separation
        const angle = Math.atan2(sk.y - sk.arcCenter.y, sk.x - sk.arcCenter.x);
        const newAngle = angle + sk.arcSpeed * dt;
        let nx = sk.arcCenter.x + Math.cos(newAngle) * sk.arcRadius;
        let ny = sk.arcCenter.y + Math.sin(newAngle) * sk.arcRadius;

        // Apply separation from other skaters
        const sep = this.computeSeparation(sk, active);
        nx += sep.x * dt * cellsPerM;
        ny += sep.y * dt * cellsPerM;

        if (this.isPassable(nx, ny)) {
          sk.x = nx;
          sk.y = ny;
          sk.dir = newAngle + (sk.arcSpeed > 0 ? Math.PI / 2 : -Math.PI / 2);
        } else {
          // Pick new arc
          sk.arcSpeed *= -1;
          const r = 15 + Math.random() * 25;
          sk.arcRadius = r;
          sk.arcCenter = {
            x: sk.x + Math.cos(sk.dir + Math.PI / 2) * r,
            y: sk.y + Math.sin(sk.dir + Math.PI / 2) * r,
          };
        }
        } // end else (not fleeing zamboni)
      } else {
        // Hockey/public: steering-based movement
        this.updateSteering(sk, active, dt, cellsPerM);
      }
    }
  }

  /** Compute separation force pushing this skater away from nearby skaters. */
  private computeSeparation(sk: Skater, active: Skater[]): { x: number; y: number } {
    let fx = 0, fy = 0;
    for (const other of active) {
      if (other === sk) continue;
      const dx = sk.x - other.x;
      const dy = sk.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < SEPARATION_DIST && dist > 0.1) {
        const strength = SEPARATION_FORCE * (1 - dist / SEPARATION_DIST);
        fx += (dx / dist) * strength;
        fy += (dy / dist) * strength;
      }
    }
    return { x: fx, y: fy };
  }

  /** Steering-based update for hockey and public skaters. */
  private updateSteering(sk: Skater, active: Skater[], dt: number, cellsPerM: number) {
    const speed = sk.speed * cellsPerM;

    // Check if we've reached target or been stuck too long
    const toTargetX = sk.targetX - sk.x;
    const toTargetY = sk.targetY - sk.y;
    const targetDist = Math.sqrt(toTargetX * toTargetX + toTargetY * toTargetY);

    if (targetDist < 10 || sk.stuckTimer > 3) {
      const target = this.pickTarget(sk);
      sk.targetX = target.x;
      sk.targetY = target.y;
      sk.stuckTimer = 0;
    }

    // Desired direction: toward target
    const toTX = sk.targetX - sk.x;
    const toTY = sk.targetY - sk.y;
    const toTLen = Math.sqrt(toTX * toTX + toTY * toTY);
    let desiredX = toTLen > 0.1 ? toTX / toTLen : Math.cos(sk.dir);
    let desiredY = toTLen > 0.1 ? toTY / toTLen : Math.sin(sk.dir);

    // Separation force from other skaters
    const sep = this.computeSeparation(sk, active);
    desiredX += sep.x * 0.5;
    desiredY += sep.y * 0.5;

    // Wall avoidance: probe ahead and to the sides
    const curDir = Math.atan2(sk.vy, sk.vx);
    const aheadDist = this.wallDistance(sk.x, sk.y, Math.cos(curDir), Math.sin(curDir));
    if (aheadDist <= WALL_SENSE_DIST) {
      const wallStrength = WALL_FORCE * (1 - aheadDist / (WALL_SENSE_DIST + 1));
      // Steer perpendicular to current direction (pick the more open side)
      const leftDist = this.wallDistance(sk.x, sk.y, Math.cos(curDir - 1.0), Math.sin(curDir - 1.0));
      const rightDist = this.wallDistance(sk.x, sk.y, Math.cos(curDir + 1.0), Math.sin(curDir + 1.0));
      const turnDir = leftDist > rightDist ? -1 : 1;
      desiredX += Math.cos(curDir + turnDir * Math.PI / 2) * wallStrength;
      desiredY += Math.sin(curDir + turnDir * Math.PI / 2) * wallStrength;
    }

    // Zamboni avoidance: strong repulsion when zamboni is nearby
    if (this.zamboniAvoid && this.zamboniAvoid.active) {
      const za = this.zamboniAvoid;
      const dist = distToRotatedRect(
        sk.x, sk.y, za.x, za.y,
        za.width / 2, za.length / 2, za.heading,
      );

      const avoidRadius = 25; // start avoiding at 25 cells distance
      if (dist < avoidRadius) {
        // Direction away from zamboni center
        const awayX = sk.x - za.x;
        const awayY = sk.y - za.y;
        const awayLen = Math.sqrt(awayX * awayX + awayY * awayY);

        if (awayLen > 0.1) {
          // Stronger force as skater gets closer
          const urgency = 1 - Math.max(dist, 0) / avoidRadius;
          const force = 8.0 * urgency * urgency;
          desiredX += (awayX / awayLen) * force;
          desiredY += (awayY / awayLen) * force;
        }

        // If very close, retarget toward nearest bench door
        if (dist < 12) {
          let nearestDoor = this.benchDoors[0];
          let nearestDist = Infinity;
          for (const door of this.benchDoors) {
            const ddx = door.x - sk.x;
            const ddy = door.y - sk.y;
            const dd = ddx * ddx + ddy * ddy;
            if (dd < nearestDist) {
              nearestDist = dd;
              nearestDoor = door;
            }
          }
          sk.targetX = nearestDoor.x;
          sk.targetY = nearestDoor.y;
        }
      }
    }

    // Normalize desired direction
    const dLen = Math.sqrt(desiredX * desiredX + desiredY * desiredY);
    if (dLen > 0.01) {
      desiredX /= dLen;
      desiredY /= dLen;
    }

    // Smoothly steer current velocity toward desired direction
    const targetVx = desiredX * speed;
    const targetVy = desiredY * speed;
    const steerFactor = 1 - Math.exp(-STEER_RATE * dt);
    sk.vx += (targetVx - sk.vx) * steerFactor;
    sk.vy += (targetVy - sk.vy) * steerFactor;

    // Maintain constant speed
    const curSpeed = Math.sqrt(sk.vx * sk.vx + sk.vy * sk.vy);
    if (curSpeed > 0.01) {
      sk.vx = (sk.vx / curSpeed) * speed;
      sk.vy = (sk.vy / curSpeed) * speed;
    }

    // Attempt move
    const nx = sk.x + sk.vx * dt;
    const ny = sk.y + sk.vy * dt;

    if (this.isPassable(nx, ny)) {
      const prevX = sk.x, prevY = sk.y;
      sk.x = nx;
      sk.y = ny;
      sk.dir = Math.atan2(sk.vy, sk.vx);

      // Track stuck detection
      const moved = Math.sqrt((sk.x - prevX) ** 2 + (sk.y - prevY) ** 2);
      if (moved < 0.5 * dt) {
        sk.stuckTimer += dt;
      } else {
        sk.stuckTimer = 0;
      }
    } else {
      // Can't move — try sliding along axes
      const slideX = this.isPassable(nx, sk.y);
      const slideY = this.isPassable(sk.x, ny);
      if (slideX) {
        sk.x = nx;
        sk.vy *= -0.5; // Dampen perpendicular component
      } else if (slideY) {
        sk.y = ny;
        sk.vx *= -0.5;
      } else {
        // Truly stuck — reverse and pick new target
        sk.vx *= -1;
        sk.vy *= -1;
        sk.stuckTimer += dt * 2;
      }
      sk.dir = Math.atan2(sk.vy, sk.vx);
    }

    // Random direction changes (less frequent since steering handles pathing)
    const changeRate = sk.type === 0 ? 0.15 : 0.08;
    if (Math.random() < changeRate * dt) {
      const target = this.pickTarget(sk);
      sk.targetX = target.x;
      sk.targetY = target.y;
    }
  }

  /** Get info about all active skaters (for debug API). */
  getActiveSkaters(): Array<{ x: number; y: number; dir: number; type: string; team: number; speed: number; seed: number }> {
    const typeNames = ['hockey', 'figure', 'public'] as const;
    return this.skaters.filter(s => s.active).map(s => ({
      x: s.x,
      y: s.y,
      dir: s.dir,
      type: typeNames[s.type] ?? 'unknown',
      team: s.team,
      speed: s.speed,
      seed: s.seed,
    }));
  }

  /** Get positions of all active skaters (for TV camera tracking). */
  getPositions(): { x: number; y: number }[] {
    return this.skaters.filter(s => s.active).map(s => ({ x: s.x, y: s.y }));
  }

  /** Get a random active skater position for surface damage. */
  getRandomPosition(): { x: number; y: number; dir: number } | null {
    const active = this.skaters.filter(s => s.active);
    if (active.length === 0) return null;
    const sk = active[Math.floor(Math.random() * active.length)];
    return { x: sk.x, y: sk.y, dir: sk.dir };
  }

  /** Write all active skaters into a SpriteBuffer at slots SLOT_SKATER_BASE+. */
  writeToSpriteBuffer(buf: SpriteBuffer) {
    const active = this.skaters.filter(s => s.active);
    const count = Math.min(active.length, MAX_SKATERS);

    for (let i = 0; i < count; i++) {
      const sk = active[i];
      const spriteType = TYPE_TO_SPRITE[sk.type] ?? SpriteType.SKATER_PUBLIC;
      buf.setSkater(i, sk.x, sk.y, sk.dir, spriteType, sk.team, 3.0, sk.phase, sk.heightScale, sk.seed);
    }

    buf.setCount(count);
  }
}
