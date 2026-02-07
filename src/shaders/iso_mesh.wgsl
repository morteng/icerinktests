// Isometric 3D renderer — mesh vertex/fragment shaders + sky dome

// ---- Mesh Vertex Shader ----

@vertex
fn vs_iso(@builtin(vertex_index) vid: u32) -> VSOut {
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

  let cell_x = min(grid_x, params.width - 1u);
  let cell_y = min(grid_y, params.height - 1u);

  let h = cell_height(cell_x, cell_y);

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
  out.uv = vec2f(f32(grid_x) / f32(params.width), f32(grid_y) / f32(params.height));
  out.normal = normal;
  out.world_pos = world_pos;
  return out;
}

// ---- Mesh Fragment Shader ----

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
      roughness = 0.92;
      f0 = 0.02;
      let blade = hash(gx * 3.7, gy * 3.7);
      let shade = 0.75 + n1 * 0.25;
      let green_var = 0.9 + blade * 0.2;
      base_color = base_color * vec3f(shade * 0.9, shade * green_var, shade * 0.85);
    } else if (ground_type == 2u) {
      roughness = 0.85;
      f0 = 0.03;
      let stone_size = hash(floor(gx * 0.5), floor(gy * 0.5));
      let brightness = 0.7 + n1 * 0.35;
      let warmth = 0.95 + n2 * 0.1;
      base_color = base_color * vec3f(brightness * warmth, brightness, brightness * 0.95);
    } else if (ground_type == 3u) {
      roughness = 0.75;
      f0 = 0.04;
      let tar = 0.88 + n1 * 0.12;
      base_color = base_color * vec3f(tar);
      if (n2 > 0.92) {
        base_color *= 1.6;
        roughness = 0.5;
      }
    } else {
      roughness = 0.65;
      f0 = 0.04;
      let trowel = 0.93 + n1 * 0.07;
      base_color = base_color * vec3f(trowel);
    }
  }

  let ground_textured = base_color;

  if (s.y > 0.1) {
    let ice_depth_m = s.y * 0.001;
    let ice_absorption = vec3f(60.0, 6.0, 1.8);
    let ice_transmittance = exp(-ice_absorption * ice_depth_m);
    let through_ice = ground_textured * ice_transmittance;
    let ice_scatter = vec3f(0.6, 0.8, 0.95) * (1.0 - ice_transmittance.g) * 0.5;
    base_color = through_ice + ice_scatter;

    roughness = select(0.05, 0.25, s.w > 0.02);
    f0 = 0.018;

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

        let depth_above = max(ice_mm - 6.0, 0.0) * 0.001;
        let tint = exp(-ice_absorption * depth_above);
        base_color = mix(base_color, mc * tint, alpha * 0.8);
      }
    }
  } else if (s.z > 0.1) {
    let water_depth_m = s.z * 0.001;
    let water_absorption = vec3f(225.0, 30.0, 7.5);
    let water_transmittance = exp(-water_absorption * water_depth_m);
    let through_water = ground_textured * water_transmittance;
    let water_scatter = vec3f(0.1, 0.25, 0.5) * (1.0 - water_transmittance.g) * 0.4;
    base_color = through_water + water_scatter;
    roughness = 0.02;
    f0 = 0.020;
  }

  // ---- Fence material ----
  let solid_val = solids[idx];
  var is_fence = solid_val > 2.5;
  if (is_fence) {
    let gx = f32(cell_x);
    let gy = f32(cell_y);
    let n1 = hash(gx * 1.3, gy * 1.7);
    let n2 = hash(gx + 73.0, gy + 41.0);

    if (solid_val < 3.5) {
      let grain = hash(gx, floor(gy * 0.3)) * 0.12;
      let ring_noise = hash(floor(gx * 0.5) + 17.0, floor(gy * 0.5) + 31.0) * 0.08;
      base_color = vec3f(0.38 + grain, 0.28 + grain * 0.5, 0.14 + grain * 0.25);
      base_color += vec3f(ring_noise * 0.5, ring_noise * 0.3, ring_noise * 0.1);
      let weather = hash(gx * 0.7 + 11.0, gy * 0.7 + 23.0);
      base_color = mix(base_color, vec3f(0.35, 0.33, 0.30), weather * 0.3);
      roughness = 0.82;
      f0 = 0.04;
    } else {
      let board_id = floor(gy * 0.4);
      let board_color_var = hash(board_id, 7.0) * 0.15;
      let grain = hash(gx * 0.8, board_id) * 0.10;
      let knot = hash(floor(gx * 0.15), board_id);

      base_color = vec3f(
        0.50 + grain + board_color_var,
        0.36 + grain * 0.7 + board_color_var * 0.6,
        0.18 + grain * 0.3 + board_color_var * 0.3
      );

      let seam_pos = fract(gy * 0.4);
      if (seam_pos < 0.08 || seam_pos > 0.92) { base_color *= 0.5; }

      if (knot > 0.93) {
        base_color = vec3f(0.25, 0.18, 0.08);
        roughness = 0.9;
      }

      let rivet_x = fract(gx * 0.15);
      let rivet_y = fract(gy * 0.4 + 0.2);
      let rivet_dist = length(vec2f(rivet_x - 0.5, rivet_y - 0.5));
      if (rivet_dist < 0.15) {
        base_color = vec3f(0.55, 0.55, 0.52) * (0.8 + n2 * 0.2);
        roughness = 0.35;
        f0 = 0.5;
      } else {
        let weather = hash(gx * 0.9 + 5.0, gy * 0.9 + 13.0);
        base_color = mix(base_color, vec3f(0.40, 0.38, 0.34), weather * 0.25);
        roughness = 0.78;
        f0 = 0.04;
      }
    }
  }

  // Snow/shavings
  var snow_sparkle = vec3f(0.0);
  if (s.w > 0.05) {
    let pile_depth = s.w;
    let s2 = state2[idx];
    let density = max(s2.x, 50.0);
    let lwc = s2.y;
    let mud_amt = s2.z;

    let density_frac = clamp((density - 50.0) / (900.0 - 50.0), 0.0, 1.0);
    let base_albedo = mix(0.88, 0.30, density_frac);
    var albedo = base_albedo * (1.0 - lwc * 0.4);

    let mud_frac = clamp(mud_amt / 2.0, 0.0, 0.6);
    let mud_tint = mix(vec3f(1.0), vec3f(0.45, 0.35, 0.20), mud_frac);
    albedo *= (1.0 - mud_frac * 0.3);

    let efold = mix(3.0, 0.5, density_frac);
    let opacity = 1.0 - exp(-pile_depth / efold);
    let pile_coverage = clamp(pile_depth / 2.0, 0.0, 0.98);

    let grain_noise = hash(f32(cell_x), f32(cell_y));
    let snow_color = vec3f(albedo) * mud_tint * (1.0 - grain_noise * 0.08);

    let snow_roughness = mix(0.7, 0.3, density_frac) * (1.0 - lwc * 0.2);

    base_color = mix(base_color, snow_color, opacity * pile_coverage);
    roughness = mix(roughness, snow_roughness, opacity * pile_coverage);
    f0 = mix(f0, 0.04, opacity * pile_coverage);

    if (pile_depth > 0.3 && lwc < 0.03 && density < 300.0) {
      let sparkle_hash = hash(f32(cell_x) + 0.31, f32(cell_y) + 0.71);
      let time_phase = fract(sparkle_hash * 7.0 + params.anim_time * 0.3);
      let sparkle_intensity = pow(sparkle_hash, 12.0) * smoothstep(0.4, 0.6, time_phase) * smoothstep(0.9, 0.7, time_phase);
      snow_sparkle = vec3f(sparkle_intensity * 2.0 * opacity);
    }
  }

  // ---- Lighting ----
  let N = normalize(in.normal);
  let V = normalize(camera.cam_pos - in.world_pos);
  let NdotV = max(dot(N, V), 0.001);

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

  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - in.world_pos;
    let dist = length(to_light);
    let L = to_light / max(dist, 0.01);

    let NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) { continue; }

    var atten = light.intensity;
    if (light.radius > 0.0) { atten *= attenuation_ue4(dist, light.radius); }
    if (atten < 0.001) { continue; }

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

  // Ambient
  let sky_ambient = select(
    vec3f(params.sky_brightness * 0.35 + 0.10),
    max(params.sky_color * 0.5, vec3f(0.08)) + vec3f(0.03),
    is_outdoor
  );
  let F_amb = F_Schlick(NdotV, f0);
  let kD_amb = 1.0 - F_amb;

  var result = base_color * (sky_ambient * kD_amb + diffuse_total) + specular_total;

  // Environment reflection
  let R = reflect(-V, N);
  var env_color = sample_sky_env(R, is_outdoor);
  let env_sharpness = 1.0 - roughness;
  let fresnel_weight = F_amb * env_sharpness;
  let min_reflect = (1.0 - roughness * roughness) * 0.05;
  let env_weight = max(fresnel_weight, min_reflect);

  // Sprite reflections in ice/water
  if (s.y > 0.1 || s.z > 0.1) {
    let sprite_refl = sprite_ice_reflection(in.world_pos, R, s.y + s.z);
    if (sprite_refl.a > 0.01) {
      env_color = mix(env_color, sprite_refl.rgb, sprite_refl.a);
    }
  }

  result = mix(result, env_color, env_weight);
  result += snow_sparkle;
  result *= params.exposure;
  result = aces_tonemap(result);

  return vec4f(result, 1.0);
}

// ---- Sky dome ----

struct SkyVSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) ray_dir: vec3f,
}

@vertex
fn vs_sky(@builtin(vertex_index) vid: u32) -> SkyVSOut {
  var pos = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
    vec2f(-1.0,  1.0),
  );

  let p = pos[vid];

  let clip_near = camera.inv_view_proj * vec4f(p, 0.9999, 1.0);
  let clip_cam  = camera.inv_view_proj * vec4f(p, 0.0, 1.0);
  let world_near = clip_near.xyz / clip_near.w;
  let world_cam  = clip_cam.xyz / clip_cam.w;
  let ray = normalize(world_near - world_cam);

  var out: SkyVSOut;
  out.clip_pos = vec4f(p, 0.9999, 1.0);
  out.ray_dir = ray;
  return out;
}

@fragment
fn fs_sky(in: SkyVSOut) -> @location(0) vec4f {
  let dir = normalize(in.ray_dir);
  let is_skybox = (params.flags & 4u) != 0u;
  var color = select(sample_sky_physical(dir), sample_env_map(dir), is_skybox);

  color *= params.exposure;
  color = aces_tonemap(color);

  return vec4f(color, 1.0);
}
