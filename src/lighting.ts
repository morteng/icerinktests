import { RinkConfig } from './rink';

export interface LightDef {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  intensity: number;
  radius: number; // falloff radius in cells (0 = directional, no distance falloff)
}

export interface LightingState {
  lights: LightDef[];
  skyBrightness: number;  // overall ambient/surroundings multiplier (0=pitch black, 1=full)
  fogDensity: number;     // indoor light haze strength
}

/** Physically-computed sun/sky/moon state from atmospheric scattering */
export interface SunSkyState {
  sunDir: [number, number, number];    // normalized direction toward sun
  sunColor: [number, number, number];  // RGB 0-1, attenuated by Rayleigh+Mie extinction
  skyColor: [number, number, number];  // RGB 0-1, hemisphere-average scattered sky color
  moonDir: [number, number, number];   // normalized direction toward moon
  moonPhase: number;                    // 0=new, 0.5=full, 1=new (lunar phase)
}

// Rayleigh scattering coefficients at sea level (per meter) [R, G, B]
const BETA_R: [number, number, number] = [5.8e-6, 13.5e-6, 33.1e-6];
const H_RAYLEIGH = 8400; // Rayleigh scale height (m)

// Mie scattering (wavelength-independent)
const BETA_M = 21e-6;    // per meter at sea level
const H_MIE = 1200;      // Mie scale height (m)

// Zenith optical depths
const TAU_R_ZENITH: [number, number, number] = [
  BETA_R[0] * H_RAYLEIGH,  // ~0.049
  BETA_R[1] * H_RAYLEIGH,  // ~0.113
  BETA_R[2] * H_RAYLEIGH,  // ~0.278
];
const TAU_M_ZENITH = BETA_M * H_MIE;  // ~0.025

/**
 * Compute physically-based sun and sky colors using Rayleigh + Mie atmospheric scattering.
 *
 * Sun color: Beer-Lambert extinction through atmosphere using Kasten & Young air mass.
 * Sky color: hemisphere-average of Rayleigh-scattered light (blue by day, warm at sunset).
 */
export function computeAtmosphere(timeOfDay: number, cloudCover: number): SunSkyState {
  // Sun arc: rises at 6, peaks at 12, sets at 18
  const hourAngle = ((timeOfDay - 6) / 12) * Math.PI;
  const sinEl = Math.sin(hourAngle);

  // Sun direction vector (x=east-west, y=slight south offset for 3D, z=elevation)
  const rawDir: [number, number, number] = [Math.cos(hourAngle), -0.3, Math.max(sinEl, 0.02)];
  const len = Math.sqrt(rawDir[0] ** 2 + rawDir[1] ** 2 + rawDir[2] ** 2);
  const sunDir: [number, number, number] = [rawDir[0] / len, rawDir[1] / len, rawDir[2] / len];

  // Sun below horizon → dark (still need to compute moon for nighttime rendering)
  if (sinEl <= 0) {
    const moonAngle = hourAngle + Math.PI + 0.52;
    const moonSinEl = Math.sin(moonAngle) * 0.9;
    const moonRawDir: [number, number, number] = [
      Math.cos(moonAngle), 0.2, Math.max(moonSinEl, -0.3),
    ];
    const moonLen = Math.sqrt(moonRawDir[0] ** 2 + moonRawDir[1] ** 2 + moonRawDir[2] ** 2);
    const moonDir: [number, number, number] = [
      moonRawDir[0] / moonLen, moonRawDir[1] / moonLen, moonRawDir[2] / moonLen,
    ];
    return { sunDir, sunColor: [0, 0, 0], skyColor: [0.01, 0.01, 0.02], moonDir, moonPhase: 0.5 };
  }

  // Air mass using Kasten & Young (1989) formula
  const elDeg = Math.asin(Math.min(sinEl, 1)) * (180 / Math.PI);
  const airMass = Math.min(
    1.0 / (sinEl + 0.50572 * Math.pow(elDeg + 6.07995, -1.6364)),
    40,
  );

  // Sun color: Beer-Lambert extinction through atmosphere
  const sunColor: [number, number, number] = [
    Math.exp(-(TAU_R_ZENITH[0] + TAU_M_ZENITH) * airMass),
    Math.exp(-(TAU_R_ZENITH[1] + TAU_M_ZENITH) * airMass),
    Math.exp(-(TAU_R_ZENITH[2] + TAU_M_ZENITH) * airMass),
  ];

  // Fade near horizon (atmospheric refraction zone)
  if (sinEl < 0.05) {
    const fade = sinEl / 0.05;
    sunColor[0] *= fade;
    sunColor[1] *= fade;
    sunColor[2] *= fade;
  }

  // Sky color: Rayleigh-scattered light (what's removed from direct beam)
  // sky ∝ β_R(λ) × (1 - transmittance(λ)) — more scattering = more sky contribution
  const skyRaw: [number, number, number] = [
    (BETA_R[0] / BETA_R[2]) * (1 - Math.exp(-TAU_R_ZENITH[0] * airMass)),
    (BETA_R[1] / BETA_R[2]) * (1 - Math.exp(-TAU_R_ZENITH[1] * airMass)),
    1.0 * (1 - Math.exp(-TAU_R_ZENITH[2] * airMass)),
  ];

  // Normalize so the brightest channel reaches ~1.0 at noon
  const skyMax = Math.max(skyRaw[0], skyRaw[1], skyRaw[2], 0.001);
  const skyScale = 1.0 / skyMax;
  const skyColor: [number, number, number] = [
    skyRaw[0] * skyScale,
    skyRaw[1] * skyScale,
    skyRaw[2] * skyScale,
  ];

  // Cloud modification:
  // Clouds scatter all wavelengths equally → whiten sky, reduce direct sun
  if (cloudCover > 0) {
    const avg = (skyColor[0] + skyColor[1] + skyColor[2]) / 3;
    const cc = cloudCover;
    // Sky whitens
    skyColor[0] += (avg - skyColor[0]) * cc * 0.8;
    skyColor[1] += (avg - skyColor[1]) * cc * 0.8;
    skyColor[2] += (avg - skyColor[2]) * cc * 0.8;
    // Direct sun reduced (diffused by clouds)
    const sunReduce = 1 - cc * 0.85;
    sunColor[0] *= sunReduce;
    sunColor[1] *= sunReduce;
    sunColor[2] *= sunReduce;
    // Some blocked sunlight becomes diffuse sky
    skyColor[0] *= 1 + cc * 0.2;
    skyColor[1] *= 1 + cc * 0.2;
    skyColor[2] *= 1 + cc * 0.2;
  }

  // Moon: roughly opposite the sun with offset, simplified orbital model
  // Moon rises ~50 min later each day, simplified as anti-solar + 30° offset
  const moonAngle = hourAngle + Math.PI + 0.52; // ~30° offset from anti-solar
  const moonSinEl = Math.sin(moonAngle) * 0.9; // slightly lower arc than sun
  const moonRawDir: [number, number, number] = [
    Math.cos(moonAngle), 0.2, Math.max(moonSinEl, -0.3),
  ];
  const moonLen = Math.sqrt(moonRawDir[0] ** 2 + moonRawDir[1] ** 2 + moonRawDir[2] ** 2);
  const moonDir: [number, number, number] = [
    moonRawDir[0] / moonLen, moonRawDir[1] / moonLen, moonRawDir[2] / moonLen,
  ];

  // Lunar phase: 29.53 day synodic period, simplified with sim time
  // Phase 0 = new moon, 0.5 = full moon, 1.0 = new moon
  // Use a fixed offset so full moon occurs roughly when sun is down
  const moonPhase = 0.5; // default to full moon for best visibility

  return { sunDir, sunColor, skyColor, moonDir, moonPhase };
}

export const MAX_LIGHTS = 12;

export class LightingManager {
  mode: 'auto' | 'manual' = 'auto';
  selectedIndex = -1;
  manualLights: LightDef[] = [];
  private manualSky = 1.0;
  private manualFog = 0.0;
  private config: RinkConfig;
  private lastTimeOfDay = 12;
  private lastEventType?: string;

  constructor(config: RinkConfig) {
    this.config = config;
  }

  updateConfig(config: RinkConfig) {
    this.config = config;
  }

  resetToAuto() {
    this.mode = 'auto';
    this.selectedIndex = -1;
    this.manualLights = [];
  }

  enterManualMode(timeOfDay: number, eventType?: string) {
    if (this.mode === 'manual') return;
    const auto = buildLighting(this.config, timeOfDay, eventType);
    this.manualLights = auto.lights.map(l => ({ ...l }));
    this.manualSky = auto.skyBrightness;
    this.manualFog = auto.fogDensity;
    this.mode = 'manual';
    this.selectedIndex = -1;
  }

  getLighting(timeOfDay: number, eventType?: string): LightingState {
    this.lastTimeOfDay = timeOfDay;
    this.lastEventType = eventType;
    if (this.mode === 'manual') {
      return {
        lights: this.manualLights,
        skyBrightness: this.manualSky,
        fogDensity: this.manualFog,
      };
    }
    return buildLighting(this.config, timeOfDay, eventType);
  }

  hitTest(gx: number, gy: number, threshold = 15): number {
    const lights = this.mode === 'manual' ? this.manualLights
      : buildLighting(this.config, this.lastTimeOfDay, this.lastEventType).lights;
    let bestIdx = -1;
    let bestDist = threshold;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      if (l.radius === 0) continue; // skip directional (sun/moon)
      const dx = gx - l.x;
      const dy = gy - l.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  moveLight(idx: number, gx: number, gy: number) {
    if (this.mode !== 'manual' || idx < 0 || idx >= this.manualLights.length) return;
    this.manualLights[idx].x = gx;
    this.manualLights[idx].y = gy;
  }

  addLight(x: number, y: number): number {
    if (this.mode !== 'manual') return -1;
    if (this.manualLights.length >= MAX_LIGHTS) return -1;
    this.manualLights.push({
      x, y, z: this.config.isIndoor ? 80 : 30,
      r: 1.0, g: 0.98, b: 0.95,
      intensity: 0.8,
      radius: Math.max(this.config.gridW, this.config.gridH) * 0.3,
    });
    return this.manualLights.length - 1;
  }

  removeLight(idx: number) {
    if (this.mode !== 'manual' || idx < 0 || idx >= this.manualLights.length) return;
    this.manualLights.splice(idx, 1);
    if (this.selectedIndex === idx) this.selectedIndex = -1;
    else if (this.selectedIndex > idx) this.selectedIndex--;
  }

  getSelected(): LightDef | null {
    if (this.mode !== 'manual' || this.selectedIndex < 0 || this.selectedIndex >= this.manualLights.length) return null;
    return this.manualLights[this.selectedIndex];
  }
}

export function buildLighting(
  config: RinkConfig,
  timeOfDay: number,
  eventType?: string,
): LightingState {
  const cx = config.gridW / 2;
  const cy = config.gridH / 2;
  const hx = (config.dims.lengthM / config.cellSize) / 2;
  const hy = (config.dims.widthM / config.cellSize) / 2;

  if (config.isIndoor) {
    return buildIndoorLighting(cx, cy, hx, hy, timeOfDay, eventType);
  } else {
    return buildOutdoorLighting(cx, cy, hx, hy, timeOfDay, config);
  }
}

// --- Indoor arena lighting ---

function buildIndoorLighting(
  cx: number, cy: number, hx: number, hy: number,
  tod: number, evt?: string,
): LightingState {
  const lights: LightDef[] = [];

  // Lighting level from event type or time of day
  let level: 'full' | 'medium' | 'dim';
  if (evt === 'idle') {
    level = 'dim';
  } else if (evt === 'maintenance') {
    level = 'medium';
  } else if (evt) {
    level = 'full';
  } else {
    level = (tod >= 6 && tod <= 22) ? 'full' : 'dim';
  }

  const int = level === 'full' ? 1.0 : level === 'medium' ? 0.6 : 0.12;
  const sky = level === 'full' ? 1.0 : level === 'medium' ? 0.7 : 0.12;
  const fog = level === 'full' ? 0.02 : level === 'medium' ? 0.01 : 0.0;

  if (level === 'dim') {
    // Emergency/overnight: 2 dim cool lights at rink ends
    lights.push(
      { x: cx - hx * 0.6, y: cy, z: 60, r: 0.55, g: 0.6, b: 0.85, intensity: 0.3, radius: hx * 0.8 },
      { x: cx + hx * 0.6, y: cy, z: 60, r: 0.55, g: 0.6, b: 0.85, intensity: 0.3, radius: hx * 0.8 },
    );
  } else {
    // 4 main overhead banks in rectangular pattern
    const offsets: [number, number][] = [[-0.3, -0.25], [0.3, -0.25], [-0.3, 0.25], [0.3, 0.25]];
    const colors: [number, number, number][] = [
      [1.0, 0.98, 0.95], [0.98, 0.98, 1.0],
      [1.0, 0.97, 0.93], [0.97, 0.99, 1.0],
    ];
    for (let i = 0; i < 4; i++) {
      lights.push({
        x: cx + hx * offsets[i][0], y: cy + hy * offsets[i][1], z: 80,
        r: colors[i][0], g: colors[i][1], b: colors[i][2],
        intensity: int,
        radius: Math.max(hx, hy) * 1.2,
      });
    }
    // 2 end-zone accent lights for depth
    lights.push(
      { x: cx - hx * 0.7, y: cy, z: 65, r: 0.95, g: 0.92, b: 0.87, intensity: int * 0.35, radius: hx * 0.6 },
      { x: cx + hx * 0.7, y: cy, z: 65, r: 0.95, g: 0.92, b: 0.87, intensity: int * 0.35, radius: hx * 0.6 },
    );
  }

  return { lights, skyBrightness: sky, fogDensity: fog };
}

// --- Outdoor rink lighting ---

function buildOutdoorLighting(
  cx: number, cy: number, hx: number, hy: number,
  tod: number,
  config?: RinkConfig,
): LightingState {
  const lights: LightDef[] = [];
  const sunB = computeSunBrightness(tod);
  const isNight = sunB < 0.1;
  const isDusk = sunB >= 0.1 && sunB < 0.7;
  const sky = Math.max(0.03, sunB);

  // Sun: use physically-computed atmospheric color
  if (sunB > 0.05) {
    const atm = computeAtmosphere(tod, 0);
    const angle = ((tod - 6) / 12) * Math.PI;
    const elev = Math.max(Math.sin(angle), 0.05);
    lights.push({
      x: cx + Math.cos(angle) * 200, y: cy - 100, z: Math.max(elev * 400, 30),
      r: atm.sunColor[0], g: atm.sunColor[1], b: atm.sunColor[2],
      intensity: sunB * 0.8,
      radius: 0, // directional
    });
  }

  // Night/dusk: practical light sources
  if (isNight || isDusk) {
    const fi = isNight ? 0.9 : (1.0 - sunB) * 0.7;
    const preset = config?.preset ?? 'recreational';
    const isBackyardSmall = preset === 'backyard_small';
    const isBackyardMedium = preset === 'backyard_medium';

    if (isBackyardSmall) {
      // 2 lampposts at opposite corners
      const postH = 12; // low garden lamppost
      const reach = Math.max(hx, hy) * 2.0;
      lights.push(
        { x: cx - hx - 3, y: cy - hy - 3, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.7, radius: reach },
        { x: cx + hx + 3, y: cy + hy + 3, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.7, radius: reach },
      );
    } else if (isBackyardMedium) {
      // 6 lampposts around the perimeter
      const postH = 15;
      const reach = Math.max(hx, hy) * 1.5;
      const margin = 4;
      // 2 on each long side + 1 on each short side
      lights.push(
        // Long sides (top and bottom)
        { x: cx - hx * 0.4, y: cy - hy - margin, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.6, radius: reach },
        { x: cx + hx * 0.4, y: cy - hy - margin, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.6, radius: reach },
        { x: cx - hx * 0.4, y: cy + hy + margin, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.6, radius: reach },
        { x: cx + hx * 0.4, y: cy + hy + margin, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.6, radius: reach },
        // Short sides (left and right)
        { x: cx - hx - margin, y: cy, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.6, radius: reach },
        { x: cx + hx + margin, y: cy, z: postH, r: 1.0, g: 0.92, b: 0.7, intensity: fi * 0.6, radius: reach },
      );
    } else {
      // Recreational: 8 tall floodlight poles around perimeter (realistic)
      const postH = 30;
      const reach = Math.max(hx, hy) * 2.0;
      const mx = 6; // margin from rink edge
      const my = 6;
      // 3 per long side + 1 per short side
      lights.push(
        // Top edge (3)
        { x: cx - hx * 0.5, y: cy - hy - my, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        { x: cx,             y: cy - hy - my, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        { x: cx + hx * 0.5, y: cy - hy - my, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        // Bottom edge (3)
        { x: cx - hx * 0.5, y: cy + hy + my, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        { x: cx,             y: cy + hy + my, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        { x: cx + hx * 0.5, y: cy + hy + my, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        // Short sides (1 each)
        { x: cx - hx - mx, y: cy, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
        { x: cx + hx + mx, y: cy, z: postH, r: 1.0, g: 0.97, b: 0.9, intensity: fi * 0.8, radius: reach },
      );
    }

    // Moon when dark
    if (sunB < 0.3) {
      lights.push({
        x: cx + 50, y: cy - 80, z: 300,
        r: 0.6, g: 0.65, b: 0.9,
        intensity: 0.1,
        radius: 0, // directional
      });
    }
  }

  return { lights, skyBrightness: sky, fogDensity: 0 };
}

function computeSunBrightness(tod: number): number {
  if (tod < 5 || tod >= 21) return 0;
  if (tod < 7) return smoothstep(5, 7, tod);
  if (tod <= 17) return 1.0;
  return 1.0 - smoothstep(17, 20, tod);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
