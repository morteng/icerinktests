export type RinkPreset = 'nhl' | 'olympic' | 'recreational' | 'backyard_small' | 'backyard_medium' | 'custom';
export type GroundType = 'concrete' | 'grass' | 'gravel' | 'asphalt';

export interface RinkDimensions {
  lengthM: number;
  widthM: number;
  cornerRadiusM: number;
}

export interface RinkConfig {
  gridW: number;
  gridH: number;
  cellSize: number;
  pipeSpacing: number;
  dims: RinkDimensions;
  hasPipes: boolean;
  isBackyard: boolean;
  isIndoor: boolean;
  padCells: number;
  preset: RinkPreset;
  groundColor: [number, number, number];
  groundType: GroundType;
  surfaceGroundColor: [number, number, number];
  surfaceGroundType: GroundType;
}

const PRESETS: Record<RinkPreset, { dims: RinkDimensions; hasPipes: boolean; isIndoor: boolean }> = {
  nhl:              { dims: { lengthM: 60.96, widthM: 25.91, cornerRadiusM: 8.5 }, hasPipes: true,  isIndoor: true  },
  olympic:          { dims: { lengthM: 60,    widthM: 30,    cornerRadiusM: 8.5 }, hasPipes: true,  isIndoor: true  },
  recreational:     { dims: { lengthM: 50,    widthM: 25,    cornerRadiusM: 7   }, hasPipes: true,  isIndoor: false },
  backyard_small:   { dims: { lengthM: 6,     widthM: 3,     cornerRadiusM: 0   }, hasPipes: false, isIndoor: false },
  backyard_medium:  { dims: { lengthM: 12,    widthM: 6,     cornerRadiusM: 0   }, hasPipes: false, isIndoor: false },
  custom:           { dims: { lengthM: 60.96, widthM: 25.91, cornerRadiusM: 8.5 }, hasPipes: true,  isIndoor: true  },
};

export function buildConfig(preset: RinkPreset, customDims?: Partial<RinkDimensions>, groundTypeOverride?: GroundType, surfaceGroundTypeOverride?: GroundType): RinkConfig {
  const p = PRESETS[preset];
  const dims = { ...p.dims, ...customDims };
  const isBackyard = preset === 'backyard_small' || preset === 'backyard_medium';
  const hasPipes = preset === 'custom' ? (customDims ? dims.lengthM > 15 : p.hasPipes) : p.hasPipes;
  const isIndoor = preset === 'custom' ? hasPipes : p.isIndoor;

  // Cell size: 0.08m for professional (1 pixel = 1 cell), adaptive for backyard
  const cellSize = isBackyard ? Math.max(dims.lengthM / 400, 0.015) : 0.08;

  // Padding: 4m indoor (a few rows of seats), 2m outdoor/backyard
  const padM = isIndoor ? 4.0 : 2.0;
  const padCells = Math.ceil(padM / cellSize);

  const gridW = Math.ceil(dims.lengthM / cellSize) + 2 * padCells;
  const gridH = Math.ceil(dims.widthM / cellSize) + 2 * padCells;

  // Pipe spacing: 10 cells for standard 0.06m cell (60cm visual spacing)
  const pipeSpacing = isBackyard ? 0 : 10;

  // Ground type: concrete for pro rinks, grass default for backyard (surround)
  const groundType: GroundType = groundTypeOverride
    ?? (isBackyard ? 'grass' : 'concrete');

  // Surface ground type: gravel default for backyard, same as surround for pro
  const surfaceGroundType: GroundType = surfaceGroundTypeOverride
    ?? (isBackyard ? 'gravel' : groundType);

  // Ground color based on ground type
  const GROUND_COLORS: Record<GroundType, [number, number, number]> = {
    concrete: isIndoor ? [0.92, 0.92, 0.94] : [0.15, 0.15, 0.18],
    grass: [0.22, 0.28, 0.12],
    gravel: [0.42, 0.40, 0.35],
    asphalt: [0.18, 0.18, 0.20],
  };
  const groundColor = GROUND_COLORS[groundType];
  const surfaceGroundColor = GROUND_COLORS[surfaceGroundType];

  return { gridW, gridH, cellSize, pipeSpacing, dims, hasPipes, isBackyard, isIndoor, padCells, preset, groundColor, groundType, surfaceGroundColor, surfaceGroundType };
}

export const DEFAULT_CONFIG: RinkConfig = buildConfig('nhl');

/**
 * 1D value noise: hash + smoothstep interpolation.
 * Returns value in [0, 1].
 */
function valueNoise1D(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  // Smoothstep
  const u = f * f * (3 - 2 * f);
  // Hash at integer points
  const h0 = (Math.sin(i * 127.1 + 311.7) * 43758.5) % 1;
  const h1 = (Math.sin((i + 1) * 127.1 + 311.7) * 43758.5) % 1;
  const a = h0 - Math.floor(h0);
  const b = h1 - Math.floor(h1);
  return a + (b - a) * u;
}

/**
 * Create a rink mask using rounded-rectangle SDF.
 * Returns 1.0 inside rink, 0.0 outside.
 * Backyard rinks get wavy organic edges via 1D value noise perturbation.
 */
export function createRinkMask(config: RinkConfig): Float32Array {
  const { gridW, gridH, cellSize, padCells, dims } = config;
  const mask = new Float32Array(gridW * gridH);

  const rinkCellsW = dims.lengthM / cellSize;
  const rinkCellsH = dims.widthM / cellSize;
  const cornerR = dims.cornerRadiusM / cellSize;

  // Rink center in grid coords
  const cx = gridW / 2;
  const cy = gridH / 2;

  // Half-extents of the rink rectangle (before rounding)
  const hx = rinkCellsW / 2;
  const hy = rinkCellsH / 2;

  // Noise parameters for backyard wavy edges
  const noiseAmplitude = config.isBackyard ? 2.5 : 0; // ±2.5 cells
  const noiseWavelength = 18; // cells per noise cycle

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      // Position relative to center
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const dx = Math.abs(px);
      const dy = Math.abs(py);

      let dist: number;
      if (cornerR <= 0) {
        // Pure rectangle SDF
        const ox = dx - hx;
        const oy = dy - hy;
        if (ox > 0 && oy > 0) {
          dist = Math.sqrt(ox * ox + oy * oy);
        } else {
          dist = Math.max(ox, oy);
        }
      } else {
        // Rounded rectangle SDF
        const qx = Math.max(dx - (hx - cornerR), 0);
        const qy = Math.max(dy - (hy - cornerR), 0);
        dist = Math.sqrt(qx * qx + qy * qy) - cornerR;
      }

      // Backyard: perturb the boundary with smooth noise
      if (noiseAmplitude > 0) {
        // Use angle around center for smooth wraparound
        const angle = Math.atan2(py, px);
        // Map angle to noise coordinate (wraparound-safe)
        const noiseCoord = (angle + Math.PI) / (2 * Math.PI) * (2 * (hx + hy)) / noiseWavelength;
        const perturbation = (valueNoise1D(noiseCoord * noiseWavelength / 3) - 0.5) * 2 * noiseAmplitude;
        dist += perturbation;
      }

      mask[y * gridW + x] = dist <= 0 ? 1.0 : 0.0;
    }
  }

  return mask;
}

/**
 * Two-pass counterflow pipe layout (realistic ice rink pattern).
 * Only places pipes inside the mask. Returns empty buffer when !config.hasPipes.
 */
export function createPipeLayout(config: RinkConfig, mask: Float32Array): Float32Array {
  const { gridW, gridH, pipeSpacing } = config;
  const layout = new Float32Array(gridW * gridH);

  if (!config.hasPipes || pipeSpacing <= 0) return layout;

  // Collect pipe row y-coordinates
  const pipeRows: number[] = [];
  for (let y = 0; y < gridH; y++) {
    if (y % pipeSpacing === 0) {
      // Check if this row has any masked cells
      let hasInside = false;
      for (let x = 0; x < gridW; x++) {
        if (mask[y * gridW + x] > 0.5) { hasInside = true; break; }
      }
      if (hasInside) pipeRows.push(y);
    }
  }

  const totalRows = pipeRows.length;

  // Pair adjacent rows into two-pass circuits
  for (let p = 0; p + 1 < totalRows; p += 2) {
    const yOut = pipeRows[p];
    const yRet = pipeRows[p + 1];

    // Find leftmost/rightmost masked cells for each row
    let outLeft = gridW, outRight = -1;
    for (let x = 0; x < gridW; x++) {
      if (mask[yOut * gridW + x] > 0.5) {
        if (x < outLeft) outLeft = x;
        if (x > outRight) outRight = x;
      }
    }
    let retLeft = gridW, retRight = -1;
    for (let x = 0; x < gridW; x++) {
      if (mask[yRet * gridW + x] > 0.5) {
        if (x < retLeft) retLeft = x;
        if (x > retRight) retRight = x;
      }
    }

    if (outRight < 0 || retRight < 0) continue;

    const outSpan = outRight - outLeft + 1;
    const retSpan = retRight - retLeft + 1;
    const uTurnX = Math.max(outRight, retRight);

    // Outgoing row: left→right, flow_pos ≈ 0 → 0.5
    for (let x = outLeft; x <= outRight; x++) {
      layout[yOut * gridW + x] = ((x - outLeft + 1) / (2 * outSpan));
    }

    // U-turn header at right edge (vertical connection)
    for (let hy = yOut + 1; hy < yRet; hy++) {
      if (mask[hy * gridW + uTurnX] > 0.5) {
        layout[hy * gridW + uTurnX] = 0.5;
      }
    }

    // Return row: right→left, flow_pos ≈ 0.5 → 1.0
    for (let x = retRight; x >= retLeft; x--) {
      layout[yRet * gridW + x] = 0.5 + ((retRight - x + 1) / (2 * retSpan));
    }
  }

  // If odd number of rows, last row is a single-pass circuit
  if (totalRows % 2 === 1) {
    const yLast = pipeRows[totalRows - 1];
    let left = gridW, right = -1;
    for (let x = 0; x < gridW; x++) {
      if (mask[yLast * gridW + x] > 0.5) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (right >= 0) {
      const span = right - left + 1;
      for (let x = left; x <= right; x++) {
        layout[yLast * gridW + x] = (x - left + 1) / span;
      }
    }
  }

  return layout;
}

/**
 * Create initial state as vec4 per cell: (temperature, ice, water, shavings).
 * No water outside mask.
 */
export function createInitialState(
  config: RinkConfig,
  ambientTemp: number,
  waterMm: number,
  mask: Float32Array,
  iceMm = 0,
): Float32Array {
  const cellCount = config.gridW * config.gridH;
  const data = new Float32Array(cellCount * 4);
  for (let i = 0; i < cellCount; i++) {
    const inside = mask[i] > 0.5;
    data[i * 4 + 0] = ambientTemp;
    data[i * 4 + 1] = inside ? iceMm : 0.0;
    data[i * 4 + 2] = inside ? waterMm : 0.0;
    data[i * 4 + 3] = 0.0;
  }
  return data;
}

/**
 * Create initial state2 as vec4 per cell: (snow_density, snow_lwc, mud_amount, reserved).
 * Cells with shavings (snow) get initial density; otherwise zero.
 */
export function createInitialState2(
  config: RinkConfig,
  state: Float32Array,
): Float32Array {
  const cellCount = config.gridW * config.gridH;
  const data = new Float32Array(cellCount * 4);
  // Default fresh snow density for outdoor: 80 kg/m³, indoor shavings: 400 kg/m³
  const defaultDensity = config.isIndoor ? 400.0 : 80.0;
  for (let i = 0; i < cellCount; i++) {
    const shavings = state[i * 4 + 3];
    data[i * 4 + 0] = shavings > 0.01 ? defaultDensity : 0.0; // snow_density
    data[i * 4 + 1] = 0.0; // snow_lwc
    data[i * 4 + 2] = 0.0; // mud_amount
    data[i * 4 + 3] = 0.0; // reserved
  }
  return data;
}
