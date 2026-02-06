import { ZamboniParams } from './zamboni';

export const MAX_SPRITES = 64;
export const SPRITE_SIZE = 32; // bytes per sprite (8 × f32)
export const SPRITE_HEADER = 16; // bytes (4 × u32)
export const SPRITE_BUFFER_SIZE = SPRITE_HEADER + MAX_SPRITES * SPRITE_SIZE; // 2064

export const enum SpriteType {
  NONE = 0,
  SKATER_HOCKEY = 1,
  SKATER_FIGURE = 2,
  SKATER_PUBLIC = 3,
  ZAMBONI = 4,
  SHOVEL = 5,
  GOAL_LEFT = 6,
  GOAL_RIGHT = 7,
  WATER_TANK = 8,
}

export const SLOT_GOAL_LEFT = 0;
export const SLOT_GOAL_RIGHT = 1;
export const SLOT_ZAMBONI = 2;
export const SLOT_SKATER_BASE = 3;
export const MAX_SKATERS = 32;

function packInfo(type: SpriteType, variant: number): number {
  return (type & 0xF) | ((variant & 0xF) << 4);
}

export class SpriteBuffer {
  private f32: Float32Array;
  private u32: Uint32Array;

  constructor() {
    const buf = new ArrayBuffer(SPRITE_BUFFER_SIZE);
    this.f32 = new Float32Array(buf);
    this.u32 = new Uint32Array(buf);
  }

  clear() {
    this.f32.fill(0);
  }

  private writeSprite(
    slot: number,
    x: number, y: number, dir: number,
    info: number,
    width: number, height: number,
    aux0: number, aux1: number,
  ) {
    // Header is 4 u32s = 4 f32 slots. Each sprite is 8 f32s.
    const base = 4 + slot * 8;
    this.f32[base + 0] = x;
    this.f32[base + 1] = y;
    this.f32[base + 2] = dir;
    this.u32[base + 3] = info;
    this.f32[base + 4] = width;
    this.f32[base + 5] = height;
    this.f32[base + 6] = aux0;
    this.f32[base + 7] = aux1;
  }

  /** Set goal sprites at fixed slots 0 and 1.
   *  goalOffset is in cells from the rink edge to the goal line.
   *  rinkCx/Cy/Hx/Hy are rink center and half-extents in cells. */
  setGoals(goalOffset: number, rinkCx: number, rinkCy: number, rinkHx: number, rinkHy: number) {
    if (goalOffset <= 0) {
      // No goals (backyard) — clear slots
      this.writeSprite(SLOT_GOAL_LEFT, 0, 0, 0, packInfo(SpriteType.NONE, 0), 0, 0, 0, 0);
      this.writeSprite(SLOT_GOAL_RIGHT, 0, 0, 0, packInfo(SpriteType.NONE, 0), 0, 0, 0, 0);
      return;
    }
    const netHw = goalOffset * 0.273;
    const netDepth = goalOffset * 0.334;
    // Left goal
    const leftX = rinkCx - rinkHx + goalOffset;
    this.writeSprite(SLOT_GOAL_LEFT, leftX, rinkCy, -1, packInfo(SpriteType.GOAL_LEFT, 0),
      netHw * 2, netDepth, goalOffset, 0);
    // Right goal
    const rightX = rinkCx + rinkHx - goalOffset;
    this.writeSprite(SLOT_GOAL_RIGHT, rightX, rinkCy, 1, packInfo(SpriteType.GOAL_RIGHT, 0),
      netHw * 2, netDepth, goalOffset, 0);
  }

  /** Set zamboni/shovel/water_tank sprite at slot 2. Pass null/inactive to clear. */
  setZamboni(zp: ZamboniParams) {
    if (!zp.active) {
      this.writeSprite(SLOT_ZAMBONI, 0, 0, 0, packInfo(SpriteType.NONE, 0), 0, 0, 0, 0);
      return;
    }
    const type = zp.machineType === 'zamboni' ? SpriteType.ZAMBONI
      : zp.machineType === 'water_tank' ? SpriteType.WATER_TANK
      : SpriteType.SHOVEL;
    // Encode bladeDown in aux1 bit 0 (as float: 1.0 = blade down, 0.0 = blade up)
    const aux1 = zp.bladeDown ? 1.0 : 0.0;
    this.writeSprite(SLOT_ZAMBONI, zp.x, zp.y, zp.dir,
      packInfo(type, 0), zp.width, zp.length, zp.speed, aux1);
  }

  /** Set a single skater at slot SLOT_SKATER_BASE + index. */
  setSkater(index: number, x: number, y: number, dir: number,
    type: SpriteType, team: number, width: number) {
    const slot = SLOT_SKATER_BASE + index;
    this.writeSprite(slot, x, y, dir, packInfo(type, team), width, 0, 0, 0);
  }

  /** Write the active sprite count into the header. */
  setCount(count: number) {
    this.u32[0] = count;
  }

  getBuffer(): Float32Array {
    return this.f32;
  }
}
