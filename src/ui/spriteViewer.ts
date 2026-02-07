/**
 * Interactive sprite atlas viewer — floating panel with grid, labels, zoom, animation.
 */
import {
  CELL_W, CELL_H, DIR_COUNT, FRAME_COUNT, COLS, ROW_COUNT,
  ROW_HOCKEY_BLUE, ROW_HOCKEY_RED, ROW_FIGURE, ROW_PUBLIC,
  ROW_ZAMBONI, ROW_SHOVEL, ROW_WATER_TANK, ROW_GOAL,
} from '../spriteSheet';

const ROW_LABELS = [
  'Hockey Blue', 'Hockey Red', 'Figure', 'Public',
  'Zamboni', 'Shovel', 'Water Tank', 'Goal',
];

const DIR_LABELS = ['Front', 'FrR', 'Right', 'BkR', 'Back', 'BkL', 'Left', 'FrL'];

const ZOOM = 2; // grid display scale
const DETAIL_ZOOM = 8; // zoomed detail scale

export class SpriteViewer {
  readonly el: HTMLDivElement;
  private gridCanvas: HTMLCanvasElement;
  private detailCanvas: HTMLCanvasElement;
  private atlasGetter: () => HTMLCanvasElement;
  private selectedCol = 0;
  private selectedRow = 0;
  private animating = false;
  private animFrame = 0;
  private animInterval: number | null = null;
  private tintColor = '#4488cc';

  constructor(atlasGetter: () => HTMLCanvasElement) {
    this.atlasGetter = atlasGetter;

    this.el = document.createElement('div');
    this.el.className = 'sprite-viewer';
    this.el.style.cssText = `
      display:none; position:fixed; top:40px; right:180px; z-index:10000;
      background:#1a1a2e; border:1px solid #4a4a6a; border-radius:6px;
      padding:8px; font:11px monospace; color:#c0c0e0;
      max-height:90vh; overflow-y:auto; box-shadow:0 4px 20px rgba(0,0,0,0.6);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;';
    const title = document.createElement('span');
    title.textContent = 'Sprite Atlas';
    title.style.fontWeight = 'bold';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    closeBtn.style.cssText = 'background:#444; color:#ccc; border:none; padding:2px 6px; border-radius:3px; cursor:pointer;';
    closeBtn.addEventListener('click', () => this.hide());
    header.append(title, closeBtn);
    this.el.appendChild(header);

    // Grid canvas (shows full atlas with overlay)
    this.gridCanvas = document.createElement('canvas');
    this.gridCanvas.width = COLS * CELL_W * ZOOM;
    this.gridCanvas.height = ROW_COUNT * CELL_H * ZOOM;
    this.gridCanvas.style.cssText = `cursor:pointer; border:1px solid #333; display:block; margin-bottom:6px; image-rendering:pixelated; width:${COLS * CELL_W}px; height:${ROW_COUNT * CELL_H}px;`;
    this.gridCanvas.addEventListener('click', (e) => this.onGridClick(e));
    this.el.appendChild(this.gridCanvas);

    // Info row
    const infoRow = document.createElement('div');
    infoRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:6px; flex-wrap:wrap;';

    // Detail canvas
    this.detailCanvas = document.createElement('canvas');
    this.detailCanvas.width = CELL_W * DETAIL_ZOOM;
    this.detailCanvas.height = CELL_H * DETAIL_ZOOM;
    this.detailCanvas.style.cssText = `border:1px solid #555; image-rendering:pixelated; width:${CELL_W * 4}px; height:${CELL_H * 4}px;`;
    infoRow.appendChild(this.detailCanvas);

    // Controls column
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; flex-direction:column; gap:4px;';

    // Animate button
    const animBtn = document.createElement('button');
    animBtn.textContent = 'Animate';
    animBtn.style.cssText = 'background:#334; color:#aaf; border:1px solid #557; padding:3px 8px; border-radius:3px; cursor:pointer;';
    animBtn.addEventListener('click', () => this.toggleAnimation(animBtn));
    controls.appendChild(animBtn);

    // Tint color
    const tintRow = document.createElement('div');
    tintRow.style.cssText = 'display:flex; align-items:center; gap:4px;';
    const tintLabel = document.createElement('span');
    tintLabel.textContent = 'Tint:';
    const tintInput = document.createElement('input');
    tintInput.type = 'color';
    tintInput.value = this.tintColor;
    tintInput.style.cssText = 'width:24px; height:20px; padding:0; border:1px solid #557;';
    tintInput.addEventListener('input', () => { this.tintColor = tintInput.value; this.drawDetail(); });
    tintRow.append(tintLabel, tintInput);
    controls.appendChild(tintRow);

    // Export buttons
    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export Atlas PNG';
    exportBtn.style.cssText = 'background:#334; color:#aaf; border:1px solid #557; padding:3px 8px; border-radius:3px; cursor:pointer;';
    exportBtn.addEventListener('click', () => this.exportAtlas());
    controls.appendChild(exportBtn);

    const exportCellBtn = document.createElement('button');
    exportCellBtn.textContent = 'Export Cell PNG';
    exportCellBtn.style.cssText = 'background:#334; color:#aaf; border:1px solid #557; padding:3px 8px; border-radius:3px; cursor:pointer;';
    exportCellBtn.addEventListener('click', () => this.exportCell());
    controls.appendChild(exportCellBtn);

    infoRow.appendChild(controls);
    this.el.appendChild(infoRow);
  }

  show() {
    this.el.style.display = '';
    this.drawGrid();
    this.drawDetail();
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

  private drawGrid() {
    const atlas = this.atlasGetter();
    const ctx = this.gridCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    // Draw atlas scaled up
    ctx.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
    ctx.drawImage(atlas, 0, 0, this.gridCanvas.width, this.gridCanvas.height);

    // Draw grid lines
    ctx.strokeStyle = 'rgba(100, 100, 150, 0.3)';
    ctx.lineWidth = 1;
    for (let col = 0; col <= COLS; col++) {
      const x = col * CELL_W * ZOOM;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.gridCanvas.height);
      ctx.stroke();
    }
    for (let row = 0; row <= ROW_COUNT; row++) {
      const y = row * CELL_H * ZOOM;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.gridCanvas.width, y);
      ctx.stroke();
    }

    // Direction group separators (thicker lines every 4 columns)
    ctx.strokeStyle = 'rgba(150, 150, 200, 0.5)';
    ctx.lineWidth = 2;
    for (let dir = 0; dir <= DIR_COUNT; dir++) {
      const x = dir * FRAME_COUNT * CELL_W * ZOOM;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.gridCanvas.height);
      ctx.stroke();
    }

    // Row labels (left side)
    ctx.font = `${10 * ZOOM}px monospace`;
    ctx.textBaseline = 'middle';
    for (let row = 0; row < ROW_COUNT; row++) {
      const y = (row + 0.5) * CELL_H * ZOOM;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, row * CELL_H * ZOOM, 70 * ZOOM, CELL_H * ZOOM);
      ctx.fillStyle = '#dde';
      ctx.fillText(ROW_LABELS[row], 3 * ZOOM, y);
    }

    // Direction labels (top)
    ctx.font = `${8 * ZOOM}px monospace`;
    ctx.textAlign = 'center';
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      const x = (dir * FRAME_COUNT + FRAME_COUNT / 2) * CELL_W * ZOOM;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(dir * FRAME_COUNT * CELL_W * ZOOM, 0, FRAME_COUNT * CELL_W * ZOOM, 12 * ZOOM);
      ctx.fillStyle = '#aab';
      ctx.fillText(DIR_LABELS[dir], x, 7 * ZOOM);
    }
    ctx.textAlign = 'start';

    // Selection highlight
    const sx = this.selectedCol * CELL_W * ZOOM;
    const sy = this.selectedRow * CELL_H * ZOOM;
    ctx.strokeStyle = '#ff0';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 1, sy + 1, CELL_W * ZOOM - 2, CELL_H * ZOOM - 2);
  }

  private drawDetail() {
    const atlas = this.atlasGetter();
    const ctx = this.detailCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const col = this.animating ? this.animCol() : this.selectedCol;

    // Clear with checkerboard (transparency indicator)
    for (let y = 0; y < this.detailCanvas.height; y += 8) {
      for (let x = 0; x < this.detailCanvas.width; x += 8) {
        ctx.fillStyle = ((x / 8 + y / 8) % 2 === 0) ? '#2a2a3a' : '#22222e';
        ctx.fillRect(x, y, 8, 8);
      }
    }

    // Draw the selected cell zoomed
    const sx = col * CELL_W;
    const sy = this.selectedRow * CELL_H;
    ctx.drawImage(atlas, sx, sy, CELL_W, CELL_H, 0, 0, this.detailCanvas.width, this.detailCanvas.height);

    // Apply tint preview for figure/public rows
    if (this.selectedRow === ROW_FIGURE || this.selectedRow === ROW_PUBLIC) {
      const imgData = ctx.getImageData(0, 0, this.detailCanvas.width, this.detailCanvas.height);
      const tint = this.hexToRgb(this.tintColor);
      for (let i = 0; i < imgData.data.length; i += 4) {
        const r = imgData.data[i], g = imgData.data[i + 1], b = imgData.data[i + 2], a = imgData.data[i + 3];
        if (a > 128) {
          const brightness = Math.max(r, g, b);
          if (brightness > 190) {
            imgData.data[i] = Math.round(r * tint[0] / 255);
            imgData.data[i + 1] = Math.round(g * tint[1] / 255);
            imgData.data[i + 2] = Math.round(b * tint[2] / 255);
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
  }

  private animCol(): number {
    const dir = Math.floor(this.selectedCol / FRAME_COUNT);
    return dir * FRAME_COUNT + (this.animFrame % FRAME_COUNT);
  }

  private onGridClick(e: MouseEvent) {
    const rect = this.gridCanvas.getBoundingClientRect();
    const scaleX = this.gridCanvas.width / rect.width;
    const scaleY = this.gridCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    this.selectedCol = Math.floor(px / (CELL_W * ZOOM));
    this.selectedRow = Math.floor(py / (CELL_H * ZOOM));
    this.selectedCol = Math.max(0, Math.min(COLS - 1, this.selectedCol));
    this.selectedRow = Math.max(0, Math.min(ROW_COUNT - 1, this.selectedRow));
    this.drawGrid();
    this.drawDetail();
  }

  private toggleAnimation(btn: HTMLButtonElement) {
    if (this.animating) {
      this.stopAnimation();
      btn.textContent = 'Animate';
      btn.style.color = '#aaf';
    } else {
      this.animating = true;
      this.animFrame = 0;
      btn.textContent = 'Stop';
      btn.style.color = '#faa';
      this.animInterval = window.setInterval(() => {
        this.animFrame++;
        this.drawDetail();
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

  private exportAtlas() {
    const atlas = this.atlasGetter();
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

  private exportCell() {
    const atlas = this.atlasGetter();
    const c = document.createElement('canvas');
    c.width = CELL_W;
    c.height = CELL_H;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(atlas, this.selectedCol * CELL_W, this.selectedRow * CELL_H, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sprite_${ROW_LABELS[this.selectedRow]}_dir${Math.floor(this.selectedCol / FRAME_COUNT)}_f${this.selectedCol % FRAME_COUNT}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  private hexToRgb(hex: string): [number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  }
}
