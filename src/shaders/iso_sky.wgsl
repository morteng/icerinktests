// Isometric 3D renderer — sky dome, HDRI environment, clouds

// ---- HDRI environment map sampling ----
fn env_pixel(ix: u32, iy: u32) -> vec3f {
  let cx = ix % ENV_W;
  let cy = clamp(iy, 0u, ENV_H - 1u);
  return env_map[cy * ENV_W + cx].rgb;
}

fn sample_env_map(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let u = atan2(d.z, d.x) / (2.0 * PI) + 0.5;
  let v = acos(clamp(d.y, -1.0, 1.0)) / PI;

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

  // Horizon warmth scales with sky brightness so it vanishes at night
  let sky_lum = dot(params.sky_color, vec3f(0.2126, 0.7152, 0.0722));
  let horizon_warmth = vec3f(0.15, 0.12, 0.08) * clamp(sky_lum * 2.0, 0.0, 1.0);
  let horizon = params.sky_color * 0.7 + horizon_warmth;
  let zenith = params.sky_color * 1.3;
  var sky = mix(horizon, zenith, pow(up, 0.4));

  let sun_dir = normalize(params.sun_dir);
  let sun_cos = dot(d, sun_dir);
  let sun_disc = smoothstep(0.9995, 0.9999, sun_cos) * 8.0;
  let sun_glow = pow(max(sun_cos, 0.0), 128.0) * 0.3;
  let sun_halo = pow(max(sun_cos, 0.0), 16.0) * 0.08;
  sky += params.sun_color * (sun_disc + sun_glow + sun_halo);

  if (params.cloud_cover > 0.01 && d.y > -0.05) {
    let cloud_x = d.x / max(d.y + 0.3, 0.1) * 200.0;
    let cloud_y = d.z / max(d.y + 0.3, 0.1) * 200.0;
    let cd = cloud_density_iso(cloud_x, cloud_y, params.anim_time, params.cloud_cover);

    if (cd > 0.01) {
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
      let cloud_dark = cloud_lit * (0.4 + 0.6 * max(up, 0.1));
      sky = mix(sky, cloud_dark, cd * 0.9);
    }
  }

  if (d.y < -0.01) {
    let mirror_up = max(-d.y, 0.0);
    let m_horizon = params.sky_color * 0.7 + horizon_warmth;
    let m_zenith = params.sky_color * 1.3;
    var m_sky = mix(m_horizon, m_zenith, pow(mirror_up, 0.4));
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
    return m_sky * 0.4;
  }
  return sky;
}

// ---- Indoor arena environment ----
fn sample_arena_env(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let brightness = params.sky_brightness;

  // Base dark arena ambient
  let arena_ambient = vec3f(0.03, 0.03, 0.04) * (brightness * 0.3 + 0.2);

  if (d.y > 0.05) {
    // === Ceiling zone ===
    // Map direction to ceiling coordinates (project onto flat ceiling plane at y=1)
    let ceil_x = d.x / d.y * 40.0;
    let ceil_z = d.z / d.y * 40.0;

    // Acoustic tile grid: rectangular pattern
    let tile_x = fract(ceil_x * 0.25);
    let tile_z = fract(ceil_z * 0.25);
    let tile_edge = step(0.02, tile_x) * step(tile_x, 0.98) * step(0.02, tile_z) * step(tile_z, 0.98);
    let tile_var = value_noise(ceil_x * 0.5, ceil_z * 0.5) * 0.08;
    let tile_color = vec3f(0.08 + tile_var, 0.08 + tile_var, 0.09 + tile_var) * tile_edge
                   + vec3f(0.03, 0.03, 0.04) * (1.0 - tile_edge); // dark grid lines

    // Roof trusses: steel beams at regular intervals
    let truss_x = abs(fract(ceil_x * 0.06 + 0.5) - 0.5);
    let truss_z = abs(fract(ceil_z * 0.06 + 0.5) - 0.5);
    let truss_min = min(truss_x, truss_z);
    let truss_mask = 1.0 - smoothstep(0.03, 0.06, truss_min);
    let truss_color = vec3f(0.12, 0.12, 0.14); // dark steel

    // Light banks: bright rectangular panels at even spacing
    let light_cell_x = fract(ceil_x * 0.12 + 0.5);
    let light_cell_z = fract(ceil_z * 0.08 + 0.5);
    let in_light_x = step(0.25, light_cell_x) * step(light_cell_x, 0.75);
    let in_light_z = step(0.30, light_cell_z) * step(light_cell_z, 0.70);
    let light_mask = in_light_x * in_light_z;
    // Light panels: warm white, intensity scales with sky_brightness
    let light_panel_color = vec3f(1.2, 1.15, 1.0) * brightness * 2.0;

    // Scoreboard: central dark rectangle
    let score_x = abs(ceil_x);
    let score_z = abs(ceil_z);
    let in_scoreboard = step(score_x, 6.0) * step(score_z, 3.0) * step(3.0, d.y * 40.0);
    let score_glow = vec3f(0.15, 0.20, 0.25) * brightness * 0.5;

    // Combine ceiling
    var ceiling = mix(tile_color, truss_color, truss_mask);
    ceiling = mix(ceiling, light_panel_color, light_mask * (1.0 - truss_mask));
    ceiling = mix(ceiling, score_glow, in_scoreboard * (1.0 - light_mask));

    // Fade to darker at horizon (looking more across than up)
    let up_factor = smoothstep(0.05, 0.4, d.y);
    return mix(arena_ambient * 1.5, ceiling, up_factor) * (brightness * 0.6 + 0.4);

  } else if (d.y > -0.15) {
    // === Upper wall / glass zone ===
    // Transition zone: glass barriers, then dark arena wall
    let wall_t = smoothstep(-0.15, 0.05, d.y);

    // Arena wall base
    let wall_color = vec3f(0.06, 0.06, 0.08);

    // Glass/railing: slightly reflective band near ice level
    let glass_band = smoothstep(-0.02, 0.0, d.y) * smoothstep(0.05, 0.02, d.y);
    let glass_color = vec3f(0.10, 0.12, 0.15) * brightness;

    // Horizontal stripe at dasher board level
    let dasher = smoothstep(-0.01, 0.0, d.y) * smoothstep(0.02, 0.01, d.y);
    let dasher_color = vec3f(0.20, 0.20, 0.22);

    var wall = mix(wall_color, glass_color, glass_band);
    wall = mix(wall, dasher_color, dasher);

    // Upper seating: warm-toned blocks above the glass
    let seat_az = atan2(d.z, d.x);
    let seat_row = fract(d.y * 12.0 + 0.5);
    let seat_col = fract(seat_az * 3.0);
    let seat_mask = step(0.0, d.y) * step(d.y, 0.05);
    let seat_variation = value_noise(seat_az * 8.0, d.y * 40.0);
    let seat_occupied = step(0.3, seat_variation); // some seats have people
    let seat_base = vec3f(0.12, 0.08, 0.06); // dark seat color
    let seat_person = vec3f(0.15, 0.12, 0.10) * (0.8 + seat_variation * 0.4);
    let seat_color = mix(seat_base, seat_person, seat_occupied);

    wall = mix(wall, seat_color, seat_mask * step(0.1, seat_row) * step(seat_row, 0.85));

    return wall * (brightness * 0.5 + 0.3);

  } else {
    // === Below ice level: dark arena floor ===
    return arena_ambient * 0.5;
  }
}

fn sample_sky_env(dir: vec3f, is_outdoor: bool) -> vec3f {
  let is_skybox = (params.flags & 4u) != 0u;

  if (!is_outdoor) {
    return sample_arena_env(dir);
  }

  if (is_skybox) {
    return sample_env_map(dir);
  }
  return sample_sky_physical(dir);
}
