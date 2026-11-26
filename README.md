# shade355 — 355 Coronation Drive 3D Solar, Shade & Wind Tunnel Simulator

**Live Demo:** https://petescarth.com/shade355/

An interactive, zero-dependency-install 3D urban **solar overshadowing** and **3D wind tunnel (CFD)** simulator for the proposed **355 Coronation Drive & 6 Lang Parade, Auchenflower / Milton (Brisbane)** development (**DA `A006954430`**, *"Bloom"*).

The simulator models **1,570 measured Brisbane buildings** over a **Queensland 0.5m LiDAR Digital Elevation Model (DEM)** across a **1,733.8 m × 1,507.6 m** study area, combining:
1. WebGL real-time shadow mapping with a client-side **3D geometric ray-traced surface shading engine** (`% Shaded` on any building wall, roof, or whole exterior), and
2. A client-side **3D incompressible Navier-Stokes wind tunnel solver** (`WebGL2 GPU` + `CPU` fallback) coupled with **10 years (`95,448` hours, 2016–2026)** of real Brisbane historical wind & gust records to assess pedestrian wind comfort, downwash, and storm edge cases.

---

## Key Features

- **Real-Time 3D Solar & Shadow Visualization**
  - Interactive WebGL scene with `4096×4096` soft shadow maps (`PCFSoftShadowMap`), dynamic sky/sunlight color temperature by solar altitude, a Brisbane River water plane at `0.52 m` AHD, and an optional 3D solar path arc with sun-ray vector.
- **Ray-Traced Surface Shading Inspector (`% Shaded`)**
  - Click any exterior wall or roof on any of the 1,570 buildings (or the proposed tower) to run a geometric ray-traced shading analysis comparing **Existing Baseline** (with the existing on-site buildings at 355 Coronation Dr / 6 Lang Pde) against **With 355 Coronation Dr** (with the existing on-site structures removed and the proposed tower active).
  - Paints a live **3D sample-cell heatmap** directly onto the selected surface (`Gold` = direct sunlight, `Crimson` = new shade from 355 Coro, `Slate` = existing building/terrain shade, `Dark Navy` = self-shaded / facing away).
  - Computes a **full-day shading curve** in 15-minute increments with an interactive SVG chart you can click or drag to scrub time, plus **9:00 AM–3:00 PM** and full-day averages, direct sun hours lost, and peak extra shade time.
- **Neighbourhood Impact Scanner**
  - Ray-traces surrounding buildings within **450 m** of the site across the selected date (8:00 AM–4:00 PM at 30-minute steps + current time), ranking every neighbour experiencing ≥ 1.5% additional overshadowing and allowing one-click fly-to at each building's peak impact time.
- **Scenario & A/B Massing Controls**
  - Toggle the proposed building on/off for instant baseline comparison, switch between regulatory/DA presets, or adjust tower height (`0–100 m` above `RL 7.20 m` AHD Ground FFL) and site cover (`40%–75%` of the `1,430 m²` approved DA site).
- **3D Urban Wind Tunnel (In-Browser CFD) & 10-Year Brisbane Weather History**
  - Switch to **💨 Wind Tunnel** in the top bar to run an interactive **3D incompressible Navier-Stokes CFD** simulation (`WebGL2 GPU 96×96×40` with automatic self-healing `CPU 64×64×32` fallback) over a `320 m × 320 m × 150 m` domain centered on 355 Coronation Drive.
  - Captures true 3D atmospheric boundary layer profiles, facade stagnation, **3D downwash**, corner Venturi acceleration, and wake recirculation comparing **Existing Baseline** vs **With 355 Coro** across any height/site-cover scenario.
  - Ships with **10 years (`95,448` hours, 2016–2026)** of pre-compiled site wind climate from Open-Meteo ERA5 and Brisbane Airport (`YBBN`) METAR anemometer gusts (`data/wind-climate.js`), including real historical edge-case presets (*Ex-TC Alfred*, *Ex-TC Debbie*, *SSW Channel Funnel*, *Winter Westerly*, *YBBN Supercell Peak*), an interactive 16-sector Brisbane Wind Rose, online historical date replay, `3,200` animated 3D streamlines (`45%` street-level + `55%` upper downwash curtain), pedestrian heatmap (`Δ Impact`, `Speed`, `Lawson Comfort`, `Downwash`), movable wind-aligned vertical cross-section slice, click-to-probe anemometer with `0–120 m AHD` vertical profile chart, and an **8-Direction CFD × 10-Year Climate Edge-Case & Condition 30 Scanner** supporting both **Selected Point** (live instant update on map click) and **Whole 320m Site** (click jumps probe & camera directly to each storm's worst hotspot).
  - *Note:* The browser CFD model (`~3.3 m` voxels) is a screening & comparative impact tool, not a certified RPEQ / AS/NZS 1170.2 compliance wind tunnel study.
- **Offline / `file://` Ready**
  - All scripts, libraries, terrain DEM grids, building footprints, and basemap textures are self-contained locally and loaded via classic `<script>` tags so the app works both from a local HTTP server and when opened directly via `file://`.

---

## Data Sources

All spatial datasets are pre-compiled into [data/scene-data.js](data/scene-data.js) and [data/basemaps.js](data/basemaps.js) by [scripts/build_dataset.mjs](scripts/build_dataset.mjs) for the study bounding box **`152.99485990, -27.48253927`** to **`153.01241521, -27.46893391`** (centered at `153.003638° E, -27.475737° S`, AEST UTC+10).

| Layer | Source | Details |
| :--- | :--- | :--- |
| **Building Footprints & Measured Heights** | Brisbane City Council Nearmap/LiDAR Open Data (`Prop_Boundaries/FeatureServer/6`) | 1,570 polygon footprints with `BUILDINGHEIGHTM` attributes (minimum clamped to `3.0 m` if `< 2.2 m` or missing). Coordinates converted to local metric East-North-Up (`+X` East, `+Y` Up in m AHD, `-Z` North). |
| **Property Boundaries & Street Addresses** | Brisbane City Council Property Holdings (`Prop_Boundaries/FeatureServer/2`) | Spatial-hashed parcel polygons used to match building centroids to street addresses (`UNIT_HOUSE_NUMBER` / `HOUSE_NUMBER`, `CORRIDOR_NAME`, `CORRIDOR_SUFFIX_CODE`, `SUBURB`) and flag existing structures on the `355 Coronation Dr` / `6 Lang Pde` site (`onSite355`). |
| **Terrain Elevation (DEM)** | Queensland Government 0.5m LiDAR DEM (`Elevation/QldDem` ImageServer) | Sampled as a `200 × 174` (`~8.7 m` spacing) 32-bit float GeoTIFF, quantized to decimetres (`0.1 m` AHD) with underwater riverbed elevations clamped to `0.2 m` AHD for smooth river representation and hill/ridge terrain occlusion. |
| **Terrain Basemap Textures** | Esri ArcGIS REST MapServer Exports | Three `1600 × 1391` JPEG textures embedded as base64 data URIs in [data/basemaps.js](data/basemaps.js): `Canvas/World_Light_Gray_Base` (*Architectural*), `World_Street_Map` (*Street Map*), and `World_Imagery` (*Satellite*). |
| **Historical Wind Climate & Extremes** | Open-Meteo Historical Archive (ERA5/ACCESS) & Brisbane Airport (`YBBN`) METAR (IEM ASOS) | `95,448` hourly wind/gust records (`2016-01-01`–`2026-11-20`) at `-27.4752, 153.0026` plus `YBBN` peak storm gusts compiled by [scripts/fetch_wind_history.mjs](scripts/fetch_wind_history.mjs) into [data/wind-climate.js](data/wind-climate.js) (16-sector wind rose, speed histograms, and curated historical edge-case presets). |
| **Proposed Tower Parameters** | BCC Approved DA `A006954430` (Rev B, 16/10/2026) | Combined `355 Coronation Dr` + `6 Lang Pde` site (`1,430 m²` survey area; Lot 3 RP52037 & Lot 16 SP135237; existing NGL `~6.9 m` AHD, approved Ground FFL `RL 7.20 m` AHD). Multi-tier stepped rounded-corner profile: **Podium** (Ground–L01, `RL 7.20–18.50 m`), **Main Residential Tower** (L02–L19 + Roof Undercroft to Roof Terrace, `RL 18.50–78.35 m`, `~858 m²` / `60%` site cover), and **Recessed Rooftop Pavilion** on the SW half (`RL 78.35–83.60 m`, `76.4 m` total height, 23 storeys, with open 25 m lap pool terrace on the NE half). Presets include Approved DA (`23st 76.4m`, 60% cover), Approved Height at 50% Site Cover (`23st 50%`), HDR2 zone cap (`15st 50m`, 50% cover), and TANP statutory limit for `< 1,500 m²` lots (`8st 27m`, 50% cover). |

---

## Libraries & Technical Architecture

### Vendored Libraries
- **[Three.js r147](lib/three.min.js)** (`MIT License`) — WebGL rendering, merged `BufferGeometry` building meshes (`MeshStandardMaterial` with per-vertex colors), `ShapeUtils.triangulateShape` roof triangulation, `PCFSoftShadowMap`, `ACESFilmicToneMapping`, and `Raycaster` surface picking.
- **[OrbitControls.js](lib/OrbitControls.js)** — Three.js camera orbit, pan, zoom, damping, and polar angle clamping.

No npm runtime dependencies, bundlers, or external CDNs are required to run the simulator.

### Custom Modules
- **[js/solar.js](js/solar.js) (`SolarCalc`)** — Self-contained NOAA / Jean Meeus astronomical solar position calculator for Brisbane (`AEST UTC+10`, no DST), including Julian day, equation of time, solar declination, atmospheric refraction correction, sunrise/solar noon/sunset calculation, and conversion to Three.js sun direction vectors.
- **[js/raytracer.js](js/raytracer.js) (`ShadingEngine`)** — High-speed geometric ray-tracer using:
  - A **2D spatial grid (`40 m` cells)** with **DDA traversal** and visit-stamping across all 1,570 building prisms.
  - Exact **3D AABB slab + 2D polygon wall-edge + roof/bottom intersection** (`rayHitsPrism`), plus **DEM terrain marching** (`14 m` steps) for topographic ridge occlusion (e.g., Dunmore Terrace hillside).
  - Bitmask ray results distinguishing existing context/terrain (`bit 1`), existing on-site buildings (`bit 2`), and the proposed 355 Coronation Dr tower (`bit 4`) in a single pass.
- **[js/wind-solver.js](js/wind-solver.js) (`WindTunnelEngine`)** — Self-contained 3D incompressible Navier-Stokes CFD solver (`WebGL2FluidSolver` on 2D-tiled `RGBA32F` float textures + automatic `solveCPU3D` Red-Black SOR fallback), solid voxelizer, trilinear velocity sampler, pedestrian/vertical-profile metrics, and 8-direction × 10-year climate convolution engine (`runWindRoseAnalysis` & instant `evaluatePointClimate`).
- **[js/wind-ui.js](js/wind-ui.js)** — Three.js 3D wind tunnel layers (terrain-draped pedestrian heatmap, `3,200` animated 3D flowlines, wind-aligned vertical cross-section slice, 3D anemometer pin), interactive 16-sector Wind Rose SVG, vertical wind profile chart, online Open-Meteo historical date replay, and Selected-Point / Whole-Site Edge-Case & Condition 30 UI.
- **[js/app.js](js/app.js)** — Scene assembly, camera flight interpolation, UI controls, 3D surface heatmap rendering, interactive SVG daily chart, and neighbourhood impact scanning.
- **[scripts/build_dataset.mjs](scripts/build_dataset.mjs)** — Standalone Node.js data pipeline (uses built-in `fetch`, `fs`, and a custom `Float32` GeoTIFF parser `parseTiffF32`) to rebuild `data/scene-data.js` and `data/basemaps.js` from the live ArcGIS REST endpoints.
- **[scripts/fetch_wind_history.mjs](scripts/fetch_wind_history.mjs)** — Standalone Node.js climate harvester fetching 10+ years (`2016–2026`, `95,448` hours) of hourly wind & gusts from Open-Meteo Archive plus `YBBN` Brisbane Airport METAR peak gusts from IEM ASOS to build `data/wind-climate.js`.

---

## Modelling Methodology & Physics

### 1. Proposed 355 Coronation Drive Massing (`DA A006954430` Rev B)
Both the solar ray-tracer and the 3D wind voxelizer use the exact 3-tier rounded-corner building profile from the approved architectural plans (`1,430 m²` official survey site area; existing NGL `6.9 m` AHD; approved Ground FFL `RL 7.20 m` AHD), aligned to orthonormal axes along the SW (`45.2 m`) and NW (`30.2 m`) cadastral boundaries:
- **Podium (Ground, Mezzanine `RL 10.70 m`, Level 01 `RL 13.35 m`):** `RL 7.20 m → RL 18.50 m` (`~651 m²`), pulled back along the NE Lang Parade frontage over the lobby/driveway.
- **Main Residential Tower (Levels 02–19 + Roof Undercroft `RL 75.65 m` → Roof Terrace):** `RL 18.50 m → RL 78.35 m` (`~859 m²` rounded floorplate = `60.0%` site cover, cantilevering over the podium with a solid soffit cap).
- **Recessed Rooftop Pavilion:** `RL 78.35 m → RL 83.60 m` (`~305 m²`, `5.25 m` tall, total height `76.4 m` above Ground FFL) positioned on the **SW half** of the roof plate, leaving open sky over the **NE 25 m rooftop lap pool terrace** (`RL 78.35 m`).

Changing the **Tower Height** (`0–100 m`) or **Site Cover** (`40%–75%`) sliders dynamically rebuilds all 3 tiers simultaneously for WebGL rendering, geometric solar raytracing, and 3D wind voxelization.

### 2. Solar & Surface Shading Engine (`js/solar.js` & `js/raytracer.js`)
- **Astronomical Solar Ephemeris:** Computes solar altitude and azimuth for Brisbane (`153.0036° E, -27.4757° S`, fixed `AEST UTC+10`) using NOAA / Jean Meeus formulas including Julian day, equation of time, solar declination, and atmospheric refraction correction.
- **Surface Discretization:** Clicked building facades, roofs, or whole exteriors are subdivided into ~200–280 area-weighted sample cells (`0.6–4.0 m` spacing), skipping wall cells buried below the sloped LiDAR ground elevation.
- **Single-Pass Bitmask Raytracing:** Each sample point fires a ray toward the sun vector through:
  1. All active proposed 355 Coro tiers (`bit 4`),
  2. All 1,570 surrounding prisms via a `40 m` 2D spatial grid with DDA traversal and exact 3D AABB + 2D polygonal wall/roof intersection (`bit 1` for context buildings, `bit 2` for existing demolished buildings on the 355 Coro / 6 Lang Pde lots), and
  3. LiDAR DEM terrain marching (`14 m` step) to capture Dunmore Terrace hillside ridge occlusion (`bit 1`).
- **A/B Comparison:** From that single ray pass, **Existing Baseline** shade is `bit 1 | bit 2`, **With 355 Coro** shade is `bit 1 | bit 4`, and **New 355 Coro Shade** is `bit 4` where neither `bit 1` nor `bit 2` occurred.

### 3. 3D Wind Tunnel CFD Engine (`js/wind-solver.js`)
- **Domain & Voxel Grid:** Centered on 355 Coronation Drive, spanning **`320 m (E–W) × 320 m (N–S) × 150 m (vertical, RL 0–150 m AHD)`** — nearly `2×` the `76.4 m` tower height to prevent artificial ceiling-blockage speedup over the roof.
  - **WebGL2 GPU Backend (default):** `96 × 96 × 40` (`368,640` voxels; `Δx = Δz = 3.33 m`, `Δy = 3.75 m`) packed into a `768 × 480` (`8 × 5` slice) `RGBA32F` 2D texture atlas. Includes an automatic self-healing driver check.
  - **CPU Fallback Backend:** `64 × 64 × 32` (`131,072` voxels; `Δx = Δz = 5.0 m`, `Δy = 4.69 m`) using TypedArrays and Red-Black SOR over-relaxation ($\omega = 1.48$).
- **Solid Voxelization:** Distinguishes **terrain voxels (`1`)** from **building voxels (`2`)** across the Queensland DEM, surrounding BCC buildings, and either the existing on-site buildings (**Baseline**) or the 3-tier proposed tower (**With 355 Coro**). Separating terrain vs. building flags prevents coarse terrain voxels from falsely killing low-altitude pedestrian streamlines (`DEM + 1.5 m`).
- **Atmospheric Boundary Layer (ABL) Inflow:** Upwind faces apply a height-dependent power-law wind profile:
  $$U_{\text{in}}(h) = U_{10}\left(\frac{\max(h, 0.5)}{10}\right)^{\alpha(\theta)}$$
  where the terrain roughness exponent $\alpha(\theta) = 0.20 - 0.04\cos(\theta - 115^\circ)$ smoothly transitions from **open Brisbane River fetch** (ESE–SE, $\alpha \approx 0.16$, Terrain Category 2) to **suburban Dunmore Terrace ridge fetch** (W–NW, $\alpha \approx 0.24$, Terrain Category 3). Downwind faces use zero-gradient convective outflow ($p = 0$), and the top lid (`150 m`) is free-slip.
- **Governing Equations & Numerical Scheme:** Solves steady 3D incompressible Navier-Stokes equations:
  $$\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u} \cdot \nabla)\mathbf{u} = -\nabla p + \nu_t \nabla^2 \mathbf{u}, \qquad \nabla \cdot \mathbf{u} = 0$$
  using 2nd-order midpoint **Semi-Lagrangian advection** (clamped out of solid voxels), **fluid-only Smagorinsky sub-grid eddy viscosity** (averaging strictly over fluid neighbors so walls do not create artificial sticky boundary layers), gentle ground-layer friction (`0.988`), and **Poisson pressure projection** (`22–32` Jacobi iterations on GPU; `14–22` Red-Black SOR iterations on CPU) with exact solid-wall Neumann boundary conditions ($\partial p/\partial n = 0$).
- **Scale-Invariant Normalized Caching:** High-Reynolds bluff-body speedup ratios $\mathbf{u}(\mathbf{x})/U_{10}$ are effectively Reynolds-independent. Solving once at normalized $U_{10} = 10\text{ m/s}$ and caching by `(scenario, direction)` allows the **Ref Speed slider (`3–44 m/s`)** to rescale the full 3D velocity field, heatmap, streamlines, and Lawson comfort zones instantaneously with zero re-solve.
- **Near-Ground Sampling & Downwash:** Trilinearly interpolates velocity over fluid corners and applies physical log-law shear attenuation $(h_{\text{AGL}} / (0.85\,\Delta y))^{\alpha}$ whenever sampling below the first fluid cell height (`DEM + 1.5 m`). Facade downwash is tracked across both `DEM + 1.5 m` and the `DEM + 6.0 m` impingement jet where downward vertical velocity ($-u_y$) peaks before turning horizontally along the pavement.

### 4. 10-Year Historical Wind Climate, Edge-Case Discovery & Lawson Comfort Criteria
- **Historical Data (`data/wind-climate.js`):** Combines `95,448` hourly site records (`2016-01-01`–`2026-11-20`) from Open-Meteo ERA5/ACCESS with `1,215` real high-gust (`≥ 28 kt`) METAR anemometer records from Brisbane Airport (`YBBN`). Stored as 16-sector wind roses, 11-bin speed & gust probability distributions, and curated storm presets.
- **8-Direction CFD × Climate Convolution:** Running the **8-Dir Edge-Case & Cond. 30 Scan** solves `0°, 45°, 90°, 135°, 180°, 225°, 270°, 315°` for both Baseline and Proposed (16 cached 3D fields), linearly interpolates directional speedup factors $K(\theta)$ across all 16 compass sectors and historical storm bearings, and computes:
  - **Selected Point Edge Cases & Annual Exceedance (`< 2 ms` live update on any map click):** Ranks the worst 2016–2026 historical storms *specifically at your clicked 3D probe point* and integrates all `95,448` hours against Lawson pedestrian comfort thresholds (`> 4 m/s` exceeds Sitting, `> 8 m/s` exceeds Walking, `> 15 m/s` gust = Distress / Unsafe).
  - **Whole 320m Site Edge Cases:** Ranks historical storms against the worst open street/footpath cell anywhere in the `320 m` domain and records each storm's exact `(x, z)` hotspot — clicking a site-wide storm card snaps the 3D probe pin and camera directly onto that exceedance location.
  - **Condition 30 Checkpoints:** Evaluates 5 fixed checkpoints (Coronation Dr Footpath, Lang Pde × Coro Dr Corner, 8 Dunmore Tce Corridor, Lang Parade Footpath, and Rooftop Pool Terrace `RL 78.4 m`) plus a live highlighted **`★ Selected Point`** row when a custom location is probed.
- **Lawson Pedestrian Wind Comfort Bands:**
  - `< 4.0 m/s`: Sitting · `4.0–6.0 m/s`: Standing · `6.0–8.0 m/s`: Walking · `8.0–10.0 m/s`: Uncomfortable · `10.0–15.0 m/s`: Very Windy · `≥ 15.0 m/s`: Distress / Unsafe.

### 5. Modelling Scope & Limitations
- **Screening Tool vs. Certified Wind Tunnel:** At `~3.3–3.75 m` voxel resolution, the browser CFD engine reliably captures macro-scale 3D mechanisms (ABL profile, facade stagnation, 3D downwash scaling with tower height, Venturi corner/channel acceleration, Dunmore Terrace topographic shelter, and relative A/B shifts between `8st`, `15st`, and `23st`). It does **not** resolve sub-metre architectural mitigations (balcony fins, podium awnings, planter screens, or street trees) or unsteady turbulent peak-gust statistics, and is **not** a substitute for a certified RPEQ / AS/NZS 1170.2 wind tunnel study required under BCC Condition 30.
- **Surrounding Buildings & DEM:** Existing context buildings are extruded as flat-topped prisms from BCC `BUILDINGHEIGHTM` LiDAR attributes over an `~8.7 m` quantized DEM grid (sloped pitched roofs, under-crofts, and vegetation canopies are simplified to solid footprints).

---

## How to Use It

### 1. Launching the Simulator

- **Live Hosted Version:** Open **[https://petescarth.com/shade355/](https://petescarth.com/shade355/)** in any modern WebGL-enabled browser.
- **Direct Open:** Double-click [index.html](index.html) to open it directly from disk (`file://` is fully supported).
- **Local HTTP Server (optional):**
  ```powershell
  # Using Python
  python -m http.server 8080
  # Or using Node.js
  npx serve .
  ```
  Then open `http://localhost:8080` in your browser.

### 2. Navigating the 3D Scene

| Action | Control |
| :--- | :--- |
| **Rotate / Orbit** | `Left-Drag` |
| **Pan** | `Right-Drag` (or `Ctrl` / `Shift` + `Left-Drag`) |
| **Zoom** | `Scroll Wheel` |
| **Inspect Wall or Roof** | `Left-Click` any building wall or roof |
| **Reset North Up** | Click the **Compass** icon in the top HUD bar |

Use the **Camera Bar** in the top-right to smoothly fly between preset views:
- **355 Coro** — Default oblique view framing 355 Coronation Dr, Lang Parade, and Dunmore Terrace.
- **Dunmore Tce** — View from the Dunmore Terrace hillside looking past 8 & 24 Dunmore Tce toward the site and river.
- **River View** — Elevation view from over the Brisbane River looking toward Coronation Drive.
- **Top Plan** — Near top-down architectural shadow plan view.
- **Full Region** — Overview of the entire `1.73 km × 1.51 km` model.

### 3. Solar & Scenario Controls (Left Panel)

- **Solar Date & Time:** Pick a solstice/equinox preset (`21 Jun` Winter Solstice, `21 Mar` / `23 Sep` Equinox, `21 Dec` Summer Solstice) or any custom date. Drag the **Time of Day (AEST)** slider (`05:00`–`19:00`) or click **▶ Animate Day** (`Slow 0.5 hr/s`, `Normal 1.2 hr/s`, `Fast 2.6 hr/s`).
- **355 Coronation Dr (DA A006954430):**
  - Toggle **Show Proposed Building (A/B Compare)** to switch between the proposed tower and the existing baseline buildings on the site.
  - Choose a height/cover preset (`23st 76.4m` Approved DA, `23st 50%` Approved height at 50% cover, `15st 50m` HDR2 cap, `8st 27m` Statutory TANP limit, or `Off`), or fine-tune **Tower Height** (`0–100 m`) and **Tower Site Cover** (`40%–75%`).
- **3D Display & Layers:** Switch terrain basemaps (*Architectural*, *Street Map*, *Satellite*), building color modes (*Uniform*, *By Height*, *355 Impact*), and toggle the **3D Surface Shade Heatmap Overlay**, **3D Solar Path Arc & Sun Sphere**, and **23-Storey Floor Lines**.

### 4. Surface Shading Simulator & Impacted Neighbours (Right Panel)

- **Surface Inspector tab:**
  - Click any building facade or roof in the 3D viewport (or click **Inspect 8 Dunmore Tce** on startup) to inspect that surface, or switch via the **Simulated Surface** dropdown (`Whole Building Exterior`, `Roof Surface`, or individual compass-labeled walls).
  - View instantaneous **With 355 Coro**, **Existing Base**, and **355 Coro Impact** (`Δ%` and `m²` newly shaded), the segmented breakdown bar, and the **Full-Day Surface Shading Curve** (click or drag across the SVG chart to scrub time, or click the peak impact timestamp link to jump directly to peak overshadowing).
- **Impacted Neighbours tab:**
  - Lists all neighbouring buildings within `450 m` that experience additional overshadowing on the selected date, sorted by `9am–3pm` average impact.
  - Click any building in the list to jump to its peak impact time, select its most impacted facade, and fly the camera to it.
  - Click **↻ Rescan & Highlight on 3D Map** to refresh the scan and switch buildings to the *355 Impact* color ramp.

### 5. 3D Wind Tunnel Mode (Switch via Top Bar)

- **Historical Presets & Wind Rose (Left Panel):** Choose a verified 2016–2026 Brisbane storm edge case (*Ex-TC Alfred*, *Ex-TC Debbie*, *SSW Channel Funnel*, *Winter Westerly*, *YBBN Supercell*) or P95 prevailing breeze, click any compass sector on the interactive **16-sector Brisbane Wind Rose**, drag **Wind From Direction (`0–360°`)** and **Ref Speed (`3–44 m/s`)**, or use **Replay Real Past Date (Online)** to fetch any historical hour (`1940–present`) from Open-Meteo Archive.
- **3D Wind Layers:** Toggle the terrain-draped **Pedestrian Wind Map (`DEM + 1.5 m`)** (`Δ Impact`, `Speed`, `Lawson`, `Downwash`), **Animated 3D Wind Streamlines** (`3,200` street + downwash tracers), and the movable wind-aligned **Vertical Airflow Cross-Section**.
- **Wind Probe & Edge Cases (Right Panel):**
  - **Wind Probe tab:** Click anywhere on the street, footpath, neighbouring courtyard, or `RL 78.4 m` rooftop pool terrace (or pick a Condition 30 checkpoint) to inspect Baseline vs. Proposed speed (`m/s` & `km/h`), `Δ` impact, speedup factor `K`, downwash velocity, Lawson comfort transition, and the `0–120 m AHD` vertical wind profile.
  - **Edge Cases & Cond. 30 tab:** Click **↻ Run 8-Dir Edge-Case & Cond. 30 Scan** to solve all 8 compass directions and convolve with `95,448` real Brisbane hours. Toggle between **Selected Point** (updates live as you click anywhere on the 3D map) and **Whole 320m Site** (clicking any storm card jumps the 3D probe & camera directly to that storm's worst street hotspot).

---

## Rebuilding the Datasets

To re-fetch the BCC building footprints, property boundaries, Queensland DEM, and Esri basemap textures from source APIs (requires Node.js 18+ with global `fetch` and internet access):

```powershell
node scripts/build_dataset.mjs
```

To refresh the 10-year Open-Meteo ERA5 + Brisbane Airport (`YBBN`) METAR historical wind climate dataset (`data/wind-climate.js`):

```powershell
node scripts/fetch_wind_history.mjs
```

Note that [scripts/build_dataset.mjs](scripts/build_dataset.mjs) writes to `data/scene-data.js` and `data/basemaps.js`, and [scripts/fetch_wind_history.mjs](scripts/fetch_wind_history.mjs) writes to `data/wind-climate.js`.

---

## Project Structure

```text
shade355/
├── index.html               # App layout, HUD, control panels, and script loader
├── css/
│   └── style.css            # Glassmorphic dark-HUD styling and responsive layout
├── data/
│   ├── scene-data.js        # Prebuilt DEM grid, 1,570 building prisms, and 355 Coro parcel/tower config
│   ├── basemaps.js          # Base64-encoded Light Gray, Street Map, and Satellite textures
│   └── wind-climate.js      # 10-year (95,448 hr) site wind rose, speed histograms & historical extreme presets
├── js/
│   ├── solar.js             # NOAA / Jean Meeus solar position & day-summary calculator
│   ├── raytracer.js         # 2D DDA + polygonal prism + DEM ray-traced shading engine
│   ├── wind-solver.js       # 3D Navier-Stokes CFD engine (WebGL2 GPU + CPU fallback) & climate convolution
│   ├── wind-ui.js           # 3D wind overlays (heatmap, streamlines, slice, probe), wind rose & Condition 30 UI
│   └── app.js               # Three.js scene, shadow mapping, 3D heatmap overlay, charts & UI
├── lib/
│   ├── three.min.js         # Three.js r147 (MIT)
│   └── OrbitControls.js     # Three.js OrbitControls
└── scripts/
    ├── build_dataset.mjs    # Node.js data ingestion & GeoTIFF/ArcGIS build script
    └── fetch_wind_history.mjs # Node.js 10-year Open-Meteo + YBBN METAR wind climate builder
```
