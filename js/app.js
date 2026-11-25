/**
 * 355 Coronation Drive — 3D Solar & Surface Shading Simulator
 * Built on real Brisbane City Council building heights (1,570 footprints)
 * and Queensland Government 0.5m LiDAR Digital Elevation Model.
 */
(function () {
  'use strict';

  const DATA = window.SCENE_DATA;
  const BASEMAPS = window.BASEMAPS;
  const Solar = window.SolarCalc;

  if (!DATA || !THREE) {
    alert('Failed to load scene data or Three.js.');
    return;
  }

  // ==================== STATE ====================
  const state = {
    year: 2026,
    month: 6,
    day: 21, // Winter Solstice (critical overshadowing date in Brisbane)
    minutes: 570, // 09:30 AEST
    playing: false,
    playSpeed: 75, // simulated minutes per second

    proposedEnabled: true,
    proposedHeight: DATA.proposed.approvedHeight, // 76.4 m
    proposedSiteCover: 60, // 60%
    activeScenario: 'approved',

    basemap: 'streets',
    colorMode: 'architectural', // 'architectural' | 'height' | 'impact'
    showHeatmap: true,
    showSunArc: true,
    showFloors: true,

    // Selected building & surface
    selectedPrism: null,
    selectedSurface: null, // { type: 'wall'|'roof'|'whole', edgeIdx, label, ... }
    selectedSamples: [],
    dailyProfile: null,

    // Neighbourhood impact scan cache
    impactList: [],
    impactMap: new Map()
  };

  // ==================== ENGINE ====================
  const engine = new window.ShadingEngine(DATA);

  // ==================== THREE.JS SETUP ====================
  const container = document.getElementById('canvas-container');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc8dcf0);
  scene.fog = new THREE.FogExp2(0xc8dcf0, 0.00011);

  const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 2, 6000);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI / 2 - 0.025;
  controls.minDistance = 30;
  controls.maxDistance = 2400;
  controls.rotateSpeed = 0.75;
  controls.panSpeed = 0.85;
  controls.zoomSpeed = 1.1;

  // Lights (high-contrast solar lighting so cast shadows read razor-sharp)
  const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.42);
  scene.add(hemiLight);

  const ambientLight = new THREE.AmbientLight(0x94a3b8, 0.14);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xfffbeb, 1.72);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 4096;
  sunLight.shadow.mapSize.height = 4096;
  sunLight.shadow.camera.near = 100;
  sunLight.shadow.camera.far = 2600;
  const SHADOW_EXTENT = 580;
  sunLight.shadow.camera.left = -SHADOW_EXTENT;
  sunLight.shadow.camera.right = SHADOW_EXTENT;
  sunLight.shadow.camera.top = SHADOW_EXTENT;
  sunLight.shadow.camera.bottom = -SHADOW_EXTENT;
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.45;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Subtle fill light from opposite direction so shaded facades retain clear 3D form
  const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.25);
  fillLight.position.set(-300, 200, 400);
  scene.add(fillLight);

  // ==================== TERRAIN MESH ====================
  const textures = {};
  const texLoader = new THREE.TextureLoader();

  function getBasemapTexture(key) {
    if (!textures[key] && BASEMAPS && BASEMAPS[key]) {
      const tex = texLoader.load(BASEMAPS[key]);
      tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      textures[key] = tex;
    }
    return textures[key];
  }

  function buildTerrainMesh() {
    const { widthM, depthM } = DATA.meta;
    const { w, h, scale, v } = DATA.dem;

    const geo = new THREE.PlaneGeometry(widthM, depthM, w - 1, h - 1);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, v[i] * scale);
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: getBasemapTexture(state.basemap),
      roughness: 0.92,
      metalness: 0.02
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'terrain';
    scene.add(mesh);

    // Subtle Brisbane River water shimmer plane at y = 0.55m AHD
    const waterGeo = new THREE.PlaneGeometry(widthM, depthM);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.16,
      roughness: 0.22,
      metalness: 0.35,
      depthWrite: false
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.y = 0.52;
    waterMesh.receiveShadow = true;
    scene.add(waterMesh);

    return mesh;
  }

  const terrainMesh = buildTerrainMesh();

  // ==================== EXISTING BUILDINGS MERGED GEOMETRY ====================
  function createMergedBuildings(prismList) {
    const positions = [];
    const normals = [];
    const colors = [];
    const triToPrism = [];
    const triToSurface = []; // -1 = roof, >= 0 = wall edgeIdx
    const edgeLines = [];
    const vertexRanges = new Map(); // prism.id -> { startVert, endVert, roofStartVert, roofEndVert }

    const defaultWall = new THREE.Color(0xe2e8f0);
    const defaultRoof = new THREE.Color(0xcbd5e1);

    for (const prism of prismList) {
      const ring = prism.r;
      const n = ring.length;
      if (n < 3) continue;

      const startVert = positions.length / 3;
      const yMin = prism.yMin;
      const yTop = prism.yTop;

      // Per-tier color styling for the proposed 355 Coro multi-tier DA profile
      let wallC = defaultWall;
      let roofC = defaultRoof;
      if (prism.isProposed) {
        if (prism.tierKey === 'podium') {
          wallC = new THREE.Color(0xb91c1c);
          roofC = new THREE.Color(0x991b1b);
        } else if (prism.tierKey === 'pavilion') {
          wallC = new THREE.Color(0x9f1239);
          roofC = new THREE.Color(0x881337);
        } else {
          wallC = new THREE.Color(0xdc2626);
          roofC = new THREE.Color(0xbe123c);
        }
      }

      // 1. Walls
      for (let i = 0; i < n; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % n];
        const dx = p2[0] - p1[0];
        const dz = p2[1] - p1[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.05) continue;

        const nx = -dz / len;
        const nz = dx / len;

        // 2 triangles: (bl, br, tr) and (bl, tr, tl)
        const v0 = [p1[0], yMin, p1[1]];
        const v1 = [p2[0], yMin, p2[1]];
        const v2 = [p2[0], yTop, p2[1]];
        const v3 = [p1[0], yTop, p1[1]];

        const pushTri = (a, b, c) => {
          positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
          normals.push(nx, 0, nz, nx, 0, nz, nx, 0, nz);
          colors.push(
            wallC.r, wallC.g, wallC.b,
            wallC.r, wallC.g, wallC.b,
            wallC.r, wallC.g, wallC.b
          );
          triToPrism.push(prism);
          triToSurface.push(i);
        };
        pushTri(v0, v1, v2);
        pushTri(v0, v2, v3);

        // Roof edge outline
        edgeLines.push(p1[0], yTop + 0.06, p1[1], p2[0], yTop + 0.06, p2[1]);
        if (prism.hasSoffit) {
          edgeLines.push(p1[0], yMin - 0.03, p1[1], p2[0], yMin - 0.03, p2[1]);
        }
      }

      // 2. Roof triangulation (+ optional downward soffit cap for cantilevered tower floorplates)
      const roofStartVert = positions.length / 3;
      const contour2D = ring.map(([x, z]) => new THREE.Vector2(x, -z));
      const faces = THREE.ShapeUtils.triangulateShape(contour2D, []);

      for (const f of faces) {
        const a = ring[f[0]];
        const b = ring[f[1]];
        const c = ring[f[2]];
        // Verify upward normal (+Y)
        const abx = b[0] - a[0], abz = b[1] - a[1];
        const acx = c[0] - a[0], acz = c[1] - a[1];
        const ny = abz * acx - abx * acz;
        const pA = a, pB = ny >= 0 ? b : c, pC = ny >= 0 ? c : b;

        positions.push(pA[0], yTop, pA[1], pB[0], yTop, pB[1], pC[0], yTop, pC[1]);
        normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        colors.push(
          roofC.r, roofC.g, roofC.b,
          roofC.r, roofC.g, roofC.b,
          roofC.r, roofC.g, roofC.b
        );
        triToPrism.push(prism);
        triToSurface.push(-1);

        if (prism.hasSoffit) {
          positions.push(pA[0], yMin, pA[1], pC[0], yMin, pC[1], pB[0], yMin, pB[1]);
          normals.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
          colors.push(
            roofC.r * 0.78, roofC.g * 0.78, roofC.b * 0.78,
            roofC.r * 0.78, roofC.g * 0.78, roofC.b * 0.78,
            roofC.r * 0.78, roofC.g * 0.78, roofC.b * 0.78
          );
          triToPrism.push(prism);
          triToSurface.push(-1);
        }
      }

      const endVert = positions.length / 3;
      vertexRanges.set(prism.id, { startVert, roofStartVert, endVert });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.04
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeLines, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x475569,
      transparent: true,
      opacity: 0.35
    });
    const edges = new THREE.LineSegments(lineGeo, lineMat);

    return { mesh, edges, triToPrism, triToSurface, vertexRanges };
  }

  const mainPrisms = engine.prisms.filter((p) => !p.onSite355);
  const onSitePrisms = engine.prisms.filter((p) => p.onSite355);

  const mainBldgs = createMergedBuildings(mainPrisms);
  scene.add(mainBldgs.mesh);
  scene.add(mainBldgs.edges);

  const onSiteBldgs = createMergedBuildings(onSitePrisms);
  scene.add(onSiteBldgs.mesh);
  scene.add(onSiteBldgs.edges);

  // ==================== PROPOSED 355 CORONATION DR TOWER ====================
  const proposedGroup = new THREE.Group();
  scene.add(proposedGroup);

  let proposedMeshObj = null;

  // Ground cadastral parcel outline for 355 Coronation Dr & 6 Lang Pde
  function buildSiteParcelOutline() {
    const ring = DATA.proposed.siteParcel;
    const pts = [];
    for (let i = 0; i <= ring.length; i++) {
      const [x, z] = ring[i % ring.length];
      const y = engine.sampleDem(x, z) + 0.35;
      pts.push(new THREE.Vector3(x, y, z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xf43f5e, linewidth: 2 });
    const line = new THREE.Line(geo, mat);
    scene.add(line);
  }
  buildSiteParcelOutline();

  function rebuildProposedMesh() {
    // Clear existing proposed meshes
    while (proposedGroup.children.length > 0) {
      const ch = proposedGroup.children[0];
      proposedGroup.remove(ch);
      if (ch.geometry) ch.geometry.dispose();
      if (ch.material) ch.material.dispose();
    }
    proposedMeshObj = null;

    engine.setProposedConfig({
      enabled: state.proposedEnabled,
      height: state.proposedHeight,
      siteCoverPct: state.proposedSiteCover
    });

    const tiers = engine.proposedPrisms;
    const active = !!(engine.proposedPrism && tiers && tiers.length > 0);
    // Hide demolished existing buildings on 355 Coro when proposed tower is shown
    onSiteBldgs.mesh.visible = !active;
    onSiteBldgs.edges.visible = !active;

    if (!active) return;

    const p = engine.proposedPrism;
    const built = createMergedBuildings(tiers);

    // Override material with sleek per-tier architectural crimson for clear visual distinction & crisp shading
    built.mesh.material.dispose();
    built.mesh.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      emissive: 0x2b050b,
      emissiveIntensity: 0.16,
      roughness: 0.52,
      metalness: 0.08
    });
    built.mesh.castShadow = true;
    built.mesh.receiveShadow = true;

    built.edges.material.dispose();
    built.edges.material = new THREE.LineBasicMaterial({
      color: 0xffe4e6,
      transparent: true,
      opacity: 0.78
    });

    proposedGroup.add(built.mesh);
    proposedGroup.add(built.edges);

    // Exact DA A006954430 Rev B floor-plate bands (Ground 7.2, Mezz 10.7, L01 13.35, L02 18.50 + 3.15m typical, Undercroft 75.65, Terrace 78.35, Pavilion 82.10/83.60)
    if (state.showFloors && p.totalH >= 6) {
      const floorPts = [];
      const pushRingAtY = (ring, fy) => {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const len = Math.hypot(dx, dz) || 1;
          const nx = (-dz / len) * 0.12;
          const nz = (dx / len) * 0.12;
          floorPts.push(a[0] + nx, fy, a[1] + nz, b[0] + nx, fy, b[1] + nz);
        }
      };

      const groundFFL = p.groundFFL || 7.2;
      const typicalH = DATA.proposed.typicalFloorH || 3.15;

      for (const tier of tiers) {
        if (tier.tierKey === 'podium') {
          const podLevels = [groundFFL, DATA.proposed.mezzanineRL || 10.7, DATA.proposed.level01RL || 13.35];
          for (const fy of podLevels) {
            if (fy > tier.gMin + 0.5 && fy < tier.yTop - 0.5) pushRingAtY(tier.r, fy);
          }
        } else if (tier.tierKey === 'tower') {
          // Typical residential levels (3.15m floor-to-floor from L02 RL 18.50 upward)
          const roofUndercroftRL = DATA.proposed.roofUndercroftRL || 75.65;
          const maxTypicalY = Math.min(tier.yTop - 2.4, roofUndercroftRL - 2.5);
          for (let fy = tier.yMin + typicalH; fy <= maxTypicalY + 0.05; fy += typicalH) {
            pushRingAtY(tier.r, fy);
          }
          // Roof Undercroft transfer/pool slab band (2.7m below Roof Terrace)
          if (tier.yTop - tier.yMin > 8.0) {
            pushRingAtY(tier.r, tier.yTop - 2.7);
          }
        } else if (tier.tierKey === 'pavilion' && tier.yTop - tier.yMin >= 3.5) {
          // Lower NE canopy overhang line (RL 82.10 = 1.5m below RL 83.60)
          pushRingAtY(tier.r, tier.yTop - 1.5);
        }
      }

      if (floorPts.length > 0) {
        const fGeo = new THREE.BufferGeometry();
        fGeo.setAttribute('position', new THREE.Float32BufferAttribute(floorPts, 3));
        const fMat = new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.40
        });
        proposedGroup.add(new THREE.LineSegments(fGeo, fMat));
      }
    }

    // Purely visual 25m rooftop lap pool on open NE (Lang Parade) half of Roof Terrace (RL 78.35m)
    if (p.poolRing && p.poolRing.length === 4) {
      const pr = p.poolRing;
      const py = p.terraceY + 0.12;
      const poolPos = new Float32Array([
        pr[0][0], py, pr[0][1], pr[1][0], py, pr[1][1], pr[2][0], py, pr[2][1],
        pr[0][0], py, pr[0][1], pr[2][0], py, pr[2][1], pr[3][0], py, pr[3][1]
      ]);
      const poolGeo = new THREE.BufferGeometry();
      poolGeo.setAttribute('position', new THREE.BufferAttribute(poolPos, 3));
      poolGeo.computeVertexNormals();
      const poolMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0c4a6e,
        emissiveIntensity: 0.35,
        roughness: 0.18,
        metalness: 0.25,
        side: THREE.DoubleSide
      });
      const poolMesh = new THREE.Mesh(poolGeo, poolMat);
      poolMesh.castShadow = false;
      poolMesh.receiveShadow = true;
      proposedGroup.add(poolMesh);
    }

    proposedMeshObj = built;
  }

  // ==================== BUILDING COLORING MODES ====================
  function heightToColor(h, isRoof) {
    const c = new THREE.Color();
    // Smooth architectural elevation ramp: slate-white (low) -> teal -> blue -> indigo -> amber (tallest)
    const t = Math.max(0, Math.min(1, (h - 4) / 60));
    if (t < 0.25) c.setRGB(0.84 - t * 0.4, 0.89 - t * 0.1, 0.93);
    else if (t < 0.55) {
      const u = (t - 0.25) / 0.3;
      c.setRGB(0.74 - u * 0.42, 0.86 - u * 0.15, 0.93 - u * 0.05);
    } else {
      const u = (t - 0.55) / 0.45;
      c.setRGB(0.32 + u * 0.62, 0.71 - u * 0.35, 0.88 - u * 0.65);
    }
    if (isRoof) c.multiplyScalar(0.92);
    return c;
  }

  function impactToColor(deltaPct, isRoof) {
    const c = new THREE.Color();
    if (!deltaPct || deltaPct < 1.0) {
      c.setHex(isRoof ? 0xcbd5e1 : 0xe2e8f0);
      return c;
    }
    const t = Math.max(0, Math.min(1, deltaPct / 30));
    // Warm yellow -> vivid orange -> deep crimson
    c.setRGB(0.98, 0.78 - t * 0.62, 0.18 + t * 0.08);
    if (isRoof) c.multiplyScalar(0.93);
    return c;
  }

  function updateBuildingColors(hoveredId = null) {
    const applyTo = (bundle, list) => {
      const colAttr = bundle.mesh.geometry.attributes.color;
      const arr = colAttr.array;

      for (const p of list) {
        const range = bundle.vertexRanges.get(p.id);
        if (!range) continue;

        let wallC, roofC;
        if (state.selectedPrism && state.selectedPrism.id === p.id) {
          wallC = new THREE.Color(0xbae6fd);
          roofC = new THREE.Color(0x7dd3fc);
        } else if (hoveredId !== null && hoveredId === p.id) {
          wallC = new THREE.Color(0xfef08a);
          roofC = new THREE.Color(0xfde047);
        } else if (state.colorMode === 'height') {
          wallC = heightToColor(p.h, false);
          roofC = heightToColor(p.h, true);
        } else if (state.colorMode === 'impact') {
          const imp = state.impactMap.get(p.id);
          const metric = imp ? Math.max(imp.avgDelta9to3, imp.peakDeltaPct * 0.5) : 0;
          wallC = impactToColor(metric, false);
          roofC = impactToColor(metric, true);
        } else {
          // Architectural clean massing with subtle height-based contrast
          const shade = 0.94 - Math.min(0.14, p.h * 0.0022);
          wallC = new THREE.Color(shade, shade + 0.01, shade + 0.03);
          roofC = new THREE.Color(shade - 0.07, shade - 0.05, shade - 0.02);
        }

        for (let v = range.startVert; v < range.roofStartVert; v++) {
          const k = v * 3;
          arr[k] = wallC.r; arr[k + 1] = wallC.g; arr[k + 2] = wallC.b;
        }
        for (let v = range.roofStartVert; v < range.endVert; v++) {
          const k = v * 3;
          arr[k] = roofC.r; arr[k + 1] = roofC.g; arr[k + 2] = roofC.b;
        }
      }
      colAttr.needsUpdate = true;
    };

    applyTo(mainBldgs, mainPrisms);
    applyTo(onSiteBldgs, onSitePrisms);
  }

  // ==================== 3D SUN PATH ARC & SPHERE ====================
  const sunArcGroup = new THREE.Group();
  scene.add(sunArcGroup);

  const sunSphere = new THREE.Mesh(
    new THREE.SphereGeometry(18, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xfde047 })
  );
  sunArcGroup.add(sunSphere);

  let sunPathLine = null;
  let sunRayLine = null;

  function rebuildSunArc() {
    if (sunPathLine) {
      sunArcGroup.remove(sunPathLine);
      sunPathLine.geometry.dispose();
      sunPathLine.material.dispose();
      sunPathLine = null;
    }
    const { centerLat, centerLon, timezoneOffsetHours } = DATA.meta;
    const cx = DATA.proposed.cx;
    const cz = DATA.proposed.cz;
    const R = 520;
    const pts = [];
    for (let m = 300; m <= 1140; m += 10) {
      const sp = Solar.getSunPosition(state.year, state.month, state.day, m, centerLat, centerLon, timezoneOffsetHours);
      if (sp.altitudeDeg >= 0) {
        pts.push(new THREE.Vector3(cx + sp.dir[0] * R, 10 + sp.dir[1] * R, cz + sp.dir[2] * R));
      }
    }
    if (pts.length > 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.55 });
      sunPathLine = new THREE.Line(geo, mat);
      sunArcGroup.add(sunPathLine);
    }
  }

  // ==================== 3D SURFACE HEATMAP OVERLAY ====================
  const overlayGroup = new THREE.Group();
  scene.add(overlayGroup);

  function clearSurfaceOverlay() {
    while (overlayGroup.children.length > 0) {
      const ch = overlayGroup.children[0];
      overlayGroup.remove(ch);
      if (ch.geometry) ch.geometry.dispose();
      if (ch.material) ch.material.dispose();
    }
  }

  function renderSurfaceOverlay(prism, surfaceSpec, samples, evalResult) {
    clearSurfaceOverlay();
    if (!prism) return;

    // 1. Crisp cyan selection outline on clicked wall or building
    const outlinePts = [];
    if (surfaceSpec.type === 'wall') {
      const p1 = surfaceSpec.p1, p2 = surfaceSpec.p2;
      const [nx, , nz] = surfaceSpec.normal;
      const off = 0.25;
      const y0 = prism.gMin;
      const y1 = prism.yTop;
      const a = [p1[0] + nx * off, y0, p1[1] + nz * off];
      const b = [p2[0] + nx * off, y0, p2[1] + nz * off];
      const c = [p2[0] + nx * off, y1, p2[1] + nz * off];
      const d = [p1[0] + nx * off, y1, p1[1] + nz * off];
      outlinePts.push(...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a);
    } else {
      const r = prism.r;
      const y = prism.yTop + 0.35;
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        outlinePts.push(a[0], y, a[1], b[0], y, b[1]);
      }
    }
    const outGeo = new THREE.BufferGeometry();
    outGeo.setAttribute('position', new THREE.Float32BufferAttribute(outlinePts, 3));
    const outMat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
    overlayGroup.add(new THREE.LineSegments(outGeo, outMat));

    if (!state.showHeatmap || !samples.length || !evalResult) return;

    // 2. Live 3D sample-cell heatmap painted right onto the clicked wall / roof!
    const positions = [];
    const colors = [];
    const states = evalResult.states;

    const colSun = [0.98, 0.75, 0.14];    // Gold: direct sun
    const colNew355 = [0.96, 0.22, 0.36]; // Vivid crimson: NEW shade from 355 Coro!
    const colExist = [0.39, 0.46, 0.55];  // Cool slate: existing shade
    const colSelf = [0.15, 0.21, 0.31];   // Dark navy: facing away

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const st = states[i];
      const c = st === 0 ? colSun : st === 3 ? colNew355 : st === 2 ? colExist : colSelf;

      const hw = s.cellW * 0.45;
      const hh = s.cellH * 0.45;
      const off = 0.16;
      const cx = s.x + s.nx * off;
      const cy = s.y + s.ny * off;
      const cz = s.z + s.nz * off;

      let v0, v1, v2, v3;
      if (s.isRoof) {
        v0 = [cx - hw, cy, cz - hh];
        v1 = [cx + hw, cy, cz - hh];
        v2 = [cx + hw, cy, cz + hh];
        v3 = [cx - hw, cy, cz + hh];
      } else {
        const tx = s.ux * hw;
        const tz = s.uz * hw;
        v0 = [cx - tx, cy - hh, cz - tz];
        v1 = [cx + tx, cy - hh, cz + tz];
        v2 = [cx + tx, cy + hh, cz + tz];
        v3 = [cx - tx, cy + hh, cz - tz];
      }

      positions.push(
        v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2],
        v0[0], v0[1], v0[2], v2[0], v2[1], v2[2], v3[0], v3[1], v3[2]
      );
      for (let k = 0; k < 6; k++) colors.push(c[0], c[1], c[2]);
    }

    const hmGeo = new THREE.BufferGeometry();
    hmGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    hmGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const hmMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false
    });
    overlayGroup.add(new THREE.Mesh(hmGeo, hmMat));
  }

  // ==================== SUN & LIGHTING UPDATE ====================
  function updateSunAndLighting() {
    const { centerLat, centerLon, timezoneOffsetHours } = DATA.meta;
    const sunPos = Solar.getSunPosition(
      state.year, state.month, state.day, state.minutes,
      centerLat, centerLon, timezoneOffsetHours
    );

    // Position directional light centered on focus target (around 355 Coro / OrbitControls target)
    const tx = Math.max(-450, Math.min(450, controls.target.x));
    const tz = Math.max(-400, Math.min(400, controls.target.z));
    sunLight.target.position.set(tx, 10, tz);

    const dist = 950;
    sunLight.position.set(
      tx + sunPos.dir[0] * dist,
      10 + Math.max(0.02, sunPos.dir[1]) * dist,
      tz + sunPos.dir[2] * dist
    );
    sunLight.target.updateMatrixWorld();

    // Dynamic sky & sun warmth based on solar altitude
    const alt = sunPos.altitudeDeg;
    if (alt <= 0) {
      sunLight.intensity = 0.02;
      hemiLight.intensity = 0.18;
      scene.background.setHex(0x0f172a);
      scene.fog.color.setHex(0x0f172a);
    } else if (alt < 12) {
      const t = alt / 12;
      sunLight.intensity = 0.4 + t * 0.9;
      sunLight.color.setRGB(1.0, 0.72 + t * 0.24, 0.45 + t * 0.48);
      hemiLight.intensity = 0.28 + t * 0.28;
      const sky = new THREE.Color(0x334155).lerp(new THREE.Color(0xcbdcf0), t);
      scene.background.copy(sky);
      scene.fog.color.copy(sky);
    } else {
      sunLight.intensity = 1.65 + Math.min(0.22, (alt - 12) * 0.004);
      sunLight.color.setHex(0xfffbeb);
      hemiLight.intensity = 0.40;
      scene.background.setHex(0xd6e6f7);
      scene.fog.color.setHex(0xd6e6f7);
    }

    // Update 3D sun sphere & ray indicator
    sunArcGroup.visible = state.showSunArc && sunPos.isDay;
    if (sunPos.isDay) {
      const cx = DATA.proposed.cx;
      const cz = DATA.proposed.cz;
      const R = 520;
      const sx = cx + sunPos.dir[0] * R;
      const sy = 10 + sunPos.dir[1] * R;
      const sz = cz + sunPos.dir[2] * R;
      sunSphere.position.set(sx, sy, sz);

      if (sunRayLine) {
        sunArcGroup.remove(sunRayLine);
        sunRayLine.geometry.dispose();
        sunRayLine.material.dispose();
      }
      const rayGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(sx, sy, sz),
        new THREE.Vector3(cx, DATA.proposed.g + (state.proposedEnabled ? state.proposedHeight : 10), cz)
      ]);
      sunRayLine = new THREE.Line(
        rayGeo,
        new THREE.LineDashedMaterial({ color: 0xfde047, dashSize: 12, gapSize: 8, transparent: true, opacity: 0.45 })
      );
      sunRayLine.computeLineDistances();
      sunArcGroup.add(sunRayLine);
    }

    // Update HUD readouts
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const timeStr = Solar.formatMinutes(state.minutes);
    document.getElementById('hud-datetime').textContent = `${state.day} ${months[state.month - 1]} · ${timeStr}`;
    document.getElementById('hud-alt').textContent = sunPos.isDay ? `${sunPos.altitudeDeg.toFixed(1)}°` : 'Below Horizon';
    document.getElementById('hud-az').textContent = sunPos.isDay
      ? `${sunPos.azimuthDeg.toFixed(1)}° ${Solar.azimuthToCompass(sunPos.azimuthDeg)}`
      : 'Night';
    document.getElementById('time-val').textContent = timeStr;
    document.getElementById('sel-time-badge').textContent = `${timeStr} AEST`;

    // Re-evaluate currently selected building surface live!
    if (state.selectedPrism && state.selectedSurface) {
      evaluateSelectedSurfaceNow(sunPos);
      updateChartTimeMarker();
    }
  }

  // ==================== SURFACE INSPECTION & CHART ====================
  function selectBuildingSurface(prism, surfaceSpec) {
    state.selectedPrism = prism;

    // Populate surface selector dropdown
    const surfaces = engine.getBuildingSurfaces(prism);
    const selectEl = document.getElementById('surface-select');
    selectEl.innerHTML = '';

    // Add Whole Building option at top
    const wholeOpt = document.createElement('option');
    wholeOpt.value = 'whole';
    const totalArea = surfaces.reduce((acc, s) => acc + s.area, 0);
    wholeOpt.textContent = `Whole Building Exterior (${totalArea} m²)`;
    selectEl.appendChild(wholeOpt);

    // Add Roof & all Walls
    for (const s of surfaces) {
      const opt = document.createElement('option');
      opt.value = s.type === 'roof' ? 'roof' : `wall:${s.edgeIdx}`;
      opt.textContent =
        s.type === 'roof'
          ? `Roof Surface (${s.area} m²)`
          : `${s.label} — ${s.width}m × ${s.height}m (${s.area} m²)`;
      selectEl.appendChild(opt);
    }

    // Resolve chosen surface spec
    let chosen = surfaceSpec;
    if (!chosen || chosen.type === 'whole') {
      chosen = { type: 'whole', edgeIdx: -2, label: 'Whole Building Exterior', area: totalArea };
      selectEl.value = 'whole';
    } else if (chosen.type === 'roof') {
      chosen = surfaces.find((s) => s.type === 'roof') || surfaces[0];
      selectEl.value = 'roof';
    } else if (chosen.type === 'wall') {
      chosen = surfaces.find((s) => s.type === 'wall' && s.edgeIdx === chosen.edgeIdx) || surfaces[1] || surfaces[0];
      selectEl.value = chosen.type === 'roof' ? 'roof' : `wall:${chosen.edgeIdx}`;
    }

    state.selectedSurface = chosen;
    state.selectedSamples = engine.buildSurfaceSamples(prism, chosen, chosen.type === 'whole' ? 280 : 210);

    // Update UI Header
    document.getElementById('inspector-empty').style.display = 'none';
    document.getElementById('inspector-content').style.display = 'flex';
    document.getElementById('sel-addr').textContent = prism.addr;

    const dist355 = Math.round(Math.hypot(prism.cx - DATA.proposed.cx, prism.cz - DATA.proposed.cz));
    const approxStoreys = Math.max(1, Math.round(prism.h / 3.3));
    if (prism.isProposed) {
      const groundFFL = DATA.proposed.groundFFL || 7.2;
      document.getElementById('sel-meta').innerHTML = `
        <span class="meta-chip">Total: ${(prism.totalH || state.proposedHeight).toFixed(1)}m (Ground RL ${groundFFL.toFixed(1)}m)</span>
        <span class="meta-chip">Tier RL: ${prism.g.toFixed(1)}–${prism.yTop.toFixed(2)}m</span>
        <span class="meta-chip">Floorplate: ${prism.area} m²</span>
        <span class="meta-chip" style="color:#fda4af">DA A006954430</span>
      `;
    } else {
      document.getElementById('sel-meta').innerHTML = `
        <span class="meta-chip">Height: ${prism.h.toFixed(1)}m (~${approxStoreys}st)</span>
        <span class="meta-chip">NGL: ${prism.g.toFixed(1)}m AHD</span>
        <span class="meta-chip">Roof RL: ${prism.yTop.toFixed(1)}m</span>
        <span class="meta-chip">${dist355}m from 355 Coro</span>
      `;
    }
    document.getElementById('sel-area').textContent = `${Math.round(chosen.area)} m² · ${state.selectedSamples.length} pts`;

    // Highlight buttons
    document.getElementById('btn-surf-roof').classList.toggle('active-cyan', chosen.type === 'roof');
    document.getElementById('btn-surf-whole').classList.toggle('active-cyan', chosen.type === 'whole');

    // Switch to Inspector tab
    switchTab('inspector');

    // Compute full-day shading profile & current evaluation
    recomputeSelectedDailyProfile();
    updateBuildingColors();
  }

  function evaluateSelectedSurfaceNow(sunPos) {
    if (!state.selectedPrism || !state.selectedSurface) return;
    if (!sunPos) {
      const { centerLat, centerLon, timezoneOffsetHours } = DATA.meta;
      sunPos = Solar.getSunPosition(
        state.year, state.month, state.day, state.minutes,
        centerLat, centerLon, timezoneOffsetHours
      );
    }

    const res = engine.evaluateSurfaceAtSun(state.selectedPrism, state.selectedSamples, sunPos);

    // Update KPI cards
    document.getElementById('kpi-prop').textContent = `${res.proposedShadedPct.toFixed(1)}%`;
    document.getElementById('kpi-base').textContent = `${res.baselineShadedPct.toFixed(1)}%`;
    const sign = res.deltaPct > 0.05 ? '+' : '';
    document.getElementById('kpi-delta').textContent = `${sign}${res.deltaPct.toFixed(1)}%`;
    document.getElementById('kpi-delta-m2').textContent =
      res.newShadeAreaM2 > 0.5 ? `+${Math.round(res.newShadeAreaM2)} m² newly shaded` : 'No extra shade now';

    // Breakdown bar segments
    const sunPct = Math.max(0, res.sunlitPct);
    const newPct = Math.max(0, (res.newShadeAreaM2 / (res.totalArea || 1)) * 100);
    const selfPct = Math.max(0, res.selfShadedPct);
    const existPct = Math.max(0, 100 - sunPct - newPct - selfPct);

    document.getElementById('seg-sun').style.width = `${sunPct.toFixed(1)}%`;
    document.getElementById('seg-new355').style.width = `${newPct.toFixed(1)}%`;
    document.getElementById('seg-exist').style.width = `${existPct.toFixed(1)}%`;
    document.getElementById('seg-self').style.width = `${selfPct.toFixed(1)}%`;

    document.getElementById('leg-sun').textContent = `${sunPct.toFixed(1)}%`;
    document.getElementById('leg-new355').textContent = `${newPct.toFixed(1)}%`;
    document.getElementById('leg-exist').textContent = `${existPct.toFixed(1)}%`;
    document.getElementById('leg-self').textContent = `${selfPct.toFixed(1)}%`;

    // Render 3D sample heatmap overlay on the clicked surface
    renderSurfaceOverlay(state.selectedPrism, state.selectedSurface, state.selectedSamples, res);
  }

  function recomputeSelectedDailyProfile() {
    if (!state.selectedPrism || !state.selectedSurface) return;
    const prof = engine.computeDailyProfile(
      state.selectedPrism, state.selectedSamples,
      state.year, state.month, state.day, 15
    );
    state.dailyProfile = prof;
    renderDailyChart(prof);
    evaluateSelectedSurfaceNow();

    // Update summary stats table
    const fmtDelta = (v) => (v > 0.05 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`);
    document.getElementById('st-base-93').textContent = `${prof.avgBase9to3.toFixed(1)}%`;
    document.getElementById('st-prop-93').textContent = `${prof.avgProp9to3.toFixed(1)}%`;
    const d93 = document.getElementById('st-delta-93');
    d93.textContent = fmtDelta(prof.avgDelta9to3);
    d93.className = prof.avgDelta9to3 > 0.5 ? 'delta-pos' : 'delta-zero';

    document.getElementById('st-base-day').textContent = `${prof.avgBaseDay.toFixed(1)}%`;
    document.getElementById('st-prop-day').textContent = `${prof.avgPropDay.toFixed(1)}%`;
    const dDay = document.getElementById('st-delta-day');
    dDay.textContent = fmtDelta(prof.avgDeltaDay);
    dDay.className = prof.avgDeltaDay > 0.5 ? 'delta-pos' : 'delta-zero';

    const hrsEl = document.getElementById('st-hrs-93');
    hrsEl.textContent = prof.sunlitHoursLost9to3 > 0.01 ? `-${prof.sunlitHoursLost9to3.toFixed(2)} hr` : '0.00 hr';
    hrsEl.className = prof.sunlitHoursLost9to3 > 0.05 ? 'delta-pos' : 'delta-zero';

    const peakTimeEl = document.getElementById('st-peak-time');
    const peakValEl = document.getElementById('st-peak-val');
    if (prof.peakDelta > 0.5) {
      peakTimeEl.textContent = `@ ${Solar.formatMinutes(prof.peakDeltaMin)} (jump)`;
      peakTimeEl.dataset.min = String(prof.peakDeltaMin);
      peakValEl.textContent = `+${prof.peakDelta.toFixed(1)}%`;
      peakValEl.className = 'delta-pos';
    } else {
      peakTimeEl.textContent = 'None';
      peakTimeEl.dataset.min = '';
      peakValEl.textContent = '0.0%';
      peakValEl.className = 'delta-zero';
    }
  }

  // ==================== SVG DAILY SHADING CHART ====================
  let chartCoords = { minM: 360, maxM: 1080, x0: 28, x1: 310, y0: 10, y1: 126 };

  function renderDailyChart(prof) {
    const svg = document.getElementById('daily-chart-svg');
    const pts = prof.points;
    if (!pts.length) {
      svg.innerHTML = '';
      return;
    }

    const x0 = 28, x1 = 310, y0 = 10, y1 = 126;
    const minM = pts[0].min;
    const maxM = pts[pts.length - 1].min;
    chartCoords = { minM, maxM, x0, x1, y0, y1 };

    const mapX = (m) => x0 + ((m - minM) / Math.max(1, maxM - minM)) * (x1 - x0);
    const mapY = (pct) => y1 - (Math.max(0, Math.min(100, pct)) / 100) * (y1 - y0);

    // 9am - 3pm shaded band
    const x9 = Math.max(x0, Math.min(x1, mapX(540)));
    const x15 = Math.max(x0, Math.min(x1, mapX(900)));

    let html = '';
    html += `<rect x="${x9.toFixed(1)}" y="${y0}" width="${Math.max(0, x15 - x9).toFixed(1)}" height="${y1 - y0}" fill="rgba(245,158,11,0.08)" />`;

    // Horizontal grid lines
    for (const p of [0, 25, 50, 75, 100]) {
      const y = mapY(p);
      html += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="rgba(148,163,184,0.16)" stroke-width="1"/>`;
      if (p % 50 === 0) {
        html += `<text x="${x0 - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="#64748b" font-size="8.5" font-family="monospace">${p}%</text>`;
      }
    }

    // X-axis hour ticks
    for (let h = 6; h <= 18; h += 2) {
      const m = h * 60;
      if (m < minM - 10 || m > maxM + 10) continue;
      const x = mapX(m);
      html += `<line x1="${x.toFixed(1)}" y1="${y1}" x2="${x.toFixed(1)}" y2="${y1 + 3}" stroke="#64748b" stroke-width="1"/>`;
      html += `<text x="${x.toFixed(1)}" y="${y1 + 14}" text-anchor="middle" fill="#94a3b8" font-size="8.5" font-family="monospace">${String(h).padStart(2, '0')}h</text>`;
    }

    // Delta fill polygon between proposed curve and baseline curve
    let fillPath = `M ${mapX(pts[0].min).toFixed(1)} ${mapY(pts[0].propPct).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      fillPath += ` L ${mapX(pts[i].min).toFixed(1)} ${mapY(pts[i].propPct).toFixed(1)}`;
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      fillPath += ` L ${mapX(pts[i].min).toFixed(1)} ${mapY(pts[i].basePct).toFixed(1)}`;
    }
    fillPath += ' Z';
    html += `<path d="${fillPath}" fill="rgba(244,63,94,0.34)" />`;

    // Baseline dashed curve
    const baseD = pts
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${mapX(pt.min).toFixed(1)} ${mapY(pt.basePct).toFixed(1)}`)
      .join(' ');
    html += `<path d="${baseD}" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="3,3" />`;

    // Proposed solid curve
    const propD = pts
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${mapX(pt.min).toFixed(1)} ${mapY(pt.propPct).toFixed(1)}`)
      .join(' ');
    html += `<path d="${propD}" fill="none" stroke="#fb7185" stroke-width="2.1" />`;

    // Current time marker line
    html += `<line id="chart-time-line" x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="#fbbf24" stroke-width="1.6" />`;
    html += `<circle id="chart-time-dot" cx="${x0}" cy="${y1}" r="3.5" fill="#fbbf24" stroke="#0f172a" stroke-width="1.2" />`;

    svg.innerHTML = html;
    updateChartTimeMarker();
  }

  function updateChartTimeMarker() {
    const line = document.getElementById('chart-time-line');
    const dot = document.getElementById('chart-time-dot');
    if (!line || !dot || !state.dailyProfile) return;
    const { minM, maxM, x0, x1, y0, y1 } = chartCoords;
    const clampedM = Math.max(minM, Math.min(maxM, state.minutes));
    const x = x0 + ((clampedM - minM) / Math.max(1, maxM - minM)) * (x1 - x0);

    // Interpolate propPct at current minute
    const pts = state.dailyProfile.points;
    let pct = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      if (clampedM >= pts[i].min && clampedM <= pts[i + 1].min) {
        const f = (clampedM - pts[i].min) / Math.max(1, pts[i + 1].min - pts[i].min);
        pct = pts[i].propPct * (1 - f) + pts[i + 1].propPct * f;
        break;
      }
    }
    const y = y1 - (pct / 100) * (y1 - y0);
    line.setAttribute('x1', x.toFixed(1));
    line.setAttribute('x2', x.toFixed(1));
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', y.toFixed(1));
  }

  // Interactive scrubbing on SVG chart
  const chartSvg = document.getElementById('daily-chart-svg');
  let scrubbingChart = false;
  function scrubChartFromEvent(e) {
    if (!state.dailyProfile) return;
    const rect = chartSvg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * 320;
    const { minM, maxM, x0, x1 } = chartCoords;
    const frac = Math.max(0, Math.min(1, (relX - x0) / (x1 - x0)));
    const newMin = Math.round(minM + frac * (maxM - minM));
    setMinutes(newMin);
  }
  chartSvg.addEventListener('pointerdown', (e) => {
    scrubbingChart = true;
    chartSvg.setPointerCapture(e.pointerId);
    scrubChartFromEvent(e);
  });
  chartSvg.addEventListener('pointermove', (e) => {
    if (scrubbingChart) scrubChartFromEvent(e);
  });
  chartSvg.addEventListener('pointerup', () => {
    scrubbingChart = false;
  });

  // ==================== NEIGHBOURHOOD IMPACT SCAN ====================
  function runImpactScan() {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    document.getElementById('scan-date-badge').textContent = `${state.day} ${months[state.month - 1]}`;

    const results = engine.scanImpactedBuildings(state.year, state.month, state.day, state.minutes, 450);
    state.impactList = results;
    state.impactMap.clear();
    for (const r of results) state.impactMap.set(r.id, r);

    document.getElementById('impact-count-badge').textContent = String(results.length);

    const listEl = document.getElementById('impact-list');
    if (results.length === 0) {
      listEl.innerHTML = `<div class="section-card empty-state">No neighbouring buildings receive additional shade from 355 Coronation Drive under the current height/date settings.</div>`;
    } else {
      listEl.innerHTML = results
        .map((r, i) => {
          const barW = Math.min(100, Math.max(6, r.peakDeltaPct));
          return `
            <div class="impact-item" data-bldg-id="${r.id}" data-peak-min="${r.peakMin}">
              <div class="impact-item-top">
                <span class="impact-addr">${i + 1}. ${r.addr}</span>
                <span class="impact-delta">+${r.peakDeltaPct.toFixed(1)}% peak</span>
              </div>
              <div class="impact-item-sub">
                <span>h=${r.h.toFixed(1)}m · ${r.dist}m away</span>
                <span>9–3 avg: +${r.avgDelta9to3.toFixed(1)}% · @ ${Solar.formatMinutes(r.peakMin)}</span>
              </div>
              <div class="impact-bar-bg"><div class="impact-bar-fill" style="width:${barW.toFixed(0)}%"></div></div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.impact-item').forEach((el) => {
        el.addEventListener('click', () => {
          const id = Number(el.dataset.bldgId);
          const peakMin = Number(el.dataset.peakMin);
          const prism = engine.byId.get(id);
          if (!prism) return;
          // Jump time to peak impact moment for crystal-clear visualization
          if (Number.isFinite(peakMin)) setMinutes(peakMin);
          // Pick most impacted sun-facing wall (or whole building)
          const bestSurf = findMostImpactedSurface(prism, peakMin);
          selectBuildingSurface(prism, bestSurf);
          flyToBuilding(prism);
        });
      });
    }

    if (state.colorMode === 'impact') {
      updateBuildingColors();
    }
  }

  function findMostImpactedSurface(prism, atMin) {
    const { centerLat, centerLon, timezoneOffsetHours } = DATA.meta;
    const sunPos = Solar.getSunPosition(state.year, state.month, state.day, atMin, centerLat, centerLon, timezoneOffsetHours);
    const surfaces = engine.getBuildingSurfaces(prism);
    let best = surfaces[0];
    let bestScore = -1;
    for (const s of surfaces) {
      if (s.area < 12) continue;
      const samples = engine.buildSurfaceSamples(prism, s, 45);
      const res = engine.evaluateSurfaceAtSun(prism, samples, sunPos);
      // Prefer surfaces with largest delta % weighted slightly by area
      const score = res.deltaPct * Math.pow(s.area, 0.2);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  // ==================== CAMERA PRESETS & SMOOTH FLIGHT ====================
  let cameraFlight = null;

  function flyTo(pos, target, durationMs = 750) {
    cameraFlight = {
      startTime: performance.now(),
      duration: durationMs,
      fromPos: camera.position.clone(),
      toPos: new THREE.Vector3(pos[0], pos[1], pos[2]),
      fromTarget: controls.target.clone(),
      toTarget: new THREE.Vector3(target[0], target[1], target[2])
    };
  }

  function flyToBuilding(prism) {
    const dist = Math.max(85, prism.h * 2.4 + 65);
    flyTo(
      [prism.cx + dist * 0.75, prism.yTop + dist * 0.65, prism.cz + dist * 0.72],
      [prism.cx, prism.g + prism.h * 0.45, prism.cz],
      700
    );
  }

  function setCameraPreset(name, instant = false) {
    const cx = DATA.proposed.cx;
    const cz = DATA.proposed.cz;
    let pos, target;
    if (name === 'focus355') {
      // Classic dramatic view showing 355 Coro, Lang Parade, Coronation Dr, and Dunmore Tce hillside behind!
      pos = [cx + 215, 175, cz + 185];
      target = [cx - 25, 28, cz + 15];
    } else if (name === 'dunmore') {
      // Looking from Dunmore Terrace hilltop past 8 & 24 Dunmore Tce toward 355 Coro & River
      pos = [cx - 210, 145, cz + 175];
      target = [cx - 20, 32, cz + 10];
    } else if (name === 'river') {
      // Looking from over Brisbane River / West End directly at Coronation Dr riverfront elevation
      pos = [cx + 270, 95, cz + 250];
      target = [cx, 35, cz];
    } else if (name === 'top') {
      // Near top-down architectural shadow plan view
      pos = [cx, 620, cz + 45];
      target = [cx, 10, cz];
    } else {
      // Full region overview (1.73 km x 1.51 km)
      pos = [220, 780, 760];
      target = [0, 10, 0];
    }

    document.querySelectorAll('.cam-btn').forEach((b) => b.classList.toggle('active', b.dataset.cam === name));

    if (instant) {
      camera.position.set(pos[0], pos[1], pos[2]);
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
    } else {
      flyTo(pos, target, 750);
    }
  }

  // ==================== RAYCAST PICKING (CLICK ANY WALL OR ROOF!) ====================
  const raycaster = new THREE.Raycaster();
  const mouseNDC = new THREE.Vector2();
  const tooltipEl = document.getElementById('hover-tooltip');
  const ttAddr = document.getElementById('tt-addr');
  const ttSub = document.getElementById('tt-sub');

  let pointerDownPos = null;
  let hoveredBuildingId = null;

  function pickAtClient(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);

    const targets = [mainBldgs.mesh];
    if (onSiteBldgs.mesh.visible) targets.push(onSiteBldgs.mesh);
    if (proposedMeshObj && proposedMeshObj.mesh.visible) targets.push(proposedMeshObj.mesh);

    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;

    const hit = hits[0];
    let bundle = mainBldgs;
    if (hit.object === onSiteBldgs.mesh) bundle = onSiteBldgs;
    else if (proposedMeshObj && hit.object === proposedMeshObj.mesh) bundle = proposedMeshObj;

    const prism = bundle.triToPrism[hit.faceIndex];
    const surfIdx = bundle.triToSurface[hit.faceIndex];
    if (!prism) return null;
    return { prism, surfIdx, hit };
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button === 0) {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      cameraFlight = null;
    }
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    // Only hover-pick when not dragging
    if (e.buttons !== 0) {
      tooltipEl.style.display = 'none';
      return;
    }
    const picked = pickAtClient(e.clientX, e.clientY);
    if (picked) {
      const { prism, surfIdx } = picked;
      const surfLabel = surfIdx === -1 ? 'Roof Surface' : 'Exterior Wall';
      ttAddr.textContent = prism.isProposed ? (prism.shortAddr || prism.addr) : prism.addr;
      ttSub.textContent = prism.isProposed
        ? `${prism.tierLabel} · ${surfLabel}`
        : `Height: ${prism.h.toFixed(1)}m · Roof RL ${prism.yTop.toFixed(1)}m · ${surfLabel}`;
      tooltipEl.style.display = 'block';
      tooltipEl.style.left = `${Math.min(window.innerWidth - 270, e.clientX + 14)}px`;
      tooltipEl.style.top = `${Math.min(window.innerHeight - 60, e.clientY + 14)}px`;

      if (hoveredBuildingId !== prism.id) {
        hoveredBuildingId = prism.id;
        updateBuildingColors(hoveredBuildingId);
      }
      renderer.domElement.style.cursor = 'pointer';
    } else {
      tooltipEl.style.display = 'none';
      if (hoveredBuildingId !== null) {
        hoveredBuildingId = null;
        updateBuildingColors(null);
      }
      renderer.domElement.style.cursor = 'grab';
    }
  });

  // ==================== WIND TUNNEL MODULE REFERENCE ====================
  let windTunnel = null;

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!pointerDownPos || e.button !== 0) return;
    const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    pointerDownPos = null;
    if (dist > 5) return; // Was a drag/orbit, not a click

    // In Wind Tunnel mode, clicking terrain or rooftop drops the 3D wind probe
    if (windTunnel && windTunnel.isActive()) {
      const rect = renderer.domElement.getBoundingClientRect();
      mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouseNDC, camera);
      const targets = [terrainMesh];
      if (proposedMeshObj && proposedMeshObj.mesh.visible) targets.unshift(proposedMeshObj.mesh);
      const hits = raycaster.intersectObjects(targets, false);
      if (hits.length) {
        const hitProp = !!(proposedMeshObj && hits[0].object === proposedMeshObj.mesh);
        if (windTunnel.onSceneClick(hits[0].point, hitProp)) return;
      }
    }

    const picked = pickAtClient(e.clientX, e.clientY);
    if (picked) {
      const { prism, surfIdx } = picked;
      const spec = surfIdx === -1 ? { type: 'roof', edgeIdx: -1 } : { type: 'wall', edgeIdx: surfIdx };
      selectBuildingSurface(prism, spec);
    }
  });

  // ==================== UI BINDINGS ====================
  function updateDaySummaryUI() {
    const { centerLat, centerLon, timezoneOffsetHours } = DATA.meta;
    const info = Solar.getDaySummary(state.year, state.month, state.day, centerLat, centerLon, timezoneOffsetHours);
    document.getElementById('tick-sunrise').textContent = `↑ ${Solar.formatMinutes(info.sunriseMin)}`;
    document.getElementById('tick-noon').textContent = `☀ ${Solar.formatMinutes(info.solarNoonMin)}`;
    document.getElementById('tick-sunset').textContent = `↓ ${Solar.formatMinutes(info.sunsetMin)}`;

    // Season badge
    const badge = document.getElementById('day-season-badge');
    const md = `${String(state.month).padStart(2, '0')}-${String(state.day).padStart(2, '0')}`;
    if (md === '06-21') badge.textContent = 'Winter Solstice';
    else if (md === '12-21') badge.textContent = 'Summer Solstice';
    else if (md === '03-21' || md === '09-23') badge.textContent = 'Equinox';
    else if (state.month >= 6 && state.month <= 8) badge.textContent = 'Brisbane Winter';
    else if (state.month === 12 || state.month <= 2) badge.textContent = 'Brisbane Summer';
    else badge.textContent = `Max Alt ${info.maxAltitudeDeg.toFixed(0)}°`;

    rebuildSunArc();
  }

  function setDate(isoStr) {
    const parts = isoStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return;
    state.year = parts[0];
    state.month = parts[1];
    state.day = parts[2];
    document.getElementById('date-input').value = isoStr;
    document.querySelectorAll('[data-date]').forEach((b) => b.classList.toggle('active', b.dataset.date === isoStr));
    updateDaySummaryUI();
    updateSunAndLighting();
    if (state.selectedPrism) recomputeSelectedDailyProfile();
    runImpactScan();
  }

  function setMinutes(m) {
    state.minutes = Math.max(300, Math.min(1140, m));
    document.getElementById('time-slider').value = String(Math.round(state.minutes));
    updateSunAndLighting();
  }

  function estimateProposedStoreys(h) {
    if (h <= 0) return 0;
    if (Math.abs(h - 76.4) < 0.35) return 23;
    const podiumH = DATA.proposed.podiumHeight || 11.3;
    const typicalH = DATA.proposed.typicalFloorH || 3.15;
    if (h <= podiumH) return Math.max(1, Math.round(h / 3.75));
    const pavH = h > 18.0 ? Math.min(DATA.proposed.pavilionHeight || 5.25, (h - 18.0) * 0.25) : 0;
    return Math.max(1, Math.round(3 + (h - podiumH - pavH) / typicalH + (h > 18.0 ? 1 : 0)));
  }

  function updateProposedUI() {
    const active = state.proposedEnabled && state.proposedHeight > 0;
    const h = active ? state.proposedHeight : 0;
    const groundFFL = DATA.proposed.groundFFL !== undefined ? DATA.proposed.groundFFL : 7.2;
    const storeys = estimateProposedStoreys(h);
    const rl = groundFFL + h;
    const pavH = h > 18.0 ? Math.min(DATA.proposed.pavilionHeight || 5.25, (h - 18.0) * 0.25) : 0;
    const terraceRL = rl - pavH;

    rebuildProposedMesh();

    const towerArea = engine.proposedPrism
      ? engine.proposedPrism.towerArea
      : Math.round(DATA.proposed.siteArea * (state.proposedSiteCover / 100));

    document.getElementById('toggle-proposed').checked = state.proposedEnabled;
    document.getElementById('height-slider').value = String(state.proposedHeight);
    document.getElementById('height-val').textContent = `${state.proposedHeight.toFixed(1)} m`;
    document.getElementById('cover-slider').value = String(state.proposedSiteCover);
    document.getElementById('cover-val').textContent = `${state.proposedSiteCover}% (${towerArea} m²)`;
    document.getElementById('tower-rl').textContent = active ? `${rl.toFixed(1)} m` : 'Existing';
    const terraceEl = document.getElementById('tower-terrace-rl');
    if (terraceEl) terraceEl.textContent = active && pavH > 0.2 ? `${terraceRL.toFixed(2)} m` : '—';
    document.getElementById('tower-storeys').textContent = active ? String(storeys) : '0';
    document.getElementById('hud-tower').textContent = active ? `${storeys}st · ${h.toFixed(1)}m (RL ${rl.toFixed(1)}m)` : 'OFF (Baseline)';

    const badge = document.getElementById('tower-status-badge');
    if (!active) { badge.textContent = 'Baseline'; badge.className = 'badge'; }
    else if (Math.abs(h - 76.4) < 0.5 && state.proposedSiteCover === 60) { badge.textContent = 'Approved DA'; badge.className = 'badge red'; }
    else if (Math.abs(h - 76.4) < 0.5 && state.proposedSiteCover === 50) { badge.textContent = '23st · 50% Cover'; badge.className = 'badge amber'; }
    else if (Math.abs(h - 27.0) < 0.5) { badge.textContent = '8st Statutory'; badge.className = 'badge green'; }
    else if (Math.abs(h - 50.0) < 0.5) { badge.textContent = '15st HDR2'; badge.className = 'badge amber'; }
    else { badge.textContent = 'Custom'; badge.className = 'badge amber'; }

    if (state.selectedPrism) {
      if (state.selectedPrism.isProposed) {
        const match = engine.proposedPrisms.find((t) => t.tierKey === state.selectedPrism.tierKey) || engine.proposedPrism;
        if (match) selectBuildingSurface(match, state.selectedSurface);
        else {
          state.selectedPrism = null;
          clearSurfaceOverlay();
          document.getElementById('inspector-empty').style.display = 'block';
          document.getElementById('inspector-content').style.display = 'none';
        }
      } else {
        recomputeSelectedDailyProfile();
      }
    }
    runImpactScan();
    if (windTunnel) windTunnel.onProposedChanged();
  }

  function switchTab(tabName) {
    document.querySelectorAll('#right-solar-pane .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('#right-solar-pane .tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
  }

  // Date pills & custom date
  document.querySelectorAll('[data-date]').forEach((btn) => {
    btn.addEventListener('click', () => setDate(btn.dataset.date));
  });
  document.getElementById('date-input').addEventListener('change', (e) => setDate(e.target.value));

  // Time slider & Play animation
  document.getElementById('time-slider').addEventListener('input', (e) => {
    state.playing = false;
    updatePlayBtn();
    setMinutes(Number(e.target.value));
  });

  function updatePlayBtn() {
    const btn = document.getElementById('play-btn');
    btn.textContent = state.playing ? '⏸ Pause' : '▶ Animate Day';
    btn.classList.toggle('playing', state.playing);
  }

  document.getElementById('play-btn').addEventListener('click', () => {
    state.playing = !state.playing;
    updatePlayBtn();
  });
  document.getElementById('play-speed').addEventListener('change', (e) => {
    state.playSpeed = Number(e.target.value);
  });

  // Scenario pills
  document.querySelectorAll('[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sc = btn.dataset.scenario;
      state.activeScenario = sc;
      document.querySelectorAll('[data-scenario]').forEach((b) => b.classList.toggle('active-red', b === btn));
      if (sc === 'approved') {
        state.proposedEnabled = true; state.proposedHeight = 76.4; state.proposedSiteCover = 60;
      } else if (sc === 'cover50') {
        state.proposedEnabled = true; state.proposedHeight = 76.4; state.proposedSiteCover = 50;
      } else if (sc === 'hdr2') {
        state.proposedEnabled = true; state.proposedHeight = 50.0; state.proposedSiteCover = 50;
      } else if (sc === 'statutory') {
        state.proposedEnabled = true; state.proposedHeight = 27.0; state.proposedSiteCover = 50;
      } else if (sc === 'off') {
        state.proposedEnabled = false;
      }
      updateProposedUI();
    });
  });

  document.getElementById('toggle-proposed').addEventListener('change', (e) => {
    state.proposedEnabled = e.target.checked;
    if (state.proposedEnabled && state.proposedHeight <= 0) state.proposedHeight = 76.4;
    updateProposedUI();
  });

  let sliderDebounce = null;
  function onTowerSliderChange() {
    state.proposedHeight = Number(document.getElementById('height-slider').value);
    state.proposedSiteCover = Number(document.getElementById('cover-slider').value);
    state.proposedEnabled = state.proposedHeight > 0;
    document.querySelectorAll('[data-scenario]').forEach((b) => b.classList.remove('active-red'));

    // Immediate visual update of tower + selected surface
    rebuildProposedMesh();
    const groundFFL = DATA.proposed.groundFFL !== undefined ? DATA.proposed.groundFFL : 7.2;
    const h = state.proposedEnabled ? state.proposedHeight : 0;
    const rl = groundFFL + h;
    const pavH = h > 18.0 ? Math.min(DATA.proposed.pavilionHeight || 5.25, (h - 18.0) * 0.25) : 0;
    const area = engine.proposedPrism
      ? engine.proposedPrism.towerArea
      : Math.round(DATA.proposed.siteArea * (state.proposedSiteCover / 100));
    document.getElementById('height-val').textContent = `${state.proposedHeight.toFixed(1)} m`;
    document.getElementById('cover-val').textContent = `${state.proposedSiteCover}% (${area} m²)`;
    document.getElementById('tower-rl').textContent = state.proposedEnabled ? `${rl.toFixed(1)} m` : 'Existing';
    const terraceEl = document.getElementById('tower-terrace-rl');
    if (terraceEl) terraceEl.textContent = state.proposedEnabled && pavH > 0.2 ? `${(rl - pavH).toFixed(2)} m` : '—';
    document.getElementById('tower-storeys').textContent = state.proposedEnabled ? String(estimateProposedStoreys(h)) : '0';
    document.getElementById('toggle-proposed').checked = state.proposedEnabled;
    if (state.selectedPrism && !state.selectedPrism.isProposed) {
      evaluateSelectedSurfaceNow();
    }

    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(() => updateProposedUI(), 180);
  }
  document.getElementById('height-slider').addEventListener('input', onTowerSliderChange);
  document.getElementById('cover-slider').addEventListener('input', onTowerSliderChange);

  // Basemap buttons
  document.querySelectorAll('[data-basemap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.basemap = btn.dataset.basemap;
      document.querySelectorAll('[data-basemap]').forEach((b) => b.classList.toggle('active-cyan', b === btn));
      terrainMesh.material.map = getBasemapTexture(state.basemap);
      terrainMesh.material.needsUpdate = true;
    });
  });

  // Building coloring mode buttons
  document.querySelectorAll('[data-colormode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.colorMode = btn.dataset.colormode;
      document.querySelectorAll('[data-colormode]').forEach((b) => b.classList.toggle('active-cyan', b === btn));
      updateBuildingColors();
    });
  });

  // Display checkboxes
  document.getElementById('toggle-heatmap').addEventListener('change', (e) => {
    state.showHeatmap = e.target.checked;
    if (state.selectedPrism) evaluateSelectedSurfaceNow();
  });
  document.getElementById('toggle-sunarc').addEventListener('change', (e) => {
    state.showSunArc = e.target.checked;
    updateSunAndLighting();
  });
  document.getElementById('toggle-floors').addEventListener('change', (e) => {
    state.showFloors = e.target.checked;
    rebuildProposedMesh();
  });

  // Camera buttons & compass reset
  document.querySelectorAll('.cam-btn').forEach((btn) => {
    btn.addEventListener('click', () => setCameraPreset(btn.dataset.cam));
  });
  document.getElementById('compass-btn').addEventListener('click', () => {
    const t = controls.target;
    const dist = camera.position.distanceTo(t);
    const polar = controls.getPolarAngle();
    flyTo(
      [t.x, t.y + Math.cos(polar) * dist, t.z + Math.sin(polar) * dist],
      [t.x, t.y, t.z],
      500
    );
  });

  // Panel collapse / restore
  const leftPanel = document.getElementById('left-panel');
  const rightPanel = document.getElementById('right-panel');
  const toggleLeftBtn = document.getElementById('toggle-left-btn');
  const toggleRightBtn = document.getElementById('toggle-right-btn');

  document.getElementById('collapse-left').addEventListener('click', () => {
    leftPanel.classList.add('collapsed');
    toggleLeftBtn.style.display = 'block';
  });
  toggleLeftBtn.addEventListener('click', () => {
    leftPanel.classList.remove('collapsed');
    toggleLeftBtn.style.display = 'none';
  });
  document.getElementById('collapse-right').addEventListener('click', () => {
    rightPanel.classList.add('collapsed');
    toggleRightBtn.style.display = 'block';
  });
  toggleRightBtn.addEventListener('click', () => {
    rightPanel.classList.remove('collapsed');
    toggleRightBtn.style.display = 'none';
  });

  // Right panel solar tabs
  document.querySelectorAll('#right-solar-pane .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Surface dropdown & quick buttons
  document.getElementById('surface-select').addEventListener('change', (e) => {
    if (!state.selectedPrism) return;
    const val = e.target.value;
    if (val === 'whole') selectBuildingSurface(state.selectedPrism, { type: 'whole' });
    else if (val === 'roof') selectBuildingSurface(state.selectedPrism, { type: 'roof', edgeIdx: -1 });
    else if (val.startsWith('wall:')) {
      selectBuildingSurface(state.selectedPrism, { type: 'wall', edgeIdx: Number(val.split(':')[1]) });
    }
  });
  document.getElementById('btn-surf-roof').addEventListener('click', () => {
    if (state.selectedPrism) selectBuildingSurface(state.selectedPrism, { type: 'roof', edgeIdx: -1 });
  });
  document.getElementById('btn-surf-whole').addEventListener('click', () => {
    if (state.selectedPrism) selectBuildingSurface(state.selectedPrism, { type: 'whole' });
  });
  document.getElementById('btn-fly-selected').addEventListener('click', () => {
    if (state.selectedPrism) flyToBuilding(state.selectedPrism);
  });

  document.getElementById('st-peak-time').addEventListener('click', (e) => {
    const m = Number(e.target.dataset.min);
    if (Number.isFinite(m) && m > 0) setMinutes(m);
  });

  document.getElementById('quick-inspect-8dunmore').addEventListener('click', () => {
    // Pick the tallest 8 Dunmore Terrace building (nearest residential tower directly SW of 355 Coro)
    const candidates = engine.prisms
      .filter((p) => !p.onSite355 && /^8 Dunmore/i.test(p.addr))
      .sort((a, b) => b.h - a.h);
    const target = candidates[0] || (state.impactList[0] && engine.byId.get(state.impactList[0].id));
    if (target) {
      const surf = findMostImpactedSurface(target, state.minutes);
      selectBuildingSurface(target, surf);
      flyToBuilding(target);
    }
  });

  document.getElementById('btn-rescan-impact').addEventListener('click', () => {
    state.colorMode = 'impact';
    document.querySelectorAll('[data-colormode]').forEach((b) => b.classList.toggle('active-cyan', b.dataset.colormode === 'impact'));
    runImpactScan();
    updateBuildingColors();
  });

  // Resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ==================== MAIN ANIMATION LOOP ====================
  const compassSvg = document.getElementById('compass-svg');
  let lastFrameTime = performance.now();

  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    // Camera flight interpolation
    if (cameraFlight) {
      const elapsed = now - cameraFlight.startTime;
      const t = Math.min(1, elapsed / cameraFlight.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(cameraFlight.fromPos, cameraFlight.toPos, ease);
      controls.target.lerpVectors(cameraFlight.fromTarget, cameraFlight.toTarget, ease);
      if (t >= 1) cameraFlight = null;
    }

    // Play sun animation
    if (state.playing) {
      let nextM = state.minutes + dt * state.playSpeed;
      if (nextM > 1080) nextM = 360;
      setMinutes(nextM);
    }

    // Step 3D Wind Tunnel streamlines when active
    if (windTunnel) windTunnel.animate(dt);

    controls.update();

    // Keep shadow frustum anchored smoothly around camera target
    const az = controls.getAzimuthalAngle(); // 0 when looking North (-Z)
    compassSvg.style.transform = `rotate(${(az * 180) / Math.PI}deg)`;

    renderer.render(scene, camera);
  }

  // ==================== INITIALIZE SCENE ====================
  setCameraPreset('focus355', true);
  rebuildProposedMesh();
  updateBuildingColors();
  updateDaySummaryUI();
  updateSunAndLighting();
  runImpactScan();

  // Initialize 3D Wind Tunnel (Navier-Stokes CFD + 10-year Brisbane Wind Climate)
  if (window.initWindTunnelUI) {
    windTunnel = window.initWindTunnelUI({
      THREE,
      scene,
      shadingEngine: engine,
      sceneData: DATA,
      windClimate: window.WIND_CLIMATE,
      getAppState: () => state,
      flyTo,
      onModeChange: (mode) => {
        // Hide solar surface heatmap overlay when inspecting Wind Tunnel mode
        if (overlayGroup) overlayGroup.visible = mode === 'solar';
      }
    });
  }

  // Pre-select 8 Dunmore Terrace's most impacted facade on startup so the user immediately sees
  // the live 3D surface shading heatmap + daily % shaded chart in action!
  const defaultNeighbour = engine.prisms
    .filter((p) => !p.onSite355 && /^8 Dunmore/i.test(p.addr))
    .sort((a, b) => b.h - a.h)[0];
  if (defaultNeighbour) {
    const bestSurf = findMostImpactedSurface(defaultNeighbour, state.minutes);
    selectBuildingSurface(defaultNeighbour, bestSurf);
  }

  // Hide loading overlay
  const loadingEl = document.getElementById('loading-overlay');
  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 400);

  requestAnimationFrame(animate);
})();
