import { computeLayerLayout, LayerLayout } from '../crossSection';
import { RinkConfig } from '../rink';

const RETURN_DELTA = 3.0; // must match simulation.ts

export class CrossSectionUI {
  private labels: Record<string, HTMLSpanElement> = {};
  private config: RinkConfig;

  constructor(container: HTMLElement, config: RinkConfig) {
    this.config = config;
    const names = ['air', 'snow', 'water', 'ice-top', 'marking', 'ice-base', 'pipes', 'concrete'];
    for (const name of names) {
      const el = document.createElement('span');
      el.className = 'cs-lbl';
      container.appendChild(el);
      this.labels[name] = el;
    }
  }

  updateConfig(config: RinkConfig) {
    this.config = config;
  }

  update(
    iceMm: number, waterMm: number, shavingsMm: number,
    ambientTemp: number, pipeTemp: number,
    cellTemp?: number, pipeFlowPos?: number, markingType?: number,
  ): { layout: LayerLayout; hasMarking: boolean } {
    const isOutdoor = !this.config.isIndoor;
    const hasMarking = markingType !== undefined && markingType > 0.5 && iceMm > 3;
    const layout = computeLayerLayout(iceMm, waterMm, shavingsMm, hasMarking, isOutdoor, cellTemp ?? 15);

    const surface = 0.42;
    const uvToTop = (uv: number) => `${(1 - uv) * 100}%`;
    const fmt = (v: number) => v.toFixed(1) + '\u00B0';
    const fmm = (v: number) => v < 1 ? v.toFixed(1) + 'mm' : Math.round(v) + 'mm';

    // Air
    this.labels['air'].textContent = `AIR ${fmt(ambientTemp)}`;
    this.labels['air'].style.top = uvToTop(Math.min((layout.snowTop + 0.96) / 2, 0.94));

    // Snow/shavings
    const hasSnow = layout.snowTop > layout.waterTop + 0.001;
    const snowLabel = isOutdoor ? 'SNOW' : 'SHAVINGS';
    this.labels['snow'].textContent = `${snowLabel} ${fmm(shavingsMm)}`;
    this.labels['snow'].style.top = uvToTop((layout.waterTop + layout.snowTop) / 2);
    this.labels['snow'].style.display = hasSnow ? '' : 'none';

    // Water
    const hasWater = layout.waterTop > layout.iceTop + 0.001;
    const tStr = cellTemp !== undefined ? ' ' + fmt(cellTemp) : '';
    this.labels['water'].textContent = `WATER ${fmm(waterMm)}${tStr}`;
    this.labels['water'].style.top = uvToTop((layout.iceTop + layout.waterTop) / 2);
    this.labels['water'].style.display = hasWater ? '' : 'none';

    // Ice top
    const hasIceTop = layout.iceTop > layout.paintTop + 0.001;
    const iceTopMm = hasMarking ? Math.max(iceMm - 6, 0) : iceMm;
    this.labels['ice-top'].textContent = `ICE ${fmm(iceTopMm)}${tStr}`;
    this.labels['ice-top'].style.top = uvToTop((layout.paintTop + layout.iceTop) / 2);
    this.labels['ice-top'].style.display = hasIceTop ? '' : 'none';

    // Marking
    const hasPaint = layout.paintTop > layout.paintBot + 0.001;
    this.labels['marking'].textContent = 'PAINT';
    this.labels['marking'].style.top = uvToTop((layout.paintBot + layout.paintTop) / 2);
    this.labels['marking'].style.display = (hasMarking && hasPaint) ? '' : 'none';

    // Ice base
    const hasIceBase = layout.paintBot > surface + 0.001;
    const iceBaseMm = hasMarking ? Math.min(iceMm, 6) : 0;
    this.labels['ice-base'].textContent = `ICE ${fmm(iceBaseMm)}`;
    this.labels['ice-base'].style.top = uvToTop((surface + layout.paintBot) / 2);
    this.labels['ice-base'].style.display = (hasMarking && hasIceBase) ? '' : 'none';

    // Pipes
    if (this.config.hasPipes && pipeFlowPos !== undefined && pipeFlowPos > 0) {
      const localPipeT = pipeTemp + pipeFlowPos * RETURN_DELTA;
      this.labels['pipes'].textContent = `PIPES ${fmt(localPipeT)}`;
    } else {
      this.labels['pipes'].textContent = this.config.hasPipes ? 'PIPES' : '';
    }
    this.labels['pipes'].style.top = uvToTop(0.33);
    this.labels['pipes'].style.display = this.config.hasPipes ? '' : 'none';

    // Ground / Concrete
    const groundLabel = this.config.groundType === 'concrete' ? 'SLAB' : 'GROUND';
    this.labels['concrete'].textContent = `${groundLabel}${tStr}`;
    this.labels['concrete'].style.top = uvToTop(0.14);

    return { layout, hasMarking };
  }
}
