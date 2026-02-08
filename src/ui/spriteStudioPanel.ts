/**
 * Sprite Studio — floating panel with atlas grid + GPU-rendered sprite preview.
 * Replaces the old SpriteViewer with real-time PBR preview via SpriteStudioRenderer.
 */
import {
  CELL_W, CELL_H, DIR_COUNT, FRAME_COUNT, COLS, ROW_COUNT, MAX_ROW_COUNT,
  CELL_SPANS, ROW_Y_OFFSETS, ATLAS_PX_W,
  getOrCreateAtlas,
} from '../spriteSheet';
import { SpriteStudioRenderer, RenderSpriteOptions } from '../spriteStudio';

const ROW_LABELS = [
  'Hockey Blue', 'Hockey Red', 'Figure', 'Public',
  'Zamboni', 'Shovel', 'Water Tank', 'Goal',
  'Custom 9', 'Custom 10', 'Custom 11', 'Custom 12',
  'Custom 13', 'Custom 14', 'Custom 15', 'Custom 16',
];

const DIR_LABELS = ['Front', 'FrR', 'Right', 'BkR', 'Back', 'BkL', 'Left', 'FrL'];
const ZOOM = 2;

const PREVIEW_W = 200;
const PREVIEW_H = 300;

export class SpriteStudioPanel {
  readonly el: HTMLDivElement;
  private gridCanvas: HTMLCanvasElement;
  private previewCanvas: HTMLCanvasElement;
  private studioRenderer: SpriteStudioRenderer;

  private selectedRow = 0;
  private selectedDir = 0;
  private selectedFrame = 0;
  private animating = false;
  private animInterval: number | null = null;

  // Sliders state
  private dirSlider!: HTMLInputElement;
  private frameSlider!: HTMLInputElement;
  private sunAzSlider!: HTMLInputElement;
  private sunElSlider!: HTMLInputElement;
  private exposureSlider!: HTMLInputElement;
  private camAzSlider!: HTMLInputElement;
  private camElSlider!: HTMLInputElement;
  private seedSlider!: HTMLInputElement;
  private dirLabel!: HTMLSpanElement;
  private frameLabel!: HTMLSpanElement;

  constructor(studioRenderer: SpriteStudioRenderer) {
    this.studioRenderer = studioRenderer;

    this.el = document.createElement('div');
    this.el.className = 'sprite-studio';
    this.el.style.cssText = `
      display:none; background:#1a1a2e;
      padding:12px; font:11px monospace; color:#c0c0e0;
      width:100%; height:100vh; overflow-y:auto;
      flex-direction:column;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-shrink:0;';
    const title = document.createElement('span');
    title.textContent = 'Sprite Studio';
    title.style.cssText = 'font-weight:bold; font-size:14px;';
    header.append(title);
    this.el.appendChild(header);

    // Atlas grid (compact — shows only 8 built-in rows, variable heights)
    // Grid pixel height = sum of built-in row heights
    const builtInPxH = ROW_Y_OFFSETS[ROW_COUNT]; // pixel Y after last built-in row
    this.gridCanvas = document.createElement('canvas');
    this.gridCanvas.width = ATLAS_PX_W * ZOOM;
    this.gridCanvas.height = builtInPxH * ZOOM;
    this.gridCanvas.style.cssText = `cursor:pointer; border:1px solid #333; display:block; margin-bottom:6px; image-rendering:pixelated; width:${ATLAS_PX_W}px; height:${builtInPxH}px;`;
    this.gridCanvas.addEventListener('click', (e) => this.onGridClick(e));
    this.el.appendChild(this.gridCanvas);

    // Lower section: preview + controls side by side
    const lower = document.createElement('div');
    lower.style.cssText = 'display:flex; gap:8px; align-items:flex-start;';

    // GPU preview canvas
    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = PREVIEW_W;
    this.previewCanvas.height = PREVIEW_H;
    this.previewCanvas.style.cssText = `border:1px solid #555; width:${PREVIEW_W}px; height:${PREVIEW_H}px;`;
    lower.appendChild(this.previewCanvas);

    // Controls column
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; flex-direction:column; gap:3px; min-width:140px;';

    // Sprite type dropdown
    const spriteRow = this.makeRow('Sprite:');
    const spriteSelect = document.createElement('select');
    spriteSelect.style.cssText = 'background:#222; color:#ccc; border:1px solid #555; font:10px monospace; width:90px;';
    for (let i = 0; i < MAX_ROW_COUNT; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = ROW_LABELS[i];
      spriteSelect.appendChild(opt);
    }
    spriteSelect.value = '0';
    spriteSelect.addEventListener('change', () => {
      this.selectedRow = parseInt(spriteSelect.value);
      this.updatePreview();
      this.drawGrid();
    });
    spriteRow.appendChild(spriteSelect);
    controls.appendChild(spriteRow);

    // Direction slider (0-7)
    const [dirRow, dirSlider, dirLabel] = this.makeSlider('Dir:', 0, 7, 0, 1);
    this.dirSlider = dirSlider;
    this.dirLabel = dirLabel;
    dirSlider.addEventListener('input', () => {
      this.selectedDir = parseInt(dirSlider.value);
      dirLabel.textContent = DIR_LABELS[this.selectedDir];
      this.updatePreview();
    });
    dirLabel.textContent = DIR_LABELS[0];
    controls.appendChild(dirRow);

    // Frame slider (0-3)
    const [frameRow, frameSlider, frameLabel] = this.makeSlider('Frame:', 0, 3, 0, 1);
    this.frameSlider = frameSlider;
    this.frameLabel = frameLabel;
    frameSlider.addEventListener('input', () => {
      this.selectedFrame = parseInt(frameSlider.value);
      frameLabel.textContent = String(this.selectedFrame);
      this.updatePreview();
    });
    controls.appendChild(frameRow);

    // Animate button
    const animBtn = document.createElement('button');
    animBtn.textContent = 'Animate';
    animBtn.style.cssText = 'background:#334; color:#aaf; border:1px solid #557; padding:3px 8px; border-radius:3px; cursor:pointer;';
    animBtn.addEventListener('click', () => this.toggleAnimation(animBtn));
    controls.appendChild(animBtn);

    // --- Lighting ---
    const lightLabel = document.createElement('div');
    lightLabel.textContent = '--- Lighting ---';
    lightLabel.style.cssText = 'color:#888; margin-top:4px; text-align:center;';
    controls.appendChild(lightLabel);

    const [sunAzRow, sunAzSlider] = this.makeSlider('Sun Az:', 0, 628, 100, 1);
    this.sunAzSlider = sunAzSlider;
    sunAzSlider.addEventListener('input', () => this.updatePreview());
    controls.appendChild(sunAzRow);

    const [sunElRow, sunElSlider] = this.makeSlider('Sun El:', 0, 157, 70, 1);
    this.sunElSlider = sunElSlider;
    sunElSlider.addEventListener('input', () => this.updatePreview());
    controls.appendChild(sunElRow);

    const [expRow, expSlider] = this.makeSlider('Exposure:', 20, 300, 120, 1);
    this.exposureSlider = expSlider;
    expSlider.addEventListener('input', () => this.updatePreview());
    controls.appendChild(expRow);

    // --- Camera ---
    const camLabel = document.createElement('div');
    camLabel.textContent = '--- Camera ---';
    camLabel.style.cssText = 'color:#888; margin-top:4px; text-align:center;';
    controls.appendChild(camLabel);

    const [camAzRow, camAzSlider] = this.makeSlider('Cam Az:', 0, 628, 60, 1);
    this.camAzSlider = camAzSlider;
    camAzSlider.addEventListener('input', () => this.updatePreview());
    controls.appendChild(camAzRow);

    const [camElRow, camElSlider] = this.makeSlider('Cam El:', 10, 157, 50, 1);
    this.camElSlider = camElSlider;
    camElSlider.addEventListener('input', () => this.updatePreview());
    controls.appendChild(camElRow);

    // --- Tint ---
    const [seedRow, seedSlider] = this.makeSlider('Seed:', 0, 100, 50, 1);
    this.seedSlider = seedSlider;
    seedSlider.addEventListener('input', () => this.updatePreview());
    controls.appendChild(seedRow);

    // --- Export ---
    const exportRow = document.createElement('div');
    exportRow.style.cssText = 'display:flex; gap:4px; margin-top:4px;';
    const pngBtn = document.createElement('button');
    pngBtn.textContent = 'PNG';
    pngBtn.style.cssText = 'background:#334; color:#aaf; border:1px solid #557; padding:2px 6px; border-radius:3px; cursor:pointer; flex:1;';
    pngBtn.addEventListener('click', () => this.exportPNG());
    const atlasBtn = document.createElement('button');
    atlasBtn.textContent = 'Atlas';
    atlasBtn.style.cssText = 'background:#334; color:#aaf; border:1px solid #557; padding:2px 6px; border-radius:3px; cursor:pointer; flex:1;';
    atlasBtn.addEventListener('click', () => this.exportAtlas());
    exportRow.append(pngBtn, atlasBtn);
    controls.appendChild(exportRow);

    lower.appendChild(controls);
    this.el.appendChild(lower);
  }

  private makeRow(label: string): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:4px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'min-width:50px; font-size:10px;';
    row.appendChild(lbl);
    return row;
  }

  private makeSlider(label: string, min: number, max: number, value: number, step: number): [HTMLDivElement, HTMLInputElement, HTMLSpanElement] {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:4px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'min-width:50px; font-size:10px;';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.value = String(value);
    slider.step = String(step);
    slider.style.cssText = 'width:70px;';
    const valLabel = document.createElement('span');
    valLabel.textContent = String(value);
    valLabel.style.cssText = 'min-width:24px; font-size:10px; text-align:right;';
    slider.addEventListener('input', () => { valLabel.textContent = slider.value; });
    row.append(lbl, slider, valLabel);
    return [row, slider, valLabel];
  }

  show() {
    this.el.style.display = 'flex';
    this.drawGrid();
    this.updatePreview();
  }

  hide() {
    this.el.style.display = 'none';
    this.stopAnimation();
  }

  toggle() {
    if (this.el.style.display === 'none') {
      this.show();
    } else {
      this.hide();
    }
  }

  private getPreviewOpts(): RenderSpriteOptions {
    // Map row to spriteType:
    // Row 0 = hockey blue -> type 1, team 0
    // Row 1 = hockey red  -> type 1, team 1
    // Row 2 = figure -> type 2
    // Row 3 = public -> type 3
    // Row 4 = zamboni -> type 4
    // Row 5 = shovel -> type 5
    // Row 6 = water tank -> type 8
    // Row 7 = goal -> type 6
    // Row 8-15 = custom -> type 9-16
    let spriteType: number;
    let team = 0;
    const row = this.selectedRow;
    if (row === 0) { spriteType = 1; team = 0; }
    else if (row === 1) { spriteType = 1; team = 1; }
    else if (row === 2) { spriteType = 2; }
    else if (row === 3) { spriteType = 3; }
    else if (row === 4) { spriteType = 4; }
    else if (row === 5) { spriteType = 5; }
    else if (row === 6) { spriteType = 8; }
    else if (row === 7) { spriteType = 6; }
    else { spriteType = row + 1; } // rows 8-15 -> types 9-16

    // Direction: map 0-7 index to radians
    // dir=0 in sprite system means "facing camera" which is front
    // We map facing index to a direction angle
    const dirRad = this.selectedDir * Math.PI / 4;

    return {
      spriteType,
      team,
      direction: dirRad,
      frame: this.selectedFrame,
      width: PREVIEW_W,
      height: PREVIEW_H,
      sunAzimuth: parseInt(this.sunAzSlider.value) / 100,
      sunElevation: parseInt(this.sunElSlider.value) / 100,
      exposure: parseInt(this.exposureSlider.value) / 100,
      cameraAzimuth: parseInt(this.camAzSlider.value) / 100,
      cameraElevation: parseInt(this.camElSlider.value) / 100,
      seed: parseInt(this.seedSlider.value) / 100,
      background: 'sky',
    };
  }

  private updatePreview() {
    if (this.el.style.display === 'none') return;
    try {
      this.studioRenderer.renderToCanvas(this.previewCanvas, this.getPreviewOpts());
    } catch (e) {
      console.warn('[SpriteStudio] Preview render failed:', e);
    }
  }

  private drawGrid() {
    const atlas = getOrCreateAtlas();
    const ctx = this.gridCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const builtInPxH = ROW_Y_OFFSETS[ROW_COUNT];
    ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
    // Draw only built-in rows (0-7) — custom rows are blank until injected
    ctx.drawImage(atlas, 0, 0, ATLAS_PX_W, builtInPxH,
      0, 0, this.gridCanvas.width, this.gridCanvas.height);

    const colSlotW = ATLAS_PX_W / COLS; // column slot width in atlas pixels

    // Grid lines (per column slot)
    ctx.strokeStyle = 'rgba(100, 100, 150, 0.3)';
    ctx.lineWidth = 1;
    for (let col = 0; col <= COLS; col++) {
      const x = col * colSlotW * ZOOM;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.gridCanvas.height); ctx.stroke();
    }
    // Row separators (variable heights)
    for (let row = 0; row <= ROW_COUNT; row++) {
      const y = ROW_Y_OFFSETS[row] * ZOOM;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.gridCanvas.width, y); ctx.stroke();
    }

    // Direction group separators
    ctx.strokeStyle = 'rgba(150, 150, 200, 0.5)';
    ctx.lineWidth = 2;
    for (let dir = 0; dir <= DIR_COUNT; dir++) {
      const x = dir * FRAME_COUNT * colSlotW * ZOOM;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.gridCanvas.height); ctx.stroke();
    }

    // Row labels
    ctx.font = `${10 * ZOOM}px monospace`;
    ctx.textBaseline = 'middle';
    for (let row = 0; row < ROW_COUNT; row++) {
      const rowY = ROW_Y_OFFSETS[row] * ZOOM;
      const rowH = CELL_SPANS[row].h * CELL_H * ZOOM;
      const midY = rowY + rowH / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, rowY, 70 * ZOOM, rowH);
      ctx.fillStyle = '#dde';
      ctx.fillText(ROW_LABELS[row], 3 * ZOOM, midY);
    }

    // Direction labels
    ctx.font = `${8 * ZOOM}px monospace`;
    ctx.textAlign = 'center';
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      const x = (dir * FRAME_COUNT + FRAME_COUNT / 2) * colSlotW * ZOOM;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(dir * FRAME_COUNT * colSlotW * ZOOM, 0, FRAME_COUNT * colSlotW * ZOOM, 12 * ZOOM);
      ctx.fillStyle = '#aab';
      ctx.fillText(DIR_LABELS[dir], x, 7 * ZOOM);
    }
    ctx.textAlign = 'start';

    // Selection highlight
    if (this.selectedRow < ROW_COUNT) {
      const selCol = this.selectedDir * FRAME_COUNT + this.selectedFrame;
      const sx = selCol * colSlotW * ZOOM;
      const sy = ROW_Y_OFFSETS[this.selectedRow] * ZOOM;
      const sw = CELL_SPANS[this.selectedRow].w * CELL_W * ZOOM;
      const sh = CELL_SPANS[this.selectedRow].h * CELL_H * ZOOM;
      ctx.strokeStyle = '#ff0';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
    }
  }

  private onGridClick(e: MouseEvent) {
    const rect = this.gridCanvas.getBoundingClientRect();
    const scaleX = this.gridCanvas.width / rect.width;
    const scaleY = this.gridCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const colSlotW = ATLAS_PX_W / COLS;
    const col = Math.max(0, Math.min(COLS - 1, Math.floor(px / (colSlotW * ZOOM))));
    // Find row from variable-height layout
    let row = 0;
    const pyAtlas = py / ZOOM; // convert to atlas pixel coords
    for (let r = ROW_COUNT - 1; r >= 0; r--) {
      if (pyAtlas >= ROW_Y_OFFSETS[r]) { row = r; break; }
    }

    this.selectedRow = row;
    this.selectedDir = Math.floor(col / FRAME_COUNT);
    this.selectedFrame = col % FRAME_COUNT;

    // Update sliders to match
    this.dirSlider.value = String(this.selectedDir);
    this.dirLabel.textContent = DIR_LABELS[this.selectedDir];
    this.frameSlider.value = String(this.selectedFrame);
    this.frameLabel.textContent = String(this.selectedFrame);

    this.drawGrid();
    this.updatePreview();
  }

  private toggleAnimation(btn: HTMLButtonElement) {
    if (this.animating) {
      this.stopAnimation();
      btn.textContent = 'Animate';
      btn.style.color = '#aaf';
    } else {
      this.animating = true;
      btn.textContent = 'Stop';
      btn.style.color = '#faa';
      this.animInterval = window.setInterval(() => {
        this.selectedFrame = (this.selectedFrame + 1) % FRAME_COUNT;
        this.frameSlider.value = String(this.selectedFrame);
        this.frameLabel.textContent = String(this.selectedFrame);
        this.updatePreview();
        this.drawGrid();
      }, 167); // ~6 fps
    }
  }

  private stopAnimation() {
    this.animating = false;
    if (this.animInterval !== null) {
      clearInterval(this.animInterval);
      this.animInterval = null;
    }
  }

  private async exportPNG() {
    try {
      const url = await this.studioRenderer.renderSprite(this.getPreviewOpts());
      const a = document.createElement('a');
      a.href = url;
      a.download = `sprite_${ROW_LABELS[this.selectedRow]}_dir${this.selectedDir}_f${this.selectedFrame}.png`;
      a.click();
    } catch (e) {
      console.error('[SpriteStudio] Export failed:', e);
    }
  }

  private exportAtlas() {
    const atlas = getOrCreateAtlas();
    atlas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sprite_atlas.png';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}
