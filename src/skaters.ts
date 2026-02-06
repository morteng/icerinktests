import { RinkConfig } from './rink';
import { SpriteBuffer, SpriteType, SLOT_SKATER_BASE, MAX_SKATERS } from './sprites';

export { MAX_SKATERS };

export type SkaterType = 'hockey' | 'figure' | 'public';

interface Skater {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: number;      // facing angle (radians)
  type: number;      // 0=hockey, 1=figure, 2=public
  team: number;      // 0=home, 1=away (hockey only)
  active: boolean;
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

export class SkaterSimulation {
  private config: RinkConfig;
  private mask: Float32Array;
  private solids: Float32Array | null;
  private skaters: Skater[] = [];
  private rinkBounds: { left: number; right: number; top: number; bottom: number };

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

  spawn(type: SkaterType, count: number) {
    const typeNum = type === 'hockey' ? 0 : type === 'figure' ? 1 : 2;

    for (let i = 0; i < count && this.skaters.length < MAX_SKATERS; i++) {
      const pos = this.randomInsidePos();
      const angle = Math.random() * Math.PI * 2;
      const speed = type === 'hockey' ? 4.0 + Math.random() * 3.0 :
                    type === 'figure' ? 2.0 + Math.random() * 1.5 :
                    1.5 + Math.random() * 2.0;

      const skater: Skater = {
        x: pos.x, y: pos.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        dir: angle,
        type: typeNum,
        team: i % 2, // alternate teams
        active: true,
      };

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

    for (const sk of this.skaters) {
      if (!sk.active) continue;

      if (sk.type === 1 && sk.arcCenter && sk.arcRadius && sk.arcSpeed) {
        // Figure skater: follow arc path
        const angle = Math.atan2(sk.y - sk.arcCenter.y, sk.x - sk.arcCenter.x);
        const newAngle = angle + sk.arcSpeed * dt;
        const nx = sk.arcCenter.x + Math.cos(newAngle) * sk.arcRadius;
        const ny = sk.arcCenter.y + Math.sin(newAngle) * sk.arcRadius;

        if (this.isPassable(nx, ny)) {
          sk.x = nx;
          sk.y = ny;
          sk.dir = newAngle + (sk.arcSpeed > 0 ? Math.PI / 2 : -Math.PI / 2);
        } else {
          // Bounce off wall — reverse arc direction and pick new center
          sk.arcSpeed *= -1;
          const r = 15 + Math.random() * 25;
          sk.arcRadius = r;
          sk.arcCenter = {
            x: sk.x + Math.cos(sk.dir + Math.PI / 2) * r,
            y: sk.y + Math.sin(sk.dir + Math.PI / 2) * r,
          };
        }
      } else {
        // Hockey/public: straight-line movement with random direction changes
        const speed = Math.sqrt(sk.vx * sk.vx + sk.vy * sk.vy);
        const nx = sk.x + sk.vx * cellsPerM * dt;
        const ny = sk.y + sk.vy * cellsPerM * dt;

        if (this.isPassable(nx, ny)) {
          sk.x = nx;
          sk.y = ny;
          sk.dir = Math.atan2(sk.vy, sk.vx);
        } else {
          // Bounce: reflect velocity and add randomness
          const wallAngle = Math.atan2(ny - this.config.gridH / 2, nx - this.config.gridW / 2);
          const newAngle = wallAngle + Math.PI + (Math.random() - 0.5) * 1.5;
          sk.vx = Math.cos(newAngle) * speed;
          sk.vy = Math.sin(newAngle) * speed;
          sk.dir = newAngle;
        }

        // Random direction changes
        const changeRate = sk.type === 0 ? 0.3 : 0.15; // hockey changes more
        if (Math.random() < changeRate * dt) {
          const newAngle = sk.dir + (Math.random() - 0.5) * 1.5;
          sk.vx = Math.cos(newAngle) * speed;
          sk.vy = Math.sin(newAngle) * speed;
          sk.dir = newAngle;
        }
      }
    }
  }

  /** Write all active skaters into a SpriteBuffer at slots SLOT_SKATER_BASE+. */
  writeToSpriteBuffer(buf: SpriteBuffer) {
    const active = this.skaters.filter(s => s.active);
    const count = Math.min(active.length, MAX_SKATERS);

    for (let i = 0; i < count; i++) {
      const sk = active[i];
      const spriteType = TYPE_TO_SPRITE[sk.type] ?? SpriteType.SKATER_PUBLIC;
      buf.setSkater(i, sk.x, sk.y, sk.dir, spriteType, sk.team, 3.0);
    }

    buf.setCount(count);
  }
}
