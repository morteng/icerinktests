struct CrossParams {
  width: u32,
  height: u32,
  cursor_x: u32,
  cursor_y: u32,
  canvas_w: u32,
  canvas_h: u32,
  is_outdoor: u32,
  has_marking: u32,
  // Layer top positions (computed on CPU, "not to scale" layout)
  ly_paint_bot: f32,   // top of base ice / bottom of paint
  ly_paint_top: f32,   // top of paint / bottom of upper ice
  ly_ice_top: f32,     // top of all ice
  ly_water_top: f32,   // top of water
  ly_snow_top: f32,    // top of snow
  ground_type: u32,    // 0=concrete, 1=grass, 2=gravel, 3=asphalt
  has_pipes: u32,      // 0=no pipes, 1=has pipes
  _pad4: f32,
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var<uniform> params: CrossParams;
@group(0) @binding(1) var<storage, read> state: array<vec4f>;
@group(0) @binding(2) var<storage, read> pipes: array<f32>;
@group(0) @binding(3) var<storage, read> markings: array<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 6>(
    vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
    vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),
  );
  var out: VSOut;
  let p = positions[vi];
  out.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(p.x, 1.0 - p.y);
  return out;
}

fn temp_to_concrete_color(t: f32) -> vec3f {
  if (t < -5.0) {
    return vec3f(0.25, 0.3, 0.45);
  } else if (t < 0.0) {
    let s = (t + 5.0) / 5.0;
    return mix(vec3f(0.25, 0.3, 0.45), vec3f(0.4, 0.4, 0.42), s);
  } else {
    let s = clamp(t / 15.0, 0.0, 1.0);
    return mix(vec3f(0.4, 0.4, 0.42), vec3f(0.5, 0.38, 0.32), s);
  }
}

fn ground_color(t: f32) -> vec3f {
  let gt = params.ground_type;
  if (gt == 1u) {
    // Grass: green-brown earth, temperature-tinted (colder=duller)
    let warmth = clamp((t + 5.0) / 20.0, 0.0, 1.0);
    return mix(vec3f(0.18, 0.20, 0.10), vec3f(0.25, 0.32, 0.14), warmth);
  } else if (gt == 2u) {
    // Gravel: gray-brown with subtle temperature shift
    let warmth = clamp((t + 5.0) / 20.0, 0.0, 1.0);
    return mix(vec3f(0.35, 0.33, 0.28), vec3f(0.45, 0.42, 0.38), warmth);
  } else if (gt == 3u) {
    // Asphalt: dark gray
    let warmth = clamp((t + 5.0) / 20.0, 0.0, 1.0);
    return mix(vec3f(0.14, 0.14, 0.16), vec3f(0.20, 0.20, 0.22), warmth);
  }
  // Default: concrete
  return temp_to_concrete_color(t);
}

fn marking_color(mtype: f32) -> vec3f {
  if (mtype < 1.5) { return vec3f(0.85, 0.1, 0.1); }
  if (mtype < 2.5) { return vec3f(0.1, 0.2, 0.85); }
  if (mtype < 3.5) { return vec3f(0.85, 0.1, 0.1); }
  if (mtype < 4.5) { return vec3f(0.2, 0.4, 0.85); }
  if (mtype < 5.5) { return vec3f(0.1, 0.2, 0.85); }
  return vec3f(0.85, 0.1, 0.1);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let depth = 1.0 - in.uv.y;  // 0=bottom, 1=top
  let across = in.uv.x;

  let gx = clamp(params.cursor_x, 0u, params.width - 1u);
  let gy = clamp(params.cursor_y, 0u, params.height - 1u);
  let idx = gy * params.width + gx;

  let cell = state[idx];
  let temp = cell.x;
  let ice_mm = cell.y;
  let water_mm = cell.z;
  let flow_pos = pipes[idx];
  let mtype = markings[idx];

  // --- Fixed zones ---
  let pipe_bottom = 0.28;
  let pipe_top    = 0.38;
  let surface     = 0.42;

  // --- Dynamic zones from CPU-computed layout ---
  let paint_bot  = params.ly_paint_bot;
  let paint_top  = params.ly_paint_top;
  let ice_top    = params.ly_ice_top;
  let water_top  = params.ly_water_top;
  let snow_top   = params.ly_snow_top;
  let has_mark   = params.has_marking > 0u;

  var color = vec3f(0.06, 0.06, 0.10); // default: air

  // === GROUND BASE ===
  if (depth < pipe_bottom) {
    color = ground_color(temp);
    let grain = fract(depth * 200.0);
    if (grain < 0.03) {
      color *= 0.92;
    }
  }
  // === PIPE ZONE (or ground if no pipes) ===
  else if (depth < pipe_top) {
    color = ground_color(temp);

    if (params.has_pipes > 0u && flow_pos > 0.0) {
      let pipe_cy = (pipe_bottom + pipe_top) * 0.5;
      let r_px = 12.0;
      let dy_px = (depth - pipe_cy) * f32(params.canvas_h);
      let dx_px = (across - 0.5) * f32(params.canvas_w);
      let dist = sqrt(dx_px * dx_px + dy_px * dy_px);

      if (dist < r_px + 2.5) {
        if (dist > r_px - 2.0) {
          color = vec3f(0.55, 0.55, 0.60);
        } else {
          let coolant = mix(vec3f(0.15, 0.4, 0.95), vec3f(0.95, 0.25, 0.15), flow_pos);
          let inner_frac = dist / max(r_px - 2.0, 1.0);
          color = mix(coolant * 1.1, coolant * 0.85, inner_frac);
        }
      }
    }
  }
  // === SURFACE GAP ===
  else if (depth < surface) {
    color = ground_color(temp);
  }
  // === BASE ICE (below paint, only when marking present) ===
  else if (depth < paint_bot && has_mark) {
    let frac = (depth - surface) / max(paint_bot - surface, 0.001);
    color = mix(vec3f(0.72, 0.86, 0.96), vec3f(0.82, 0.90, 0.98), frac);
  }
  // === PAINT STRIPE ===
  else if (depth < paint_top && has_mark) {
    let mc = marking_color(mtype);
    var mark_alpha: f32;
    if (ice_mm < 6.0) {
      mark_alpha = 0.4 * (ice_mm - 3.0) / 3.0;
    } else if (ice_mm < 10.0) {
      mark_alpha = 0.4 + 0.35 * (ice_mm - 6.0) / 4.0;
    } else {
      mark_alpha = 0.75;
    }
    // Paint on ice background
    let ice_bg = vec3f(0.85, 0.92, 0.98);
    color = mix(ice_bg, mc, mark_alpha);
  }
  // === UPPER ICE (above paint, or all ice when no marking) ===
  else if (depth < ice_top) {
    let base = select(surface, paint_top, has_mark);
    let frac = (depth - base) / max(ice_top - base, 0.001);
    color = mix(vec3f(0.78, 0.90, 0.98), vec3f(0.92, 0.96, 1.0), frac);
  }
  // === WATER LAYER ===
  else if (depth < water_top) {
    let frac = (depth - ice_top) / max(water_top - ice_top, 0.001);
    color = mix(vec3f(0.18, 0.38, 0.78), vec3f(0.12, 0.28, 0.62), frac);
    let shimmer = sin(across * 40.0 + depth * 200.0) * 0.05;
    color += vec3f(shimmer, shimmer, shimmer * 1.5);
  }
  // === SNOW / SHAVINGS LAYER ===
  else if (depth < snow_top) {
    let noise = fract(sin(across * 127.1 + depth * 311.7) * 43758.5453);
    let noise2 = fract(sin(across * 269.3 + depth * 183.1) * 28461.7231);
    if (params.is_outdoor > 0u) {
      // Outdoor: fluffy snow look
      color = mix(vec3f(0.85, 0.88, 0.92), vec3f(0.95, 0.97, 1.0), noise * 0.6);
      if (noise2 > 0.92) {
        color = vec3f(1.0, 1.0, 1.0);
      }
    } else {
      // Indoor: ice shavings — speckled white/translucent chips
      color = mix(vec3f(0.78, 0.82, 0.88), vec3f(0.92, 0.95, 0.98), noise);
      // Sharper speckle pattern for chipped ice look
      if (noise2 > 0.75) {
        color = vec3f(0.96, 0.98, 1.0);
      } else if (noise2 < 0.15) {
        color = vec3f(0.65, 0.70, 0.78);
      }
    }
  }

  // === Separator lines ===
  let line_w = 1.5 / f32(params.canvas_h);

  if (abs(depth - pipe_bottom) < line_w) {
    color = mix(color, vec3f(0.5, 0.5, 0.55), 0.3);
  }
  if (abs(depth - surface) < line_w * 1.5) {
    color = mix(color, vec3f(0.65, 0.65, 0.7), 0.5);
  }
  // Paint boundaries
  if (has_mark && paint_top > paint_bot + 0.001) {
    if (abs(depth - paint_bot) < line_w) {
      color = mix(color, vec3f(0.6, 0.4, 0.3), 0.4);
    }
    if (abs(depth - paint_top) < line_w) {
      color = mix(color, vec3f(0.6, 0.4, 0.3), 0.4);
    }
  }
  // Ice/water boundary
  if (water_top > ice_top + 0.001 && abs(depth - ice_top) < line_w) {
    color = mix(color, vec3f(0.4, 0.5, 0.7), 0.3);
  }
  // Water/snow boundary
  if (snow_top > water_top + 0.001 && abs(depth - water_top) < line_w) {
    color = mix(color, vec3f(0.7, 0.7, 0.75), 0.3);
  }

  return vec4f(color, 1.0);
}
