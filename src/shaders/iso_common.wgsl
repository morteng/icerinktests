// Isometric 3D renderer — shared types, bindings, utilities

const MAX_LIGHTS: u32 = 12u;
const PI: f32 = 3.14159265;
const ENV_W: u32 = 1024u;
const ENV_H: u32 = 512u;

struct Light {
  pos: vec3f,
  intensity: f32,
  color: vec3f,
  radius: f32,
}

struct CameraParams {
  view: mat4x4f,
  proj: mat4x4f,
  inv_view_proj: mat4x4f,
  cam_pos: vec3f,
  _pad0: f32,
  billboard_right: vec3f,
  _pad1: f32,
}

struct Params {
  width: u32,
  height: u32,
  show_markings: u32,
  flags: u32,           // bit0=outdoor, bit1=backyard, bit2=skybox, bits3-4=surface_gt, bits5-6=surround_gt
  ground_color: vec3f,  // surface ground color (inside rink mask)
  cell_size: f32,
  sun_dir: vec3f,
  time_of_day: f32,
  sun_color: vec3f,
  sky_brightness: f32,
  sky_color: vec3f,
  fog_density: f32,
  cloud_cover: f32,
  anim_time: f32,
  light_count: u32,
  exposure: f32,
  lights: array<Light, 12>,
  surround_color: vec3f,  // surround ground color (outside rink mask)
  contrast: f32,
  saturation: f32,
  rink_cx: f32,
  rink_cy: f32,
  rink_hx: f32,
  rink_hy: f32,
  rink_cr: f32,
  goal_offset: f32,
  crowd_density: f32,
  _pad_arena: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraParams;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read> state: array<vec4f>;
@group(0) @binding(3) var<storage, read> markings: array<f32>;
@group(0) @binding(4) var<storage, read> env_map: array<vec4f>;
@group(0) @binding(5) var<storage, read> mask: array<f32>;
// State2: vec4f per cell (snow_density kg/m³, snow_lwc 0-1, mud_amount mm, reserved)
@group(0) @binding(6) var<storage, read> state2: array<vec4f>;
// Solids: f32 per cell (0=open, 1=goal frame, 2=goal net, 3=fence post, 4=fence panel)
@group(0) @binding(7) var<storage, read> solids: array<f32>;
// Sprite buffer (same format as 2D renderer)
@group(0) @binding(8) var<storage, read> sprite_data: array<u32>;
// Sprite atlas texture + sampler
@group(0) @binding(9) var sprite_atlas: texture_2d<f32>;
@group(0) @binding(10) var sprite_sampler: sampler;
// Sprite height atlas for parallax relief mapping
@group(0) @binding(11) var sprite_height_atlas: texture_2d<f32>;
// Reflection texture (sprites rendered to offscreen, sampled for ice reflections)
@group(0) @binding(12) var reflection_tex: texture_2d<f32>;
// Scratch buffer: u32 per cell — bits [0:7] dir, [8:15] density, [16:23] secondary dir
@group(0) @binding(13) var<storage, read> scratches: array<u32>;

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
  let base = 4u + slot * 8u;
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

struct VSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
  @location(2) world_pos: vec3f,
}

// ---- Height helpers ----

fn arena_height(dist: f32) -> f32 {
  let cell_mm = params.cell_size * 1000.0;
  // Uniform fence height: boards + glass are same height around entire rink
  let fence_h = 1200.0;  // ~1.2m dasher boards + glass (uniform)
  if (dist < 4.0) {
    // Boards + glass zone: smooth ramp from ice level to uniform fence height
    let ramp = smoothstep(-0.5, 2.0, dist);
    return (fence_h * ramp) / cell_mm;
  } else if (dist < 8.0) {
    // Concourse: flat walkway behind the glass, buffer before seats
    let t = (dist - 4.0) / 4.0;
    let concourse_h = 300.0;
    let h = mix(fence_h, concourse_h, smoothstep(0.0, 0.4, t));
    return h / cell_mm;
  } else {
    // Tiered seating: rises with distance — visible amphitheater steps
    let seat_dist = dist - 8.0;
    let row_pitch = 10.0;
    let row_idx = floor(seat_dist / row_pitch);
    let in_row = fract(seat_dist / row_pitch);
    let base_h = 300.0;    // concourse level
    let step_h = 400.0;    // each row rises 400mm — dramatic visible steps
    // Smooth step within each row (front of row = previous level, back = next level)
    let row_ramp = smoothstep(0.0, 0.2, in_row);
    return (base_h + (row_idx + row_ramp) * step_h) / cell_mm;
  }
}

fn cell_height(x: u32, y: u32) -> f32 {
  let idx = y * params.width + x;
  let s = state[idx];
  let cell_mm = params.cell_size * 1000.0;

  // Indoor arena: use SDF directly (not mask) to avoid discretization jaggies at corners
  if (is_indoor() && !is_backyard() && params.rink_hx > 0.0) {
    let dist = rink_sdf(f32(x) + 0.5, f32(y) + 0.5);
    if (dist >= -0.5) {
      // Smooth blend zone: SDF -0.5..0 transitions from ice height to arena height
      let ice_h = (s.y + s.z + s.w) / cell_mm;
      let arena_h = arena_height(max(dist, 0.0));
      if (dist >= 0.5) {
        return arena_h;
      }
      let blend = smoothstep(-0.5, 0.5, dist);
      return mix(ice_h, arena_h, blend);
    }
  }

  var h = (s.y + s.z + s.w) / cell_mm;
  let solid = solids[idx];
  if (solid > 2.5) {
    let fence_mm = select(180.0, 220.0, solid < 3.5);
    h += fence_mm / cell_mm;
  }
  return h;
}

fn cell_height_clamped(x: i32, y: i32) -> f32 {
  let cx = clamp(x, 0i, i32(params.width) - 1i);
  let cy = clamp(y, 0i, i32(params.height) - 1i);
  return cell_height(u32(cx), u32(cy));
}

// Surface height for HD normals: ice + water only (excludes noisy snow/fences)
fn surface_height(x: u32, y: u32) -> f32 {
  let idx = y * params.width + x;
  let s = state[idx];
  let cell_mm = params.cell_size * 1000.0;
  return (s.y + s.z) / cell_mm;
}

// ---- BRDF ----

fn F_Schlick(cosTheta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn D_GGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 0.0001);
}

fn G_Smith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = r * r / 8.0;
  let gv = NdotV / (NdotV * (1.0 - k) + k);
  let gl = NdotL / (NdotL * (1.0 - k) + k);
  return gv * gl;
}

// AgX tonemapping — Minimal implementation (Benjamin Wrensch / iolite engine)
// Better highlight rolloff than ACES: preserves hue, no washed-out whites
fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  let v = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  return v;
}

fn agx_tonemap(val: vec3f) -> vec3f {
  // sRGB → AgX log encoding
  let agx_mat = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  // AgX log → sRGB decoding
  let agx_mat_inv = mat3x3f(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
  );

  let min_ev = -12.47393;
  let max_ev = 4.026069;

  var v = agx_mat * val;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(min_ev), vec3f(max_ev));
  v = (v - min_ev) / (max_ev - min_ev);
  v = agx_contrast(v);

  // Configurable look — contrast power + saturation boost from params
  let luma = dot(v, vec3f(0.2126, 0.7152, 0.0722));
  v = pow(v, vec3f(params.contrast));
  v = vec3f(luma) + (v - vec3f(luma)) * params.saturation;

  v = agx_mat_inv * v;

  return clamp(v, vec3f(0.0), vec3f(1.0));
}

// ---- Hash / noise ----
fn hash(a: f32, b: f32) -> f32 {
  var p = vec2f(a, b);
  p = fract(p * vec2f(443.8975, 397.2973));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

fn value_noise(x: f32, y: f32) -> f32 {
  let ix = floor(x);
  let iy = floor(y);
  let fx = x - ix;
  let fy = y - iy;
  let ux = fx * fx * (3.0 - 2.0 * fx);
  let uy = fy * fy * (3.0 - 2.0 * fy);
  let a = hash(ix, iy);
  let b = hash(ix + 1.0, iy);
  let c = hash(ix, iy + 1.0);
  let d = hash(ix + 1.0, iy + 1.0);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

fn cloud_density_iso(x: f32, y: f32, t: f32, cover: f32) -> f32 {
  let n1 = value_noise(x * 0.02 + t * 0.008, y * 0.02 + t * 0.003);
  let n2 = value_noise(x * 0.05 - t * 0.012, y * 0.05 + t * 0.006) * 0.4;
  let raw = n1 + n2;
  let threshold = 1.0 - cover * 0.7;
  return clamp((raw - threshold) / (1.0 - threshold + 0.01), 0.0, 1.0);
}

// ---- Rink SDF (same as 2D common.wgsl) ----
fn rink_sdf(px: f32, py: f32) -> f32 {
  let dx = max(abs(px - params.rink_cx) - params.rink_hx + params.rink_cr, 0.0);
  let dy = max(abs(py - params.rink_cy) - params.rink_hy + params.rink_cr, 0.0);
  return sqrt(dx * dx + dy * dy) - params.rink_cr;
}

fn is_indoor() -> bool {
  return (params.flags & 1u) == 0u;
}

fn is_backyard() -> bool {
  return (params.flags & 2u) != 0u;
}
