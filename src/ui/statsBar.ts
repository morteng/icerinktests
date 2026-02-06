import { QualityMetrics } from '../events';
import { RinkConfig, RinkPreset } from '../rink';

const PRESET_NAMES: Record<RinkPreset, string> = {
  nhl: 'NHL', olympic: 'Olympic', recreational: 'Recreational',
  backyard_small: 'Backyard S', backyard_medium: 'Backyard M', custom: 'Custom',
};

export class StatsBar {
  readonly el: HTMLDivElement;

  // Legend
  private legendBar: HTMLDivElement;

  // Sim group
  private simTimeEl: HTMLSpanElement;
  private fpsEl: HTMLSpanElement;

  // Rink group
  private rinkDimsEl: HTMLDivElement;
  private rinkAreaEl: HTMLDivElement;
  private rinkGridEl: HTMLDivElement;

  // Ice quality group
  private qualityEl: HTMLSpanElement;
  private qualityBarEl: HTMLSpanElement;
  private iceThicknessEl: HTMLSpanElement;
  private iceUniformityEl: HTMLSpanElement;
  private iceBareEl: HTMLSpanElement;
  private iceWaterEl: HTMLSpanElement;

  // Temp group
  private tempIceEl: HTMLSpanElement;
  private tempSurfaceEl: HTMLSpanElement;
  private tempSupplyEl: HTMLSpanElement;
  private tempReturnEl: HTMLSpanElement;
  private tempCoolantLine: HTMLDivElement;

  // Event group
  private eventNameEl: HTMLSpanElement;
  private eventRemainingEl: HTMLSpanElement;
  private eventProgressFill: HTMLSpanElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'bottom';

    // Legend
    const legend = document.createElement('div');
    legend.id = 'legend';
    const lblMin = document.createElement('span');
    lblMin.className = 'lbl';
    lblMin.textContent = '-15\u00B0C';
    this.legendBar = document.createElement('div');
    this.legendBar.id = 'legend-bar';
    const lblMax = document.createElement('span');
    lblMax.className = 'lbl';
    lblMax.textContent = '20\u00B0C';
    legend.append(lblMin, this.legendBar, lblMax);
    this.el.appendChild(legend);

    // Stats panel
    const panel = document.createElement('div');
    panel.id = 'stats-panel';

    // Sim
    const simGroup = this.makeGroup('Sim', 'sg-sim');
    this.simTimeEl = this.addStatLine(simGroup, 'Time:');
    this.fpsEl = this.addStatLine(simGroup, 'FPS:');
    panel.appendChild(simGroup);

    // Rink
    const rinkGroup = this.makeGroup('Rink', 'sg-rink');
    this.rinkDimsEl = document.createElement('div');
    this.rinkDimsEl.className = 'stat-line';
    this.rinkDimsEl.textContent = '--';
    rinkGroup.appendChild(this.rinkDimsEl);
    this.rinkAreaEl = document.createElement('div');
    this.rinkAreaEl.className = 'stat-line';
    this.rinkAreaEl.textContent = 'Area: --';
    rinkGroup.appendChild(this.rinkAreaEl);
    this.rinkGridEl = document.createElement('div');
    this.rinkGridEl.className = 'stat-line';
    this.rinkGridEl.textContent = '--';
    rinkGroup.appendChild(this.rinkGridEl);
    panel.appendChild(rinkGroup);

    // Ice quality
    const iceGroup = this.makeGroup('Ice Quality', 'sg-ice');
    const scoreLine = document.createElement('div');
    scoreLine.className = 'stat-line';
    scoreLine.textContent = 'Score: ';
    this.qualityEl = document.createElement('span');
    this.qualityEl.className = 'stat-val';
    this.qualityEl.textContent = '--';
    scoreLine.appendChild(this.qualityEl);
    this.qualityBarEl = document.createElement('span');
    this.qualityBarEl.className = 'quality-bar';
    scoreLine.appendChild(this.qualityBarEl);
    iceGroup.appendChild(scoreLine);
    this.iceThicknessEl = this.addStatLine(iceGroup, 'Thick:');
    const uniformLine = document.createElement('div');
    uniformLine.className = 'stat-line';
    uniformLine.textContent = 'Uniform: ';
    this.iceUniformityEl = document.createElement('span');
    this.iceUniformityEl.className = 'stat-val';
    this.iceUniformityEl.textContent = '--';
    uniformLine.appendChild(this.iceUniformityEl);
    uniformLine.append(' Bare: ');
    this.iceBareEl = document.createElement('span');
    this.iceBareEl.className = 'stat-val';
    this.iceBareEl.textContent = '--';
    uniformLine.appendChild(this.iceBareEl);
    iceGroup.appendChild(uniformLine);
    this.iceWaterEl = this.addStatLine(iceGroup, 'Water:');
    panel.appendChild(iceGroup);

    // Temp
    const tempGroup = this.makeGroup('Temperature', 'sg-temp');
    this.tempIceEl = this.addStatLine(tempGroup, 'Ice avg:');
    this.tempSurfaceEl = this.addStatLine(tempGroup, 'Surface:');
    this.tempCoolantLine = document.createElement('div');
    this.tempCoolantLine.className = 'stat-line';
    this.tempCoolantLine.textContent = 'Supply: ';
    this.tempSupplyEl = document.createElement('span');
    this.tempSupplyEl.className = 'stat-val';
    this.tempSupplyEl.textContent = '--';
    this.tempCoolantLine.appendChild(this.tempSupplyEl);
    this.tempCoolantLine.append(' Ret: ');
    this.tempReturnEl = document.createElement('span');
    this.tempReturnEl.className = 'stat-val';
    this.tempReturnEl.textContent = '--';
    this.tempCoolantLine.appendChild(this.tempReturnEl);
    tempGroup.appendChild(this.tempCoolantLine);
    panel.appendChild(tempGroup);

    // Event
    const eventGroup = this.makeGroup('Event', 'sg-event');
    const evtLine1 = document.createElement('div');
    evtLine1.className = 'stat-line';
    this.eventNameEl = document.createElement('span');
    this.eventNameEl.className = 'stat-val';
    this.eventNameEl.textContent = '--';
    evtLine1.appendChild(this.eventNameEl);
    eventGroup.appendChild(evtLine1);
    const evtLine2 = document.createElement('div');
    evtLine2.className = 'stat-line';
    const progressWrap = document.createElement('span');
    progressWrap.className = 'event-progress';
    this.eventProgressFill = document.createElement('span');
    this.eventProgressFill.className = 'event-progress-fill';
    progressWrap.appendChild(this.eventProgressFill);
    evtLine2.appendChild(progressWrap);
    evtLine2.append(' ');
    this.eventRemainingEl = document.createElement('span');
    this.eventRemainingEl.className = 'stat-val';
    evtLine2.appendChild(this.eventRemainingEl);
    eventGroup.appendChild(evtLine2);
    panel.appendChild(eventGroup);

    this.el.appendChild(panel);
  }

  private makeGroup(title: string, className: string): HTMLDivElement {
    const g = document.createElement('div');
    g.className = `stats-group ${className}`;
    const t = document.createElement('div');
    t.className = 'stats-group-title';
    t.textContent = title;
    g.appendChild(t);
    return g;
  }

  private addStatLine(group: HTMLDivElement, prefix: string): HTMLSpanElement {
    const line = document.createElement('div');
    line.className = 'stat-line';
    line.textContent = `${prefix} `;
    const val = document.createElement('span');
    val.className = 'stat-val';
    val.textContent = '--';
    line.appendChild(val);
    group.appendChild(line);
    return val;
  }

  updateStats(m: QualityMetrics) {
    this.qualityEl.textContent = `${m.score}`;
    this.qualityEl.className = 'stat-val ' + (m.score >= 70 ? 'quality-good' : m.score >= 40 ? 'quality-ok' : 'quality-bad');
    const barW = Math.round(m.score * 0.6);
    this.qualityBarEl.style.width = `${barW}px`;
    this.qualityBarEl.style.background = m.score >= 70 ? '#4ade80' : m.score >= 40 ? '#fbbf24' : '#f87171';
    this.iceThicknessEl.textContent = `${m.avgIceMm}/${m.minIceMm}/${m.maxIceMm}mm`;
    this.iceUniformityEl.textContent = `${m.uniformityPct}%`;
    this.iceBareEl.textContent = `${m.bareSpotsPct}%`;
    this.iceWaterEl.textContent = `${m.avgWaterMm}mm`;
    this.tempIceEl.textContent = `${m.avgIceTemp}\u00B0C`;
    this.tempSurfaceEl.textContent = `${m.avgSurfaceTemp}\u00B0C`;
  }

  updateSimTime(simTime: number) {
    const days = Math.floor(simTime / 86400);
    const hours = Math.floor((simTime % 86400) / 3600);
    const mins = Math.floor((simTime % 3600) / 60);
    const secs = Math.floor(simTime % 60);
    if (days > 0) {
      this.simTimeEl.textContent = `${days}d ${hours}h ${mins}m`;
    } else if (hours > 0) {
      this.simTimeEl.textContent = `${hours}h ${mins}m ${secs}s`;
    } else {
      this.simTimeEl.textContent = `${mins}m ${secs}s`;
    }
  }

  updateFps(fps: number) {
    this.fpsEl.textContent = `${fps}`;
  }

  updateRinkInfo(config: RinkConfig, maskData: Float32Array) {
    const name = PRESET_NAMES[config.preset];
    this.rinkDimsEl.textContent = `${name} ${Math.round(config.dims.lengthM)}\u00D7${Math.round(config.dims.widthM)}m`;
    const insideCells = maskData.reduce((sum: number, v: number) => sum + (v > 0.5 ? 1 : 0), 0);
    const areaM2 = insideCells * config.cellSize * config.cellSize;
    this.rinkAreaEl.textContent = `Area: ${Math.round(areaM2).toLocaleString()} m\u00B2`;
    this.rinkGridEl.textContent = `${config.gridW}\u00D7${config.gridH} cells`;
  }

  updateCoolantDisplay(hasPipes: boolean, supply: number) {
    this.tempCoolantLine.classList.toggle('hidden', !hasPipes);
    if (hasPipes) {
      this.tempSupplyEl.textContent = `${supply.toFixed(0)}\u00B0C`;
      this.tempReturnEl.textContent = `${(supply + 3).toFixed(0)}\u00B0C`;
    }
  }

  updateEventDisplay(autoMode: boolean, paused: boolean, eventName: string, timeRemaining: number, progressFraction: number) {
    if (autoMode && !paused) {
      this.eventNameEl.textContent = eventName;
      const remMin = Math.floor(timeRemaining / 60);
      const remSec = Math.floor(timeRemaining % 60);
      this.eventRemainingEl.textContent = `${remMin}m ${remSec}s`;
      this.eventProgressFill.style.width = `${Math.round(progressFraction * 100)}%`;
    } else {
      this.eventNameEl.textContent = autoMode ? eventName : '--';
      this.eventRemainingEl.textContent = '';
      this.eventProgressFill.style.width = '0%';
    }
  }
}
