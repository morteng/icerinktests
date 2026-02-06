# Voxel/Columnar Architecture Research

## Recommendation: Multi-Surface Height-Field (NOT full voxels)

The physical constraint that ice < water < snow (always in this order) means full voxel
stacking is overkill. Instead, extend the current vec4f state with a velocity buffer.

## Data Layout (32 bytes/cell total, 2 ping-pong pairs)

**State buffer** (existing, vec4f):
- .x = temperature (°C)
- .y = ice thickness (mm)
- .z = water depth (mm)
- .w = snow/shavings depth (mm)

**Velocity buffer** (NEW, vec4f):
- .x = water velocity X (mm/s)
- .y = water velocity Y (mm/s)
- .z = snow velocity X (wind transport)
- .w = snow velocity Y (wind transport)

## Memory: NHL at 405K cells
- State x2: 12.96 MB
- Velocity x2: 12.96 MB
- Aux buffers: ~8.1 MB
- Readback: 6.48 MB
- **Total: ~40.9 MB** (well within 128 MB limit)

## Multi-Pass Compute Pipeline

Split monolithic heat.wgsl into focused passes:

1. **Heat Diffusion** + Pipe Cooling + Air Coupling (temperature only)
2. **Phase Change** (freeze/melt, local ops, no race conditions)
3. **Water Transport** (virtual pipe / shallow water, checkerboard pattern)
4. **Snow Transport** (wind + angle of repose, Margolus 2x2 blocks)
5. **Interactions** (damage, zamboni, flood, rain, local ops)

### Why multi-pass:
- Each pass uses correct update pattern (checkerboard for transport, parallel for local ops)
- Can skip passes (e.g., skip wind transport for indoor rinks)
- More maintainable than 466-line monolithic shader
- Cost: ~0.1ms dispatch overhead per pass = 0.5ms total

## Bind Groups (staying within 8 storage buffers/stage)

**Group 0** (heat + phase change):
- 0: SimParams, 1: state_in, 2: state_out, 3: pipes, 4: mask, 5: solids, 6: scratches, 7: vel_in

**Group 1** (water + snow transport):
- 0: SimParams, 1: state_in, 2: state_out, 3: vel_in, 4: vel_out, 5: mask, 6: solids, 7: wind

## Transport Methods

### Water: Virtual Pipe Model
- Flow rates between cells based on height differences
- Momentum (waves, splashing, overshoot)
- Clamped outflow (can't lose more water than you have)
- Performance: fine at 900x450 on integrated GPU

### Snow: Saltation Model
```
pickup = saltation_rate * (wind_speed - threshold)² * dt
deposit = airborne_amount * deposition_rate * dt
```

### Wind Shadow Behind Obstacles
- Check 5 cells upwind for solids/mask
- Linear decay shadow causes snow deposition in lee zones
- Per-cell cost: 5 iterations, negligible

## Race Condition Solutions

### Checkerboard Pattern (for water transport)
- Pass 1: process cells where (x+y)%2==0
- Pass 2: process cells where (x+y)%2==1
- Two dispatches, no race conditions

### Margolus 2x2 Blocks (for snow/falling-sand)
- 4-step cycle with offset: (0,0), (1,0), (0,1), (1,1)
- Eliminates directional bias
- All blocks process in parallel

## Performance Estimate (Intel HD 4000, 900x450 grid)
- 6,441 workgroups at @workgroup_size(8,8)
- ~0.5-1.0ms per pass, 2.5-5.0ms for 5 passes
- At 20 dispatches/frame (max speed): 10-20ms, leaves room for rendering

## Key Insight: NOT Noita-style
Noita uses CPU-based falling sand with 64x64 dirty rectangles. For an ice rink:
- Layer order is physically determined (no arbitrary material mixing)
- Height-field with velocity is both cheaper and more physically accurate
- GPU compute with checkerboard pattern is natural fit
