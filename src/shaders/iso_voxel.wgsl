// Isometric 3D renderer — voxel box for zamboni
// Renders a procedural 3D oriented box with 36 vertices (12 triangles, 6 faces)
// Rotated by heading, per-face coloring, PBR lit

struct VoxelVSOut {
  @builtin(position) clip_pos: vec4f,
  @location(0) world_pos: vec3f,
  @location(1) world_normal: vec3f,
  @location(2) @interpolate(flat) face_id: u32,
  @location(3) face_uv: vec2f,
}

@vertex
fn vs_voxel(@builtin(vertex_index) vid: u32) -> VoxelVSOut {
  var out: VoxelVSOut;
  out.clip_pos = vec4f(0.0, 0.0, 0.0, 1.0);
  out.world_pos = vec3f(0.0);
  out.world_normal = vec3f(0.0, 1.0, 0.0);
  out.face_id = 0u;
  out.face_uv = vec2f(0.0);

  // Read zamboni sprite from slot 2
  let sp = read_sprite(2u);
  let st = sprite_type(sp);
  // Only render for zamboni type (4)
  if (st != SPRITE_ZAMBONI) { return out; }

  let cell_m = params.cell_size;
  let heading = sp.dir; // heading in radians

  // Box dimensions in world units (cells)
  // sp.width = body width (cells), sp.height = body length (cells)
  let box_w = sp.width;          // width (perpendicular to travel)
  let box_l = sp.height;         // length (along travel direction)
  let box_h = 1.5 / cell_m;     // height: ~1.5m in cells

  let half_w = box_w * 0.5;
  let half_l = box_l * 0.5;
  let half_h = box_h * 0.5;

  // 6 faces × 6 vertices = 36
  let face_id = vid / 6u;
  let corner_in_face = vid % 6u;

  // Each face: 2 triangles (0,1,2) + (1,3,2) reindexed as (0,1,2,1,3,2)
  var cx: f32 = 0.0;
  var cy: f32 = 0.0;
  switch corner_in_face {
    case 0u: { cx = -1.0; cy = -1.0; }
    case 1u: { cx =  1.0; cy = -1.0; }
    case 2u: { cx = -1.0; cy =  1.0; }
    case 3u: { cx =  1.0; cy = -1.0; }
    case 4u: { cx =  1.0; cy =  1.0; }
    case 5u: { cx = -1.0; cy =  1.0; }
    default: {}
  }

  // Define face vertices in local box space (before rotation)
  // Local space: X = along travel, Y = up, Z = perpendicular
  var local_pos: vec3f;
  var local_normal: vec3f;

  switch face_id {
    case 0u: {
      // Top face (Y+)
      local_pos = vec3f(cx * half_l, half_h, cy * half_w);
      local_normal = vec3f(0.0, 1.0, 0.0);
    }
    case 1u: {
      // Bottom face (Y-)
      local_pos = vec3f(cx * half_l, -half_h, -cy * half_w);
      local_normal = vec3f(0.0, -1.0, 0.0);
    }
    case 2u: {
      // Front face (X+, blade end)
      local_pos = vec3f(half_l, cy * half_h, cx * half_w);
      local_normal = vec3f(1.0, 0.0, 0.0);
    }
    case 3u: {
      // Back face (X-, water/towel end)
      local_pos = vec3f(-half_l, cy * half_h, -cx * half_w);
      local_normal = vec3f(-1.0, 0.0, 0.0);
    }
    case 4u: {
      // Right side (Z+)
      local_pos = vec3f(cx * half_l, cy * half_h, half_w);
      local_normal = vec3f(0.0, 0.0, 1.0);
    }
    case 5u: {
      // Left side (Z-)
      local_pos = vec3f(-cx * half_l, cy * half_h, -half_w);
      local_normal = vec3f(0.0, 0.0, -1.0);
    }
    default: {}
  }

  // Rotate local position by heading around Y axis
  // heading = 0 means facing +X in world space
  let ch = cos(heading);
  let sh = sin(heading);
  let rotated_x = local_pos.x * ch - local_pos.z * sh;
  let rotated_z = local_pos.x * sh + local_pos.z * ch;

  // Rotate normal similarly
  let rot_nx = local_normal.x * ch - local_normal.z * sh;
  let rot_nz = local_normal.x * sh + local_normal.z * ch;

  // Position at ice surface height
  let surface_h = ice_surface_height(sp.x, sp.y);

  // World position: center at sprite position, bottom of box at ice surface
  let world_pos = vec3f(
    sp.x + rotated_x,
    surface_h + local_pos.y + half_h, // shift up so bottom sits on ice
    sp.y + rotated_z,
  );

  let clip_pos = camera.proj * camera.view * vec4f(world_pos, 1.0);

  out.clip_pos = clip_pos;
  out.world_pos = world_pos;
  out.world_normal = vec3f(rot_nx, local_normal.y, rot_nz);
  out.face_id = face_id;
  out.face_uv = vec2f(cx * 0.5 + 0.5, cy * 0.5 + 0.5);
  return out;
}

// Per-face colors for the zamboni box
fn zamboni_face_color(face_id: u32, uv: vec2f, anim_time: f32) -> vec3f {
  switch face_id {
    case 0u: {
      // Top: white body with subtle panel lines
      let panel = step(0.48, abs(uv.x - 0.5)) * 0.05;
      return vec3f(0.88, 0.88, 0.90) - vec3f(panel);
    }
    case 1u: {
      // Bottom: dark undercarriage
      return vec3f(0.12, 0.12, 0.14);
    }
    case 2u: {
      // Front (blade end): metallic silver blade
      let blade_stripe = smoothstep(0.3, 0.35, uv.y) * (1.0 - smoothstep(0.65, 0.7, uv.y));
      let silver = vec3f(0.65, 0.68, 0.72);
      let body = vec3f(0.82, 0.82, 0.85);
      return mix(body, silver, blade_stripe);
    }
    case 3u: {
      // Back (water end): blue-gray water system
      let pipe = smoothstep(0.35, 0.4, uv.y) * (1.0 - smoothstep(0.6, 0.65, uv.y));
      let blue_gray = vec3f(0.35, 0.45, 0.58);
      let body = vec3f(0.75, 0.78, 0.82);
      return mix(body, blue_gray, pipe);
    }
    case 4u, 5u: {
      // Sides: hazard stripes (orange/black diagonal)
      // Upper body is white, lower has warning stripes
      if (uv.y > 0.65) {
        // Upper body panels
        return vec3f(0.85, 0.85, 0.88);
      }
      // Warning stripe band
      let stripe_coord = uv.x * 6.0 + uv.y * 3.0 + anim_time * 0.0; // static stripes
      let stripe = step(0.5, fract(stripe_coord));
      let orange = vec3f(0.92, 0.55, 0.0);
      let black = vec3f(0.10, 0.10, 0.10);
      return mix(black, orange, stripe);
    }
    default: {
      return vec3f(0.5);
    }
  }
}

@fragment
fn fs_voxel(in: VoxelVSOut) -> @location(0) vec4f {
  let sp = read_sprite(2u);
  let st = sprite_type(sp);
  if (st != SPRITE_ZAMBONI) { discard; }

  let base_color = zamboni_face_color(in.face_id, in.face_uv, params.anim_time);
  let N = normalize(in.world_normal);

  // PBR lighting (simplified — diffuse + specular)
  let is_outdoor = (params.flags & 1u) != 0u;
  let V = normalize(camera.cam_pos - in.world_pos);

  // Sun light
  let raw_sun = params.sun_dir;
  let sun_len = length(raw_sun);
  let sun_dir = select(vec3f(0.0, 1.0, 0.0), raw_sun / sun_len, sun_len > 0.001);
  let sun_ndotl = max(dot(N, sun_dir), 0.0);

  // Terrain shadow from heightfield
  let terrain_shadow = shadow_for_sun(in.world_pos, sun_dir);

  var diffuse = params.sun_color * sun_ndotl * 0.8 * terrain_shadow;

  // Specular (metallic front face, matte body)
  let roughness = select(0.4, 0.15, in.face_id == 2u); // front is shinier
  let H = normalize(V + sun_dir);
  let NdotH = max(dot(N, H), 0.0);
  let NdotV = max(dot(N, V), 0.001);
  let NdotL = max(dot(N, sun_dir), 0.0);
  let D = D_GGX(NdotH, roughness);
  let G = G_Smith(NdotV, NdotL, roughness);
  let F = F_Schlick(max(dot(H, V), 0.0), 0.04);
  let spec = D * G * F / (4.0 * NdotV * NdotL + 0.001);
  diffuse += params.sun_color * spec * NdotL * terrain_shadow;

  // Point lights
  let light_count = min(params.light_count, MAX_LIGHTS);
  for (var i = 0u; i < light_count; i++) {
    let light = params.lights[i];
    let to_light = light.pos - in.world_pos;
    let dist = length(to_light);
    let L = to_light / max(dist, 0.01);
    let ndotl = max(dot(N, L), 0.0);
    var atten = light.intensity;
    if (light.radius > 0.0) {
      atten *= attenuation_ue4(dist, light.radius);
    }
    if (atten > 0.001) {
      let shadow = shadow_for_light(in.world_pos, light.pos);
      diffuse += light.color * ndotl * atten * 0.6 * shadow;
    }
  }

  // Ambient
  let ambient = select(
    vec3f(params.sky_brightness * 0.35 + 0.12),
    max(params.sky_color * 0.4, vec3f(0.08)) + vec3f(0.04),
    is_outdoor
  );

  var result = base_color * (ambient + diffuse);
  result *= params.exposure;
  result = agx_tonemap(result);

  return vec4f(result, 1.0);
}
