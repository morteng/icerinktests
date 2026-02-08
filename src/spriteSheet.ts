/**
 * Sprite sheet atlas generator + GPU texture management.
 *
 * Atlas layout:
 *   Columns: 8 directions × 4 animation frames = 32 cells per row
 *   Rows: one per sprite variant
 *     0: Hockey team 0 (blue)
 *     1: Hockey team 1 (red)
 *     2: Figure skater
 *     3: Public skater
 *     4: Zamboni
 *     5: Shovel person
 *     6: Water tank
 *     7: Goal net
 *
 * Cell size: 32×48 pixels (width × height)
 * Direction order: 0=front, 1=front-right, 2=right, 3=back-right,
 *                  4=back, 5=back-left, 6=left, 7=front-left
 */

export const CELL_W = 32;
export const CELL_H = 48;
export const DIR_COUNT = 8;
export const FRAME_COUNT = 4;
export const COLS = DIR_COUNT * FRAME_COUNT; // 32
export const ROW_COUNT = 8;       // built-in sprite rows
export const MAX_ROW_COUNT = 16;  // total rows including injected custom sprites

// Row indices
export const ROW_HOCKEY_BLUE = 0;
export const ROW_HOCKEY_RED = 1;
export const ROW_FIGURE = 2;
export const ROW_PUBLIC = 3;
export const ROW_ZAMBONI = 4;
export const ROW_SHOVEL = 5;
export const ROW_WATER_TANK = 6;
export const ROW_GOAL = 7;

// ---- Multi-cell span system ----
// Each row declares a span {w, h} in base cells.
// 1x1 = 32x48 px, 2x2 = 64x96 px
export const CELL_SPANS: Array<{ w: number; h: number }> = [
  { w: 1, h: 1 }, // 0: hockey blue
  { w: 1, h: 1 }, // 1: hockey red
  { w: 1, h: 1 }, // 2: figure
  { w: 1, h: 1 }, // 3: public
  { w: 2, h: 2 }, // 4: zamboni
  { w: 1, h: 1 }, // 5: shovel
  { w: 2, h: 2 }, // 6: water tank
  { w: 1, h: 1 }, // 7: goal
  { w: 1, h: 1 }, // 8-15: custom (default 1x1)
  { w: 1, h: 1 },
  { w: 1, h: 1 },
  { w: 1, h: 1 },
  { w: 1, h: 1 },
  { w: 1, h: 1 },
  { w: 1, h: 1 },
  { w: 1, h: 1 },
];

// Maximum span width across all rows (determines atlas width)
const MAX_SPAN_W = Math.max(...CELL_SPANS.map(s => s.w)); // 2

// Atlas pixel dimensions
export const ATLAS_PX_W = COLS * MAX_SPAN_W * CELL_W; // 32 * 2 * 32 = 2048
export const ATLAS_PX_H = CELL_SPANS.reduce((sum, s) => sum + s.h * CELL_H, 0); // 864

// Precomputed row Y pixel offsets into the atlas
export const ROW_Y_OFFSETS: number[] = [];
{
  let y = 0;
  for (let i = 0; i < MAX_ROW_COUNT; i++) {
    ROW_Y_OFFSETS.push(y);
    y += CELL_SPANS[i].h * CELL_H;
  }
}

/** Get the frame pixel size for a given row. */
export function getFrameSize(row: number): [number, number] {
  const span = CELL_SPANS[row] ?? { w: 1, h: 1 };
  return [span.w * CELL_W, span.h * CELL_H];
}

// ---- Atlas generation ----

let cachedAtlas: HTMLCanvasElement | null = null;

/** Get or create the sprite atlas (cached — only generated once). */
export function getOrCreateAtlas(): HTMLCanvasElement {
  if (!cachedAtlas) {
    cachedAtlas = generateSpriteAtlas();
  }
  return cachedAtlas;
}

export function generateSpriteAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_PX_W;
  canvas.height = ATLAS_PX_H;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  console.log('[SpriteAtlas] Generating %dx%d atlas (%d rows × %d cols, multi-cell spans)',
    canvas.width, canvas.height, MAX_ROW_COUNT, COLS);

  for (let dir = 0; dir < DIR_COUNT; dir++) {
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      const col = dir * FRAME_COUNT + frame;
      const phase = frame / FRAME_COUNT;

      drawHockeySkater(ctx, col, ROW_HOCKEY_BLUE, dir, phase, 'blue');
      drawHockeySkater(ctx, col, ROW_HOCKEY_RED, dir, phase, 'red');
      drawFigureSkater(ctx, col, ROW_FIGURE, dir, phase);
      drawPublicSkater(ctx, col, ROW_PUBLIC, dir, phase);
      drawZamboni(ctx, col, ROW_ZAMBONI, dir);
      drawShovelPerson(ctx, col, ROW_SHOVEL, dir, phase);
      drawWaterTank(ctx, col, ROW_WATER_TANK, dir);
      drawGoal(ctx, col, ROW_GOAL, dir);
    }
  }

  console.log('[SpriteAtlas] Done (%dx%d)', canvas.width, canvas.height);

  return canvas;
}

// ---- GPU texture creation ----

export function createAtlasTexture(device: GPUDevice, canvas: HTMLCanvasElement): GPUTexture {
  const texture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture },
    [canvas.width, canvas.height],
  );

  return texture;
}

// ---- Drawing helpers ----

type Dir = number; // 0-7
type TeamColor = 'blue' | 'red';

/** Get X pixel offset for a column in the given row (span-aware).
 *  Each column slot is MAX_SPAN_W * CELL_W wide; the frame is left-aligned within it. */
function cellX(col: number): number {
  return col * MAX_SPAN_W * CELL_W;
}
/** Get Y pixel offset for a row (span-aware, variable row heights). */
function cellY(row: number): number { return ROW_Y_OFFSETS[row] ?? 0; }

// Body width scale by direction (front=1.0, side=0.65)
function bodyScale(dir: Dir): number {
  if (dir === 0 || dir === 4) return 1.0;
  if (dir === 2 || dir === 6) return 0.65;
  return 0.85; // diagonals
}

function isFront(dir: Dir): boolean { return dir === 0 || dir === 1 || dir === 7; }
function isBack(dir: Dir): boolean { return dir === 3 || dir === 4 || dir === 5; }
function isSide(dir: Dir): boolean { return dir === 2 || dir === 6; }
function isLeft(dir: Dir): boolean { return dir >= 5 && dir <= 7; }

// All drawing uses coords relative to cell (0,0)-(CELL_W, CELL_H)
// with y=0 at TOP of cell (canvas convention), feet at bottom.
// Sprite body occupies roughly:
//   Head: y 2-12, Torso: y 12-26, Pants: y 26-34, Legs: y 34-44, Skates: y 44-48

function drawHead(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir,
  skinColor: string,
  helmetColor: string,
  hairColor: string,
) {
  const cx = ox + CELL_W / 2;
  const cy = oy + 7;
  const r = 5;
  const ws = bodyScale(dir);

  // Helmet/hair base
  ctx.fillStyle = isBack(dir) ? hairColor : helmetColor;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * ws, r, 0, 0, Math.PI * 2);
  ctx.fill();

  if (isFront(dir)) {
    // Face
    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 1, 3.5 * ws, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (isSide(dir)) {
    // Side profile: half face
    const faceX = dir === 6 ? cx + 1 : cx - 1;
    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.ellipse(faceX, cy + 1, 2.5, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Back: just helmet/hair, no face
}

function drawTorso(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir,
  mainColor: string,
  altColor: string,
) {
  const cx = ox + CELL_W / 2;
  const top = oy + 12;
  const h = 14;
  const halfW = 7 * bodyScale(dir);

  ctx.fillStyle = mainColor;
  ctx.fillRect(cx - halfW, top, halfW * 2, h);

  if (isBack(dir)) {
    // Number on back
    ctx.fillStyle = altColor;
    ctx.fillRect(cx - 3, top + 3, 6, 7);
  } else if (isFront(dir)) {
    // Logo/stripe
    ctx.fillStyle = altColor;
    ctx.fillRect(cx - 4, top + 4, 8, 3);
  }
}

/** Draw arms with swing animation. */
function drawArms(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir,
  phase: number,
  sleeveColor: string,
  skinColor: string,
  armLen?: number,
) {
  const cx = ox + CELL_W / 2;
  const ws = bodyScale(dir);
  const shoulderY = oy + 14;
  const len = armLen ?? 10;
  const swing = Math.sin(phase * Math.PI * 2) * 3;

  if (isSide(dir)) {
    // Side view: one arm visible, swinging forward/back
    const ax = isLeft(dir) ? cx + 4 * ws : cx - 4 * ws;
    // Upper arm (sleeve)
    ctx.fillStyle = sleeveColor;
    ctx.fillRect(ax - 1.5, shoulderY, 3, 6);
    // Lower arm + hand (skin)
    ctx.fillStyle = skinColor;
    ctx.fillRect(ax - 1.5 + swing * 0.3, shoulderY + 6, 3, len - 6);
  } else if (isFront(dir) || dir === 1 || dir === 7) {
    // Front/front-diagonal: both arms visible, alternating swing
    const shoulderOff = 7 * ws;
    // Left arm
    ctx.fillStyle = sleeveColor;
    ctx.fillRect(cx - shoulderOff - 3, shoulderY - swing * 0.5, 3, 6);
    ctx.fillStyle = skinColor;
    ctx.fillRect(cx - shoulderOff - 3, shoulderY + 6 - swing * 0.5, 3, len - 6);
    // Right arm
    ctx.fillStyle = sleeveColor;
    ctx.fillRect(cx + shoulderOff, shoulderY + swing * 0.5, 3, 6);
    ctx.fillStyle = skinColor;
    ctx.fillRect(cx + shoulderOff, shoulderY + 6 + swing * 0.5, 3, len - 6);
  } else if (isBack(dir)) {
    // Back/back-diagonal: both arms visible from behind
    const shoulderOff = 7 * ws;
    ctx.fillStyle = sleeveColor;
    ctx.fillRect(cx - shoulderOff - 3, shoulderY + swing * 0.5, 3, 6);
    ctx.fillStyle = skinColor;
    ctx.fillRect(cx - shoulderOff - 3, shoulderY + 6 + swing * 0.5, 3, len - 6);
    ctx.fillStyle = sleeveColor;
    ctx.fillRect(cx + shoulderOff, shoulderY - swing * 0.5, 3, 6);
    ctx.fillStyle = skinColor;
    ctx.fillRect(cx + shoulderOff, shoulderY + 6 - swing * 0.5, 3, len - 6);
  }
}

function drawPants(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir,
  color: string,
) {
  const cx = ox + CELL_W / 2;
  const top = oy + 26;
  const h = 8;
  const halfW = 6 * bodyScale(dir);

  ctx.fillStyle = color;
  ctx.fillRect(cx - halfW, top, halfW * 2, h);
}

function drawLegs(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir,
  phase: number,
  legColor: string,
  skateColor: string,
) {
  const cx = ox + CELL_W / 2;
  const top = oy + 34;
  const stride = Math.sin(phase * Math.PI * 2) * 3;

  if (isSide(dir)) {
    // Single visible leg with stride
    const lx = cx + stride * 0.5;
    ctx.fillStyle = legColor;
    ctx.fillRect(lx - 2.5, top, 5, 8);
    ctx.fillStyle = skateColor;
    ctx.fillRect(lx - 3, top + 8, 6, 4);
  } else {
    // Two legs
    const l1 = cx - 3 + stride;
    const l2 = cx + 3 - stride;
    ctx.fillStyle = legColor;
    ctx.fillRect(l1 - 2, top, 4, 8);
    ctx.fillRect(l2 - 2, top, 4, 8);
    ctx.fillStyle = skateColor;
    ctx.fillRect(l1 - 2.5, top + 8, 5, 4);
    ctx.fillRect(l2 - 2.5, top + 8, 5, 4);
  }
}

function drawStick(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir,
  phase: number,
) {
  const cx = ox + CELL_W / 2;
  const swing = Math.cos(phase * Math.PI * 2) * 2;
  const mirror = isLeft(dir);

  ctx.strokeStyle = '#7a6035';
  ctx.lineWidth = 2;

  if (isSide(dir) || dir === 1 || dir === 7) {
    // Side: stick extends forward
    const sx = mirror ? cx - 10 : cx + 10;
    ctx.beginPath();
    ctx.moveTo(sx, oy + 18 + swing);
    ctx.lineTo(sx + (mirror ? -2 : 2), oy + 40);
    ctx.stroke();
    // Blade
    ctx.fillStyle = '#222';
    const bx = sx + (mirror ? -4 : -2);
    ctx.fillRect(bx, oy + 40, 6, 3);
  } else if (isFront(dir)) {
    // Front: stick to the right
    const sx = cx + 11;
    ctx.beginPath();
    ctx.moveTo(sx, oy + 16 + swing);
    ctx.lineTo(sx, oy + 40);
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.fillRect(sx - 3, oy + 40, 7, 3);
  } else if (isBack(dir)) {
    // Back: stick visible to one side
    const sx = cx + 10;
    ctx.beginPath();
    ctx.moveTo(sx, oy + 18 - swing);
    ctx.lineTo(sx + 1, oy + 40);
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.fillRect(sx - 2, oy + 40, 6, 3);
  }
}

// ---- Sprite type drawers ----

function drawHockeySkater(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir, phase: number,
  team: TeamColor,
) {
  const ox = cellX(col);
  const oy = cellY(row);

  const mainColor = team === 'blue' ? '#2244bb' : '#bb2222';
  const altColor = team === 'blue' ? '#4466dd' : '#dd4444';
  const helmetColor = team === 'blue' ? '#2838aa' : '#aa2828';
  const gloveColor = team === 'blue' ? '#1a2266' : '#661a1a';

  drawHead(ctx, ox, oy, dir, '#dab893', helmetColor, helmetColor);
  drawTorso(ctx, ox, oy, dir, mainColor, altColor);
  // Arms in jersey color with gloves
  drawArms(ctx, ox, oy, dir, phase, mainColor, gloveColor, 11);
  drawPants(ctx, ox, oy, dir, '#282830');
  drawLegs(ctx, ox, oy, dir, phase, '#404048', '#333338');
  drawStick(ctx, ox, oy, dir, phase);
}

function drawFigureSkater(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir, phase: number,
) {
  const ox = cellX(col);
  const oy = cellY(row);

  // Costume drawn in WHITE — shader tints per-skater
  const costumeColor = '#ffffff';
  const costumeDark = '#cccccc';

  drawHead(ctx, ox, oy, dir, '#dab893', '#3a2010', '#3a2010');

  // Costume body + flared skirt
  const cx = ox + CELL_W / 2;
  const ws = bodyScale(dir);
  const top = oy + 12;

  ctx.fillStyle = isBack(dir) ? costumeDark : costumeColor;
  // Upper body
  ctx.fillRect(cx - 6 * ws, top, 12 * ws, 10);
  // Flared skirt
  ctx.beginPath();
  ctx.moveTo(cx - 6 * ws, top + 10);
  ctx.lineTo(cx - 9 * ws, top + 20);
  ctx.lineTo(cx + 9 * ws, top + 20);
  ctx.lineTo(cx + 6 * ws, top + 10);
  ctx.fill();

  // Sparkle dots
  ctx.fillStyle = '#ffffee';
  for (let i = 0; i < 3; i++) {
    const sx = cx + (i - 1) * 4 * ws;
    const sy = top + 5 + (i % 2) * 6;
    ctx.fillRect(sx - 0.5, sy - 0.5, 1.5, 1.5);
  }

  // Expressive arms (graceful, wide swing)
  const armSwing = Math.sin(phase * Math.PI * 2 + 0.5) * 5;
  const shoulderY = oy + 14;
  if (isSide(dir)) {
    const ax = isLeft(dir) ? cx + 5 * ws : cx - 5 * ws;
    ctx.fillStyle = '#dab893';
    ctx.save();
    ctx.translate(ax, shoulderY);
    ctx.rotate((-0.8 + armSwing * 0.08) * (isLeft(dir) ? -1 : 1));
    ctx.fillRect(-1.5, 0, 3, 10);
    ctx.restore();
  } else {
    const shoulderOff = 7 * ws;
    ctx.fillStyle = '#dab893';
    // Left arm — raised/lowered gracefully
    ctx.save();
    ctx.translate(cx - shoulderOff - 1, shoulderY);
    ctx.rotate(-0.6 - armSwing * 0.06);
    ctx.fillRect(-1.5, 0, 3, 10);
    ctx.restore();
    // Right arm — opposite phase
    ctx.save();
    ctx.translate(cx + shoulderOff + 1, shoulderY);
    ctx.rotate(0.6 + armSwing * 0.06);
    ctx.fillRect(-1.5, 0, 3, 10);
    ctx.restore();
  }

  // Legs (tights colored like skin)
  drawLegs(ctx, ox, oy, dir, phase, '#dab893', '#e8e8ee');
}

function drawPublicSkater(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir, phase: number,
) {
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + CELL_W / 2;

  // Hat drawn in WHITE — shader tints per-skater
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - 4 * bodyScale(dir), oy + 1, 8 * bodyScale(dir), 4);

  drawHead(ctx, ox, oy, dir, '#dab893', '#4a3020', '#4a3020');

  // Scarf (front only) — also tintable white
  if (isFront(dir)) {
    ctx.fillStyle = '#dddddd';
    ctx.fillRect(cx - 5 * bodyScale(dir), oy + 11, 10 * bodyScale(dir), 2);
  }

  // Jacket drawn in WHITE — shader tints per-skater
  const jacketColor = '#ffffff';
  const jacketDark = '#cccccc';
  drawTorso(ctx, ox, oy, dir, isBack(dir) ? jacketDark : jacketColor, jacketColor);

  // Zipper line (front)
  if (isFront(dir)) {
    ctx.fillStyle = '#888888';
    ctx.fillRect(cx - 0.5, oy + 13, 1, 12);
  }

  // Arms in jacket color with mittens
  drawArms(ctx, ox, oy, dir, phase, isBack(dir) ? jacketDark : jacketColor, '#cccccc', 10);

  drawPants(ctx, ox, oy, dir, '#2a2a3a');
  drawLegs(ctx, ox, oy, dir, phase, '#222230', '#404048');
}

function drawZamboni(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir,
) {
  const [fw, fh] = getFrameSize(row);
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + fw / 2;

  // Scale factor relative to original 32x48 drawing
  const sx = fw / CELL_W;
  const sy = fh / CELL_H;

  // Redesigned zamboni: low, wide machine with cab at rear end.
  // Key: body is SHORT and WIDE (not tall), cab offset to rear (not centered on top).
  const facingR = dir === 1 || dir === 2 || dir === 3;
  const facingL = dir === 5 || dir === 6 || dir === 7;
  const isSide = dir === 2 || dir === 6;
  const isFB = dir === 0 || dir === 4;

  // Machine body: wide and flat (key to looking mechanical, not humanoid)
  const bW = (isSide ? 27 : isFB ? 20 : 24) * sx;
  const bH = 9 * sy;
  const bTop = oy + 25 * sy;

  // Hopper/snow tank dimensions (sits on rear-center of body)
  const hopW = bW * 0.50;
  const hopH = 7 * sy;
  const hopTop = bTop - hopH;

  // Cab dimensions (at rear end, taller than hopper)
  const cabW = bW * 0.34;
  const cabH = 10 * sy;
  const cabTop = bTop - cabH;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, oy + 42 * sy, bW * 0.52, 3.5 * sy, 0, 0, Math.PI * 2);
  ctx.fill();

  // === WHEELS (behind body) ===
  ctx.fillStyle = '#16161c';
  if (isFB) {
    ctx.fillRect(cx - bW / 2 + 1 * sx, bTop + bH - 1 * sy, 4 * sx, 6 * sy);
    ctx.fillRect(cx + bW / 2 - 5 * sx, bTop + bH - 1 * sy, 4 * sx, 6 * sy);
    ctx.fillRect(cx - bW * 0.15, bTop + bH, 3 * sx, 5 * sy);
    ctx.fillRect(cx + bW * 0.15 - 3 * sx, bTop + bH, 3 * sx, 5 * sy);
    ctx.fillStyle = '#2e2e36';
    ctx.fillRect(cx - bW / 2 + 2 * sx, bTop + bH + 1 * sy, 2 * sx, 3 * sy);
    ctx.fillRect(cx + bW / 2 - 4 * sx, bTop + bH + 1 * sy, 2 * sx, 3 * sy);
  } else if (isSide) {
    ctx.fillRect(cx - bW * 0.33, bTop + bH - 1 * sy, 5 * sx, 6 * sy);
    ctx.fillRect(cx + bW * 0.21, bTop + bH - 1 * sy, 5 * sx, 6 * sy);
    ctx.fillStyle = '#2a2a32';
    ctx.fillRect(cx - bW * 0.32, bTop + bH, 3 * sx, 4 * sy);
    ctx.fillRect(cx + bW * 0.22, bTop + bH, 3 * sx, 4 * sy);
  } else {
    const s = facingR ? 1 : -1;
    ctx.fillRect(cx + s * bW * 0.28, bTop + bH - 1 * sy, 5 * sx, 5 * sy);
    ctx.fillRect(cx - s * bW * 0.22, bTop + bH, 4 * sx, 5 * sy);
    ctx.fillRect(cx + s * bW * 0.02, bTop + bH + 1 * sy, 4 * sx, 4 * sy);
  }

  // === BODY DEPTH (3D side face) ===
  if (facingR) {
    ctx.fillStyle = '#9c9ca4';
    ctx.fillRect(cx, bTop + 2 * sy, bW / 2, bH);
  }
  if (facingL) {
    ctx.fillStyle = '#9c9ca4';
    ctx.fillRect(cx - bW / 2, bTop + 2 * sy, bW / 2, bH);
  }

  // === MAIN BODY (chassis — wide, flat, clearly a vehicle platform) ===
  ctx.fillStyle = '#ccccd4';
  ctx.fillRect(cx - bW / 2, bTop, bW, bH);
  ctx.fillStyle = '#dcdce4';
  ctx.fillRect(cx - bW / 2, bTop, bW, 1 * sy);          // top highlight
  ctx.fillStyle = '#606068';
  ctx.fillRect(cx - bW / 2, bTop + bH - 1 * sy, bW, 1 * sy); // undercarriage
  ctx.fillStyle = '#b0b0b8';
  ctx.fillRect(cx - bW / 2, bTop + 4 * sy, bW, 1 * sy);      // horizontal trim

  // === HOPPER TANK (snow container — the big boxy part on top) ===
  // Shifted toward rear so it reads as "on the back half of the machine"
  let hopCX = cx;
  if (!isFB) {
    const rearSign = facingR ? -1 : 1;
    hopCX = cx + rearSign * bW * 0.06;
  }
  // Hopper depth face
  if (facingR) {
    ctx.fillStyle = '#a4a4ac';
    ctx.fillRect(hopCX, hopTop + 2 * sy, hopW / 2, hopH);
  }
  if (facingL) {
    ctx.fillStyle = '#a4a4ac';
    ctx.fillRect(hopCX - hopW, hopTop + 2 * sy, hopW / 2, hopH);
  }
  // Hopper main face
  ctx.fillStyle = '#b8b8c4';
  ctx.fillRect(hopCX - hopW / 2, hopTop, hopW, hopH);
  // Hopper rim (open top for snow)
  ctx.fillStyle = '#d4d4e0';
  ctx.fillRect(hopCX - hopW / 2, hopTop, hopW, 1 * sy);
  ctx.fillRect(hopCX - hopW / 2, hopTop + hopH - 1 * sy, hopW, 1 * sy);
  // Snow mound visible inside
  ctx.fillStyle = '#e8e8f4';
  ctx.fillRect(hopCX - hopW * 0.35, hopTop + 1 * sy, hopW * 0.7, 2 * sy);

  // === CAB (driver compartment at REAR END — breaks the humanoid silhouette) ===
  if (dir === 0) {
    // Facing toward viewer: cab is at rear (far side), peeks above hopper
    const peekH = 4 * sy;
    ctx.fillStyle = '#dddde4';
    ctx.fillRect(cx - cabW / 2, hopTop - peekH, cabW, peekH);
    ctx.fillStyle = '#4a6888'; // windshield
    ctx.fillRect(cx - cabW * 0.3, hopTop - peekH + 1 * sy, cabW * 0.6, 2 * sy);
    ctx.fillStyle = '#ff8800'; // warning light
    ctx.fillRect(cx - 1.5 * sx, hopTop - peekH - 1 * sy, 3 * sx, 1 * sy);
  } else if (dir === 4) {
    // Facing away: cab closest to viewer (prominent rear view)
    ctx.fillStyle = '#d0d0d8';
    ctx.fillRect(cx - cabW / 2, cabTop, cabW, cabH);
    ctx.fillStyle = '#c0c0c8';
    ctx.fillRect(cx - cabW / 2, cabTop, cabW, 2 * sy); // roof
    ctx.fillStyle = '#4a6888'; // rear window
    ctx.fillRect(cx - cabW * 0.3, cabTop + 3 * sy, cabW * 0.6, cabH * 0.35);
    ctx.fillStyle = '#cc2020'; // tail lights
    ctx.fillRect(cx - cabW / 2 + 1 * sx, bTop - 2 * sy, 2 * sx, 2 * sy);
    ctx.fillRect(cx + cabW / 2 - 3 * sx, bTop - 2 * sy, 2 * sx, 2 * sy);
    ctx.fillStyle = '#ff8800'; // warning light
    ctx.fillRect(cx - 1.5 * sx, cabTop - 2 * sy, 3 * sx, 2 * sy);
  } else {
    // Side/diagonal views: cab at rear end of body
    const rearSign = facingR ? -1 : 1;
    const cabCX = cx + rearSign * (bW / 2 - cabW / 2 - 1 * sx);
    // Cab depth face
    if (facingR) {
      ctx.fillStyle = '#b0b0b8';
      ctx.fillRect(cabCX, cabTop + 2 * sy, cabW / 2, cabH);
    }
    if (facingL) {
      ctx.fillStyle = '#b0b0b8';
      ctx.fillRect(cabCX - cabW, cabTop + 2 * sy, cabW / 2, cabH);
    }
    // Cab main face
    ctx.fillStyle = '#dddde4';
    ctx.fillRect(cabCX - cabW / 2, cabTop, cabW, cabH);
    ctx.fillStyle = '#c0c0c8';
    ctx.fillRect(cabCX - cabW / 2, cabTop, cabW, 2 * sy); // roof
    // Side window
    ctx.fillStyle = '#4a6888';
    if (isSide) {
      ctx.fillRect(cabCX - cabW * 0.35, cabTop + 3 * sy, cabW * 0.7, cabH * 0.4);
      ctx.fillStyle = 'rgba(140,180,220,0.3)'; // reflection
      ctx.fillRect(cabCX - cabW * 0.15, cabTop + 4 * sy, cabW * 0.2, cabH * 0.2);
    } else {
      const winX = facingR ? cabCX - cabW * 0.3 : cabCX - cabW * 0.15;
      ctx.fillRect(winX, cabTop + 3 * sy, cabW * 0.5, cabH * 0.4);
    }
    // Warning light
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(cabCX - 1.5 * sx, cabTop - 2 * sy, 3 * sx, 2 * sy);
    ctx.fillStyle = '#ffaa30';
    ctx.fillRect(cabCX - 1 * sx, cabTop - 3 * sy, 2 * sx, 1 * sy);
  }

  // === CONDITIONER BLADE (at front end) ===
  if (dir === 0 || dir === 1 || dir === 7) {
    // Front-facing: blade visible below body
    ctx.fillStyle = '#606870';
    ctx.fillRect(cx - bW * 0.44, bTop + bH, bW * 0.88, 3 * sy);
    ctx.fillStyle = '#4080a8'; // water nozzle bar
    ctx.fillRect(cx - bW * 0.36, bTop + bH + 3 * sy, bW * 0.72, 2 * sy);
  } else if (dir !== 4 && dir !== 3 && dir !== 5) {
    // Side views: blade at front end
    const frontSign = facingR ? 1 : -1;
    const bladeX = cx + frontSign * bW / 2 - (facingR ? 3 * sx : 0);
    ctx.fillStyle = '#606870';
    ctx.fillRect(bladeX, bTop + bH - 2 * sy, 3 * sx, 6 * sy);
    ctx.fillStyle = '#4080a8';
    ctx.fillRect(bladeX, bTop + bH + 3 * sy, 3 * sx, 2 * sy);
  }

  // === DETAILS ===
  // Hazard stripes on visible side panel
  ctx.fillStyle = '#e09000';
  if (facingR) {
    ctx.fillRect(cx + bW / 2 - 3 * sx, bTop + 2 * sy, 2 * sx, 2 * sy);
    ctx.fillRect(cx + bW / 2 - 3 * sx, bTop + 5 * sy, 2 * sx, 2 * sy);
  }
  if (facingL) {
    ctx.fillRect(cx - bW / 2 + 1 * sx, bTop + 2 * sy, 2 * sx, 2 * sy);
    ctx.fillRect(cx - bW / 2 + 1 * sx, bTop + 5 * sy, 2 * sx, 2 * sy);
  }

  // Logo stripe on body
  ctx.fillStyle = '#3060a0';
  ctx.fillRect(cx - 3 * sx, bTop + 1 * sy, 6 * sx, 2 * sy);

  // Auger pipe (connects blade to hopper, visible from side)
  if (!isFB) {
    const frontSign = facingR ? 1 : -1;
    ctx.fillStyle = '#888890';
    ctx.fillRect(cx + frontSign * bW * 0.08, bTop - 1 * sy, bW * 0.22, 2 * sy);
  }

  // Exhaust pipe (at rear)
  if (!isFB) {
    const rearSign = facingR ? -1 : 1;
    ctx.fillStyle = '#505058';
    ctx.fillRect(cx + rearSign * (bW / 2 - 6 * sx), hopTop - 2 * sy, 2 * sx, 3 * sy);
    ctx.fillStyle = '#404048';
    ctx.fillRect(cx + rearSign * (bW / 2 - 6 * sx), hopTop - 3 * sy, 2 * sx, 1 * sy);
  }
}

function drawShovelPerson(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir, phase: number,
) {
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + CELL_W / 2;
  const mirror = isLeft(dir);

  // Head with toque
  ctx.fillStyle = '#cc2222';
  ctx.fillRect(cx - 3 * bodyScale(dir), oy + 1, 6 * bodyScale(dir), 4);
  drawHead(ctx, ox, oy, dir, '#dab893', '#cc2222', '#4a3020');

  // Winter jacket
  drawTorso(ctx, ox, oy, dir, '#1a4a6a', '#2a5a7a');
  // Arms holding shovel
  drawArms(ctx, ox, oy, dir, phase, '#1a4a6a', '#dab893', 10);
  drawPants(ctx, ox, oy, dir, '#3a3020');
  drawLegs(ctx, ox, oy, dir, phase, '#2a2018', '#333');

  // Snow shovel — wide scoop, visible from all angles
  const bsc = bodyScale(dir);
  if (!isBack(dir)) {
    // Handle (wooden pole)
    const hx = mirror ? cx - 10 : cx + 10;
    ctx.strokeStyle = '#7a6a40';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hx, oy + 14);
    ctx.lineTo(hx + (mirror ? 3 : -3), oy + 40);
    ctx.stroke();
    // Wide scoop blade (metal)
    const bladeW = 14 * bsc;
    const bladeX = hx - bladeW / 2 + (mirror ? 2 : -2);
    ctx.fillStyle = '#707880';
    ctx.fillRect(bladeX, oy + 40, bladeW, 4);
    // Scoop lip (curled edge)
    ctx.fillStyle = '#585e66';
    ctx.fillRect(bladeX, oy + 44, bladeW, 2);
    // Highlight on blade
    ctx.fillStyle = '#8a9098';
    ctx.fillRect(bladeX + 1, oy + 40, bladeW - 2, 1);
  } else {
    // Back view: handle visible, blade on ground in front
    ctx.strokeStyle = '#7a6a40';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, oy + 14);
    ctx.lineTo(cx, oy + 40);
    ctx.stroke();
    const bladeW = 14 * bsc;
    ctx.fillStyle = '#707880';
    ctx.fillRect(cx - bladeW / 2, oy + 40, bladeW, 3);
    ctx.fillStyle = '#585e66';
    ctx.fillRect(cx - bladeW / 2, oy + 43, bladeW, 2);
  }
}

function drawWaterTank(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir,
) {
  const [fw, fh] = getFrameSize(row);
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + fw / 2;

  // Scale factor relative to original 32x48 drawing
  const sx = fw / CELL_W;
  const sy = fh / CELL_H;

  const tankW = (dir === 2 || dir === 6 ? 22 : dir === 0 || dir === 4 ? 18 : 20) * sx;
  const tankH = 16 * sy;
  const tankTop = oy + 14 * sy;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.ellipse(cx, oy + 42 * sy, tankW * 0.5, 3 * sy, 0, 0, Math.PI * 2);
  ctx.fill();

  // Side panel (depth)
  if (dir === 2 || dir === 1 || dir === 3) {
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(cx, tankTop + 2 * sy, tankW / 2, tankH);
  }
  if (dir === 6 || dir === 5 || dir === 7) {
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(cx - tankW / 2, tankTop + 2 * sy, tankW / 2, tankH);
  }

  // Main tank body (rusty metal)
  ctx.fillStyle = '#7a5030';
  ctx.fillRect(cx - tankW / 2, tankTop, tankW, tankH);

  // Rivet bands
  ctx.fillStyle = '#5a3820';
  ctx.fillRect(cx - tankW / 2, tankTop + 4 * sy, tankW, 1.5 * sy);
  ctx.fillRect(cx - tankW / 2, tankTop + 10 * sy, tankW, 1.5 * sy);

  // Rust patches
  ctx.fillStyle = '#8a4828';
  ctx.fillRect(cx - tankW * 0.2, tankTop + 2 * sy, 4 * sx, 3 * sy);
  ctx.fillRect(cx + tankW * 0.1, tankTop + 7 * sy, 3 * sx, 4 * sy);

  // Fill cap on top
  ctx.fillStyle = '#505058';
  ctx.fillRect(cx - 3 * sx, tankTop - 4 * sy, 6 * sx, 5 * sy);
  ctx.fillStyle = '#606870';
  ctx.fillRect(cx - 2 * sx, tankTop - 3 * sy, 4 * sx, 3 * sy);

  // Handle/push bar
  ctx.fillStyle = '#404048';
  if (dir === 0 || dir === 1 || dir === 7) {
    ctx.fillRect(cx - tankW * 0.35, tankTop - 8 * sy, 2 * sx, 6 * sy);
    ctx.fillRect(cx + tankW * 0.35 - 2 * sx, tankTop - 8 * sy, 2 * sx, 6 * sy);
    ctx.fillRect(cx - tankW * 0.35, tankTop - 8 * sy, tankW * 0.7, 2 * sy);
  } else if (!(dir === 4 || dir === 3 || dir === 5)) {
    const barX = dir === 2 ? cx - tankW / 2 - 2 * sx : cx + tankW / 2;
    ctx.fillRect(barX, tankTop - 6 * sy, 2 * sx, 8 * sy);
  }

  // Wheels
  const wheelY = tankTop + tankH;
  ctx.fillStyle = '#1a1a20';
  if (dir === 0 || dir === 4) {
    ctx.fillRect(cx - tankW / 2 - 1 * sx, wheelY, 4 * sx, 5 * sy);
    ctx.fillRect(cx + tankW / 2 - 3 * sx, wheelY, 4 * sx, 5 * sy);
  } else if (dir === 2 || dir === 6) {
    ctx.fillRect(cx - tankW * 0.3, wheelY + 1 * sy, 5 * sx, 5 * sy);
    ctx.fillRect(cx + tankW * 0.15, wheelY + 1 * sy, 5 * sx, 5 * sy);
  } else {
    const sign = (dir === 1 || dir === 3) ? 1 : -1;
    ctx.fillRect(cx + sign * tankW * 0.3, wheelY, 4 * sx, 5 * sy);
    ctx.fillRect(cx - sign * tankW * 0.15, wheelY + 1 * sy, 4 * sx, 4 * sy);
  }

  // Drip nozzles
  if (dir === 0 || dir === 1 || dir === 7) {
    ctx.fillStyle = '#606068';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(cx - 6 * sx + i * 5 * sx, wheelY + 5 * sy, 3 * sx, 3 * sy);
    }
    ctx.fillStyle = 'rgba(100,160,220,0.5)';
    ctx.fillRect(cx - 5 * sx, wheelY + 7 * sy, 10 * sx, 2 * sy);
  }
}

function drawGoal(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir,
) {
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + CELL_W / 2;

  // Goal mouth width varies by viewing angle
  const postH = 36;
  const barY = oy + 6;
  // Net depth (how far back the net extends, in pixels)
  const netDepth = 10;

  if (dir === 0) {
    // Front: full goal mouth visible, net behind
    const postL = ox + 3;
    const postR = ox + 27;
    // Net behind (drawn first)
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 5; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(220,220,230,0.5)' : 'rgba(220,220,230,0.0)';
        ctx.fillRect(postL + 3 + nx * 4, barY + 3 + ny * 4, 4, 4);
      }
    }
    // Frame
    ctx.fillStyle = '#dd2020';
    ctx.fillRect(postL, barY, 3, postH);     // left post
    ctx.fillRect(postR, barY, 3, postH);     // right post
    ctx.fillRect(postL, barY, postR - postL + 3, 3); // crossbar
  } else if (dir === 4) {
    // Back: rear netting visible, frame behind
    const postL = ox + 3;
    const postR = ox + 27;
    // Back net (denser, slightly darker)
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 5; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(200,200,210,0.6)' : 'rgba(200,200,210,0.0)';
        ctx.fillRect(postL + 3 + nx * 4, barY + 3 + ny * 4, 4, 4);
      }
    }
    // Back bar (frame visible at top through net)
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(postL + 1, barY + postH - 2, postR - postL + 1, 2); // bottom bar
    // Side frames (seen from behind)
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(postL, barY, 2, postH);
    ctx.fillRect(postR + 1, barY, 2, postH);
    ctx.fillRect(postL, barY, postR - postL + 3, 2);
  } else if (dir === 2) {
    // Right side: one post closest, net stretches left
    // Net (receding into depth)
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 3; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(220,220,230,0.5)' : 'rgba(220,220,230,0.0)';
        ctx.fillRect(cx - netDepth + nx * 4, barY + 3 + ny * 4, 4, 4);
      }
    }
    // Near post (right side, prominent)
    ctx.fillStyle = '#dd2020';
    ctx.fillRect(cx + 2, barY, 3, postH);
    // Far post (left side, thinner)
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(cx - netDepth - 1, barY, 2, postH);
    // Crossbar (foreshortened)
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(cx - netDepth - 1, barY, netDepth + 4, 3);
    // Top net bar
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(cx - netDepth - 1, barY + postH - 1, netDepth + 4, 2);
  } else if (dir === 6) {
    // Left side: mirror of dir=2
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 3; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(220,220,230,0.5)' : 'rgba(220,220,230,0.0)';
        ctx.fillRect(cx + nx * 4, barY + 3 + ny * 4, 4, 4);
      }
    }
    ctx.fillStyle = '#dd2020';
    ctx.fillRect(cx - 5, barY, 3, postH);
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(cx + netDepth - 1, barY, 2, postH);
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(cx - 5, barY, netDepth + 6, 3);
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(cx - 5, barY + postH - 1, netDepth + 6, 2);
  } else if (dir === 1) {
    // Front-right: 3/4 view — wider mouth, some depth
    const mouthW = 20;
    const postL = cx - mouthW / 2;
    const postR = cx + mouthW / 2;
    // Net
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 4; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(220,220,230,0.5)' : 'rgba(220,220,230,0.0)';
        ctx.fillRect(postL + 2 + nx * 4.5, barY + 3 + ny * 4, 4, 4);
      }
    }
    ctx.fillStyle = '#dd2020';
    ctx.fillRect(postR, barY, 3, postH);     // near post
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(postL, barY, 2, postH);     // far post
    ctx.fillRect(postL, barY, mouthW + 3, 3); // crossbar
  } else if (dir === 7) {
    // Front-left: mirror of dir=1
    const mouthW = 20;
    const postL = cx - mouthW / 2;
    const postR = cx + mouthW / 2;
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 4; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(220,220,230,0.5)' : 'rgba(220,220,230,0.0)';
        ctx.fillRect(postL + 2 + nx * 4.5, barY + 3 + ny * 4, 4, 4);
      }
    }
    ctx.fillStyle = '#dd2020';
    ctx.fillRect(postL - 1, barY, 3, postH);  // near post
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(postR, barY, 2, postH);       // far post
    ctx.fillRect(postL - 1, barY, mouthW + 3, 3);
  } else if (dir === 3) {
    // Back-right: rear 3/4
    const mouthW = 18;
    const postL = cx - mouthW / 2;
    const postR = cx + mouthW / 2;
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 4; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(210,210,220,0.5)' : 'rgba(210,210,220,0.0)';
        ctx.fillRect(postL + 2 + nx * 4, barY + 3 + ny * 4, 4, 4);
      }
    }
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(postR, barY, 3, postH);
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(postL, barY, 2, postH);
    ctx.fillRect(postL, barY, mouthW + 3, 2);
    ctx.fillRect(postL, barY + postH - 1, mouthW + 3, 2);
  } else {
    // Back-left (dir=5): mirror of dir=3
    const mouthW = 18;
    const postL = cx - mouthW / 2;
    const postR = cx + mouthW / 2;
    for (let ny = 0; ny < 8; ny++) {
      for (let nx = 0; nx < 4; nx++) {
        ctx.fillStyle = (nx + ny) % 2 === 0 ? 'rgba(210,210,220,0.5)' : 'rgba(210,210,220,0.0)';
        ctx.fillRect(postL + 2 + nx * 4, barY + 3 + ny * 4, 4, 4);
      }
    }
    ctx.fillStyle = '#cc1c1c';
    ctx.fillRect(postL - 1, barY, 3, postH);
    ctx.fillStyle = '#bb1818';
    ctx.fillRect(postR, barY, 2, postH);
    ctx.fillRect(postL - 1, barY, mouthW + 3, 2);
    ctx.fillRect(postL - 1, barY + postH - 1, mouthW + 3, 2);
  }
}

// ---- Sampler creation ----

export function createAtlasSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    minFilter: 'nearest',
    magFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
}

// ---- Height atlas for parallax relief mapping ----

let cachedHeightAtlas: HTMLCanvasElement | null = null;

/** Get or create height atlas (cached). */
export function getOrCreateHeightAtlas(): HTMLCanvasElement {
  if (!cachedHeightAtlas) {
    cachedHeightAtlas = generateHeightAtlas(getOrCreateAtlas());
  }
  return cachedHeightAtlas;
}

/**
 * Generate a height + normal map atlas matching the color atlas layout.
 * Channel encoding:
 *   R = height (0-255 → normalized in shader)
 *   G = normal.x (encoded: 128 + 127 * nx, where nx ∈ [-1, 1])
 *   B = normal.y (encoded: 128 + 127 * ny, where ny ∈ [-1, 1])
 * Normal.z is reconstructed in the shader: sqrt(1 - nx² - ny²)
 *
 * Height profiles per sprite type:
 * - Skaters (rows 0-3, 5): color-aware body parts — dome head, neck indent,
 *   arm cylinders, leg separation, flat skates, stick ridges
 * - Vehicles (rows 4, 6): cab high, body medium, wheels low
 * - Goals (row 7): frame high, net medium
 *
 * Normals computed via Sobel filter with color-boundary detail perturbations.
 */
export function generateHeightAtlas(colorAtlas: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = colorAtlas.width;
  canvas.height = colorAtlas.height;
  const ctx = canvas.getContext('2d')!;

  // Read color atlas to determine opaque pixels
  const colorCtx = colorAtlas.getContext('2d')!;
  const colorData = colorCtx.getImageData(0, 0, colorAtlas.width, colorAtlas.height);

  const heightData = ctx.createImageData(canvas.width, canvas.height);

  // --- Pass 1: Generate height values in R channel ---
  for (let row = 0; row < MAX_ROW_COUNT; row++) {
    const [framePxW, framePxH] = getFrameSize(row);
    const rowOy = ROW_Y_OFFSETS[row];

    for (let col = 0; col < COLS; col++) {
      const cellOx = col * MAX_SPAN_W * CELL_W; // column slot origin

      for (let py = 0; py < framePxH; py++) {
        for (let px = 0; px < framePxW; px++) {
          const gx = cellOx + px;
          const gy = rowOy + py;
          if (gx >= colorAtlas.width || gy >= colorAtlas.height) continue;
          const ci = (gy * colorAtlas.width + gx) * 4;

          // Only generate height for opaque pixels
          const alpha = colorData.data[ci + 3];
          if (alpha < 128) continue;

          // Local UV within frame (0-1)
          const lu = px / framePxW;
          const lv = 1.0 - py / framePxH; // flip: y=0 at bottom (feet)

          // Center distance for roundness (0 = center, 1 = edge)
          const centerDist = Math.abs(lu - 0.5) * 2.0;

          // Color data for body-part detection
          const cr = colorData.data[ci];
          const cg = colorData.data[ci + 1];
          const cb = colorData.data[ci + 2];

          let height = 0;

          if (row <= 3 || row === ROW_SHOVEL) {
            height = computeSkaterHeight(lv, centerDist, cr, cg, cb, lu);
          } else if (row === ROW_ZAMBONI) {
            height = computeVehicleHeight(lv, centerDist, 180);
          } else if (row === ROW_WATER_TANK) {
            height = computeVehicleHeight(lv, centerDist, 140);
          } else if (row === ROW_GOAL) {
            height = computeGoalHeight(lu, lv, cr, cg, cb);
          } else if (row >= ROW_COUNT) {
            height = computeSkaterHeight(lv, centerDist, cr, cg, cb, lu);
          }

          const h = Math.max(0, Math.min(255, Math.round(height)));
          const hi = (gy * canvas.width + gx) * 4;
          heightData.data[hi + 0] = h;   // R = height
          heightData.data[hi + 1] = 128; // G = normal.x (neutral)
          heightData.data[hi + 2] = 128; // B = normal.y (neutral)
          heightData.data[hi + 3] = 255;
        }
      }
    }
  }

  // --- Pass 2: Compute normals via Sobel filter, encode into G/B channels ---
  const w = canvas.width;
  const h = canvas.height;
  // Helper to read height at pixel (clamped, returns 0 for transparent)
  const hAt = (x: number, y: number): number => {
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    return heightData.data[(y * w + x) * 4]; // R channel = height
  };

  for (let row = 0; row < MAX_ROW_COUNT; row++) {
    const [framePxW, framePxH] = getFrameSize(row);
    const rowOy = ROW_Y_OFFSETS[row];

    for (let col = 0; col < COLS; col++) {
      const cellOx = col * MAX_SPAN_W * CELL_W;

      for (let py = 0; py < framePxH; py++) {
        for (let px = 0; px < framePxW; px++) {
          const gx = cellOx + px;
          const gy = rowOy + py;
          if (gx >= w || gy >= h) continue;
          const hi = (gy * w + gx) * 4;
          if (heightData.data[hi + 3] < 255) continue; // skip transparent

          // Sobel 3x3 for X gradient
          const gxSobel =
            -1 * hAt(gx - 1, gy - 1) + 1 * hAt(gx + 1, gy - 1)
            - 2 * hAt(gx - 1, gy)     + 2 * hAt(gx + 1, gy)
            - 1 * hAt(gx - 1, gy + 1) + 1 * hAt(gx + 1, gy + 1);

          // Sobel 3x3 for Y gradient (note: canvas Y is inverted vs UV Y)
          const gySobel =
            -1 * hAt(gx - 1, gy - 1) - 2 * hAt(gx, gy - 1) - 1 * hAt(gx + 1, gy - 1)
            + 1 * hAt(gx - 1, gy + 1) + 2 * hAt(gx, gy + 1) + 1 * hAt(gx + 1, gy + 1);

          // Normalize gradient to get tangent-space normal
          // Scale factor controls how "bumpy" the normals appear
          const scale = 4.0;
          const nx = -gxSobel / (255.0 * scale);
          const ny = gySobel / (255.0 * scale); // flip Y: canvas down = UV up
          const nz = 1.0;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
          const nnx = nx / len;
          const nny = ny / len;

          // Add detail perturbations from color boundaries
          // Jersey/clothing edges create fold normals
          const cr = colorData.data[(gy * w + gx) * 4];
          const cg = colorData.data[(gy * w + gx) * 4 + 1];
          const cb = colorData.data[(gy * w + gx) * 4 + 2];
          let detailNx = nnx;
          let detailNy = nny;

          // Detect color boundaries (jersey edges, face border) for micro-detail
          if (gx > 0 && gx < w - 1) {
            const crL = colorData.data[(gy * w + gx - 1) * 4];
            const crR = colorData.data[(gy * w + gx + 1) * 4];
            const colorDiff = Math.abs(cr - crL) + Math.abs(cr - crR)
              + Math.abs(cg - colorData.data[(gy * w + gx - 1) * 4 + 1])
              + Math.abs(cg - colorData.data[(gy * w + gx + 1) * 4 + 1]);
            if (colorDiff > 120) {
              // Color boundary: add subtle fold normal
              detailNx += (crR - crL) * 0.001;
            }
          }

          // Encode: 128 + 127 * n → [1, 255] range
          const encG = Math.max(1, Math.min(255, Math.round(128 + 127 * detailNx)));
          const encB = Math.max(1, Math.min(255, Math.round(128 + 127 * detailNy)));

          heightData.data[hi + 1] = encG; // G = normal.x
          heightData.data[hi + 2] = encB; // B = normal.y
        }
      }
    }
  }

  ctx.putImageData(heightData, 0, 0);
  console.log('[SpriteAtlas] Height+normal atlas generated (%dx%d)', canvas.width, canvas.height);
  return canvas;
}

function computeSkaterHeight(
  v: number,
  centerDist: number,
  r?: number,
  g?: number,
  b?: number,
  lu?: number,
): number {
  // v: 0 = feet, 1 = top of head; lu: 0-1 horizontal position within sprite
  // Color-aware body part detection when RGBA provided
  const hasColor = r !== undefined && g !== undefined && b !== undefined;
  const lum = hasColor ? (r! + g! + b!) / 3 : 128;

  // Detect skin pixels (warm tone: R high, G medium, B lower)
  const isSkin = hasColor && r! > 160 && g! > 100 && b! > 60 && r! > b! + 30;
  // Detect dark bottom pixels (skates/boots)
  const isDark = hasColor && lum < 70 && v < 0.15;
  // Detect stick/pole (brown: R>G>B, thin, elongated)
  const isStick = hasColor && r! > 80 && r! < 180 && g! > 50 && g! < 140 && b! < 80 && r! > b! + 20;

  // Base height profile
  let baseH: number;
  if (v > 0.85) {
    // Head — steeper dome with neck indentation at base
    const headV = (v - 0.85) / 0.15;
    const domeH = Math.sqrt(Math.max(0, 1.0 - headV * headV));
    // Neck pinch at bottom of head range
    const neckFactor = Math.min(1.0, (v - 0.85) / 0.03);
    baseH = 33 + 15 * domeH * (0.7 + 0.3 * neckFactor);
    if (isSkin) baseH += 2; // Face protrudes slightly
  } else if (v > 0.75) {
    // Neck/shoulder transition — narrower
    const t = (v - 0.75) / 0.10;
    baseH = 28 + 5 * t;
    // Neck is narrower than torso
    if (centerDist > 0.3) baseH *= 0.85;
  } else if (v > 0.42) {
    // Torso — widest part, slightly flattened front-to-back
    const t = (v - 0.42) / 0.33;
    baseH = 18 + 14 * t;
  } else if (v > 0.20) {
    // Pants/hips
    baseH = 10 + 8 * (v - 0.20) / 0.22;
  } else if (v > 0.06) {
    // Legs — detect left/right leg as separate cylinders
    baseH = 3 + 7 * (v - 0.06) / 0.14;
    if (lu !== undefined) {
      // Two-cylinder leg separation (gap in center)
      const legCenter = Math.abs(lu - 0.5);
      if (legCenter < 0.04 && v < 0.18) {
        baseH *= 0.5; // Gap between legs
      }
    }
  } else {
    // Skates (ground level) — flat
    baseH = isDark ? 1.0 : 1.5 + 1.5 * v / 0.06;
  }

  // Stick/pole pixels: thin raised ridge
  if (isStick && centerDist > 0.3) {
    baseH = Math.max(baseH, 8);
    // Reduce roundness falloff for thin objects
    return baseH * 0.7;
  }

  // Apply roundness (elliptical cross-section)
  const roundness = Math.sqrt(Math.max(0, 1.0 - centerDist * centerDist));

  // Arms: detect lateral extent and model as separate volumes
  if (lu !== undefined && v > 0.42 && v < 0.78) {
    const armDist = Math.abs(lu - 0.5);
    if (armDist > 0.28 && armDist < 0.5) {
      // Arm region: smaller cylinder offset from torso
      const armCenter = (armDist - 0.28) / 0.22; // 0 at shoulder, 1 at hand
      const armRound = Math.sqrt(Math.max(0, 1.0 - armCenter * armCenter * 0.8));
      return Math.max(6, baseH * 0.5) * armRound;
    }
  }

  return baseH * roundness;
}

function computeVehicleHeight(v: number, centerDist: number, maxH: number): number {
  // Vehicles: boxy shape, cab on top
  let baseH: number;
  if (v > 0.65) {
    // Cab/top area
    baseH = maxH * 0.7 + maxH * 0.3 * ((v - 0.65) / 0.35);
  } else if (v > 0.10) {
    // Main body
    baseH = maxH * 0.3 + maxH * 0.4 * ((v - 0.10) / 0.55);
  } else {
    // Wheels/base
    baseH = maxH * 0.1 + maxH * 0.2 * (v / 0.10);
  }

  // Slightly rounded sides (less round than person)
  const roundness = 1.0 - centerDist * centerDist * 0.3;
  return baseH * Math.max(0, roundness);
}

function computeGoalHeight(u: number, v: number, r: number, g: number, b: number): number {
  // Goal: red frame is tall, net is medium height
  const isRed = r > 180 && g < 80 && b < 80;
  if (isRed) {
    return 200; // frame posts/crossbar
  }
  // Net — moderate height, decreasing toward back
  return 40 + 40 * v;
}

// ---- Runtime sprite injection ----

export type SpriteDrawFn = (
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: number, frame: number, phase: number,
  frameW: number, frameH: number,
) => void;

/**
 * Inject a custom sprite into atlas row (8-15).
 * Calls drawFn for all 32 cells, regenerates height atlas.
 * Returns both canvases for GPU texture upload.
 */
export function injectSpriteRow(
  row: number,
  drawFn: SpriteDrawFn,
): { colorCanvas: HTMLCanvasElement; heightCanvas: HTMLCanvasElement } {
  if (row < ROW_COUNT || row >= MAX_ROW_COUNT) {
    throw new Error(`injectSpriteRow: row must be ${ROW_COUNT}-${MAX_ROW_COUNT - 1}, got ${row}`);
  }

  const atlas = getOrCreateAtlas();
  const ctx = atlas.getContext('2d')!;

  // Clear the target row region (span-aware)
  const [framePxW, framePxH] = getFrameSize(row);
  const oy = ROW_Y_OFFSETS[row];
  ctx.clearRect(0, oy, atlas.width, framePxH);

  // Draw all 32 cells (8 dirs × 4 frames)
  for (let dir = 0; dir < DIR_COUNT; dir++) {
    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      const col = dir * FRAME_COUNT + frame;
      const phase = frame / FRAME_COUNT;
      drawFn(ctx, col, row, dir, frame, phase, framePxW, framePxH);
    }
  }

  // Regenerate height atlas from updated color atlas
  cachedHeightAtlas = generateHeightAtlas(atlas);

  console.log('[SpriteAtlas] Injected custom sprite at row %d (%dx%d frames)', row, framePxW, framePxH);
  return { colorCanvas: atlas, heightCanvas: cachedHeightAtlas };
}

/** Get the total atlas row count (always MAX_ROW_COUNT). */
export function getAtlasRowCount(): number {
  return MAX_ROW_COUNT;
}
