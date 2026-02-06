// ================================================================
// Sprites — marking colors, goal nets, light fixtures, zamboni, skaters, particles
// ================================================================

// ---- Vivid marking colors ----
fn marking_color_visual(mtype: f32) -> vec3f {
  if (mtype < 1.5) { return vec3f(0.9, 0.08, 0.08); }
  if (mtype < 2.5) { return vec3f(0.08, 0.15, 0.9); }
  if (mtype < 3.5) { return vec3f(0.9, 0.08, 0.08); }
  if (mtype < 4.5) { return vec3f(0.15, 0.35, 0.9); }
  if (mtype < 5.5) { return vec3f(0.08, 0.15, 0.9); }
  if (mtype < 6.5) { return vec3f(0.9, 0.08, 0.08); }
  return vec3f(0.95, 0.95, 0.97); // white paint (type 7)
}

// ---- Goal net rendering (from sprite) ----
fn draw_goal_net_sprite(color: ptr<function, vec3f>, fpx: f32, fpy: f32, gs: Sprite) {
  let st = sprite_type(gs);
  if (st != SPRITE_GOAL_LEFT && st != SPRITE_GOAL_RIGHT) { return; }

  let goal_off = gs.aux0;
  let net_hw = goal_off * 0.273;
  let net_depth = goal_off * 0.334;
  let goal_dir = gs.dir;
  let goal_x = gs.x;
  let cy = gs.y;

  let dx = (fpx - goal_x) * goal_dir;
  let dy = fpy - cy;
  let depth_frac = clamp(dx / max(net_depth, 1.0), 0.0, 1.0);
  let hw_at_depth = mix(net_hw, net_hw * 0.6, depth_frac);

  if (dx >= -1.0 && dx < net_depth + 0.5 && abs(dy) < hw_at_depth + 1.0) {
    if (abs(dy) <= hw_at_depth) {
      let is_post = dx >= -1.0 && dx < 1.0 && abs(dy) > net_hw - 2.0;
      let is_back = dx > net_depth - 1.5 && dx < net_depth + 0.5;
      let is_side = abs(abs(dy) - hw_at_depth) < 1.2 && dx >= 0.0;
      if (is_post || is_back || is_side) {
        *color = vec3f(0.85, 0.12, 0.12);
      } else if (dx > 0.5) {
        let check = (u32(fpx) + u32(fpy)) % 2u;
        if (check == 0u) {
          *color = mix(*color, vec3f(0.88, 0.90, 0.93), 0.5);
        }
      }
    }
  }
}

// ---- Light fixtures (physical objects, always visible in visual mode) ----
fn draw_light_fixtures(color: ptr<function, vec3f>, fpx: f32, fpy: f32) {
  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];

    // Skip directional lights (sun/moon) — not physical fixtures
    if (light.radius == 0.0) { continue; }

    let dx = fpx - light.pos.x;
    let dy = fpy - light.pos.y;
    let dist = sqrt(dx * dx + dy * dy);

    // Classify fixture type by height
    if (light.pos.z > 40.0) {
      // Indoor overhead bank: bright 10×5 rectangular glow
      let rx = abs(dx);
      let ry = abs(dy);
      if (rx < 5.0 && ry < 2.5) {
        let edge = max(rx / 5.0, ry / 2.5);
        let glow = (1.0 - edge) * light.intensity;
        *color = mix(*color, light.color * 1.4, clamp(glow, 0.0, 0.95));
      }
      // Soft halo around fixture
      if (dist < 12.0) {
        let halo = (1.0 - dist / 12.0) * light.intensity * 0.15;
        *color = mix(*color, light.color, clamp(halo, 0.0, 0.4));
      }
    } else if (light.pos.z > 15.0) {
      // Outdoor floodlight: circular bright spot
      if (dist < 4.0) {
        let glow = (1.0 - dist / 4.0) * light.intensity;
        *color = mix(*color, light.color * 1.3, clamp(glow, 0.0, 0.95));
      }
      // Halo
      if (dist < 10.0) {
        let halo = (1.0 - dist / 10.0) * light.intensity * 0.12;
        *color = mix(*color, light.color, clamp(halo, 0.0, 0.35));
      }
    } else {
      // String light: small warm amber dot
      if (dist < 2.0) {
        let glow = (1.0 - dist / 2.0) * light.intensity;
        *color = mix(*color, vec3f(1.0, 0.9, 0.5) * 1.2, clamp(glow, 0.0, 0.9));
      }
      // Tiny halo
      if (dist < 5.0) {
        let halo = (1.0 - dist / 5.0) * light.intensity * 0.08;
        *color = mix(*color, vec3f(1.0, 0.9, 0.5), clamp(halo, 0.0, 0.2));
      }
    }

    // Selection ring (only in light tool mode)
    if (params.light_tool_active > 0u && params.selected_light == i32(i)) {
      let ring_r = select(6.0, select(5.0, 3.0, light.pos.z <= 15.0), light.pos.z > 40.0);
      let ring_thick = 0.8;
      let ring_dist = abs(dist - ring_r);
      if (ring_dist < ring_thick) {
        // Animated dashed effect
        let angle = atan2(dy, dx);
        let dash = sin(angle * 8.0 + params.anim_time * 4.0);
        if (dash > 0.0) {
          let ring_alpha = (1.0 - ring_dist / ring_thick) * 0.8;
          *color = mix(*color, vec3f(1.0, 0.85, 0.2), ring_alpha);
        }
      }
    }
  }
}

// ---- Crosshair ----
fn draw_crosshair(color: ptr<function, vec3f>, px: u32, py: u32) {
  if (params.show_cross_line > 0u) {
    let cy = params.cross_y;
    let cx = params.cross_x;
    if (py == cy || py == cy + 1u) {
      *color = mix(*color, vec3f(1.0, 1.0, 0.3), 0.35);
    }
    if (px == cx || px == cx + 1u) {
      *color = mix(*color, vec3f(1.0, 1.0, 0.3), 0.35);
    }
  }
}

// ---- Zamboni/Shovel rendering from sprite ----
fn draw_zamboni_sprite(color: ptr<function, vec3f>, fpx: f32, fpy: f32, zs: Sprite) {
  let zt = sprite_type(zs);
  if (zt != SPRITE_ZAMBONI && zt != SPRITE_SHOVEL && zt != SPRITE_WATER_TANK) { return; }

  let zv = zamboni_hit(fpx, fpy, zs);
  let along = zv.x;
  let dy = zv.y;
  let hw = zs.width * 0.5;
  let zl = zs.height;
  let blade_down = zs.aux1 > 0.5;

  if (abs(dy) < hw && along >= 0.0 && along < zl) {
    if (zt == SPRITE_ZAMBONI) {
      let on_edge = (abs(dy) > hw - 1.2) || (along < 1.2) || (along > zl - 1.2);
      if (on_edge) {
        *color = vec3f(0.1, 0.1, 0.12);
      } else if (along > zl * 0.75) {
        // Blade zone: tint lighter when retracted
        var blade_col = vec3f(0.25, 0.35, 0.6);
        if (!blade_down) { blade_col = mix(blade_col, vec3f(0.5, 0.55, 0.6), 0.3); }
        *color = blade_col;
        // Headlights: brighter at night
        if (along > zl - 3.0 && abs(dy) < hw * 0.4) {
          let hl_pos = abs(dy) / (hw * 0.4);
          if (hl_pos > 0.3 && hl_pos < 0.85) {
            let hl_bright = mix(1.0, 1.5, 1.0 - params.sky_brightness);
            *color = vec3f(1.0, 0.95, 0.5) * hl_bright;
          }
        }
      } else if (along > zl * 0.55) {
        *color = vec3f(0.62, 0.65, 0.68);
      } else if (along > 3.0) {
        *color = vec3f(0.45, 0.48, 0.52);
      } else {
        *color = vec3f(0.25, 0.25, 0.28);
      }
    } else if (zt == SPRITE_WATER_TANK) {
      // Water tank: boxy rusty-metal body
      let on_edge = (abs(dy) > hw - 1.0) || (along < 1.0) || (along > zl - 1.0);
      if (on_edge) {
        *color = vec3f(0.15, 0.12, 0.08); // dark frame
      } else if (along > zl * 0.7) {
        // Rear water tank body: rusty metal
        *color = vec3f(0.45, 0.28, 0.15);
        // Nozzle spots at rear
        let nozzle_y = abs(dy) / hw;
        if (along < zl * 0.8 && (nozzle_y < 0.2 || (nozzle_y > 0.4 && nozzle_y < 0.6) || nozzle_y > 0.8)) {
          *color = vec3f(0.2, 0.2, 0.22); // nozzle outlets
          // Water spray hint when active
          if (blade_down && along < zl * 0.75) {
            *color = mix(*color, vec3f(0.4, 0.6, 0.85), 0.4);
          }
        }
      } else if (along > zl * 0.3) {
        // Tank section: dull metal
        *color = vec3f(0.38, 0.35, 0.30);
      } else {
        // Front: hitch area
        *color = vec3f(0.30, 0.28, 0.25);
      }
    } else {
      // Shovel
      let blade_zone = along > zl * 0.8;
      if (blade_zone) {
        *color = vec3f(0.5, 0.52, 0.55);
      } else {
        *color = vec3f(0.45, 0.3, 0.15);
      }
      let on_edge = (abs(dy) > hw - 0.8) || (along < 0.8) || (along > zl - 0.8);
      if (on_edge) { *color *= 0.6; }
    }
    // PBR lighting on sprite body
    *color = sprite_light(fpx, fpy, *color);
  }
}

// ---- Zamboni rendering for thermal mode (simpler) ----
fn draw_zamboni_thermal(color: ptr<function, vec3f>, fpx: f32, fpy: f32, zs: Sprite) {
  let zt = sprite_type(zs);
  if (zt != SPRITE_ZAMBONI && zt != SPRITE_SHOVEL && zt != SPRITE_WATER_TANK) { return; }

  let zv = zamboni_hit(fpx, fpy, zs);
  let along = zv.x;
  let dy = zv.y;
  let hw = zs.width * 0.5;
  let zl = zs.height;

  if (abs(dy) < hw && along >= 0.0 && along < zl) {
    *color = mix(*color, vec3f(0.4, 0.45, 0.5), 0.85);
  }
}

// ---- Skater rendering from sprite ----
fn draw_skaters(color: ptr<function, vec3f>, fpx: f32, fpy: f32) {
  let sk_count = min(sprite_count(), 32u);
  if (sk_count == 0u) { return; }

  for (var si = 0u; si < sk_count; si++) {
    let sp = read_sprite(SLOT_SKATER_BASE + si);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE) { continue; }

    let sk_x = sp.x;
    let sk_y = sp.y;
    let sk_dir = sp.dir;
    let sk_team = sprite_team(sp);

    let sdx = fpx - sk_x;
    let sdy = fpy - sk_y;
    let sdist = max(abs(sdx), abs(sdy));

    if (sdist < 3.5) {
      if (st == SPRITE_SKATER_HOCKEY) {
        if (sdist < 1.5) {
          if (sk_team == 0u) {
            *color = vec3f(0.85, 0.15, 0.15);
          } else {
            *color = vec3f(0.15, 0.25, 0.85);
          }
          if (sdist < 0.6) { *color *= 0.5; }
          *color = sprite_light(fpx, fpy, *color);
        } else {
          let stick_dx = cos(sk_dir);
          let stick_dy = sin(sk_dir);
          let stick_along = sdx * stick_dx + sdy * stick_dy;
          let stick_perp = abs(sdx * stick_dy - sdy * stick_dx);
          if (stick_along > 0.5 && stick_along < 3.0 && stick_perp < 0.7) {
            *color = vec3f(0.35, 0.25, 0.12);
          }
        }
      } else if (st == SPRITE_SKATER_FIGURE) {
        if (sdist < 1.2) {
          let sk_hash = fract(sin(f32(si) * 73.1 + 17.3) * 43758.5);
          if (sk_hash < 0.33) {
            *color = vec3f(0.75, 0.45, 0.7);
          } else if (sk_hash < 0.66) {
            *color = vec3f(0.4, 0.7, 0.75);
          } else {
            *color = vec3f(0.8, 0.65, 0.3);
          }
          if (sdist < 0.5) { *color *= 0.6; }
          *color = sprite_light(fpx, fpy, *color);
        }
        let trail_dx = -cos(sk_dir);
        let trail_dy = -sin(sk_dir);
        let trail_along = sdx * trail_dx + sdy * trail_dy;
        let trail_perp = abs(sdx * trail_dy - sdy * trail_dx);
        if (trail_along > 0.5 && trail_along < 3.0 && trail_perp < 0.5) {
          let spark = hash(fpx, fpy);
          if (spark > 0.75) {
            *color = mix(*color, vec3f(1.0, 1.0, 1.0), 0.3);
          }
        }
      } else if (st == SPRITE_SKATER_PUBLIC) {
        if (sdist < 1.3) {
          let r = fract(sin(f32(si) * 7.3 + 13.1) * 43758.5);
          let g = fract(sin(f32(si) * 7.3 + 14.8) * 43758.5);
          let b = fract(sin(f32(si) * 7.3 + 16.5) * 43758.5);
          *color = vec3f(0.25 + r * 0.55, 0.25 + g * 0.55, 0.25 + b * 0.55);
          if (sdist < 0.5) { *color *= 0.5; }
          *color = sprite_light(fpx, fpy, *color);
        }
      }
    }
  }
}

// ---- Particle rendering ----
fn draw_particles(color: ptr<function, vec3f>, fpx: f32, fpy: f32) {
  let p_count = min(particle_data[0], 512u);
  if (p_count == 0u) { return; }

  for (var i = 0u; i < p_count; i++) {
    let base = 4u + i * 4u;
    let px = bitcast<f32>(particle_data[base + 0u]);
    let py = bitcast<f32>(particle_data[base + 1u]);
    let pz = bitcast<f32>(particle_data[base + 2u]);
    let info = particle_data[base + 3u];
    let ptype = info & 0xFFFFu; // 0=water, 1=snow, 2=snowball, 3=weather_snow, 4=weather_rain
    let variation = f32((info >> 16u) & 0xFFu) / 255.0;

    let dx = fpx - px;
    let dy = fpy - py;
    let dist2 = dx * dx + dy * dy;

    if (ptype == 3u) {
      // Weather snow: grows as it approaches ground, fades in
      let size = 0.8 + (25.0 - clamp(pz, 0.0, 25.0)) * 0.06;
      if (dist2 < size * size) {
        let alpha = (1.0 - sqrt(dist2) / size) * (0.3 + (1.0 - clamp(pz / 25.0, 0.0, 1.0)) * 0.5);
        let snow_col = vec3f(0.92 + variation * 0.04, 0.94 + variation * 0.03, 0.97);
        *color = mix(*color, snow_col, alpha * 0.85);
      }
    } else if (ptype == 4u) {
      // Weather rain: elongated vertical streak
      let size_x = 0.5;
      let size_y = 1.5 + clamp(pz, 0.0, 30.0) * 0.05;
      if (abs(dx) < size_x && abs(dy) < size_y) {
        let t = max(abs(dx) / size_x, abs(dy) / size_y);
        let alpha = (1.0 - t) * (0.15 + (1.0 - clamp(pz / 30.0, 0.0, 1.0)) * 0.25);
        *color = mix(*color, vec3f(0.6, 0.65, 0.75), alpha * 0.7);
      }
    } else {
      // Tool particles: water(0), snow(1), snowball(2)
      let base_size = select(1.2, 2.0, ptype == 2u);
      let size = base_size + pz * 0.1;
      if (dist2 < size * size) {
        let alpha = (1.0 - sqrt(dist2) / size) * clamp(1.0 - pz * 0.08, 0.3, 1.0);
        if (ptype == 0u) {
          // Water: blue-cyan dot
          *color = mix(*color, vec3f(0.3, 0.6, 0.95), alpha * 0.8);
        } else if (ptype == 2u) {
          // Snowball: white-grey with color variation
          let grey = 0.90 + variation * 0.05;
          *color = mix(*color, vec3f(grey, grey + 0.01, grey + 0.02), alpha * 0.9);
        } else {
          // Snow: white dot
          *color = mix(*color, vec3f(0.95, 0.97, 1.0), alpha * 0.85);
        }
      }

      // Ground shadow for tool particles with z > 1 (no shadow for weather)
      if (pz > 1.0) {
        let shadow_dist2 = (fpx - px) * (fpx - px) + (fpy - py - pz * 0.3) * (fpy - py - pz * 0.3);
        if (shadow_dist2 < 1.5) {
          let shadow_alpha = (1.0 - sqrt(shadow_dist2) / 1.2) * 0.1;
          *color *= (1.0 - shadow_alpha);
        }
      }
    }
  }
}
