// ================================================================
// Fragment shader — main render entry point
// ================================================================

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let px = min(u32(in.uv.x * f32(params.width)), params.width - 1u);
  let py = min(u32(in.uv.y * f32(params.height)), params.height - 1u);
  let idx = py * params.width + px;

  let m = mask[idx];
  let sdf = rink_sdf(f32(px) + 0.5, f32(py) + 0.5);

  // Read zamboni sprite once for both modes
  let zs = read_sprite(SLOT_ZAMBONI);

  // === SKY VIEW MODE (render_mode == 2) ===
  // Fisheye hemisphere projection: shows the full sky dome as seen from rink center
  if (params.render_mode == 2u) {
    let cx = f32(params.width) * 0.5;
    let cy = f32(params.height) * 0.5;
    let radius = min(cx, cy) * 0.95;
    let dx = (f32(px) + 0.5 - cx) / radius;
    let dy = (f32(py) + 0.5 - cy) / radius;
    let r2 = dx * dx + dy * dy;

    if (r2 > 1.0) {
      // Outside the hemisphere circle: dark border with cardinal labels
      return vec4f(0.02, 0.02, 0.04, 1.0);
    }

    // Map to 3D sky direction (fisheye: x,y → horizontal, z from distance to center)
    let elev = sqrt(max(1.0 - r2, 0.0)); // z = elevation (1 at center/zenith, 0 at edge/horizon)
    let sky_dir = normalize(vec3f(dx, -dy, elev));

    let is_outdoor = params.is_outdoor > 0u;
    let sky = sample_sky(sky_dir, params.time_of_day, params.sky_brightness, params.cloud_cover, is_outdoor, params.anim_time);

    // Horizon circle overlay
    var color = sky;
    let edge = smoothstep(0.98, 1.0, sqrt(r2));
    color = mix(color, vec3f(0.4, 0.4, 0.5), edge * 0.6);

    // Cardinal direction marks (N/S/E/W dots at the edge)
    let angle = atan2(-dy, dx);
    let cardinal = fract(angle / (3.14159265 * 0.5) + 0.5);
    if (r2 > 0.85 && r2 < 0.95 && (cardinal < 0.03 || cardinal > 0.97)) {
      color = vec3f(1.0, 1.0, 0.5);
    }

    // Zenith crosshair
    if (r2 < 0.002) {
      color = vec3f(1.0, 1.0, 1.0);
    }

    return vec4f(color, 1.0);
  }

  if (params.render_mode == 0u) {
    // === THERMAL MODE ===
    if (m < 0.5) {
      var color: vec3f;
      if (params.is_backyard > 0u) {
        // Backyard: show simulated temperature outside mask too
        let cell = state[idx];
        let temp = cell.x;
        let ice = cell.y;
        let water = cell.z;
        color = temp_to_color(temp);
        if (water > 0.01) {
          let water_alpha = clamp(water / 5.0, 0.0, 0.35);
          color = mix(color, vec3f(0.15, 0.3, 0.7), water_alpha);
        }
        if (ice > 0.01) {
          let ice_alpha = clamp(ice / 25.0, 0.0, 0.88);
          let ice_tint = mix(vec3f(0.78, 0.88, 0.98), vec3f(0.92, 0.95, 1.0), clamp(ice / 25.0, 0.0, 1.0));
          color = mix(color, ice_tint, ice_alpha);
        }
        // Subtle border at rink edge
        if (sdf >= -0.5 && sdf < 0.5) {
          color = mix(color, vec3f(0.5, 0.5, 0.3), 0.3);
        }
        draw_zamboni_thermal(&color, f32(px), f32(py), zs);
      } else if (sdf < 1.5 && sdf >= 0.0) {
        color = vec3f(0.25, 0.18, 0.12);
      } else {
        color = vec3f(0.06, 0.06, 0.10);
      }
      draw_crosshair(&color, px, py);
      return vec4f(color, 1.0);
    }

    let cell = state[idx];
    let temp = cell.x;
    let ice = cell.y;
    let water = cell.z;
    var color = temp_to_color(temp);
    if (water > 0.01) {
      let water_alpha = clamp(water / 5.0, 0.0, 0.35);
      color = mix(color, vec3f(0.15, 0.3, 0.7), water_alpha);
    }
    if (ice > 0.01) {
      let ice_alpha = clamp(ice / 25.0, 0.0, 0.88);
      let ice_tint = mix(vec3f(0.78, 0.88, 0.98), vec3f(0.92, 0.95, 1.0), clamp(ice / 25.0, 0.0, 1.0));
      color = mix(color, ice_tint, ice_alpha);
    }
    let flow_pos = pipes[idx];
    if (params.show_pipes > 0u && flow_pos > 0.0) {
      let pipe_color = mix(vec3f(0.2, 0.5, 1.0), vec3f(1.0, 0.3, 0.2), flow_pos);
      color = mix(color, pipe_color, 0.18);
    }
    draw_zamboni_thermal(&color, f32(px), f32(py), zs);
    draw_crosshair(&color, px, py);
    return vec4f(color, 1.0);

  } else {
    // === VISUAL MODE (Noita-inspired pixel art) ===

    if (m < 0.5) {
      // ---- Outside the rink ----
      let dist = sdf;
      var color: vec3f;
      // Ground illumination: PBR-consistent vec3f (diffuse BRDF + ambient)
      let g_light = ground_light(f32(px) + 0.5, f32(py) + 0.5);
      let sky_ambient_o = select(
        vec3f(params.sky_brightness * 0.2 + 0.04),
        get_sky_color() * 0.3 + get_sun_color() * max(get_sun_dir().z, 0.0) * 0.4 + vec3f(0.02),
        params.is_outdoor > 0u
      );
      let local_bright = sky_ambient_o + g_light * 0.8;

      if (params.is_backyard > 0u) {
        // ---- Backyard: no boards, render grass/earth ground with full simulation ----
        let out_cell = state[idx];
        let out_ice = out_cell.y;
        let out_water = out_cell.z;
        let out_shavings = out_cell.w;

        // Base: grass/earth with pixel noise for natural variation
        let ground_col = vec3f(params.ground_r, params.ground_g, params.ground_b);
        let gn = hash(f32(px) * 1.1, f32(py) * 0.9);
        color = ground_col * (0.85 + gn * 0.3);

        // Outer depression lip shadow: subtle darkening near rink edge
        if (dist > 0.0 && dist < 2.0) {
          let lip_f = smoothstep(0.0, 2.0, dist); // 0 at edge → 1 at 2 cells out
          color *= 0.85 + 0.15 * lip_f;
        }

        let ice_abs = vec3f(60.0, 6.0, 1.8);

        // Ice overlay (Beer-Lambert absorption)
        if (out_ice > 0.01) {
          let d_m = out_ice * 0.001;
          let full_trans = exp(-ice_abs * d_m * 2.0);
          color = color * full_trans;

          // Paint/markings at 6mm depth (same logic as inside rink)
          if (params.show_markings > 0u && out_ice > 3.0) {
            let mtype = markings[idx];
            if (mtype > 0.5) {
              let mc = marking_color_visual(mtype);
              if (out_ice < 6.0) {
                let vis = (out_ice - 3.0) / 3.0;
                color = mix(color, mc, vis * 0.7);
              } else {
                let above_m = (out_ice - 6.0) * 0.001;
                let above_trans = exp(-ice_abs * above_m * 2.0);
                let tinted_mc = mc * above_trans;
                let seal = 0.5 + 0.4 * clamp((out_ice - 6.0) / 4.0, 0.0, 1.0);
                color = mix(color, tinted_mc, seal);
              }
            }
          }
        } else if (params.show_markings > 0u) {
          // No ice: paint directly visible on ground
          let mtype = markings[idx];
          if (mtype > 0.5) {
            let mc = marking_color_visual(mtype);
            color = mix(color, mc, 0.8);
          }
        }

        // Lighting (same PBR as inside rink when there's ice)
        if (out_ice > 1.0) {
          let roughness = select(0.30, 0.05, out_shavings < 0.1);
          color = compute_lighting(px, py, idx, color, roughness, out_water);
        } else {
          // Ground/bare: ambient + light sources
          color *= local_bright;
        }

        // Drop shadows
        if (has_flag(FLAG_SHADOWS)) {
          let by_shadow = compute_shadow(f32(px) + 0.5, f32(py) + 0.5);
          color *= (1.0 - by_shadow);
        }

        // Snow/shavings overlay (density-driven PBR subsurface)
        if (out_shavings > 0.05) {
          let pile_depth = out_shavings;
          let pile_coverage = clamp(pile_depth / 2.0, 0.0, 0.98);
          let out_s2 = state2[idx];
          let out_density = max(out_s2.x, 50.0);
          let out_lwc = out_s2.y;
          let out_mud = out_s2.z;
          let out_dfrac = clamp((out_density - 50.0) / (900.0 - 50.0), 0.0, 1.0);
          let base_albedo = mix(0.88, 0.30, out_dfrac);
          let albedo = base_albedo * (1.0 - out_lwc * 0.4);
          let out_mud_frac = clamp(out_mud / 2.0, 0.0, 0.6);
          let out_efold = mix(3.0, 0.5, out_dfrac);
          let opacity = 1.0 - exp(-pile_depth / out_efold);

          let sun_col_s = get_sun_color();
          let sky_col_s = get_sky_color();
          let sun_dir_s = get_sun_dir();
          let sun_illum_s = sun_col_s * max(sun_dir_s.z, 0.0) * 0.5;
          let sky_illum_s = sky_col_s * 0.35 + vec3f(0.03);
          var light_illum_s = vec3f(0.0);
          let lc = min(params.light_count, MAX_LIGHTS);
          for (var li = 0u; li < lc; li++) {
            let light = params.lights[li];
            let h_dist = length(vec2f(light.pos.x - f32(px), light.pos.y - f32(py)));
            var la = light.intensity;
            if (light.radius > 0.0) { la *= attenuation_ue4(h_dist, light.radius); }
            light_illum_s += light.color * la * 0.3;
          }
          let total_illum_s = sun_illum_s + sky_illum_s + light_illum_s;
          let out_mud_tint = mix(vec3f(1.0), vec3f(0.45, 0.35, 0.20), out_mud_frac);
          let snow_color = vec3f(albedo) * out_mud_tint * total_illum_s;
          let noise = hash(f32(px), f32(py));
          let snow_final = snow_color * (0.92 + noise * 0.08);
          color = mix(color, snow_final, opacity * pile_coverage);
        }

        // Water overlay (Beer-Lambert + Fresnel, same as inside rink)
        if (out_water > 0.01) {
          let water_abs = vec3f(225.0, 30.0, 7.5);
          let wd_m = out_water * 0.001;
          let w_trans = exp(-water_abs * wd_m * 2.0);
          color *= w_trans;

          // Fresnel reflection
          let w_view = vec3f(0.0, 0.0, 1.0);
          let w_ndotv = 1.0; // top-down
          let f0_water = 0.020;
          let w_fresnel = f0_water + (1.0 - f0_water) * pow(1.0 - w_ndotv, 5.0);
          let w_reflect = vec3f(0.0, 0.0, 1.0);
          let w_sky = sample_sky(w_reflect, params.time_of_day, params.sky_brightness, params.cloud_cover, true, params.anim_time);
          let depth_coverage = clamp(out_water / 1.0, 0.0, 1.0);
          color += w_sky * w_fresnel * depth_coverage;
        }

        // Sprites on backyard ground (goals, zamboni, skaters, particles, lights)
        let by_fpx = f32(px) + 0.5;
        let by_fpy = f32(py) + 0.5;
        let by_gl = read_sprite(SLOT_GOAL_LEFT);
        let by_gr = read_sprite(SLOT_GOAL_RIGHT);
        draw_goal_net_sprite(&color, by_fpx, by_fpy, by_gl);
        draw_goal_net_sprite(&color, by_fpx, by_fpy, by_gr);
        draw_zamboni_sprite(&color, by_fpx, by_fpy, zs);
        draw_particles(&color, by_fpx, by_fpy);
        draw_skaters(&color, by_fpx, by_fpy);
        draw_light_fixtures(&color, by_fpx, by_fpy);

        color = max(color, vec3f(0.01));
      } else if (dist < 0.8) {
        // Kick plate
        color = vec3f(0.9, 0.9, 0.92) * local_bright;
      } else if (dist < 2.5) {
        // Board body
        let bx_rel = (f32(px) - params.rink_cx) / params.rink_hx;
        let on_near_side = f32(py) > params.rink_cy + params.rink_hy * 0.4;
        let on_far_side = f32(py) < params.rink_cy - params.rink_hy * 0.4;
        let in_bench_range = abs(bx_rel) > 0.03 && abs(bx_rel) < 0.35;
        let in_penalty_range = abs(bx_rel) > 0.03 && abs(bx_rel) < 0.17;

        if (params.is_outdoor == 0u && params.goal_offset > 0.0 && on_near_side && in_bench_range) {
          if (bx_rel < 0.0) {
            let bn = hash(f32(px) * 2.1, f32(py) * 1.3);
            color = vec3f(0.12 + bn * 0.04, 0.15 + bn * 0.03, 0.42 + bn * 0.06);
          } else {
            let bn = hash(f32(px) * 2.1, f32(py) * 1.3);
            color = vec3f(0.42 + bn * 0.06, 0.12 + bn * 0.04, 0.12 + bn * 0.03);
          }
        } else if (params.is_outdoor == 0u && params.goal_offset > 0.0 && on_far_side && in_penalty_range) {
          let bn = hash(f32(px) * 2.1, f32(py) * 1.3);
          color = vec3f(0.38 + bn * 0.05, 0.32 + bn * 0.04, 0.12 + bn * 0.03);
        } else {
          if (px % 3u < 1u) {
            color = vec3f(0.55, 0.35, 0.18);
          } else {
            color = vec3f(0.38, 0.24, 0.12);
          }
        }
        color *= local_bright;
      } else if (dist < 4.0) {
        // Glass/railing
        let bx_rel = (f32(px) - params.rink_cx) / params.rink_hx;
        let on_near_side = f32(py) > params.rink_cy + params.rink_hy * 0.4;
        let on_far_side = f32(py) < params.rink_cy - params.rink_hy * 0.4;
        let in_bench_range = abs(bx_rel) > 0.03 && abs(bx_rel) < 0.35;
        let in_penalty_range = abs(bx_rel) > 0.03 && abs(bx_rel) < 0.17;

        let glass_t = (dist - 2.5) / 1.5;
        let noise = hash(f32(px), f32(py));

        if (params.is_outdoor == 0u && params.goal_offset > 0.0 &&
            ((on_near_side && in_bench_range) || (on_far_side && in_penalty_range))) {
          color = vec3f(0.08 + noise * 0.03, 0.07 + noise * 0.02, 0.12 + noise * 0.03);
        } else {
          color = mix(vec3f(0.7, 0.72, 0.75), vec3f(0.5, 0.52, 0.55), glass_t);
          color += vec3f(noise * 0.05);
        }
        color *= local_bright;
      } else if (dist < 6.0) {
        // Concourse
        let noise = hash(f32(px), f32(py));
        color = vec3f(0.10 + noise * 0.04, 0.08 + noise * 0.03, 0.14 + noise * 0.04);
        color *= local_bright;
      } else {
        // Arena seats (indoor) or snow field (outdoor)
        if (params.is_outdoor == 0u) {
          let seat_dist = dist - 6.0;
          let max_seat = max(f32(params.width), f32(params.height)) * 0.05;
          let fade = 1.0 - smoothstep(max_seat * 0.6, max_seat, seat_dist);

          let row_pitch = 10.0;
          let row_f = seat_dist / row_pitch;
          let row = u32(row_f);
          let in_row = fract(row_f);
          let is_row_area = in_row < 0.7;

          let adx = abs(f32(px) - params.rink_cx) - (params.rink_hx - params.rink_cr);
          let ady = abs(f32(py) - params.rink_cy) - (params.rink_hy - params.rink_cr);
          let t = smoothstep(-2.0, 2.0, adx - ady);
          let tangent_coord = mix(f32(px), f32(py), t);
          let seat_col = tangent_coord / 7.0;
          let in_seat = fract(seat_col);
          let is_seat_pixel = in_seat > 0.12 && in_seat < 0.88;

          let aisle_pos = fract(seat_col / 20.0);
          let is_aisle = aisle_pos < 0.06 || aisle_pos > 0.94;

          if (is_row_area && is_seat_pixel && !is_aisle && fade > 0.05) {
            let sect_angle = abs(atan2(f32(py) - params.rink_cy, f32(px) - params.rink_cx));
            let end_blend = smoothstep(0.6, 0.85, sect_angle) * (1.0 - smoothstep(2.3, 2.55, sect_angle))
                          + smoothstep(2.55, 2.8, sect_angle);
            let corner_blend = smoothstep(1.6, 1.85, sect_angle) * (1.0 - smoothstep(2.3, 2.55, sect_angle));

            let red = vec3f(0.7, 0.12, 0.12);
            let blue = vec3f(0.12, 0.18, 0.65);
            let gold = vec3f(0.7, 0.58, 0.08);
            color = blue;
            color = mix(color, gold, corner_blend);
            color = mix(color, red, end_blend);

            let seat_id = hash(floor(seat_col), f32(row));
            color *= 0.7 + seat_id * 0.4;
            color *= 0.85 + in_row * 0.2;
            color *= fade;
          } else {
            let step_noise = hash(f32(px) * 3.1, f32(py) * 2.7);
            color = vec3f(0.06 + step_noise * 0.02, 0.05 + step_noise * 0.015, 0.08 + step_noise * 0.02);
            color *= fade;
          }
          // Arena brightness from lighting state
          color *= local_bright;
        } else {
          // Outdoor ground — render simulated state (snow, water, ice)
          let out_cell = state[idx];
          let out_ice = out_cell.y;
          let out_water = out_cell.z;
          let out_shavings = out_cell.w;

          // Base: dark ground/liner
          let ground_col = vec3f(params.ground_r, params.ground_g, params.ground_b);
          color = ground_col;

          // Ice overlay (Beer-Lambert, same as inside rink)
          if (out_ice > 0.01) {
            let d_m = out_ice * 0.001;
            let full_trans = exp(-vec3f(60.0, 6.0, 1.8) * d_m * 2.0);
            color = ground_col * full_trans;
          }

          // Illumination
          let sun_col = get_sun_color();
          let sky_col = get_sky_color();
          let sun_dir = get_sun_dir();
          let sun_up = max(sun_dir.z, 0.0);
          let direct_illum = sun_col * sun_up * 0.6;
          let sky_illum = sky_col * 0.35 + vec3f(0.02);
          color *= (direct_illum + sky_illum);
          color += ground_col * g_light * 0.5;

          // Water overlay
          if (out_water > 0.01) {
            let w_alpha = clamp(out_water / 2.0, 0.0, 0.8);
            let w_abs = exp(-vec3f(225.0, 30.0, 7.5) * out_water * 0.001 * 2.0);
            let w_col = color * w_abs;
            color = mix(color, w_col, w_alpha);
          }

          // Snow/shavings overlay (density-driven)
          if (out_shavings > 0.05) {
            let pile_coverage = clamp(out_shavings / 2.0, 0.0, 0.98);
            let osur_s2 = state2[idx];
            let osur_density = max(osur_s2.x, 50.0);
            let osur_lwc = osur_s2.y;
            let osur_mud = osur_s2.z;
            let osur_dfrac = clamp((osur_density - 50.0) / 850.0, 0.0, 1.0);
            let albedo = mix(0.88, 0.30, osur_dfrac) * (1.0 - osur_lwc * 0.4);
            let osur_efold = mix(3.0, 0.5, osur_dfrac);
            let opacity = 1.0 - exp(-out_shavings / osur_efold);
            let osur_mf = clamp(osur_mud / 2.0, 0.0, 0.6);
            let osur_mt = mix(vec3f(1.0), vec3f(0.45, 0.35, 0.20), osur_mf);
            let snow_illum = vec3f(albedo) * osur_mt * (direct_illum + sky_illum + g_light * 0.5);
            let noise = hash(f32(px), f32(py));
            let snow_final = snow_illum * (0.92 + noise * 0.08);
            color = mix(color, snow_final, pile_coverage * opacity);
          }

          color = max(color, vec3f(0.01));

          // Blend distant outdoor ground to sky with animated clouds
          let sky_start = 8.0;
          let sky_end = 30.0;
          let sky_frac = smoothstep(sky_start, sky_end, dist);
          if (sky_frac > 0.01) {
            let dim = f32(max(params.width, params.height));
            let rx = (f32(px) - params.rink_cx) / dim;
            let ry = (f32(py) - params.rink_cy) / dim;
            let elev = max(0.08, 1.0 - sqrt(rx * rx + ry * ry) * 1.2);
            let sky_dir = normalize(vec3f(rx * 0.5, -ry * 0.5, elev));
            let bg_sky = sample_sky(sky_dir, params.time_of_day, params.sky_brightness, params.cloud_cover, true, params.anim_time);
            color = mix(color, bg_sky, sky_frac);
          }
        }
      }

      // Light fixtures (physical objects)
      draw_light_fixtures(&color, f32(px) + 0.5, f32(py) + 0.5);

      draw_crosshair(&color, px, py);
      color = aces_tonemap(color);
      return vec4f(color, 1.0);
    }

    // ---- Inside the rink ----
    let cell = state[idx];
    let temp = cell.x;
    let ice = cell.y;
    let water = cell.z;
    let shavings = cell.w;

    // Base: surface ground color (white paint for indoor pro rinks, gravel for backyard)
    let concrete_col = vec3f(params.surface_ground_r, params.surface_ground_g, params.surface_ground_b);
    var color = concrete_col;

    // Depression shadow at rink edges (backyard: stamped-in area)
    if (params.is_backyard > 0u) {
      let edge_dist = -sdf; // positive inside rink, distance from edge
      if (edge_dist > 0.0 && edge_dist < 3.0) {
        // Inner rim: darken near edge to simulate depression lip shadow
        let shadow_f = smoothstep(0.0, 3.0, edge_dist); // 0 at edge → 1 at 3 cells in
        color *= 0.75 + 0.25 * shadow_f;
      }
    }

    // === PBR Ice Column Rendering (Beer-Lambert absorption) ===
    // Ice absorption coefficients [R,G,B] per meter — physical values ×100 for mm-scale ice
    // Physical: α = [0.6, 0.06, 0.018]/m → red absorbed most → blue tint
    let ice_abs = vec3f(60.0, 6.0, 1.8);

    if (ice > 0.01) {
      let d_m = ice * 0.001; // ice thickness in meters

      // Beer-Lambert: transmittance through full ice (round-trip: down and back)
      let full_trans = exp(-ice_abs * d_m * 2.0);

      // Concrete visible through ice, tinted by absorption
      color = concrete_col * full_trans;

      // Markings painted at ~6mm depth
      if (params.show_markings > 0u && ice > 3.0) {
        let mtype = markings[idx];
        if (mtype > 0.5) {
          let mc = marking_color_visual(mtype);
          if (ice < 6.0) {
            // Paint exposed/degrading: partially visible
            let vis = (ice - 3.0) / 3.0;
            color = mix(color, mc, vis * 0.7);
          } else {
            // Paint sealed under clear ice — light absorption above paint layer
            let above_m = (ice - 6.0) * 0.001;
            let above_trans = exp(-ice_abs * above_m * 2.0);
            let tinted_mc = mc * above_trans;
            let seal = 0.5 + 0.4 * clamp((ice - 6.0) / 4.0, 0.0, 1.0);
            color = mix(color, tinted_mc, seal);
          }
        }
      }

      // Ice surface scattering (bubbles, scratches, damage → cloudy white)
      let scatter = clamp(shavings / 0.5, 0.0, 1.0) * 0.15;
      color = mix(color, vec3f(0.90, 0.93, 0.97), scatter);

      // Micro-facet glints: GGX evaluation against dominant light (crystal reflections)
      if (shavings < 0.05 && has_flag(FLAG_SPARKLE)) {
        let fh = hash(f32(px), f32(py));
        let ft = hash2(f32(px), f32(py), 17.0) * 0.1;
        let mn = normalize(vec3f(cos(fh * 6.283) * ft, sin(fh * 6.283) * ft, 1.0));
        // Choose light source: artificial light or sun
        var glint_dir: vec3f;
        var glint_col: vec3f;
        var glint_a: f32;
        if (params.light_count > 0u) {
          let l0 = params.lights[0];
          glint_dir = normalize(l0.pos - vec3f(f32(px), f32(py), 0.0));
          glint_col = l0.color;
          let hd = length(vec2f(l0.pos.x - f32(px), l0.pos.y - f32(py)));
          glint_a = select(l0.intensity * 0.4, l0.intensity * attenuation_ue4(hd, l0.radius), l0.radius > 0.0);
        } else {
          let sd = get_sun_dir();
          glint_dir = normalize(vec3f(sd.x * 0.1, sd.y * 0.1, max(sd.z, 0.1)));
          glint_col = get_sun_color();
          glint_a = max(sd.z, 0.0) * 0.6;
        }
        if (glint_a > 0.01) {
          let hv = normalize(glint_dir + vec3f(0.0, 0.0, 1.0));
          let glint_d = D_GGX(max(dot(mn, hv), 0.0), 0.004);
          let tw = sin(params.anim_time * 2.0 + fh * 6.283) * 0.5 + 0.5;
          color += glint_col * glint_d * 0.018 * glint_a * tw * 0.06;
        }
      }
    }

    // === Per-pixel lighting (light-array driven, Fresnel, wet ice, board shadow, haze) ===
    if (ice > 1.0) {
      let roughness = select(0.30, 0.05, shavings < 0.1);
      color = compute_lighting(px, py, idx, color, roughness, water);
    } else {
      // Concrete without ice: sky-tinted ambient + local light sources
      let g_lit = ground_light(f32(px) + 0.5, f32(py) + 0.5);
      let sky_ambient_c = select(
        vec3f(params.sky_brightness * 0.25 + 0.04),
        get_sky_color() * 0.3 + vec3f(0.02),
        params.is_outdoor > 0u
      );
      color *= sky_ambient_c + g_lit * 0.6;
    }

    // Drop shadows
    if (has_flag(FLAG_SHADOWS)) {
      let shadow = compute_shadow(f32(px) + 0.5, f32(py) + 0.5);
      color *= (1.0 - shadow);
    }

    // Directional surface scratches (from scratch buffer)
    if (ice > 4.0 && has_flag(FLAG_SCRATCHES)) {
      let scratch_data = scratches[idx];
      let dir_8 = scratch_data & 0xFFu;
      let density = f32((scratch_data >> 8u) & 0xFFu) / 255.0;

      if (density > 0.02) {
        // Primary direction scratches
        let angle = f32(dir_8) * 0.7854; // π/4 per direction step
        let cos_a = cos(angle);
        let sin_a = sin(angle);
        let local_x = f32(px) * cos_a + f32(py) * sin_a;
        let local_y = -f32(px) * sin_a + f32(py) * cos_a;

        // Multiple fine parallel lines
        let line_id = floor(local_y * 0.7);
        let line_noise = hash(line_id, f32(dir_8));

        if (line_noise < density) {
          let line_frac = fract(local_y * 0.7);
          if (line_frac < 0.12) {
            color = mix(color, vec3f(0.97, 0.98, 1.0), 0.12 + 0.08 * density);
          }
        }

        // Secondary direction cross-hatching
        let dir2 = (scratch_data >> 16u) & 0xFFu;
        let density2 = density * 0.5; // secondary is fainter
        if (dir2 != dir_8 && density2 > 0.02) {
          let angle2 = f32(dir2) * 0.7854;
          let cos_a2 = cos(angle2);
          let sin_a2 = sin(angle2);
          let local_y2 = -f32(px) * sin_a2 + f32(py) * cos_a2;
          let line_id2 = floor(local_y2 * 0.7);
          let line_noise2 = hash(line_id2, f32(dir2) + 100.0);

          if (line_noise2 < density2) {
            let line_frac2 = fract(local_y2 * 0.7);
            if (line_frac2 < 0.12) {
              color = mix(color, vec3f(0.97, 0.98, 1.0), 0.08 + 0.06 * density2);
            }
          }
        }
      }
    }

    // Pixel center coordinates (used by sprites below)
    let fpx = f32(px) + 0.5;
    let fpy = f32(py) + 0.5;

    // === PBR Snow/Shavings Rendering (density-driven subsurface scattering) ===
    if (shavings > 0.05) {
      let pile_depth = shavings; // mm
      let pile_coverage = clamp(pile_depth / 2.0, 0.0, 0.98);

      // Read density/lwc/mud from state2
      let s2 = state2[idx];
      let density = max(s2.x, 50.0);
      let lwc = s2.y;
      let mud_amt = s2.z;

      // Density-driven albedo: fresh snow (80) bright, slush (600+) dark
      let density_frac = clamp((density - 50.0) / (900.0 - 50.0), 0.0, 1.0);
      let base_albedo = mix(0.88, 0.30, density_frac);

      // Wet darkening from lwc
      let albedo = base_albedo * (1.0 - lwc * 0.4);

      // Mud tinting
      let mud_frac = clamp(mud_amt / 2.0, 0.0, 0.6);

      // Subsurface opacity: denser snow is more opaque
      let efold = mix(3.0, 0.5, density_frac);
      let opacity = 1.0 - exp(-pile_depth / efold);

      // Base snow color: white with subtle blue tint from skylight
      let sun_col = get_sun_color();
      let sky_col = get_sky_color();
      let sun_dir = get_sun_dir();

      // Direct illumination: sun-lit surfaces warm-tinted
      let sun_illum = sun_col * max(sun_dir.z, 0.0) * 0.5;
      // Diffuse sky illumination: blue-tinted (Rayleigh sky)
      let sky_illum = sky_col * 0.35 + vec3f(0.03);
      // Light source illumination
      var light_illum = vec3f(0.0);
      let light_count = min(params.light_count, MAX_LIGHTS);
      for (var li = 0u; li < light_count; li++) {
        let light = params.lights[li];
        let h_dist = length(vec2f(light.pos.x - fpx, light.pos.y - fpy));
        var la = light.intensity;
        if (light.radius > 0.0) {
          la *= attenuation_ue4(h_dist, light.radius);
        }
        light_illum += light.color * la * 0.3;
      }

      let total_illum = sun_illum + sky_illum + light_illum;
      // Apply mud tinting to snow color
      let mud_tint = mix(vec3f(1.0), vec3f(0.45, 0.35, 0.20), mud_frac);
      let snow_color = vec3f(albedo) * mud_tint * total_illum;

      // GGX micro-facet glints on snow/shaving crystal faces (only dry, low-density snow)
      if (pile_depth > 0.3 && has_flag(FLAG_SPARKLE) && lwc < 0.03 && density < 300.0) {
        let sfh = hash2(f32(px), f32(py), 42.7);
        let sft = hash2(f32(px), f32(py), 91.3) * 0.15;
        let smn = normalize(vec3f(cos(sfh * 6.283) * sft, sin(sfh * 6.283) * sft, 1.0));
        var sg_dir: vec3f;
        var sg_col: vec3f;
        var sg_a: f32;
        if (params.light_count > 0u) {
          let sl0 = params.lights[0];
          sg_dir = normalize(sl0.pos - vec3f(f32(px), f32(py), 0.0));
          sg_col = sl0.color;
          let shd = length(vec2f(sl0.pos.x - f32(px), sl0.pos.y - f32(py)));
          sg_a = select(sl0.intensity * 0.4, sl0.intensity * attenuation_ue4(shd, sl0.radius), sl0.radius > 0.0);
        } else {
          let ssd = get_sun_dir();
          sg_dir = normalize(vec3f(ssd.x * 0.1, ssd.y * 0.1, max(ssd.z, 0.1)));
          sg_col = get_sun_color();
          sg_a = max(ssd.z, 0.0) * 0.6;
        }
        if (sg_a > 0.01) {
          let shv = normalize(sg_dir + vec3f(0.0, 0.0, 1.0));
          let sg_d = D_GGX(max(dot(smn, shv), 0.0), 0.006);
          let stw = sin(params.anim_time * 2.5 + sfh * 6.283) * 0.5 + 0.5;
          color += sg_col * sg_d * 0.02 * sg_a * stw * pile_coverage * 0.08;
        }
      }

      // Granular texture: per-pixel noise for snow grain structure
      let grain_noise = hash(f32(px) * 1.7, f32(py) * 1.3);
      let grain_variation = 1.0 - grain_noise * 0.08;

      // Blend snow onto underlying surface
      color = mix(color, snow_color * grain_variation, opacity * pile_coverage);
    }

    // === PBR Water Rendering ===
    // Water absorption coefficients [R,G,B] per meter — ×500 exaggeration for mm-scale
    // Physical: [0.45, 0.06, 0.015]/m → mostly transparent at rink depths
    let water_abs = vec3f(225.0, 30.0, 7.5);

    if (water > 0.01) {
      let wd_m = water * 0.001; // depth in meters

      // Beer-Lambert absorption: light passes through water round-trip
      let w_trans = exp(-water_abs * wd_m * 2.0);
      // Surface below water is tinted by absorption (slight blue shift at depth)
      color *= w_trans;

      // Thin-film iridescence hint for very shallow water films (<0.3mm)
      // Use low spatial frequency to avoid moiré at 1px/cell resolution
      if (water > 0.03 && water < 0.3 && has_flag(FLAG_THIN_FILM)) {
        let film_t = (water - 0.03) / 0.27; // 0..1 across the range
        let phase = film_t * 6.283; // single smooth color cycle across depth range
        let tf_r = 0.5 + 0.5 * sin(phase);
        let tf_g = 0.5 + 0.5 * sin(phase + 2.094);
        let tf_b = 0.5 + 0.5 * sin(phase + 4.189);
        let film_strength = 0.1 * (1.0 - abs(film_t * 2.0 - 1.0)); // peak at mid-range
        color = mix(color, vec3f(tf_r, tf_g, tf_b), film_strength);
      }

      // Meniscus: detect water→dry boundary from neighbors (soft transitions)
      var w_boundary_strength = 0.0;
      var w_grad = 0.0;
      let w_self = smoothstep(0.02, 0.1, water); // how "wet" is this cell
      if (px > 0u && mask[idx - 1u] > 0.5) {
        let nd = state[idx - 1u].z;
        w_grad += abs(water - nd);
        let dry_n = 1.0 - smoothstep(0.0, 0.03, nd); // 1 when neighbor dry
        w_boundary_strength = max(w_boundary_strength, dry_n * w_self);
      }
      if (px < params.width - 1u && mask[idx + 1u] > 0.5) {
        let nd = state[idx + 1u].z;
        w_grad += abs(water - nd);
        let dry_n = 1.0 - smoothstep(0.0, 0.03, nd);
        w_boundary_strength = max(w_boundary_strength, dry_n * w_self);
      }
      if (py > 0u && mask[idx - params.width] > 0.5) {
        let nd = state[idx - params.width].z;
        w_grad += abs(water - nd);
        let dry_n = 1.0 - smoothstep(0.0, 0.03, nd);
        w_boundary_strength = max(w_boundary_strength, dry_n * w_self);
      }
      if (py < params.height - 1u && mask[idx + params.width] > 0.5) {
        let nd = state[idx + params.width].z;
        w_grad += abs(water - nd);
        let dry_n = 1.0 - smoothstep(0.0, 0.03, nd);
        w_boundary_strength = max(w_boundary_strength, dry_n * w_self);
      }
      // Meniscus bright edge (total internal reflection at contact line)
      color = mix(color, vec3f(0.88, 0.92, 1.0), w_boundary_strength * 0.2);
      let edge_intensity = clamp(w_grad / 2.0, 0.0, 0.25);
      color = mix(color, vec3f(0.5, 0.6, 0.85), edge_intensity);

      // Schlick Fresnel reflection (R0=0.020 for water, n=1.33)
      if (has_flag(FLAG_REFLECTIONS)) {
        let w = params.width;
        let h = params.height;
        let at = params.anim_time;
        // Water surface normal from depth gradient + animated ripples
        let wc = water;
        let wl = select(wc, state[idx - 1u].z, px > 0u);
        let wr = select(wc, state[idx + 1u].z, px < w - 1u);
        let wu = select(wc, state[idx - w].z, py > 0u);
        let wd_n = select(wc, state[idx + w].z, py < h - 1u);
        let grad_x = (wr - wl) * 0.3;
        let grad_y = (wd_n - wu) * 0.3;
        let ripple_x = sin(f32(px) * 0.08 + at * 1.8) * sin(f32(py) * 0.05 + at * 1.1) * 0.05;
        let ripple_y = sin(f32(px) * 0.05 - at * 1.4) * sin(f32(py) * 0.08 + at * 2.0) * 0.05;
        let water_n = normalize(vec3f(-grad_x + ripple_x, -grad_y + ripple_y, 1.0));
        let w_view = vec3f(0.0, 0.0, 1.0);
        let w_reflect = reflect(-w_view, water_n);
        let w_ndotv = max(dot(water_n, w_view), 0.0);
        // Schlick Fresnel: R0 = ((n1-n2)/(n1+n2))² = ((1-1.33)/(1+1.33))² ≈ 0.020
        let f0_water = 0.020;
        let w_fresnel = f0_water + (1.0 - f0_water) * pow(1.0 - w_ndotv, 5.0);
        let w_is_outdoor = params.is_outdoor > 0u;
        let w_sky = sample_sky(w_reflect, params.time_of_day, params.sky_brightness, params.cloud_cover, w_is_outdoor, at);
        let depth_coverage = clamp(water / 1.0, 0.0, 1.0);
        color += w_sky * w_fresnel * depth_coverage;

        // Per-light Cook-Torrance GGX specular on water surface
        let w_alpha = 0.02; // water roughness (near-mirror)
        let w_ndotv_s = max(dot(water_n, w_view), 0.001);
        let light_count = min(params.light_count, MAX_LIGHTS);
        for (var li = 0u; li < light_count; li++) {
          let light = params.lights[li];
          let to_light = light.pos - vec3f(f32(px), f32(py), 0.0);
          let light_dir = normalize(to_light);
          let half_vec = normalize(light_dir + w_view);
          let ndoth = max(dot(water_n, half_vec), 0.0);
          let ndotl_w = max(dot(water_n, light_dir), 0.001);
          let vdoth_w = max(dot(w_view, half_vec), 0.0);
          let h_dist = length(vec2f(light.pos.x - f32(px), light.pos.y - f32(py)));
          var spec_atten = light.intensity;
          if (light.radius > 0.0) {
            spec_atten *= attenuation_ue4(h_dist, light.radius);
          }
          // Cook-Torrance: D×G×F / (4×n·v×n·l)
          let wD = D_GGX(ndoth, w_alpha);
          let wG = G_Smith(w_ndotv_s, ndotl_w, w_alpha);
          let wF = F_Schlick(vdoth_w, f0_water);
          let water_spec = wD * wG * wF / (4.0 * w_ndotv_s * ndotl_w + 0.001);
          color += light.color * water_spec * ndotl_w * spec_atten * depth_coverage;
        }
      }
    }

    // Goal nets (from sprite buffer) — rendered on top of ice/snow/water
    let gl = read_sprite(SLOT_GOAL_LEFT);
    let gr = read_sprite(SLOT_GOAL_RIGHT);
    draw_goal_net_sprite(&color, fpx, fpy, gl);
    draw_goal_net_sprite(&color, fpx, fpy, gr);

    // Pipe overlay
    let flow_pos = pipes[idx];
    if (params.show_pipes > 0u && flow_pos > 0.0) {
      let pipe_color = mix(vec3f(0.2, 0.5, 1.0), vec3f(1.0, 0.3, 0.2), flow_pos);
      color = mix(color, pipe_color, 0.15);
    }

    // Zamboni/Shovel (from sprite buffer)
    draw_zamboni_sprite(&color, fpx, fpy, zs);

    // Particles (water/snow gun)
    draw_particles(&color, fpx, fpy);

    // Skater sprites (from sprite buffer)
    draw_skaters(&color, fpx, fpy);

    // Light fixtures (physical objects)
    draw_light_fixtures(&color, f32(px) + 0.5, f32(py) + 0.5);

    // Backyard: blend far cells to sky with animated clouds
    if (params.is_backyard > 0u && sdf > 0.0) {
      let by_sky_start = 4.0;
      let by_sky_end = 20.0;
      let by_sky_frac = smoothstep(by_sky_start, by_sky_end, sdf);
      if (by_sky_frac > 0.01) {
        let dim = f32(max(params.width, params.height));
        let rx = (f32(px) - params.rink_cx) / dim;
        let ry = (f32(py) - params.rink_cy) / dim;
        let elev = max(0.08, 1.0 - sqrt(rx * rx + ry * ry) * 1.2);
        let sky_dir = normalize(vec3f(rx * 0.5, -ry * 0.5, elev));
        let bg_sky = sample_sky(sky_dir, params.time_of_day, params.sky_brightness, params.cloud_cover, true, params.anim_time);
        color = mix(color, bg_sky, by_sky_frac);
      }
    }

    // Cross-section crosshair
    draw_crosshair(&color, px, py);

    color = aces_tonemap(color);
    return vec4f(color, 1.0);
  }
}
