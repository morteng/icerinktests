import { RinkConfig } from './rink';

/**
 * Create a solids buffer for physical collision barriers.
 *   0.0 = passable (open ice/water/air)
 *   1.0 = goal frame (blocks water AND snow)
 *   2.0 = goal net mesh (blocks snow only, water passes through)
 *
 * Goal geometry matches sprites.wgsl draw_goal_net_sprite().
 */
export function createSolidsBuffer(config: RinkConfig, mask: Float32Array): Float32Array {
  const { gridW, gridH } = config;
  const solids = new Float32Array(gridW * gridH);

  const goalOffsetM = config.preset === 'olympic' ? 4.0
    : config.isBackyard ? Math.min(2.0, config.dims.lengthM * 0.2)
    : 3.35;
  const goalOffset = goalOffsetM / config.cellSize;
  if (goalOffset <= 0) return solids;

  const rinkCellsW = config.dims.lengthM / config.cellSize;
  const rinkCellsH = config.dims.widthM / config.cellSize;
  const cx = gridW / 2;
  const cy = gridH / 2;
  const hx = rinkCellsW / 2;
  const hy = rinkCellsH / 2;

  // Two goals: left and right
  const goals = [
    { goalX: cx - hx + goalOffset, dir: -1 },
    { goalX: cx + hx - goalOffset, dir: 1 },
  ];

  const netHw = goalOffset * 0.273;
  const netDepth = goalOffset * 0.334;

  for (const goal of goals) {
    // Scan a bounding box around the goal area
    const minX = Math.max(0, Math.floor(goal.goalX - netDepth - 2));
    const maxX = Math.min(gridW - 1, Math.ceil(goal.goalX + netDepth + 2));
    const minY = Math.max(0, Math.floor(cy - netHw - 2));
    const maxY = Math.min(gridH - 1, Math.ceil(cy + netHw + 2));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = y * gridW + x;
        if (mask[idx] < 0.5) continue;

        const fpx = x + 0.5;
        const fpy = y + 0.5;
        const dx = (fpx - goal.goalX) * goal.dir;
        const dy = fpy - cy;
        const depthFrac = Math.max(0, Math.min(dx / Math.max(netDepth, 1), 1));
        const hwAtDepth = netHw + (netHw * 0.6 - netHw) * depthFrac; // mix(netHw, netHw*0.6, depthFrac)

        if (dx >= -1 && dx < netDepth + 0.5 && Math.abs(dy) < hwAtDepth + 1) {
          if (Math.abs(dy) <= hwAtDepth) {
            // Posts: front face
            const isPost = dx >= -1 && dx < 1 && Math.abs(dy) > netHw - 2;
            // Back bar
            const isBack = dx > netDepth - 1.5 && dx < netDepth + 0.5;
            // Side bars
            const isSide = Math.abs(Math.abs(dy) - hwAtDepth) < 1.2 && dx >= 0;

            if (isPost || isBack || isSide) {
              solids[idx] = 1.0; // frame: blocks both water and snow
            } else if (dx > 0.5) {
              solids[idx] = 2.0; // net mesh: blocks snow only
            }
          }
        }
      }
    }
  }

  return solids;
}

/**
 * Add fence/boards to solids buffer for backyard rink containment.
 *   3.0 = fence post (blocks water AND snow, taller — 4x4 lumber)
 *   4.0 = fence plank (blocks water AND snow — standard 2x6 or 2x8 lumber)
 *
 * Fence is 3 cells wide (inside boundary + 1 cell inward + 1 cell outward)
 * for proper height-field mesh coverage. Posts at ~1.2m intervals.
 */
export function addFenceToSolids(
  solids: Float32Array,
  config: RinkConfig,
  mask: Float32Array,
): void {
  const { gridW, gridH, cellSize } = config;

  // Post spacing: ~1.2m in cells (standard fence post spacing)
  const postSpacing = Math.max(Math.round(1.2 / cellSize), 6);

  // Pass 1: find boundary cells (inside mask, adjacent to outside)
  const isBoundary = new Uint8Array(gridW * gridH);
  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < gridW - 1; x++) {
      const idx = y * gridW + x;
      if (mask[idx] < 0.5) continue;
      const hasOutside =
        mask[(y - 1) * gridW + x] < 0.5 ||
        mask[(y + 1) * gridW + x] < 0.5 ||
        mask[y * gridW + (x - 1)] < 0.5 ||
        mask[y * gridW + (x + 1)] < 0.5;
      if (hasOutside) {
        isBoundary[idx] = 1;
      }
    }
  }

  // Pass 2: expand fence to 3 cells wide (boundary + 1 inward + 1 outward)
  const fenceCells = new Set<number>();
  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < gridW - 1; x++) {
      const idx = y * gridW + x;
      if (!isBoundary[idx]) continue;
      // Mark this cell and neighbors (creates 3-cell-wide band)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
          const ni = ny * gridW + nx;
          if (solids[ni] > 0.5) continue; // don't overwrite goals
          fenceCells.add(ni);
        }
      }
    }
  }

  // Pass 3: assign post vs plank
  for (const idx of fenceCells) {
    const x = idx % gridW;
    const y = Math.floor(idx / gridW);
    // Posts at regular intervals (2-cell-wide posts for visibility)
    const isPost = (x % postSpacing < 2 && y % postSpacing < 2);
    solids[idx] = isPost ? 3.0 : 4.0;
  }
}
