/**
 * Environment map manager — loads HDR equirectangular images as GPU storage buffers
 * for sky rendering and reflection mapping in the 3D view.
 * Uses storage buffer (not texture) for maximum compatibility — consistent with
 * the rest of the codebase. Bilinear filtering done in shader.
 */

import { loadHDR } from './hdrLoader';

export type EnvPreset = 'clear' | 'overcast' | 'sunset' | 'night';

const ENV_URLS: Record<EnvPreset, string> = {
  clear: 'hdri/kloofendal_43d_clear_puresky_1k.hdr',
  overcast: 'hdri/kloofendal_overcast_puresky_1k.hdr',
  sunset: 'hdri/belfast_sunset_puresky_1k.hdr',
  night: 'hdri/kloppenheim_02_1k.hdr',
};

/** Approximate sun/sky lighting parameters to match each HDRI preset.
 *  Sun directions use the CPU coordinate system (Z-up). */
export interface EnvLighting {
  sunDir: [number, number, number];   // normalized, Z-up
  sunColor: [number, number, number]; // linear RGB
  skyColor: [number, number, number]; // linear RGB ambient
  skyBrightness: number;
}

const ENV_LIGHTING: Record<EnvPreset, EnvLighting> = {
  clear: {
    sunDir: [0.3, -0.15, 0.94],       // high sun, ~70° elevation
    sunColor: [1.8, 1.7, 1.5],
    skyColor: [0.25, 0.4, 0.8],
    skyBrightness: 1.0,
  },
  overcast: {
    sunDir: [0.2, -0.1, 0.97],        // diffuse, barely visible
    sunColor: [0.4, 0.4, 0.4],
    skyColor: [0.35, 0.35, 0.38],
    skyBrightness: 0.5,
  },
  sunset: {
    sunDir: [0.85, -0.2, 0.15],       // low sun, ~8° elevation
    sunColor: [2.0, 0.8, 0.25],
    skyColor: [0.4, 0.25, 0.15],
    skyBrightness: 0.4,
  },
  night: {
    sunDir: [0.0, 0.0, -1.0],         // below horizon
    sunColor: [0.0, 0.0, 0.0],
    skyColor: [0.01, 0.015, 0.03],
    skyBrightness: 0.05,
  },
};

// All Poly Haven 1k HDRIs are 1024×512 (equirectangular 2:1)
export const ENV_WIDTH = 1024;
export const ENV_HEIGHT = 512;
const PIXEL_COUNT = ENV_WIDTH * ENV_HEIGHT;
const BUFFER_SIZE = PIXEL_COUNT * 16; // vec4f per pixel = 16 bytes

export class EnvironmentMap {
  buffer: GPUBuffer;
  private device: GPUDevice;
  private currentPreset: EnvPreset | null = null;
  private loading = false;

  constructor(device: GPUDevice) {
    this.device = device;

    // Create storage buffer at full HDRI size
    this.buffer = device.createBuffer({
      size: BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Initialize with a simple procedural sky gradient
    const data = new Float32Array(PIXEL_COUNT * 4);
    for (let y = 0; y < ENV_HEIGHT; y++) {
      const elevation = 1.0 - y / ENV_HEIGHT; // 1=zenith, 0=horizon
      for (let x = 0; x < ENV_WIDTH; x++) {
        const idx = (y * ENV_WIDTH + x) * 4;
        data[idx] = 0.2 + elevation * 0.15;     // R
        data[idx + 1] = 0.35 + elevation * 0.25; // G
        data[idx + 2] = 0.6 + elevation * 0.4;   // B
        data[idx + 3] = 1.0;
      }
    }
    device.queue.writeBuffer(this.buffer, 0, data);
  }

  async load(preset: EnvPreset, basePath = ''): Promise<void> {
    if (preset === this.currentPreset || this.loading) return;
    this.loading = true;

    try {
      const url = basePath + ENV_URLS[preset];
      const hdr = await loadHDR(url);

      // Convert RGB → RGBA vec4f
      const rgba = new Float32Array(hdr.width * hdr.height * 4);
      for (let i = 0; i < hdr.width * hdr.height; i++) {
        rgba[i * 4] = hdr.data[i * 3];
        rgba[i * 4 + 1] = hdr.data[i * 3 + 1];
        rgba[i * 4 + 2] = hdr.data[i * 3 + 2];
        rgba[i * 4 + 3] = 1.0;
      }

      this.device.queue.writeBuffer(this.buffer, 0, rgba);
      this.currentPreset = preset;
    } catch (e) {
      console.warn('Failed to load env map:', preset, e);
    } finally {
      this.loading = false;
    }
  }

  /** Pick the best env preset for the current time of day */
  static presetForTime(timeOfDay: number, cloudCover: number): EnvPreset {
    if (timeOfDay < 5.5 || timeOfDay > 20.5) return 'night';
    if (timeOfDay < 7 || timeOfDay > 17.5) return 'sunset';
    if (cloudCover > 0.6) return 'overcast';
    return 'clear';
  }

  /** Get lighting parameters matching the current (or specified) HDRI preset */
  static lightingForPreset(preset: EnvPreset): EnvLighting {
    return ENV_LIGHTING[preset];
  }

  destroy() {
    this.buffer.destroy();
  }
}
