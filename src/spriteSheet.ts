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
export const ROW_COUNT = 8;

// Row indices
export const ROW_HOCKEY_BLUE = 0;
export const ROW_HOCKEY_RED = 1;
export const ROW_FIGURE = 2;
export const ROW_PUBLIC = 3;
export const ROW_ZAMBONI = 4;
export const ROW_SHOVEL = 5;
export const ROW_WATER_TANK = 6;
export const ROW_GOAL = 7;

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
  canvas.width = COLS * CELL_W;
  canvas.height = ROW_COUNT * CELL_H;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  console.log('[SpriteAtlas] Generating %dx%d atlas (%d rows × %d cols)',
    canvas.width, canvas.height, ROW_COUNT, COLS);

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
      drawGoal(ctx, col, ROW_GOAL);
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

function cellX(col: number): number { return col * CELL_W; }
function cellY(row: number): number { return row * CELL_H; }

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
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + CELL_W / 2;

  // 3/4 orthographic zamboni — direction determines which faces are visible
  // Dir 0=toward viewer (front/blade visible), 4=away (cab/rear visible)
  // The zamboni body is: front=blade/conditioner, middle=tank, rear=cab

  // Foreshortening: front/back views are wider, side views are narrower/longer
  const bodyW = dir === 2 || dir === 6 ? 24 : dir === 0 || dir === 4 ? 20 : 22;
  const bodyH = 18;
  const bodyTop = oy + 16;

  // Shadow/ground contact
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath();
  ctx.ellipse(cx, oy + 44, bodyW * 0.55, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // === BODY (main tank/hopper) ===
  // Side panels (3D depth illusion)
  if (dir === 2 || dir === 1 || dir === 3) {
    // Right side visible — darker shade
    ctx.fillStyle = '#a0a0a8';
    ctx.fillRect(cx, bodyTop + 2, bodyW / 2, bodyH);
  }
  if (dir === 6 || dir === 5 || dir === 7) {
    // Left side visible — darker shade
    ctx.fillStyle = '#a0a0a8';
    ctx.fillRect(cx - bodyW / 2, bodyTop + 2, bodyW / 2, bodyH);
  }
  // Top surface
  ctx.fillStyle = '#ccccd4';
  ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);

  // Snow/ice hopper on top (center)
  ctx.fillStyle = '#b8b8c0';
  ctx.fillRect(cx - bodyW * 0.3, bodyTop - 3, bodyW * 0.6, 5);
  // Ice chips in hopper
  ctx.fillStyle = '#e8e8f0';
  ctx.fillRect(cx - bodyW * 0.25, bodyTop - 2, bodyW * 0.5, 3);

  // === CAB (rear of zamboni, top when facing away) ===
  const cabH = 12;
  const cabW = bodyW * 0.55;
  // Cab position depends on direction — it's at the REAR of the vehicle
  let cabX = cx, cabY = bodyTop;
  if (dir === 0) { cabY = bodyTop - 2; } // facing us: cab behind, partially hidden, shows above body
  else if (dir === 4) { cabY = bodyTop - cabH + 2; } // facing away: cab prominent at top
  else if (dir === 2) { cabX = cx - bodyW * 0.15; cabY = bodyTop - cabH + 4; }
  else if (dir === 6) { cabX = cx + bodyW * 0.15; cabY = bodyTop - cabH + 4; }
  else if (dir === 1 || dir === 7) { cabY = bodyTop - cabH + 5; }
  else { cabY = bodyTop - cabH + 3; } // dir 3,5 — cab at top

  // Cab body
  ctx.fillStyle = '#dddde4';
  ctx.fillRect(cabX - cabW / 2, cabY, cabW, cabH);
  // Cab roof edge
  ctx.fillStyle = '#c0c0c8';
  ctx.fillRect(cabX - cabW / 2, cabY, cabW, 2);

  // Windshield
  if (dir === 0 || dir === 1 || dir === 7) {
    // Facing us — windshield visible on cab
    ctx.fillStyle = '#4a6888';
    ctx.fillRect(cabX - cabW * 0.35, cabY + 3, cabW * 0.7, cabH * 0.55);
    // Glare highlight
    ctx.fillStyle = 'rgba(140,180,220,0.4)';
    ctx.fillRect(cabX - cabW * 0.25, cabY + 4, cabW * 0.25, cabH * 0.3);
  } else if (dir === 4 || dir === 3 || dir === 5) {
    // Facing away — rear of cab (no windshield, just panel + brake light)
    ctx.fillStyle = '#b0b0b8';
    ctx.fillRect(cabX - cabW / 2 + 1, cabY + 2, cabW - 2, cabH - 3);
    // Brake lights
    ctx.fillStyle = '#cc2020';
    ctx.fillRect(cabX - cabW / 2 + 2, cabY + cabH - 4, 3, 2);
    ctx.fillRect(cabX + cabW / 2 - 5, cabY + cabH - 4, 3, 2);
  } else {
    // Side — window
    ctx.fillStyle = '#4a6888';
    const winX = dir === 2 ? cabX - cabW * 0.3 : cabX - cabW * 0.1;
    ctx.fillRect(winX, cabY + 3, cabW * 0.45, cabH * 0.5);
  }

  // === WARNING LIGHTS on cab roof ===
  ctx.fillStyle = '#ff8800';
  ctx.fillRect(cabX - 2, cabY - 2, 4, 3);

  // === BLADE/CONDITIONER (front of zamboni) ===
  const bladeY = bodyTop + bodyH;
  if (dir === 0 || dir === 1 || dir === 7) {
    // Facing us — blade/conditioner visible at bottom
    ctx.fillStyle = '#707880';
    ctx.fillRect(cx - bodyW * 0.45, bladeY, bodyW * 0.9, 3);
    // Water towel (wet strip)
    ctx.fillStyle = '#5588aa';
    ctx.fillRect(cx - bodyW * 0.4, bladeY + 3, bodyW * 0.8, 2);
  } else if (dir === 4 || dir === 3 || dir === 5) {
    // Facing away — blade not visible (it's at the front, hidden)
  } else {
    // Side view — blade as thin line at front end
    const bladeX = dir === 2 ? cx + bodyW / 2 - 2 : cx - bodyW / 2;
    ctx.fillStyle = '#707880';
    ctx.fillRect(bladeX, bladeY - 2, 3, 5);
  }

  // === WHEELS (4 wheels, visible depending on direction) ===
  const wheelY = bodyTop + bodyH - 2;
  ctx.fillStyle = '#1a1a20';
  if (dir === 0 || dir === 4) {
    // Front/back: see both sides of wheels as pairs
    ctx.fillRect(cx - bodyW / 2 - 1, wheelY + 2, 4, 6);
    ctx.fillRect(cx + bodyW / 2 - 3, wheelY + 2, 4, 6);
    ctx.fillRect(cx - bodyW / 2 - 1, wheelY + 10, 4, 6);
    ctx.fillRect(cx + bodyW / 2 - 3, wheelY + 10, 4, 6);
  } else if (dir === 2 || dir === 6) {
    // Side: see two wheels along the length
    ctx.fillRect(cx - bodyW * 0.32, wheelY + 4, 5, 6);
    ctx.fillRect(cx + bodyW * 0.2, wheelY + 4, 5, 6);
    // Tire detail
    ctx.fillStyle = '#2a2a30';
    ctx.fillRect(cx - bodyW * 0.31, wheelY + 5, 3, 4);
    ctx.fillRect(cx + bodyW * 0.21, wheelY + 5, 3, 4);
  } else {
    // Diagonal: 3 wheels visible
    const sign = (dir === 1 || dir === 3) ? 1 : -1;
    ctx.fillRect(cx + sign * bodyW * 0.35, wheelY + 3, 4, 6);
    ctx.fillRect(cx - sign * bodyW * 0.1, wheelY + 5, 4, 5);
    ctx.fillRect(cx + sign * bodyW * 0.1, wheelY + 10, 4, 5);
  }

  // === HAZARD STRIPES on body sides ===
  ctx.fillStyle = '#e09000';
  if (dir === 2 || dir === 1 || dir === 3) {
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(cx + bodyW / 2 - 3, bodyTop + 4 + i * 6, 2, 4);
    }
  }
  if (dir === 6 || dir === 5 || dir === 7) {
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(cx - bodyW / 2 + 1, bodyTop + 4 + i * 6, 2, 4);
    }
  }

  // === LOGO / BRAND on top ===
  ctx.fillStyle = '#3060a0';
  ctx.fillRect(cx - 3, bodyTop + 2, 6, 3);
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

  // Shovel handle + blade
  if (!isBack(dir)) {
    const sx = mirror ? cx - 10 : cx + 10;
    ctx.strokeStyle = '#7a6a40';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, oy + 14);
    ctx.lineTo(sx + (mirror ? 2 : -2), oy + 42);
    ctx.stroke();
    // Blade
    ctx.fillStyle = '#707880';
    ctx.fillRect(sx - 4, oy + 42, 8, 4);
  }
}

function drawWaterTank(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
  dir: Dir,
) {
  const ox = cellX(col);
  const oy = cellY(row);
  const cx = ox + CELL_W / 2;

  // 3/4 orthographic water tank — old-school gravity-fed resurfacer
  const tankW = dir === 2 || dir === 6 ? 22 : dir === 0 || dir === 4 ? 18 : 20;
  const tankH = 16;
  const tankTop = oy + 14;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  ctx.ellipse(cx, oy + 42, tankW * 0.5, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Side panel (depth)
  if (dir === 2 || dir === 1 || dir === 3) {
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(cx, tankTop + 2, tankW / 2, tankH);
  }
  if (dir === 6 || dir === 5 || dir === 7) {
    ctx.fillStyle = '#5a3520';
    ctx.fillRect(cx - tankW / 2, tankTop + 2, tankW / 2, tankH);
  }

  // Main tank body (rusty metal)
  ctx.fillStyle = '#7a5030';
  ctx.fillRect(cx - tankW / 2, tankTop, tankW, tankH);

  // Rivet bands
  ctx.fillStyle = '#5a3820';
  ctx.fillRect(cx - tankW / 2, tankTop + 4, tankW, 1.5);
  ctx.fillRect(cx - tankW / 2, tankTop + 10, tankW, 1.5);

  // Rust patches
  ctx.fillStyle = '#8a4828';
  ctx.fillRect(cx - tankW * 0.2, tankTop + 2, 4, 3);
  ctx.fillRect(cx + tankW * 0.1, tankTop + 7, 3, 4);

  // Fill cap on top
  ctx.fillStyle = '#505058';
  ctx.fillRect(cx - 3, tankTop - 4, 6, 5);
  ctx.fillStyle = '#606870';
  ctx.fillRect(cx - 2, tankTop - 3, 4, 3);

  // Handle/push bar
  ctx.fillStyle = '#404048';
  if (dir === 0 || dir === 1 || dir === 7) {
    // Push bar visible at rear (top of sprite)
    ctx.fillRect(cx - tankW * 0.35, tankTop - 8, 2, 6);
    ctx.fillRect(cx + tankW * 0.35 - 2, tankTop - 8, 2, 6);
    ctx.fillRect(cx - tankW * 0.35, tankTop - 8, tankW * 0.7, 2);
  } else if (dir === 4 || dir === 3 || dir === 5) {
    // Rear visible at bottom — no push bar shown (it's behind)
  } else {
    // Side: push bar as single vertical bar
    const barX = dir === 2 ? cx - tankW / 2 - 2 : cx + tankW / 2;
    ctx.fillRect(barX, tankTop - 6, 2, 8);
  }

  // Wheels
  const wheelY = tankTop + tankH;
  ctx.fillStyle = '#1a1a20';
  if (dir === 0 || dir === 4) {
    ctx.fillRect(cx - tankW / 2 - 1, wheelY, 4, 5);
    ctx.fillRect(cx + tankW / 2 - 3, wheelY, 4, 5);
  } else if (dir === 2 || dir === 6) {
    ctx.fillRect(cx - tankW * 0.3, wheelY + 1, 5, 5);
    ctx.fillRect(cx + tankW * 0.15, wheelY + 1, 5, 5);
  } else {
    const sign = (dir === 1 || dir === 3) ? 1 : -1;
    ctx.fillRect(cx + sign * tankW * 0.3, wheelY, 4, 5);
    ctx.fillRect(cx - sign * tankW * 0.15, wheelY + 1, 4, 4);
  }

  // Drip nozzles (3 nozzles at bottom-front)
  if (dir === 0 || dir === 1 || dir === 7) {
    ctx.fillStyle = '#606068';
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(cx - 6 + i * 5, wheelY + 5, 3, 3);
    }
    // Water drip
    ctx.fillStyle = 'rgba(100,160,220,0.5)';
    ctx.fillRect(cx - 5, wheelY + 7, 10, 2);
  }
}

function drawGoal(
  ctx: CanvasRenderingContext2D,
  col: number, row: number,
) {
  const ox = cellX(col);
  const oy = cellY(row);

  // Frame (red)
  ctx.fillStyle = '#dd2020';
  ctx.fillRect(ox + 2, oy + 4, 3, 40); // left post
  ctx.fillRect(ox + 27, oy + 4, 3, 40); // right post
  ctx.fillRect(ox + 2, oy + 4, 28, 3); // crossbar

  // Net (white checkerboard)
  for (let ny = 0; ny < 9; ny++) {
    for (let nx = 0; nx < 5; nx++) {
      if ((nx + ny) % 2 === 0) {
        ctx.fillStyle = 'rgba(230,230,240,0.7)';
      } else {
        ctx.fillStyle = 'rgba(230,230,240,0.0)';
      }
      ctx.fillRect(ox + 5 + nx * 4.4, oy + 7 + ny * 4, 4.4, 4);
    }
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
 * Generate a height map atlas matching the color atlas layout.
 * Height is encoded in the R channel (0-255 → normalized in shader).
 *
 * Height profiles per sprite type:
 * - Skaters (rows 0-3, 5): head high, body medium, legs low, feet ground
 * - Vehicles (rows 4, 6): cab high, body medium, wheels low
 * - Goals (row 7): frame high, net medium
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

  for (let row = 0; row < ROW_COUNT; row++) {
    for (let col = 0; col < COLS; col++) {
      const cellOx = col * CELL_W;
      const cellOy = row * CELL_H;

      for (let py = 0; py < CELL_H; py++) {
        for (let px = 0; px < CELL_W; px++) {
          const gx = cellOx + px;
          const gy = cellOy + py;
          const ci = (gy * colorAtlas.width + gx) * 4;

          // Only generate height for opaque pixels
          const alpha = colorData.data[ci + 3];
          if (alpha < 128) continue;

          // Local UV within cell (0-1)
          const lu = px / CELL_W;
          const lv = 1.0 - py / CELL_H; // flip: y=0 at bottom (feet)

          // Center distance for roundness (0 = center, 1 = edge)
          const centerDist = Math.abs(lu - 0.5) * 2.0;

          let height = 0;

          if (row <= 3 || row === ROW_SHOVEL) {
            // Skater/person height profile
            height = computeSkaterHeight(lv, centerDist);
          } else if (row === ROW_ZAMBONI) {
            height = computeVehicleHeight(lv, centerDist, 180);
          } else if (row === ROW_WATER_TANK) {
            height = computeVehicleHeight(lv, centerDist, 140);
          } else if (row === ROW_GOAL) {
            height = computeGoalHeight(lu, lv, colorData.data[ci], colorData.data[ci + 1], colorData.data[ci + 2]);
          }

          // Clamp and write to R channel
          const h = Math.max(0, Math.min(255, Math.round(height)));
          const hi = (gy * canvas.width + gx) * 4;
          heightData.data[hi + 0] = h;
          heightData.data[hi + 1] = h;
          heightData.data[hi + 2] = h;
          heightData.data[hi + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(heightData, 0, 0);
  console.log('[SpriteAtlas] Height atlas generated (%dx%d)', canvas.width, canvas.height);
  return canvas;
}

function computeSkaterHeight(v: number, centerDist: number): number {
  // v: 0 = feet, 1 = top of head
  // Profile: skates→legs→pants→torso→head
  let baseH: number;
  if (v > 0.85) {
    // Head (top portion) — dome shape
    const headV = (v - 0.85) / 0.15;
    baseH = 35 + 13 * Math.sqrt(1.0 - headV * headV);
  } else if (v > 0.75) {
    // Neck/upper torso
    baseH = 32 + 3 * (v - 0.75) / 0.10;
  } else if (v > 0.42) {
    // Torso (widest part)
    baseH = 20 + 12 * (v - 0.42) / 0.33;
  } else if (v > 0.20) {
    // Pants/hips
    baseH = 10 + 10 * (v - 0.20) / 0.22;
  } else if (v > 0.06) {
    // Legs
    baseH = 3 + 7 * (v - 0.06) / 0.14;
  } else {
    // Skates (ground level)
    baseH = 1 + 2 * v / 0.06;
  }

  // Apply roundness (elliptical cross-section)
  const roundness = Math.sqrt(Math.max(0, 1.0 - centerDist * centerDist));
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
