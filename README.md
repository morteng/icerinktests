# Ice Rink Simulator

A WebGPU-based ice rink physics simulator with realistic thermal dynamics, water physics, and resurfacing operations.

🎮 **[Try it live](https://icegame.pages.dev)** (or run locally with `npm run dev`)

## Features

- **Configurable Rinks**: NHL, Olympic, Recreational, and Backyard presets
- **GPU Physics Simulation**: Heat diffusion, phase change, water flow, and snow dynamics
- **PBR Rendering**: Physically-based rendering with atmospheric scattering
- **Resurfacing Tools**: Zamboni, shovel, and water tank machines
- **Event Scheduler**: Automated game sessions with damage and resurfacing
- **Real-time Metrics**: Ice quality tracking and cross-section visualization

## Tech Stack

- Vite + TypeScript
- Raw WebGPU API with compute shaders
- Browser-based, cross-platform

## Getting Started

```bash
npm install
npm run dev
```

Open http://localhost:5173 in a WebGPU-compatible browser (Chrome, Edge, or recent Firefox).

## Controls

- Mouse click/drag: Skate damage
- UI panels: Configure rink, environment, tools, and lighting
- View modes: Visual, Thermal, Sky View
- Save/Load: Store and restore simulation states
