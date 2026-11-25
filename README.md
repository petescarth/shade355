# shade355 — 355 Coronation Drive 3D Solar & Surface Shading Simulator

**Live Demo:** https://petescarth.com/shade355/

An interactive, zero-dependency-install 3D urban solar and overshadowing simulator for the proposed **355 Coronation Drive & 6 Lang Parade, Auchenflower / Milton (Brisbane)** development (**DA `A006954430`**, *"Bloom"*).

The simulator models **1,570 measured Brisbane buildings** over a **Queensland 0.5m LiDAR Digital Elevation Model (DEM)** across a **1,733.8 m × 1,507.6 m** study area and combines WebGL real-time shadow mapping with a client-side **3D geometric ray-traced surface shading engine** to quantify baseline vs. proposed overshadowing on any building wall, roof, or whole exterior.

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
  - Switch to **💨 Wind Tunnel** in the top bar to run an interactive **3D incompressible Navier-Stokes CFD** simulation (`WebGL2 GPU 96×96×32` with automatic `CPU 64×64×26` fallback) over a `320 m × 320 m × 104 m` domain centered on 355 Coronation Drive.
  - Captures true 3D atmospheric boundary layer profiles, facade stagnation, **3D downwash**, corner Venturi acceleration, and wake recirculation comparing **Existing Baseline** vs **With 355 Coro** across any height/site-cover scenario.
  - Ships with **10 years (`95,448` hours, 2016–2026)** of pre-compiled site wind climate from Open-Meteo ERA5 and Brisbane Airport (`YBBN`) METAR anemometer gusts (`data/wind-climate.js`), including real historical edge-case presets (*Ex-TC Alfred*, *Ex-TC Debbie*, *SSW Channel Funnel*, *Winter Westerly*, *YBBN Supercell Peak*), an interactive 16-sector Brisbane Wind Rose, online historical date replay, animated 3D streamlines, pedestrian heatmap (`Δ Impact`, `Speed`, `Lawson Comfort`, `Downwash`), movable wind-aligned vertical cross-section slice, click-to-probe anemometer with vertical profile chart, and an **8-Direction CFD × 10-Year Climate Edge-Case & Condition 30 Scanner**.
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
- **[js/app.js](js/app.js)** — Scene assembly, camera flight interpolation, UI controls, 3D surface heatmap rendering, interactive SVG daily chart, and neighbourhood impact scanning.
- **[scripts/build_dataset.mjs](scripts/build_dataset.mjs)** — Standalone Node.js data pipeline (uses built-in `fetch`, `fs`, and a custom `Float32` GeoTIFF parser `parseTiffF32`) to rebuild `data/scene-data.js` and `data/basemaps.js` from the live ArcGIS REST endpoints.

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

---

## Rebuilding the Dataset

To re-fetch the BCC building footprints, property boundaries, Queensland DEM, and Esri basemap textures from source APIs (requires Node.js 18+ with global `fetch` and internet access):

```powershell
node scripts/build_dataset.mjs
```

Note that [scripts/build_dataset.mjs](scripts/build_dataset.mjs) writes output directly to `c:/Scratch/dev3d/data/scene-data.js` and `c:/Scratch/dev3d/data/basemaps.js`.

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
