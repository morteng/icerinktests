// ================================================================
// PBR Atmosphere — sun/sky accessors, phase functions, sky dome
// ================================================================

// PBR accessors — sun/sky colors precomputed on CPU via Rayleigh+Mie atmospheric scattering
fn get_sun_dir() -> vec3f {
  return normalize(vec3f(params.sun_dir_x, params.sun_dir_y, params.sun_dir_z));
}

fn get_sun_color() -> vec3f {
  return vec3f(params.sun_color_r, params.sun_color_g, params.sun_color_b);
}

fn get_sky_color() -> vec3f {
  return vec3f(params.sky_color_r, params.sky_color_g, params.sky_color_b);
}

fn get_moon_dir() -> vec3f {
  return normalize(vec3f(params.moon_dir_x, params.moon_dir_y, params.moon_dir_z));
}

// Henyey-Greenstein phase function (Mie forward scattering)
fn hg_phase(cos_theta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cos_theta;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
}

// Rayleigh phase function
fn rayleigh_phase(cos_theta: f32) -> f32 {
  return 0.75 * (1.0 + cos_theta * cos_theta);
}

// ================================================================
// Full PBR sky dome — Rayleigh+Mie scattering, sun, moon, stars, clouds
// ================================================================

// Zenith optical depths (β × scale_height)
const TAU_R_ZENITH = vec3f(0.049, 0.113, 0.278);  // Rayleigh [R,G,B]
const TAU_M_ZENITH = 0.025;                         // Mie (wavelength-independent)

// Per-pixel air mass approximation for view ray
fn view_air_mass(view_el: f32) -> f32 {
  let el = max(view_el, 0.001);
  // Simplified Kasten-Young for shader
  return min(1.0 / (el + 0.15 * pow(el * 57.3 + 3.885, -1.253)), 38.0);
}

// Star field: stable hash-based stars with magnitude variation and twinkling
fn star_field(view: vec3f, anim_t: f32) -> vec3f {
  // Quantize direction to angular cells (~0.3° per cell)
  let scale = 300.0;
  let cx = floor(view.x * scale);
  let cy = floor(view.y * scale);
  let cz = floor(view.z * scale);
  let cell_hash = hash(cx + cz * 37.0, cy + cz * 53.0);

  // ~0.4% of cells have stars
  if (cell_hash > 0.996) {
    // Star magnitude: most are dim, few are bright (power law)
    let mag = hash(cx * 3.1 + cz, cy * 7.3 - cz);
    let brightness = pow(mag, 4.0) * 1.2;
    // Twinkling: atmospheric scintillation
    let twinkle = sin(anim_t * (1.5 + cell_hash * 4.0) + cell_hash * 100.0) * 0.25 + 0.75;
    // Star color temperature variation (B-V index)
    let temp_hash = hash(cx * 11.0, cy * 13.0);
    var star_col = vec3f(1.0);
    if (temp_hash < 0.2) {
      star_col = vec3f(0.7, 0.8, 1.0);   // hot blue star
    } else if (temp_hash > 0.85) {
      star_col = vec3f(1.0, 0.85, 0.6);  // cool red giant
    }
    return star_col * brightness * twinkle;
  }
  return vec3f(0.0);
}

// Moon rendering with phase and earthshine
fn render_moon(view: vec3f, moon_dir: vec3f, sun_dir: vec3f, phase: f32) -> vec3f {
  let moon_dot = dot(view, moon_dir);
  let moon_angular_radius = 0.0045; // ~0.26° in radians → cos threshold
  let moon_cos_edge = cos(moon_angular_radius);

  if (moon_dot < moon_cos_edge) {
    return vec3f(0.0);
  }

  // Moon disc coordinate system
  let angular_dist = acos(clamp(moon_dot, -1.0, 1.0));
  let r = angular_dist / moon_angular_radius; // 0 at center, 1 at edge

  if (r > 1.0) { return vec3f(0.0); }

  // Limb darkening (less pronounced than sun)
  let limb = 1.0 - 0.3 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));

  // Phase illumination: fraction of moon face lit by sun
  // Direction from moon to sun projected onto moon disc
  let moon_to_sun = normalize(sun_dir - moon_dir * dot(sun_dir, moon_dir));
  // Local coordinate on moon disc
  let up_vec = vec3f(0.0, 0.0, 1.0);
  let moon_right = normalize(cross(moon_dir, up_vec));
  let moon_up = cross(moon_right, moon_dir);
  let local_x = dot(view - moon_dir * moon_dot, moon_right);
  let local_y = dot(view - moon_dir * moon_dot, moon_up);

  // Phase terminator: x coordinate where lit/dark boundary falls
  // phase 0 = new (all dark), 0.5 = full (all lit), 1.0 = new
  let phase_angle = phase * 2.0 * 3.14159265;
  let terminator = cos(phase_angle);
  let local_r = sqrt(local_x * local_x + local_y * local_y);
  let norm_x = local_x / max(local_r, 0.0001) * r;

  // Illuminated fraction based on terminator position
  let lit = smoothstep(-0.05, 0.05, norm_x * terminator + (1.0 - 2.0 * abs(phase - 0.5)));

  // Moon surface color: gray-white with slight warm tint
  let moon_base = vec3f(0.75, 0.73, 0.70);

  // Earthshine: faint blue illumination on dark side
  let earthshine = vec3f(0.02, 0.03, 0.05) * (1.0 - lit);

  return (moon_base * lit * limb + earthshine) * 0.35;
}

// Sun disc with limb darkening
fn render_sun(view: vec3f, sun_dir: vec3f, sun_col: vec3f) -> vec3f {
  let cos_theta = dot(view, sun_dir);
  let sun_angular_radius = 0.00465; // ~0.267° in radians
  let sun_cos_edge = cos(sun_angular_radius);

  if (cos_theta < sun_cos_edge) {
    return vec3f(0.0);
  }

  let angular_dist = acos(clamp(cos_theta, -1.0, 1.0));
  let r = angular_dist / sun_angular_radius;

  // Limb darkening: I(r) = I₀ × (1 - u(1 - √(1-r²)))
  // Solar limb darkening coefficient u ≈ 0.6
  let mu = sqrt(max(1.0 - r * r, 0.0));
  let limb = 1.0 - 0.6 * (1.0 - mu);

  return sun_col * limb * 5.0;
}

// Sample sky color for a given 3D view direction
fn sample_sky(dir: vec3f, tod: f32, sky_bright: f32, cover: f32, outdoor: bool, anim_t: f32) -> vec3f {
  // Indoor: ceiling illuminated by arena lights
  if (!outdoor) {
    return vec3f(0.08, 0.08, 0.10) * (sky_bright * 0.5 + 0.3);
  }

  let view = normalize(dir);
  let sun_dir = get_sun_dir();
  let sun_col = get_sun_color();
  let sky_base = get_sky_color();
  let sun_lum = dot(sun_col, vec3f(0.2126, 0.7152, 0.0722));
  let view_el = max(view.z, 0.0);
  let cos_theta = dot(view, sun_dir);

  // === Per-pixel Rayleigh + Mie scattering ===
  // Air mass along this view direction
  let am = view_air_mass(max(view_el, 0.02));

  // Optical depth along view ray
  let tau_r = TAU_R_ZENITH * am;
  let tau_m = TAU_M_ZENITH * am;

  // In-scattering: fraction of sunlight scattered into view ray
  let inscatter_r = 1.0 - exp(-tau_r);
  let inscatter_m = 1.0 - exp(-tau_m);

  // Zenith in-scattering (reference point — sky_base matches this)
  let zenith_inscatter_r = 1.0 - exp(-TAU_R_ZENITH);

  // Scale per-pixel inscattering relative to zenith, anchored to CPU-computed sky_base
  var sky_col = sky_base * (inscatter_r / max(zenith_inscatter_r, vec3f(0.001)));

  // Rayleigh phase function: brighter toward sun and anti-sun
  let phase_r = rayleigh_phase(cos_theta);
  sky_col *= (0.6 + phase_r * 0.4);

  // Mie forward scattering: bright halo around sun (wavelength-independent)
  let phase_m = hg_phase(cos_theta, 0.76);
  sky_col += sun_col * phase_m * inscatter_m * 0.8;

  // Horizon: whiten from longer scattering path (multiple scattering effect)
  let horizon_t = pow(1.0 - view_el, 4.0);
  let sky_lum = (sky_col.r + sky_col.g + sky_col.b) / 3.0;
  sky_col = mix(sky_col, vec3f(sky_lum * 1.2 + 0.02), horizon_t * 0.45);

  // Below horizon: darken (ground line)
  if (view.z < 0.0) {
    sky_col *= max(1.0 + view.z * 3.0, 0.0);
  }

  // === Night sky base (deep blue-black gradient) ===
  let night_factor = 1.0 - clamp(sun_lum * 8.0, 0.0, 1.0);
  if (night_factor > 0.01) {
    let night_zenith = vec3f(0.005, 0.005, 0.02);
    let night_horizon = vec3f(0.015, 0.015, 0.03);
    let night_sky = mix(night_horizon, night_zenith, view_el);
    sky_col = mix(sky_col, night_sky, night_factor);

    // Stars: only visible when dark enough and above horizon
    if (view.z > 0.0) {
      let star_vis = night_factor * clamp(view_el * 5.0, 0.0, 1.0);
      sky_col += star_field(view, anim_t) * star_vis;
    }

    // Moon
    let moon_dir = get_moon_dir();
    if (moon_dir.z > -0.1) {
      let moon = render_moon(view, moon_dir, sun_dir, params.moon_phase);
      // Moon visible in twilight too, but stars need darkness
      sky_col += moon * max(night_factor, 0.3);
    }
  }

  // === Sun disc with limb darkening ===
  if (sun_lum > 0.01 && view.z > -0.02) {
    sky_col += render_sun(view, sun_dir, sun_col);
  }

  // === Clouds (procedural, physically lit by sun) ===
  if (cover > 0.01 && view.z > -0.05) {
    // Project onto dome
    let cloud_x = view.x / max(view.z + 0.3, 0.1) * 200.0;
    let cloud_y = view.y / max(view.z + 0.3, 0.1) * 200.0;
    let cd = cloud_density(cloud_x, cloud_y, anim_t, cover);

    if (cd > 0.01) {
      // Cloud illumination: sun-facing side bright, away side dark
      let cloud_n = normalize(vec3f(
        -sin(cloud_x * 0.05) * 0.3,
        -sin(cloud_y * 0.05) * 0.3,
        1.0
      ));
      let cloud_ndotl = max(dot(cloud_n, sun_dir), 0.0);

      // Direct sun illumination on cloud (golden at sunset)
      let direct = sun_col * cloud_ndotl * 0.9;
      // Ambient from sky scattered light
      let ambient = sky_base * 0.3;
      // Cloud base color: high albedo white
      let cloud_albedo = vec3f(0.92, 0.93, 0.95);
      let cloud_lit = cloud_albedo * (direct + ambient);
      // Dark underside when thick
      let cloud_dark = cloud_lit * (0.4 + 0.6 * max(view_el, 0.1));

      // At night, clouds are faintly visible from moonlight
      var cloud_final = cloud_dark;
      if (night_factor > 0.5) {
        let moon_dir = get_moon_dir();
        let moon_illum = max(dot(cloud_n, moon_dir), 0.0) * 0.04;
        cloud_final = vec3f(0.03, 0.03, 0.05) * cd + vec3f(moon_illum);
      }

      sky_col = mix(sky_col, cloud_final, cd * 0.9);
    }
  }

  return sky_col * sky_bright;
}
