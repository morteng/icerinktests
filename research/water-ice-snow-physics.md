# Comprehensive Physics of Water, Ice, Snow, Slush, and Ice Shavings on Rink Surfaces

## 1. Snow on Cold Ice: Sintering and Bonding

**Mechanism**: When snow lands on cold ice, bonding occurs through **sintering** -- ice grains develop necks at contact points via vapor diffusion (sublimation from convex surfaces, deposition at concave contact points).

**Rate and temperature dependency**:
- Primary sintering mechanism on timescales of hours to days is **vapor diffusion**
- Bond-to-grain ratio grows as power law: proportional to t^(1/5), measured exponent 0.18 +/- 0.01
- For contact times >100-1000s, bond area growth proportional to t^0.4
- Rate increases sharply with temperature. Maximum rate at **-5°C**
- Sintering follows Arrhenius behavior: Ea ≈ 11.5 kJ/mol, rate roughly doubles per 5-7°C increase

**Practical behavior**:
- At -5°C: Snow bonds noticeably within minutes to hours
- At -10°C: Hours to form weak bonds, days for strong bonds
- At -20°C and below: Very slow, snow remains loose powder for days
- Liquid water dramatically accelerates sintering by orders of magnitude

**Simulation**: tau_sinter ~ 100s * exp(Ea/R * (1/T - 1/268)) where T in Kelvin

**KEY INSIGHT**: Snow does NOT "sinter into ice" in the way our sim models it. Sintering creates inter-grain bonds but the snow retains its granular structure. Snow becomes ice only through:
1. Melt-refreeze (requires liquid water phase)
2. Extreme pressure (glacial, not relevant here)
3. Very long timescales (months-years for firn→ice transition)

Sources:
- [Sintering rate of snow](https://www.cambridge.org/core/journals/journal-of-glaciology/article/experimental-and-numerical-investigation-of-the-sintering-rate-of-snow/0EE38666F876660D5D5176418E1A8356)
- [Ice sintering dependencies](https://pubs.aip.org/aip/jap/article/131/2/025109/2836434)
- [Avalanche.org: Bonding](https://avalanche.org/avalanche-encyclopedia/snowpack/snow-metamorphism/bonding-or-sintering/)

---

## 2. Ice Shavings vs. Natural Snow

**Ice shavings (from skating/zamboni)**:
- Thin curls/chips of solid ice, mechanically fractured
- Grain shape: elongated fragments, shards, curls (not rounded)
- Density: **300-500 kg/m³** loosely piled
- Grain size: **0.5-3 mm**, much larger and more angular than natural snow

**Natural snow**:
- Crystal forms: dendrites, plates, columns, needles
- Fresh grain size: **<0.5 mm**
- Fresh density: **50-100 kg/m³**
- Old/settled grain size: 0.5-2 mm rounded grains

**Key differences for simulation**:
- Ice shavings are 3-8x denser than fresh snow
- Higher thermal conductivity (more ice per volume)
- Sinter more slowly (larger grains, fewer contact points)
- Melt faster (less air insulation)
- Appear more translucent/glassy vs bright white of fresh snow

---

## 3. Snow Compaction and Metamorphism

### Three metamorphic processes:

**A. Equitemperature (isothermal)** (gradient < 5°C/m):
- Surface energy minimization → grains become more rounded and larger
- Timescale: days to weeks
- Bond-to-grain ratio increases, snow strengthens

**B. Temperature gradient** (gradient > 10-25°C/m):
- Produces faceted crystals and depth hoar (large, angular, weak)
- Timescale: days to weeks
- Weakens snowpack despite grain growth

**C. Melt-freeze** (liquid water present):
- Produces large rounded "corn snow" grains (1-3 mm)
- Refreezing creates strong inter-grain bonds
- Timescale: hours

### Compaction/settling rates:
- Fresh snow (50-100 kg/m³) → 150-200 kg/m³ in first 24-48 hours
- Rate drops sharply after reaching ~150 kg/m³
- Wind compaction → 280-400 kg/m³ rapidly
- Rain on snow increases compaction rate by **3-5 orders of magnitude**
- Model: rho(t) = rho_eq - (rho_eq - rho_0) * exp(-t/tau), tau~24-72h

---

## 4. Slush Formation

Slush = snow saturated with liquid water (LWC >15% by mass)

### Water content regimes:
| Regime | LWC (% by mass) | Character |
|--------|-----------------|-----------|
| Dry | 0% | No liquid water |
| Moist | 0-3% | Barely detectable |
| Wet (pendular) | 3-8% | Isolated water menisci at grain contacts |
| Very wet | 8-15% | Transition pendular→funicular |
| Slush (funicular) | >15% | Continuous water paths, snow loses structure |

**Irreducible water content**: ~7% of pore volume (held by capillary forces, does not drain)

---

## 5. Freeze/Thaw of Water Layers (Zamboni Resurfacing)

### Stefan problem: h(t) = sqrt(2 * k_ice * dT * t / (rho_ice * L))

### Practical freezing rates:
| Ice Temperature | 0.5mm layer freeze time |
|----------------|------------------------|
| -5°C | ~2-4 minutes |
| -10°C | ~1-2 minutes |
| -15°C | ~30-60 seconds |

### Why hot water for resurfacing:
- Releases dissolved gases → clearer, denser ice
- Slightly melts underlying surface → better bonding
- Spreads more evenly (lower viscosity at higher T)

---

## 6. Snow Melting on Ice

### Key insight: Snow insulates ice
- Even 1-2 cm of snow dramatically reduces heat exchange
- On cold ice: snow melts from TOP (air contact), not bottom
- Snow acts as blanket: keeps cold ice cold in warm air

### Melt rates:
- Solar radiation: ~1 mm SWE/hour at 100 W/m² net absorption
- Conductive melt depends on air temp, wind, humidity

---

## 7. Thermal Properties Reference

### Pure Ice:
| T (°C) | ρ (kg/m³) | k (W/m/K) | cp (J/kg/K) |
|---------|-----------|-----------|-------------|
| 0 | 917 | 2.16 | 2,100 |
| -5 | 917.5 | 2.25 | 2,027 |
| -10 | 918.9 | 2.30 | 2,000 |
| -20 | 919.4 | 2.39 | 1,943 |

### Water at 0°C:
- k = 0.56 W/m/K, cp = 4,186 J/kg/K
- L_fusion = **334,000 J/kg**
- Surface tension = 75.6 mN/m
- Contact angle on ice = **12°**

### Snow thermal conductivity (Sturm 1997):
- ρ ≥ 156 kg/m³: **k = 0.138 - 1.01ρ + 3.233ρ²** (ρ in g/cm³)
- ρ < 156 kg/m³: **k = 0.023 + 0.234ρ**

| Density (kg/m³) | k (W/m/K) | Type |
|-----------------|-----------|------|
| 50 | 0.035 | Fresh powder |
| 100 | 0.046 | New snow |
| 200 | 0.085 | Settled |
| 300 | 0.18 | Wind-packed |
| 400 | 0.35 | Ice shavings |
| 500 | 0.56 | Dense compacted |

---

## 8. Density Reference

| Material | Density (kg/m³) |
|----------|-----------------|
| Wild/very fresh snow | 10-30 |
| Fresh snow (calm) | 50-65 |
| Fresh snow (general) | 50-100 |
| Settling snow | 70-90 |
| Settled (days) | 150-250 |
| Wind-packed | 280-350 |
| Hard wind slab | 350-400 |
| Ice shavings (loose) | 300-500 |
| Compacted (foot traffic) | 400-550 |
| Slush | 500-800 |
| Pure ice | 917 |

---

## 9. Optical Properties

### Albedo:
| Surface | Albedo |
|---------|--------|
| Fresh dry snow | 0.85-0.95 |
| Old dry snow | 0.70-0.80 |
| Ice shavings | 0.55-0.75 |
| Wet snow | 0.50-0.70 |
| Dirty snow | 0.20-0.40 |
| Clear ice | 0.10-0.20 |

- Visible: albedo high regardless of grain size; contaminants dominate
- NIR: **strongly grain-size dependent** — larger grains absorb more
- Wet darkening: 10-30% darker than dry equivalent

---

## 10. Water Behavior on Ice

- Contact angle: **11.8° ± 1.2°** (partial wetting, not complete)
- Ice-air interfacial tension: ~105 mN/m
- Water spreads but does not form infinitely thin film
- On real rinks: water flows to low spots and pools

---

## 11. Ice Surface Quality

### Optimal temperatures:
| Sport | Ice T (°C) | Rationale |
|-------|-----------|-----------|
| Speed skating | -5 to -9 | Hard, minimal friction |
| Hockey (game) | -6 to -8 | Hard for durability |
| Figure skating | -3 to -3.5 | Soft for landings |

### Ice hardness: P(T) = (-0.6±0.4)T + 14.7±2.1 MPa
- Friction minimum at **-7°C** (μ ≈ 0.003-0.005)
- Below -7°C: friction increases (too hard, insufficient QLL)
- Above -7°C: friction increases (too soft, ploughing)

---

## 12. Rain/Snow on Outdoor Rinks

### Rain on ice:
- Cold ice: freezes on contact → rough "orange peel" texture
- Near 0°C ice: pools and flows as liquid
- Carries debris that freezes into surface

### Snow on ice:
- Acts as insulator (reduces air-ice heat exchange)
- Should be removed within 12-18 hours
- If not removed: sinters to ice surface, very hard to remove cleanly

---

## Ice Appearance (Rendering Reference)

### Why pro rinks look bright white:
- **White paint** sprayed at ~1mm depth, NOT the ice itself
- Pure ice is nearly transparent in visible spectrum
- White paint (TiO₂/ZnO) acts as high-albedo diffuse reflector under transparent ice
- ~300 gallons of paint-water mixture covers NHL rink surface

### Backyard rink appearance:
- No white paint → appearance dominated by underlying surface
- Dark liner/ground → dark, mirror-like "black ice" look
- White liner → brighter, cleaner appearance
- Thin ice on dark ground is the classic dark reflective look

### Key visual factors:
1. **Underlying surface** is the #1 factor in ice appearance
2. **Fresnel reflection**: R0=0.018, highly reflective at grazing angles
3. **Surface condition**: freshly resurfaced = mirror-smooth, used = scratched/cloudy
4. **Beer-Lambert absorption**: subtle blue tint through clear ice
5. **Environment reflection**: ice reflects sky/ceiling at grazing angles

### Ice thickness and appearance:
- <3mm: nearly transparent, see-through to ground
- 3-10mm: still largely transparent, subtle blue tint developing
- 10-30mm (typical rink): white paint visible through ice, blue-tinted
- >50mm: begins to appear blue-green on its own (glacier effect)
