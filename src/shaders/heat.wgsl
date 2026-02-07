// Per-cell state packed as vec4f:
//   .x = temperature (°C)
//   .y = ice thickness (mm)
//   .z = water depth (mm)
//   .w = shavings/debris depth (mm)

struct SimParams {
  width: u32,
  height: u32,
  pipe_temp: f32,
  ambient_temp: f32,
  alpha_dt_dx2: f32,
  pipe_coupling: f32,
  air_coupling: f32,
  freeze_rate: f32,
  melt_rate: f32,
  latent_factor: f32,
  flood_amount: f32,
  return_delta: f32,
  // Damage params (mode: 0=none, 1=damage ice, 2=add water, 3=add snow)
  damage_x: f32,
  damage_y: f32,
  damage_radius: f32,
  damage_mode: u32,
  // Zamboni params
  zamboni_x: f32,
  zamboni_y: f32,
  zamboni_width: f32,
  zamboni_active: u32,
  zamboni_length: f32,
  zamboni_dir: f32,
  sim_dt: f32,
  // Water physics params
  water_coupling: f32,
  evap_rate: f32,
  drain_rate: f32,
  snow_amount: f32,
  rain_rate: f32,
  // Zamboni resurfacing params (configurable per tool type)
  zamboni_water_rate: f32,  // mm/s water deposited to each cell in water zone while active
  zamboni_heat_temp: f32,   // water temperature °C (65 zamboni, 0 shovel)
  zamboni_speed: f32,       // cells/s travel speed
  zamboni_shave_depth: f32, // mm ice removed per crossing (0.8 zamboni, 0 shovel)
  // New: height-field water + falling-sand snow params
  water_gravity_coupling: f32,
  water_damping: f32,
  snow_repose_threshold: f32,
  snow_transfer_frac: f32,
  cell_size_m: f32,
  damage_amount: f32,
  damage_temp: f32,
  damage_dir: f32,
  is_outdoor: u32,
  is_backyard: u32,
  blade_down: u32,
  water_on: u32,
  wind_x: f32,
  wind_y: f32,
  noise_seed: u32,
  _pad47: f32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> state_in: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> state_out: array<vec4f>;
@group(0) @binding(3) var<storage, read> pipes: array<f32>;
@group(0) @binding(4) var<storage, read> mask: array<f32>;
@group(0) @binding(5) var<storage, read> solids: array<f32>;
@group(0) @binding(6) var<storage, read_write> scratches: array<u32>;
// State2: vec4f per cell (snow_density kg/m³, snow_lwc 0-1, mud_amount mm, reserved)
@group(0) @binding(7) var<storage, read> state2_in: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> state2_out: array<vec4f>;

fn cell(x: u32, y: u32) -> u32 {
  return y * params.width + x;
}

// PCG hash for fast per-cell, per-frame noise
fn pcg_hash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Returns [0,1] noise for a cell, varies per frame via noise_seed
fn cell_noise(x: u32, y: u32) -> f32 {
  let h = pcg_hash(x + y * params.width + params.noise_seed * 65537u);
  return f32(h) / 4294967295.0;
}

// Water passes through: open(0) and net(2). Blocked by: frame(1), fence(3,4), outside-mask (indoor only).
fn is_passable_water(x: u32, y: u32) -> bool {
  let i = cell(x, y);
  if (mask[i] > 0.5) {
    let s = solids[i];
    return s < 0.5 || (s > 1.5 && s < 2.5); // only net(2) passes water
  }
  return params.is_outdoor > 0u;
}

// Snow passes through: open(0) only. Blocked by: frame(1), net(2), outside-mask (indoor only).
fn is_passable_snow(x: u32, y: u32) -> bool {
  let i = cell(x, y);
  if (mask[i] > 0.5) {
    return solids[i] < 0.5;
  }
  return params.is_outdoor > 0u;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) {
    return;
  }

  let i = cell(x, y);
  let inside_mask = mask[i] > 0.5;

  // Indoor rinks: skip cells outside mask entirely
  if (!inside_mask && params.is_outdoor == 0u) {
    state_out[i] = vec4f(params.ambient_temp, 0.0, 0.0, 0.0);
    state2_out[i] = vec4f(0.0, 0.0, 0.0, 0.0);
    return;
  }

  let s = state_in[i];
  var T = s.x;
  var ice = s.y;
  var water = s.z;
  var shavings = s.w;

  // State2: snow properties
  let s2 = state2_in[i];
  var snow_density = s2.x;   // kg/m³ (0 or 50-917)
  var snow_lwc = s2.y;       // liquid water content fraction (0-1)
  var mud = s2.z;             // mud/dirt (mm)
  var snow_reserved = s2.w;   // reserved

  // Ensure density is valid when snow exists
  if (shavings > 0.01 && snow_density < 50.0) {
    snow_density = select(400.0, 80.0, params.is_outdoor > 0u);
  }
  if (shavings < 0.01) {
    snow_density = 0.0;
    snow_lwc = 0.0;
  }

  // --- Flood: add water if requested (inside rink only) ---
  // Pro rinks: hot zamboni water (40°C). Backyard: garden hose (2°C).
  if (inside_mask && params.flood_amount > 0.0) {
    water += params.flood_amount;
    let flood_temp = select(40.0, 2.0, params.is_backyard > 0u);
    T = mix(T, flood_temp, clamp(params.flood_amount / 5.0, 0.0, 0.5));
  }

  // --- Snowfall: add snow (shavings) if requested ---
  if (params.snow_amount > 0.0) {
    let old_mass = shavings * snow_density;
    let new_density = 80.0; // fresh falling snow
    let new_mass = params.snow_amount * new_density;
    shavings += params.snow_amount;
    snow_density = select((old_mass + new_mass) / max(shavings, 0.01), new_density, old_mass < 0.01);
  }

  // --- Rain: continuous water accumulation (outdoor, warm conditions) ---
  // Spatial noise makes rain coverage uneven
  let rain_noise = cell_noise(x ^ 7u, y ^ 13u);
  water += params.rain_rate * (0.7 + rain_noise * 0.6);

  // --- Grid-edge drain for outdoor rinks (water/snow runs off at edges) ---
  if (!inside_mask) {
    let at_grid_edge = x == 0u || x == params.width - 1u || y == 0u || y == params.height - 1u;
    if (at_grid_edge) {
      water *= 0.95;
      shavings *= 0.98;
    }
  }

  // Backyard grid-edge drain: water/snow run off at grid boundaries
  // (with all-1.0 mask, the above drain never triggers for backyard)
  if (params.is_backyard > 0u) {
    let at_grid_edge = x <= 1u || x >= params.width - 2u || y <= 1u || y >= params.height - 2u;
    if (at_grid_edge) {
      water *= 0.97;
      shavings *= 0.99;
    }
  }

  // --- Heat diffusion (zero-flux BC at mask edges) ---
  let xl = max(x, 1u) - 1u;
  let xr = min(x + 1u, params.width - 1u);
  let yu = max(y, 1u) - 1u;
  let yd = min(y + 1u, params.height - 1u);

  // Neumann BC: if neighbor is outside mask, use own temperature (indoor only)
  // Outdoor rinks allow heat flow across mask boundary
  let outdoor = params.is_outdoor > 0u;
  let mask_xl = mask[cell(xl, y)] > 0.5 || outdoor;
  let mask_xr = mask[cell(xr, y)] > 0.5 || outdoor;
  let mask_yu = mask[cell(x, yu)] > 0.5 || outdoor;
  let mask_yd = mask[cell(x, yd)] > 0.5 || outdoor;

  let Txl = select(T, state_in[cell(xl, y)].x, mask_xl);
  let Txr = select(T, state_in[cell(xr, y)].x, mask_xr);
  let Tyu = select(T, state_in[cell(x, yu)].x, mask_yu);
  let Tyd = select(T, state_in[cell(x, yd)].x, mask_yd);

  let lap = Txl + Txr + Tyu + Tyd - 4.0 * T;

  T += params.alpha_dt_dx2 * lap;

  // --- Height-field gravity-driven water flow (with heat advection) ---
  // Water flows from high effective surface to low, carrying heat with it.
  // Snow acts as a physical dam: dense snow blocks water, fresh powder is permeable.
  {
    let snow_barrier_frac = clamp(snow_density / 400.0, 0.0, 1.0);
    let my_surface = ice + water + shavings * snow_barrier_frac;
    let coupling = params.water_gravity_coupling;
    var water_out = 0.0;   // total water leaving
    var water_in = 0.0;    // total water arriving
    var heat_in = 0.0;     // temperature-weighted incoming water (for advection)

    // Left neighbor
    if (is_passable_water(xl, y)) {
      let ni = cell(xl, y);
      let ns = state_in[ni];
      let nb = ns.w * clamp(state2_in[ni].x / 400.0, 0.0, 1.0);
      let n_surface = ns.y + ns.z + nb;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0 && water > 0.0) {
        water_out += min(h_diff * 0.5 * coupling, water * 0.24);
      } else if (h_diff < 0.0) {
        let inflow = min(-h_diff * 0.5 * coupling, ns.z * 0.24);
        water_in += inflow;
        heat_in += inflow * ns.x;
      }
    }
    // Right neighbor
    if (is_passable_water(xr, y)) {
      let ni = cell(xr, y);
      let ns = state_in[ni];
      let nb = ns.w * clamp(state2_in[ni].x / 400.0, 0.0, 1.0);
      let n_surface = ns.y + ns.z + nb;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0 && water > 0.0) {
        water_out += min(h_diff * 0.5 * coupling, water * 0.24);
      } else if (h_diff < 0.0) {
        let inflow = min(-h_diff * 0.5 * coupling, ns.z * 0.24);
        water_in += inflow;
        heat_in += inflow * ns.x;
      }
    }
    // Up neighbor
    if (is_passable_water(x, yu)) {
      let ni = cell(x, yu);
      let ns = state_in[ni];
      let nb = ns.w * clamp(state2_in[ni].x / 400.0, 0.0, 1.0);
      let n_surface = ns.y + ns.z + nb;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0 && water > 0.0) {
        water_out += min(h_diff * 0.5 * coupling, water * 0.24);
      } else if (h_diff < 0.0) {
        let inflow = min(-h_diff * 0.5 * coupling, ns.z * 0.24);
        water_in += inflow;
        heat_in += inflow * ns.x;
      }
    }
    // Down neighbor
    if (is_passable_water(x, yd)) {
      let ni = cell(x, yd);
      let ns = state_in[ni];
      let nb = ns.w * clamp(state2_in[ni].x / 400.0, 0.0, 1.0);
      let n_surface = ns.y + ns.z + nb;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0 && water > 0.0) {
        water_out += min(h_diff * 0.5 * coupling, water * 0.24);
      } else if (h_diff < 0.0) {
        let inflow = min(-h_diff * 0.5 * coupling, ns.z * 0.24);
        water_in += inflow;
        heat_in += inflow * ns.x;
      }
    }

    // Noise jitter on water damping for natural variation
    let water_noise = cell_noise(x, y);
    let noisy_damping = params.water_damping * (0.92 + water_noise * 0.16);
    let net_flow = (water_in - water_out) * noisy_damping;
    water = max(water + net_flow, 0.0);

    // Heat advection: incoming water mixes with cell's thermal mass
    let effective_inflow = water_in * noisy_damping;
    if (effective_inflow > 0.001) {
      let avg_T_in = heat_in / water_in;
      let thermal_mass = ice * 0.5 + water + shavings * 0.3 + 5.0;
      let mix_frac = effective_inflow / (thermal_mass + effective_inflow);
      T = mix(T, avg_T_in, clamp(mix_frac, 0.0, 0.3));
    }
  }

  // --- Board drain: water near mask edge drains (inside rink only) ---
  if (inside_mask && water > 0.001) {
    let raw_mask_xl = mask[cell(xl, y)] > 0.5;
    let raw_mask_xr = mask[cell(xr, y)] > 0.5;
    let raw_mask_yu = mask[cell(x, yu)] > 0.5;
    let raw_mask_yd = mask[cell(x, yd)] > 0.5;
    let at_edge = !raw_mask_xl || !raw_mask_xr || !raw_mask_yu || !raw_mask_yd;
    if (at_edge) {
      let effective_drain = select(params.drain_rate, params.drain_rate * 0.05, params.is_backyard > 0u);
      water *= (1.0 - effective_drain);
    }
  }

  // --- Evaporation: slow water loss above freezing ---
  if (T > 0.0 && water > 0.0) {
    water -= min(water, params.evap_rate * T);
  }

  // --- Pipe cooling (temperature varies along flow: supply→return, inside rink only) ---
  if (inside_mask) {
    let flow_pos = pipes[i];
    if (flow_pos > 0.0) {
      let local_pipe_temp = params.pipe_temp + flow_pos * params.return_delta;
      T += params.pipe_coupling * (local_pipe_temp - T);
    }
  }

  // --- Air coupling (modulated by snow insulation, density-dependent) ---
  // Thermal conductivity scales with density: fresh snow k≈0.03, ice k≈2.2 W/m/K
  // Higher density snow insulates less
  var snow_k = 0.03;
  if (shavings > 0.01 && snow_density > 50.0) {
    snow_k = mix(0.03, 2.2, clamp((snow_density - 50.0) / (917.0 - 50.0), 0.0, 1.0));
  }
  // Insulation factor: low k = high insulation, high k = low insulation
  let insulation_strength = (2.2 / max(snow_k, 0.01)) * params.water_coupling;
  let insulation = 1.0 / (1.0 + shavings * insulation_strength);
  T += params.air_coupling * insulation * (params.ambient_temp - T);

  // --- Phase change ---
  // Rate-limited phase change (gradual, visual effect)
  if (T < 0.0 && water > 0.0) {
    let can_freeze = min(water, params.freeze_rate * abs(T));
    ice += can_freeze;
    water -= can_freeze;
    T += can_freeze * params.latent_factor;
  }

  if (T > 0.0 && ice > 0.0) {
    // Dirty ice melts faster: mud reduces albedo → absorbs more heat
    let mud_melt_factor = 1.0 + clamp(mud * 5.0, 0.0, 1.0);
    let can_melt = min(ice, params.melt_rate * T * mud_melt_factor);
    ice -= can_melt;
    water += can_melt;
    T -= can_melt * params.latent_factor;
  }

  // Equilibrium clamp: water cannot exist below 0°C, ice cannot exist above 0°C.
  // Force remaining phase change to enforce physical constraint.
  if (T < 0.0 && water > 0.0) {
    // How much water must freeze to release enough latent heat to reach 0°C?
    let needed = min(water, abs(T) / params.latent_factor);
    ice += needed;
    water -= needed;
    T += needed * params.latent_factor;
  }
  if (T > 0.0 && ice > 0.0) {
    let needed = min(ice, T / params.latent_factor);
    ice -= needed;
    water += needed;
    T -= needed * params.latent_factor;
  }

  // --- Shavings melt (2x faster than solid ice — more surface area) ---
  if (T > 0.0 && shavings > 0.0) {
    let can_melt_shav = min(shavings, params.melt_rate * 2.0 * T);
    shavings -= can_melt_shav;
    water += can_melt_shav;
    T -= can_melt_shav * params.latent_factor;
  }
  // Equilibrium clamp for shavings too
  if (T > 0.0 && shavings > 0.0) {
    let needed = min(shavings, T / params.latent_factor);
    shavings -= needed;
    water += needed;
    T -= needed * params.latent_factor;
  }

  // --- Snow sublimation: dry cold snow loses mass directly to vapor ---
  let dt = params.sim_dt;
  let wind_strength = sqrt(params.wind_x * params.wind_x + params.wind_y * params.wind_y);
  if (T < 0.0 && shavings > 0.01 && snow_lwc < 0.02) {
    let wind_enhance = 1.0 + wind_strength * 0.1;
    // ~0.5 mm/day at -10°C, increases with wind
    let sublim = 0.0000005 * abs(T) * wind_enhance * dt;
    shavings = max(shavings - sublim, 0.0);
  }

  // --- Falling-sand snow/shavings (angle of repose + wind drift) ---
  // Dense/packed snow holds steeper walls than fresh powder
  // Scale threshold by cell size for consistent angle of repose across presets
  let density_frac_repose = clamp((snow_density - 50.0) / (600.0 - 50.0), 0.0, 1.0);
  let cell_mm = params.cell_size_m * 1000.0;
  let threshold = params.snow_repose_threshold * (cell_mm / 80.0) * (1.0 + density_frac_repose * 3.0);
  let tfrac = params.snow_transfer_frac * (1.0 - density_frac_repose * 0.7);
  var delta_snow = 0.0;
  var snow_push_total = 0.0;   // total snow pushed away
  var snow_recv_total = 0.0;   // total snow received
  var recv_density_sum = 0.0;  // density-weighted received snow
  var recv_lwc_sum = 0.0;      // lwc-weighted received snow
  var recv_mud_sum = 0.0;      // proportional mud arriving with snow

  // Wind-biased transfer: directional modifiers for cardinal neighbors
  let wind_factor = min(wind_strength * 0.05, 0.3);
  // Push: wind makes it easier to push downwind, harder upwind
  let wind_push_left  = clamp(1.0 + wind_factor * (-params.wind_x), 0.5, 2.0); // left = -x
  let wind_push_right = clamp(1.0 + wind_factor * params.wind_x, 0.5, 2.0);    // right = +x
  let wind_push_up    = clamp(1.0 + wind_factor * (-params.wind_y), 0.5, 2.0);  // up = -y
  let wind_push_down  = clamp(1.0 + wind_factor * params.wind_y, 0.5, 2.0);     // down = +y
  // Receive: opposite bias
  let wind_recv_left  = clamp(1.0 + wind_factor * params.wind_x, 0.5, 2.0);
  let wind_recv_right = clamp(1.0 + wind_factor * (-params.wind_x), 0.5, 2.0);
  let wind_recv_up    = clamp(1.0 + wind_factor * params.wind_y, 0.5, 2.0);
  let wind_recv_down  = clamp(1.0 + wind_factor * (-params.wind_y), 0.5, 2.0);

  // Push excess to lower neighbors
  if (shavings > 0.01) {
    if (is_passable_snow(xl, y)) {
      let diff = shavings - state_in[cell(xl, y)].w;
      if (diff > threshold) {
        let pushed = min((diff - threshold) * 0.5 * tfrac * wind_push_left, shavings * 0.15);
        delta_snow -= pushed;
        snow_push_total += pushed;
      }
    }
    if (is_passable_snow(xr, y)) {
      let diff = shavings - state_in[cell(xr, y)].w;
      if (diff > threshold) {
        let pushed = min((diff - threshold) * 0.5 * tfrac * wind_push_right, shavings * 0.15);
        delta_snow -= pushed;
        snow_push_total += pushed;
      }
    }
    if (is_passable_snow(x, yu)) {
      let diff = shavings - state_in[cell(x, yu)].w;
      if (diff > threshold) {
        let pushed = min((diff - threshold) * 0.5 * tfrac * wind_push_up, shavings * 0.15);
        delta_snow -= pushed;
        snow_push_total += pushed;
      }
    }
    if (is_passable_snow(x, yd)) {
      let diff = shavings - state_in[cell(x, yd)].w;
      if (diff > threshold) {
        let pushed = min((diff - threshold) * 0.5 * tfrac * wind_push_down, shavings * 0.15);
        delta_snow -= pushed;
        snow_push_total += pushed;
      }
    }
  }

  // Receive from taller neighbors (track properties for mixing)
  if (is_passable_snow(xl, y)) {
    let ni = cell(xl, y);
    let diff = state_in[ni].w - shavings;
    if (diff > threshold) {
      let amount = min((diff - threshold) * 0.5 * tfrac * wind_recv_left, state_in[ni].w * 0.15);
      delta_snow += amount;
      snow_recv_total += amount;
      let ns2 = state2_in[ni];
      recv_density_sum += amount * ns2.x;
      recv_lwc_sum += amount * ns2.y;
      recv_mud_sum += amount * ns2.z * amount / max(state_in[ni].w, 0.01);
    }
  }
  if (is_passable_snow(xr, y)) {
    let ni = cell(xr, y);
    let diff = state_in[ni].w - shavings;
    if (diff > threshold) {
      let amount = min((diff - threshold) * 0.5 * tfrac * wind_recv_right, state_in[ni].w * 0.15);
      delta_snow += amount;
      snow_recv_total += amount;
      let ns2 = state2_in[ni];
      recv_density_sum += amount * ns2.x;
      recv_lwc_sum += amount * ns2.y;
      recv_mud_sum += amount * ns2.z * amount / max(state_in[ni].w, 0.01);
    }
  }
  if (is_passable_snow(x, yu)) {
    let ni = cell(x, yu);
    let diff = state_in[ni].w - shavings;
    if (diff > threshold) {
      let amount = min((diff - threshold) * 0.5 * tfrac * wind_recv_up, state_in[ni].w * 0.15);
      delta_snow += amount;
      snow_recv_total += amount;
      let ns2 = state2_in[ni];
      recv_density_sum += amount * ns2.x;
      recv_lwc_sum += amount * ns2.y;
      recv_mud_sum += amount * ns2.z * amount / max(state_in[ni].w, 0.01);
    }
  }
  if (is_passable_snow(x, yd)) {
    let ni = cell(x, yd);
    let diff = state_in[ni].w - shavings;
    if (diff > threshold) {
      let amount = min((diff - threshold) * 0.5 * tfrac * wind_recv_down, state_in[ni].w * 0.15);
      delta_snow += amount;
      snow_recv_total += amount;
      let ns2 = state2_in[ni];
      recv_density_sum += amount * ns2.x;
      recv_lwc_sum += amount * ns2.y;
      recv_mud_sum += amount * ns2.z * amount / max(state_in[ni].w, 0.01);
    }
  }

  // Apply snow movement with property mixing
  let old_shavings = shavings;
  shavings = max(shavings + delta_snow, 0.0);

  // Mix received snow properties (density, lwc, mud) with existing snow
  if (snow_recv_total > 0.001 && shavings > 0.01) {
    let remaining = max(old_shavings - snow_push_total, 0.0);
    snow_density = (snow_density * remaining + recv_density_sum) / max(shavings, 0.01);
    snow_lwc = (snow_lwc * remaining + recv_lwc_sum) / max(shavings, 0.01);
    mud += recv_mud_sum;
  }
  // Mud leaves with pushed snow (proportional)
  if (snow_push_total > 0.001 && old_shavings > 0.01) {
    mud *= (1.0 - min(snow_push_total / old_shavings, 1.0));
  }

  // --- Water percolation into snow (density-aware) ---
  // Water infiltrates porous snow; rate depends on porosity (1 - density/917)
  if (water > 0.01 && shavings > 0.01) {
    let comp_dt = min(dt, 0.1);
    let pore_fraction = max(1.0 - snow_density / 917.0, 0.0);
    let percolation = min(water, shavings * pore_fraction * 0.01 * comp_dt);
    if (percolation > 0.0) {
      water -= percolation;
      // Water absorbed into snow increases liquid water content
      let snow_mass = shavings; // approximate mm of snow
      snow_lwc = clamp(snow_lwc + percolation / max(snow_mass, 0.1), 0.0, 0.8);
      // Warm water brings heat into snow layer
      if (T > 0.0) {
        let temp_factor = clamp(T * 0.2, 0.0, 1.0);
        let melt_from_heat = min(percolation * temp_factor, shavings * 0.1);
        shavings -= melt_from_heat;
        water += melt_from_heat;
        T -= melt_from_heat * params.latent_factor;
      }
    }
  }

  // --- Snow liquid water drainage ---
  // Excess lwc above capillary retention (~3%) drains to surface water by gravity
  if (shavings > 0.01 && snow_lwc > 0.03) {
    let comp_dt = min(dt, 0.1);
    let pore_fraction = max(1.0 - snow_density / 917.0, 0.0);
    let excess_lwc = snow_lwc - 0.03;
    let drain_rate = excess_lwc * pore_fraction * 0.05 * comp_dt;
    let drained = drain_rate * shavings;
    snow_lwc = max(snow_lwc - drain_rate, 0.03);
    water += drained;
  }

  // --- Density-dependent slush formation ---
  // When lwc > 0: density increases (snow grains collapse, water fills gaps)
  if (shavings > 0.01 && snow_lwc > 0.0) {
    let comp_dt = min(dt, 0.1);
    let target_density = min(917.0, snow_density + snow_lwc * 200.0);
    let density_rate = select(50.0, 150.0, snow_lwc > 0.15); // fast in slush regime
    let d_density = min((target_density - snow_density) * density_rate * comp_dt / max(target_density, 1.0), target_density - snow_density);
    if (d_density > 0.0) {
      let old_density = snow_density;
      snow_density += d_density;
      // Volume conservation: snow depth decreases as density increases
      let volume_ratio = old_density / max(snow_density, 1.0);
      shavings *= volume_ratio;
    }
  }

  // --- Slush freezing → snow-ice ---
  // When T < 0 and lwc > 0: liquid in snow freezes, releasing latent heat
  if (T < 0.0 && snow_lwc > 0.0 && shavings > 0.01) {
    let comp_dt = min(dt, 0.1);
    let freeze_amount = min(snow_lwc, params.freeze_rate * abs(T) * 2.0 / max(dt, 0.001) * comp_dt);
    snow_lwc -= freeze_amount;
    // Freezing water in snow increases density (with volume conservation)
    let old_d = snow_density;
    snow_density = min(917.0, snow_density + freeze_amount * 200.0);
    if (snow_density > old_d) {
      shavings *= old_d / snow_density;
    }
    // Latent heat release
    let heat_released = freeze_amount * shavings * params.latent_factor * 0.2;
    T += heat_released;
  }

  // --- Snow-ice → ice conversion ---
  // Only converts when density is very close to pure ice (>900) AND well frozen (T < -2)
  // This only realistically happens through the slush-freeze path, not dry sintering
  if (shavings > 0.1 && snow_density > 900.0 && snow_lwc < 0.01 && T < -2.0) {
    let ice_equivalent = shavings * (snow_density / 917.0);
    ice += ice_equivalent;
    // Transfer any mud from snow into ice (dirty ice)
    // mud stays in state2 as a marker for dirty ice
    shavings = 0.0;
    snow_density = 0.0;
    snow_lwc = 0.0;
  }

  // --- Natural compaction (gravity + sintering) ---
  if (shavings > 0.01 && snow_density > 0.0) {
    let comp_dt = min(dt, 0.1);
    // Gravity compaction: target density depends on snow depth
    let gravity_target = min(400.0, 200.0 + shavings * 2.0);
    if (snow_density < gravity_target) {
      let rate = 0.0001 * comp_dt;
      let old_density = snow_density;
      snow_density += (gravity_target - snow_density) * rate;
      // Volume conservation
      shavings *= old_density / max(snow_density, 1.0);
    }
    // Sintering at T < 0: ice crystal bonds form very slowly (days/weeks in reality)
    if (T < 0.0 && snow_lwc < 0.02) {
      let old_d_s = snow_density;
      snow_density = min(600.0, snow_density + 0.01 * comp_dt);
      // Volume conservation for sintering
      if (snow_density > old_d_s) {
        shavings *= old_d_s / snow_density;
      }
    }
  }

  // --- Snow-ice contact physics ---
  // Snow sitting on ice doesn't just "float" — it interacts with the surface:
  // Cold ice (T < -0.5): bottom of snow pack bonds to ice (freeze-bonding)
  // Warm ice (T > -0.5): quasi-liquid layer on ice surface wets snow base
  if (shavings > 0.01 && ice > 0.1) {
    let comp_dt = min(dt, 0.1);
    if (T < -0.5 && water < 0.01) {
      // Freeze-bonding: snow base sinters onto ice surface
      // Rate increases with colder temps and denser snow
      let density_factor = clamp(snow_density / 400.0, 0.2, 1.0);
      let bond_rate = 0.002 * abs(T + 0.5) * density_factor * comp_dt;
      let bonded = min(shavings, bond_rate);
      shavings -= bonded;
      ice += bonded * clamp(snow_density / 917.0, 0.1, 1.0);
      // If snow is exhausted, reset state2
      if (shavings < 0.01) {
        snow_density = 0.0;
        snow_lwc = 0.0;
      }
    } else if (T > -0.5 && snow_lwc < 0.3) {
      // Quasi-liquid layer: ice surface near 0°C has a thin melt film
      // This wets the base of the snow pack, triggering slush formation path
      let wetting_rate = 0.005 * (T + 0.5 + 0.5) * comp_dt; // stronger near 0°C
      snow_lwc = min(snow_lwc + wetting_rate, 0.3);
    }
  }

  // --- Mud advection with water flow ---
  // Mud moves with water (simplified: follows water gravity flow direction)
  if (mud > 0.001 && water > 0.01) {
    var mud_delta = 0.0;
    let mud_coupling = params.water_gravity_coupling * 0.5;
    let my_surface = ice + water;
    // Same 4-neighbor flow as water but for mud
    if (is_passable_water(xl, y)) {
      let ni = cell(xl, y);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0) {
        mud_delta -= min(h_diff * 0.5 * mud_coupling, mud * 0.24);
      }
    }
    if (is_passable_water(xr, y)) {
      let ni = cell(xr, y);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0) {
        mud_delta -= min(h_diff * 0.5 * mud_coupling, mud * 0.24);
      }
    }
    if (is_passable_water(x, yu)) {
      let ni = cell(x, yu);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0) {
        mud_delta -= min(h_diff * 0.5 * mud_coupling, mud * 0.24);
      }
    }
    if (is_passable_water(x, yd)) {
      let ni = cell(x, yd);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = my_surface - n_surface;
      if (h_diff > 0.0) {
        mud_delta -= min(h_diff * 0.5 * mud_coupling, mud * 0.24);
      }
    }
    // Receive mud from neighbors (flow toward us)
    if (is_passable_water(xl, y)) {
      let ni = cell(xl, y);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = n_surface - my_surface;
      if (h_diff > 0.0) {
        mud_delta += min(h_diff * 0.5 * mud_coupling, state2_in[ni].z * 0.24);
      }
    }
    if (is_passable_water(xr, y)) {
      let ni = cell(xr, y);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = n_surface - my_surface;
      if (h_diff > 0.0) {
        mud_delta += min(h_diff * 0.5 * mud_coupling, state2_in[ni].z * 0.24);
      }
    }
    if (is_passable_water(x, yu)) {
      let ni = cell(x, yu);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = n_surface - my_surface;
      if (h_diff > 0.0) {
        mud_delta += min(h_diff * 0.5 * mud_coupling, state2_in[ni].z * 0.24);
      }
    }
    if (is_passable_water(x, yd)) {
      let ni = cell(x, yd);
      let n_surface = state_in[ni].y + state_in[ni].z;
      let h_diff = n_surface - my_surface;
      if (h_diff > 0.0) {
        mud_delta += min(h_diff * 0.5 * mud_coupling, state2_in[ni].z * 0.24);
      }
    }
    mud = max(mud + mud_delta, 0.0);
  }

  // --- Interactive tools (damage / water gun / snow gun) ---
  if ((inside_mask || params.is_backyard > 0u) && params.damage_mode > 0u) {
    let dx = f32(x) - params.damage_x;
    let dy = f32(y) - params.damage_y;
    let dist2 = dx * dx + dy * dy;
    let radius = params.damage_radius;
    let r2 = radius * radius;

    if (dist2 < r2) {
      // Gaussian falloff: smooth bell curve instead of linear
      let strength = exp(-dist2 / (r2 * 0.32));
      let amt = params.damage_amount;

      if (params.damage_mode == 1u) {
        // Hockey damage: scrape off ice, create shavings
        if (ice > 0.0) {
          let damage = min(ice, amt * strength);
          ice -= damage;
          shavings += damage * 0.6;
          water += damage * 0.2;
          // Shavings from ice damage are dense fragments
          if (shavings > 0.01) {
            snow_density = mix(snow_density, 400.0, damage * strength / max(shavings, 0.1));
          }
        }
      } else if (params.damage_mode == 2u) {
        // Water gun: add warm water
        water += amt * strength;
        T = mix(T, params.damage_temp, 0.1 * strength);
      } else if (params.damage_mode == 3u) {
        // Snow gun: add snow/shavings with fresh density
        let added = amt * strength;
        if (added > 0.0) {
          let old_mass = shavings * snow_density;
          let new_density = 80.0; // fresh snow
          let new_mass = added * new_density;
          shavings += added;
          snow_density = (old_mass + new_mass) / max(shavings, 0.01);
        }
      } else if (params.damage_mode == 5u) {
        // Mud gun: deposits mud + water mixture
        let mud_add = amt * strength * 0.3; // 30% is mud
        let water_add = amt * strength * 0.7; // 70% is water
        mud += mud_add;
        water += water_add;
        T = mix(T, params.damage_temp, 0.05 * strength);
      }
    }
  }

  // --- Scratch accumulation from hockey damage ---
  if ((inside_mask || params.is_backyard > 0u) && params.damage_mode == 1u && params.damage_dir > -90.0) {
    let dx = f32(x) - params.damage_x;
    let dy = f32(y) - params.damage_y;
    let dist2 = dx * dx + dy * dy;
    let radius = params.damage_radius;
    if (dist2 < radius * radius) {
      let strength = exp(-dist2 / (radius * radius * 0.32));
      if (strength > 0.1) {
        let existing = scratches[i];
        // Convert angle to 8-direction index (0-7)
        let angle = params.damage_dir;
        let dir_f = (angle / 0.7854 + 8.0) % 8.0;
        let dir8 = u32(dir_f + 0.5) % 8u;
        // Read existing density
        let old_density = (existing >> 8u) & 0xFFu;
        let old_dir2 = (existing >> 16u) & 0xFFu;
        let old_primary = existing & 0xFFu;
        // New density: saturating add
        let add_density = u32(strength * 60.0);
        let new_density = min(old_density + add_density, 255u);
        // If direction changed significantly, move old primary to secondary
        var new_dir2 = old_dir2;
        if (old_density > 10u && old_primary != dir8) {
          new_dir2 = old_primary;
        }
        scratches[i] = dir8 | (new_density << 8u) | (new_dir2 << 16u);
      }
    }
  }

  // --- Zamboni/Shovel/WaterTank (zone-based: blade → auger → water/towel) ---
  if ((inside_mask || params.is_backyard > 0u) && params.zamboni_active > 0u) {
    let zx = params.zamboni_x;
    let zy = params.zamboni_y;
    let zw = params.zamboni_width;
    let zl = params.zamboni_length;
    let zdir = params.zamboni_dir;
    let zspeed = params.zamboni_speed;
    let fx = f32(x);
    let fy = f32(y);

    let dy_z = abs(fy - zy);
    let dx_z = (fx - zx) * zdir; // 0=rear, zl=front
    let hw = zw * 0.5;

    // Three-way detection: shovel=no shave+no water, water_tank=no shave+has water, zamboni=else
    let is_shovel = params.zamboni_shave_depth == 0.0 && params.zamboni_water_rate == 0.0;
    let is_water_tank = params.zamboni_shave_depth == 0.0 && params.zamboni_water_rate > 0.0;

    if (is_shovel) {
      // --- SHOVEL: pushes snow/shavings and water forward ---
      if (dy_z < hw && dx_z >= 0.0 && dx_z < zl) {
        let clear_rate = min(1.0, 5.0 * dt * zspeed / zl);
        shavings *= (1.0 - clear_rate);
        water *= (1.0 - clear_rate * 0.3);
      }

      let behind_x = i32(x) - i32(zdir);
      if (behind_x >= 0 && behind_x < i32(params.width)) {
        let behind_i = cell(u32(behind_x), y);
        let behind_dx = (f32(behind_x) - zx) * zdir;
        let behind_dy = abs(f32(y) - zy);
        if (behind_dy < hw && behind_dx >= 0.0 && behind_dx < zl) {
          let push_rate = min(1.0, 5.0 * dt * zspeed / zl);
          let pushed = state_in[behind_i].w * push_rate;
          shavings += pushed;
          water += state_in[behind_i].z * push_rate * 0.3;
        }
      }

      let pile_depth = hw * 0.5;
      if (dy_z < hw && dx_z >= zl && dx_z < zl + pile_depth) {
        let pile_frac = 1.0 - (dx_z - zl) / pile_depth;
        let pile_add = pile_frac * 0.02 * dt * zspeed;
        shavings += min(pile_add, 0.5);
      }

      let at_edge = mask[cell(xl, y)] < 0.5 || mask[cell(xr, y)] < 0.5 || mask[cell(x, yu)] < 0.5 || mask[cell(x, yd)] < 0.5;
      if (at_edge && dy_z < hw * 2.0 && dx_z >= -zl && dx_z < zl + pile_depth) {
        let edge_drain = min(1.0, 8.0 * dt);
        shavings *= (1.0 - edge_drain);
        water *= (1.0 - edge_drain * 0.5);
      }
    } else if (is_water_tank) {
      // --- WATER TANK: gravity-fed, no blade/auger, 3-nozzle uneven pattern ---
      // Water covers ~80% of body footprint
      if (dy_z < hw && dx_z >= 0.0 && dx_z < zl * 0.8 && params.water_on > 0u) {
        let y_fade = select(0.0, 1.0, dy_z < hw);
        // Nozzle pattern: 3 outlets create slightly uneven coverage
        let nozzle_factor = 0.7 + 0.3 * cos(fract(dy_z / hw * 1.5) * 6.2832);
        let water_add = params.zamboni_water_rate * dt * y_fade * nozzle_factor;
        water += water_add;
        let thermal_mass = ice * 0.5 + water + 5.0;
        let heat_frac = water_add / max(thermal_mass + water_add, 0.1);
        T = mix(T, params.zamboni_heat_temp, heat_frac);
      }
      // Body pushes loose snow regardless of water state
      if (dy_z < hw && dx_z >= 0.0 && dx_z < zl) {
        shavings *= max(0.0, 1.0 - 0.3 * dt);
      }
    } else {
      // --- ZAMBONI: blade → auger → water/towel ---
      let cs = max(params.cell_size_m, 0.01);
      let blade_zone = max(3.0, 0.3 / cs);
      let water_zone = max(3.0, 0.5 / cs);
      let rear_ext = water_zone + 1.0;

      if (dy_z < hw + 1.0 && dx_z >= -rear_ext && dx_z < zl) {
        let rate_factor = zspeed * dt;
        let y_fade = select(0.0, 1.0, dy_z < hw);

        // BLADE ZONE (front): shave ice, create shavings, clear scratches
        if (dx_z > zl - blade_zone && params.blade_down > 0u) {
          let shave = min(ice, params.zamboni_shave_depth * rate_factor / blade_zone * y_fade);
          if (ice > 1.0) {
            ice -= shave;
            shavings += shave;
          }
          if (y_fade > 0.5) {
            scratches[i] = 0u;
          }
        }

        // AUGER ZONE (middle): collect shavings into snow tank
        if (dx_z > water_zone && dx_z < zl - blade_zone) {
          shavings *= max(0.0, 1.0 - 5.0 * dt * y_fade);
        }

        // WATER/TOWEL ZONE (rear): deposit hot water (time-based rate, mm/s)
        if (dx_z < water_zone && dx_z >= -rear_ext && params.zamboni_water_rate > 0.0 && params.water_on > 0u) {
          let water_add = params.zamboni_water_rate * dt * y_fade;
          water += water_add;
          let thermal_mass = ice * 0.5 + water + 5.0;
          let heat_frac = water_add / max(thermal_mass + water_add, 0.1);
          T = mix(T, params.zamboni_heat_temp, heat_frac);
        }

        // Entire body: squeegee clears loose snow
        shavings *= max(0.0, 1.0 - 0.5 * dt * y_fade);
      }
    }
  }

  state_out[i] = vec4f(T, ice, water, shavings);
  state2_out[i] = vec4f(snow_density, snow_lwc, mud, snow_reserved);
}
