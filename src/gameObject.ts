import { SpriteBuffer } from './sprites';

/** Simulation effect produced by a game object (e.g. zamboni depositing water). */
export interface SimEffect {
  type: 'damage' | 'deposit_water' | 'clear_shavings';
  x: number;
  y: number;
  radius: number;
  value?: number;
}

/** Lightweight game object interface — wraps existing logic without replacing it. */
export interface GameObject {
  type: string;
  active: boolean;
  x: number;
  y: number;
  dir: number;
  width: number;
  height: number;

  update?(dt: number): void;
  writeSprite(buf: SpriteBuffer, slot: number): void;
  getSimEffect?(): SimEffect | null;
}

/**
 * Thin manager for game objects. Iterates objects for update/render.
 * NOT a full ECS — just a collection with convenience methods.
 */
export class GameObjectManager {
  objects: GameObject[] = [];

  add(obj: GameObject) {
    this.objects.push(obj);
  }

  remove(obj: GameObject) {
    const idx = this.objects.indexOf(obj);
    if (idx >= 0) this.objects.splice(idx, 1);
  }

  clear() {
    this.objects.length = 0;
  }

  update(dt: number) {
    for (const obj of this.objects) {
      if (obj.active && obj.update) {
        obj.update(dt);
      }
    }
  }

  writeSprites(buf: SpriteBuffer, startSlot: number) {
    let slot = startSlot;
    for (const obj of this.objects) {
      if (obj.active) {
        obj.writeSprite(buf, slot++);
      }
    }
  }

  getActiveObjects(): GameObject[] {
    return this.objects.filter(o => o.active);
  }

  getSimEffects(): SimEffect[] {
    const effects: SimEffect[] = [];
    for (const obj of this.objects) {
      if (obj.active && obj.getSimEffect) {
        const effect = obj.getSimEffect();
        if (effect) effects.push(effect);
      }
    }
    return effects;
  }
}
