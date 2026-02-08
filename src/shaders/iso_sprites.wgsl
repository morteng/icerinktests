// Isometric 3D renderer — billboard sprite system
// Includes: vertex/fragment shaders, procedural drawing, shadow casting, reflections

struct SpriteVSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) local_uv: vec2f,
  @location(1) world_pos: vec3f,
  @location(2) @interpolate(flat) sprite_idx: u32,
}

// Billboard size in cells based on sprite type
fn sprite_billboard_size(sp: Sprite, st: u32) -> vec2f {
  let cell_m = params.cell_size;
  // sp.height stores heightScale for skaters (0.85-1.15), 0 means default (1.0)
  let hs = select(sp.height, 1.0, sp.height < 0.01);
  switch st {
    case 1u, 2u, 3u: {
      return vec2f(0.6 / cell_m, 1.8 * hs / cell_m);
    }
    case 4u: {
      return vec2f(max(sp.width, 10.0), 2.2 / cell_m);
    }
    case 5u: {
      return vec2f(0.8 / cell_m, 1.8 / cell_m);
    }
    case 6u, 7u: {
      return vec2f(sp.width, 1.2 / cell_m);
    }
    case 8u: {
      return vec2f(max(sp.width, 8.0), 1.8 / cell_m);
    }
    default: {
      // Custom sprite types 9-16: default to skater-like size
      if (st >= 9u && st <= 16u) {
        let hs2 = select(sp.height, 1.0, sp.height < 0.01);
        return vec2f(0.6 / cell_m, 1.8 * hs2 / cell_m);
      }
      return vec2f(1.0, 1.0);
    }
  }
}

// Get ice surface height at a grid position (without fence contribution)
fn ice_surface_height(gx: f32, gy: f32) -> f32 {
  let ix = clamp(u32(gx), 0u, params.width - 1u);
  let iy = clamp(u32(gy), 0u, params.height - 1u);
  let idx = iy * params.width + ix;
  let s = state[idx];
  let cell_mm = params.cell_size * 1000.0;
  return (s.y + s.z + s.w) / cell_mm;
}

@vertex
fn vs_sprite(@builtin(vertex_index) vid: u32) -> SpriteVSOut {
  let slot = vid / 6u;
  let corner_idx = vid % 6u;

  var out: SpriteVSOut;
  out.clip_pos = vec4f(0.0, 0.0, 0.0, 1.0);
  out.local_uv = vec2f(0.0);
  out.world_pos = vec3f(0.0);
  out.sprite_idx = slot;

  if (slot >= MAX_SPRITES) { return out; }

  let sp = read_sprite(slot);
  let st = sprite_type(sp);
  if (st == SPRITE_NONE) { return out; }
  // Zamboni uses voxel box renderer — suppress billboard
  if (st == SPRITE_ZAMBONI) { return out; }
  // Goals use 3D voxel geometry in indoor arena — suppress billboard sprite
  if ((st == SPRITE_GOAL_LEFT || st == SPRITE_GOAL_RIGHT) && is_indoor() && !is_backyard()) { return out; }

  let size = sprite_billboard_size(sp, st);
  let half_w = size.x * 0.5;
  let full_h = size.y;

  var cx: f32 = 0.0;
  var cy: f32 = 0.0;
  switch corner_idx {
    case 0u: { cx = -1.0; cy = 0.0; }
    case 1u: { cx = 1.0;  cy = 0.0; }
    case 2u: { cx = -1.0; cy = 1.0; }
    case 3u: { cx = 1.0;  cy = 0.0; }
    case 4u: { cx = 1.0;  cy = 1.0; }
    case 5u: { cx = -1.0; cy = 1.0; }
    default: {}
  }

  let surface_h = ice_surface_height(sp.x, sp.y);
  let center = vec3f(sp.x, surface_h, sp.y);

  // Goals: world-oriented quads (not billboarded)
  // sp.dir = -1 for left goal (faces +X), +1 for right goal (faces -X)
  var right: vec3f;
  var up: vec3f;
  if (st == SPRITE_GOAL_LEFT || st == SPRITE_GOAL_RIGHT) {
    // Goal frame lies along Z axis (across the rink width)
    // "right" = across the goal mouth (Z direction)
    right = vec3f(0.0, 0.0, 1.0);
    // "up" = vertical
    up = vec3f(0.0, 1.0, 0.0);
  } else {
    right = camera.billboard_right;
    up = vec3f(0.0, 1.0, 0.0);
  }

  let world_pos = center + right * cx * half_w + up * cy * full_h;
  let clip_pos = camera.proj * camera.view * vec4f(world_pos, 1.0);

  out.clip_pos = clip_pos;
  out.local_uv = vec2f(cx * 0.5 + 0.5, cy);
  out.world_pos = world_pos;
  out.sprite_idx = slot;
  return out;
}

// ===========================================================================
// ---- Animated procedural sprite drawing ----
// ===========================================================================
//
// Skater sprites use 8-direction facing + skating animation:
//   dir (radians) → discrete facing (0=front, 1=front-right, ... 7=front-left)
//   aux0 = animation phase (0-1 cycling), controls leg/arm stride
//
// Facing indices (clockwise from front/camera-facing):
//   0 = front, 1 = front-right, 2 = right, 3 = back-right
//   4 = back,  5 = back-left,   6 = left,  7 = front-left

// Map continuous direction (radians) to 8-direction facing index
// dir=0 means facing right in world space; we remap relative to camera
fn facing_index(dir: f32) -> u32 {
  // Camera billboard_right defines the screen-right direction.
  // Compute angle of sprite's movement relative to camera forward.
  let right = camera.billboard_right;
  let cam_fwd = vec3f(-right.z, 0.0, right.x); // camera forward (horizontal)

  // Sprite direction vector from dir (radians, 0=right, pi/2=up in world XZ)
  let sprite_dx = cos(dir);
  let sprite_dz = sin(dir);

  // Angle between sprite direction and camera forward
  let dot_fwd = sprite_dx * cam_fwd.x + sprite_dz * cam_fwd.z;
  let dot_right = sprite_dx * right.x + sprite_dz * right.z;
  let angle = atan2(dot_right, dot_fwd); // [-PI, PI], 0 = moving toward camera

  // Quantize to 8 directions (0=front = moving toward camera)
  let idx = (i32(round(angle / (PI / 4.0))) + 8) % 8;
  return u32(idx);
}

// Body width scale by facing (person viewed from side is much narrower)
fn body_width_scale(face: u32) -> f32 {
  // 0=front, 1=front-right, 2=right, 3=back-right, 4=back, 5=back-left, 6=left, 7=front-left
  switch face {
    case 0u, 4u: { return 1.0; }        // front/back: full width
    case 1u, 3u, 5u, 7u: { return 0.85; } // diagonal: slight narrowing
    case 2u, 6u: { return 0.65; }        // side: noticeably narrower but not stick-thin
    default: { return 1.0; }
  }
}

// Remap u coordinate to account for body width narrowing
fn body_u(u: f32, width_scale: f32) -> f32 {
  let center = 0.5;
  return center + (u - center) / width_scale;
}

// ---- Hockey skater: 8-direction + skating animation ----
fn draw_skater_hockey(uv: vec2f, team: u32, dir: f32, phase: f32) -> vec4f {
  let u = uv.x;
  let v = uv.y;
  let face = facing_index(dir);

  // Animation: sinusoidal stride cycle
  let stride = sin(phase * 2.0 * PI); // -1 to 1
  let arm_swing = cos(phase * 2.0 * PI) * 0.5;

  let jersey_main = select(vec3f(0.15, 0.25, 0.75), vec3f(0.75, 0.15, 0.15), team == 0u);
  let jersey_alt = jersey_main * 1.3;
  let helmet = select(vec3f(0.2, 0.3, 0.8), vec3f(0.8, 0.2, 0.2), team == 0u);
  let skin = vec3f(0.85, 0.72, 0.58);
  let pants = vec3f(0.15, 0.15, 0.18);
  let skate = vec3f(0.2, 0.2, 0.22);
  let stick_col = vec3f(0.45, 0.35, 0.2);
  let blade_col = vec3f(0.12, 0.12, 0.12);

  let is_side = face == 2u || face == 6u;
  let is_back = face == 3u || face == 4u || face == 5u;
  let is_front = face == 0u || face == 1u || face == 7u;

  // Mirror for left-facing sprites
  var lu = u;
  if (face >= 5u && face <= 7u) { lu = 1.0 - u; }

  // Apply body width scaling — narrower from side
  let ws = body_width_scale(face);
  let bu = body_u(lu, ws);

  // ---- Head ----
  let head_y = 0.86;
  let head_r = 0.09;
  let head_center = vec2f(0.5, head_y);
  let hdist = length(vec2f(bu, v) - head_center);

  if (hdist < head_r + 0.04) {
    // Helmet (outer ring)
    if (hdist >= head_r - 0.01) {
      return vec4f(helmet, 1.0);
    }
    if (is_back) {
      // Back of head: all helmet, with a stripe
      if (abs(v - head_y) < 0.02 && abs(bu - 0.5) < 0.03) {
        return vec4f(helmet * 0.7, 1.0); // helmet stripe/visor back
      }
      return vec4f(helmet, 1.0);
    }
    if (is_side) {
      // Side profile: half face, half helmet
      if (bu > 0.48) {
        return vec4f(helmet, 1.0); // back half = helmet
      }
      if (v < head_y + 0.02 && v > head_y - 0.04) {
        return vec4f(skin, 1.0); // face profile
      }
      return vec4f(helmet, 1.0);
    }
    // Front: face area
    if (v < head_y + 0.03 && v > head_y - 0.06) {
      return vec4f(skin, 1.0);
    }
    return vec4f(helmet, 1.0);
  }

  // ---- Torso (jersey) ----
  if (v > 0.42 && v < 0.76 && bu > 0.24 && bu < 0.76) {
    // Back: show number (white rectangle)
    if (is_back && v > 0.50 && v < 0.70 && bu > 0.35 && bu < 0.65) {
      return vec4f(1.0, 1.0, 1.0, 1.0); // white number patch
    }
    // Front: show team logo area (slightly different shade)
    if (is_front && v > 0.52 && v < 0.68 && bu > 0.38 && bu < 0.62) {
      return vec4f(jersey_alt, 1.0);
    }
    // Side: show arm/shoulder detail
    if (is_side && bu > 0.55) {
      return vec4f(jersey_main * 0.8, 1.0); // arm shadow
    }
    return vec4f(jersey_main, 1.0);
  }

  // ---- Arms + stick (side/diagonal only) ----
  if ((is_side || face == 1u || face == 3u || face == 5u || face == 7u) && !is_back) {
    let arm_y = 0.50 + arm_swing * 0.08;
    // Leading arm reaching forward with stick
    if (lu > 0.72 && lu < 0.88 && v > arm_y - 0.02 && v < arm_y + 0.14) {
      return vec4f(jersey_main * 0.85, 1.0);
    }
    // Stick shaft (extends down from hand)
    let stick_base = 0.08 + arm_swing * 0.04;
    if (lu > 0.76 && lu < 0.84 && v > stick_base && v < arm_y) {
      return vec4f(stick_col, 1.0);
    }
    // Stick blade (at bottom)
    if (lu > 0.70 && lu < 0.92 && v > stick_base - 0.03 && v < stick_base + 0.04) {
      return vec4f(blade_col, 1.0);
    }
  }

  // ---- Stick (front view — held to the right) ----
  if (is_front && !is_side) {
    if (bu > 0.74 && bu < 0.82 && v > 0.12 && v < 0.55) {
      return vec4f(stick_col, 1.0);
    }
    if (bu > 0.68 && bu < 0.88 && v > 0.06 && v < 0.14) {
      return vec4f(blade_col, 1.0);
    }
  }

  // ---- Pants ----
  if (v > 0.20 && v <= 0.42 && bu > 0.28 && bu < 0.72) {
    return vec4f(pants, 1.0);
  }

  // ---- Legs + skates (animated stride) ----
  if (v > 0.02 && v <= 0.20) {
    let leg_offset = stride * 0.07;
    let leg_w = select(0.07, 0.10, is_side); // side: legs overlap = wider single leg

    if (is_side) {
      // Side view: single visible leg with stride offset
      let leg_x = 0.5 + leg_offset * 0.5;
      if (abs(bu - leg_x) < leg_w) {
        if (v < 0.06) { return vec4f(skate, 1.0); }
        return vec4f(0.25, 0.25, 0.28, 1.0);
      }
    } else {
      // Front/back: two legs visible
      let leg1_x = 0.42 + leg_offset;
      let leg2_x = 0.58 - leg_offset;
      if (abs(bu - leg1_x) < leg_w || abs(bu - leg2_x) < leg_w) {
        if (v < 0.06) { return vec4f(skate, 1.0); }
        return vec4f(0.25, 0.25, 0.28, 1.0);
      }
    }
  }

  return vec4f(0.0);
}

// ---- Figure skater: 8-direction + graceful skating animation ----
fn draw_skater_figure(uv: vec2f, team: u32, dir: f32, phase: f32) -> vec4f {
  let u = uv.x;
  let v = uv.y;
  let face = facing_index(dir);

  let stride = sin(phase * 2.0 * PI);
  let arm_lift = sin(phase * 2.0 * PI + 0.5) * 0.5 + 0.5;

  var costume = vec3f(0.2, 0.6, 0.8);
  if (team == 1u) { costume = vec3f(0.8, 0.2, 0.6); }
  else if (team == 2u) { costume = vec3f(0.3, 0.7, 0.3); }
  else if (team == 3u) { costume = vec3f(0.9, 0.5, 0.1); }

  let skin = vec3f(0.85, 0.72, 0.58);
  let hair_color = select(vec3f(0.15, 0.1, 0.05), vec3f(0.6, 0.35, 0.15), team > 2u);
  let is_back = face == 3u || face == 4u || face == 5u;
  let is_side = face == 2u || face == 6u;
  let is_front = face == 0u || face == 1u || face == 7u;

  var lu = u;
  if (face >= 5u && face <= 7u) { lu = 1.0 - u; }

  let ws = body_width_scale(face);
  let bu = body_u(lu, ws);

  // Head
  let head_center = vec2f(0.5, 0.87);
  let hdist = length(vec2f(bu, v) - head_center);

  if (hdist < 0.12) {
    // Hair (top/back of head)
    if (v > 0.89 || is_back) {
      return vec4f(hair_color, 1.0);
    }
    // Side: profile
    if (is_side) {
      if (bu < 0.52 && v < 0.89) { return vec4f(skin, 1.0); }
      return vec4f(hair_color, 1.0);
    }
    // Front face
    if (hdist < 0.08 && v < 0.89) { return vec4f(skin, 1.0); }
    return vec4f(hair_color, 1.0);
  }

  // Costume body + skirt (flared at bottom)
  let skirt_flare = max(0.0, 0.45 - v) * 0.4; // widens toward bottom
  if (v > 0.25 && v < 0.80 && bu > 0.26 - skirt_flare && bu < 0.74 + skirt_flare) {
    if (fract(bu * 8.0 + v * 5.0 + phase) > 0.85) {
      return vec4f(costume * 1.5, 1.0); // sparkle
    }
    if (is_back) { return vec4f(costume * 0.8, 1.0); }
    return vec4f(costume, 1.0);
  }

  // Arms — expressive poses
  let arm_y = 0.58 + arm_lift * 0.14;
  if (is_side || face == 1u || face == 7u) {
    // Extended arm
    if (lu > 0.70 && lu < 0.92 && v > arm_y - 0.04 && v < arm_y + 0.04) {
      return vec4f(skin, 1.0);
    }
  } else if (is_front) {
    // Both arms slightly raised
    if ((abs(bu - 0.18) < 0.06 || abs(bu - 0.82) < 0.06) && v > arm_y - 0.03 && v < arm_y + 0.10) {
      return vec4f(skin, 1.0);
    }
  }

  // Legs (animated glide)
  if (v > 0.04 && v <= 0.25) {
    let leg_spread = stride * 0.08;
    if (is_side) {
      let leg_x = 0.5 + leg_spread * 0.5;
      if (abs(bu - leg_x) < 0.08) { return vec4f(skin, 1.0); }
    } else {
      let l1 = 0.42 + leg_spread;
      let l2 = 0.58 - leg_spread;
      if (abs(bu - l1) < 0.06 || abs(bu - l2) < 0.06) { return vec4f(skin, 1.0); }
    }
  }

  // Skates
  if (v <= 0.04 && bu > 0.32 && bu < 0.68) {
    return vec4f(0.9, 0.9, 0.92, 1.0);
  }

  return vec4f(0.0);
}

// ---- Public skater: 8-direction + casual skating ----
fn draw_skater_public(uv: vec2f, team: u32, dir: f32, phase: f32) -> vec4f {
  let u = uv.x;
  let v = uv.y;
  let face = facing_index(dir);

  let stride = sin(phase * 2.0 * PI);
  let is_back = face == 3u || face == 4u || face == 5u;
  let is_side = face == 2u || face == 6u;
  let is_front = face == 0u || face == 1u || face == 7u;

  var lu = u;
  if (face >= 5u && face <= 7u) { lu = 1.0 - u; }

  let ws = body_width_scale(face);
  let bu = body_u(lu, ws);

  let skin = vec3f(0.85, 0.72, 0.58);
  let hat_h = hash(f32(team) + 1.0, 3.0);
  let hat_color = vec3f(hat_h, 1.0 - hat_h, 0.5);
  let jacket_h = hash(f32(team) + 5.0, 7.0);
  var jacket = vec3f(jacket_h * 0.5 + 0.2, (1.0 - jacket_h) * 0.4 + 0.2, 0.5);

  // Head
  let head_center = vec2f(0.5, 0.86);
  let hdist = length(vec2f(bu, v) - head_center);

  // Hat/toque (above head)
  if (v > 0.92 && bu > 0.38 && bu < 0.62) {
    return vec4f(hat_color, 1.0);
  }

  if (hdist < 0.10) {
    if (is_back) {
      // Back of head: hair + hat edge
      if (v > 0.88) { return vec4f(hat_color, 1.0); }
      return vec4f(0.3, 0.2, 0.12, 1.0); // dark hair
    }
    if (is_side) {
      if (bu < 0.52 && v < 0.88) { return vec4f(skin, 1.0); }
      return vec4f(0.3, 0.2, 0.12, 1.0);
    }
    // Front face
    if (v < 0.88 && hdist < 0.07) { return vec4f(skin, 1.0); }
    return vec4f(0.3, 0.2, 0.12, 1.0); // hair around face
  }

  // Scarf (front only)
  if (is_front && v > 0.76 && v < 0.80 && bu > 0.36 && bu < 0.64) {
    return vec4f(hat_color * 0.8, 1.0);
  }

  // Jacket
  if (v > 0.42 && v < 0.78 && bu > 0.24 && bu < 0.76) {
    if (is_back) { jacket *= 0.75; }
    // Front: zipper line
    if (is_front && abs(bu - 0.5) < 0.02 && v > 0.45) {
      return vec4f(jacket * 0.5, 1.0);
    }
    return vec4f(jacket, 1.0);
  }

  // Pants
  if (v > 0.15 && v <= 0.42 && bu > 0.28 && bu < 0.72) {
    return vec4f(0.2, 0.2, 0.3, 1.0);
  }

  // Legs + skates
  if (v > 0.02 && v <= 0.15) {
    let leg_offset = stride * 0.05;
    if (is_side) {
      let lx = 0.5 + leg_offset * 0.5;
      if (abs(bu - lx) < 0.09) {
        if (v < 0.05) { return vec4f(0.3, 0.3, 0.32, 1.0); }
        return vec4f(0.15, 0.15, 0.18, 1.0);
      }
    } else {
      let l1 = 0.42 + leg_offset;
      let l2 = 0.58 - leg_offset;
      if (abs(bu - l1) < 0.07 || abs(bu - l2) < 0.07) {
        if (v < 0.05) { return vec4f(0.3, 0.3, 0.32, 1.0); }
        return vec4f(0.15, 0.15, 0.18, 1.0);
      }
    }
  }

  return vec4f(0.0);
}

fn draw_zamboni(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  if (v > 0.05 && v < 0.65 && u > 0.05 && u < 0.95) {
    if (v > 0.4 && u > 0.55) {
      if (v > 0.45 && v < 0.6 && u > 0.6 && u < 0.88) {
        return vec4f(0.3, 0.4, 0.55, 1.0);
      }
      return vec4f(0.85, 0.85, 0.88, 1.0);
    }
    if (u < 0.55) {
      return vec4f(0.75, 0.78, 0.82, 1.0);
    }
    return vec4f(0.82, 0.82, 0.85, 1.0);
  }

  if (v > 0.0 && v <= 0.08) {
    if ((u > 0.1 && u < 0.3) || (u > 0.7 && u < 0.9)) {
      return vec4f(0.1, 0.1, 0.12, 1.0);
    }
  }

  if (v > 0.0 && v < 0.06 && u > 0.3 && u < 0.7) {
    return vec4f(0.5, 0.5, 0.55, 1.0);
  }

  if (v > 0.62 && v < 0.68 && u > 0.05 && u < 0.95) {
    let stripe = fract(u * 8.0);
    if (stripe < 0.5) {
      return vec4f(0.9, 0.6, 0.0, 1.0);
    }
    return vec4f(0.15, 0.15, 0.15, 1.0);
  }

  return vec4f(0.0);
}

fn draw_shovel(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  let head_center = vec2f(0.45, 0.87);
  let head_dist = length(vec2f(u, v) - head_center);
  if (head_dist < 0.1) { return vec4f(0.85, 0.72, 0.58, 1.0); }
  if (v > 0.9 && u > 0.3 && u < 0.55) { return vec4f(0.7, 0.1, 0.1, 1.0); }
  if (v > 0.45 && v < 0.8 && u > 0.2 && u < 0.65) { return vec4f(0.15, 0.35, 0.55, 1.0); }
  if (v > 0.15 && v <= 0.45 && u > 0.25 && u < 0.65) { return vec4f(0.25, 0.22, 0.15, 1.0); }
  if (v <= 0.15 && v > 0.02 && u > 0.28 && u < 0.62) { return vec4f(0.2, 0.15, 0.1, 1.0); }
  if (u > 0.6 && u < 0.68 && v > 0.2 && v < 0.75) { return vec4f(0.5, 0.4, 0.25, 1.0); }
  if (u > 0.55 && u < 0.8 && v > 0.02 && v < 0.15) { return vec4f(0.45, 0.45, 0.5, 1.0); }

  return vec4f(0.0);
}

fn draw_water_tank(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  if (v > 0.08 && v < 0.7 && u > 0.08 && u < 0.92) {
    let rust = hash(floor(u * 12.0), floor(v * 8.0));
    let base = vec3f(0.45, 0.3, 0.2) + vec3f(rust * 0.15, rust * 0.08, rust * 0.02);
    if (fract(v * 5.0) < 0.15) { return vec4f(base * 0.6, 1.0); }
    return vec4f(base, 1.0);
  }
  if (v > 0.65 && v < 0.8 && u > 0.3 && u < 0.7) { return vec4f(0.3, 0.3, 0.32, 1.0); }
  if (v > 0.0 && v <= 0.1) {
    if ((u > 0.1 && u < 0.3) || (u > 0.7 && u < 0.9)) { return vec4f(0.1, 0.1, 0.12, 1.0); }
  }
  if (v > 0.02 && v < 0.09 && u > 0.2 && u < 0.8) { return vec4f(0.35, 0.35, 0.4, 1.0); }

  return vec4f(0.0);
}

fn draw_goal(uv: vec2f) -> vec4f {
  let u = uv.x;
  let v = uv.y;

  let frame_w = 0.06;
  let is_frame = (u < frame_w || u > 1.0 - frame_w || v > 0.92);
  if (is_frame && v > 0.0) { return vec4f(0.85, 0.1, 0.1, 1.0); }

  if (u > frame_w && u < 1.0 - frame_w && v > 0.0 && v <= 0.92) {
    let grid_u = floor(u * 12.0);
    let grid_v = floor(v * 8.0);
    let checker = (u32(grid_u) + u32(grid_v)) % 2u;
    if (checker == 0u) { return vec4f(0.92, 0.92, 0.95, 0.7); }
    return vec4f(0.0);
  }

  return vec4f(0.0);
}

// ---- Parallax relief mapping for height-extruded sprites ----

// Maximum parallax depth scale (in UV space)
const PARALLAX_SCALE: f32 = 0.08;
const PARALLAX_STEPS: i32 = 12;
const PARALLAX_REFINE_STEPS: i32 = 4;

// Sample height from the height atlas at given atlas UV
// Atlas channels: R=height, G=normal.x, B=normal.y (normals read separately)
fn sample_height_at_atlas_uv(atlas_uv: vec2f) -> f32 {
  let h = textureSampleLevel(sprite_height_atlas, sprite_sampler, atlas_uv, 0.0);
  return h.r; // height normalized 0-1 (from R channel only)
}

// Compute atlas UV for a given local sprite UV, sprite, and type
// Uses per-row pixel offsets and span sizes for multi-cell sprite support
fn compute_atlas_uv(uv: vec2f, sp: Sprite, st: u32) -> vec2f {
  let team = sprite_team(sp);
  let row = sprite_atlas_row(st, team);
  let dir_idx = facing_index(sp.dir);
  let frame = u32(floor(sp.aux0 * f32(ATLAS_FRAME_COUNT))) % ATLAS_FRAME_COUNT;
  let col = dir_idx * ATLAS_FRAME_COUNT + frame;

  // Per-row frame pixel dimensions
  let span_w = f32(ROW_SPAN_W[row]);
  let span_h = f32(ROW_SPAN_H[row]);
  let frame_px_w = span_w * BASE_CELL_W;
  let frame_px_h = span_h * BASE_CELL_H;

  // Pixel position of this frame in the atlas
  let px_x = f32(col) * COL_SLOT_W + clamp(uv.x, 0.001, 0.999) * frame_px_w;
  let px_y = ROW_Y_PX[row] + (1.0 - clamp(uv.y, 0.001, 0.999)) * frame_px_h;

  return vec2f(px_x / ATLAS_PX_W, px_y / ATLAS_PX_H);
}

// Sample height at local sprite UV
fn sample_sprite_height(uv: vec2f, sp: Sprite, st: u32) -> f32 {
  let atlas_uv = compute_atlas_uv(uv, sp, st);
  return sample_height_at_atlas_uv(atlas_uv);
}

// Read normal from height atlas G/B channels (pre-computed Sobel normals)
// Falls back to finite differences if normal is zero (backward compat for custom sprites)
fn sprite_height_normal(uv: vec2f, sp: Sprite, st: u32) -> vec3f {
  let atlas_uv = compute_atlas_uv(uv, sp, st);
  let sample = textureSampleLevel(sprite_height_atlas, sprite_sampler, atlas_uv, 0.0);

  // Decode normals from G/B: nx = (g - 0.5) * 2.0, ny = (b - 0.5) * 2.0
  let nx = (sample.g - 0.5) * 2.0;
  let ny = (sample.b - 0.5) * 2.0;

  // Check if normal data is present (non-neutral G/B)
  if (abs(nx) > 0.01 || abs(ny) > 0.01) {
    let nz = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
    return normalize(vec3f(nx, ny, nz));
  }

  // Fallback: finite differences for custom sprites without encoded normals
  let team = sprite_team(sp);
  let row = sprite_atlas_row(st, team);
  let frame_px_w = f32(ROW_SPAN_W[row]) * BASE_CELL_W;
  let frame_px_h = f32(ROW_SPAN_H[row]) * BASE_CELL_H;
  let eps = vec2f(1.0 / frame_px_w, 1.0 / frame_px_h);

  let h_xp = sample_sprite_height(uv + vec2f(eps.x, 0.0), sp, st);
  let h_xn = sample_sprite_height(uv - vec2f(eps.x, 0.0), sp, st);
  let h_yp = sample_sprite_height(uv + vec2f(0.0, eps.y), sp, st);
  let h_yn = sample_sprite_height(uv - vec2f(0.0, eps.y), sp, st);

  let dhdx = (h_xp - h_xn) * 0.5;
  let dhdy = (h_yp - h_yn) * 0.5;
  return normalize(vec3f(-dhdx * 3.0, -dhdy * 3.0, 1.0));
}

// Parallax ray march: adjust UV based on view direction through height field
fn parallax_sprite(uv: vec2f, view_dir_ts: vec2f, sp: Sprite, st: u32) -> vec2f {
  // Linear search
  let step_size = 1.0 / f32(PARALLAX_STEPS);
  let delta_uv = view_dir_ts * PARALLAX_SCALE * step_size;

  var cur_uv = uv;
  var cur_depth: f32 = 0.0;
  var cur_height = sample_sprite_height(cur_uv, sp, st);

  for (var i = 0; i < PARALLAX_STEPS; i++) {
    if (cur_depth >= cur_height) { break; }
    cur_uv -= delta_uv;
    cur_depth += step_size;
    cur_height = sample_sprite_height(cur_uv, sp, st);
  }

  // Binary refinement
  var prev_uv = cur_uv + delta_uv;
  var prev_depth = cur_depth - step_size;

  for (var j = 0; j < PARALLAX_REFINE_STEPS; j++) {
    let mid_uv = (cur_uv + prev_uv) * 0.5;
    let mid_depth = (cur_depth + prev_depth) * 0.5;
    let mid_height = sample_sprite_height(mid_uv, sp, st);

    if (mid_depth >= mid_height) {
      cur_uv = mid_uv;
      cur_depth = mid_depth;
    } else {
      prev_uv = mid_uv;
      prev_depth = mid_depth;
    }
  }

  return cur_uv;
}

// Parallax self-shadow: march from surface point along light direction through height field
// Returns shadow factor (0.3 = fully shadowed, 1.0 = fully lit)
fn parallax_self_shadow(uv: vec2f, light_dir_ts: vec2f, sp: Sprite, st: u32) -> f32 {
  let steps = 6;
  let step_size = 1.0 / f32(steps);
  let cur_height = sample_sprite_height(uv, sp, st);

  // March along light direction in UV space
  let delta_uv = light_dir_ts * PARALLAX_SCALE * step_size;
  var max_depth_under: f32 = 0.0;
  var march_uv = uv;
  var march_h = cur_height;

  for (var i = 1; i <= steps; i++) {
    march_uv += delta_uv;
    march_h -= step_size; // expected height decreasing along ray

    // Bounds check
    if (march_uv.x < 0.0 || march_uv.x > 1.0 || march_uv.y < 0.0 || march_uv.y > 1.0) { break; }

    let h = sample_sprite_height(march_uv, sp, st);
    let depth_under = h - (cur_height - f32(i) * step_size * cur_height);
    max_depth_under = max(max_depth_under, depth_under);
  }

  // Soft shadow: blend based on how deep under the height field
  if (max_depth_under > 0.01) {
    let shadow_strength = clamp(max_depth_under * 8.0, 0.0, 1.0);
    return mix(1.0, 0.3, shadow_strength);
  }
  return 1.0;
}

// Ambient occlusion from height field — samples ring around pixel
fn sprite_ao(uv: vec2f, sp: Sprite, st: u32) -> f32 {
  let center_h = sample_sprite_height(uv, sp, st);
  let team = sprite_team(sp);
  let row = sprite_atlas_row(st, team);
  let frame_px_w = f32(ROW_SPAN_W[row]) * BASE_CELL_W;
  let frame_px_h = f32(ROW_SPAN_H[row]) * BASE_CELL_H;
  // Sample radius: ~3 texels
  let r = vec2f(3.0 / frame_px_w, 3.0 / frame_px_h);

  // 8 samples in a ring
  var total_diff: f32 = 0.0;
  var count: f32 = 0.0;
  let offsets = array<vec2f, 8>(
    vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(0.707, 0.707), vec2f(-0.707, 0.707), vec2f(0.707, -0.707), vec2f(-0.707, -0.707)
  );

  for (var i = 0; i < 8; i++) {
    let sample_uv = uv + offsets[i] * r;
    if (sample_uv.x >= 0.0 && sample_uv.x <= 1.0 && sample_uv.y >= 0.0 && sample_uv.y <= 1.0) {
      let h = sample_sprite_height(sample_uv, sp, st);
      total_diff += max(0.0, h - center_h); // how much higher the surrounding is
      count += 1.0;
    }
  }

  // Cavities (center lower than surroundings) get darkened
  if (count > 0.0) {
    let avg_diff = total_diff / count;
    let ao = 1.0 - clamp(avg_diff * 6.0, 0.0, 0.5);
    return ao;
  }
  return 1.0;
}

// Sprite lighting using per-pixel normal from height map
// self_shadow: parallax self-shadow factor (0.3-1.0), ao: ambient occlusion (0.5-1.0)
fn sprite_light_with_normal(world_pos: vec3f, base_color: vec3f, N_tangent: vec3f, billboard_right: vec3f, self_shadow: f32, ao: f32) -> vec3f {
  let is_outdoor = (params.flags & 1u) != 0u;
  let billboard_up = vec3f(0.0, 1.0, 0.0);
  let billboard_fwd = normalize(cross(billboard_up, billboard_right));

  // Transform tangent-space normal to world space
  // Tangent space: X = right, Y = up, Z = toward camera
  let N_world = normalize(
    billboard_right * N_tangent.x +
    billboard_up * N_tangent.y +
    billboard_fwd * N_tangent.z
  );

  let raw_sun = params.sun_dir;
  let sun_len = length(raw_sun);
  let sun_dir = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len, sun_len > 0.001);
  let sun_ndotl = max(dot(N_world, sun_dir), 0.0);
  let sun_half = sun_ndotl * 0.5 + 0.5;
  let terrain_sun_shadow = shadow_for_sun(world_pos, sun_dir);
  // Apply self-shadow to sun contribution
  var diffuse = params.sun_color * sun_half * 0.7 * terrain_sun_shadow * self_shadow;

  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - world_pos;
    let dist = length(to_light);
    let L = to_light / max(dist, 0.01);
    let ndotl = max(dot(N_world, L), 0.0) * 0.5 + 0.5;
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(dist, light.radius);
    }
    if (atten > 0.001) {
      let shadow = shadow_for_light(world_pos, light.pos);
      diffuse += light.color * ndotl * atten * 0.5 * shadow;
    }
  }

  let ambient = select(
    vec3f(params.sky_brightness * 0.3 + 0.15),
    max(params.sky_color * 0.4, vec3f(0.1)) + vec3f(0.05),
    is_outdoor
  );

  // Apply AO to ambient lighting
  var result = base_color * (ambient * ao + diffuse);
  result *= params.exposure;
  result = agx_tonemap(result);
  return result;
}

// ---- Sprite atlas sampling (multi-cell span support) ----
const ATLAS_PX_W: f32 = 2048.0; // 32 cols × 2 × 32px
const ATLAS_PX_H: f32 = 864.0;  // sum of per-row heights
const BASE_CELL_W: f32 = 32.0;
const BASE_CELL_H: f32 = 48.0;
const COL_SLOT_W: f32 = 64.0;   // MAX_SPAN_W(2) × BASE_CELL_W(32)
const ATLAS_FRAME_COUNT: u32 = 4u;

// Per-row span widths in base cells (1 or 2)
const ROW_SPAN_W = array<u32, 16>(1u, 1u, 1u, 1u, 2u, 1u, 2u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u);
// Per-row span heights in base cells (1 or 2)
const ROW_SPAN_H = array<u32, 16>(1u, 1u, 1u, 1u, 2u, 1u, 2u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u, 1u);
// Per-row Y pixel offsets into atlas
const ROW_Y_PX = array<f32, 16>(0.0, 48.0, 96.0, 144.0, 192.0, 288.0, 336.0, 432.0, 480.0, 528.0, 576.0, 624.0, 672.0, 720.0, 768.0, 816.0);

fn sprite_atlas_row(st: u32, team: u32) -> u32 {
  switch st {
    case 1u: { return select(1u, 0u, team == 0u); } // hockey blue/red
    case 2u: { return 2u; } // figure
    case 3u: { return 3u; } // public
    case 4u: { return 4u; } // zamboni
    case 5u: { return 5u; } // shovel
    case 6u, 7u: { return 7u; } // goal
    case 8u: { return 6u; } // water tank
    default: {
      // Custom sprite types 9-16 map to atlas rows 8-15
      if (st >= 9u && st <= 16u) { return st - 1u; }
      return 0u;
    }
  }
}

// HSV to RGB (h=0-1, s=0-1, v=0-1)
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> vec3f {
  let c = v * s;
  let hp = h * 6.0;
  let x = c * (1.0 - abs(hp % 2.0 - 1.0));
  let m = v - c;
  var rgb = vec3f(0.0);
  if (hp < 1.0) { rgb = vec3f(c, x, 0.0); }
  else if (hp < 2.0) { rgb = vec3f(x, c, 0.0); }
  else if (hp < 3.0) { rgb = vec3f(0.0, c, x); }
  else if (hp < 4.0) { rgb = vec3f(0.0, x, c); }
  else if (hp < 5.0) { rgb = vec3f(x, 0.0, c); }
  else { rgb = vec3f(c, 0.0, x); }
  return rgb + vec3f(m);
}

// Per-skater color tint derived from seed (aux1)
fn sprite_tint_color(st: u32, seed: f32) -> vec3f {
  if (st == 3u) {
    // Public skater: vivid random jacket/hat color
    return hsv_to_rgb(seed, 0.65, 0.85);
  }
  if (st == 2u) {
    // Figure skater: bright costume color
    return hsv_to_rgb(seed * 0.8 + 0.05, 0.55, 0.90);
  }
  return vec3f(1.0); // no tint
}

fn sample_sprite_from_atlas(uv: vec2f, sp: Sprite, st: u32) -> vec4f {
  let atlas_uv = compute_atlas_uv(uv, sp, st);
  var color = textureSampleLevel(sprite_atlas, sprite_sampler, atlas_uv, 0.0);

  // Apply per-sprite color tint to "white" clothing areas
  if (st == 2u || st == 3u) {
    let tint = sprite_tint_color(st, sp.aux1);
    // Tint pixels that are bright/white (clothing), leave skin/dark areas alone
    let brightness = max(color.r, max(color.g, color.b));
    if (brightness > 0.75 && color.a > 0.5) {
      color = vec4f(color.rgb * tint, color.a);
    }
  }

  return color;
}

// ---- Sprite color dispatcher ----
fn sample_sprite_color(uv: vec2f, sp: Sprite, st: u32) -> vec4f {
  // Use texture atlas — set to false to fall back to procedural
  let use_atlas = true;
  if (use_atlas) {
    return sample_sprite_from_atlas(uv, sp, st);
  }
  switch st {
    case 1u: { return draw_skater_hockey(uv, sprite_team(sp), sp.dir, sp.aux0); }
    case 2u: { return draw_skater_figure(uv, sprite_team(sp), sp.dir, sp.aux0); }
    case 3u: { return draw_skater_public(uv, sprite_team(sp), sp.dir, sp.aux0); }
    case 4u: { return draw_zamboni(uv); }
    case 5u: { return draw_shovel(uv); }
    case 6u, 7u: { return draw_goal(uv); }
    case 8u: { return draw_water_tank(uv); }
    default: { return vec4f(0.0); }
  }
}

// ---- Sprite shadow + reflection system ----

fn ray_billboard_intersect(ray_o: vec3f, ray_d: vec3f, sp: Sprite, st: u32) -> vec4f {
  let size = sprite_billboard_size(sp, st);
  let half_w = size.x * 0.5;
  let full_h = size.y;

  // Goals: world-oriented, not billboarded
  var right: vec3f;
  if (st == SPRITE_GOAL_LEFT || st == SPRITE_GOAL_RIGHT) {
    right = vec3f(0.0, 0.0, 1.0);
  } else {
    right = camera.billboard_right;
  }
  let fwd = vec3f(-right.z, 0.0, right.x);

  let surface_h = ice_surface_height(sp.x, sp.y);
  let base = vec3f(sp.x, surface_h, sp.y);

  let denom = dot(ray_d, fwd);
  if (abs(denom) < 0.0001) { return vec4f(0.0, 0.0, -1.0, 0.0); }

  let t = dot(base - ray_o, fwd) / denom;
  if (t < 0.01) { return vec4f(0.0, 0.0, -1.0, 0.0); }

  let hit = ray_o + ray_d * t;
  let local = hit - base;

  let lu = dot(local, right) / half_w;
  let lv = local.y / full_h;

  if (lu < -1.0 || lu > 1.0 || lv < 0.0 || lv > 1.0) {
    return vec4f(0.0, 0.0, -1.0, 0.0);
  }

  let uv = vec2f(lu * 0.5 + 0.5, lv);
  return vec4f(uv, t, 1.0);
}

fn sprite_silhouette(uv: vec2f, st: u32) -> bool {
  let u = uv.x;
  let v = uv.y;

  if (st >= 1u && st <= 3u) {
    let cx = abs(u - 0.5) * 2.0;
    var w = 0.5;
    if (v > 0.3 && v < 0.8) { w = 0.7; }
    else if (v > 0.8) { w = 0.4; }
    return cx < w && v > 0.02 && v < 0.95;
  }
  if (st == 4u || st == 8u) {
    return u > 0.05 && u < 0.95 && v > 0.05 && v < 0.7;
  }
  if (st == 5u) {
    return u > 0.15 && u < 0.85 && v > 0.02 && v < 0.95;
  }
  if (st == 6u || st == 7u) {
    let frame_w = 0.08;
    return (u < frame_w || u > 1.0 - frame_w || v > 0.9) && v > 0.0;
  }
  return false;
}

fn sprite_cast_shadow(world_pos: vec3f, light_dir: vec3f) -> f32 {
  let count = min(sprite_count(), MAX_SPRITES);
  var best = 1.0;

  for (var i = 0u; i < count; i++) {
    let sp = read_sprite(i);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE) { continue; }

    // Method 1: ray-billboard intersection (pixel-accurate shadow shape)
    let hit = ray_billboard_intersect(world_pos, light_dir, sp, st);
    if (hit.w > 0.5) {
      let atlas_uv = compute_atlas_uv(hit.xy, sp, st);
      let alpha = textureSampleLevel(sprite_atlas, sprite_sampler, atlas_uv, 0.0).a;
      if (alpha > 0.1) {
        best = min(best, 0.30);
        continue;
      }
      if (sprite_silhouette(hit.xy, st)) {
        best = min(best, 0.40);
        continue;
      }
    }

    // Method 2: geometric ground-projected shadow (fallback, always works)
    // Projects sprite as shadow ellipse on the ground along sun direction
    if (light_dir.y > 0.05) {
      let size = sprite_billboard_size(sp, st);
      let half_h = size.y * 0.5;
      // Shadow center: project from sprite mid-height onto ground along -sun
      let proj_x = sp.x - (light_dir.x / light_dir.y) * half_h;
      let proj_z = sp.y - (light_dir.z / light_dir.y) * half_h;
      let dx = world_pos.x - proj_x;
      let dz = world_pos.z - proj_z;
      // Ellipse: width = sprite width, length = projected height
      let shadow_w = max(size.x * 0.35, 2.0);
      let shadow_len = max(half_h / light_dir.y * 0.3, 3.0);
      // Rotate ellipse axes along shadow direction
      let sun_xz = normalize(vec2f(light_dir.x, light_dir.z));
      let along = dx * sun_xz.x + dz * sun_xz.y; // distance along shadow
      let perp = -dx * sun_xz.y + dz * sun_xz.x;  // perpendicular distance
      let norm_dist = (along * along) / (shadow_len * shadow_len) + (perp * perp) / (shadow_w * shadow_w);
      if (norm_dist < 1.0) {
        let f = 1.0 - norm_dist;
        best = min(best, 1.0 - f * f * 0.30);
      }
    }
  }
  return best;
}

// Contact shadow: subtle ambient occlusion under each sprite at ice level
// Grounds sprites visually — small, soft darkening right at feet
fn sprite_contact_shadow(world_pos: vec3f) -> f32 {
  let count = min(sprite_count(), MAX_SPRITES);
  var shadow = 0.0;
  let cell_m = params.cell_size;

  for (var i = 0u; i < count; i++) {
    let sp = read_sprite(i);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE || st == SPRITE_GOAL_LEFT || st == SPRITE_GOAL_RIGHT) { continue; }

    let dx = world_pos.x - sp.x;
    let dz = world_pos.z - sp.y;
    let dist_sq = dx * dx + dz * dz;

    // Subtle contact shadow: ~0.15m radius for skaters, larger for vehicles
    var radius_m: f32 = 0.15;
    var strength: f32 = 0.30;
    if (st == SPRITE_ZAMBONI) { radius_m = 1.5; }
    else if (st == SPRITE_WATER_TANK) { radius_m = 1.0; }
    else if (st == SPRITE_SHOVEL) { radius_m = 0.2; }

    let radius = radius_m / cell_m;
    let r2 = radius * radius;

    if (dist_sq < r2) {
      let t = 1.0 - dist_sq / r2;
      shadow = max(shadow, t * t * strength);
    }
  }
  return 1.0 - shadow;
}

fn sprite_ice_reflection(world_pos: vec3f, R: vec3f, ice_mm: f32) -> vec4f {
  let count = min(sprite_count(), MAX_SPRITES);
  var best_t = 1e10;
  var best_color = vec4f(0.0);

  for (var i = 0u; i < count; i++) {
    let sp = read_sprite(i);
    let st = sprite_type(sp);
    if (st == SPRITE_NONE) { continue; }

    let hit = ray_billboard_intersect(world_pos, R, sp, st);
    if (hit.w < 0.5 || hit.z > best_t) { continue; }

    let pixel = sample_sprite_color(hit.xy, sp, st);
    if (pixel.a > 0.01) {
      best_t = hit.z;
      best_color = pixel;
    }
  }

  if (best_t < 1e9) {
    let sun_dir = normalize(select(vec3f(0.0, 1.0, 0.0), params.sun_dir, length(params.sun_dir) > 0.001));
    let sun_half = max(dot(vec3f(0.0, 1.0, 0.0), sun_dir), 0.0) * 0.5 + 0.5;
    let is_outdoor = (params.flags & 1u) != 0u;
    let ambient = select(vec3f(params.sky_brightness * 0.3 + 0.12), params.sky_color * 0.35 + vec3f(0.06), is_outdoor);
    let lit = best_color.rgb * (params.sun_color * sun_half * 0.5 + ambient);

    let ice_absorption = vec3f(60.0, 6.0, 1.8);
    let absorb = exp(-ice_absorption * ice_mm * 0.002);

    let fade = exp(-best_t * 0.015);
    return vec4f(lit * absorb, best_color.a * fade);
  }
  return vec4f(0.0);
}

// ---- Sprite lighting with terrain shadow reception ----
fn sprite_light_3d(world_pos: vec3f, base_color: vec3f) -> vec3f {
  let is_outdoor = (params.flags & 1u) != 0u;
  let N = normalize(camera.cam_pos - world_pos);

  let raw_sun = params.sun_dir;
  let sun_len = length(raw_sun);
  let sun_dir = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len, sun_len > 0.001);
  let sun_ndotl = max(dot(N, sun_dir), 0.0);
  let sun_half = sun_ndotl * 0.5 + 0.5;
  let terrain_sun_shadow = shadow_for_sun(world_pos, sun_dir);
  var diffuse = params.sun_color * sun_half * 0.7 * terrain_sun_shadow;

  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - world_pos;
    let dist = length(to_light);
    let L = to_light / max(dist, 0.01);
    let ndotl = max(dot(N, L), 0.0) * 0.5 + 0.5;
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(dist, light.radius);
    }
    if (atten > 0.001) {
      let shadow = shadow_for_light(world_pos, light.pos);
      diffuse += light.color * ndotl * atten * 0.5 * shadow;
    }
  }

  let ambient = select(
    vec3f(params.sky_brightness * 0.3 + 0.15),
    max(params.sky_color * 0.4, vec3f(0.1)) + vec3f(0.05),
    is_outdoor
  );

  var result = base_color * (ambient + diffuse);
  result *= params.exposure;
  result = agx_tonemap(result);
  return result;
}

@fragment
fn fs_sprite(in: SpriteVSOut) -> @location(0) vec4f {
  let slot = in.sprite_idx;
  if (slot >= MAX_SPRITES) { discard; }

  let sp = read_sprite(slot);
  let st = sprite_type(sp);
  if (st == SPRITE_NONE) { discard; }

  // Check if this sprite has height data (skaters, vehicles, goals, custom)
  let has_height = st >= 1u && st <= 16u;

  var uv = in.local_uv;
  var use_normal_lighting = false;
  var N_tangent = vec3f(0.0, 0.0, 1.0);
  var self_shadow: f32 = 1.0;
  var ao: f32 = 1.0;

  if (has_height) {
    // Compute view direction in tangent space for parallax
    let view_world = normalize(camera.cam_pos - in.world_pos);
    let right = camera.billboard_right;
    let up = vec3f(0.0, 1.0, 0.0);
    let fwd = normalize(cross(up, right));

    // Project view direction onto billboard tangent plane
    let view_u = dot(view_world, right);
    let view_v = dot(view_world, up);
    let view_dir_ts = vec2f(view_u, view_v);

    // Apply parallax mapping
    uv = parallax_sprite(in.local_uv, view_dir_ts, sp, st);

    // Bounds check — discard if parallax pushed UV out of sprite
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { discard; }

    // Silhouette clipping: discard pixels with near-zero height
    // Use very low threshold to keep sprite feet/skate blades visible
    let surface_h = sample_sprite_height(uv, sp, st);
    if (surface_h < 0.005) { discard; }

    // Compute per-pixel normal from height atlas (single sample, pre-computed Sobel)
    N_tangent = sprite_height_normal(uv, sp, st);
    use_normal_lighting = true;

    // Self-shadow: march from surface point along sun direction through height field
    let raw_sun = params.sun_dir;
    let sun_len = length(raw_sun);
    if (sun_len > 0.001) {
      let sun_dir = raw_sun / sun_len;
      // Project sun direction into tangent space
      let sun_u = dot(sun_dir, right);
      let sun_v = dot(sun_dir, up);
      let light_dir_ts = vec2f(sun_u, sun_v);
      self_shadow = parallax_self_shadow(uv, light_dir_ts, sp, st);
    }

    // Ambient occlusion from height field
    ao = sprite_ao(uv, sp, st);
  }

  let pixel = sample_sprite_color(uv, sp, st);
  if (pixel.a < 0.01) { discard; }

  var lit: vec3f;
  if (use_normal_lighting) {
    lit = sprite_light_with_normal(in.world_pos, pixel.rgb, N_tangent, camera.billboard_right, self_shadow, ao);
  } else {
    lit = sprite_light_3d(in.world_pos, pixel.rgb);
  }

  return vec4f(lit, pixel.a);
}
