import { ToolSettings } from './interaction';

export interface Particle {
  x: number; y: number; z: number;       // position (grid coords, z = height above surface)
  vx: number; vy: number; vz: number;    // velocity (grid cells/s)
  temp: number;                            // temperature °C
  amount: number;                          // material amount (mm)
  type: 'water' | 'snow' | 'snowball' | 'weather_snow' | 'weather_rain';
  life: number;                            // seconds alive
}

export interface LandedDeposit {
  cellIdx: number;
  heatDelta: number;    // °C adjustment
  iceDelta: number;     // mm
  waterDelta: number;   // mm
  snowDelta: number;    // mm (shavings)
}

const MAX_PARTICLES = 512;
const GRAVITY = 9.81;

// Pack: 0=water, 1=snow, 2=snowball, 3=weather_snow, 4=weather_rain
// Low 16 bits = type, high 16 bits = color variation
function packType(type: 'water' | 'snow' | 'snowball' | 'weather_snow' | 'weather_rain', variation: number): number {
  const typeId = type === 'water' ? 0 : type === 'snow' ? 1 : type === 'snowball' ? 2
    : type === 'weather_snow' ? 3 : 4;
  return typeId + (Math.floor(variation * 255) << 16);
}

export class ParticleManager {
  particles: Particle[] = [];
  private gridW: number;
  private gridH: number;
  private cellSize: number;
  private solids: Float32Array | null;

  // Cached readback state for temperature-dependent landing
  cachedState: Float32Array | null = null;

  // Chaotic dispenser state
  private chaosTime = 0;
  private wobbleAngle = 0;
  private pressureSurge = 1;

  constructor(gridW: number, gridH: number, cellSize: number, solids: Float32Array | null = null) {
    this.gridW = gridW;
    this.gridH = gridH;
    this.cellSize = cellSize;
    this.solids = solids;
  }

  /** Update chaotic dispenser state — call before emit(). */
  private updateChaos(dt: number) {
    this.chaosTime += dt;
    const t = this.chaosTime;
    // Nozzle wobble: multi-frequency oscillation + random jitter
    this.wobbleAngle = Math.sin(t * 3.5) * 0.15 + Math.sin(t * 8.7) * 0.08 + Math.random() * 0.05;
    // Pressure surge: slow + fast oscillation + random
    this.pressureSurge = Math.max(0.3, Math.min(1.3,
      0.7 + 0.3 * Math.sin(t * 2.1) + 0.15 * Math.sin(t * 7.3) + Math.random() * 0.1
    ));
  }

  setCachedState(data: Float32Array | null) {
    this.cachedState = data;
  }

  emit(
    cursorX: number, cursorY: number,
    mouseVelX: number, mouseVelY: number,
    type: 'water' | 'snow',
    settings: ToolSettings,
  ) {
    // Update chaotic dispenser state
    this.updateChaos(1 / 60);

    // Snow burst density: 1.5x when sin(t*5) > 0.8
    const burstMul = (type === 'snow' && Math.sin(this.chaosTime * 5) > 0.8) ? 1.5 : 1.0;

    // Scale particle count with radius for wider nozzles
    const baseCount = type === 'water' ? 10 : 12;
    const count = Math.min(Math.round(baseCount * Math.max(settings.radius / 4, 1) * burstMul), 40);
    const amountPerParticle = settings.amount / count;

    const speed = Math.sqrt(mouseVelX * mouseVelX + mouseVelY * mouseVelY);
    const hasVelocity = speed > 5; // cells/s threshold

    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) break;

      // Random offset within radius
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * settings.radius * 0.5;
      const px = cursorX + Math.cos(angle) * r;
      const py = cursorY + Math.sin(angle) * r;

      // Initial height above surface
      const pz = 3 + Math.random() * 2;

      // Velocity: follows mouse direction with spread + chaos
      let vx: number, vy: number, vz: number;
      if (hasVelocity) {
        // Spray in direction of mouse movement
        const dirX = mouseVelX / speed;
        const dirY = mouseVelY / speed;
        const baseSpeed = (type === 'water'
          ? settings.pressure * 8
          : settings.spread * 5) * this.pressureSurge;
        const spreadAngle = (type === 'water'
          ? (Math.random() - 0.5) * 0.4
          : (Math.random() - 0.5) * 1.2) + this.wobbleAngle;
        const cosS = Math.cos(spreadAngle);
        const sinS = Math.sin(spreadAngle);
        vx = (dirX * cosS - dirY * sinS) * baseSpeed * (0.7 + Math.random() * 0.6);
        vy = (dirX * sinS + dirY * cosS) * baseSpeed * (0.7 + Math.random() * 0.6);
        vz = (1 + Math.random() * 2) * settings.pressure * this.pressureSurge;
      } else {
        // Stationary cursor: spray upward, falls back on cursor + wobble
        const spreadAngle = Math.random() * Math.PI * 2 + this.wobbleAngle;
        const lateralSpeed = (type === 'water'
          ? Math.random() * 3 * settings.pressure
          : Math.random() * 5 * settings.spread) * this.pressureSurge;
        vx = Math.cos(spreadAngle) * lateralSpeed;
        vy = Math.sin(spreadAngle) * lateralSpeed;
        vz = (3 + Math.random() * 4) * settings.pressure * this.pressureSurge;
      }

      const temp = type === 'water' ? settings.temp : -5;

      this.particles.push({
        x: px, y: py, z: pz,
        vx, vy, vz,
        temp,
        amount: amountPerParticle,
        type,
        life: 0,
      });
    }
  }

  emitSnowball(
    cursorX: number, cursorY: number,
    mouseVelX: number, mouseVelY: number,
    settings: ToolSettings,
  ) {
    if (this.particles.length >= MAX_PARTICLES) return;

    const speed = Math.sqrt(mouseVelX * mouseVelX + mouseVelY * mouseVelY);
    const hasVelocity = speed > 5;

    // Varying clump sizes: baseSize * (0.6 + random * 0.8)
    const baseSize = settings.amount; // 2-8mm from slider
    const amount = baseSize * (0.6 + Math.random() * 0.8);

    const px = cursorX + (Math.random() - 0.5) * 2;
    const py = cursorY + (Math.random() - 0.5) * 2;
    const pz = 3 + Math.random() * 2;

    let vx: number, vy: number, vz: number;
    if (hasVelocity) {
      const dirX = mouseVelX / speed;
      const dirY = mouseVelY / speed;
      const baseSpeed = settings.pressure * 12; // faster than water/snow
      const spreadAngle = (Math.random() - 0.5) * 0.3; // tight cone
      const cosS = Math.cos(spreadAngle);
      const sinS = Math.sin(spreadAngle);
      vx = (dirX * cosS - dirY * sinS) * baseSpeed * (0.7 + Math.random() * 0.6);
      vy = (dirX * sinS + dirY * cosS) * baseSpeed * (0.7 + Math.random() * 0.6);
      vz = (2 + Math.random() * 3) * settings.pressure;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const lateralSpeed = Math.random() * 4 * settings.pressure;
      vx = Math.cos(angle) * lateralSpeed;
      vy = Math.sin(angle) * lateralSpeed;
      vz = (4 + Math.random() * 5) * settings.pressure;
    }

    this.particles.push({
      x: px, y: py, z: pz,
      vx, vy, vz,
      temp: -5,
      amount,
      type: 'snowball',
      life: 0,
    });
  }

  emitWeather(
    type: 'weather_snow' | 'weather_rain',
    windX: number, windY: number,
    gridW: number, gridH: number,
    intensity: number,
  ) {
    const isSnow = type === 'weather_snow';
    const baseRate = isSnow ? 4 : 8;
    const count = Math.round(baseRate * intensity);

    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) break;

      // Random position across the visible grid
      const px = Math.random() * gridW;
      const py = Math.random() * gridH;

      if (isSnow) {
        // Snow: high start, slow fall, wind-drifted
        const pz = 15 + Math.random() * 10;
        const vz = -(2 + Math.random() * 2);
        const vx = windX * 3 + (Math.random() - 0.5) * 2;
        const vy = windY * 3 + (Math.random() - 0.5) * 2;
        this.particles.push({
          x: px, y: py, z: pz,
          vx, vy, vz,
          temp: -5,
          amount: 0.01 + Math.random() * 0.04,
          type: 'weather_snow',
          life: 0,
        });
      } else {
        // Rain: high start, fast fall, less wind drift
        const pz = 20 + Math.random() * 10;
        const vz = -(15 + Math.random() * 10);
        const vx = windX + (Math.random() - 0.5) * 0.5;
        const vy = windY + (Math.random() - 0.5) * 0.5;
        this.particles.push({
          x: px, y: py, z: pz,
          vx, vy, vz,
          temp: 5,
          amount: 0.01 + Math.random() * 0.02,
          type: 'weather_rain',
          life: 0,
        });
      }
    }
  }

  update(dt: number, windX = 0, windY = 0): LandedDeposit[] {
    const deposits: LandedDeposit[] = [];
    const gravityScaled = GRAVITY / this.cellSize;
    const secondaries: Particle[] = [];

    const surviving: Particle[] = [];
    for (const p of this.particles) {
      // Gravity (weather snow has high drag, approaches terminal velocity quickly)
      const gravMul = p.type === 'weather_snow' ? 0.3 : 1;
      p.vz -= gravityScaled * gravMul * dt;
      // Air drag: snowballs heavier (less drag), water/snow lighter
      const dragBase = p.type === 'snowball' ? 0.99 : p.type === 'weather_snow' ? 0.95 : 0.97;
      const drag = Math.pow(dragBase, dt * 60);
      p.vx *= drag;
      p.vy *= drag;
      // Wind effect on all particles (snow amplified 3x)
      const isSnowy = p.type === 'snow' || p.type === 'snowball' || p.type === 'weather_snow';
      const windMul = isSnowy ? 3 : 1;
      p.vx += windX * windMul * dt;
      p.vy += windY * windMul * dt;
      // Snow lateral drift (both tool snow and weather snow)
      if (p.type === 'snow' || p.type === 'weather_snow') {
        p.vx += (Math.random() - 0.5) * 2 * dt;
        p.vy += (Math.random() - 0.5) * 2 * dt;
      }
      // Position integration
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.life += dt;

      // Low-altitude trajectory collision with solids (bounce off goal posts)
      if (p.z > 0 && p.z < 2 && this.solids) {
        const tx = Math.floor(p.x);
        const ty = Math.floor(p.y);
        if (tx >= 0 && tx < this.gridW && ty >= 0 && ty < this.gridH) {
          const ti = ty * this.gridW + tx;
          if (this.solids[ti] >= 1.0) {
            // Reflect horizontal velocity
            p.vx = -p.vx;
            p.vy = -p.vy;
            // Push back out of solid
            p.x -= p.vx * dt * 2;
            p.y -= p.vy * dt * 2;
          }
        }
      }

      // Landing check
      if (p.z <= 0) {
        const cx = Math.floor(p.x);
        const cy = Math.floor(p.y);
        if (cx >= 0 && cx < this.gridW && cy >= 0 && cy < this.gridH) {
          const cellIdx = cy * this.gridW + cx;
          const landIdx = this.findLandingCell(cellIdx, cx, cy, p.type);
          if (landIdx >= 0) {
            const deposit = this.integrateParticle(p, landIdx);
            if (deposit) deposits.push(deposit);

            // Splash physics: generate secondary particles on impact
            const canSplash = this.particles.length + secondaries.length < MAX_PARTICLES - 20;
            if (canSplash) {
              if (p.type === 'snowball') {
                // Snowball shatter: 4-8 radial snow fragments
                const fragCount = 4 + Math.floor(Math.random() * 5);
                for (let f = 0; f < fragCount; f++) {
                  const angle = (f / fragCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
                  const lateralSpeed = 3 + Math.random() * 5;
                  secondaries.push({
                    x: p.x, y: p.y, z: 0.5,
                    vx: Math.cos(angle) * lateralSpeed,
                    vy: Math.sin(angle) * lateralSpeed,
                    vz: 2 + Math.random() * 4,
                    temp: -5,
                    amount: p.amount * 0.05,
                    type: 'snow',
                    life: 0,
                  });
                }
              } else if (p.type === 'water') {
                // Water splash: only on high-velocity impact
                const impactSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
                if (impactSpeed > 15) {
                  const dropCount = 2 + Math.floor(Math.random() * 3);
                  for (let f = 0; f < dropCount; f++) {
                    const angle = Math.random() * Math.PI * 2;
                    const lateralSpeed = 2 + Math.random() * 4;
                    secondaries.push({
                      x: p.x, y: p.y, z: 0.3,
                      vx: Math.cos(angle) * lateralSpeed,
                      vy: Math.sin(angle) * lateralSpeed,
                      vz: 1.5 + Math.random() * 3,
                      temp: p.temp,
                      amount: p.amount * 0.08,
                      type: 'water',
                      life: 0,
                    });
                  }
                }
              }
            }
          }
          // else: blocked by solid with no adjacent passable cell — particle destroyed
        }
        continue; // remove particle
      }

      // Out of bounds check (weather particles get longer life for high-altitude travel)
      const maxLife = (p.type === 'weather_snow' || p.type === 'weather_rain') ? 15 : 5;
      if (p.x < -5 || p.x > this.gridW + 5 || p.y < -5 || p.y > this.gridH + 5 || p.life > maxLife) {
        continue; // remove
      }

      surviving.push(p);
    }

    // Append secondaries (splash/shatter fragments)
    for (const s of secondaries) {
      if (surviving.length >= MAX_PARTICLES) break;
      surviving.push(s);
    }

    this.particles = surviving;
    return deposits;
  }

  /** Check if a cell is blocked by solids for a given particle type. */
  private isSolidBlocked(cellIdx: number, type: Particle['type']): boolean {
    if (!this.solids) return false;
    const s = this.solids[cellIdx];
    if (s >= 1.0 && s < 1.5) return true;  // frame: blocks both
    if (s >= 1.5 && (type === 'snow' || type === 'snowball' || type === 'weather_snow')) return true;
    return false;
  }

  /** Find a landing cell, deflecting to adjacent if the target is solid. Returns -1 if no passable cell. */
  private findLandingCell(cellIdx: number, cx: number, cy: number, type: Particle['type']): number {
    if (!this.isSolidBlocked(cellIdx, type)) return cellIdx;
    // Search 1-cell radius for nearest passable cell
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= this.gridW || ny < 0 || ny >= this.gridH) continue;
        const ni = ny * this.gridW + nx;
        if (!this.isSolidBlocked(ni, type)) return ni;
      }
    }
    return -1; // fully surrounded by solids — destroy particle
  }

  private integrateParticle(p: Particle, cellIdx: number): LandedDeposit | null {
    // Read cached temperature at landing cell
    let cellTemp = 0;
    if (this.cachedState && cellIdx * 4 + 3 < this.cachedState.length) {
      cellTemp = this.cachedState[cellIdx * 4];
    }

    if (p.type === 'weather_rain') {
      // Weather rain deposits as water (tiny amount)
      return {
        cellIdx,
        heatDelta: 0,
        iceDelta: 0,
        waterDelta: p.amount,
        snowDelta: 0,
      };
    }

    if (p.type === 'weather_snow') {
      // Weather snow deposits as shavings (tiny amount)
      return {
        cellIdx,
        heatDelta: 0,
        iceDelta: 0,
        waterDelta: 0,
        snowDelta: p.amount,
      };
    }

    if (p.type === 'water') {
      if (cellTemp < 0) {
        // Water on cold ice: partial freeze
        const freezeFrac = Math.min(-cellTemp / 5, 0.8);
        return {
          cellIdx,
          heatDelta: p.amount * freezeFrac * 5 * 0.1, // latent heat release
          iceDelta: p.amount * freezeFrac,
          waterDelta: p.amount * (1 - freezeFrac),
          snowDelta: 0,
        };
      } else {
        // Water on warm surface
        return {
          cellIdx,
          heatDelta: (p.temp - cellTemp) * 0.05 * p.amount,
          iceDelta: 0,
          waterDelta: p.amount,
          snowDelta: 0,
        };
      }
    } else {
      // Snow and snowball — both deposit as shavings
      if (cellTemp > 2) {
        // Snow on warm surface → melts
        return {
          cellIdx,
          heatDelta: -p.amount * 5 * 0.1, // absorbs heat
          iceDelta: 0,
          waterDelta: p.amount * 0.8,
          snowDelta: p.amount * 0.2,
        };
      } else {
        // Snow on cold surface → becomes shavings
        return {
          cellIdx,
          heatDelta: 0,
          iceDelta: 0,
          waterDelta: 0,
          snowDelta: p.amount,
        };
      }
    }
  }

  /** Pack active particles into Float32Array for GPU rendering. */
  getRenderData(): Float32Array {
    // Header: 4 u32 (count + padding) = 16 bytes
    // Per particle: 4 f32 (x, y, z, packed_type) = 16 bytes each
    const bufferSize = 4 + MAX_PARTICLES * 4;
    const data = new Float32Array(bufferSize);
    const u32 = new Uint32Array(data.buffer);

    u32[0] = this.particles.length;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const base = 4 + i * 4;
      data[base + 0] = p.x;
      data[base + 1] = p.y;
      data[base + 2] = p.z;
      // Pack type + variation
      u32[base + 3] = packType(p.type, p.life);
    }

    return data;
  }

  clear() {
    this.particles = [];
  }
}

export const PARTICLE_BUFFER_SIZE = (4 + MAX_PARTICLES * 4) * 4; // bytes
