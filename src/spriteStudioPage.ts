/**
 * Standalone entry point for the Sprite Studio page.
 * Initializes its own WebGPU device and builds the full-page sprite studio UI.
 */
import { SpriteStudioRenderer } from './spriteStudio';
import { SpriteStudioPanel } from './ui/spriteStudioPanel';

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

  const format = navigator.gpu.getPreferredCanvasFormat();
  const renderer = new SpriteStudioRenderer(device, format);
  const panel = new SpriteStudioPanel(renderer);

  document.body.appendChild(panel.el);
  panel.show();
}

main().catch(console.error);
