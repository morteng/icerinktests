# Snow Physics Simulation Parameters

## Snow Crystal Metamorphism
- **Equitemperature (ET)**: Sharp points → rounded grains. Timescale: 1-3 days to lose branches, 1-2 weeks full rounding. Grain growth: d(t) = d0 + C*sqrt(t), ~0.02 mm/day at -5°C
- **Temperature Gradient (TG)**: gradient > 10°C/m → faceted crystals/depth hoar (2-10mm). Forms in 3-7 days
- **Melt-Freeze**: Diurnal cycling → polycrystalline clusters 1-5mm ("corn snow"). 3-7 cycles to develop

## Density Ranges (kg/m³)
| Type | Density |
|------|---------|
| Wild snow (calm, cold) | 10-30 |
| Fresh powder | 50-100 |
| Fresh (mild) | 100-150 |
| Settled (days) | 150-250 |
| Wind-packed slab | 300-450 |
| Depth hoar | 150-250 |
| Corn snow | 350-500 |
| Ice shavings (fresh) | 300-500 |
| Ice shavings (zamboni pile) | 400-600 |

## Angle of Repose
| Type | Angle |
|------|-------|
| Fresh dry powder | 40-60° |
| Settled/rounded | 35-45° |
| Wind-packed slab | 60-90° |
| Wet snow | 15-30° |
| Ice shavings (fresh) | 30-40° |
| Ice shavings (wet) | 15-25° |

## Compaction
- Fresh powder (50-80 kg/m³): loses 30-50% height in first 24h
- After 1 week: ~150-200 kg/m³
- Seasonal settled: 200-350 kg/m³
- Simple model: rho(t) = rho_eq - (rho_eq - rho_0) * exp(-t/tau), tau~24-72h

## Thermal Properties
- k ≈ 2.5e-6 * rho² - 1.23e-4 * rho + 0.024 [W/(m·K)]
  - 50 kg/m³ → 0.025, 200 → 0.074, 400 → 0.270
- c_ice = 2090 J/(kg·K)
- L_fusion = 334,000 J/kg
- L_sublimation = 2,830,000 J/kg
- Snow as insulator: 30cm at rho=100 → R=7.9 m²·K/W (slows ice cooling!)

## Wind Transport
- Creep: surface rolling, 5-25% of transport, lowest wind speeds
- Saltation: bouncing 1-10cm high, 50-75% of transport
- Suspension: fine particles lofted meters, >10-15 m/s

### Threshold Speeds
| Surface | u*t (m/s) | U_10m (m/s) |
|---------|-----------|-------------|
| Fresh loose powder | 0.15-0.25 | 4-7 |
| Partially sintered (12h) | 0.25-0.35 | 7-10 |
| Wind-packed slab | 0.40-0.60 | 12-18 |
| Fresh ice shavings | 0.20-0.30 | 5-8 |

### Drift Patterns
- Behind obstacle (fence, boards): deposition 5-15H downwind, peak at 3-8H
- 50% porous fence: drift 15-20H downwind, 5H upwind, peak height ~0.8-1.0H
- Building corners: scour zones, wind acceleration

## Snow-Water Interaction
- Irreducible saturation: 3-8% liquid water by volume before draining
- Percolation velocity: 0.1-1.0 m/hour
- Refreezing: m_refreeze = c_ice * rho_snow * dT / L_f per volume
- Ice layers form as barriers to further percolation

## Sublimation
- Calm, -10°C, RH=80%: 0.05-0.15 mm w.e./day
- Windy 10 m/s, -10°C, RH=50%: 0.5-1.5 mm w.e./day
- Blowing snow event: 1-5 mm w.e./day

## Albedo
| Type | Albedo |
|------|--------|
| Fresh dry snow | 0.85-0.95 |
| Fresh wet snow | 0.75-0.85 |
| Aged dry (days) | 0.70-0.80 |
| Dirty snow | 0.30-0.50 |
| Ice shavings (fresh) | 0.60-0.75 |
| Ice rink surface | 0.10-0.30 |

## Simulation Parameters
```
SHAVINGS_DENSITY = 400 kg/m³
SHAVINGS_CONDUCTIVITY = 0.25 W/(m·K)
SHAVINGS_REPOSE_DRY = 35°
SHAVINGS_REPOSE_WET = 20°
SHAVINGS_MELT_FACTOR = 2.0
SHAVINGS_WIND_THRESHOLD = 12 m/s
SHAVINGS_ALBEDO = 0.65

SNOW_DENSITY_FRESH = 80 kg/m³
SNOW_CONDUCTIVITY_FRESH = 0.03 W/(m·K)
SNOW_REPOSE_DRY = 50°
SNOW_REPOSE_WET = 20°
SNOW_WIND_THRESHOLD = 5 m/s
SNOW_ALBEDO_FRESH = 0.90
SNOW_COMPACTION_TAU = 48h
SNOW_DENSITY_SETTLED = 250 kg/m³
```
