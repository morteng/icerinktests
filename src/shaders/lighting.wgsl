// ================================================================
// Lighting — PBR Cook-Torrance GGX, shadows, ground illumination
// ================================================================

const PI = 3.14159265;

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

// ---- Zamboni hit test from sprite slot ----
fn zamboni_hit(px: f32, py: f32, zs: Sprite) -> vec2f {
  let dx = px - zs.x;
  let dy = py - zs.y;
  let along = dx * zs.dir;
  return vec2f(along, dy);
}

// ================================================================
// ---- Height-field shadow system ----
// ================================================================

const BOARD_HT = 14.0;       // ~1.07m dasher boards
const GLASS_HT = 22.0;       // ~1.8m glass + boards
const GOAL_FRAME_HT = 15.0;  // ~1.22m goal frame
const GOAL_NET_HT = 11.0;    // ~0.9m net mesh
const ZAMBONI_HT = 18.0;     // ~1.5m zamboni body
const TERRAIN_SCALE = 0.5;   // height exaggeration: 1mm → 0.5 cells
const SHADOW_STEPS = 16u;
const SHADOW_STEP_SZ = 2.0;

fn goal_terrain_ht_single(sx: f32, sy: f32, gs: Sprite) -> f32 {
  let st = sprite_type(gs);
  if (st != SPRITE_GOAL_LEFT && st != SPRITE_GOAL_RIGHT) { return 0.0; }

  let goal_off = gs.aux0;
  let net_hw = goal_off * 0.273;
  let net_depth = goal_off * 0.334;
  let goal_dir = gs.dir;

  let dx = (sx - gs.x) * goal_dir;
  let dy = sy - gs.y;
  let df = clamp(dx / max(net_depth, 1.0), 0.0, 1.0);
  let hw = mix(net_hw, net_hw * 0.6, df);

  if (dx >= -1.0 && dx < net_depth + 0.5 && abs(dy) <= hw) {
    let is_frame = (dx >= -1.0 && dx < 1.0 && abs(dy) > net_hw - 2.0)
               || (dx > net_depth - 1.5 && dx < net_depth + 0.5)
               || (abs(abs(dy) - hw) < 1.2 && dx >= 0.0);
    if (is_frame) { return GOAL_FRAME_HT; }
    if (dx > 0.5) { return GOAL_NET_HT; }
  }

  return 0.0;
}

fn goal_terrain_ht(sx: f32, sy: f32) -> f32 {
  let gl = read_sprite(SLOT_GOAL_LEFT);
  let h1 = goal_terrain_ht_single(sx, sy, gl);
  if (h1 > 0.0) { return h1; }

  let gr = read_sprite(SLOT_GOAL_RIGHT);
  return goal_terrain_ht_single(sx, sy, gr);
}

fn terrain_height(sx: f32, sy: f32) -> f32 {
  let sdf = rink_sdf(sx, sy);
  if (params.is_backyard == 0u) {
    if (sdf >= 0.0 && sdf < 2.5) { return BOARD_HT; }
    if (sdf >= 2.5 && sdf < 4.0) { return GLASS_HT; }
  }
  if (sdf >= 0.0) { return 0.0; }

  let ix = u32(clamp(sx, 0.0, f32(params.width - 1u)));
  let iy = u32(clamp(sy, 0.0, f32(params.height - 1u)));
  let si = iy * params.width + ix;

  if (mask[si] < 0.5) { return 0.0; }

  let zs = read_sprite(SLOT_ZAMBONI);
  let zt = sprite_type(zs);
  if (zt == SPRITE_ZAMBONI || zt == SPRITE_SHOVEL) {
    let zv = zamboni_hit(sx, sy, zs);
    if (abs(zv.y) < zs.width * 0.5 && zv.x >= 0.0 && zv.x < zs.height) {
      return ZAMBONI_HT;
    }
  }

  let gh = goal_terrain_ht(sx, sy);
  if (gh > 0.0) { return gh; }

  let s = state[si];
  return (s.y + s.z + s.w) * TERRAIN_SCALE;
}

fn shadow_for_light(px: f32, py: f32, h_self: f32, light: Light) -> f32 {
  if (!has_flag(FLAG_SHADOWS)) { return 0.0; }
  let to_light = vec2f(light.pos.x - px, light.pos.y - py);
  let h_dist = length(to_light);
  if (h_dist < 2.0) { return 0.0; }

  let dir = to_light / h_dist;
  var occ = 0.0;

  for (var step = 1u; step <= SHADOW_STEPS; step++) {
    let t = f32(step) * SHADOW_STEP_SZ;
    if (t >= h_dist) { break; }

    let sx = px + dir.x * t;
    let sy = py + dir.y * t;

    let frac = t / h_dist;
    let ray_z = h_self + frac * (light.pos.z - h_self);

    let tz = terrain_height(sx, sy);
    if (tz > ray_z) {
      // Penumbra softness proportional to occluder height excess
      let block = clamp((tz - ray_z) * 0.5, 0.0, 1.0);
      occ = max(occ, block);
      if (occ > 0.95) { break; }
    }
  }

  return occ;
}

// ================================================================
// ---- PBR BRDF Components (Cook-Torrance GGX) ----
// ================================================================

// GGX/Trowbridge-Reitz normal distribution function
// D(h) = α² / (π × ((n·h)²(α²-1)+1)²)
fn D_GGX(ndoth: f32, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + 0.0001);
}

// Schlick-GGX geometry function (single direction)
// G1(v) = n·v / (n·v × (1-k) + k)
// k = (α+1)²/8 for direct lighting (Schlick-Beckmann)
fn G_SchlickGGX(ndot: f32, k: f32) -> f32 {
  return ndot / (ndot * (1.0 - k) + k);
}

// Smith geometry function: product of two Schlick-GGX terms
fn G_Smith(ndotv: f32, ndotl: f32, alpha: f32) -> f32 {
  let k = (alpha + 1.0) * (alpha + 1.0) / 8.0;
  return G_SchlickGGX(ndotv, k) * G_SchlickGGX(ndotl, k);
}

// Schlick Fresnel approximation
fn F_Schlick(cos_theta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - cos_theta, 5.0);
}

fn F_Schlick3(cos_theta: f32, f0: vec3f) -> vec3f {
  return f0 + (1.0 - f0) * pow(1.0 - cos_theta, 5.0);
}

// Smooth windowed falloff (UE4 window function without inverse-square)
// The 1/(d²+1) inverse-square is omitted because our coordinates are in cells
// (distances ~200-400), not meters — inverse-square would give ~0.000007.
// The (1-(d/r)⁴)² window provides physically-motivated smooth cutoff at radius.
fn attenuation_ue4(dist: f32, radius: f32) -> f32 {
  let d_r = dist / max(radius, 1.0);
  let d_r2 = d_r * d_r;
  let window = clamp(1.0 - d_r2 * d_r2, 0.0, 1.0);
  return window * window;
}

// ================================================================
// ---- Per-pixel PBR lighting (Cook-Torrance + energy conservation) ----
// ================================================================

fn compute_normal(px: u32, py: u32, idx: u32) -> vec3f {
  let w = params.width;
  let h = params.height;
  let ice_c = state[idx].y;
  let ice_l = select(ice_c, state[idx - 1u].y, px > 0u);
  let ice_r = select(ice_c, state[idx + 1u].y, px < w - 1u);
  let ice_u = select(ice_c, state[idx - w].y, py > 0u);
  let ice_d = select(ice_c, state[idx + w].y, py < h - 1u);
  // Normal scale: mm height per cell. Exaggerated 12× for visibility at 1px=1cell
  // Physical: 1mm / 80mm cell = 0.0125 → ×12 = 0.15
  let scale = 0.15;
  let ddx = (ice_r - ice_l) * scale;
  let ddy = (ice_d - ice_u) * scale;
  return normalize(vec3f(-ddx, -ddy, 1.0));
}

// Main PBR lighting: Cook-Torrance GGX with energy conservation
// roughness: 0=mirror, 1=fully diffuse (ice ~0.05, scratched ~0.3, water ~0.02)
fn compute_lighting(px: u32, py: u32, idx: u32, base_color: vec3f, roughness: f32, water_depth: f32) -> vec3f {
  let normal = compute_normal(px, py, idx);
  let pos = vec3f(f32(px), f32(py), 0.0);
  let view_dir = vec3f(0.0, 0.0, 1.0);  // top-down view
  let fpx = f32(px) + 0.5;
  let fpy = f32(py) + 0.5;

  // Self height for shadow ray origin
  let h_self = (state[idx].y + state[idx].z + state[idx].w) * TERRAIN_SCALE;

  // Fresnel R0: select ice or water based on water coverage
  // Ice: n=1.31 → R0=(0.31/2.31)²=0.018
  // Water: n=1.33 → R0=(0.33/2.33)²=0.020
  let f0 = select(0.018, 0.020, water_depth > 0.3);

  // Water film smooths the surface (lerp roughness toward water's 0.02)
  let water_film = clamp(water_depth / 0.5, 0.0, 1.0);
  let alpha = mix(roughness, 0.02, water_film);
  let alpha_clamped = max(alpha, 0.01); // avoid degenerate at 0

  let ndotv = max(dot(normal, view_dir), 0.001);

  var diffuse_total = vec3f(0.0);
  var specular_total = vec3f(0.0);
  let light_count = min(params.light_count, MAX_LIGHTS);

  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - pos;
    let dist_3d = length(to_light);
    let light_dir = to_light / max(dist_3d, 0.01);
    let h_dist = length(vec2f(light.pos.x - fpx, light.pos.y - fpy));

    // UE4-style inverse-square attenuation with smooth windowed falloff
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(h_dist, light.radius);
    }

    // Height-field shadow
    let occ = shadow_for_light(fpx, fpy, h_self, light);
    atten *= (1.0 - occ * 0.85);

    let ndotl = max(dot(normal, light_dir), 0.001);
    let half_vec = normalize(light_dir + view_dir);
    let ndoth = max(dot(normal, half_vec), 0.0);
    let vdoth = max(dot(view_dir, half_vec), 0.0);

    // Cook-Torrance specular BRDF: D × G × F / (4 × n·v × n·l)
    let D = D_GGX(ndoth, alpha_clamped);
    let G = G_Smith(ndotv, ndotl, alpha_clamped);
    let F = F_Schlick(vdoth, f0);

    let spec_num = D * G * F;
    let spec_denom = 4.0 * ndotv * ndotl + 0.001;
    let spec = spec_num / spec_denom;

    // Energy conservation: diffuse attenuated by (1-F)
    let kD = 1.0 - F;

    // Accumulate: diffuse + specular (no /π — light units are arbitrary, not physical)
    diffuse_total += light.color * kD * ndotl * atten;
    specular_total += light.color * spec * ndotl * atten;
  }

  // Ambient: sky-colored hemisphere illumination
  let sky_col = get_sky_color();
  let is_outdoor = params.is_outdoor > 0u;
  // Hemisphere integration approximation: π × L_sky for diffuse
  let sky_ambient = select(
    vec3f(params.sky_brightness * 0.35 + 0.10),
    sky_col * 0.5 + vec3f(0.03),
    is_outdoor
  );

  // Ambient Fresnel at normal incidence for energy conservation
  let F_ambient = F_Schlick(ndotv, f0);
  let kD_ambient = 1.0 - F_ambient;

  var result = base_color * (sky_ambient * kD_ambient + diffuse_total) + specular_total;

  // Indoor volumetric haze (Beer-Lambert approximation of in-scattering)
  if (params.fog_density > 0.0) {
    for (var i = 0u; i < light_count; i++) {
      let light = params.lights[i];
      if (light.radius > 0.0) {
        let h_dist = length(vec2f(light.pos.x - fpx, light.pos.y - fpy));
        // In-scattering: 1 - exp(-τ × density) where τ decreases with distance
        let optical_depth = params.fog_density * exp(-h_dist * 0.01);
        let inscatter = (1.0 - exp(-optical_depth * 2.0)) * light.intensity;
        result += light.color * inscatter;
      }
    }
  }

  // Environment reflection: sample sky in reflection direction, weighted by Fresnel
  if (has_flag(FLAG_REFLECTIONS)) {
    let reflect_dir = reflect(-view_dir, normal);
    let env_color = sample_sky(reflect_dir, params.time_of_day, params.sky_brightness, params.cloud_cover, is_outdoor, params.anim_time);
    // Rougher surfaces see blurrier reflections — approximate with reduced intensity
    let env_lod = 1.0 - alpha_clamped * 0.8;
    result += env_color * F_ambient * env_lod;
  }

  return result;
}

// ---- Ground illumination (for areas outside rink) ----
fn ground_light(px: f32, py: f32) -> vec3f {
  var illum = vec3f(0.0);
  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let h_dist = length(vec2f(light.pos.x - px, light.pos.y - py));
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(h_dist, light.radius);
    } else {
      atten *= 0.4;
    }
    let occ = shadow_for_light(px, py, 0.0, light);
    atten *= (1.0 - occ * 0.7);

    illum += light.color * atten;
  }
  return illum;
}

// ---- Drop shadows from skaters (light-directed, reads sprite buffer) ----
fn compute_shadow(px: f32, py: f32) -> f32 {
  let sk_total = sprite_count();
  if (sk_total == 0u) { return 0.0; }

  let light_count = min(params.light_count, MAX_LIGHTS);

  var dom_idx = 0u;
  var dom_int = 0.0;
  for (var i = 0u; i < light_count; i++) {
    if (params.lights[i].intensity > dom_int) {
      dom_int = params.lights[i].intensity;
      dom_idx = i;
    }
  }
  if (dom_int < 0.01) { return 0.0; }
  let dom = params.lights[dom_idx];

  var shadow = 0.0;
  let sk_count = min(sk_total, 32u);
  for (var si = 0u; si < sk_count; si++) {
    let sp = read_sprite(SLOT_SKATER_BASE + si);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE) { continue; }
    let sk_x = sp.x;
    let sk_y = sp.y;
    let sdir = normalize(vec2f(sk_x - dom.pos.x, sk_y - dom.pos.y));
    let offset = sdir * 2.5 * (50.0 / max(dom.pos.z, 10.0));

    let dist = length(vec2f(px - sk_x - offset.x, py - sk_y - offset.y));
    if (dist < 4.0) {
      shadow = max(shadow, (1.0 - dist / 4.0) * 0.15);
    }
  }

  return shadow;
}

// ---- Sprite lighting: simplified diffuse for sprite pixels ----
fn sprite_light(fpx: f32, fpy: f32, base_col: vec3f) -> vec3f {
  let sky_col = get_sky_color();
  let is_outdoor = params.is_outdoor > 0u;
  let ambient = select(
    vec3f(params.sky_brightness * 0.25 + 0.04),
    sky_col * 0.35 + vec3f(0.02),
    is_outdoor
  );

  var direct = vec3f(0.0);
  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let h_dist = length(vec2f(light.pos.x - fpx, light.pos.y - fpy));
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(h_dist, light.radius);
    }
    // Assume top-down normal for sprites, so ndotl = light.pos.z / dist_3d
    let dist_3d = sqrt(h_dist * h_dist + light.pos.z * light.pos.z);
    let ndotl = max(light.pos.z / max(dist_3d, 1.0), 0.0);
    direct += light.color * ndotl * atten;
  }

  return base_col * (ambient + direct);
}
