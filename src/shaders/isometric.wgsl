// 3D perspective view — full PBR lighting with HDRI environment reflections

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
  _pad_a: f32,
  _pad_b: f32,
  _pad_c: f32,
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

fn cell_height(x: u32, y: u32) -> f32 {
  let idx = y * params.width + x;
  let s = state[idx];
  let cell_mm = params.cell_size * 1000.0;
  // 1:1 physical scale: mm → cell units (1 cell = cell_size_m * 1000 mm)
  var h = (s.y + s.z + s.w) / cell_mm;
  // Fence: add height for post (3.0) or plank (4.0)
  let solid = solids[idx];
  if (solid > 2.5) {
    let fence_mm = select(180.0, 220.0, solid < 3.5); // post=220mm, plank=180mm
    h += fence_mm / cell_mm;
  }
  return h;
}

fn cell_height_clamped(x: i32, y: i32) -> f32 {
  let cx = clamp(x, 0i, i32(params.width) - 1i);
  let cy = clamp(y, 0i, i32(params.height) - 1i);
  return cell_height(u32(cx), u32(cy));
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

// AgX tonemapping — better highlight handling than ACES, preserves hue
fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  let v = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  return v;
}

fn agx_tonemap(val: vec3f) -> vec3f {
  let agx_mat = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
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

// ---- Value noise + clouds (for physical sky) ----
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

// ---- HDRI environment map sampling ----
// Equirectangular mapping: direction → UV → bilinear-filtered pixel lookup
// Direction is in Y-up 3D world space

fn env_pixel(ix: u32, iy: u32) -> vec3f {
  let cx = ix % ENV_W;
  let cy = clamp(iy, 0u, ENV_H - 1u);
  return env_map[cy * ENV_W + cx].rgb;
}

fn sample_env_map(dir: vec3f) -> vec3f {
  let d = normalize(dir);

  // Equirectangular: direction → (u, v)
  // u = longitude [0,1], v = latitude [0,1] where 0=north pole (up), 1=south pole
  let u = atan2(d.z, d.x) / (2.0 * PI) + 0.5;
  let v = acos(clamp(d.y, -1.0, 1.0)) / PI;

  // Bilinear interpolation
  let fx = u * f32(ENV_W);
  let fy = v * f32(ENV_H);
  let x0 = u32(floor(fx));
  let y0 = u32(floor(fy));
  let x1 = x0 + 1u;
  let y1 = y0 + 1u;
  let dx = fract(fx);
  let dy = fract(fy);

  let c00 = env_pixel(x0, y0);
  let c10 = env_pixel(x1, y0);
  let c01 = env_pixel(x0, y1);
  let c11 = env_pixel(x1, y1);

  return mix(mix(c00, c10, dx), mix(c01, c11, dx), dy);
}

// Analytical physical sky (Rayleigh-like gradient + sun disc + animated clouds)
fn sample_sky_physical(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let up = max(d.y, 0.0);

  // Sky gradient: horizon lighter, zenith deeper blue
  let horizon = params.sky_color * 0.7 + vec3f(0.15, 0.12, 0.08);
  let zenith = params.sky_color * 1.3;
  var sky = mix(horizon, zenith, pow(up, 0.4));

  // Sun disc + glow
  let sun_dir = normalize(params.sun_dir);
  let sun_cos = dot(d, sun_dir);
  let sun_disc = smoothstep(0.9995, 0.9999, sun_cos) * 8.0;
  let sun_glow = pow(max(sun_cos, 0.0), 128.0) * 0.3;
  let sun_halo = pow(max(sun_cos, 0.0), 16.0) * 0.08;
  sky += params.sun_color * (sun_disc + sun_glow + sun_halo);

  // Animated clouds (projected onto sky dome)
  if (params.cloud_cover > 0.01 && d.y > -0.05) {
    let cloud_x = d.x / max(d.y + 0.3, 0.1) * 200.0;
    let cloud_y = d.z / max(d.y + 0.3, 0.1) * 200.0;
    let cd = cloud_density_iso(cloud_x, cloud_y, params.anim_time, params.cloud_cover);

    if (cd > 0.01) {
      // Cloud illumination: sun-facing side bright, away side dark
      let cloud_n = normalize(vec3f(
        -sin(cloud_x * 0.05) * 0.3,
        1.0,
        -sin(cloud_y * 0.05) * 0.3
      ));
      let cloud_ndotl = max(dot(cloud_n, sun_dir), 0.0);
      let direct = params.sun_color * cloud_ndotl * 0.9;
      let ambient = sky * 0.3;
      let cloud_albedo = vec3f(0.92, 0.93, 0.95);
      let cloud_lit = cloud_albedo * (direct + ambient);
      // Dark underside when thick
      let cloud_dark = cloud_lit * (0.4 + 0.6 * max(up, 0.1));
      sky = mix(sky, cloud_dark, cd * 0.9);
    }
  }

  // Below horizon: mirror sky (reflective ground plane) for nice top-down views
  if (d.y < -0.01) {
    let mirror_up = max(-d.y, 0.0);
    let m_horizon = params.sky_color * 0.7 + vec3f(0.15, 0.12, 0.08);
    let m_zenith = params.sky_color * 1.3;
    var m_sky = mix(m_horizon, m_zenith, pow(mirror_up, 0.4));
    // Mirrored clouds
    if (params.cloud_cover > 0.01) {
      let md = vec3f(d.x, -d.y, d.z);
      let mcx = md.x / max(md.y + 0.3, 0.1) * 200.0;
      let mcy = md.z / max(md.y + 0.3, 0.1) * 200.0;
      let mcd = cloud_density_iso(mcx, mcy, params.anim_time, params.cloud_cover);
      if (mcd > 0.01) {
        let mca = vec3f(0.92, 0.93, 0.95) * (params.sun_color * 0.4 + m_sky * 0.3);
        m_sky = mix(m_sky, mca, mcd * 0.7);
      }
    }
    return m_sky * 0.4; // dimmer reflected sky
  }
  return sky;
}

// Sample environment: dispatches by sky mode (skybox vs physical) and indoor/outdoor
fn sample_sky_env(dir: vec3f, is_outdoor: bool) -> vec3f {
  let is_skybox = (params.flags & 4u) != 0u;

  if (!is_outdoor) {
    // Indoor: analytical dim ceiling with overhead light glow
    let d = normalize(dir);
    let up = max(d.y, 0.0);
    let base = vec3f(0.06, 0.06, 0.08) * (params.sky_brightness * 0.5 + 0.3);
    let glow = vec3f(0.15, 0.14, 0.12) * params.sky_brightness * up * up;
    return base + glow;
  }

  if (is_skybox) {
    return sample_env_map(dir);
  }
  return sample_sky_physical(dir);
}

// UE4-style windowed attenuation
fn attenuation_ue4(dist: f32, radius: f32) -> f32 {
  let d_r = dist / max(radius, 1.0);
  let d_r2 = d_r * d_r;
  let window = clamp(1.0 - d_r2 * d_r2, 0.0, 1.0);
  return window * window;
}

// ---- Shadows ----

fn shadow_for_light(world_pos: vec3f, light_pos: vec3f) -> f32 {
  let to_light = light_pos - world_pos;
  let light_dist = length(to_light);
  if (light_dist < 1.0) { return 1.0; }
  let dir = to_light / light_dist;

  var shadow = 1.0;
  let steps = 16;
  for (var i = 1; i < steps; i++) {
    let t = f32(i) / f32(steps) * min(light_dist, 100.0);
    let sp = world_pos + dir * t;
    let sx = i32(sp.x);
    let sy = i32(sp.z);
    if (sx >= 0 && sx < i32(params.width) && sy >= 0 && sy < i32(params.height)) {
      let th = cell_height(u32(sx), u32(sy));
      if (th > sp.y + 0.1) {
        shadow = 0.3;
        break;
      }
    }
  }
  return shadow;
}

fn shadow_for_sun(world_pos: vec3f, sun_dir: vec3f) -> f32 {
  var shadow = 1.0;
  let steps = 16;
  for (var i = 1; i < steps; i++) {
    let t = f32(i) * 2.0;
    let sp = world_pos + sun_dir * t;
    let sx = i32(sp.x);
    let sy = i32(sp.z);
    if (sx >= 0 && sx < i32(params.width) && sy >= 0 && sy < i32(params.height)) {
      let th = cell_height(u32(sx), u32(sy));
      if (th > sp.y + 0.05) {
        shadow = 0.3;
        break;
      }
    }
  }
  return shadow;
}

// ---- Vertex Shader ----

@vertex
fn vs_iso(@builtin(vertex_index) vid: u32) -> VSOut {
  // Subsample to keep vertex count reasonable (~300k vertices max)
  let max_quads = 50000u;
  var subsample = 1u;
  for (var s = 2u; s <= 16u; s++) {
    if ((params.width / s) * (params.height / s) < max_quads) {
      subsample = s;
      break;
    }
  }

  let quad_idx = vid / 6u;
  let vert_in_quad = vid % 6u;
  let quads_per_row = params.width / subsample;
  let quad_x = quad_idx % quads_per_row;
  let quad_y = quad_idx / quads_per_row;

  let base_x = quad_x * subsample;
  let base_y = quad_y * subsample;

  // Two triangles per quad
  var corner = vec2u(0u, 0u);
  switch vert_in_quad {
    case 0u: { corner = vec2u(0u, 0u); }
    case 1u: { corner = vec2u(1u, 0u); }
    case 2u: { corner = vec2u(0u, 1u); }
    case 3u: { corner = vec2u(1u, 0u); }
    case 4u: { corner = vec2u(1u, 1u); }
    case 5u: { corner = vec2u(0u, 1u); }
    default: {}
  }

  let grid_x = base_x + corner.x * subsample;
  let grid_y = base_y + corner.y * subsample;

  // Per-vertex cell coordinates (clamped to grid bounds)
  let cell_x = min(grid_x, params.width - 1u);
  let cell_y = min(grid_y, params.height - 1u);

  // Per-vertex height — each corner samples its own cell
  let h = cell_height(cell_x, cell_y);

  // Normal from neighboring heights at this vertex's position
  var normal = vec3f(0.0, 1.0, 0.0);
  if (cell_x > 0u && cell_x < params.width - 1u && cell_y > 0u && cell_y < params.height - 1u) {
    let h_l = cell_height(cell_x - 1u, cell_y);
    let h_r = cell_height(cell_x + 1u, cell_y);
    let h_u = cell_height(cell_x, cell_y - 1u);
    let h_d = cell_height(cell_x, cell_y + 1u);
    let dh_dx = (h_r - h_l) * 0.5;
    let dh_dy = (h_d - h_u) * 0.5;
    normal = normalize(vec3f(-dh_dx, f32(subsample), -dh_dy));
  }

  let world_pos = vec3f(f32(grid_x), h, f32(grid_y));
  let clip_pos = camera.proj * camera.view * vec4f(world_pos, 1.0);

  var out: VSOut;
  out.clip_pos = clip_pos;
  // Per-vertex UV — interpolated across triangles for per-pixel cell lookup
  out.uv = vec2f(f32(grid_x) / f32(params.width), f32(grid_y) / f32(params.height));
  out.normal = normal;
  out.world_pos = world_pos;
  return out;
}

// ---- Fragment Shader ----

@fragment
fn fs_iso(in: VSOut) -> @location(0) vec4f {
  let cell_x = u32(in.uv.x * f32(params.width));
  let cell_y = u32(in.uv.y * f32(params.height));

  if (cell_x >= params.width || cell_y >= params.height) {
    return vec4f(0.02, 0.02, 0.04, 1.0);
  }

  let idx = cell_y * params.width + cell_x;
  let s = state[idx];
  let is_outdoor = (params.flags & 1u) != 0u;

  // ---- Material ----
  // Use mask to select surface (inside rink) vs surround (outside) ground
  let mask_val = mask[idx];
  let is_inside = mask_val > 0.5;
  let ground_type = select((params.flags >> 5u) & 3u, (params.flags >> 3u) & 3u, is_inside);
  var base_color = select(params.surround_color, params.ground_color, is_inside);
  var roughness: f32 = 0.8;
  var f0: f32 = 0.04;

  // Per-material ground properties with procedural texture
  {
    let gx = f32(cell_x);
    let gy = f32(cell_y);
    let n1 = hash(gx, gy);
    let n2 = hash(gx + 137.0, gy + 241.0);

    if (ground_type == 1u) {
      // Grass — very rough, low reflectance, blade variation
      roughness = 0.92;
      f0 = 0.02;
      let blade = hash(gx * 3.7, gy * 3.7);
      let shade = 0.75 + n1 * 0.25;         // light/dark patches
      let green_var = 0.9 + blade * 0.2;     // greener/browner blades
      base_color = base_color * vec3f(shade * 0.9, shade * green_var, shade * 0.85);
    } else if (ground_type == 2u) {
      // Gravel — rough, individual stone variation
      roughness = 0.85;
      f0 = 0.03;
      let stone_size = hash(floor(gx * 0.5), floor(gy * 0.5)); // clusters
      let brightness = 0.7 + n1 * 0.35;
      let warmth = 0.95 + n2 * 0.1;
      base_color = base_color * vec3f(brightness * warmth, brightness, brightness * 0.95);
    } else if (ground_type == 3u) {
      // Asphalt — medium-rough, aggregate sparkle, subtle variation
      roughness = 0.75;
      f0 = 0.04;
      let tar = 0.88 + n1 * 0.12;           // tar patch variation
      base_color = base_color * vec3f(tar);
      // Embedded aggregate — occasional bright specks
      if (n2 > 0.92) {
        base_color *= 1.6;
        roughness = 0.5; // aggregate is smoother than surrounding asphalt
      }
    } else {
      // Concrete — medium-rough, subtle trowel texture
      roughness = 0.65;
      f0 = 0.04;
      let trowel = 0.93 + n1 * 0.07;
      base_color = base_color * vec3f(trowel);
    }
  }

  // Save textured ground color for Beer-Lambert transmission
  let ground_textured = base_color;

  if (s.y > 0.1) {
    // Ice — Beer-Lambert absorption (matches 2D renderer)
    let ice_depth_m = s.y * 0.001; // mm → meters
    let ice_absorption = vec3f(60.0, 6.0, 1.8); // per meter — red absorbed most
    let ice_transmittance = exp(-ice_absorption * ice_depth_m);
    // Textured ground showing through ice layer
    let through_ice = ground_textured * ice_transmittance;
    // Volume scattering within ice (blue tint, increases with depth)
    let ice_scatter = vec3f(0.6, 0.8, 0.95) * (1.0 - ice_transmittance.g) * 0.5;
    base_color = through_ice + ice_scatter;

    // Damage visibility: amplify shavings effect for roughness
    let shav_thresh = 0.02 / max(params.damage_vis, 0.01);
    let damage_rough = 0.05 + min(s.w * params.damage_vis * 10.0, 1.0) * 0.35;
    roughness = select(0.05, damage_rough, s.w > shav_thresh);
    // Tint damaged areas slightly brown/grey when exaggerated
    if (s.w > shav_thresh && params.damage_vis > 1.0) {
      let tint_strength = min((params.damage_vis - 1.0) * 0.15, 0.4) * min(s.w * 5.0, 1.0);
      base_color = mix(base_color, vec3f(0.7, 0.65, 0.6), tint_strength);
    }
    f0 = 0.018;

    // Markings (depth-based visibility)
    if (params.show_markings > 0u) {
      let mt = u32(markings[idx]);
      if (mt > 0u) {
        var mc = vec3f(0.0);
        if (mt == 1u || mt == 3u || mt == 5u) { mc = vec3f(0.8, 0.1, 0.1); }
        else if (mt == 2u || mt == 4u || mt == 6u) { mc = vec3f(0.1, 0.3, 0.8); }
        else if (mt == 7u) { mc = vec3f(0.9, 0.9, 0.9); }

        let ice_mm = s.y;
        var alpha = 0.0;
        if (ice_mm >= 3.0 && ice_mm < 6.0) {
          alpha = (ice_mm - 3.0) / 3.0 * 0.5;
        } else if (ice_mm >= 6.0 && ice_mm < 10.0) {
          alpha = 0.5 + (ice_mm - 6.0) / 4.0 * 0.5;
        } else if (ice_mm >= 10.0) {
          alpha = 1.0;
        }

        // Beer-Lambert tinting of markings through ice above paint
        let depth_above = max(ice_mm - 6.0, 0.0) * 0.001;
        let tint = exp(-ice_absorption * depth_above);
        base_color = mix(base_color, mc * tint, alpha * 0.8);
      }
    }
  } else if (s.z > 0.1) {
    // Water — Beer-Lambert absorption
    let water_depth_m = s.z * 0.001;
    let water_absorption = vec3f(225.0, 30.0, 7.5); // per meter
    let water_transmittance = exp(-water_absorption * water_depth_m);
    let through_water = ground_textured * water_transmittance;
    let water_scatter = vec3f(0.1, 0.25, 0.5) * (1.0 - water_transmittance.g) * 0.4;
    base_color = through_water + water_scatter;
    roughness = 0.02;
    f0 = 0.020;
  }

  // ---- Fence material (solid lumber planks + rivets) ----
  let solid_val = solids[idx];
  var is_fence = solid_val > 2.5;
  if (is_fence) {
    let gx = f32(cell_x);
    let gy = f32(cell_y);
    let n1 = hash(gx * 1.3, gy * 1.7);
    let n2 = hash(gx + 73.0, gy + 41.0);

    if (solid_val < 3.5) {
      // Fence post — 4×4 pressure-treated lumber
      // Wood grain runs vertically (along y)
      let grain = hash(gx, floor(gy * 0.3)) * 0.12;
      let ring_noise = hash(floor(gx * 0.5) + 17.0, floor(gy * 0.5) + 31.0) * 0.08;
      base_color = vec3f(0.38 + grain, 0.28 + grain * 0.5, 0.14 + grain * 0.25);
      base_color += vec3f(ring_noise * 0.5, ring_noise * 0.3, ring_noise * 0.1); // growth rings
      // Weathered grey-brown patina
      let weather = hash(gx * 0.7 + 11.0, gy * 0.7 + 23.0);
      base_color = mix(base_color, vec3f(0.35, 0.33, 0.30), weather * 0.3);
      roughness = 0.82;
      f0 = 0.04;
    } else {
      // Fence plank — standard 2×6 or 2×8 lumber boards
      // Wood grain texture: planks run horizontally (along x), with board seams
      let board_id = floor(gy * 0.4); // each "board" is ~2.5 cells wide
      let board_color_var = hash(board_id, 7.0) * 0.15; // each board slightly different
      let grain = hash(gx * 0.8, board_id) * 0.10;
      let knot = hash(floor(gx * 0.15), board_id);

      base_color = vec3f(
        0.50 + grain + board_color_var,
        0.36 + grain * 0.7 + board_color_var * 0.6,
        0.18 + grain * 0.3 + board_color_var * 0.3
      );

      // Board seam (dark gap between planks)
      let seam_pos = fract(gy * 0.4);
      if (seam_pos < 0.08 || seam_pos > 0.92) {
        base_color *= 0.5; // dark gap between boards
      }

      // Occasional knot (dark oval)
      if (knot > 0.93) {
        base_color = vec3f(0.25, 0.18, 0.08);
        roughness = 0.9;
      }

      // Rivet/screw heads — galvanized steel dots at regular intervals
      let rivet_x = fract(gx * 0.15);
      let rivet_y = fract(gy * 0.4 + 0.2); // centered on each board
      let rivet_dist = length(vec2f(rivet_x - 0.5, rivet_y - 0.5));
      if (rivet_dist < 0.15) {
        // Galvanized screw/rivet: metallic grey
        base_color = vec3f(0.55, 0.55, 0.52) * (0.8 + n2 * 0.2);
        roughness = 0.35; // metal is smoother
        f0 = 0.5; // metallic reflectance
      } else {
        // Weathering on wood surface
        let weather = hash(gx * 0.9 + 5.0, gy * 0.9 + 13.0);
        base_color = mix(base_color, vec3f(0.40, 0.38, 0.34), weather * 0.25);
        roughness = 0.78;
        f0 = 0.04;
      }
    }
  }

  // Snow/shavings layer — density-driven subsurface scattering
  var snow_sparkle = vec3f(0.0);
  if (s.w > 0.05) {
    let pile_depth = s.w; // mm
    let s2 = state2[idx];
    let density = max(s2.x, 50.0);  // snow_density kg/m³
    let lwc = s2.y;                   // liquid water content
    let mud_amt = s2.z;               // mud contamination

    // Density-driven albedo: fresh snow (80) bright, slush (600+) dark
    let density_frac = clamp((density - 50.0) / (900.0 - 50.0), 0.0, 1.0);
    let base_albedo = mix(0.88, 0.30, density_frac);

    // Wet darkening: water fills air gaps
    var albedo = base_albedo * (1.0 - lwc * 0.4);

    // Mud tinting: brown color reduces albedo
    let mud_frac = clamp(mud_amt / 2.0, 0.0, 0.6);
    let mud_tint = mix(vec3f(1.0), vec3f(0.45, 0.35, 0.20), mud_frac);
    albedo *= (1.0 - mud_frac * 0.3);

    // Subsurface opacity: denser snow is more opaque
    let efold = mix(3.0, 0.5, density_frac); // fresh=3mm, dense=0.5mm
    let opacity = 1.0 - exp(-pile_depth / efold);
    let pile_coverage = clamp(pile_depth / 2.0, 0.0, 0.98);

    // Snow color with per-pixel grain texture + mud tint
    let grain_noise = hash(f32(cell_x), f32(cell_y));
    let snow_color = vec3f(albedo) * mud_tint * (1.0 - grain_noise * 0.08);

    // Roughness: dense/wet snow is smoother
    let snow_roughness = mix(0.7, 0.3, density_frac) * (1.0 - lwc * 0.2);

    // Blend over underlying surface
    base_color = mix(base_color, snow_color, opacity * pile_coverage);
    roughness = mix(roughness, snow_roughness, opacity * pile_coverage);
    f0 = mix(f0, 0.04, opacity * pile_coverage);

    // Crystal sparkle: only on dry, low-density snow (wet snow doesn't sparkle)
    if (pile_depth > 0.3 && lwc < 0.03 && density < 300.0) {
      let sparkle_hash = hash(f32(cell_x) + 0.31, f32(cell_y) + 0.71);
      let time_phase = fract(sparkle_hash * 7.0 + params.anim_time * 0.3);
      let sparkle_intensity = pow(sparkle_hash, 12.0) * smoothstep(0.4, 0.6, time_phase) * smoothstep(0.9, 0.7, time_phase);
      snow_sparkle = vec3f(sparkle_intensity * 2.0 * opacity);
    }
  }

  // ---- Vectors ----
  let N = normalize(in.normal);
  let V = normalize(camera.cam_pos - in.world_pos);
  let NdotV = max(dot(N, V), 0.001);

  // ---- Sun (directional) ----
  let raw_sun = params.sun_dir;
  let sun_len = length(raw_sun);
  let sun_dir = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len, sun_len > 0.001);

  var diffuse_total = vec3f(0.0);
  var specular_total = vec3f(0.0);

  let sun_NdotL = max(dot(N, sun_dir), 0.0);
  if (sun_NdotL > 0.0 && sun_len > 0.001) {
    let terrain_shadow = shadow_for_sun(in.world_pos, sun_dir);
    let sprite_shadow = sprite_cast_shadow(in.world_pos, sun_dir);
    let sun_shadow = terrain_shadow * sprite_shadow;
    let H = normalize(V + sun_dir);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);

    let D = D_GGX(NdotH, roughness);
    let G = G_Smith(NdotV, sun_NdotL, roughness);
    let F = F_Schlick(VdotH, f0);

    let spec = D * G * F / (4.0 * NdotV * sun_NdotL + 0.001);
    let kD = 1.0 - F;

    diffuse_total += params.sun_color * kD * sun_NdotL * sun_shadow;
    specular_total += params.sun_color * spec * sun_NdotL * sun_shadow;
  }

  // ---- Point lights ----
  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - in.world_pos;
    let dist = length(to_light);
    let L = to_light / max(dist, 0.01);

    let NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) { continue; }

    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(dist, light.radius);
    }

    if (atten < 0.001) { continue; }

    // Shadow
    let shadow = shadow_for_light(in.world_pos, light.pos);

    let H = normalize(V + L);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);

    let D = D_GGX(NdotH, roughness);
    let G = G_Smith(NdotV, NdotL, roughness);
    let F = F_Schlick(VdotH, f0);

    let spec = D * G * F / (4.0 * NdotV * NdotL + 0.001);
    let kD = 1.0 - F;

    diffuse_total += light.color * kD * NdotL * atten * shadow;
    specular_total += light.color * spec * NdotL * atten * shadow;
  }

  // ---- Ambient ----
  let sky_ambient = select(
    vec3f(params.sky_brightness * 0.35 + 0.10),
    max(params.sky_color * 0.5, vec3f(0.08)) + vec3f(0.03),
    is_outdoor
  );
  let F_amb = F_Schlick(NdotV, f0);
  let kD_amb = 1.0 - F_amb;

  var result = base_color * (sky_ambient * kD_amb + diffuse_total) + specular_total;

  // ---- Environment reflection (HDRI) ----
  // Reflect view vector off surface normal → sample environment
  let R = reflect(-V, N);
  var env_color = sample_sky_env(R, is_outdoor);
  // Rougher surfaces = blurrier reflections (approximate with reduced weight)
  let env_sharpness = 1.0 - roughness;
  let fresnel_weight = F_amb * env_sharpness;
  // Smooth dielectrics (ice/water) need minimum reflection visibility
  // (micro-facet models underpredict normal-incidence for perfectly smooth surfaces)
  let min_reflect = (1.0 - roughness * roughness) * 0.05;
  let env_weight = max(fresnel_weight, min_reflect);

  // Sprite reflections in ice/water — sprites appear in reflective surface
  if (s.y > 0.1 || s.z > 0.1) {
    let sprite_refl = sprite_ice_reflection(in.world_pos, R, s.y + s.z);
    if (sprite_refl.a > 0.01) {
      env_color = mix(env_color, sprite_refl.rgb, sprite_refl.a);
    }
  }

  // Energy-conserving blend: reflected light replaces diffuse, not additive
  result = mix(result, env_color, env_weight);

  // Snow crystal sparkle (additive, after reflections)
  result += snow_sparkle;

  // Exposure (2^exposure curve centered at 0)
  result *= params.exposure;

  // ACES filmic tonemapping (matches 2D renderer)
  result = agx_tonemap(result);

  return vec4f(result, 1.0);
}

// ---- Sky dome (fullscreen quad, HDRI env map) ----

struct SkyVSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) ray_dir: vec3f,
}

@vertex
fn vs_sky(@builtin(vertex_index) vid: u32) -> SkyVSOut {
  // Fullscreen triangle-strip quad (6 vertices, 2 triangles)
  var pos = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
    vec2f(-1.0,  1.0),
  );

  let p = pos[vid];

  // Unproject clip-space corners to world-space ray directions
  // Use a z value near the far plane (0.9999 in clip space for reverse-Z or standard Z)
  let clip_near = camera.inv_view_proj * vec4f(p, 0.9999, 1.0);
  let clip_cam  = camera.inv_view_proj * vec4f(p, 0.0, 1.0);
  let world_near = clip_near.xyz / clip_near.w;
  let world_cam  = clip_cam.xyz / clip_cam.w;
  let ray = normalize(world_near - world_cam);

  var out: SkyVSOut;
  // Place quad at max depth (z=0.9999 in NDC)
  out.clip_pos = vec4f(p, 0.9999, 1.0);
  out.ray_dir = ray;
  return out;
}

@fragment
fn fs_sky(in: SkyVSOut) -> @location(0) vec4f {
  let dir = normalize(in.ray_dir);
  let is_skybox = (params.flags & 4u) != 0u;
  var color = select(sample_sky_physical(dir), sample_env_map(dir), is_skybox);

  // Apply exposure
  color *= params.exposure;

  // ACES tonemapping
  color = agx_tonemap(color);

  return vec4f(color, 1.0);
}

// ===========================================================================
// ---- Billboard Sprite System ----
// ===========================================================================

struct SpriteVSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) local_uv: vec2f,
  @location(1) world_pos: vec3f,
  @location(2) @interpolate(flat) sprite_idx: u32,
}

// Billboard size in cells based on sprite type
fn sprite_billboard_size(sp: Sprite, st: u32) -> vec2f {
  let cell_m = params.cell_size;
  switch st {
    case 1u, 2u, 3u: {
      // Skaters: ~1.8m tall, ~0.6m wide
      return vec2f(0.6 / cell_m, 1.8 / cell_m);
    }
    case 4u: {
      // Zamboni: ~2.2m tall, width from sprite data
      return vec2f(max(sp.width, 10.0), 2.2 / cell_m);
    }
    case 5u: {
      // Shovel person: ~1.8m tall, ~0.8m wide
      return vec2f(0.8 / cell_m, 1.8 / cell_m);
    }
    case 6u, 7u: {
      // Goals: ~1.2m tall, width from sprite data
      return vec2f(sp.width, 1.2 / cell_m);
    }
    case 8u: {
      // Water tank: ~1.8m tall, width from sprite data
      return vec2f(max(sp.width, 8.0), 1.8 / cell_m);
    }
    default: {
      return vec2f(1.0, 1.0);
    }
  }
}

// Get ice surface height at a grid position (without fence contribution)
fn ice_surface_height(gx: f32, gy: f32) -> f32 {
  let ix = clamp(u32(gx), 0u, params.width - 1u);
  let iy = clamp(u32(gy), 0u, params.height - 1u);
  let idx = iy * params.width + ix;
  let s = state[idx];
  let cell_mm = params.cell_size * 1000.0;
  return (s.y + s.z + s.w) / cell_mm;
}

@vertex
fn vs_sprite(@builtin(vertex_index) vid: u32) -> SpriteVSOut {
  let slot = vid / 6u;
  let corner_idx = vid % 6u;

  var out: SpriteVSOut;

  // Default: degenerate triangle (invisible)
  out.clip_pos = vec4f(0.0, 0.0, 0.0, 1.0);
  out.local_uv = vec2f(0.0);
  out.world_pos = vec3f(0.0);
  out.sprite_idx = slot;

  if (slot >= MAX_SPRITES) {
    return out;
  }

  let sp = read_sprite(slot);
  let st = sprite_type(sp);

  if (st == SPRITE_NONE) {
    return out;
  }

  let size = sprite_billboard_size(sp, st);
  let half_w = size.x * 0.5;
  let full_h = size.y;

  // Quad corner: bottom-anchored
  var cx: f32 = 0.0;
  var cy: f32 = 0.0;
  switch corner_idx {
    case 0u: { cx = -1.0; cy = 0.0; }
    case 1u: { cx = 1.0;  cy = 0.0; }
    case 2u: { cx = -1.0; cy = 1.0; }
    case 3u: { cx = 1.0;  cy = 0.0; }
    case 4u: { cx = 1.0;  cy = 1.0; }
    case 5u: { cx = -1.0; cy = 1.0; }
    default: {}
  }

  // Billboard right from camera, up = world Y
  let right = camera.billboard_right;
  let up = vec3f(0.0, 1.0, 0.0);

  // Sprite center on ice surface
  let surface_h = ice_surface_height(sp.x, sp.y);
  let center = vec3f(sp.x, surface_h, sp.y);

  let world_pos = center + right * cx * half_w + up * cy * full_h;
  let clip_pos = camera.proj * camera.view * vec4f(world_pos, 1.0);

  out.clip_pos = clip_pos;
  out.local_uv = vec2f(cx * 0.5 + 0.5, cy); // [0,1] range
  out.world_pos = world_pos;
  out.sprite_idx = slot;

  return out;
}

// ---- Procedural sprite drawing functions ----

fn draw_skater_hockey(uv: vec2f, team: u32, dir: f32) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Mirror based on direction
  var lu = u;
  if (dir < 0.0) { lu = 1.0 - u; }

  // Head (circle at top)
  let head_center = vec2f(0.5, 0.85);
  let head_dist = length(vec2f(lu, v) - head_center);
  if (head_dist < 0.12) {
    // Helmet
    let helmet_color = select(vec3f(0.2, 0.3, 0.8), vec3f(0.8, 0.2, 0.2), team == 0u);
    return vec4f(helmet_color, 1.0);
  }

  // Face
  if (head_dist < 0.15) {
    return vec4f(0.85, 0.72, 0.58, 1.0);
  }

  // Jersey (torso)
  if (v > 0.45 && v < 0.78 && lu > 0.25 && lu < 0.75) {
    let jersey = select(vec3f(0.15, 0.25, 0.75), vec3f(0.75, 0.15, 0.15), team == 0u);
    // Number stripe
    if (v > 0.55 && v < 0.65 && lu > 0.35 && lu < 0.65) {
      return vec4f(jersey * 1.3, 1.0);
    }
    return vec4f(jersey, 1.0);
  }

  // Pants
  if (v > 0.2 && v <= 0.45 && lu > 0.28 && lu < 0.72) {
    return vec4f(0.15, 0.15, 0.18, 1.0);
  }

  // Legs/skates
  if (v > 0.02 && v <= 0.2 && lu > 0.3 && lu < 0.7) {
    if (v < 0.08) {
      return vec4f(0.2, 0.2, 0.22, 1.0); // skate blades
    }
    return vec4f(0.25, 0.25, 0.28, 1.0); // legs
  }

  // Stick (thin line)
  if (lu > 0.7 && lu < 0.8 && v > 0.15 && v < 0.65) {
    return vec4f(0.45, 0.35, 0.2, 1.0);
  }
  // Stick blade
  if (lu > 0.65 && lu < 0.85 && v > 0.08 && v < 0.16) {
    return vec4f(0.12, 0.12, 0.12, 1.0);
  }

  return vec4f(0.0);
}

fn draw_skater_figure(uv: vec2f, team: u32) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Head
  let head_center = vec2f(0.5, 0.87);
  let head_dist = length(vec2f(u, v) - head_center);
  if (head_dist < 0.1) {
    return vec4f(0.85, 0.72, 0.58, 1.0); // skin
  }
  // Hair
  if (head_dist < 0.14 && v > 0.87) {
    let hair_color = select(vec3f(0.15, 0.1, 0.05), vec3f(0.6, 0.35, 0.15), team > 2u);
    return vec4f(hair_color, 1.0);
  }

  // Costume (colorful based on variant)
  if (v > 0.35 && v < 0.8 && u > 0.3 && u < 0.7) {
    var costume = vec3f(0.2, 0.6, 0.8);
    if (team == 1u) { costume = vec3f(0.8, 0.2, 0.6); }
    else if (team == 2u) { costume = vec3f(0.3, 0.7, 0.3); }
    else if (team == 3u) { costume = vec3f(0.9, 0.5, 0.1); }
    // Sparkle detail
    if (fract(u * 8.0 + v * 5.0) > 0.85) {
      costume *= 1.5;
    }
    return vec4f(costume, 1.0);
  }

  // Legs
  if (v > 0.05 && v <= 0.35 && u > 0.32 && u < 0.68) {
    return vec4f(0.85, 0.72, 0.58, 1.0); // skin-colored tights
  }

  // Skates
  if (v <= 0.05 && u > 0.3 && u < 0.7) {
    return vec4f(0.9, 0.9, 0.92, 1.0); // white skates
  }

  return vec4f(0.0);
}

fn draw_skater_public(uv: vec2f, team: u32) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Head
  let head_center = vec2f(0.5, 0.86);
  let head_dist = length(vec2f(u, v) - head_center);
  if (head_dist < 0.11) {
    return vec4f(0.85, 0.72, 0.58, 1.0);
  }
  // Hat/toque
  if (v > 0.9 && u > 0.35 && u < 0.65) {
    let hat_h = hash(f32(team) + 1.0, 3.0);
    let hat_color = vec3f(hat_h, 1.0 - hat_h, 0.5);
    return vec4f(hat_color, 1.0);
  }

  // Jacket
  if (v > 0.45 && v < 0.78 && u > 0.25 && u < 0.75) {
    let jacket_h = hash(f32(team) + 5.0, 7.0);
    let jacket = vec3f(jacket_h * 0.5 + 0.2, (1.0 - jacket_h) * 0.4 + 0.2, 0.5);
    return vec4f(jacket, 1.0);
  }

  // Pants
  if (v > 0.15 && v <= 0.45 && u > 0.28 && u < 0.72) {
    return vec4f(0.2, 0.2, 0.3, 1.0); // jeans
  }

  // Skates
  if (v > 0.02 && v <= 0.15 && u > 0.3 && u < 0.7) {
    return vec4f(0.15, 0.15, 0.18, 1.0);
  }

  return vec4f(0.0);
}

fn draw_zamboni(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Body (main rectangle)
  if (v > 0.05 && v < 0.65 && u > 0.05 && u < 0.95) {
    // Cab (front upper section)
    if (v > 0.4 && u > 0.55) {
      // Windows
      if (v > 0.45 && v < 0.6 && u > 0.6 && u < 0.88) {
        return vec4f(0.3, 0.4, 0.55, 1.0); // glass
      }
      return vec4f(0.85, 0.85, 0.88, 1.0); // cab body
    }
    // Tank (rear section)
    if (u < 0.55) {
      return vec4f(0.75, 0.78, 0.82, 1.0); // metal tank
    }
    return vec4f(0.82, 0.82, 0.85, 1.0); // body
  }

  // Wheels/tracks
  if (v > 0.0 && v <= 0.08) {
    if ((u > 0.1 && u < 0.3) || (u > 0.7 && u < 0.9)) {
      return vec4f(0.1, 0.1, 0.12, 1.0);
    }
  }

  // Blade (bottom front)
  if (v > 0.0 && v < 0.06 && u > 0.3 && u < 0.7) {
    return vec4f(0.5, 0.5, 0.55, 1.0); // steel blade
  }

  // Warning stripes
  if (v > 0.62 && v < 0.68 && u > 0.05 && u < 0.95) {
    let stripe = fract(u * 8.0);
    if (stripe < 0.5) {
      return vec4f(0.9, 0.6, 0.0, 1.0); // orange
    }
    return vec4f(0.15, 0.15, 0.15, 1.0); // black
  }

  return vec4f(0.0);
}

fn draw_shovel(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Person body (similar to public skater but with shovel)
  let head_center = vec2f(0.45, 0.87);
  let head_dist = length(vec2f(u, v) - head_center);
  if (head_dist < 0.1) {
    return vec4f(0.85, 0.72, 0.58, 1.0);
  }
  // Hat
  if (v > 0.9 && u > 0.3 && u < 0.55) {
    return vec4f(0.7, 0.1, 0.1, 1.0);
  }

  // Jacket
  if (v > 0.45 && v < 0.8 && u > 0.2 && u < 0.65) {
    return vec4f(0.15, 0.35, 0.55, 1.0); // blue work jacket
  }

  // Pants
  if (v > 0.15 && v <= 0.45 && u > 0.25 && u < 0.65) {
    return vec4f(0.25, 0.22, 0.15, 1.0); // brown work pants
  }

  // Boots
  if (v <= 0.15 && v > 0.02 && u > 0.28 && u < 0.62) {
    return vec4f(0.2, 0.15, 0.1, 1.0);
  }

  // Shovel handle
  if (u > 0.6 && u < 0.68 && v > 0.2 && v < 0.75) {
    return vec4f(0.5, 0.4, 0.25, 1.0); // wooden handle
  }
  // Shovel blade
  if (u > 0.55 && u < 0.8 && v > 0.02 && v < 0.15) {
    return vec4f(0.45, 0.45, 0.5, 1.0); // metal blade
  }

  return vec4f(0.0);
}

fn draw_water_tank(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Boxy body
  if (v > 0.08 && v < 0.7 && u > 0.08 && u < 0.92) {
    // Rusty metal look
    let rust = hash(floor(u * 12.0), floor(v * 8.0));
    let base = vec3f(0.45, 0.3, 0.2) + vec3f(rust * 0.15, rust * 0.08, rust * 0.02);
    // Metal bands
    if (fract(v * 5.0) < 0.15) {
      return vec4f(base * 0.6, 1.0); // dark bands
    }
    return vec4f(base, 1.0);
  }

  // Handle/push bar
  if (v > 0.65 && v < 0.8 && u > 0.3 && u < 0.7) {
    return vec4f(0.3, 0.3, 0.32, 1.0);
  }

  // Wheels
  if (v > 0.0 && v <= 0.1) {
    if ((u > 0.1 && u < 0.3) || (u > 0.7 && u < 0.9)) {
      return vec4f(0.1, 0.1, 0.12, 1.0);
    }
  }

  // Nozzle bar at bottom
  if (v > 0.02 && v < 0.09 && u > 0.2 && u < 0.8) {
    return vec4f(0.35, 0.35, 0.4, 1.0);
  }

  return vec4f(0.0);
}

fn draw_goal(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  // Frame posts (red)
  let frame_w = 0.06;
  let is_frame = (u < frame_w || u > 1.0 - frame_w || v > 0.92);
  if (is_frame && v > 0.0) {
    return vec4f(0.85, 0.1, 0.1, 1.0); // red frame
  }

  // Net mesh (white checkerboard)
  if (u > frame_w && u < 1.0 - frame_w && v > 0.0 && v <= 0.92) {
    let grid_u = floor(u * 12.0);
    let grid_v = floor(v * 8.0);
    let checker = (u32(grid_u) + u32(grid_v)) % 2u;
    if (checker == 0u) {
      return vec4f(0.92, 0.92, 0.95, 0.7); // white mesh
    }
    return vec4f(0.0); // see-through gaps
  }

  return vec4f(0.0);
}

// ---- Sprite shadow + reflection system ----

// Ray-billboard intersection: returns vec4f(u, v, t, hit)
// u,v in [0,1], t = ray distance, hit = 1.0 if intersected
fn ray_billboard_intersect(ray_o: vec3f, ray_d: vec3f, sp: Sprite, st: u32) -> vec4f {
  let size = sprite_billboard_size(sp, st);
  let half_w = size.x * 0.5;
  let full_h = size.y;

  let right = camera.billboard_right;
  // Billboard plane normal (horizontal, facing camera)
  let fwd = vec3f(-right.z, 0.0, right.x);

  let surface_h = ice_surface_height(sp.x, sp.y);
  let base = vec3f(sp.x, surface_h, sp.y);

  // Ray-plane intersection
  let denom = dot(ray_d, fwd);
  if (abs(denom) < 0.0001) { return vec4f(0.0, 0.0, -1.0, 0.0); }

  let t = dot(base - ray_o, fwd) / denom;
  if (t < 0.01) { return vec4f(0.0, 0.0, -1.0, 0.0); }

  let hit = ray_o + ray_d * t;
  let local = hit - base;

  let lu = dot(local, right) / half_w; // [-1, 1]
  let lv = local.y / full_h; // [0, 1]

  if (lu < -1.0 || lu > 1.0 || lv < 0.0 || lv > 1.0) {
    return vec4f(0.0, 0.0, -1.0, 0.0);
  }

  let uv = vec2f(lu * 0.5 + 0.5, lv); // [0,1] range
  return vec4f(uv, t, 1.0);
}

// Rough silhouette test for shadow casting (cheaper than full draw functions)
fn sprite_silhouette(uv: vec2f, st: u32) -> bool {
  let u = uv.x;
  let v = uv.y;

  if (st >= 1u && st <= 3u) {
    // Human-shaped: wider at torso, narrow at feet and head
    let cx = abs(u - 0.5) * 2.0;
    var w = 0.5;
    if (v > 0.3 && v < 0.8) { w = 0.7; }
    else if (v > 0.8) { w = 0.4; }
    return cx < w && v > 0.02 && v < 0.95;
  }
  if (st == 4u || st == 8u) {
    // Vehicle: rectangular
    return u > 0.05 && u < 0.95 && v > 0.05 && v < 0.7;
  }
  if (st == 5u) {
    // Shovel person
    return u > 0.15 && u < 0.85 && v > 0.02 && v < 0.95;
  }
  if (st == 6u || st == 7u) {
    // Goal: frame + crossbar
    let frame_w = 0.08;
    return (u < frame_w || u > 1.0 - frame_w || v > 0.9) && v > 0.0;
  }
  return false;
}

// Check if sprites cast shadow on a world point along a light direction
fn sprite_cast_shadow(world_pos: vec3f, light_dir: vec3f) -> f32 {
  let count = min(sprite_count(), MAX_SPRITES);

  for (var i = 0u; i < count; i++) {
    let sp = read_sprite(i);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE) { continue; }

    let hit = ray_billboard_intersect(world_pos, light_dir, sp, st);
    if (hit.w > 0.5 && sprite_silhouette(hit.xy, st)) {
      return 0.35;
    }
  }
  return 1.0;
}

// Sample a sprite's drawn color at given UV (for reflections)
fn sample_sprite_color(uv: vec2f, sp: Sprite, st: u32) -> vec4f {
  switch st {
    case 1u: { return draw_skater_hockey(uv, sprite_team(sp), sp.dir); }
    case 2u: { return draw_skater_figure(uv, sprite_team(sp)); }
    case 3u: { return draw_skater_public(uv, sprite_team(sp)); }
    case 4u: { return draw_zamboni(uv); }
    case 5u: { return draw_shovel(uv); }
    case 6u, 7u: { return draw_goal(uv); }
    case 8u: { return draw_water_tank(uv); }
    default: { return vec4f(0.0); }
  }
}

// Check if a reflection ray from ice hits a sprite; returns lit reflected color
fn sprite_ice_reflection(world_pos: vec3f, R: vec3f, ice_mm: f32) -> vec4f {
  let count = min(sprite_count(), MAX_SPRITES);
  var best_t = 1e10;
  var best_color = vec4f(0.0);

  for (var i = 0u; i < count; i++) {
    let sp = read_sprite(i);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE) { continue; }

    let hit = ray_billboard_intersect(world_pos, R, sp, st);
    if (hit.w < 0.5 || hit.z > best_t) { continue; }

    let pixel = sample_sprite_color(hit.xy, sp, st);
    if (pixel.a > 0.01) {
      best_t = hit.z;
      best_color = pixel;
    }
  }

  if (best_t < 1e9) {
    // Apply basic lighting to reflected sprite image
    let sun_dir = normalize(select(vec3f(0.0, 1.0, 0.0), params.sun_dir, length(params.sun_dir) > 0.001));
    let sun_half = max(dot(vec3f(0.0, 1.0, 0.0), sun_dir), 0.0) * 0.5 + 0.5;
    let is_outdoor = (params.flags & 1u) != 0u;
    let ambient = select(vec3f(params.sky_brightness * 0.3 + 0.12), params.sky_color * 0.35 + vec3f(0.06), is_outdoor);
    let lit = best_color.rgb * (params.sun_color * sun_half * 0.5 + ambient);

    // Beer-Lambert absorption through ice (double pass: light goes down then up)
    let ice_absorption = vec3f(60.0, 6.0, 1.8);
    let absorb = exp(-ice_absorption * ice_mm * 0.002);

    // Distance-based fade
    let fade = exp(-best_t * 0.015);
    return vec4f(lit * absorb, best_color.a * fade);
  }
  return vec4f(0.0);
}

// Sprite lighting with terrain shadow reception (half-lambert for softer look)
fn sprite_light_3d(world_pos: vec3f, base_color: vec3f) -> vec3f {
  let is_outdoor = (params.flags & 1u) != 0u;

  // Sprite normal faces camera
  let N = normalize(camera.cam_pos - world_pos);

  // Sun with terrain shadow
  let raw_sun = params.sun_dir;
  let sun_len = length(raw_sun);
  let sun_dir = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len, sun_len > 0.001);
  let sun_ndotl = max(dot(N, sun_dir), 0.0);
  let sun_half = sun_ndotl * 0.5 + 0.5;
  let terrain_sun_shadow = shadow_for_sun(world_pos, sun_dir);
  var diffuse = params.sun_color * sun_half * 0.7 * terrain_sun_shadow;

  // Point lights with terrain shadows
  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - world_pos;
    let dist = length(to_light);
    let L = to_light / max(dist, 0.01);
    let ndotl = max(dot(N, L), 0.0) * 0.5 + 0.5;
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(dist, light.radius);
    }
    if (atten > 0.001) {
      let shadow = shadow_for_light(world_pos, light.pos);
      diffuse += light.color * ndotl * atten * 0.5 * shadow;
    }
  }

  // Ambient
  let ambient = select(
    vec3f(params.sky_brightness * 0.3 + 0.15),
    max(params.sky_color * 0.4, vec3f(0.1)) + vec3f(0.05),
    is_outdoor
  );

  var result = base_color * (ambient + diffuse);
  result *= params.exposure;
  result = agx_tonemap(result);
  return result;
}

@fragment
fn fs_sprite(in: SpriteVSOut) -> @location(0) vec4f {
  let slot = in.sprite_idx;
  if (slot >= MAX_SPRITES) { discard; }

  let sp = read_sprite(slot);
  let st = sprite_type(sp);
  if (st == SPRITE_NONE) { discard; }

  let uv = in.local_uv;

  var pixel = vec4f(0.0);
  switch st {
    case 1u: { pixel = draw_skater_hockey(uv, sprite_team(sp), sp.dir); }
    case 2u: { pixel = draw_skater_figure(uv, sprite_team(sp)); }
    case 3u: { pixel = draw_skater_public(uv, sprite_team(sp)); }
    case 4u: { pixel = draw_zamboni(uv); }
    case 5u: { pixel = draw_shovel(uv); }
    case 6u, 7u: { pixel = draw_goal(uv); }
    case 8u: { pixel = draw_water_tank(uv); }
    default: { discard; }
  }

  if (pixel.a < 0.01) { discard; }

  // Apply lighting
  let lit = sprite_light_3d(in.world_pos, pixel.rgb);

  return vec4f(lit, pixel.a);
}
