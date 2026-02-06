# Ice Rink Cooling Systems - Engineering Reference

Compiled from ASHRAE guidelines, NRCan studies, IIHF standards, and industry sources.

## 1. Pipe Specifications

### Materials
- **HDPE (High-Density Polyethylene):** Modern standard. Fusion-welded joints, long lifespan.
- **Low-carbon seamless steel:** Traditional. 38mm OD x 3.5mm wall (IIHF spec).
- **PE/LLDPE:** ~25mm diameter thin-wall polymer. LLDPE for portable rink mats.

### Sizes (in-floor grid)
- **1 inch (25mm) OD** dominant in North America
- **3/4 inch (19mm)** for smaller/portable systems
- Steel: 38mm OD x 3.5mm wall
- HDPE: SDR 11 at 1-inch nominal gives ~2.4mm wall

### Header pipes
- Supply/return headers: 6-10 inches (150-250mm) diameter
- Material: PVC, steel, or HDPE (fusion-welded HDPE preferred)
- Saddle fitting spacing: 7 inches on center (for 3.5-inch floor pipe spacing)

## 2. Layout Patterns

### Pipe spacing (center-to-center)
- **Typical: 75-100mm (3-4 inches)**
- Close-spacing: 3.5 inches (89mm), +30% cooling surface, 10-15% better efficiency
- Research tested 50.8-152.4mm; wider spacing degrades uniformity

### Pattern
- **Header-and-lateral** is standard: parallel straight pipes along rink length
- Headers at: mid-rink, end-feed, or side-feed
- End-feed and mid-rink most common for hockey rinks

### Total pipe length
- Standard NHL rink (26m x 61m): ~5 miles (8km) of floor piping
- Larger/direct-expansion: up to 10 miles (16km)

## 3. Interconnection and Circuits

### Pass configuration
- **Two-pass** most common: brine flows down one pipe, U-turns, returns through adjacent pipe
- Adjacent pipes carry coolant in **opposite directions** (counterflow) - key for temperature uniformity
- Four-pass: worse uniformity but halves flow rate
- NRCan: two-pass significantly more uniform than four-pass

### Number of circuits
- ~296 pipes in two-pass = ~148 parallel circuits
- Each circuit ~120-130m long (two rink lengths + U-turn)

### Headers/manifolds
- One supply + one return header (or two each if mid-rink feed)
- 6-10 inch diameter, oversized for even flow distribution
- All floor pipes connect in parallel between headers

## 4. Coolant / Brine

### Fluid types
- **CaCl2 brine:** Most common (North America). Better heat transfer than glycol, lower pumping power. Corrosive (needs pH buffering 7.5-8.5).
- **Ethylene glycol:** ~3.3 kJ/kgK specific heat
- **Propylene glycol:** Less toxic alternative
- **Ammonia (NH3):** Primary refrigerant in indirect systems (not in floor pipes)
- **CO2:** Emerging for direct-expansion floor systems

### CaCl2 brine properties (~22% concentration at -10C)
- Density: ~1,190-1,230 kg/m3
- Specific heat: ~2.9-3.0 kJ/kgK
- Thermal conductivity: ~0.52-0.54 W/mK
- Freeze point: -18 to -29C (mixed to -21 to -23C in practice)

### Temperatures
- **Supply to floor:** -9C to -15C
- **Return from floor:** -6C to -10C
- **Delta-T across rink:** 3-5C (NRCan measured up to 4C rise)
- **Along single pipe run:** ~0.7C variation (NRCan, beyond 20cm from inlet)

### Flow rates
- Total brine: ~900 GPM (~57 L/s) with 22kW pump
- Reduced: ~450 GPM (~28.5 L/s) with 11kW pump
- Head pressure: ~226-263 kPa

## 5. Temperature Gradient Effects

### The problem
Brine warms as it flows. Inlet end of circuit has colder ice than outlet end.

### Measured magnitude
- Two-pass: 0.7C surface variation near pipe outlet (NRCan)
- Four-pass: significantly larger fluctuation

### Compensation strategies
1. **Two-pass counterflow:** Adjacent pipes flow opposite directions, averaging temperature
2. **Alternating flow direction** for circuit groups
3. **Multiple independent circuits** for zone control
4. **Oversized headers** for even flow distribution
5. **Higher flow rates** to reduce per-circuit delta-T

## 6. Power Consumption

### Total facility energy
- Typical: 600,000-2,000,000 kWh/year
- Standard: ~1,500,000 kWh/year
- Efficient: ~800,000 kWh/year

### Breakdown
- Refrigeration: 40-65% (compressors + pumps + condensers)
- Heating: ~26%
- Lighting: ~10-15%
- Ventilation/dehumidification: ~5-10%

### Compressor
- Capacity: 45-300 tons refrigeration (158-1,055 kW thermal)
- Standard single-sheet NHL rink: ~100 tons (352 kW thermal)
- COP (ammonia reciprocating): 1.2-1.6
- Per 1C suction pressure raise: ~1.5% power reduction

### Brine pump
- 11-25 kW motor
- >15% of refrigeration system energy

## 7. Concrete Slab Cross-Section (Top to Bottom)

| Layer | Thickness | Notes |
|-------|-----------|-------|
| Ice surface | 19-38mm | Hockey: 25-32mm; figure skating: up to 38mm |
| Concrete slab (with cooling pipes) | 100-150mm | Reinforced. Pipes at mid-depth. |
| Insulation | 50-100mm | EPS R-3.85-4.2/inch; XPS R-4.5-5.0/inch |
| Heated slab (with heating pipes) | 75-100mm | Warm brine at 4.4-6.6C, pipes at 300-600mm centers |
| Sand/gravel base | 150-300mm | Compacted |
| Drainage layer | Variable | Groundwater management |
| Subgrade soil | -- | Natural ground |

### Key points
- Insulation separates cooling slab from heating slab
- Without sub-slab heating: frost heave damages slab
- Ground heat gain: 2-3% of total refrigeration load

## 8. Thermal Parameters for Simulation

### Material Properties

| Material | k (W/mK) | rho (kg/m3) | cp (J/kgK) |
|----------|-----------|-------------|-------------|
| Ice (0C) | 2.22 | 917 | 2,090 |
| Water (0C) | 0.561 | 999.8 | 4,217 |
| Concrete (standard) | 1.4-1.8 | 2,300 | 880 |
| Concrete (improved, iron ore agg.) | 2.6 | ~2,500 | ~880 |
| EPS insulation | 0.033-0.040 | 15-30 | 1,450 |
| CaCl2 brine (22%) | ~0.53 | ~1,210 | ~2,970 |
| Steel pipe | 50 | 7,850 | 500 |
| HDPE pipe | 0.46-0.52 | 950 | 1,900 |

**Latent heat of fusion (ice):** 334 kJ/kg

### Heat Transfer Coefficients

| Interface | Value | Notes |
|-----------|-------|-------|
| Air-to-ice convection | 3-10 W/m2K | Low air velocity: 3-6; textbook: 10 |
| Ice emissivity | 0.95 | For radiation |
| Brine-to-pipe (internal) | 200-1000 W/m2K | Depends on Re |

### Heat Load Components (typical indoor hockey rink, ~1,500 m2)

| Component | % of Total | W/m2 | Notes |
|-----------|-----------|------|-------|
| Ceiling radiation | 25-43% | 40-100 | Varies with ceiling temp |
| Convection (sensible+latent) | 28-75% | 30-80 | Includes condensation |
| Ground conduction | 2-3% | 3-5 | Through insulation |
| Lighting | 5-10% | 5-15 | LED reduces this |
| Resurfacing (Zamboni) | 11-17% | transient | 300-500L hot water at 30-60C |
| Piping heat gains | 2-4% | -- | Headers, pump losses |

**Total steady-state load:** ~136 W/m2 (maintenance), ~158 W/m2 (during resurfacing)

### Phase Change
- Ice builds in layers: 0.8-1.6mm per Zamboni pass
- Total ice: 12+ layers over 48-72 hours
- Resurfacing removes ~1mm ice, deposits equivalent hot water
- Water at 60C: 251 kJ/kg sensible cooling + 334 kJ/kg latent = 585 kJ/kg total

## 9. Ice Markings Application and Maintenance

### Process
Ice markings (lines, circles, logos) are painted onto the ice during initial build-up, not on the finished surface. The standard process is:

1. **Base layer:** Build 6-7mm (~1/4 inch) of clear ice first
2. **White paint coat:** Spray an even coat of white paint (titanium dioxide in water) over entire surface for the white "background"
3. **Seal white layer:** Flood with thin water layers, build 1-2mm of clear ice over the white
4. **Paint markings:** Apply colored markings (red/blue lines, circles, logos, crease lines) using templates, string lines, and paint sprayers
5. **Seal markings:** Carefully flood with multiple thin layers of cold water (misting) to build 6-10mm of clear ice over the markings
6. **Final build:** Continue building ice to operational thickness (25-32mm total)

### Key Details
- **Paint depth:** Markings sit at approximately 6-7mm (1/4") from the concrete slab surface
- **Paint type:** Water-based acrylic paint, specifically formulated for ice rinks
- **White base:** Critical for visibility — markings are painted on the white layer, not directly on clear ice
- **Sealing:** Thin misting coats (not heavy floods) prevent paint from lifting or bleeding
- **Total ice over markings:** 15-25mm of clear ice above the paint layer

### Visibility vs Ice Thickness
- **< 3mm:** No markings visible (paint not yet applied, or ice too thin — paint has been destroyed by melting)
- **3-6mm:** Paint at or near the ice surface — exposed, degraded, partially worn by skate blades and resurfacing
- **6-10mm:** Paint being sealed under clear ice — increasingly vivid as protective layer builds
- **> 10mm:** Fully sealed — markings at maximum vibrancy, protected under clear ice

### Damage and Maintenance
- **Skate cuts:** If ice thins below ~6mm (e.g., from aggressive resurfacing or warm conditions), markings become exposed and degrade rapidly
- **Resurfacing risk:** Zamboni shaves ~1mm per pass; too many passes without rebuilding can expose markings
- **Repair:** If markings are damaged, they cannot be repainted without shaving down to the paint layer and rebuilding
- **Complete rebuild:** Markings are redone during seasonal ice installation or after major damage (melt-and-rebuild)
- **Typical lifespan:** Markings last the entire season (6-8 months) under normal maintenance

### NHL/IIHF Marking Specifications
- **Center red line:** 30cm (12") wide, extends full width of rink
- **Blue lines:** 30cm wide, positioned 19.5m from each end (NHL) or 22.86m (IIHF)
- **Face-off circles:** 4.57m (15ft) radius, 5cm wide lines
- **Face-off dots:** 30cm (12") diameter
- **Goal crease:** Blue-painted half-circle, 1.83m radius
- **Center ice dot:** 30cm diameter blue dot
- **Boundary/boards line:** Red line at rink perimeter

## Sources

- ASHRAE Handbook of Refrigeration, Chapter 44 - Ice Rinks
- NRCan - Effects of Multi-Pass Brine System on Ice Temperature
- MDPI - Simulation of Optimal Refrigerated Floor Design for Ice Rinks
- MDPI - Parametric Evaluation of Cooling Pipe in Direct Evaporation Ice Rinks
- IIHF Sustainable Ice Rink Guide (2023)
- NRCan - Comparative Study of Refrigeration Systems for Ice Rinks
