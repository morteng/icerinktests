# PBR Rendering Parameters for Ice/Water/Snow

## Ice Optical Properties
- n_ice = 1.31, Fresnel R0 = 0.018 (1.8% reflection at normal incidence)
- Absorption coefficients (1/m): Red=0.6, Green=0.06, Blue=0.018
- Beer-Lambert: T(λ) = exp(-α(λ) * d)
- Blue tint only visible >0.5m naturally; use exaggeration factor ~50-200 for rink ice
- Clarity: slow freeze (<0.5mm/h) = clear, fast (>2mm/h) = cloudy/white
- Bubbles increase scattering coefficient, correlate with freeze rate

## Water Optical Properties
- n_water = 1.33, Fresnel R0 = 0.020
- Absorption (1/m): Red=0.45, Green=0.06, Blue=0.015
- For rink depths (0-10mm) absorption is negligible; main effects: reflection, caustics
- Thin-film interference only at <1μm (initial melting/final evaporation)
- Caustics: Voronoi-based or layered sine patterns modulated by depth

## Snow Optical Properties
- White from multiple scattering (asymmetry parameter g=0.86)
- Single-scattering albedo ~0.99 at visible wavelengths
- Grain size → albedo: 0.05mm=0.98-0.99, 0.5mm=0.95-0.97, 2mm=0.90-0.93
- Wet snow 20-40% darker (water fills air gaps)
- Snow opaque at ~15-20mm, semi-transparent at 5-10mm
- Subsurface e-folding: 0.1mm grain=2cm, 0.5mm=5cm, 1.0mm=10cm
- Shadows on snow appear blue (lit by Rayleigh-scattered skylight)

## Atmospheric Scattering
- Rayleigh β (sea level, 1/m): R=5.8e-6, G=13.5e-6, B=33.1e-6
- Mie β: ~21e-6 (wavelength-independent)
- Scale heights: Rayleigh=8400m, Mie=1200m
- Sun color shifts: noon=white/yellow, 30°=warm yellow, 10°=orange, 2°=deep red, 0°=red
- Cloud cover: 0%=85:15 direct:diffuse, 50%=35:65, 100%=0:100, total drops to 35-40%

## Shadow Casting
- Ray marching on height-field recommended over shadow mapping
- Sun angular radius: 0.27° → penumbra width = distance * 0.0047
- IQ soft shadow technique: track min(clearance/distance) ratio

## Combined Column Rendering (top to bottom)
1. Snow/Shavings: subsurface scattering, sparkle, blue shadows
2. Water: Fresnel reflection, caustics, thin-film, wet darkening
3. Ice: Beer-Lambert tint, clarity/cloudiness, markings at 6mm depth
4. Concrete: base gray, visible through thin ice

## Physical Constants
| Property | Value |
|----------|-------|
| Ice n | 1.31 |
| Water n | 1.33 |
| Ice R0 | 0.018 |
| Water R0 | 0.020 |
| Snow g | 0.86 |
| Snow SSA | ~0.99 |
| Sun angular radius | 0.27° |
