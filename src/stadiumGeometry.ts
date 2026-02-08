import { RinkConfig } from './rink';

/**
 * Stadium geometry generator — builds 3D box geometry for boards/glass (indoor)
 * and fence posts/planks (backyard).
 *
 * Vertex format (9 floats per vertex, 36 bytes):
 *   position: vec3f (world space: X=grid x, Y=up, Z=grid y)
 *   normal:   vec3f (face normal)
 *   uv:       vec2f (texture coords)
 *   material: f32   (bitcast to u32 — zone type for fragment shader)
 *
 * Material IDs:
 *   0 = default boards
 *   1 = home bench (blue boards)
 *   2 = away bench (red boards)
 *   3 = penalty box (tan boards)
 *   4 = fence post (weathered wood, backyard)
 *   5 = fence plank (lumber, backyard)
 *   6 = door frame (dark metal)
 *   7 = scorer's table
 */

const FLOATS_PER_VERTEX = 9;
const VERTS_PER_BOX = 36; // 6 faces × 2 triangles × 3 verts

// Board/glass height zones (meters above ice surface)
const GLASS_TOP_M = 2.27;
const BOARD_TOP_M = 1.07; // dasher boards without glass

/**
 * Add a Y-axis-rotated box to the vertex array.
 * center: [x, y, z] in world space
 * halfExtents: [halfW, halfH, halfL] — W=perpendicular, H=up, L=along travel
 * rotY: rotation angle around Y axis (radians)
 * material: material ID (u32 stored as f32 via bitcast)
 */
function addBox(
  verts: number[],
  center: [number, number, number],
  halfExtents: [number, number, number],
  rotY: number,
  material: number,
): void {
  const [cx, cy, cz] = center;
  const [hw, hh, hl] = halfExtents;
  const ch = Math.cos(rotY);
  const sh = Math.sin(rotY);
  const matBits = material; // stored as f32, shader bitcasts to u32

  // Local-space face definitions:
  // Each face: 4 corners as [local_x, local_y, local_z], outward normal
  // Local: X=along rotY direction, Y=up, Z=perpendicular
  // Winding: CCW when viewed from outside (for back-face culling)
  const faces: Array<{
    corners: [number, number, number][];
    normal: [number, number, number];
  }> = [
    // Top (Y+)
    {
      corners: [[-hl, hh, -hw], [hl, hh, -hw], [hl, hh, hw], [-hl, hh, hw]],
      normal: [0, 1, 0],
    },
    // Bottom (Y-)
    {
      corners: [[-hl, -hh, hw], [hl, -hh, hw], [hl, -hh, -hw], [-hl, -hh, -hw]],
      normal: [0, -1, 0],
    },
    // Front (X+)
    {
      corners: [[hl, -hh, hw], [hl, hh, hw], [hl, hh, -hw], [hl, -hh, -hw]],
      normal: [1, 0, 0],
    },
    // Back (X-)
    {
      corners: [[-hl, -hh, -hw], [-hl, hh, -hw], [-hl, hh, hw], [-hl, -hh, hw]],
      normal: [-1, 0, 0],
    },
    // Right (Z+)
    {
      corners: [[-hl, -hh, hw], [-hl, hh, hw], [hl, hh, hw], [hl, -hh, hw]],
      normal: [0, 0, 1],
    },
    // Left (Z-)
    {
      corners: [[hl, -hh, -hw], [hl, hh, -hw], [-hl, hh, -hw], [-hl, -hh, -hw]],
      normal: [0, 0, -1],
    },
  ];

  // UV coords for each corner of a face quad (0,1,2,3)
  const uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // Triangle indices: (0,1,2) + (0,2,3)
  const triIdx = [0, 1, 2, 0, 2, 3];

  for (const face of faces) {
    // Rotate normal
    const [nx, ny, nz] = face.normal;
    const rnx = nx * ch - nz * sh;
    const rnz = nx * sh + nz * ch;

    for (const ti of triIdx) {
      const [lx, ly, lz] = face.corners[ti];
      // Rotate around Y
      const rx = lx * ch - lz * sh;
      const rz = lx * sh + lz * ch;
      // World position
      const wx = cx + rx;
      const wy = cy + ly;
      const wz = cz + rz;

      const [u, v] = uvs[ti];

      verts.push(wx, wy, wz, rnx, ny, rnz, u, v, matBits);
    }
  }
}

/**
 * Sample the rounded-rectangle contour at parametric position t (0..1).
 * Returns [x, y, nx, ny] where (x,y) is the position and (nx,ny) is the outward normal.
 */
function sampleContour(
  cx: number, cy: number,
  hx: number, hy: number,
  cr: number,
  t: number,
): [number, number, number, number] {
  // Perimeter segments: 4 straights + 4 arcs
  // Total perimeter = 2*(2*hx-2*cr) + 2*(2*hy-2*cr) + 2*PI*cr
  const straightX = 2 * (hx - cr);
  const straightY = 2 * (hy - cr);
  const arcLen = Math.PI * cr / 2; // quarter circle
  const totalPerim = 2 * straightX + 2 * straightY + 4 * arcLen;

  let d = ((t % 1) + 1) % 1 * totalPerim; // distance along perimeter

  // Segments in order: bottom straight, bottom-right arc, right straight, top-right arc,
  // top straight, top-left arc, left straight, bottom-left arc
  const segments = [
    { type: 'straight' as const, len: straightX, x0: cx - hx + cr, y0: cy + hy, dx: 1, dy: 0, nx: 0, ny: 1 },
    { type: 'arc' as const, len: arcLen, acx: cx + hx - cr, acy: cy + hy - cr, startAngle: Math.PI / 2 },
    { type: 'straight' as const, len: straightY, x0: cx + hx, y0: cy + hy - cr, dx: 0, dy: -1, nx: 1, ny: 0 },
    { type: 'arc' as const, len: arcLen, acx: cx + hx - cr, acy: cy - hy + cr, startAngle: 0 },
    { type: 'straight' as const, len: straightX, x0: cx + hx - cr, y0: cy - hy, dx: -1, dy: 0, nx: 0, ny: -1 },
    { type: 'arc' as const, len: arcLen, acx: cx - hx + cr, acy: cy - hy + cr, startAngle: -Math.PI / 2 },
    { type: 'straight' as const, len: straightY, x0: cx - hx, y0: cy - hy + cr, dx: 0, dy: 1, nx: -1, ny: 0 },
    { type: 'arc' as const, len: arcLen, acx: cx - hx + cr, acy: cy + hy - cr, startAngle: Math.PI },
  ];

  for (const seg of segments) {
    if (d <= seg.len + 0.001) {
      if (seg.type === 'straight') {
        const f = d / Math.max(seg.len, 0.001);
        const x = seg.x0! + seg.dx! * seg.len * f;
        const y = seg.y0! + seg.dy! * seg.len * f;
        return [x, y, seg.nx!, seg.ny!];
      } else {
        // Arc
        const angle = seg.startAngle! + (d / Math.max(seg.len, 0.001)) * (-Math.PI / 2);
        const x = seg.acx! + cr * Math.cos(angle);
        const y = seg.acy! + cr * Math.sin(angle);
        const nx = Math.cos(angle);
        const ny = Math.sin(angle);
        return [x, y, nx, ny];
      }
    }
    d -= seg.len;
  }

  // Fallback (shouldn't happen)
  return [cx, cy + hy, 0, 1];
}

/**
 * Segment classification for arena structures — determines material, height, and
 * whether a segment is a door opening (gap in boards).
 */
interface SegmentInfo {
  material: number;   // 0-7 (see material IDs above)
  maxHeight: number;  // GLASS_TOP_M (full) or BOARD_TOP_M (boards only)
  isDoor: boolean;    // true = skip wall box, add door frame posts instead
}

/**
 * Classify a contour segment by its position relative to rink center.
 * Returns segment info with material, height, and door status.
 */
function classifySegment(
  px: number, py: number,
  rinkCx: number, rinkCy: number,
  rinkHx: number, rinkHy: number,
  goalOffset: number,
): SegmentInfo {
  const result: SegmentInfo = { material: 0, maxHeight: GLASS_TOP_M, isDoor: false };
  if (goalOffset <= 0) return result;

  const bxRel = (px - rinkCx) / rinkHx;
  const abxRel = Math.abs(bxRel);
  const onNearSide = py > rinkCy + rinkHy * 0.4;
  const onFarSide = py < rinkCy - rinkHy * 0.4;

  // --- Near side (south): team benches + zamboni gate ---
  if (onNearSide) {
    // Zamboni gate: wide opening near one end (right side, bxRel ~0.70)
    if (bxRel > 0.64 && bxRel < 0.76) {
      result.isDoor = true;
      result.material = 6;
      result.maxHeight = GLASS_TOP_M; // tall gate frame posts
      return result;
    }

    // Bench zone
    if (abxRel > 0.03 && abxRel < 0.35) {
      // Home bench doors (left side, two doors)
      if (bxRel < 0 && (Math.abs(bxRel + 0.10) < 0.015 || Math.abs(bxRel + 0.25) < 0.015)) {
        result.isDoor = true;
        result.material = 6;
        result.maxHeight = BOARD_TOP_M;
        return result;
      }
      // Away bench doors (right side, two doors)
      if (bxRel > 0 && (Math.abs(bxRel - 0.10) < 0.015 || Math.abs(bxRel - 0.25) < 0.015)) {
        result.isDoor = true;
        result.material = 6;
        result.maxHeight = BOARD_TOP_M;
        return result;
      }
      // Regular bench boards — low height, no glass
      result.material = bxRel < 0 ? 1 : 2;
      result.maxHeight = BOARD_TOP_M;
      return result;
    }
  }

  // --- Far side (north): penalty boxes + scorer's table ---
  if (onFarSide) {
    if (abxRel < 0.17) {
      // Scorer's table (dead center between penalty boxes)
      if (abxRel < 0.035) {
        result.material = 7;
        result.maxHeight = BOARD_TOP_M;
        return result;
      }
      // Penalty box doors
      if (Math.abs(bxRel + 0.10) < 0.015 || Math.abs(bxRel - 0.10) < 0.015) {
        result.isDoor = true;
        result.material = 6;
        result.maxHeight = BOARD_TOP_M;
        return result;
      }
      // Penalty box boards
      result.material = 3;
      result.maxHeight = BOARD_TOP_M;
      return result;
    }
  }

  return result;
}

/**
 * Add door frame posts at the edges of a door opening.
 * Two thin vertical posts flanking the gap.
 */
function addDoorFrame(
  verts: number[],
  x0: number, y0: number,
  x1: number, y1: number,
  nx: number, ny: number,
  seg: SegmentInfo,
  cellSize: number,
): void {
  const isZamboniGate = seg.maxHeight === GLASS_TOP_M;
  const postWidthM = isZamboniGate ? 0.15 : 0.10;
  const postDepthM = 0.08;
  const postHeightM = seg.maxHeight;

  const postW = postWidthM / cellSize / 2;
  const postD = postDepthM / cellSize / 2;
  const postH = postHeightM / cellSize / 2;

  // Segment direction
  const dx = x1 - x0;
  const dz = y1 - y0;
  const segLen = Math.sqrt(dx * dx + dz * dz);
  if (segLen < 0.001) return;
  const rotY = Math.atan2(dz, dx);

  // Post positions: at each end of the segment, offset outward by normal
  const posts: [number, number][] = [
    [x0, y0], // left post
    [x1, y1], // right post
  ];

  for (const [px, pz] of posts) {
    const cx = px + nx * postD;
    const cy = postH;
    const cz = pz + ny * postD;
    addBox(verts, [cx, cy, cz], [postD, postH, postW], rotY, 6);
  }
}

/**
 * Add 3D goal frame + net geometry at both ends of the rink.
 * Material 11 = red metal frame, 12 = white net mesh.
 *
 * Real NHL goal: 1.83m wide × 1.22m tall × 1.12m deep (trapezoidal).
 * Frame tubes: ~5cm diameter.
 *
 * addBox coordinate reminder:
 *   halfExtents = [hw, hh, hl]
 *   Local space: X = ±hl, Y = ±hh, Z = ±hw
 *   rotY rotates local X,Z around Y axis
 *   At rotY=0: hl→worldX extent, hw→worldZ extent, hh→worldY extent
 */
function addGoalGeometry(
  verts: number[],
  config: RinkConfig,
  rinkCx: number, rinkCy: number,
  rinkHx: number, _rinkHy: number,
  cellSize: number,
): void {
  const goalOffM = config.preset === 'olympic' ? 4.0
    : config.isBackyard ? Math.min(2.0, config.dims.lengthM * 0.2)
    : 3.35;
  const goalOffset = goalOffM / cellSize;
  if (goalOffset <= 0) return;

  // Goal dimensions in cells
  const gw = 1.83 / cellSize;    // front width (along world Z)
  const gh = 1.22 / cellSize;    // front height (world Y)
  const gd = 1.12 / cellSize;    // depth (along world X, behind goal line)
  const t  = 0.05 / cellSize;    // frame tube diameter
  const ht = t / 2;              // half tube

  // Trapezoidal back frame — narrower + shorter
  const bw = gw * 0.6;
  const bh = gh * 0.65;
  const netThick = t * 0.15;

  // Helper: horizontal bar between two XZ points at given Y height.
  // rotY aligns local X with (dx,dz) direction; tube cross-section is ht × ht.
  function hbar(x0: number, z0: number, x1: number, z1: number, y: number, mat: number) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) return;
    // [hw=⊥Z, hh=Y, hl=‖X] → tube square cross-section, length along bar
    addBox(verts, [(x0 + x1) / 2, y, (z0 + z1) / 2],
      [ht, ht, len / 2], Math.atan2(dz, dx), mat);
  }

  // Helper: vertical post at (x,z) spanning yBot to yTop.
  function vpost(x: number, z: number, yBot: number, yTop: number, mat: number) {
    const hh = (yTop - yBot) / 2;
    // [hw=Z, hh=Y, hl=X] — square cross-section, height along Y
    addBox(verts, [x, yBot + hh, z], [ht, hh, ht], 0, mat);
  }

  // Two goals at each end of the rink
  const goals = [
    { fx: rinkCx - rinkHx + goalOffset, fwd: 1 },   // left — mouth faces +X (toward center)
    { fx: rinkCx + rinkHx - goalOffset, fwd: -1 },   // right — mouth faces −X (toward center)
  ];

  for (const { fx, fwd } of goals) {
    // Net extends BEHIND goal line, toward the end boards (opposite of fwd)
    const bx = fx - fwd * gd;
    const cz = rinkCy;            // center Z (rink width center)

    // Corner Z positions
    const fzL = cz - gw / 2;     // front-left
    const fzR = cz + gw / 2;     // front-right
    const bzL = cz - bw / 2;     // back-left (narrower)
    const bzR = cz + bw / 2;     // back-right

    // ── Frame (mat 11 = red metal) ──

    // Front face: two posts + crossbar
    vpost(fx, fzL, 0, gh, 11);
    vpost(fx, fzR, 0, gh, 11);
    hbar(fx, fzL, fx, fzR, gh - ht, 11);

    // Back face: shorter posts + crossbar
    vpost(bx, bzL, 0, bh, 11);
    vpost(bx, bzR, 0, bh, 11);
    hbar(bx, bzL, bx, bzR, bh - ht, 11);

    // Top connecting rails (front top → back top)
    hbar(fx, fzL, bx, bzL, (gh + bh) / 2 - ht, 11);
    hbar(fx, fzR, bx, bzR, (gh + bh) / 2 - ht, 11);

    // Bottom connecting rails (front base → back base)
    hbar(fx, fzL, bx, bzL, ht, 11);
    hbar(fx, fzR, bx, bzR, ht, 11);

    // ── Net panels (mat 12 = white mesh) ──

    // Back panel — perpendicular to X axis, centered at bx
    // rotY=PI/2 swaps: hl→worldZ (wide), hw→worldX (thin)
    addBox(verts, [bx, bh / 2, cz],
      [netThick, bh / 2 - t, bw / 2 - t], Math.PI / 2, 12);

    // Side panels — from front edge to back edge, one on each side
    for (const side of [-1, 1]) {
      const fz = cz + side * gw / 2;
      const bz = cz + side * bw / 2;
      const dx = bx - fx, dz = bz - fz;
      const len = Math.sqrt(dx * dx + dz * dz);
      const rot = Math.atan2(dz, dx);
      const avgH = (gh + bh) / 2;
      // [hw=netThick⊥, hh=height, hl=length‖] — thin perpendicular to side direction
      addBox(verts, [(fx + bx) / 2, avgH / 2, (fz + bz) / 2],
        [netThick, avgH / 2 - t, len / 2 - t], rot, 12);
    }

    // Top panel — horizontal roof, thin in Y
    {
      const avgTopY = (gh + bh) / 2 - t;
      const halfDepth = Math.abs(bx - fx) / 2;
      const midX = (fx + bx) / 2;
      const avgHalfW = (gw + bw) / 4 - t;
      // [hw=Z width, hh=Y thin, hl=X depth] at rotY=0
      addBox(verts, [midX, avgTopY, cz],
        [avgHalfW, netThick, halfDepth - t], 0, 12);
    }
  }
}

/**
 * Add arena interior structures: seat-back rows, concourse railing, zamboni tunnel.
 * Material 8 = seat backs, 9 = railing, 10 = tunnel walls.
 */
function addArenaInterior(
  verts: number[],
  config: RinkConfig,
  rinkCx: number, rinkCy: number,
  rinkHx: number, rinkHy: number,
  rinkCr: number,
  cellSize: number,
): void {
  const cellMm = cellSize * 1000;

  // Seat-back rows: thin vertical strips at the back edge of each seat tier
  const seatBackHeightM = 0.30;  // 30cm tall seat back
  const seatBackThickM = 0.05;   // 5cm thick
  const seatBackH = seatBackHeightM / cellSize;
  const seatBackThick = seatBackThickM / cellSize;

  const rowPitch = 10.0; // cells per row (matches iso_mesh.wgsl)
  const seatStart = 8.0; // concourse→seats transition dist
  const maxSeatDist = Math.max(config.gridW, config.gridH) * 0.05;
  const numRows = Math.min(Math.floor((maxSeatDist * 0.6) / rowPitch), 12);

  // Number of samples around the contour for seat backs
  const numSections = 40;
  // Aisle every ~20 seats → roughly 6-8 sections between aisles
  const aisleEvery = 20 * 7.0; // cell-space period for aisles (seat_col spacing from shader)
  const aisleWidth = 3.0; // cells gap for each aisle

  for (let row = 0; row < numRows; row++) {
    const seatDist = seatStart + row * rowPitch;
    // Height of this row's floor in cells (matches arena_height in shader)
    const baseHMm = 300 + row * 400; // concourse base + step_h per row
    const floorH = baseHMm / cellMm;
    const seatBackY = floorH + seatBackH / 2;

    for (let i = 0; i < numSections; i++) {
      const t0 = i / numSections;
      const t1 = (i + 1) / numSections;

      // Sample contour at expanded distance (offset outward by seatDist + row back edge)
      // We offset the rink half-extents by seatDist to follow the rink shape
      const expandedHx = rinkHx + seatDist + rowPitch * 0.7; // back of row
      const expandedHy = rinkHy + seatDist + rowPitch * 0.7;
      const expandedCr = rinkCr + seatDist + rowPitch * 0.7;

      const [x0, y0] = sampleContour(rinkCx, rinkCy, expandedHx, expandedHy, expandedCr, t0);
      const [x1, y1] = sampleContour(rinkCx, rinkCy, expandedHx, expandedHy, expandedCr, t1);

      // Skip sections that are out of grid
      const midX = (x0 + x1) / 2;
      const midY = (y0 + y1) / 2;
      if (midX < 2 || midX > config.gridW - 2 || midY < 2 || midY > config.gridH - 2) continue;

      const dx = x1 - x0;
      const dz = y1 - y0;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.1) continue;

      const rotY = Math.atan2(dz, dx);
      const halfLen = segLen / 2;
      const cx = (x0 + x1) / 2;
      const cz = (y0 + y1) / 2;

      addBox(verts,
        [cx, seatBackY, cz],
        [seatBackThick / 2, seatBackH / 2, halfLen],
        rotY, 8);
    }
  }

  // Concourse railing: ring of posts + horizontal rail at transition from concourse to seating
  const railingDist = seatStart - 0.5; // just inside the seating area
  const railingHeightM = 1.05; // 1.05m railing
  const railingH = railingHeightM / cellSize;
  const postWidthM = 0.06;
  const postDepthM = 0.06;
  const postW = postWidthM / cellSize;
  const postD = postDepthM / cellSize;
  const railH = 0.04 / cellSize; // thin rail bar

  const railExpandedHx = rinkHx + railingDist;
  const railExpandedHy = rinkHy + railingDist;
  const railExpandedCr = rinkCr + railingDist;

  // Concourse floor height
  const concourseFloorH = 300 / cellMm;

  // Post spacing: ~3m around contour
  const railPerim = 2 * (2 * railExpandedHx + 2 * railExpandedHy - 4 * railExpandedCr) + 2 * Math.PI * railExpandedCr;
  const postSpacingM = 3.0;
  const postSpacingCells = postSpacingM / cellSize;
  const numPosts = Math.max(Math.floor(railPerim / postSpacingCells), 8);

  for (let i = 0; i < numPosts; i++) {
    const t = i / numPosts;
    const [px, py] = sampleContour(rinkCx, rinkCy, railExpandedHx, railExpandedHy, railExpandedCr, t);
    if (px < 2 || px > config.gridW - 2 || py < 2 || py > config.gridH - 2) continue;

    // Vertical post
    addBox(verts,
      [px, concourseFloorH + railingH / 2, py],
      [postW / 2, railingH / 2, postD / 2],
      0, 9);
  }

  // Horizontal rail sections
  const numRailSegs = numPosts;
  for (let i = 0; i < numRailSegs; i++) {
    const t0 = i / numRailSegs;
    const t1 = (i + 1) / numRailSegs;
    const [x0, y0] = sampleContour(rinkCx, rinkCy, railExpandedHx, railExpandedHy, railExpandedCr, t0);
    const [x1, y1] = sampleContour(rinkCx, rinkCy, railExpandedHx, railExpandedHy, railExpandedCr, t1);
    if (x0 < 2 || x0 > config.gridW - 2 || x1 < 2 || x1 > config.gridW - 2) continue;
    if (y0 < 2 || y0 > config.gridH - 2 || y1 < 2 || y1 > config.gridH - 2) continue;

    const dx = x1 - x0;
    const dz = y1 - y0;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.1) continue;
    const rotY = Math.atan2(dz, dx);

    addBox(verts,
      [(x0 + x1) / 2, concourseFloorH + railingH, (y0 + y1) / 2],
      [railH / 2, railH / 2, segLen / 2],
      rotY, 9);
  }

  // Zamboni tunnel: short corridor behind the zamboni gate
  // Gate is at bxRel ~0.70 on the near side (py > rinkCy)
  const gateX = rinkCx + rinkHx * 0.70;
  const gateZ = rinkCy + rinkHy + 3; // just outside the boards
  const tunnelWidthM = 4.0;
  const tunnelHeightM = 3.0;
  const tunnelDepthM = 6.0;
  const tw = tunnelWidthM / cellSize / 2;
  const th = tunnelHeightM / cellSize / 2;
  const td = tunnelDepthM / cellSize / 2;

  // Left wall
  addBox(verts,
    [gateX - tw, th, gateZ + td],
    [0.15, th, td],
    0, 10);

  // Right wall
  addBox(verts,
    [gateX + tw, th, gateZ + td],
    [0.15, th, td],
    0, 10);

  // Ceiling
  addBox(verts,
    [gateX, th * 2, gateZ + td],
    [tw, 0.1, td],
    0, 10);
}

/**
 * Generate stadium geometry for indoor rinks (boards + glass around perimeter).
 */
function generateIndoorGeometry(config: RinkConfig): Float32Array {
  const verts: number[] = [];
  const cellSize = config.cellSize;

  // Rink center and half-extents in grid coordinates
  const rinkCx = config.gridW / 2;
  const rinkCy = config.gridH / 2;
  const rinkHx = config.dims.lengthM / cellSize / 2;
  const rinkHy = config.dims.widthM / cellSize / 2;
  const rinkCr = config.dims.cornerRadiusM / cellSize;

  // Goal offset for bench detection
  const goalOffM = config.preset === 'olympic' ? 4.0
    : config.isBackyard ? Math.min(2.0, config.dims.lengthM * 0.2)
    : 3.35;
  const goalOffset = goalOffM / cellSize;

  // Sample contour every ~0.5m
  const stepM = 0.5;
  const stepCells = stepM / cellSize;
  // Approximate perimeter
  const perimCells = 2 * (2 * rinkHx + 2 * rinkHy - 4 * rinkCr) + 2 * Math.PI * rinkCr;
  const numSamples = Math.max(Math.floor(perimCells / stepCells), 20);

  // Box thickness: 2 cells outward from contour
  const thickness = 2.0; // cells
  const halfThick = thickness / 2;

  // Heights in cells (from ice surface at Y=0)
  const totalHeight = GLASS_TOP_M / cellSize;
  const halfH = totalHeight / 2;

  for (let i = 0; i < numSamples; i++) {
    const t0 = i / numSamples;
    const t1 = (i + 1) / numSamples;

    const [x0, y0, nx0, ny0] = sampleContour(rinkCx, rinkCy, rinkHx, rinkHy, rinkCr, t0);
    const [x1, y1, nx1, ny1] = sampleContour(rinkCx, rinkCy, rinkHx, rinkHy, rinkCr, t1);

    // Midpoint for segment classification
    const midX = (x0 + x1) / 2;
    const midY = (y0 + y1) / 2;
    const seg = classifySegment(midX, midY, rinkCx, rinkCy, rinkHx, rinkHy, goalOffset);

    // Average outward normal
    const avgNx = (nx0 + nx1) / 2;
    const avgNy = (ny0 + ny1) / 2;
    const nLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy) || 1;
    const onx = avgNx / nLen;
    const ony = avgNy / nLen;

    if (seg.isDoor) {
      // Door opening: skip wall, add frame posts at edges
      addDoorFrame(verts, x0, y0, x1, y1, onx, ony, seg, cellSize);
    } else {
      // Solid wall segment with variable height
      const h = seg.maxHeight / cellSize;
      const halfSegH = h / 2;

      const segCx = (x0 + x1) / 2 + onx * halfThick;
      const segCy = halfSegH;
      const segCz = (y0 + y1) / 2 + ony * halfThick;

      const dx = x1 - x0;
      const dz = y1 - y0;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      const halfLen = segLen / 2;

      const rotY = Math.atan2(dz, dx);

      addBox(verts, [segCx, segCy, segCz], [halfThick, halfSegH, halfLen], rotY, seg.material);
    }
  }

  // Goal geometry — 3D voxel frames + net panels at each end
  addGoalGeometry(verts, config, rinkCx, rinkCy, rinkHx, rinkHy, cellSize);

  // Arena interior structures — seat backs, railing, tunnel
  addArenaInterior(verts, config, rinkCx, rinkCy, rinkHx, rinkHy, rinkCr, cellSize);

  // Scorer's table surface: flat box centered between penalty boxes on far side
  {
    const tableWidthM = 3.0;
    const tableDepthM = 0.8;
    const tableHeightM = 0.90;
    const tw = tableWidthM / cellSize / 2;
    const td = tableDepthM / cellSize / 2;
    const th = tableHeightM / cellSize / 2;
    // Position: centered on far side (north), just outside the rink contour
    const tableCx = rinkCx;
    const tableCy = th;
    const tableCz = rinkCy - rinkHy - 1.5; // slightly outside boards
    // [hw=Z depth, hh=Y height, hl=X width along boards]
    addBox(verts, [tableCx, tableCy, tableCz], [td, th, tw], 0, 7);
  }

  return new Float32Array(verts);
}

/**
 * Generate stadium geometry for backyard rinks (fence posts + planks from solids buffer).
 */
function generateBackyardGeometry(config: RinkConfig, solids: Float32Array): Float32Array {
  const verts: number[] = [];
  const { gridW, gridH, cellSize } = config;
  const cellMm = cellSize * 1000;

  // Scan solids buffer for fence cells and merge into rectangular boxes
  // Simple approach: scan row by row for runs of same solid type

  // Track which cells have been consumed
  const consumed = new Uint8Array(gridW * gridH);

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const idx = y * gridW + x;
      if (consumed[idx]) continue;
      const solidVal = solids[idx];
      if (solidVal < 2.5) continue; // not fence

      const isPost = solidVal < 3.5;
      const material = isPost ? 4 : 5;
      const heightMm = isPost ? 220 : 180;

      // Expand rectangle rightward and downward
      let maxX = x;
      while (maxX + 1 < gridW) {
        const ni = y * gridW + (maxX + 1);
        if (consumed[ni] || Math.abs(solids[ni] - solidVal) > 0.1) break;
        maxX++;
      }

      let maxY = y;
      outer:
      while (maxY + 1 < gridH) {
        for (let xx = x; xx <= maxX; xx++) {
          const ni = (maxY + 1) * gridW + xx;
          if (consumed[ni] || Math.abs(solids[ni] - solidVal) > 0.1) break outer;
        }
        maxY++;
      }

      // Mark consumed
      for (let yy = y; yy <= maxY; yy++) {
        for (let xx = x; xx <= maxX; xx++) {
          consumed[yy * gridW + xx] = 1;
        }
      }

      // Create box
      const bw = maxX - x + 1;
      const bh = maxY - y + 1;
      const boxCx = x + bw / 2;
      const boxCy = heightMm / cellMm / 2; // half height in cells
      const boxCz = y + bh / 2;
      const halfW = bw / 2;
      const halfH = heightMm / cellMm / 2;
      const halfL = bh / 2;

      // No rotation for axis-aligned fence boxes
      // Note: addBox uses [halfW(perp), halfH(up), halfL(along)], rotY
      // For fence we swap W and L based on box orientation:
      // The box local X maps to world X after rotation=0
      addBox(verts, [boxCx, boxCy, boxCz], [halfL, halfH, halfW], Math.PI / 2, material);
    }
  }

  return new Float32Array(verts);
}

/**
 * Generate stadium geometry for the current rink configuration.
 * Returns Float32Array of interleaved vertex data (9 floats per vertex).
 */
export function generateStadiumGeometry(config: RinkConfig, solids: Float32Array): Float32Array {
  if (config.isBackyard) {
    return generateBackyardGeometry(config, solids);
  }
  if (config.isIndoor || config.hasPipes) {
    return generateIndoorGeometry(config);
  }
  // Outdoor non-backyard (recreational) — still has boards
  return generateIndoorGeometry(config);
}
