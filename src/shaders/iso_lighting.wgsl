// Isometric 3D renderer — shadows and attenuation

// UE4-style windowed attenuation
fn attenuation_ue4(dist: f32, radius: f32) -> f32 {
  let d_r = dist / max(radius, 1.0);
  let d_r2 = d_r * d_r;
  let window = clamp(1.0 - d_r2 * d_r2, 0.0, 1.0);
  return window * window;
}

// ---- Shadows ----

fn shadow_for_light(world_pos: vec3f, light_pos: vec3f) -> f32 {
  let to_light = light_pos - world_pos;
  let light_dist = length(to_light);
  if (light_dist < 1.0) { return 1.0; }
  let dir = to_light / light_dist;

  var shadow = 1.0;
  let steps = 16;
  for (var i = 1; i < steps; i++) {
    let t = f32(i) / f32(steps) * min(light_dist, 100.0);
    let sp = world_pos + dir * t;
    let sx = i32(sp.x);
    let sy = i32(sp.z);
    if (sx >= 0 && sx < i32(params.width) && sy >= 0 && sy < i32(params.height)) {
      let th = cell_height(u32(sx), u32(sy));
      if (th > sp.y + 0.1) {
        shadow = 0.3;
        break;
      }
    }
  }
  return shadow;
}

fn shadow_for_sun(world_pos: vec3f, sun_dir: vec3f) -> f32 {
  var shadow = 1.0;
  let steps = 16;
  for (var i = 1; i < steps; i++) {
    let t = f32(i) * 2.0;
    let sp = world_pos + sun_dir * t;
    let sx = i32(sp.x);
    let sy = i32(sp.z);
    if (sx >= 0 && sx < i32(params.width) && sy >= 0 && sy < i32(params.height)) {
      let th = cell_height(u32(sx), u32(sy));
      if (th > sp.y + 0.05) {
        shadow = 0.3;
        break;
      }
    }
  }
  return shadow;
}
