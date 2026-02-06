import { RinkConfig } from './rink';

// Marking types encoded as f32 per cell
// 0 = none, 1 = red line, 2 = blue line, 3 = red circle/dot, 4 = goal crease, 5 = center circle, 6 = boundary line

export type MarkingLayout = 'nhl' | 'olympic' | 'recreational' | 'figure' | 'none';

export function createMarkings(config: RinkConfig, mask: Float32Array, layout: MarkingLayout): Float32Array {
  const { gridW, gridH } = config;
  const buf = new Float32Array(gridW * gridH);

  const cx = gridW / 2;
  const cy = gridH / 2;
  const cellM = config.cellSize;

  function set(x: number, y: number, type: number) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix >= 0 && ix < gridW && iy >= 0 && iy < gridH && mask[iy * gridW + ix] > 0.5) {
      buf[iy * gridW + ix] = type;
    }
  }

  function mToCell(meters: number): number {
    return meters / cellM;
  }

  // --- Boundary lines (type 6): mask-edge detection (all layouts get these) ---
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (mask[y * gridW + x] < 0.5) continue;
      let atEdge = false;
      if (x === 0 || mask[y * gridW + (x - 1)] < 0.5) atEdge = true;
      if (x === gridW - 1 || mask[y * gridW + (x + 1)] < 0.5) atEdge = true;
      if (y === 0 || mask[(y - 1) * gridW + x] < 0.5) atEdge = true;
      if (y === gridH - 1 || mask[(y + 1) * gridW + x] < 0.5) atEdge = true;
      if (atEdge) {
        buf[y * gridW + x] = 6;
        if (x + 1 < gridW && mask[y * gridW + (x + 1)] > 0.5) buf[y * gridW + (x + 1)] = 6;
        if (x > 0 && mask[y * gridW + (x - 1)] > 0.5) buf[y * gridW + (x - 1)] = 6;
      }
    }
  }

  // 'none' layout: boundary lines only
  if (layout === 'none') return buf;

  const rinkL = config.dims.lengthM;
  const rinkW = config.dims.widthM;

  // --- Center red line (type 1) ---
  const centerX = Math.round(cx);
  for (let y = 0; y < gridH; y++) {
    for (let t = -2; t <= 2; t++) {
      set(centerX + t, y, 1);
    }
  }

  // 'figure' layout: center circle + center dot + boundary only
  if (layout === 'figure') {
    const centerCircleR = mToCell(4.57 * Math.min(rinkW / 25.91, 1));
    drawCircle(buf, gridW, gridH, cx, cy, centerCircleR, 5, 2, mask);
    drawDot(buf, gridW, gridH, cx, cy, mToCell(0.15), 1, mask);
    return buf;
  }

  // --- Blue lines (type 2) ---
  const blueOffsetM = 7.62 * (rinkL / 60.96);
  const blueOffset = mToCell(blueOffsetM);
  const blueLeft = Math.round(cx - blueOffset);
  const blueRight = Math.round(cx + blueOffset);
  for (let y = 0; y < gridH; y++) {
    for (let t = -2; t <= 2; t++) {
      set(blueLeft + t, y, 2);
      set(blueRight + t, y, 2);
    }
  }

  // --- Center circle (type 5) ---
  const centerCircleR = mToCell(4.57 * Math.min(rinkW / 25.91, 1));
  drawCircle(buf, gridW, gridH, cx, cy, centerCircleR, 5, 2, mask);
  drawDot(buf, gridW, gridH, cx, cy, mToCell(0.15), 1, mask);

  if (layout === 'nhl' || layout === 'olympic') {
    // --- Full NHL/Olympic markings ---

    // End zone face-off circles
    const endFaceoffXM = 9.14 * (rinkL / 60.96);
    const endFaceoffX = mToCell(endFaceoffXM);
    const faceoffYM = 6.86 * (rinkW / 25.91);
    const faceoffY = mToCell(faceoffYM);
    const faceoffCircleR = mToCell(4.57 * Math.min(rinkW / 25.91, 1));

    const endPositions = [
      { x: cx - (cx - config.padCells) + endFaceoffX, y: cy - faceoffY },
      { x: cx - (cx - config.padCells) + endFaceoffX, y: cy + faceoffY },
      { x: cx + (cx - config.padCells) - endFaceoffX, y: cy - faceoffY },
      { x: cx + (cx - config.padCells) - endFaceoffX, y: cy + faceoffY },
    ];
    for (const pos of endPositions) {
      drawCircle(buf, gridW, gridH, pos.x, pos.y, faceoffCircleR, 3, 2, mask);
      drawDot(buf, gridW, gridH, pos.x, pos.y, mToCell(0.30), 3, mask);
    }

    // Neutral zone face-off dots
    const neutralDotOffset = mToCell(1.5);
    const neutralPositions = [
      { x: blueLeft - neutralDotOffset, y: cy - faceoffY },
      { x: blueLeft - neutralDotOffset, y: cy + faceoffY },
      { x: blueRight + neutralDotOffset, y: cy - faceoffY },
      { x: blueRight + neutralDotOffset, y: cy + faceoffY },
    ];
    for (const pos of neutralPositions) {
      drawDot(buf, gridW, gridH, pos.x, pos.y, mToCell(0.30), 3, mask);
    }

    // Goal creases
    const goalLineXM = 3.35 * (rinkL / 60.96);
    const goalLineX = mToCell(goalLineXM) + config.padCells;
    const creaseR = mToCell(1.83 * Math.min(rinkW / 25.91, 1));
    drawCrease(buf, gridW, gridH, goalLineX, cy, creaseR, true, mask);
    drawCrease(buf, gridW, gridH, gridW - goalLineX, cy, creaseR, false, mask);

    // Goal lines
    for (let y = 0; y < gridH; y++) {
      for (let t = -1; t <= 1; t++) {
        set(Math.round(goalLineX) + t, y, 1);
        set(Math.round(gridW - goalLineX) + t, y, 1);
      }
    }
  } else {
    // 'recreational': center line, blue lines, 4 dots, center circle (already drawn above)
    const faceoffYM = 6.86 * (rinkW / 25.91);
    const faceoffY = mToCell(faceoffYM);
    const dotPositions = [
      { x: blueLeft - mToCell(1.5), y: cy - faceoffY },
      { x: blueLeft - mToCell(1.5), y: cy + faceoffY },
      { x: blueRight + mToCell(1.5), y: cy - faceoffY },
      { x: blueRight + mToCell(1.5), y: cy + faceoffY },
    ];
    for (const pos of dotPositions) {
      drawDot(buf, gridW, gridH, pos.x, pos.y, mToCell(0.30), 3, mask);
    }
  }

  return buf;
}

function drawCircle(
  buf: Float32Array, w: number, h: number,
  cx: number, cy: number, r: number, type: number, thickness: number,
  mask: Float32Array,
) {
  const r2min = (r - thickness) * (r - thickness);
  const r2max = (r + thickness) * (r + thickness);
  for (let dy = -Math.ceil(r + thickness); dy <= Math.ceil(r + thickness); dy++) {
    for (let dx = -Math.ceil(r + thickness); dx <= Math.ceil(r + thickness); dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2min && d2 <= r2max) {
        const ix = Math.round(cx + dx);
        const iy = Math.round(cy + dy);
        if (ix >= 0 && ix < w && iy >= 0 && iy < h && mask[iy * w + ix] > 0.5) {
          buf[iy * w + ix] = type;
        }
      }
    }
  }
}

function drawDot(
  buf: Float32Array, w: number, h: number,
  cx: number, cy: number, r: number, type: number,
  mask: Float32Array,
) {
  const r2 = r * r;
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (dx * dx + dy * dy <= r2) {
        const ix = Math.round(cx + dx);
        const iy = Math.round(cy + dy);
        if (ix >= 0 && ix < w && iy >= 0 && iy < h && mask[iy * w + ix] > 0.5) {
          buf[iy * w + ix] = type;
        }
      }
    }
  }
}

function drawCrease(
  buf: Float32Array, w: number, h: number,
  goalX: number, cy: number, r: number, leftGoal: boolean,
  mask: Float32Array,
) {
  const r2 = r * r;
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (dx * dx + dy * dy <= r2) {
        if ((leftGoal && dx >= 0) || (!leftGoal && dx <= 0)) {
          const ix = Math.round(goalX + dx);
          const iy = Math.round(cy + dy);
          if (ix >= 0 && ix < w && iy >= 0 && iy < h && mask[iy * w + ix] > 0.5) {
            buf[iy * w + ix] = 4;
          }
        }
      }
    }
  }
}
