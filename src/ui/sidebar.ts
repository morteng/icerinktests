import { MarkingLayout } from '../markings';
import { GroundType, RinkConfig } from '../rink';
import { SimTunables } from '../simulation';
import {
  createSlider, createSelect, createCheckbox, createButton,
  createColorInput, createTextInput, createButtonRow,
  createSubGroup, SliderResult,
} from './helpers';
import { MenuTab } from './menuBar';

export type PaintMode = 'off' | 'red' | 'blue' | 'white' | 'erase';
export type ActiveTool = 'none' | 'skate' | 'water' | 'snow' | 'snowball';

export interface ToolSliderState {
  radius: number;
  amount: number;
  temp: number;
  pressure: number;
  spread: number;
}

export interface MachineSliderState {
  shaveDepth: number;
  waterRate: number;
  heatTemp: number;
  speed: number;
}

export class Sidebar {
  readonly el: HTMLDivElement;

  // --- Callbacks (set by main.ts) ---
  onPresetChange: ((preset: string, customDims?: { lengthM: number; widthM: number; cornerRadiusM: number }) => void) | null = null;
  onReset: (() => void) | null = null;
  onFlood: (() => void) | null = null;
  onSnow: (() => void) | null = null;
  onZamboniToggle: (() => void) | null = null;
  onShovelToggle: (() => void) | null = null;
  onWaterTankToggle: (() => void) | null = null;
  onMarkingLayoutChange: ((layout: MarkingLayout) => void) | null = null;
  onSave: ((name: string) => void) | null = null;
  onLoad: ((name: string) => void) | null = null;
  onDelete: ((name: string) => void) | null = null;
  onPauseToggle: (() => void) | null = null;
  onGroundTypeChange: ((groundType: GroundType) => void) | null = null;
  onSurfaceGroundTypeChange: ((surfaceGroundType: GroundType) => void) | null = null;
  onLightToolToggle: ((active: boolean) => void) | null = null;
  onLightDelete: (() => void) | null = null;
  onLightResetAuto: (() => void) | null = null;
  onTimeManual: (() => void) | null = null;
  onPrep: (() => void) | null = null;

  // --- Controls (assigned in build* methods called from constructor) ---
  // Scene section
  private presetSelect!: HTMLSelectElement;
  private customControls!: HTMLDivElement;
  private groundSelect!: HTMLSelectElement;
  private groundCtrl!: HTMLDivElement;
  private surfaceSelect!: HTMLSelectElement;
  private surfaceCtrl!: HTMLDivElement;
  private customLength!: SliderResult;
  private customWidth!: SliderResult;
  private customCorner!: SliderResult;

  // Environment section
  private ambientSlider!: SliderResult;
  private pipeSlider!: SliderResult;
  private pipeCtrl!: HTMLDivElement;
  private timeSlider!: SliderResult;
  private weatherAutoCheckbox!: HTMLInputElement;
  private cloudSlider!: SliderResult;
  private precipSelect!: HTMLSelectElement;
  private precipIntensity!: SliderResult;
  private windLabel!: HTMLSpanElement;
  private weatherControls!: HTMLDivElement;

  // Rendering section
  private viewModeSelect!: HTMLSelectElement;
  private showPipesCheckbox!: HTMLInputElement;
  private showPipesCtrl!: HTMLDivElement;
  private showMarkingsCheckbox!: HTMLInputElement;
  private markingLayoutSelect!: HTMLSelectElement;

  // Lights (in rendering section)
  private lightBtn!: HTMLButtonElement;
  private lightPanel!: HTMLDivElement;
  private lightIndexEl!: HTMLSpanElement;
  private lightIntensity!: SliderResult;
  private lightHeight!: SliderResult;
  private lightRadius!: SliderResult;
  private lightColor!: HTMLInputElement;
  private lightDeleteBtn!: HTMLButtonElement;
  private lightResetAutoBtn!: HTMLButtonElement;

  // Tools section
  private skateBtn!: HTMLButtonElement;
  private waterBtn!: HTMLButtonElement;
  private snowBtn!: HTMLButtonElement;
  private snowballBtn!: HTMLButtonElement;
  private skatePanel!: HTMLDivElement;
  private waterPanel!: HTMLDivElement;
  private snowPanel!: HTMLDivElement;
  private snowballPanel!: HTMLDivElement;
  private skateRadius!: SliderResult;
  private skateIntensity!: SliderResult;
  private waterRadius!: SliderResult;
  private waterFlow!: SliderResult;
  private waterTemp!: SliderResult;
  private waterPressure!: SliderResult;
  private snowRadius!: SliderResult;
  private snowAmount!: SliderResult;
  private snowSpread!: SliderResult;
  private snowballRate!: SliderResult;
  private snowballSize!: SliderResult;
  private snowballPressure!: SliderResult;

  // Paint (in tools section)
  private paintSelect!: HTMLSelectElement;

  // Machines (in tools section)
  private zamboniBtn!: HTMLButtonElement;
  private shovelBtn!: HTMLButtonElement;
  private tankBtn!: HTMLButtonElement;
  private floodBtn!: HTMLButtonElement;
  private snowActionBtn!: HTMLButtonElement;
  private machinePanel!: HTMLDivElement;
  private zamBlade!: SliderResult;
  private zamWater!: SliderResult;
  private zamTemp!: SliderResult;
  private zamSpeed!: SliderResult;

  // Sim tunables
  private freezeRateSlider!: SliderResult;
  private meltRateSlider!: SliderResult;
  private latentSlider!: SliderResult;
  private airTauSlider!: SliderResult;
  private evapSlider!: SliderResult;
  private drainSlider!: SliderResult;
  private snowReposeSlider!: SliderResult;
  private snowTransferSlider!: SliderResult;

  // Render flags
  private shadowsCheckbox!: HTMLInputElement;
  private reflectionsCheckbox!: HTMLInputElement;
  private scratchesCheckbox!: HTMLInputElement;
  private sparkleCheckbox!: HTMLInputElement;
  private thinFilmCheckbox!: HTMLInputElement;

  // Playback (sticky)
  private pauseBtn!: HTMLButtonElement;
  private prepBtn!: HTMLButtonElement;
  private speedSlider!: SliderResult;
  private autoModeCheckbox!: HTMLInputElement;

  // Session section
  private sceneNameInput!: HTMLInputElement;
  private loadSelect!: HTMLSelectElement;

  // --- State ---
  private _activeTool: ActiveTool = 'none';
  private _paintMode: PaintMode = 'off';
  private _lightToolActive = false;
  private _paused = false;

  // Tab → section mapping
  private sections = new Map<MenuTab, HTMLDivElement>();

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'sidebar';

    this.buildStickyPlayback();
    this.buildSceneSection();
    this.buildEnvironmentSection();
    this.buildRenderingSection();
    this.buildToolsSection();
    this.buildSimSection();
    this.buildSessionSection();

    // Default: show scene tab
    this.showSection('scene');
  }

  /** Show only the section for the given tab. */
  showSection(tab: MenuTab) {
    for (const [id, div] of this.sections) {
      div.style.display = id === tab ? '' : 'none';
    }
  }

  // ==================== SECTION BUILDERS ====================

  private buildStickyPlayback() {
    const sticky = document.createElement('div');
    sticky.className = 'sidebar-sticky';

    this.pauseBtn = createButton('Pause');
    const resetBtn = createButton('Reset');
    this.prepBtn = createButton('Prep');
    sticky.appendChild(createButtonRow(this.pauseBtn, resetBtn, this.prepBtn));

    this.speedSlider = createSlider({ label: 'Speed', min: 1, max: 1000, value: 10, step: 1, formatVal: v => `${v}` });
    sticky.appendChild(this.speedSlider.row);

    const auto = createCheckbox('Auto', false);
    this.autoModeCheckbox = auto.checkbox;
    sticky.appendChild(auto.row);

    this.timeSlider = createSlider({ label: 'Time', min: 0, max: 24, value: 12, step: 0.25, formatVal: v => {
      const h = Math.floor(v);
      const m = Math.floor((v - h) * 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }});
    sticky.appendChild(this.timeSlider.row);

    this.el.appendChild(sticky);

    // Events
    this.pauseBtn.addEventListener('click', () => {
      this._paused = !this._paused;
      this.pauseBtn.textContent = this._paused ? 'Play' : 'Pause';
      this.pauseBtn.classList.toggle('active', this._paused);
      this.onPauseToggle?.();
    });
    resetBtn.addEventListener('click', () => this.onReset?.());
    this.prepBtn.addEventListener('click', () => this.onPrep?.());
    this.timeSlider.slider.addEventListener('input', () => {
      this.onTimeManual?.();
    });
  }

  private buildSceneSection() {
    const section = document.createElement('div');
    section.className = 'sidebar-tab-content';
    this.sections.set('scene', section);

    const preset = createSelect({
      label: 'Preset',
      options: [
        { value: 'nhl', text: 'NHL' },
        { value: 'olympic', text: 'Olympic' },
        { value: 'recreational', text: 'Recreational' },
        { value: 'backyard_small', text: 'Backyard S', selected: true },
        { value: 'backyard_medium', text: 'Backyard M' },
        { value: 'custom', text: 'Custom' },
      ],
    });
    this.presetSelect = preset.select;
    section.appendChild(preset.row);

    const ground = createSelect({
      label: 'Surround',
      options: [
        { value: 'grass', text: 'Grass', selected: true },
        { value: 'gravel', text: 'Gravel' },
        { value: 'asphalt', text: 'Asphalt' },
      ],
    });
    this.groundSelect = ground.select;
    this.groundCtrl = ground.row;
    this.groundCtrl.classList.add('hidden');
    section.appendChild(this.groundCtrl);

    const surface = createSelect({
      label: 'Surface',
      options: [
        { value: 'gravel', text: 'Gravel', selected: true },
        { value: 'grass', text: 'Grass' },
        { value: 'asphalt', text: 'Asphalt' },
        { value: 'concrete', text: 'Concrete' },
      ],
    });
    this.surfaceSelect = surface.select;
    this.surfaceCtrl = surface.row;
    this.surfaceCtrl.classList.add('hidden');
    section.appendChild(this.surfaceCtrl);

    // Custom sliders (hidden by default)
    this.customControls = document.createElement('div');
    this.customControls.className = 'custom-sliders';
    this.customLength = createSlider({ label: 'L', min: 5, max: 70, value: 61, step: 1, short: true, formatVal: v => `${v}m` });
    this.customWidth = createSlider({ label: 'W', min: 3, max: 35, value: 26, step: 1, short: true, formatVal: v => `${v}m` });
    this.customCorner = createSlider({ label: 'R', min: 0, max: 12, value: 8.5, step: 0.5, short: true, formatVal: v => `${v}m` });
    this.customControls.append(this.customLength.row, this.customWidth.row, this.customCorner.row);
    section.appendChild(this.customControls);

    this.el.appendChild(section);

    // Events
    this.presetSelect.addEventListener('change', () => {
      this.customControls.classList.toggle('show', this.presetSelect.value === 'custom');
      this.firePresetChange();
    });
    this.groundSelect.addEventListener('change', () => {
      this.onGroundTypeChange?.(this.groundSelect.value as GroundType);
    });
    this.surfaceSelect.addEventListener('change', () => {
      this.onSurfaceGroundTypeChange?.(this.surfaceSelect.value as GroundType);
    });
    const customChange = () => {
      if (this.presetSelect.value === 'custom') this.firePresetChange();
    };
    this.customLength.slider.addEventListener('change', customChange);
    this.customWidth.slider.addEventListener('change', customChange);
    this.customCorner.slider.addEventListener('change', customChange);
  }

  private buildEnvironmentSection() {
    const section = document.createElement('div');
    section.className = 'sidebar-tab-content';
    this.sections.set('environment', section);

    this.ambientSlider = createSlider({ label: 'Ambient', min: -30, max: 35, value: -10, step: 0.5, formatVal: v => `${v.toFixed(1)}\u00B0C` });
    section.appendChild(this.ambientSlider.row);

    this.pipeSlider = createSlider({ label: 'Pipes', min: -20, max: 0, value: -9, step: 0.5, formatVal: v => `${v.toFixed(1)}\u00B0C` });
    this.pipeCtrl = this.pipeSlider.row;
    section.appendChild(this.pipeCtrl);

    // Weather controls container (hidden for indoor)
    this.weatherControls = document.createElement('div');

    section.appendChild(createSubGroup('Weather'));

    const weatherAuto = createCheckbox('Auto Weather', true);
    this.weatherAutoCheckbox = weatherAuto.checkbox;
    this.weatherControls.appendChild(weatherAuto.row);

    this.cloudSlider = createSlider({ label: 'Clouds', min: 0, max: 1, value: 0.3, step: 0.05, short: true, formatVal: v => `${Math.round(v * 100)}%` });
    this.cloudSlider.slider.disabled = true;
    this.weatherControls.appendChild(this.cloudSlider.row);

    const precip = createSelect({
      label: 'Precip',
      options: [
        { value: 'auto', text: 'Auto', selected: true },
        { value: 'none', text: 'None' },
        { value: 'rain', text: 'Rain' },
        { value: 'snow', text: 'Snow' },
      ],
    });
    this.precipSelect = precip.select;
    this.precipSelect.disabled = true;
    this.weatherControls.appendChild(precip.row);

    this.precipIntensity = createSlider({ label: 'Intensity', min: 0.1, max: 3.0, value: 1.0, step: 0.1, short: true, formatVal: v => `${v.toFixed(1)}x` });
    this.precipIntensity.slider.disabled = true;
    this.weatherControls.appendChild(this.precipIntensity.row);

    // Wind display (read-only)
    const windRow = document.createElement('div');
    windRow.className = 'ctrl';
    const windLbl = document.createElement('label');
    windLbl.textContent = 'Wind';
    this.windLabel = document.createElement('span');
    this.windLabel.className = 'val';
    this.windLabel.textContent = '0.0 m/s';
    windRow.append(windLbl, this.windLabel);
    this.weatherControls.appendChild(windRow);

    section.appendChild(this.weatherControls);

    this.el.appendChild(section);

    this.weatherAutoCheckbox.addEventListener('change', () => {
      const auto = this.weatherAutoCheckbox.checked;
      this.cloudSlider.slider.disabled = auto;
      this.precipSelect.disabled = auto;
      this.precipIntensity.slider.disabled = auto;
    });
  }

  private buildRenderingSection() {
    const section = document.createElement('div');
    section.className = 'sidebar-tab-content';
    this.sections.set('rendering', section);

    // View mode (moved from rink)
    const viewMode = createSelect({
      label: 'View',
      options: [
        { value: 'thermal', text: 'Thermal' },
        { value: 'visual', text: 'Visual', selected: true },
        { value: 'sky', text: 'Sky' },
      ],
    });
    this.viewModeSelect = viewMode.select;
    section.appendChild(viewMode.row);

    // Overlays sub-group
    section.appendChild(createSubGroup('Overlays'));

    const showPipes = createCheckbox('Pipes', true);
    this.showPipesCheckbox = showPipes.checkbox;
    this.showPipesCtrl = showPipes.row;
    section.appendChild(showPipes.row);

    const showMarkings = createCheckbox('Markings', true);
    this.showMarkingsCheckbox = showMarkings.checkbox;
    section.appendChild(showMarkings.row);

    const markingLayout = createSelect({
      label: 'Layout',
      options: [
        { value: 'nhl', text: 'NHL' },
        { value: 'olympic', text: 'Olympic' },
        { value: 'recreational', text: 'Recreational' },
        { value: 'figure', text: 'Figure' },
        { value: 'none', text: 'None', selected: true },
      ],
    });
    this.markingLayoutSelect = markingLayout.select;
    section.appendChild(markingLayout.row);

    // Lighting sub-group
    section.appendChild(createSubGroup('Lighting'));

    this.lightBtn = createButton('Edit Lights');
    section.appendChild(createButtonRow(this.lightBtn));

    this.lightPanel = document.createElement('div');
    this.lightPanel.className = 'tool-panel hidden';

    const indexRow = document.createElement('div');
    indexRow.className = 'ctrl';
    const indexLbl = document.createElement('label');
    indexLbl.textContent = 'Light';
    this.lightIndexEl = document.createElement('span');
    this.lightIndexEl.className = 'val';
    this.lightIndexEl.textContent = '--';
    indexRow.append(indexLbl, this.lightIndexEl);
    this.lightPanel.appendChild(indexRow);

    this.lightIntensity = createSlider({ label: 'Intensity', min: 0, max: 2, value: 1, step: 0.05, short: true, formatVal: v => v.toFixed(2) });
    this.lightHeight = createSlider({ label: 'Height', min: 3, max: 120, value: 80, step: 1, short: true });
    this.lightRadius = createSlider({ label: 'Radius', min: 10, max: 500, value: 100, step: 5, short: true });
    const color = createColorInput('Color', '#fffaf0');
    this.lightColor = color.input;
    this.lightPanel.append(this.lightIntensity.row, this.lightHeight.row, this.lightRadius.row, color.row);

    this.lightDeleteBtn = createButton('Delete');
    this.lightResetAutoBtn = createButton('Reset Auto');
    this.lightPanel.appendChild(createButtonRow(this.lightDeleteBtn, this.lightResetAutoBtn));

    section.appendChild(this.lightPanel);

    // Effects sub-group (render flags)
    section.appendChild(createSubGroup('Effects'));

    const shadows = createCheckbox('Shadows', true);
    this.shadowsCheckbox = shadows.checkbox;
    section.appendChild(shadows.row);

    const reflections = createCheckbox('Reflections', true);
    this.reflectionsCheckbox = reflections.checkbox;
    section.appendChild(reflections.row);

    const scratchesCb = createCheckbox('Scratches', true);
    this.scratchesCheckbox = scratchesCb.checkbox;
    section.appendChild(scratchesCb.row);

    const sparkle = createCheckbox('Sparkle', true);
    this.sparkleCheckbox = sparkle.checkbox;
    section.appendChild(sparkle.row);

    const thinFilm = createCheckbox('Thin-film', true);
    this.thinFilmCheckbox = thinFilm.checkbox;
    section.appendChild(thinFilm.row);

    this.el.appendChild(section);

    // Events
    this.viewModeSelect.addEventListener('change', () => {
      if (this.renderMode === 1) {
        this.showMarkingsCheckbox.checked = true;
      }
    });
    this.markingLayoutSelect.addEventListener('change', () => {
      this.onMarkingLayoutChange?.(this.markingLayoutSelect.value as MarkingLayout);
    });
    this.lightBtn.addEventListener('click', () => {
      this._lightToolActive = !this._lightToolActive;
      this.lightBtn.classList.toggle('active', this._lightToolActive);
      this.lightPanel.classList.toggle('hidden', !this._lightToolActive);
      if (this._lightToolActive) {
        this.deactivateAllTools();
        this._paintMode = 'off';
        this.paintSelect.value = 'off';
      }
      this.onLightToolToggle?.(this._lightToolActive);
    });
    this.lightDeleteBtn.addEventListener('click', () => this.onLightDelete?.());
    this.lightResetAutoBtn.addEventListener('click', () => {
      this._lightToolActive = false;
      this.lightBtn.classList.remove('active');
      this.lightPanel.classList.add('hidden');
      this.onLightResetAuto?.();
    });
    this.lightIntensity.slider.addEventListener('input', () => this.onLightSliderChange?.());
    this.lightHeight.slider.addEventListener('input', () => this.onLightSliderChange?.());
    this.lightRadius.slider.addEventListener('input', () => this.onLightSliderChange?.());
    this.lightColor.addEventListener('input', () => this.onLightSliderChange?.());
  }

  // Extra callback for light sliders
  onLightSliderChange: (() => void) | null = null;

  private buildToolsSection() {
    const section = document.createElement('div');
    section.className = 'sidebar-tab-content';
    this.sections.set('tools', section);

    // Hand Tools sub-group
    section.appendChild(createSubGroup('Hand Tools'));

    this.skateBtn = createButton('Skate');
    this.waterBtn = createButton('Water');
    this.snowBtn = createButton('Snow');
    this.snowballBtn = createButton('Snowball');
    section.appendChild(createButtonRow(this.skateBtn, this.waterBtn, this.snowBtn, this.snowballBtn));

    // Skate sub-panel
    this.skatePanel = document.createElement('div');
    this.skatePanel.className = 'tool-panel hidden';
    this.skateRadius = createSlider({ label: 'Radius', min: 1, max: 10, value: 5, step: 1, short: true });
    this.skateIntensity = createSlider({ label: 'Intensity', min: 0.1, max: 2.0, value: 0.8, step: 0.1, short: true, formatVal: v => v.toFixed(1) });
    this.skatePanel.append(this.skateRadius.row, this.skateIntensity.row);
    section.appendChild(this.skatePanel);

    // Water sub-panel
    this.waterPanel = document.createElement('div');
    this.waterPanel.className = 'tool-panel hidden';
    this.waterRadius = createSlider({ label: 'Radius', min: 1, max: 12, value: 6, step: 1, short: true });
    this.waterFlow = createSlider({ label: 'Flow', min: 0.05, max: 2.0, value: 0.8, step: 0.05, short: true, formatVal: v => v.toFixed(2) });
    this.waterTemp = createSlider({ label: 'Temp', min: 5, max: 80, value: 20, step: 1, short: true, formatVal: v => `${v}\u00B0C` });
    this.waterPressure = createSlider({ label: 'Pressure', min: 1, max: 8, value: 5, step: 0.5, short: true, formatVal: v => v.toFixed(1) });
    this.waterPanel.append(this.waterRadius.row, this.waterFlow.row, this.waterTemp.row, this.waterPressure.row);
    section.appendChild(this.waterPanel);

    // Snow sub-panel
    this.snowPanel = document.createElement('div');
    this.snowPanel.className = 'tool-panel hidden';
    this.snowRadius = createSlider({ label: 'Radius', min: 1, max: 15, value: 8, step: 1, short: true });
    this.snowAmount = createSlider({ label: 'Amount', min: 0.05, max: 1.0, value: 0.5, step: 0.05, short: true, formatVal: v => v.toFixed(2) });
    this.snowSpread = createSlider({ label: 'Spread', min: 1, max: 8, value: 5, step: 0.5, short: true, formatVal: v => v.toFixed(1) });
    this.snowPanel.append(this.snowRadius.row, this.snowAmount.row, this.snowSpread.row);
    section.appendChild(this.snowPanel);

    // Snowball sub-panel
    this.snowballPanel = document.createElement('div');
    this.snowballPanel.className = 'tool-panel hidden';
    this.snowballRate = createSlider({ label: 'Rate', min: 1, max: 10, value: 5, step: 1, short: true });
    this.snowballSize = createSlider({ label: 'Size', min: 2, max: 8, value: 4, step: 0.5, short: true, formatVal: v => `${v.toFixed(1)}mm` });
    this.snowballPressure = createSlider({ label: 'Pressure', min: 1, max: 8, value: 5, step: 0.5, short: true, formatVal: v => v.toFixed(1) });
    this.snowballPanel.append(this.snowballRate.row, this.snowballSize.row, this.snowballPressure.row);
    section.appendChild(this.snowballPanel);

    // Paint sub-group
    section.appendChild(createSubGroup('Paint'));

    const paint = createSelect({
      label: 'Paint',
      options: [
        { value: 'off', text: 'Off', selected: true },
        { value: 'red', text: 'Red' },
        { value: 'blue', text: 'Blue' },
        { value: 'white', text: 'White' },
        { value: 'erase', text: 'Erase' },
      ],
    });
    this.paintSelect = paint.select;
    section.appendChild(paint.row);

    // Machines sub-group
    section.appendChild(createSubGroup('Machines'));

    this.zamboniBtn = createButton('Zamboni');
    this.shovelBtn = createButton('Shovel');
    this.tankBtn = createButton('Tank');
    section.appendChild(createButtonRow(this.zamboniBtn, this.shovelBtn, this.tankBtn));

    // Machine slider panel
    this.machinePanel = document.createElement('div');
    this.machinePanel.className = 'tool-panel hidden';
    this.zamBlade = createSlider({ label: 'Blade', min: 0, max: 2, value: 0.8, step: 0.1, short: true, formatVal: v => `${v.toFixed(1)}mm` });
    this.zamWater = createSlider({ label: 'Water', min: 0, max: 5, value: 1.7, step: 0.1, short: true, formatVal: v => `${v.toFixed(1)}mm/s` });
    this.zamTemp = createSlider({ label: 'Temp', min: 0, max: 80, value: 65, step: 1, short: true, formatVal: v => `${v}\u00B0C` });
    this.zamSpeed = createSlider({ label: 'Speed', min: 0.5, max: 4.0, value: 2.0, step: 0.1, short: true, formatVal: v => `${v.toFixed(1)}m/s` });
    this.machinePanel.append(this.zamBlade.row, this.zamWater.row, this.zamTemp.row, this.zamSpeed.row);
    section.appendChild(this.machinePanel);

    // Actions sub-group
    section.appendChild(createSubGroup('Actions'));

    this.floodBtn = createButton('Flood');
    this.snowActionBtn = createButton('Snow');
    section.appendChild(createButtonRow(this.floodBtn, this.snowActionBtn));

    this.el.appendChild(section);

    // Events — hand tools
    this.skateBtn.addEventListener('click', () => this.activateTool('skate'));
    this.waterBtn.addEventListener('click', () => this.activateTool('water'));
    this.snowBtn.addEventListener('click', () => this.activateTool('snow'));
    this.snowballBtn.addEventListener('click', () => this.activateTool('snowball'));

    // Events — paint
    this.paintSelect.addEventListener('change', () => {
      this._paintMode = this.paintSelect.value as PaintMode;
      if (this._paintMode !== 'off') {
        this.deactivateAllTools();
        this.deactivateLightTool();
      }
    });

    // Events — machines
    this.zamboniBtn.addEventListener('click', () => this.onZamboniToggle?.());
    this.shovelBtn.addEventListener('click', () => this.onShovelToggle?.());
    this.tankBtn.addEventListener('click', () => this.onWaterTankToggle?.());
    this.floodBtn.addEventListener('click', () => this.onFlood?.());
    this.snowActionBtn.addEventListener('click', () => this.onSnow?.());
  }

  private buildSimSection() {
    const section = document.createElement('div');
    section.className = 'sidebar-tab-content';
    this.sections.set('sim', section);

    this.freezeRateSlider = createSlider({ label: 'Freeze', min: 0.0001, max: 0.01, value: 0.001, step: 0.0001, short: true, formatVal: v => v.toFixed(4) });
    this.meltRateSlider = createSlider({ label: 'Melt', min: 0.0001, max: 0.01, value: 0.001, step: 0.0001, short: true, formatVal: v => v.toFixed(4) });
    this.latentSlider = createSlider({ label: 'Latent', min: 1, max: 20, value: 5, step: 0.5, short: true, formatVal: v => v.toFixed(1) });
    this.airTauSlider = createSlider({ label: 'Air Tau', min: 500, max: 100000, value: 10000, step: 500, short: true, formatVal: v => `${Math.round(v)}s` });
    this.evapSlider = createSlider({ label: 'Evap', min: 0, max: 0.001, value: 0.0001, step: 0.00001, short: true, formatVal: v => v.toFixed(5) });
    this.drainSlider = createSlider({ label: 'Drain', min: 0, max: 0.2, value: 0.05, step: 0.005, short: true, formatVal: v => v.toFixed(3) });
    this.snowReposeSlider = createSlider({ label: 'Snow Angle', min: 0.5, max: 5, value: 1.5, step: 0.1, short: true, formatVal: v => `${v.toFixed(1)}mm` });
    this.snowTransferSlider = createSlider({ label: 'Snow Slide', min: 0.05, max: 0.8, value: 0.3, step: 0.01, short: true, formatVal: v => v.toFixed(2) });

    section.append(
      this.freezeRateSlider.row, this.meltRateSlider.row, this.latentSlider.row, this.airTauSlider.row,
      this.evapSlider.row, this.drainSlider.row, this.snowReposeSlider.row, this.snowTransferSlider.row,
    );

    this.el.appendChild(section);
  }

  private buildSessionSection() {
    const section = document.createElement('div');
    section.className = 'sidebar-tab-content';
    this.sections.set('session', section);

    // Save row
    const saveRow = document.createElement('div');
    saveRow.className = 'ctrl';
    this.sceneNameInput = createTextInput('name');
    const saveBtn = createButton('Save');
    saveRow.append(this.sceneNameInput, saveBtn);
    section.appendChild(saveRow);

    // Load row
    const loadRow = document.createElement('div');
    loadRow.className = 'ctrl';
    this.loadSelect = document.createElement('select');
    this.loadSelect.style.cssText = 'width:80px;flex:1;';
    this.loadSelect.innerHTML = '<option value="">--</option>';
    const loadBtn = createButton('Load');
    const delBtn = createButton('Del');
    loadRow.append(this.loadSelect, loadBtn, delBtn);
    section.appendChild(loadRow);

    this.el.appendChild(section);

    // Events
    saveBtn.addEventListener('click', () => {
      const name = this.sceneNameInput.value.trim();
      if (name) {
        this.onSave?.(name);
        this.sceneNameInput.value = '';
      }
    });
    loadBtn.addEventListener('click', () => {
      const name = this.loadSelect.value;
      if (name) this.onLoad?.(name);
    });
    delBtn.addEventListener('click', () => {
      const name = this.loadSelect.value;
      if (name) this.onDelete?.(name);
    });
  }

  // ==================== TOOL/MODE MANAGEMENT ====================

  private activateTool(tool: ActiveTool) {
    if (this._activeTool === tool) {
      this.deactivateAllTools();
      return;
    }
    this.deactivateAllTools();
    this.deactivateLightTool();
    this._paintMode = 'off';
    this.paintSelect.value = 'off';
    this._activeTool = tool;

    if (tool === 'skate') {
      this.skateBtn.classList.add('active');
      this.skatePanel.classList.remove('hidden');
    } else if (tool === 'water') {
      this.waterBtn.classList.add('active');
      this.waterPanel.classList.remove('hidden');
    } else if (tool === 'snow') {
      this.snowBtn.classList.add('active');
      this.snowPanel.classList.remove('hidden');
    } else if (tool === 'snowball') {
      this.snowballBtn.classList.add('active');
      this.snowballPanel.classList.remove('hidden');
    }
  }

  private deactivateAllTools() {
    this._activeTool = 'none';
    this.skateBtn.classList.remove('active');
    this.waterBtn.classList.remove('active');
    this.snowBtn.classList.remove('active');
    this.snowballBtn.classList.remove('active');
    this.skatePanel.classList.add('hidden');
    this.waterPanel.classList.add('hidden');
    this.snowPanel.classList.add('hidden');
    this.snowballPanel.classList.add('hidden');
  }

  private deactivateLightTool() {
    if (this._lightToolActive) {
      this._lightToolActive = false;
      this.lightBtn.classList.remove('active');
      this.lightPanel.classList.add('hidden');
      this.onLightToolToggle?.(false);
    }
  }

  // ==================== STATE GETTERS (read by main.ts each frame) ====================

  get preset(): string { return this.presetSelect.value; }
  get renderMode(): number {
    const v = this.viewModeSelect.value;
    return v === 'visual' ? 1 : v === 'sky' ? 2 : 0;
  }
  get ambientTemp(): number { return parseFloat(this.ambientSlider.slider.value); }
  get pipeTemp(): number { return parseFloat(this.pipeSlider.slider.value); }
  get simSpeed(): number { return parseInt(this.speedSlider.slider.value); }
  get timeOfDay(): number { return parseFloat(this.timeSlider.slider.value); }
  get showPipes(): boolean { return this.showPipesCheckbox.checked; }
  get showMarkings(): boolean { return this.showMarkingsCheckbox.checked; }
  get paintMode(): PaintMode { return this._paintMode; }
  get activeTool(): ActiveTool { return this._activeTool; }
  get lightToolActive(): boolean { return this._lightToolActive; }
  get paused(): boolean { return this._paused; }
  get autoMode(): boolean { return this.autoModeCheckbox.checked; }
  get markingLayout(): MarkingLayout { return this.markingLayoutSelect.value as MarkingLayout; }
  get groundType(): GroundType { return this.groundSelect.value as GroundType; }
  get surfaceGroundType(): GroundType { return this.surfaceSelect.value as GroundType; }
  get weatherAuto(): boolean { return this.weatherAutoCheckbox.checked; }
  get cloudCoverManual(): number { return parseFloat(this.cloudSlider.slider.value); }
  get precipMode(): string { return this.precipSelect.value; }
  get precipIntensityVal(): number { return parseFloat(this.precipIntensity.slider.value); }

  get simTunables(): SimTunables {
    return {
      freezeRate: parseFloat(this.freezeRateSlider.slider.value),
      meltRate: parseFloat(this.meltRateSlider.slider.value),
      latentFactor: parseFloat(this.latentSlider.slider.value),
      airTau: parseFloat(this.airTauSlider.slider.value),
      evapRate: parseFloat(this.evapSlider.slider.value),
      drainRate: parseFloat(this.drainSlider.slider.value),
      snowRepose: parseFloat(this.snowReposeSlider.slider.value),
      snowTransfer: parseFloat(this.snowTransferSlider.slider.value),
    };
  }

  get renderFlags(): number {
    let flags = 0;
    if (this.shadowsCheckbox.checked) flags |= 1;
    if (this.reflectionsCheckbox.checked) flags |= 2;
    if (this.scratchesCheckbox.checked) flags |= 4;
    if (this.sparkleCheckbox.checked) flags |= 8;
    if (this.thinFilmCheckbox.checked) flags |= 16;
    return flags;
  }

  get toolSliders(): ToolSliderState {
    if (this._activeTool === 'skate') {
      return {
        radius: parseInt(this.skateRadius.slider.value),
        amount: parseFloat(this.skateIntensity.slider.value),
        temp: 0, pressure: 0, spread: 0,
      };
    } else if (this._activeTool === 'water') {
      return {
        radius: parseInt(this.waterRadius.slider.value),
        amount: parseFloat(this.waterFlow.slider.value),
        temp: parseFloat(this.waterTemp.slider.value),
        pressure: parseFloat(this.waterPressure.slider.value),
        spread: 0,
      };
    } else if (this._activeTool === 'snow') {
      return {
        radius: parseInt(this.snowRadius.slider.value),
        amount: parseFloat(this.snowAmount.slider.value),
        temp: 0, pressure: 0,
        spread: parseFloat(this.snowSpread.slider.value),
      };
    } else if (this._activeTool === 'snowball') {
      return {
        radius: 3,
        amount: parseFloat(this.snowballSize.slider.value),
        temp: -5, pressure: parseFloat(this.snowballPressure.slider.value),
        spread: parseFloat(this.snowballRate.slider.value),
      };
    }
    return { radius: 5, amount: 0.8, temp: 20, pressure: 5, spread: 5 };
  }

  get machineSliders(): MachineSliderState {
    return {
      shaveDepth: parseFloat(this.zamBlade.slider.value),
      waterRate: parseFloat(this.zamWater.slider.value),
      heatTemp: parseFloat(this.zamTemp.slider.value),
      speed: parseFloat(this.zamSpeed.slider.value),
    };
  }

  get lightSliderState() {
    return {
      intensity: parseFloat(this.lightIntensity.slider.value),
      height: parseFloat(this.lightHeight.slider.value),
      radius: parseFloat(this.lightRadius.slider.value),
      color: this.lightColor.value,
    };
  }

  // ==================== UPDATE METHODS (called by main.ts) ====================

  /** Update which controls are visible based on config. */
  updateVisibility(config: RinkConfig) {
    const hasPipes = config.hasPipes;
    this.pipeCtrl.classList.toggle('hidden', !hasPipes);
    this.showPipesCtrl.classList.toggle('hidden', !hasPipes);
    this.snowActionBtn.classList.toggle('hidden', config.isIndoor);
    this.customControls.classList.toggle('show', config.preset === 'custom');
    this.groundCtrl.classList.toggle('hidden', !config.isBackyard);
    this.surfaceCtrl.classList.toggle('hidden', !config.isBackyard);
    this.weatherControls.style.display = config.isIndoor ? 'none' : '';

    if (config.isBackyard) {
      this.ambientSlider.slider.min = '-30';
      this.ambientSlider.slider.max = '5';
      if (this.ambientTemp > 5) this.ambientSlider.setVal(-10);
    } else {
      this.ambientSlider.slider.min = '-20';
      this.ambientSlider.slider.max = '35';
    }
  }

  setAirTauDefault(isIndoor: boolean) {
    this.airTauSlider.setVal(isIndoor ? 80000 : 10000);
  }

  setAmbientTemp(v: number) { this.ambientSlider.setVal(v); }
  setPipeTemp(v: number) { this.pipeSlider.setVal(v); }

  setWindDisplay(speedMs: number, dirDeg: number) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(((dirDeg % 360) + 360) % 360 / 45) % 8;
    this.windLabel.textContent = `${speedMs.toFixed(1)} m/s ${dirs[idx]}`;
  }

  setTimeOfDay(v: number) { this.timeSlider.setVal(v); }

  setSpeedDisplay(zamboniActive: boolean) {
    this.speedSlider.valSpan.textContent = zamboniActive ? 'RT' : `${this.simSpeed}`;
  }

  /** Update zamboni/shovel/tank button active state. */
  updateMachineButtons(zamboniActive: boolean, machineType: string) {
    this.zamboniBtn.classList.toggle('active', zamboniActive && machineType === 'zamboni');
    this.shovelBtn.classList.toggle('active', zamboniActive && machineType === 'shovel');
    this.tankBtn.classList.toggle('active', zamboniActive && machineType === 'water_tank');
    if (!zamboniActive) this.machinePanel.classList.add('hidden');
  }

  /** Show machine slider panel with preset values for the given type. */
  showMachineControls(type: 'zamboni' | 'shovel' | 'water_tank') {
    this.machinePanel.classList.remove('hidden');
    if (type === 'zamboni') {
      this.zamBlade.row.style.display = '';
      this.zamBlade.setVal(0.8);
      this.zamWater.setVal(1.7);
      this.zamTemp.setVal(65);
      this.zamSpeed.setVal(2.0);
    } else if (type === 'water_tank') {
      this.zamBlade.row.style.display = 'none'; // no blade
      this.zamWater.setVal(1.2);
      this.zamTemp.setVal(65);
      this.zamSpeed.setVal(1.5);
    } else {
      this.zamBlade.row.style.display = '';
      this.zamBlade.setVal(0);
      this.zamWater.setVal(0);
      this.zamTemp.setVal(0);
      this.zamSpeed.setVal(0.8);
    }
  }

  hideMachineControls() {
    this.machinePanel.classList.add('hidden');
  }

  /** Update light tool panel from the selected light. */
  updateLightPanel(sel: { intensity: number; z: number; radius: number; r: number; g: number; b: number } | null, index: number) {
    if (sel) {
      this.lightIndexEl.textContent = `#${index + 1}`;
      this.lightIntensity.setVal(sel.intensity);
      this.lightHeight.setVal(Math.round(sel.z));
      this.lightRadius.setVal(Math.round(sel.radius));
      const toHex = (c: number) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
      this.lightColor.value = `#${toHex(sel.r)}${toHex(sel.g)}${toHex(sel.b)}`;
    } else {
      this.lightIndexEl.textContent = '--';
    }
  }

  deactivateLightToolExternal() {
    this._lightToolActive = false;
    this.lightBtn.classList.remove('active');
    this.lightPanel.classList.add('hidden');
  }

  refreshSaveList(names: string[]) {
    this.loadSelect.innerHTML = '<option value="">--</option>';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      this.loadSelect.appendChild(opt);
    }
  }

  setMarkingLayout(layout: MarkingLayout) {
    this.markingLayoutSelect.value = layout;
  }

  setPreset(preset: string) {
    this.presetSelect.value = preset;
    this.customControls.classList.toggle('show', preset === 'custom');
  }

  // ==================== INTERNAL HELPERS ====================

  private firePresetChange() {
    const preset = this.presetSelect.value;
    let customDims: { lengthM: number; widthM: number; cornerRadiusM: number } | undefined;
    if (preset === 'custom') {
      customDims = {
        lengthM: parseFloat(this.customLength.slider.value),
        widthM: parseFloat(this.customWidth.slider.value),
        cornerRadiusM: parseFloat(this.customCorner.slider.value),
      };
    }
    this.onPresetChange?.(preset, customDims);
  }

  /** Get the canvas cursor style based on current tool/mode state. */
  get cursorStyle(): string {
    if (this._activeTool !== 'none' || this._paintMode !== 'off') return 'crosshair';
    if (this._lightToolActive) return 'pointer';
    return 'default';
  }
}
