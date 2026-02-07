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

  let horizon = params.sky_color * 0.7 + vec3f(0.15, 0.12, 0.08);
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
    let m_horizon = params.sky_color * 0.7 + vec3f(0.15, 0.12, 0.08);
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

fn sample_sky_env(dir: vec3f, is_outdoor: bool) -> vec3f {
  let is_skybox = (params.flags & 4u) != 0u;

  if (!is_outdoor) {
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
