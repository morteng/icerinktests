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

  // ---- Indoor arena structures (use SDF, not mask, for smooth corners) ----
  if (is_indoor() && !is_backyard() && params.rink_hx > 0.0) {
    let dist = rink_sdf(f32(cell_x) + 0.5, f32(cell_y) + 0.5);
    if (dist >= 0.0) {
      var arena_color = vec3f(0.1);
      var arena_rough: f32 = 0.7;
      var arena_f0: f32 = 0.04;
      let gx = f32(cell_x);
      let gy = f32(cell_y);
      let noise = hash(gx, gy);

      // Boards/glass zone (dist 0-4) now rendered as 3D voxel geometry.
      // Mesh shows flat concrete floor beneath the voxel boards.
      if (dist < 4.0) {
        arena_color = vec3f(0.10 + noise * 0.04, 0.08 + noise * 0.03, 0.14 + noise * 0.04);
        arena_rough = 0.8;
        arena_f0 = 0.04;
      } else if (dist < 8.0) {
        // Concourse — wider dark concrete walkway (buffer before seats)
        arena_color = vec3f(0.10 + noise * 0.04, 0.08 + noise * 0.03, 0.14 + noise * 0.04);
        arena_rough = 0.8;
        arena_f0 = 0.04;
      } else {
        // ---- Tiered seating ----
        let seat_dist = dist - 8.0;
        let max_seat = max(f32(params.width), f32(params.height)) * 0.05;
        let fade = 1.0 - smoothstep(max_seat * 0.6, max_seat, seat_dist);

        let row_pitch = 10.0;
        let row_f = seat_dist / row_pitch;
        let row = u32(row_f);
        let in_row = fract(row_f);
        let is_row_area = in_row < 0.7;

        // Seat column coordinate (following rink curvature)
        let adx = abs(gx - params.rink_cx) - (params.rink_hx - params.rink_cr);
        let ady = abs(gy - params.rink_cy) - (params.rink_hy - params.rink_cr);
        let t_coord = smoothstep(-2.0, 2.0, adx - ady);
        let tangent_coord = mix(gx, gy, t_coord);
        let seat_col = tangent_coord / 7.0;
        let in_seat = fract(seat_col);
        let is_seat_pixel = in_seat > 0.12 && in_seat < 0.88;

        let aisle_pos = fract(seat_col / 20.0);
        let is_aisle = aisle_pos < 0.06 || aisle_pos > 0.94;

        if (is_row_area && is_seat_pixel && !is_aisle && fade > 0.05) {
          // Section coloring by angle
          let sect_angle = abs(atan2(gy - params.rink_cy, gx - params.rink_cx));
          let end_blend = smoothstep(0.6, 0.85, sect_angle) * (1.0 - smoothstep(2.3, 2.55, sect_angle))
                        + smoothstep(2.55, 2.8, sect_angle);
          let corner_blend = smoothstep(1.6, 1.85, sect_angle) * (1.0 - smoothstep(2.3, 2.55, sect_angle));

          let red = vec3f(0.7, 0.12, 0.12);
          let blue = vec3f(0.12, 0.18, 0.65);
          let gold = vec3f(0.7, 0.58, 0.08);
          var seat_base = blue;
          seat_base = mix(seat_base, gold, corner_blend);
          seat_base = mix(seat_base, red, end_blend);

          let seat_id = hash(floor(seat_col), f32(row));

          // ---- Crowd wave: sinusoidal wave traveling around the stadium ----
          let wave_angle = atan2(gy - params.rink_cy, gx - params.rink_cx);
          let wave_phase = sin(wave_angle * 2.0 - params.anim_time * 2.5);
          // Wave is active only when crowd_density > 0.3 (enough people for a wave)
          let wave_active = smoothstep(0.3, 0.5, params.crowd_density);
          // Each person has their own reaction delay based on seat_id
          let person_delay = hash(floor(seat_col) + 7.7, f32(row) + 3.3) * 0.3;
          let wave_trigger = wave_phase - person_delay;
          let is_waving = wave_trigger > 0.5 && wave_active > 0.5;

          // Crowd density: occupied seats get colorful people, empty seats are darker
          let is_occupied = seat_id < params.crowd_density;
          if (is_occupied) {
            // Person: random clothing color + skin-tone head + hair
            let cloth_hue = hash(floor(seat_col) + 0.5, f32(row) + 0.5);
            let cloth_sat = 0.5 + hash(floor(seat_col) + 1.3, f32(row) + 2.1) * 0.4;
            // Generate clothing color from hue
            let h6 = cloth_hue * 6.0;
            let h_frac = fract(h6);
            var cloth_color: vec3f;
            let hi = u32(h6) % 6u;
            if (hi == 0u) { cloth_color = vec3f(1.0, h_frac, 0.0); }
            else if (hi == 1u) { cloth_color = vec3f(1.0 - h_frac, 1.0, 0.0); }
            else if (hi == 2u) { cloth_color = vec3f(0.0, 1.0, h_frac); }
            else if (hi == 3u) { cloth_color = vec3f(0.0, 1.0 - h_frac, 1.0); }
            else if (hi == 4u) { cloth_color = vec3f(h_frac, 0.0, 1.0); }
            else { cloth_color = vec3f(1.0, 0.0, 1.0 - h_frac); }

            // Clothing variety: some wear team jerseys, some casual
            let wear_type = hash(floor(seat_col) + 9.0, f32(row) + 11.0);
            if (wear_type > 0.7) {
              // Team jersey: match section color
              cloth_color = mix(seat_base, cloth_color, 0.3) * 0.7;
            } else {
              cloth_color = mix(vec3f(0.5), cloth_color, cloth_sat) * 0.6;
            }

            // Hair color per person
            let hair_seed = hash(floor(seat_col) + 5.0, f32(row) + 9.0);
            var hair_color: vec3f;
            if (hair_seed < 0.3) { hair_color = vec3f(0.08, 0.06, 0.04); }       // black
            else if (hair_seed < 0.55) { hair_color = vec3f(0.25, 0.15, 0.08); }  // brown
            else if (hair_seed < 0.7) { hair_color = vec3f(0.55, 0.35, 0.15); }   // light brown
            else if (hair_seed < 0.8) { hair_color = vec3f(0.65, 0.55, 0.20); }   // blonde
            else if (hair_seed < 0.88) { hair_color = vec3f(0.50, 0.15, 0.08); }  // red
            else { hair_color = vec3f(0.55, 0.55, 0.52); }                         // gray

            let skin_var = hash(floor(seat_col) + 3.0, f32(row) + 7.0);
            let skin = mix(vec3f(0.90, 0.72, 0.56), vec3f(0.45, 0.30, 0.20), skin_var);

            // Body layout within row: head at front (top), torso behind
            let row_pos = in_row / 0.7; // normalize within seat row area

            if (is_waving) {
              // Wave pose: arms up — brighter color, head extends higher
              if (row_pos < 0.12) {
                // Raised arms / hands — skin tone
                arena_color = skin;
              } else if (row_pos < 0.20) {
                // Hair cap (top of head)
                arena_color = hair_color;
              } else if (row_pos < 0.30) {
                // Face — skin tone
                arena_color = skin;
              } else {
                // Body — clothing, brightened for excitement
                arena_color = cloth_color * 1.4;
              }
            } else {
              // Normal seated pose
              if (row_pos < 0.10) {
                // Hair cap (top of head)
                arena_color = hair_color;
              } else if (row_pos < 0.25) {
                // Face — skin tone
                arena_color = skin;
              } else if (row_pos < 0.32) {
                // Slight front-to-back gradient on torso for 3D depth
                let depth_shade = 0.85 + (row_pos - 0.25) * 2.0;
                arena_color = cloth_color * depth_shade;
              } else {
                arena_color = cloth_color;
              }
            }
          } else {
            // Empty seat — folded plastic, muted section color
            arena_color = seat_base * (0.3 + seat_id * 0.15);
          }
          arena_color *= 0.85 + in_row * 0.2;
          arena_color *= fade;
          arena_rough = 0.85;
        } else {
          // Steps/aisles between seats — dark concrete
          let step_noise = hash(gx * 3.1, gy * 2.7);
          arena_color = vec3f(0.06 + step_noise * 0.02, 0.05 + step_noise * 0.015, 0.08 + step_noise * 0.02);
          arena_color *= fade;
          arena_rough = 0.8;
        }
      }

      // ---- Arena lighting (simplified PBR) ----
      let N_arena = vec3f(0.0, 1.0, 0.0);
      let V_arena = normalize(camera.cam_pos - in.world_pos);
      let NdotV_arena = max(dot(N_arena, V_arena), 0.001);

      let raw_sun = params.sun_dir;
      let sun_len_a = length(raw_sun);
      let sun_dir_a = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len_a, sun_len_a > 0.001);

      var diff_a = vec3f(0.0);
      var spec_a = vec3f(0.0);

      let sun_NdotL_a = max(dot(N_arena, sun_dir_a), 0.0);
      if (sun_NdotL_a > 0.0 && sun_len_a > 0.001) {
        let H_a = normalize(V_arena + sun_dir_a);
        let NdotH_a = max(dot(N_arena, H_a), 0.0);
        let VdotH_a = max(dot(V_arena, H_a), 0.0);
        let D_a = D_GGX(NdotH_a, arena_rough);
        let G_a = G_Smith(NdotV_arena, sun_NdotL_a, arena_rough);
        let F_a = F_Schlick(VdotH_a, arena_f0);
        let spec_brdf = D_a * G_a * F_a / (4.0 * NdotV_arena * sun_NdotL_a + 0.001);
        diff_a += params.sun_color * (1.0 - F_a) * sun_NdotL_a;
        spec_a += params.sun_color * spec_brdf * sun_NdotL_a;
      }

      let light_count_a = min(params.light_count, MAX_LIGHTS);
      for (var ia = 0u; ia < light_count_a; ia++) {
        let light_a = params.lights[ia];
        let to_light_a = light_a.pos - in.world_pos;
        let dist_a = length(to_light_a);
        let L_a = to_light_a / max(dist_a, 0.01);
        let NdotL_a = max(dot(N_arena, L_a), 0.0);
        if (NdotL_a <= 0.0) { continue; }
        var atten_a = light_a.intensity;
        if (light_a.radius > 0.0) { atten_a *= attenuation_ue4(dist_a, light_a.radius); }
        if (atten_a < 0.001) { continue; }
        let H_a2 = normalize(V_arena + L_a);
        let NdotH_a2 = max(dot(N_arena, H_a2), 0.0);
        let VdotH_a2 = max(dot(V_arena, H_a2), 0.0);
        let F_a2 = F_Schlick(VdotH_a2, arena_f0);
        diff_a += light_a.color * (1.0 - F_a2) * NdotL_a * atten_a;
        spec_a += light_a.color * D_GGX(NdotH_a2, arena_rough) * G_Smith(NdotV_arena, NdotL_a, arena_rough) * F_a2 / (4.0 * NdotV_arena * NdotL_a + 0.001) * NdotL_a * atten_a;
      }

      let sky_amb_a = vec3f(params.sky_brightness * 0.35 + 0.10);
      let F_amb_a = F_Schlick(NdotV_arena, arena_f0);
      var result_a = arena_color * (sky_amb_a * (1.0 - F_amb_a) + diff_a) + spec_a;
      result_a *= params.exposure;
      result_a = agx_tonemap(result_a);
      return vec4f(result_a, 1.0);
    }
  }

  let ground_type = select((params.flags >> 5u) & 3u, (params.flags >> 3u) & 3u, is_inside);
  var base_color = select(params.surround_color, params.ground_color, is_inside);
  var roughness: f32 = 0.8;
  var f0: f32 = 0.04;

  // Per-material ground properties with procedural texture
  // Uses value_noise (smooth interpolated) instead of raw hash to avoid grain
  {
    let gx = f32(cell_x);
    let gy = f32(cell_y);
    let n1 = value_noise(gx * 0.3, gy * 0.3);
    let n2 = value_noise(gx * 0.3 + 137.0, gy * 0.3 + 241.0);

    if (ground_type == 1u) {
      roughness = 0.92;
      f0 = 0.02;
      let blade = value_noise(gx * 1.1, gy * 1.1);
      let shade = 0.75 + n1 * 0.25;
      let green_var = 0.9 + blade * 0.2;
      base_color = base_color * vec3f(shade * 0.9, shade * green_var, shade * 0.85);
    } else if (ground_type == 2u) {
      roughness = 0.85;
      f0 = 0.03;
      // Gravel: keep per-stone hash for individual stone variation
      let stone_size = hash(floor(gx * 0.5), floor(gy * 0.5));
      let brightness = 0.7 + n1 * 0.35;
      let warmth = 0.95 + n2 * 0.1;
      base_color = base_color * vec3f(brightness * warmth, brightness, brightness * 0.95);
    } else if (ground_type == 3u) {
      roughness = 0.75;
      f0 = 0.04;
      let tar = 0.88 + n1 * 0.12;
      base_color = base_color * vec3f(tar);
      // Asphalt sparkle: use raw hash for occasional aggregate glints
      let sparkle = hash(gx, gy);
      if (sparkle > 0.92) {
        base_color *= 1.6;
        roughness = 0.5;
      }
    } else {
      // Concrete: smooth trowel texture
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

    // Damage visibility: amplify shavings + scratch effect
    let shav_thresh = 0.005 / max(params.damage_vis, 0.01);
    let damage_rough = 0.05 + min(s.w * params.damage_vis * 15.0, 1.0) * 0.30;
    roughness = select(0.05, damage_rough, s.w > shav_thresh);
    f0 = 0.018;

    // Scratch damage: directional micro-grooves from skate blades
    let scratch_data = scratches[idx];
    let scratch_density = f32((scratch_data >> 8u) & 0xFFu) / 255.0;
    if (scratch_density > 0.02) {
      // Increase roughness with scratch density — heavy use makes ice dull
      roughness = max(roughness, scratch_density * 0.45 * params.damage_vis + 0.05);
    }
    // Tint damaged areas slightly when exaggerated
    if (s.w > shav_thresh && params.damage_vis > 1.0) {
      let tint_strength = min((params.damage_vis - 1.0) * 0.15, 0.4) * min(s.w * 5.0, 1.0);
      base_color = mix(base_color, vec3f(0.7, 0.65, 0.6), tint_strength);
    }

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

  // Fence material removed — handled by 3D voxel stadium geometry

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

    let grain_noise = value_noise(f32(cell_x) * 0.4, f32(cell_y) * 0.4);
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
  // HD Surface: recompute normal per-pixel from ice+water surface height
  // Uses surface_height (excludes snow/fences) for smooth normals on the hard surface
  let is_hd = (params.flags & 128u) != 0u;
  var N: vec3f;
  if (is_hd && cell_x > 0u && cell_x < params.width - 1u && cell_y > 0u && cell_y < params.height - 1u) {
    let h_l = surface_height(cell_x - 1u, cell_y);
    let h_r = surface_height(cell_x + 1u, cell_y);
    let h_u = surface_height(cell_x, cell_y - 1u);
    let h_d = surface_height(cell_x, cell_y + 1u);
    let dh_dx = (h_r - h_l) * 0.5;
    let dh_dy = (h_d - h_u) * 0.5;
    N = normalize(vec3f(-dh_dx, 1.0, -dh_dy));
  } else {
    N = normalize(in.normal);
  }

  // Scratch normal perturbation: skate grooves deflect micro-normal perpendicular to blade direction
  if (s.y > 0.1) {
    let sc_data = scratches[idx];
    let sc_density = f32((sc_data >> 8u) & 0xFFu) / 255.0;
    if (sc_density > 0.02) {
      let sc_dir = sc_data & 0xFFu;
      let sc_angle = f32(sc_dir) * 0.7854; // π/4 per step
      // Groove direction on the surface
      let groove = vec3f(cos(sc_angle), 0.0, sin(sc_angle));
      // Perturbation perpendicular to groove (cross product with up)
      let perp = vec3f(-sin(sc_angle), 0.0, cos(sc_angle));
      // Hash-based micro-variation: alternating ridges along the groove
      let ridge = sin(dot(vec2f(f32(cell_x), f32(cell_y)), vec2f(cos(sc_angle), sin(sc_angle))) * 6.28);
      let bump_strength = sc_density * 0.25 * ridge;
      N = normalize(N + perp * bump_strength);

      // Secondary scratches (cross-hatching from direction changes)
      let sc2_dir = (sc_data >> 16u) & 0xFFu;
      if (sc2_dir != sc_dir) {
        let sc2_angle = f32(sc2_dir) * 0.7854;
        let perp2 = vec3f(-sin(sc2_angle), 0.0, cos(sc2_angle));
        let ridge2 = sin(dot(vec2f(f32(cell_x), f32(cell_y)), vec2f(cos(sc2_angle), sin(sc2_angle))) * 6.28);
        N = normalize(N + perp2 * sc_density * 0.12 * ridge2);
      }
    }
  }

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

  // Planar reflections: sample sprite reflection texture (screen-space)
  // Sprites are rendered to an offscreen texture at the same resolution/camera.
  // Sample at the fragment's screen position to get the reflected sprite color.
  var sprite_refl = vec3f(0.0);
  var sprite_refl_alpha: f32 = 0.0;
  if (s.y > 0.1 || s.z > 0.1) {
    let refl_dims = textureDimensions(reflection_tex);
    let screen_uv = in.clip_pos.xy / vec2f(f32(refl_dims.x), f32(refl_dims.y));
    let refl_pixel = textureSampleLevel(reflection_tex, sprite_sampler, screen_uv, 0.0);
    if (refl_pixel.a > 0.01) {
      // Apply Beer-Lambert absorption through ice for blue tinting
      let ice_depth_m = (s.y + s.z) * 0.001;
      let refl_absorption = vec3f(60.0, 6.0, 1.8);
      let refl_absorb = exp(-refl_absorption * ice_depth_m * 0.3);
      sprite_refl = refl_pixel.rgb * refl_absorb;
      sprite_refl_alpha = refl_pixel.a;
    }
  }

  // Blend environment reflection (sky/arena) with Fresnel weight
  result = mix(result, env_color, env_weight);

  // Blend sprite reflections on top with stronger weight (ice is very reflective)
  if (sprite_refl_alpha > 0.01) {
    let refl_strength = clamp(F_amb * 3.0 + 0.15, 0.0, 0.6) * sprite_refl_alpha;
    result = mix(result, sprite_refl, refl_strength);
  }

  // Contact shadow: ambient darkening under sprites to ground them visually
  let contact = sprite_contact_shadow(in.world_pos);
  result *= contact;

  result += snow_sparkle;
  result *= params.exposure;
  result = agx_tonemap(result);

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
  let is_outdoor = (params.flags & 1u) != 0u;
  var color = sample_sky_env(dir, is_outdoor);

  color *= params.exposure;
  color = agx_tonemap(color);

  return vec4f(color, 1.0);
}
