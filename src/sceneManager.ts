import { RinkPreset, GroundType, buildConfig, RinkDimensions } from './rink';
import { MarkingLayout } from './markings';
import { InteractionManager } from './interaction';
import { Scene, SceneState } from './scene';

const STORAGE_PREFIX = 'icerink_scene_';

export class SceneManager {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private interaction: InteractionManager;
  activeScene: Scene | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat, interaction: InteractionManager) {
    this.device = device;
    this.format = format;
    this.interaction = interaction;
  }

  /** Create and switch to a new scene for the given preset. */
  createScene(
    preset: RinkPreset,
    markingLayout: MarkingLayout,
    ambientTemp: number,
    customDims?: Partial<RinkDimensions>,
    groundType?: GroundType,
    surfaceGroundType?: GroundType,
  ): Scene {
    if (this.activeScene) {
      this.activeScene.dispose();
    }

    const config = buildConfig(preset, customDims, groundType, surfaceGroundType);
    const scene = new Scene(
      this.device,
      this.format,
      config,
      this.interaction,
      markingLayout,
      ambientTemp,
    );
    this.activeScene = scene;
    return scene;
  }

  /** Dispose current scene and set a new one. */
  switchScene(scene: Scene) {
    if (this.activeScene && this.activeScene !== scene) {
      this.activeScene.dispose();
    }
    this.activeScene = scene;
  }

  /** Save current scene to localStorage. */
  async save(name: string, ambientTemp: number, pipeTemp: number, timeOfDay: number): Promise<void> {
    if (!this.activeScene) return;
    const state = await this.activeScene.getState(ambientTemp, pipeTemp, timeOfDay);

    // Convert Float32Array to base64 for JSON serialization
    const stateBytes = new Uint8Array(state.stateData.buffer);
    let binary = '';
    for (let i = 0; i < stateBytes.length; i++) {
      binary += String.fromCharCode(stateBytes[i]);
    }
    const base64 = btoa(binary);

    const serialized = {
      ...state,
      stateData: base64,
    };

    try {
      localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(serialized));
    } catch (e) {
      console.warn('Failed to save scene:', e);
    }
  }

  /** Load a scene from localStorage. */
  load(name: string): Scene | null {
    const json = localStorage.getItem(STORAGE_PREFIX + name);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);

      // Decode base64 to Float32Array
      const binary = atob(parsed.stateData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const stateData = new Float32Array(bytes.buffer);

      const state: SceneState = {
        ...parsed,
        stateData,
      };

      // Create scene from saved state
      const scene = this.createScene(
        state.preset,
        state.markingLayout,
        state.ambientTemp,
        state.customDims,
      );

      // Restore simulation state
      scene.simulation.reset(state.stateData);
      scene.simTime = state.simTime;

      // Restore machine type
      if (state.machineType) {
        scene.switchMachine(state.machineType);
      }

      // Restore scheduler
      scene.scheduler.autoMode = state.schedulerState.autoMode;

      // Restore lighting
      if (state.lightingMode === 'manual' && state.manualLights) {
        scene.lightingMgr.enterManualMode(state.timeOfDay);
        scene.lightingMgr.manualLights = state.manualLights.map(l => ({ ...l }));
      }

      return scene;
    } catch (e) {
      console.warn('Failed to load scene:', e);
      return null;
    }
  }

  /** List all saved scene names. */
  listSaved(): string[] {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        names.push(key.slice(STORAGE_PREFIX.length));
      }
    }
    return names.sort();
  }

  /** Delete a saved scene. */
  deleteSaved(name: string) {
    localStorage.removeItem(STORAGE_PREFIX + name);
  }

  /** Dispose the active scene. */
  dispose() {
    if (this.activeScene) {
      this.activeScene.dispose();
      this.activeScene = null;
    }
  }
}
