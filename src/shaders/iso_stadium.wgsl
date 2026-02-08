// Isometric 3D renderer — stadium geometry (boards, glass, fence)
// Renders CPU-generated box geometry with per-vertex attributes.
// Material dispatch by Y height zone and material ID for PBR appearance.

struct StadiumVSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) world_pos: vec3f,
  @location(1) world_normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) material: u32,
}

@vertex
fn vs_stadium(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) mat_id: u32,
) -> StadiumVSOut {
  var out: StadiumVSOut;
  out.world_pos = position;
  out.world_normal = normal;
  out.uv = uv;
  out.material = mat_id;
  out.clip_pos = camera.proj * camera.view * vec4f(position, 1.0);
  return out;
}

// ---- Material properties ----

struct StadiumMaterial {
  base_color: vec3f,
  roughness: f32,
  f0: f32,
  alpha: f32,
}

fn stadium_material(world_pos: vec3f, normal: vec3f, uv: vec2f, mat_id: u32) -> StadiumMaterial {
  var mat: StadiumMaterial;
  mat.alpha = 1.0;
  let cell_m = params.cell_size;

  // Height in meters above ground (Y axis is up in world space)
  let height_m = world_pos.y * cell_m;

  let gx = world_pos.x;
  let gz = world_pos.z;
  let n1 = hash(gx * 1.3, gz * 1.7);
  let n2 = hash(gx + 73.0, gz + 41.0);

  // Fence materials (backyard)
  if (mat_id == 4u) {
    // Fence post — weathered 4x4 lumber
    let grain = hash(gx, floor(gz * 0.3)) * 0.12;
    let ring_noise = hash(floor(gx * 0.5) + 17.0, floor(gz * 0.5) + 31.0) * 0.08;
    mat.base_color = vec3f(0.38 + grain, 0.28 + grain * 0.5, 0.14 + grain * 0.25);
    mat.base_color += vec3f(ring_noise * 0.5, ring_noise * 0.3, ring_noise * 0.1);
    let weather = hash(gx * 0.7 + 11.0, gz * 0.7 + 23.0);
    mat.base_color = mix(mat.base_color, vec3f(0.35, 0.33, 0.30), weather * 0.3);
    mat.roughness = 0.82;
    mat.f0 = 0.04;
    return mat;
  }

  if (mat_id == 5u) {
    // Fence plank — standard lumber
    let board_id = floor(gz * 0.4);
    let board_color_var = hash(board_id, 7.0) * 0.15;
    let grain = hash(gx * 0.8, board_id) * 0.10;
    let knot = hash(floor(gx * 0.15), board_id);

    mat.base_color = vec3f(
      0.50 + grain + board_color_var,
      0.36 + grain * 0.7 + board_color_var * 0.6,
      0.18 + grain * 0.3 + board_color_var * 0.3
    );

    let seam_pos = fract(gz * 0.4);
    if (seam_pos < 0.08 || seam_pos > 0.92) { mat.base_color *= 0.5; }

    if (knot > 0.93) {
      mat.base_color = vec3f(0.25, 0.18, 0.08);
      mat.roughness = 0.9;
    } else {
      let weather = hash(gx * 0.9 + 5.0, gz * 0.9 + 13.0);
      mat.base_color = mix(mat.base_color, vec3f(0.40, 0.38, 0.34), weather * 0.25);
      mat.roughness = 0.78;
    }

    // Screw heads
    let rivet_x = fract(gx * 0.15);
    let rivet_y = fract(gz * 0.4 + 0.2);
    let rivet_dist = length(vec2f(rivet_x - 0.5, rivet_y - 0.5));
    if (rivet_dist < 0.15) {
      mat.base_color = vec3f(0.55, 0.55, 0.52) * (0.8 + n2 * 0.2);
      mat.roughness = 0.35;
      mat.f0 = 0.5;
    } else {
      mat.f0 = 0.04;
    }
    return mat;
  }

  // Seat back — colored plastic following section color by angle
  if (mat_id == 8u) {
    // Section color based on position relative to rink center (angle)
    let sect_angle = abs(atan2(gz - params.rink_cy, gx - params.rink_cx));
    let end_blend = smoothstep(0.6, 0.85, sect_angle) * (1.0 - smoothstep(2.3, 2.55, sect_angle))
                  + smoothstep(2.55, 2.8, sect_angle);
    let corner_blend = smoothstep(1.6, 1.85, sect_angle) * (1.0 - smoothstep(2.3, 2.55, sect_angle));

    let red = vec3f(0.65, 0.10, 0.10);
    let blue = vec3f(0.10, 0.16, 0.60);
    let gold = vec3f(0.65, 0.53, 0.07);
    var seat_color = blue;
    seat_color = mix(seat_color, gold, corner_blend);
    seat_color = mix(seat_color, red, end_blend);

    // Plastic texture: slight gloss variation
    let plastic_noise = hash(floor(gx * 0.3), floor(gz * 0.3));
    mat.base_color = seat_color * (0.85 + plastic_noise * 0.15);
    mat.roughness = 0.45;
    mat.f0 = 0.06;
    return mat;
  }

  // Concourse railing — brushed aluminum
  if (mat_id == 9u) {
    let brush = hash(gx * 3.0, floor(gz * 0.1)) * 0.06;
    mat.base_color = vec3f(0.70 + brush, 0.72 + brush, 0.75 + brush);
    mat.roughness = 0.25;
    mat.f0 = 0.90; // highly metallic
    return mat;
  }

  // Zamboni tunnel walls — dark concrete interior
  if (mat_id == 10u) {
    let concrete_noise = hash(gx * 0.5, gz * 0.5) * 0.04;
    mat.base_color = vec3f(0.15 + concrete_noise, 0.14 + concrete_noise, 0.17 + concrete_noise);
    mat.roughness = 0.80;
    mat.f0 = 0.04;
    return mat;
  }

  // Goal frame — red painted steel tubing
  if (mat_id == 11u) {
    let paint_var = hash(gx * 2.0, gz * 2.0) * 0.06;
    mat.base_color = vec3f(0.82 + paint_var, 0.08 + paint_var * 0.2, 0.08 + paint_var * 0.2);
    // Subtle scuffs from pucks
    let scuff = hash(floor(gx * 1.5), floor(gz * 1.5));
    if (scuff > 0.92) {
      mat.base_color = mix(mat.base_color, vec3f(0.40, 0.38, 0.36), 0.4);
    }
    mat.roughness = 0.35;
    mat.f0 = 0.30; // painted metal
    return mat;
  }

  // Goal net — white mesh (semi-transparent)
  if (mat_id == 12u) {
    // Checkerboard mesh pattern
    let net_u = fract(gx * 0.4);
    let net_v = fract(gz * 0.4);
    let is_thread = net_u < 0.15 || net_u > 0.85 || net_v < 0.15 || net_v > 0.85;
    if (is_thread) {
      mat.base_color = vec3f(0.92, 0.92, 0.95);
      mat.roughness = 0.60;
      mat.f0 = 0.04;
      mat.alpha = 0.85;
    } else {
      // Gaps between mesh threads — mostly transparent
      mat.base_color = vec3f(0.90, 0.90, 0.93);
      mat.roughness = 0.60;
      mat.f0 = 0.04;
      mat.alpha = 0.15;
    }
    return mat;
  }

  // Door frame — dark painted metal
  if (mat_id == 6u) {
    let metal_n = hash(gx * 2.1, gz * 2.3) * 0.04;
    mat.base_color = vec3f(0.13 + metal_n, 0.13 + metal_n, 0.16 + metal_n);
    // Subtle vertical scratch marks
    let scratch = hash(floor(gx * 3.0), gz * 0.5) * 0.03;
    mat.base_color += vec3f(scratch);
    mat.roughness = 0.40;
    mat.f0 = 0.50;
    return mat;
  }

  // Scorer's table — dark surface with equipment clutter
  if (mat_id == 7u) {
    let table_n = hash(gx * 2.0, gz * 2.0);
    let panel = hash(floor(gx * 0.8), floor(gz * 0.6));
    // Dark work surface with slight color variation per panel
    mat.base_color = vec3f(
      0.07 + table_n * 0.04 + panel * 0.02,
      0.07 + table_n * 0.03 + panel * 0.015,
      0.09 + table_n * 0.04 + panel * 0.025,
    );
    // Occasional bright spot (monitor/paper)
    if (table_n > 0.92) {
      mat.base_color = vec3f(0.35, 0.38, 0.40);
    }
    mat.roughness = 0.60;
    mat.f0 = 0.04;
    return mat;
  }

  // Indoor boards/glass — determine sub-material from height
  if (height_m < 0.15) {
    // Kick plate — white metallic strip
    mat.base_color = vec3f(0.85 + n1 * 0.05, 0.85 + n1 * 0.04, 0.87 + n1 * 0.05);
    mat.roughness = 0.3;
    mat.f0 = 0.5;
  } else if (height_m < 1.07) {
    // Board wood — with bench/penalty color override
    if (mat_id == 1u) {
      // Home bench — blue
      mat.base_color = vec3f(0.12 + n1 * 0.04, 0.15 + n1 * 0.03, 0.42 + n1 * 0.06);
    } else if (mat_id == 2u) {
      // Away bench — red
      mat.base_color = vec3f(0.42 + n1 * 0.06, 0.12 + n1 * 0.04, 0.12 + n1 * 0.03);
    } else if (mat_id == 3u) {
      // Penalty box — tan
      mat.base_color = vec3f(0.38 + n1 * 0.05, 0.32 + n1 * 0.04, 0.12 + n1 * 0.03);
    } else {
      // Default boards — wood grain
      let grain = hash(gx, floor(gz * 0.3)) * 0.12;
      if (u32(gx) % 3u < 1u) {
        mat.base_color = vec3f(0.55 + grain, 0.35 + grain * 0.5, 0.18 + grain * 0.25);
      } else {
        mat.base_color = vec3f(0.38 + grain, 0.24 + grain * 0.5, 0.12 + grain * 0.25);
      }
    }
    mat.roughness = 0.75;
    mat.f0 = 0.04;
  } else if (height_m < 1.10) {
    // Dasher cap — black rubber
    mat.base_color = vec3f(0.06, 0.06, 0.07);
    mat.roughness = 0.9;
    mat.f0 = 0.04;
  } else {
    // Glass — translucent, frosted gray-blue
    let glass_t = clamp((height_m - 1.10) / (2.27 - 1.10), 0.0, 1.0);
    mat.base_color = mix(vec3f(0.7, 0.72, 0.75), vec3f(0.5, 0.52, 0.55), glass_t);
    mat.base_color += vec3f(n1 * 0.05);
    mat.roughness = 0.1;
    mat.f0 = 0.25;
    mat.alpha = 0.35; // translucent glass — see through to arena behind
  }

  return mat;
}

// ---- Fragment Shader ----

@fragment
fn fs_stadium(in: StadiumVSOut) -> @location(0) vec4f {
  let mat = stadium_material(in.world_pos, in.world_normal, in.uv, in.material);
  let N = normalize(in.world_normal);
  let is_outdoor = (params.flags & 1u) != 0u;
  let V = normalize(camera.cam_pos - in.world_pos);
  let NdotV = max(dot(N, V), 0.001);

  // Sun
  let raw_sun = params.sun_dir;
  let sun_len = length(raw_sun);
  let sun_dir = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len, sun_len > 0.001);

  var diffuse = vec3f(0.0);
  var specular = vec3f(0.0);

  let sun_NdotL = max(dot(N, sun_dir), 0.0);
  if (sun_NdotL > 0.0 && sun_len > 0.001) {
    let terrain_shadow = shadow_for_sun(in.world_pos, sun_dir);
    let H = normalize(V + sun_dir);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);
    let D = D_GGX(NdotH, mat.roughness);
    let G = G_Smith(NdotV, sun_NdotL, mat.roughness);
    let F = F_Schlick(VdotH, mat.f0);
    let spec = D * G * F / (4.0 * NdotV * sun_NdotL + 0.001);
    let kD = 1.0 - F;
    diffuse += params.sun_color * kD * sun_NdotL * terrain_shadow;
    specular += params.sun_color * spec * sun_NdotL * terrain_shadow;
  }

  // Point lights
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
    let D = D_GGX(NdotH, mat.roughness);
    let G = G_Smith(NdotV, NdotL, mat.roughness);
    let F = F_Schlick(VdotH, mat.f0);
    let spec = D * G * F / (4.0 * NdotV * NdotL + 0.001);
    let kD = 1.0 - F;
    diffuse += light.color * kD * NdotL * atten * shadow;
    specular += light.color * spec * NdotL * atten * shadow;
  }

  // Ambient
  let sky_ambient = select(
    vec3f(params.sky_brightness * 0.35 + 0.10),
    max(params.sky_color * 0.4, vec3f(0.08)) + vec3f(0.04),
    is_outdoor
  );
  let F_amb = F_Schlick(NdotV, mat.f0);
  let kD_amb = 1.0 - F_amb;

  var result = mat.base_color * (sky_ambient * kD_amb + diffuse) + specular;

  // Environment reflection for glass
  if (mat.f0 > 0.1) {
    let R = reflect(-V, N);
    let env_color = sample_sky_env(R, is_outdoor);
    let env_sharpness = 1.0 - mat.roughness;
    let fresnel_weight = F_amb * env_sharpness;
    result = mix(result, env_color, fresnel_weight);
  }

  result *= params.exposure;
  result = agx_tonemap(result);

  return vec4f(result, mat.alpha);
}
