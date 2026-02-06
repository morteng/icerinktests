import { RinkPreset, GroundType, buildConfig } from './rink';
import { MarkingLayout } from './markings';
import { InteractionManager } from './interaction';
import { SceneManager } from './sceneManager';
import { Scene, SceneInputs } from './scene';
import { DEFAULT_SIM_TUNABLES_INDOOR, DEFAULT_SIM_TUNABLES_OUTDOOR } from './simulation';
import { Sidebar } from './ui/sidebar';
import { MenuBar } from './ui/menuBar';
import { StatsBar } from './ui/statsBar';
import { CrossSectionUI } from './ui/crossSectionUI';

const CS_PANEL_WIDTH = 160;
const SIDEBAR_WIDTH = 220;
const RETURN_DELTA = 3.0; // must match simulation.ts

const defaultLayoutForPreset: Record<string, MarkingLayout> = {
  nhl: 'nhl', olympic: 'olympic', recreational: 'recreational',
  backyard_small: 'none', backyard_medium: 'none', custom: 'nhl',
};

async function main() {
  const errorEl = document.getElementById('error')!;

  if (!navigator.gpu) {
    errorEl.textContent = 'WebGPU not supported. Use Chrome 113+ or Edge 113+.';
    errorEl.style.display = 'block';
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    errorEl.textContent = 'No suitable GPU adapter found.';
    errorEl.style.display = 'block';
    return;
  }

  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    console.error('GPU device lost:', info.message);
    errorEl.textContent = `GPU device lost: ${info.message}`;
    errorEl.style.display = 'block';
  });

  // --- Canvases ---
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();

  const csCanvas = document.getElementById('cross-section') as HTMLCanvasElement;
  const csCtx = csCanvas.getContext('webgpu')!;

  ctx.configure({ device, format, alphaMode: 'premultiplied' });
  csCtx.configure({ device, format, alphaMode: 'premultiplied' });

  // --- UI Modules ---
  const sidebar = new Sidebar();
  const menuBar = new MenuBar();
  const statsBar = new StatsBar();

  // Insert menu bar before app-body
  const appBody = document.getElementById('app-body')!;
  appBody.parentElement!.insertBefore(menuBar.el, appBody);

  // Insert sidebar before canvas container
  appBody.insertBefore(sidebar.el, appBody.firstChild);

  // Wire menu bar tabs → sidebar sections
  menuBar.onTabChange = (tab) => sidebar.showSection(tab);

  // Insert stats bar at bottom
  document.body.appendChild(statsBar.el);

  // Cross-section labels
  const csWrap = document.getElementById('cs-canvas-wrap')!;
  const csUI = new CrossSectionUI(csWrap, buildConfig('backyard_small'));

  // --- Interaction (singleton, lives for app lifetime) ---
  const interaction = new InteractionManager(canvas, buildConfig('backyard_small'));

  // --- Scene Manager ---
  const sceneManager = new SceneManager(device, format, interaction);

  function scene(): Scene { return sceneManager.activeScene!; }

  // --- State ---
  let cursorGridX = 0;
  let cursorGridY = 0;
  let frameCount = 0;
  let timeManual = false;
  let lightDragging = false;
  let paintMouseDown = false;
  let currentLayout: MarkingLayout = 'none';

  // FPS tracking
  let fpsTimes: number[] = [];
  let lastFps = 0;

  // --- Resize ---
  function resize() {
    const s = scene();
    if (!s) return;
    canvas.width = s.config.gridW;
    canvas.height = s.config.gridH;

    const rinkAspect = s.config.gridW / s.config.gridH;
    const maxW = window.innerWidth - CS_PANEL_WIDTH - SIDEBAR_WIDTH;
    const maxH = window.innerHeight - 80 - 34; // 34px for menu bar
    let w = maxW;
    let h = w / rinkAspect;
    if (h > maxH) {
      h = maxH;
      w = h * rinkAspect;
    }
    canvas.style.width = `${Math.floor(w)}px`;
    canvas.style.height = `${Math.floor(h)}px`;

    const dpr = window.devicePixelRatio || 1;
    const csW = CS_PANEL_WIDTH;
    const csH = Math.floor(h);
    csCanvas.width = Math.floor(csW * dpr);
    csCanvas.height = Math.floor(csH * dpr);
    csCanvas.style.width = `${csW}px`;
    csCanvas.style.height = `${csH}px`;
  }

  // --- Build new scene ---
  function rebuildScene(preset: RinkPreset, customDims?: { lengthM: number; widthM: number; cornerRadiusM: number }, groundType?: GroundType, surfaceGroundType?: GroundType) {
    sceneManager.createScene(preset, currentLayout, sidebar.ambientTemp, customDims, groundType, surfaceGroundType);
    const s = scene();
    s.scheduler.autoMode = sidebar.autoMode;
    cursorGridX = Math.floor(s.config.gridW / 2);
    cursorGridY = Math.floor(s.config.gridH / 2);
    csUI.updateConfig(s.config);
    resize();
    statsBar.updateRinkInfo(s.config, s.maskData);
    sidebar.updateVisibility(s.config);
  }

  // --- Initial build ---
  rebuildScene('backyard_small');

  // --- Sidebar callbacks ---
  sidebar.onPresetChange = (preset, customDims) => {
    const isBackyard = preset === 'backyard_small' || preset === 'backyard_medium';
    const groundType = isBackyard ? sidebar.groundType : undefined;
    const surfaceGroundType = isBackyard ? sidebar.surfaceGroundType : undefined;
    const cfg = buildConfig(preset as RinkPreset, customDims, groundType, surfaceGroundType);
    if (cfg.isBackyard) {
      sidebar.setAmbientTemp(-10);
    } else if (sidebar.ambientTemp < -20) {
      sidebar.setAmbientTemp(15);
    }
    currentLayout = defaultLayoutForPreset[preset] || 'nhl';
    sidebar.setMarkingLayout(currentLayout);
    sidebar.setAirTauDefault(cfg.isIndoor);
    rebuildScene(preset as RinkPreset, customDims, groundType, surfaceGroundType);
  };

  sidebar.onGroundTypeChange = (groundType) => {
    const s = scene();
    rebuildScene(s.config.preset, undefined, groundType, sidebar.surfaceGroundType);
  };

  sidebar.onSurfaceGroundTypeChange = (surfaceGroundType) => {
    const s = scene();
    rebuildScene(s.config.preset, undefined, sidebar.groundType, surfaceGroundType);
  };

  sidebar.onReset = () => scene().reset(sidebar.ambientTemp);
  sidebar.onPrep = () => scene().prep();
  sidebar.onFlood = () => { scene().pendingFlood = 3.0; };
  sidebar.onSnow = () => { scene().pendingSnow = 1.5; };

  sidebar.onZamboniToggle = () => {
    const s = scene();
    if (s.zamboni.active && s.machineType === 'zamboni') {
      s.zamboni.stop();
      sidebar.hideMachineControls();
    } else {
      s.switchMachine('zamboni');
      s.zamboni.start();
      sidebar.showMachineControls('zamboni');
    }
  };

  sidebar.onShovelToggle = () => {
    const s = scene();
    if (s.zamboni.active && s.machineType === 'shovel') {
      s.zamboni.stop();
      sidebar.hideMachineControls();
    } else {
      s.switchMachine('shovel');
      s.zamboni.start();
      sidebar.showMachineControls('shovel');
    }
  };

  sidebar.onWaterTankToggle = () => {
    const s = scene();
    if (s.zamboni.active && s.machineType === 'water_tank') {
      s.zamboni.stop();
      sidebar.hideMachineControls();
    } else {
      s.switchMachine('water_tank');
      s.zamboni.start();
      sidebar.showMachineControls('water_tank');
    }
  };

  sidebar.onMarkingLayoutChange = (layout) => {
    currentLayout = layout;
    scene().updateMarkings(layout);
  };

  sidebar.onSave = async (name) => {
    await sceneManager.save(name, sidebar.ambientTemp, sidebar.pipeTemp, sidebar.timeOfDay);
    sidebar.refreshSaveList(sceneManager.listSaved());
  };

  sidebar.onLoad = (name) => {
    const loaded = sceneManager.load(name);
    if (loaded) {
      cursorGridX = Math.floor(loaded.config.gridW / 2);
      cursorGridY = Math.floor(loaded.config.gridH / 2);
      csUI.updateConfig(loaded.config);
      resize();
      statsBar.updateRinkInfo(loaded.config, loaded.maskData);
      sidebar.updateVisibility(loaded.config);
    }
  };

  sidebar.onDelete = (name) => {
    sceneManager.deleteSaved(name);
    sidebar.refreshSaveList(sceneManager.listSaved());
  };

  sidebar.onTimeManual = () => { timeManual = true; };

  sidebar.onLightToolToggle = (active) => {
    const s = scene();
    if (active) {
      const evtType = (s.scheduler.autoMode && !sidebar.paused) ? s.scheduler.currentEvent.type : undefined;
      s.lightingMgr.enterManualMode(sidebar.timeOfDay, evtType);
      canvas.style.cursor = 'pointer';
    } else {
      s.lightingMgr.selectedIndex = -1;
      canvas.style.cursor = 'default';
    }
    sidebar.updateLightPanel(s.lightingMgr.getSelected(), s.lightingMgr.selectedIndex);
  };

  sidebar.onLightDelete = () => {
    const s = scene();
    if (s.lightingMgr.selectedIndex >= 0) {
      s.lightingMgr.removeLight(s.lightingMgr.selectedIndex);
      sidebar.updateLightPanel(s.lightingMgr.getSelected(), s.lightingMgr.selectedIndex);
    }
  };

  sidebar.onLightResetAuto = () => {
    scene().lightingMgr.resetToAuto();
    canvas.style.cursor = 'default';
    sidebar.updateLightPanel(null, -1);
  };

  sidebar.onLightSliderChange = () => {
    const s = scene();
    const sel = s.lightingMgr.getSelected();
    if (!sel) return;
    const ls = sidebar.lightSliderState;
    sel.intensity = ls.intensity;
    sel.z = ls.height;
    sel.radius = ls.radius;
    const hex = ls.color;
    sel.r = parseInt(hex.slice(1, 3), 16) / 255;
    sel.g = parseInt(hex.slice(3, 5), 16) / 255;
    sel.b = parseInt(hex.slice(5, 7), 16) / 255;
  };

  sidebar.refreshSaveList(sceneManager.listSaved());

  // --- Canvas helper ---
  function canvasToGrid(e: MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const s = scene();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    return [
      Math.max(0, Math.min(Math.floor(nx * s.config.gridW), s.config.gridW - 1)),
      Math.max(0, Math.min(Math.floor(ny * s.config.gridH), s.config.gridH - 1)),
    ];
  }

  // --- Paint mouse events ---
  function paintAtGrid(gx: number, gy: number) {
    const pm = sidebar.paintMode;
    const markType = pm === 'red' ? 1 : pm === 'blue' ? 2 : pm === 'white' ? 7 : 0;
    scene().paintAtGrid(gx, gy, markType);
  }

  canvas.addEventListener('mousedown', (e) => {
    // Paint mode
    if (sidebar.paintMode !== 'off') {
      paintMouseDown = true;
      const [gx, gy] = canvasToGrid(e);
      paintAtGrid(gx, gy);
      return;
    }
    // Light tool
    if (sidebar.lightToolActive) {
      const [gx, gy] = canvasToGrid(e);
      const s = scene();
      if (e.shiftKey) {
        const idx = s.lightingMgr.addLight(gx, gy);
        if (idx >= 0) {
          s.lightingMgr.selectedIndex = idx;
          sidebar.updateLightPanel(s.lightingMgr.getSelected(), s.lightingMgr.selectedIndex);
        }
        return;
      }
      const hit = s.lightingMgr.hitTest(gx, gy);
      if (hit >= 0) {
        s.lightingMgr.selectedIndex = hit;
        lightDragging = true;
      } else {
        s.lightingMgr.selectedIndex = -1;
      }
      sidebar.updateLightPanel(s.lightingMgr.getSelected(), s.lightingMgr.selectedIndex);
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    // Paint dragging
    if (paintMouseDown && sidebar.paintMode !== 'off') {
      const [gx, gy] = canvasToGrid(e);
      paintAtGrid(gx, gy);
    }
    // Light dragging
    if (sidebar.lightToolActive && lightDragging) {
      const [gx, gy] = canvasToGrid(e);
      const s = scene();
      s.lightingMgr.moveLight(s.lightingMgr.selectedIndex, gx, gy);
    }
    // Cursor tracking
    const [gx, gy] = canvasToGrid(e);
    cursorGridX = gx;
    cursorGridY = gy;
  });

  canvas.addEventListener('mouseup', () => {
    paintMouseDown = false;
    lightDragging = false;
  });
  canvas.addEventListener('mouseleave', () => {
    paintMouseDown = false;
    lightDragging = false;
  });

  // --- FPS ---
  function updateFps(now: number) {
    fpsTimes.push(now);
    while (fpsTimes.length > 0 && fpsTimes[0] < now - 1000) {
      fpsTimes.shift();
    }
    if (fpsTimes.length > 1) lastFps = fpsTimes.length;
    if (frameCount % 15 === 0) statsBar.updateFps(lastFps);
  }

  // --- Main frame loop ---
  resize();
  window.addEventListener('resize', resize);

  function frame(now: number) {
    const s = scene();
    updateFps(now);

    // Sync tool settings from sidebar to interaction
    const ts = sidebar.toolSliders;
    s.interaction.toolSettings.radius = ts.radius;
    s.interaction.toolSettings.amount = ts.amount;
    s.interaction.toolSettings.temp = ts.temp;
    s.interaction.toolSettings.pressure = ts.pressure;
    s.interaction.toolSettings.spread = ts.spread;

    // Sync damage type from sidebar to interaction
    const tool = sidebar.activeTool;
    s.interaction.damageType = tool === 'skate' ? 'hockey' : tool === 'water' ? 'water_gun' : tool === 'snow' ? 'snow_gun' : tool === 'snowball' ? 'snowball_gun' : 'none';

    // Sync machine sliders to zamboni
    if (s.zamboni.active) {
      const ms = sidebar.machineSliders;
      s.zamboni.shaveDepth = ms.shaveDepth;
      s.zamboni.waterRate = ms.waterRate;
      s.zamboni.heatTemp = ms.heatTemp;
      s.zamboni.machineSpeed = ms.speed;
    }

    // Canvas cursor
    canvas.style.cursor = sidebar.cursorStyle;

    let ambientTemp = sidebar.ambientTemp;
    const paused = sidebar.paused;
    const simSecsPerFrame = s.zamboni.active ? (1 / 60) : sidebar.simSpeed;

    // Speed display
    sidebar.setSpeedDisplay(s.zamboni.active);

    // Auto mode sync
    s.scheduler.autoMode = sidebar.autoMode;

    // Event scheduler UI updates
    if (s.scheduler.autoMode && !paused) {
      const evt = s.scheduler.currentEvent;
      ambientTemp = evt.ambient;
      sidebar.setAmbientTemp(evt.ambient);
    }

    statsBar.updateEventDisplay(
      s.scheduler.autoMode, paused,
      s.scheduler.currentEvent.name,
      s.scheduler.timeRemaining,
      s.scheduler.progressFraction,
    );

    // --- Scene update ---
    const inputs: SceneInputs = {
      ambientTemp,
      pipeTemp: sidebar.pipeTemp,
      simSecsPerFrame,
      showPipes: sidebar.showPipes,
      showMarkings: sidebar.showMarkings,
      renderMode: sidebar.renderMode,
      cursorGridX,
      cursorGridY,
      timeOfDay: sidebar.timeOfDay,
      timeManual,
      animTime: now / 1000,
      lightToolActive: sidebar.lightToolActive,
      selectedLight: s.lightingMgr.selectedIndex,
      paintMode: sidebar.paintMode,
      damageType: tool === 'skate' ? 'hockey' : tool === 'water' ? 'water_gun' : tool === 'snow' ? 'snow_gun' : tool === 'snowball' ? 'snowball_gun' : 'none',
      autoMode: s.scheduler.autoMode,
      paused,
      weatherAuto: sidebar.weatherAuto,
      cloudCoverManual: sidebar.cloudCoverManual,
      precipMode: sidebar.precipMode,
      precipIntensity: sidebar.precipIntensityVal,
      simTunables: sidebar.simTunables,
      renderFlags: sidebar.renderFlags,
    };

    const { timeOfDay } = s.update(inputs);

    // Wind display
    if (!s.config.isIndoor) {
      const wx = s.simulation.windX;
      const wy = s.simulation.windY;
      const windSpeed = Math.sqrt(wx * wx + wy * wy) * s.config.cellSize;
      const windDir = (Math.atan2(-wx, -wy) * 180 / Math.PI + 360) % 360;
      sidebar.setWindDisplay(windSpeed, windDir);
    }

    // Machine button state
    sidebar.updateMachineButtons(s.zamboni.active, s.machineType);

    // Time display
    if (!timeManual) sidebar.setTimeOfDay(timeOfDay);

    // Coolant display
    statsBar.updateCoolantDisplay(s.config.hasPipes, sidebar.pipeTemp);

    // --- Render ---
    const textureView = ctx.getCurrentTexture().createView();
    const csTextureView = csCtx.getCurrentTexture().createView();
    s.render(textureView, csTextureView, csCanvas.width, csCanvas.height);

    // --- Sim time & stats ---
    statsBar.updateSimTime(s.simTime);

    frameCount++;
    if (s.latestMetrics) statsBar.updateStats(s.latestMetrics);

    // Cross-section labels
    if (frameCount % 5 === 0) {
      const data = s.getCrossSectionData(cursorGridX, cursorGridY);
      if (data) {
        const result = csUI.update(
          data.iceMm, data.waterMm, data.shavingsMm,
          sidebar.ambientTemp, sidebar.pipeTemp,
          data.temp, data.flowPos, data.markingType,
        );
        s.lastLayout = result.layout;
        s.lastHasMarking = result.hasMarking;
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
