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
  - Toggle the proposed building on/off for instant baseline comparison, switch between regulatory/DA height presets, or adjust tower height (`0–100 m` above `6.9 m` AHD natural ground level) and site cover (`40%–75%` of the `~1,359 m²` combined parcel).
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
| **Proposed Tower Parameters** | BCC Development Application `DA A006954430` | Combined `355 Coronation Dr` + `6 Lang Pde` parcel (`1,359 m²`, frontages `30.2 m` on Coronation Dr and `42.6 m` on Lang Pde, NGL `6.9 m` AHD). Default approved tower: `76.4 m` (`23` storeys, `83.3 m` AHD roof RL) at `60%` site cover (`~830 m²`), plus presets for Max RL with rooftop plant (`83.6 m`), HDR2 zone cap (`50.0 m`, 15 storeys), and TANP statutory limit for `< 1,500 m²` lots (`27.0 m`, 8 storeys). |

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
  - Choose a height/cover preset (`23st 76.4m` Approved DA, `Max 83.6m`, `15st 50m` HDR2 cap, `8st 27m` Statutory TANP limit, or `Off`), or fine-tune **Tower Height** (`0–100 m`) and **Tower Site Cover** (`40%–75%`).
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
│   └── basemaps.js          # Base64-encoded Light Gray, Street Map, and Satellite textures
├── js/
│   ├── solar.js             # NOAA / Jean Meeus solar position & day-summary calculator
│   ├── raytracer.js         # 2D DDA + polygonal prism + DEM ray-traced shading engine
│   └── app.js               # Three.js scene, shadow mapping, 3D heatmap overlay, charts & UI
├── lib/
│   ├── three.min.js         # Three.js r147 (MIT)
│   └── OrbitControls.js     # Three.js OrbitControls
└── scripts/
    └── build_dataset.mjs    # Node.js data ingestion & GeoTIFF/ArcGIS build script
```
