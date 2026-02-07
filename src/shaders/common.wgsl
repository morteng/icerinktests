// ---- Light definition ----
const MAX_LIGHTS = 12u;

struct Light {
  pos: vec3f,
  intensity: f32,
  color: vec3f,
  radius: f32,
}

struct RenderParams {
  width: u32,
  height: u32,
  show_pipes: u32,
  show_markings: u32,
  cross_y: u32,
  show_cross_line: u32,
  is_backyard: u32,
  cloud_cover: f32,
  ground_r: f32,
  ground_g: f32,
  ground_b: f32,
  render_flags: u32,
  cross_x: u32,
  render_mode: u32,
  is_outdoor: u32,
  sim_time: f32,
  rink_cx: f32,
  rink_cy: f32,
  rink_hx: f32,
  rink_hy: f32,
  rink_cr: f32,
  goal_offset: f32,
  _pad22: u32,
  anim_time: f32,
  // Lighting
  time_of_day: f32,
  light_count: u32,
  sky_brightness: f32,
  fog_density: f32,
  lights: array<Light, 12>,
  // Light editor
  selected_light: i32,
  light_tool_active: u32,
  // PBR atmosphere (CPU-computed Rayleigh+Mie scattering)
  sun_dir_x: f32,
  sun_dir_y: f32,
  sun_dir_z: f32,
  sun_color_r: f32,
  sun_color_g: f32,
  sun_color_b: f32,
  sky_color_r: f32,
  sky_color_g: f32,
  sky_color_b: f32,
  // Moon
  moon_dir_x: f32,
  moon_dir_y: f32,
  moon_dir_z: f32,
  moon_phase: f32,
  // Surface ground (rink interior, distinct from surround)
  surface_ground_r: f32,
  surface_ground_g: f32,
  surface_ground_b: f32,
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

// ---- Sprite system ----
const SPRITE_NONE = 0u;
const SPRITE_SKATER_HOCKEY = 1u;
const SPRITE_SKATER_FIGURE = 2u;
const SPRITE_SKATER_PUBLIC = 3u;
const SPRITE_ZAMBONI = 4u;
const SPRITE_SHOVEL = 5u;
const SPRITE_GOAL_LEFT = 6u;
const SPRITE_GOAL_RIGHT = 7u;
const SPRITE_WATER_TANK = 8u;

const SLOT_GOAL_LEFT = 0u;
const SLOT_GOAL_RIGHT = 1u;
const SLOT_ZAMBONI = 2u;
const SLOT_SKATER_BASE = 3u;
const MAX_SPRITES = 64u;

struct Sprite {
  x: f32,
  y: f32,
  dir: f32,
  info: u32,
  width: f32,
  height: f32,
  aux0: f32,
  aux1: f32,
}

fn read_sprite(slot: u32) -> Sprite {
  let base = 4u + slot * 8u; // 4 u32 header + 8 u32 per sprite
  return Sprite(
    bitcast<f32>(sprite_data[base + 0u]),
    bitcast<f32>(sprite_data[base + 1u]),
    bitcast<f32>(sprite_data[base + 2u]),
    sprite_data[base + 3u],
    bitcast<f32>(sprite_data[base + 4u]),
    bitcast<f32>(sprite_data[base + 5u]),
    bitcast<f32>(sprite_data[base + 6u]),
    bitcast<f32>(sprite_data[base + 7u]),
  );
}

fn sprite_type(s: Sprite) -> u32 { return s.info & 0xFu; }
fn sprite_team(s: Sprite) -> u32 { return (s.info >> 4u) & 0xFu; }
fn sprite_count() -> u32 { return sprite_data[0]; }

@group(0) @binding(0) var<uniform> params: RenderParams;
@group(0) @binding(1) var<storage, read> state: array<vec4f>;
@group(0) @binding(2) var<storage, read> pipes: array<f32>;
@group(0) @binding(3) var<storage, read> markings: array<f32>;
@group(0) @binding(4) var<storage, read> mask: array<f32>;
@group(0) @binding(5) var<storage, read> sprite_data: array<u32>;
@group(0) @binding(6) var<storage, read> scratches: array<u32>;
@group(0) @binding(7) var<storage, read> particle_data: array<u32>;
// State2: vec4f per cell (snow_density kg/m³, snow_lwc 0-1, mud_amount mm, reserved)
@group(0) @binding(8) var<storage, read> state2: array<vec4f>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 6>(
    vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
    vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),
  );
  var out: VSOut;
  let p = positions[vi];
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}

// ---- Render feature flags ----
const FLAG_SHADOWS: u32      = 1u;
const FLAG_REFLECTIONS: u32  = 2u;
const FLAG_SCRATCHES: u32    = 4u;
const FLAG_SPARKLE: u32      = 8u;
const FLAG_THIN_FILM: u32    = 16u;

fn has_flag(flag: u32) -> bool {
  return (params.render_flags & flag) != 0u;
}

// ---- Temperature color map ----
fn temp_to_color(t: f32) -> vec3f {
  if (t < -8.0) {
    let s = clamp((t + 15.0) / 7.0, 0.0, 1.0);
    return mix(vec3f(0.15, 0.0, 0.3), vec3f(0.1, 0.15, 0.6), s);
  } else if (t < -2.0) {
    let s = clamp((t + 8.0) / 6.0, 0.0, 1.0);
    return mix(vec3f(0.1, 0.15, 0.6), vec3f(0.2, 0.7, 0.9), s);
  } else if (t < 0.0) {
    let s = clamp((t + 2.0) / 2.0, 0.0, 1.0);
    return mix(vec3f(0.2, 0.7, 0.9), vec3f(0.9, 0.95, 1.0), s);
  } else if (t < 5.0) {
    let s = clamp(t / 5.0, 0.0, 1.0);
    return mix(vec3f(0.9, 0.95, 1.0), vec3f(1.0, 0.85, 0.2), s);
  } else if (t < 12.0) {
    let s = clamp((t - 5.0) / 7.0, 0.0, 1.0);
    return mix(vec3f(1.0, 0.85, 0.2), vec3f(0.9, 0.4, 0.1), s);
  } else {
    let s = clamp((t - 12.0) / 8.0, 0.0, 1.0);
    return mix(vec3f(0.9, 0.4, 0.1), vec3f(0.6, 0.05, 0.05), s);
  }
}

fn marking_color(mtype: f32) -> vec3f {
  if (mtype < 1.5) { return vec3f(0.85, 0.1, 0.1); }
  if (mtype < 2.5) { return vec3f(0.1, 0.2, 0.85); }
  if (mtype < 3.5) { return vec3f(0.85, 0.1, 0.1); }
  if (mtype < 4.5) { return vec3f(0.2, 0.4, 0.85); }
  if (mtype < 5.5) { return vec3f(0.1, 0.2, 0.85); }
  if (mtype < 6.5) { return vec3f(0.85, 0.1, 0.1); }
  return vec3f(0.92, 0.92, 0.94); // white paint (type 7)
}

// ---- Analytical SDF distance from rink edge ----
fn rink_sdf(px: f32, py: f32) -> f32 {
  let dx = max(abs(px - params.rink_cx) - params.rink_hx + params.rink_cr, 0.0);
  let dy = max(abs(py - params.rink_cy) - params.rink_hy + params.rink_cr, 0.0);
  return sqrt(dx * dx + dy * dy) - params.rink_cr;
}

// ---- Hash functions ----
fn hash(x: f32, y: f32) -> f32 {
  return fract(sin(x * 127.1 + y * 311.7) * 43758.5);
}

fn hash2(x: f32, y: f32, seed: f32) -> f32 {
  return fract(sin(x * 42.7 + y * 97.3 + seed * 17.3) * 28461.7);
}

// ---- Value noise (smooth interpolated, not hash) ----
fn value_noise(x: f32, y: f32) -> f32 {
  let ix = floor(x);
  let iy = floor(y);
  let fx = x - ix;
  let fy = y - iy;
  // Smoothstep interpolation
  let ux = fx * fx * (3.0 - 2.0 * fx);
  let uy = fy * fy * (3.0 - 2.0 * fy);
  let a = hash(ix, iy);
  let b = hash(ix + 1.0, iy);
  let c = hash(ix, iy + 1.0);
  let d = hash(ix + 1.0, iy + 1.0);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

fn cloud_density(x: f32, y: f32, t: f32, cover: f32) -> f32 {
  // Two octaves of scrolling value noise
  let n1 = value_noise(x * 0.02 + t * 0.008, y * 0.02 + t * 0.003);
  let n2 = value_noise(x * 0.05 - t * 0.012, y * 0.05 + t * 0.006) * 0.4;
  let raw = n1 + n2;
  // Threshold: higher cover → lower threshold → more clouds
  let threshold = 1.0 - cover * 0.7;
  return clamp((raw - threshold) / (1.0 - threshold + 0.01), 0.0, 1.0);
}
