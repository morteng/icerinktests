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
