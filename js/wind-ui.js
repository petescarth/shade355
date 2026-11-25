/**
 * 3D Wind Tunnel Visualization, Interactive Brisbane Wind Rose & Probe UI
 * Integrates WindTunnelEngine (3D Navier-Stokes CFD) + WIND_CLIMATE (10-yr Brisbane history)
 * seamlessly into the Three.js scene and HUD without affecting Solar & Shade mode.
 */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerpColor(stops, t) {
    const u = clamp(t, 0, 1);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (u <= b[0] || i === stops.length - 2) {
        const f = clamp((u - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
        return [
          Math.round(a[1] + (b[1] - a[1]) * f),
          Math.round(a[2] + (b[2] - a[2]) * f),
          Math.round(a[3] + (b[3] - a[3]) * f)
        ];
      }
    }
    const last = stops[stops.length - 1];
    return [last[1], last[2], last[3]];
  }

  const RAMPS = {
    speed: [
      [0.0, 30, 58, 138],
      [0.2, 14, 165, 233],
      [0.42, 34, 197, 94],
      [0.62, 250, 204, 21],
      [0.82, 249, 115, 22],
      [1.0, 217, 70, 239]
    ],
    delta: [
      [0.0, 37, 99, 235],
      [0.32, 56, 189, 248],
      [0.5, 148, 163, 184],
      [0.64, 250, 204, 21],
      [0.82, 249, 115, 22],
      [1.0, 244, 63, 94]
    ],
    downwash: [
      [0.0, 15, 23, 42],
      [0.25, 14, 165, 233],
      [0.6, 99, 102, 241],
      [1.0, 217, 70, 239]
    ]
  };

  function speedToRGB01(spd, maxSpd = 22) {
    const rgb = lerpColor(RAMPS.speed, spd / maxSpd);
    return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  }

  function lawsonRGBA(spd) {
    if (spd < 4.0) return [34, 197, 94, 165];
    if (spd < 6.0) return [56, 189, 248, 178];
    if (spd < 8.0) return [250, 204, 21, 192];
    if (spd < 10.0) return [251, 146, 60, 208];
    if (spd < 15.0) return [244, 63, 94, 220];
    return [217, 70, 239, 235];
  }

  global.initWindTunnelUI = function initWindTunnelUI(ctx) {
    const {
      THREE,
      scene,
      shadingEngine,
      sceneData,
      windClimate,
      getAppState,
      flyTo,
      onModeChange
    } = ctx;

    if (!global.WindTunnelEngine) return null;

    const windEngine = new global.WindTunnelEngine(shadingEngine, sceneData, windClimate);

    const wState = {
      active: false,
      presetId: 'debbie-ne',
      presetLabel: 'Ex-TC Debbie (NE)',
      dirDeg: 48,
      refSpeedMs: 22.3,
      mapMode: 'delta', // 'delta' | 'speed' | 'lawson' | 'downwash'
      showMap: true,
      showParticles: true,
      showSlice: false,
      sliceOffset: 0,
      probe: { ...windEngine.keyProbes[0] },
      lastMetrics: null,
      scanning: false
    };

    // Apply default preset from WIND_CLIMATE if available
    if (windClimate && windClimate.presets && windClimate.presets.length) {
      const def = windClimate.presets.find((p) => p.id === 'debbie-ne') || windClimate.presets[0];
      wState.presetId = def.id;
      wState.presetLabel = def.label;
      wState.dirDeg = def.dirDeg;
      wState.refSpeedMs = def.defaultSpeedMs;
    }

    // ==================== 3D WIND TUNNEL SCENE GROUP ====================
    const windGroup = new THREE.Group();
    windGroup.visible = false;
    scene.add(windGroup);

    // 1. Domain boundary frame draped on terrain
    const buildDomainFrame = () => {
      const pts = [];
      const steps = 40;
      const { minX, maxX, minZ, maxZ } = windEngine;
      const addEdge = (x0, z0, x1, z1) => {
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = x0 + (x1 - x0) * t;
          const z = z0 + (z1 - z0) * t;
          pts.push(new THREE.Vector3(x, shadingEngine.sampleDem(x, z) + 0.65, z));
        }
      };
      addEdge(minX, minZ, maxX, minZ);
      addEdge(maxX, minZ, maxX, maxZ);
      addEdge(maxX, maxZ, minX, maxZ);
      addEdge(minX, maxZ, minX, minZ);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 });
      windGroup.add(new THREE.Line(geo, mat));
    };
    buildDomainFrame();

    // 2. Draped Pedestrian Wind Heatmap Mesh (nx x nz terrain-following CanvasTexture)
    const heatCanvas = document.createElement('canvas');
    heatCanvas.width = windEngine.nx;
    heatCanvas.height = windEngine.nz;
    const heatCtx = heatCanvas.getContext('2d');
    const heatTex = new THREE.CanvasTexture(heatCanvas);
    heatTex.minFilter = THREE.LinearFilter;
    heatTex.magFilter = THREE.LinearFilter;
    heatTex.flipY = false;

    const heatGeo = new THREE.PlaneGeometry(windEngine.domainW, windEngine.domainD, windEngine.nx - 1, windEngine.nz - 1);
    heatGeo.rotateX(-Math.PI / 2);
    const hPos = heatGeo.attributes.position;
    for (let i = 0; i < hPos.count; i++) {
      const lx = hPos.getX(i);
      const lz = hPos.getZ(i);
      const wx = windEngine.cx + lx;
      const wz = windEngine.cz + lz;
      hPos.setY(i, shadingEngine.sampleDem(wx, wz) + 0.58);
    }
    heatGeo.computeVertexNormals();
    const heatMat = new THREE.MeshBasicMaterial({
      map: heatTex,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const heatMesh = new THREE.Mesh(heatGeo, heatMat);
    heatMesh.position.set(windEngine.cx, 0, windEngine.cz);
    windGroup.add(heatMesh);

    // 3. Upwind Direction Chevron Arrows (3 glowing arrows showing inflow vector)
    const arrowGroup = new THREE.Group();
    windGroup.add(arrowGroup);
    function rebuildWindArrows() {
      while (arrowGroup.children.length) {
        const ch = arrowGroup.children[0];
        arrowGroup.remove(ch);
        if (ch.geometry) ch.geometry.dispose();
        if (ch.material) ch.material.dispose();
      }
      const [fx, fz] = global.WindTunnelEngine.windDirToFlowXZ(wState.dirDeg);
      const cx = windEngine.cx, cz = windEngine.cz;
      const crossX = -fz, crossZ = fx;
      const dirVec = new THREE.Vector3(fx, 0, fz);

      for (const off of [-85, 0, 85]) {
        const ox = cx - fx * 150 + crossX * off;
        const oz = cz - fz * 150 + crossZ * off;
        const oy = shadingEngine.sampleDem(ox, oz) + 34;
        const arrow = new THREE.ArrowHelper(dirVec, new THREE.Vector3(ox, oy, oz), 36, 0x38bdf8, 12, 8);
        arrowGroup.add(arrow);
      }
    }

    // 4. Animated 3D Wind Streamlines (2,400 GPU-friendly line segments)
    const PARTICLE_COUNT = 2400;
    const pPos = new Float32Array(PARTICLE_COUNT * 3);
    const pAge = new Float32Array(PARTICLE_COUNT);
    const pMaxAge = new Float32Array(PARTICLE_COUNT);
    const linePos = new Float32Array(PARTICLE_COUNT * 6);
    const lineCol = new Float32Array(PARTICLE_COUNT * 6);

    const streamGeo = new THREE.BufferGeometry();
    streamGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    streamGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
    const streamMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85
    });
    const streamLines = new THREE.LineSegments(streamGeo, streamMat);
    streamLines.frustumCulled = false;
    windGroup.add(streamLines);

    function seedParticle(i, initialScatter = false) {
      const [fx, fz] = global.WindTunnelEngine.windDirToFlowXZ(wState.dirDeg);
      const crossX = -fz, crossZ = fx;
      const half = windEngine.domainW * 0.48;
      // 45% focused around 355 Coro facade/downwash zone, 55% across full 320m domain
      const focused = (i % 10) < 4;
      const along = initialScatter
        ? (Math.random() * 2 - 1) * (focused ? 95 : half)
        : -(focused ? 55 + Math.random() * 55 : half * (0.85 + Math.random() * 0.14));
      const cross = (Math.random() * 2 - 1) * (focused ? 65 : half);
      const wx = clamp(windEngine.cx + fx * along + crossX * cross, windEngine.minX + 3, windEngine.maxX - 3);
      const wz = clamp(windEngine.cz + fz * along + crossZ * cross, windEngine.minZ + 3, windEngine.maxZ - 3);
      const gy = shadingEngine.sampleDem(wx, wz);
      // Bias heights toward pedestrian -> 76m tower height so downwash is vividly visible
      const u = Math.random();
      const hAGL = focused ? (2.0 + Math.pow(u, 1.15) * 86.0) : (2.0 + Math.pow(u, 1.45) * 90.0);
      const wy = Math.min(windEngine.domainH - 3, gy + hAGL);

      pPos[i * 3] = wx;
      pPos[i * 3 + 1] = wy;
      pPos[i * 3 + 2] = wz;
      pAge[i] = initialScatter ? Math.random() * 4.0 : 0;
      pMaxAge[i] = 3.2 + Math.random() * 3.8;

      linePos[i * 6] = wx; linePos[i * 6 + 1] = wy; linePos[i * 6 + 2] = wz;
      linePos[i * 6 + 3] = wx; linePos[i * 6 + 4] = wy; linePos[i * 6 + 5] = wz;
    }

    function resetAllParticles() {
      for (let i = 0; i < PARTICLE_COUNT; i++) seedParticle(i, true);
      streamGeo.attributes.position.needsUpdate = true;
    }

    // 5. Movable Wind-Aligned Vertical Airflow Cross-Section Slice
    const sliceW = 128, sliceH = 44;
    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = sliceW;
    sliceCanvas.height = sliceH;
    const sliceCtx = sliceCanvas.getContext('2d');
    const sliceTex = new THREE.CanvasTexture(sliceCanvas);
    sliceTex.minFilter = THREE.LinearFilter;
    sliceTex.magFilter = THREE.LinearFilter;

    const sliceGeo = new THREE.PlaneGeometry(windEngine.domainW, windEngine.domainH);
    const sliceMat = new THREE.MeshBasicMaterial({
      map: sliceTex,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const sliceMesh = new THREE.Mesh(sliceGeo, sliceMat);
    sliceMesh.visible = false;
    windGroup.add(sliceMesh);

    function updateVerticalSlice() {
      sliceMesh.visible = wState.active && wState.showSlice && !!wState.lastMetrics;
      if (!sliceMesh.visible) return;

      const field = wState.lastMetrics.prop;
      const [fx, fz] = field.flowDir;
      const crossX = -fz, crossZ = fx;
      const cx = windEngine.cx + crossX * wState.sliceOffset;
      const cz = windEngine.cz + crossZ * wState.sliceOffset;

      // Orient vertical plane along the wind vector (fx, fz)
      sliceMesh.position.set(cx, windEngine.yBase + windEngine.domainH / 2, cz);
      const yaw = Math.atan2(-fz, fx);
      sliceMesh.rotation.set(0, yaw, 0);

      const img = sliceCtx.createImageData(sliceW, sliceH);
      const d = img.data;
      const maxSpd = Math.max(14, wState.refSpeedMs * 1.35);

      for (let py = 0; py < sliceH; py++) {
        // Canvas row 0 is top (domainH), row sliceH-1 is bottom (yBase)
        const wy = windEngine.yBase + (1 - (py + 0.5) / sliceH) * windEngine.domainH;
        for (let px = 0; px < sliceW; px++) {
          const along = ((px + 0.5) / sliceW - 0.5) * windEngine.domainW;
          const wx = cx + fx * along;
          const wz = cz + fz * along;
          const k = (py * sliceW + px) * 4;

          const s = windEngine.sampleVelocity(field, wx, wy, wz, wState.refSpeedMs);
          if (s.isSolid) {
            d[k] = 15; d[k + 1] = 23; d[k + 2] = 42; d[k + 3] = 215;
          } else {
            let rgb;
            if (wState.mapMode === 'downwash') {
              const dwT = clamp(s.downwash / Math.max(4, wState.refSpeedMs * 0.35), 0, 1);
              rgb = lerpColor(RAMPS.downwash, dwT);
              d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2];
              d[k + 3] = Math.round(50 + dwT * 190);
            } else {
              rgb = lerpColor(RAMPS.speed, s.speed / maxSpd);
              d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2];
              d[k + 3] = 175;
            }
          }
        }
      }
      sliceCtx.putImageData(img, 0, 0);
      sliceTex.needsUpdate = true;
    }

    // 6. 3D Anemometer Probe Pin + Vertical Mast
    const probeGroup = new THREE.Group();
    const probeBall = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 18, 18),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    const probeRing = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 5.2, 24),
      new THREE.MeshBasicMaterial({ color: 0xe0f2fe, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    );
    probeRing.rotation.x = -Math.PI / 2;
    const mastGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 90, 0)
    ]);
    const mastLine = new THREE.Line(
      mastGeo,
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.5 })
    );
    probeGroup.add(probeBall);
    probeGroup.add(probeRing);
    probeGroup.add(mastLine);
    windGroup.add(probeGroup);

    function positionProbePin(x, y, z) {
      const gy = shadingEngine.sampleDem(x, z);
      probeBall.position.set(x, y, z);
      probeRing.position.set(x, Math.max(gy + 0.7, y - 0.8), z);
      mastLine.position.set(x, gy, z);
    }

    // ==================== PEDESTRIAN HEATMAP RENDERING ====================
    function updateLegendUI() {
      const bar = document.getElementById('wind-legend-bar');
      const lMin = document.getElementById('wind-leg-min');
      const lMid = document.getElementById('wind-leg-mid');
      const lMax = document.getElementById('wind-leg-max');
      const maxS = Math.max(14, Math.round(wState.refSpeedMs * 1.15));

      if (wState.mapMode === 'delta') {
        bar.style.background = 'linear-gradient(90deg, #2563eb, #38bdf8 30%, rgba(148,163,184,0.3) 50%, #facc15 66%, #f97316 83%, #f43f5e)';
        lMin.textContent = 'Sheltered (-6)';
        lMid.textContent = '0 m/s';
        lMax.textContent = '+10 m/s Δ';
      } else if (wState.mapMode === 'speed') {
        bar.style.background = 'linear-gradient(90deg, #1e3a8a, #0ea5e9 22%, #22c55e 44%, #facc15 64%, #f97316 82%, #d946ef)';
        lMin.textContent = '0 m/s';
        lMid.textContent = `${Math.round(maxS * 0.5)} m/s`;
        lMax.textContent = `${maxS} m/s`;
      } else if (wState.mapMode === 'lawson') {
        bar.style.background = 'linear-gradient(90deg, #22c55e 0 18%, #38bdf8 18% 36%, #facc15 36% 54%, #fb923c 54% 72%, #f43f5e 72% 88%, #d946ef 88%)';
        lMin.textContent = '<4 Sit';
        lMid.textContent = '6-8 Walk';
        lMax.textContent = '≥15 Distress';
      } else {
        bar.style.background = 'linear-gradient(90deg, rgba(15,23,42,0.4), #0ea5e9 30%, #6366f1 65%, #d946ef)';
        lMin.textContent = '0 m/s';
        lMid.textContent = 'Downwash';
        lMax.textContent = `${Math.max(4, Math.round(wState.refSpeedMs * 0.3))} m/s ↓`;
      }
    }

    function paintPedestrianHeatmap() {
      heatMesh.visible = wState.active && wState.showMap && !!wState.lastMetrics;
      if (!wState.lastMetrics) return;

      const { nx, nz } = windEngine;
      const m = wState.lastMetrics;
      const bldg = m.prop.bldgFootprint;
      const img = heatCtx.createImageData(nx, nz);
      const d = img.data;
      const maxSpd = Math.max(14, wState.refSpeedMs * 1.15);
      const maxDw = Math.max(4, wState.refSpeedMs * 0.3);

      for (let z = 0; z < nz; z++) {
        for (let x = 0; x < nx; x++) {
          const idx = z * nx + x;
          const k = idx * 4;

          // Fade smoothly at outer 3-cell edges and mask solid building interiors
          const edgeDist = Math.min(x, z, nx - 1 - x, nz - 1 - z);
          const edgeFade = clamp(edgeDist / 4, 0, 1);
          if (bldg[idx] || edgeFade < 0.02) {
            d[k] = 0; d[k + 1] = 0; d[k + 2] = 0; d[k + 3] = 0;
            continue;
          }

          let r = 0, g = 0, b = 0, a = 195;
          if (wState.mapMode === 'delta') {
            const dv = m.deltaSpeed[idx];
            const absD = Math.abs(dv);
            if (absD < 0.45) {
              a = 0;
            } else {
              const t = clamp(0.5 + (dv / 10.0) * 0.5, 0, 1);
              [r, g, b] = lerpColor(RAMPS.delta, t);
              a = Math.round(clamp((absD - 0.3) / 3.5, 0.2, 0.92) * 235);
            }
          } else if (wState.mapMode === 'speed') {
            const sp = m.propSpeed[idx];
            [r, g, b] = lerpColor(RAMPS.speed, sp / maxSpd);
            a = Math.round(135 + clamp(sp / maxSpd, 0, 1) * 95);
          } else if (wState.mapMode === 'lawson') {
            [r, g, b, a] = lawsonRGBA(m.propSpeed[idx]);
          } else {
            const dw = m.downwash[idx];
            if (dw < 0.35) {
              a = 0;
            } else {
              const t = clamp(dw / maxDw, 0, 1);
              [r, g, b] = lerpColor(RAMPS.downwash, t);
              a = Math.round((0.25 + t * 0.72) * 235);
            }
          }

          d[k] = r; d[k + 1] = g; d[k + 2] = b;
          d[k + 3] = Math.round(a * edgeFade);
        }
      }

      heatCtx.putImageData(img, 0, 0);
      heatTex.needsUpdate = true;
      updateLegendUI();
    }

    // ==================== INTERACTIVE 16-SECTOR BRISBANE WIND ROSE SVG ====================
    function renderWindRoseSVG() {
      const svg = document.getElementById('wind-rose-svg');
      if (!svg) return;
      const rose = windClimate && windClimate.roseAnnual ? windClimate.roseAnnual : null;

      let html = '';
      // Concentric frequency guide rings
      for (const rad of [24, 48, 72]) {
        html += `<circle cx="0" cy="0" r="${rad}" fill="none" stroke="rgba(148,163,184,0.18)" stroke-width="0.9" stroke-dasharray="${rad === 72 ? 'none' : '2,2'}"/>`;
      }
      // Crosshairs
      html += `<line x1="0" y1="-76" x2="0" y2="76" stroke="rgba(148,163,184,0.16)" stroke-width="0.8"/>`;
      html += `<line x1="-76" y1="0" x2="76" y2="0" stroke="rgba(148,163,184,0.16)" stroke-width="0.8"/>`;

      if (rose) {
        const maxFreq = Math.max(...rose.map((s) => s.freqPct), 12);
        const maxGust = Math.max(...rose.map((s) => s.maxGustMs), 24);
        const gustPts = [];

        for (let i = 0; i < 16; i++) {
          const s = rose[i];
          const aMid = ((s.deg - 90) * Math.PI) / 180;
          const a0 = ((s.deg - 10.2 - 90) * Math.PI) / 180;
          const a1 = ((s.deg + 10.2 - 90) * Math.PI) / 180;
          const rF = 10 + (s.freqPct / maxFreq) * 60;
          const x0 = Math.cos(a0) * rF, y0 = Math.sin(a0) * rF;
          const x1 = Math.cos(a1) * rF, y1 = Math.sin(a1) * rF;
          const isNear = Math.abs((((wState.dirDeg - s.deg + 540) % 360) - 180)) < 12;

          html += `<path d="M 0 0 L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rF.toFixed(1)} ${rF.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z"
            fill="${isNear ? 'rgba(56,189,248,0.68)' : 'rgba(56,189,248,0.28)'}"
            stroke="${isNear ? '#e0f2fe' : 'rgba(56,189,248,0.5)'}"
            stroke-width="${isNear ? 1.4 : 0.7}"
            data-rosedir="${Math.round(s.deg)}">
            <title>${s.dir} (${Math.round(s.deg)}°): ${s.freqPct}% freq · mean ${s.meanMs} m/s · max gust ${s.maxGustMs} m/s</title>
          </path>`;

          const rG = 14 + (s.maxGustMs / maxGust) * 62;
          gustPts.push(`${(Math.cos(aMid) * rG).toFixed(1)},${(Math.sin(aMid) * rG).toFixed(1)}`);
        }
        // 10-year max gust envelope polygon
        html += `<polygon points="${gustPts.join(' ')}" fill="none" stroke="rgba(244,63,94,0.65)" stroke-width="1.2" stroke-dasharray="3,2" pointer-events="none"/>`;
      }

      // Active wind direction pointer (pointing inward FROM dirDeg)
      const rad = ((wState.dirDeg - 90) * Math.PI) / 180;
      const sx = Math.cos(rad) * 78, sy = Math.sin(rad) * 78;
      const ex = Math.cos(rad) * 18, ey = Math.sin(rad) * 18;
      html += `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#f43f5e" stroke-width="2.4" stroke-linecap="round" pointer-events="none"/>`;
      html += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4.5" fill="#f43f5e" stroke="#fff" stroke-width="1.2" pointer-events="none"/>`;
      html += `<circle cx="0" cy="0" r="3" fill="#e2e8f0" pointer-events="none"/>`;

      // Cardinal labels
      const labels = [
        ['N', 0, -85], ['NE', 63, -60], ['E', 86, 4], ['SE', 63, 66],
        ['S', 0, 91], ['SW', -63, 66], ['W', -86, 4], ['NW', -63, -60]
      ];
      for (const [txt, lx, ly] of labels) {
        const major = txt.length === 1;
        html += `<text x="${lx}" y="${ly}" text-anchor="middle" fill="${major ? '#f8fafc' : '#94a3b8'}" font-size="${major ? 10.5 : 8.5}" font-weight="${major ? 700 : 600}" pointer-events="none">${txt}</text>`;
      }
      svg.innerHTML = html;
    }

    // ==================== VERTICAL WIND PROFILE SVG CHART ====================
    function renderVerticalProfileSVG(probeRes) {
      const svg = document.getElementById('wind-profile-svg');
      if (!svg || !probeRes || !probeRes.profile.length) return;

      const W = 320, H = 148;
      const padL = 34, padR = 12, padT = 10, padB = 22;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const maxH = 96;
      const maxS = Math.max(
        12,
        ...probeRes.profile.map((p) => Math.max(p.propSpeed, p.baseSpeed))
      ) * 1.12;

      const xOf = (spd) => padL + clamp(spd / maxS, 0, 1) * plotW;
      const yOf = (rl) => padT + (1 - clamp(rl / maxH, 0, 1)) * plotH;

      let html = '';
      // Horizontal RL reference bands (Podium 18.5m, Roof Terrace 78.35m)
      const yTerr = yOf(78.35);
      const yPod = yOf(18.5);
      html += `<line x1="${padL}" y1="${yTerr.toFixed(1)}" x2="${W - padR}" y2="${yTerr.toFixed(1)}" stroke="rgba(244,63,94,0.35)" stroke-dasharray="3,3" stroke-width="1"/>`;
      html += `<text x="${W - padR - 2}" y="${(yTerr - 3).toFixed(1)}" text-anchor="end" fill="#fda4af" font-size="8.5">Terrace RL 78.4m</text>`;
      html += `<line x1="${padL}" y1="${yPod.toFixed(1)}" x2="${W - padR}" y2="${yPod.toFixed(1)}" stroke="rgba(148,163,184,0.22)" stroke-dasharray="2,3" stroke-width="1"/>`;

      // Grid lines & labels
      for (const rl of [0, 25, 50, 75, 95]) {
        const y = yOf(rl);
        html += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="rgba(148,163,184,0.12)" stroke-width="0.8"/>`;
        html += `<text x="${padL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="8.5" font-family="monospace">${rl}m</text>`;
      }
      for (let i = 0; i <= 4; i++) {
        const sp = (maxS * i) / 4;
        const x = xOf(sp);
        html += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${H - padB}" stroke="rgba(148,163,184,0.12)" stroke-width="0.8"/>`;
        html += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="#94a3b8" font-size="8.5" font-family="monospace">${sp.toFixed(0)}</text>`;
      }

      // Baseline dashed polyline & Proposed solid polyline
      const basePts = probeRes.profile.map((p) => `${xOf(p.baseSpeed).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' ');
      const propPts = probeRes.profile.map((p) => `${xOf(p.propSpeed).toFixed(1)},${yOf(p.y).toFixed(1)}`).join(' ');
      html += `<polyline points="${basePts}" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="4,3"/>`;
      html += `<polyline points="${propPts}" fill="none" stroke="#38bdf8" stroke-width="2.2"/>`;

      // Highlight probed height dot
      const dotX = xOf(probeRes.prop.speed);
      const dotY = yOf(probeRes.y);
      html += `<circle cx="${dotX.toFixed(1)}" cy="${dotY.toFixed(1)}" r="4" fill="#f43f5e" stroke="#fff" stroke-width="1.2"/>`;

      svg.innerHTML = html;
    }

    // ==================== CORE UPDATE & PROBE EVALUATION ====================
    function updateProbeUI() {
      if (!wState.active) return;
      const pr = wState.probe;
      const res = windEngine.probePoint(pr.x, pr.y, pr.z, wState.dirDeg, wState.refSpeedMs);
      positionProbePin(res.x, res.y, res.z);

      document.getElementById('wprobe-label').textContent = pr.label || 'Custom Point';
      document.getElementById('wprobe-elev').textContent = pr.isRooftop
        ? `RL ${res.y.toFixed(1)}m (Terrace)`
        : `RL ${res.y.toFixed(1)}m (+${res.hAGL.toFixed(1)}m AGL)`;
      document.getElementById('wprobe-dir-badge').textContent = `${Math.round(wState.dirDeg)}° ${global.WindTunnelEngine.dirToCompass(wState.dirDeg)}`;

      document.getElementById('wkpi-prop').textContent = `${res.prop.speed.toFixed(1)} m/s`;
      document.getElementById('wkpi-prop-kmh').textContent = `${Math.round(res.prop.speed * 3.6)} km/h`;
      document.getElementById('wkpi-base').textContent = `${res.base.speed.toFixed(1)} m/s`;
      document.getElementById('wkpi-base-kmh').textContent = `${Math.round(res.base.speed * 3.6)} km/h`;

      const sign = res.deltaMs > 0.05 ? '+' : '';
      const dEl = document.getElementById('wkpi-delta');
      dEl.textContent = `${sign}${res.deltaMs.toFixed(1)} m/s`;
      dEl.style.color = res.deltaMs > 0.5 ? '#fb7185' : res.deltaMs < -0.5 ? '#38bdf8' : '#cbd5e1';
      document.getElementById('wkpi-delta-pct').textContent =
        Math.abs(res.deltaPct) > 0.5 ? `${res.deltaPct > 0 ? '+' : ''}${Math.round(res.deltaPct)}% vs base` : 'No change';

      const lb = document.getElementById('wlawson-base');
      lb.textContent = res.lawsonBase.label;
      lb.style.background = res.lawsonBase.color;
      const lp = document.getElementById('wlawson-prop');
      lp.textContent = res.lawsonProp.label;
      lp.style.background = res.lawsonProp.color;

      document.getElementById('wprobe-k').textContent = `${res.speedupK.toFixed(2)}×`;
      document.getElementById('wprobe-dw').textContent =
        res.prop.downwash > 0.2 ? `${res.prop.downwash.toFixed(1)} m/s ↓` : `${Math.abs(res.prop.downwash).toFixed(1)} m/s ↑`;

      renderVerticalProfileSVG(res);
    }

    function updateWindHUD() {
      const comp = global.WindTunnelEngine.dirToCompass(wState.dirDeg);
      document.getElementById('wind-dir-slider').value = String(Math.round(wState.dirDeg));
      document.getElementById('wind-dir-val').textContent = `${Math.round(wState.dirDeg)}° ${comp}`;
      document.getElementById('wind-speed-slider').value = String(wState.refSpeedMs);
      document.getElementById('wind-speed-val').textContent = `${wState.refSpeedMs.toFixed(1)} m/s (${Math.round(wState.refSpeedMs * 3.6)} km/h)`;

      document.getElementById('whud-dir').textContent = `${Math.round(wState.dirDeg)}° ${comp} · ${wState.presetLabel}`;
      document.getElementById('whud-ref').textContent = `${wState.refSpeedMs.toFixed(1)} m/s · ${Math.round(wState.refSpeedMs * 3.6)} km/h`;

      const appSt = getAppState();
      const active = appSt.proposedEnabled && appSt.proposedHeight > 0;
      document.getElementById('whud-tower').textContent = active
        ? `${document.getElementById('tower-storeys').textContent}st · ${appSt.proposedHeight.toFixed(1)}m`
        : 'OFF (Baseline)';

      if (wState.lastMetrics) {
        const st = wState.lastMetrics.stats;
        document.getElementById('whud-peak').textContent =
          `${st.maxPropSpeed.toFixed(1)} m/s (Δ +${st.maxDelta.toFixed(1)})`;
        document.getElementById('wsum-max').textContent = `${st.maxPropSpeed.toFixed(1)} m/s (${Math.round(st.maxPropSpeed * 3.6)} km/h)`;
        document.getElementById('wsum-delta').textContent = `+${st.maxDelta.toFixed(1)} m/s (K=${st.maxK.toFixed(2)}×)`;
        document.getElementById('wsum-dw').textContent = `${st.maxDownwash.toFixed(1)} m/s ↓`;
        document.getElementById('wsum-area8').textContent = `${st.areaOver8Base.toLocaleString()} → ${st.areaOver8Prop.toLocaleString()} m²`;
        document.getElementById('wsum-area15').textContent = `${st.areaOver15Base.toLocaleString()} → ${st.areaOver15Prop.toLocaleString()} m²`;
        document.getElementById('wind-solve-ms').textContent = st.solveMs > 0 ? `${st.solveMs} ms` : 'cached';
      }
      renderWindRoseSVG();
    }

    let solveTimer = null;
    function scheduleSolve(immediate = false) {
      if (!wState.active) return;
      const run = () => {
        const statusEl = document.getElementById('wind-solve-status');
        statusEl.textContent = 'Solving 3D Navier-Stokes…';
        // Defer 1 frame so status text paints before GPU/CPU solve
        requestAnimationFrame(() => {
          wState.lastMetrics = windEngine.computePedestrianMetrics(wState.dirDeg, wState.refSpeedMs);
          statusEl.textContent = windEngine.backend;
          rebuildWindArrows();
          paintPedestrianHeatmap();
          updateVerticalSlice();
          updateProbeUI();
          updateWindHUD();
        });
      };
      clearTimeout(solveTimer);
      if (immediate) run();
      else solveTimer = setTimeout(run, 140);
    }

    // ==================== STREAMLINE ANIMATION TICK ====================
    function stepParticles(dt) {
      if (!wState.active || !wState.showParticles || !wState.lastMetrics) {
        streamLines.visible = false;
        return;
      }
      streamLines.visible = true;
      const field = wState.lastMetrics.prop;
      const maxSpd = Math.max(14, wState.refSpeedMs * 1.25);
      // Visual advection speed scaled smoothly so streamlines are easy to read at any wind speed
      const advDt = Math.min(0.05, dt) * 1.35;
      const tailScale = 0.24;

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        let x = pPos[i * 3];
        let y = pPos[i * 3 + 1];
        let z = pPos[i * 3 + 2];
        pAge[i] += advDt;

        const v = windEngine.sampleVelocity(field, x, y, z, wState.refSpeedMs);
        if (pAge[i] > pMaxAge[i] || !v.inDomain || v.isSolid || v.speed < 0.25) {
          seedParticle(i, false);
          continue;
        }

        const nx = x + v.ux * advDt;
        const ny = y + v.uy * advDt;
        const nz = z + v.uz * advDt;

        // Check bounds & terrain clearance
        if (
          nx <= windEngine.minX + 2 || nx >= windEngine.maxX - 2 ||
          nz <= windEngine.minZ + 2 || nz >= windEngine.maxZ - 2 ||
          ny >= windEngine.domainH - 2
        ) {
          seedParticle(i, false);
          continue;
        }
        const gy = shadingEngine.sampleDem(nx, nz);
        const clampedY = Math.max(gy + 0.8, ny);

        pPos[i * 3] = nx;
        pPos[i * 3 + 1] = clampedY;
        pPos[i * 3 + 2] = nz;

        // Line segment from tail -> head
        const tx = nx - v.ux * tailScale;
        const ty = Math.max(gy + 0.6, clampedY - v.uy * tailScale);
        const tz = nz - v.uz * tailScale;

        const k6 = i * 6;
        linePos[k6] = tx; linePos[k6 + 1] = ty; linePos[k6 + 2] = tz;
        linePos[k6 + 3] = nx; linePos[k6 + 4] = clampedY; linePos[k6 + 5] = nz;

        // Color by speed (or highlight vivid cyan-violet when strong downwash plunging downward!)
        let r, g, b;
        if (v.downwash > Math.max(2.2, wState.refSpeedMs * 0.14)) {
          r = 0.82; g = 0.35; b = 0.98;
        } else {
          [r, g, b] = speedToRGB01(v.speed, maxSpd);
        }
        // Fade tail dimmer than head for directional flow feel
        lineCol[k6] = r * 0.35; lineCol[k6 + 1] = g * 0.35; lineCol[k6 + 2] = b * 0.45;
        lineCol[k6 + 3] = r; lineCol[k6 + 4] = g; lineCol[k6 + 5] = b;
      }

      streamGeo.attributes.position.needsUpdate = true;
      streamGeo.attributes.color.needsUpdate = true;
    }

    // ==================== POPULATE UI CONTROLS ====================
    function populatePresets() {
      const grid = document.getElementById('wind-preset-grid');
      if (!grid || !windClimate || !windClimate.presets) return;
      grid.innerHTML = '';

      for (const pr of windClimate.presets) {
        const btn = document.createElement('button');
        btn.className = `wind-preset-btn ${pr.category === 'extreme' ? 'extreme' : ''} ${pr.id === wState.presetId ? 'active' : ''}`;
        btn.dataset.wpreset = pr.id;
        btn.title = `${pr.label} (${pr.date}): Mean ${pr.meanMs} m/s, Gust ${pr.gustMs} m/s from ${pr.dirDeg}° ${pr.dir} — ${pr.source}`;
        btn.innerHTML = pr.shortLabel.replace('\n', '<br/>');
        btn.addEventListener('click', () => {
          wState.presetId = pr.id;
          wState.presetLabel = pr.label;
          wState.dirDeg = pr.dirDeg;
          wState.refSpeedMs = pr.defaultSpeedMs;
          document.querySelectorAll('.wind-preset-btn').forEach((b) => b.classList.toggle('active', b === btn));
          document.getElementById('wind-preset-note').innerHTML =
            `<strong>${pr.label}</strong> (${pr.date}) · Mean ${pr.meanMs} m/s, Gust ${pr.gustMs} m/s.<br/>${pr.note}`;
          resetAllParticles();
          scheduleSolve(true);
        });
        grid.appendChild(btn);
      }

      const activePr = windClimate.presets.find((p) => p.id === wState.presetId) || windClimate.presets[0];
      if (activePr) {
        document.getElementById('wind-preset-note').innerHTML =
          `<strong>${activePr.label}</strong> (${activePr.date}) · Mean ${activePr.meanMs} m/s, Gust ${activePr.gustMs} m/s.<br/>${activePr.note}`;
      }
    }

    function populateQuickProbes() {
      const wrap = document.getElementById('wind-quick-probes');
      if (!wrap) return;
      wrap.innerHTML = '';
      for (const kp of windEngine.keyProbes) {
        const btn = document.createElement('button');
        btn.className = `pill-btn ${kp.id === wState.probe.id ? 'active-cyan' : ''}`;
        btn.dataset.probeid = kp.id;
        btn.textContent = kp.label;
        btn.addEventListener('click', () => {
          const activeP = shadingEngine.proposedPrism;
          const y = kp.isRooftop && activeP && activeP.terraceY ? activeP.terraceY + 1.5 : kp.y;
          wState.probe = { ...kp, y };
          document.querySelectorAll('[data-probeid]').forEach((b) => b.classList.toggle('active-cyan', b === btn));
          updateProbeUI();
          flyTo([kp.x + 120, Math.max(85, y + 65), kp.z + 110], [kp.x, Math.max(12, y), kp.z], 650);
        });
        wrap.appendChild(btn);
      }
    }

    // ==================== EVENT BINDINGS ====================
    document.getElementById('wind-backend-badge').textContent = windEngine.gpuSolver.ok ? 'WebGL2 GPU' : 'CPU 3D';

    // Mode switcher buttons
    function setAppMode(mode) {
      const isWind = mode === 'wind';
      wState.active = isWind;
      windGroup.visible = isWind;

      document.getElementById('mode-btn-solar').classList.toggle('active-solar', !isWind);
      document.getElementById('mode-btn-wind').classList.toggle('active-wind', isWind);
      document.getElementById('sun-hud-pill').style.display = isWind ? 'none' : 'flex';
      document.getElementById('wind-hud-pill').style.display = isWind ? 'flex' : 'none';

      document.getElementById('solar-datetime-card').style.display = isWind ? 'none' : 'flex';
      document.getElementById('wind-left-controls').style.display = isWind ? 'flex' : 'none';
      document.getElementById('left-panel-title').textContent = isWind
        ? '3D Wind Tunnel & Scenarios'
        : 'Solar & Scenario Controls';

      document.getElementById('right-solar-pane').style.display = isWind ? 'none' : 'flex';
      document.getElementById('right-wind-pane').style.display = isWind ? 'flex' : 'none';
      document.getElementById('right-panel-title').textContent = isWind
        ? 'Wind Tunnel Inspector'
        : 'Surface Shading Simulator';

      document.getElementById('hint-click-action').innerHTML = isWind
        ? '<kbd>Click</kbd> Street or Rooftop to Drop 3D Wind Probe'
        : '<kbd>Click</kbd> Any Wall or Roof to Simulate % Shaded';

      if (onModeChange) onModeChange(mode);

      if (isWind) {
        resetAllParticles();
        scheduleSolve(true);
      }
    }

    document.querySelectorAll('[data-appmode]').forEach((btn) => {
      btn.addEventListener('click', () => setAppMode(btn.dataset.appmode));
    });

    // Wind right-panel tabs
    document.querySelectorAll('[data-wtab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.wtab;
        document.querySelectorAll('[data-wtab]').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('#right-wind-pane .tab-pane').forEach((p) => {
          p.classList.toggle('active', p.id === `wtab-${name}`);
        });
      });
    });

    // Click on Wind Rose SVG to set wind direction
    document.getElementById('wind-rose-svg').addEventListener('click', (e) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      wState.dirDeg = Math.round(deg);
      wState.presetId = null;
      wState.presetLabel = 'Custom Rose';
      document.querySelectorAll('.wind-preset-btn').forEach((b) => b.classList.remove('active'));
      resetAllParticles();
      updateWindHUD();
      scheduleSolve(false);
    });

    // Wind direction slider
    document.getElementById('wind-dir-slider').addEventListener('input', (e) => {
      wState.dirDeg = Number(e.target.value);
      wState.presetId = null;
      wState.presetLabel = 'Custom';
      document.querySelectorAll('.wind-preset-btn').forEach((b) => b.classList.remove('active'));
      updateWindHUD();
      scheduleSolve(false);
    });

    // Wind speed slider (INSTANT linear scaling — zero CFD re-solve!)
    document.getElementById('wind-speed-slider').addEventListener('input', (e) => {
      wState.refSpeedMs = Number(e.target.value);
      if (wState.lastMetrics) {
        wState.lastMetrics = windEngine.computePedestrianMetrics(wState.dirDeg, wState.refSpeedMs);
        paintPedestrianHeatmap();
        updateVerticalSlice();
        updateProbeUI();
      }
      updateWindHUD();
    });

    // Pedestrian map mode pills
    document.querySelectorAll('[data-windmap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        wState.mapMode = btn.dataset.windmap;
        document.querySelectorAll('[data-windmap]').forEach((b) => b.classList.toggle('active-cyan', b === btn));
        paintPedestrianHeatmap();
        updateVerticalSlice();
      });
    });

    // Layer toggles
    document.getElementById('toggle-wind-map').addEventListener('change', (e) => {
      wState.showMap = e.target.checked;
      heatMesh.visible = wState.active && wState.showMap && !!wState.lastMetrics;
    });
    document.getElementById('toggle-wind-particles').addEventListener('change', (e) => {
      wState.showParticles = e.target.checked;
      streamLines.visible = wState.active && wState.showParticles;
    });
    document.getElementById('toggle-wind-slice').addEventListener('change', (e) => {
      wState.showSlice = e.target.checked;
      document.getElementById('wind-slice-controls').style.display = wState.showSlice ? 'flex' : 'none';
      updateVerticalSlice();
    });
    document.getElementById('wind-slice-slider').addEventListener('input', (e) => {
      wState.sliceOffset = Number(e.target.value);
      document.getElementById('wind-slice-val').textContent = `${wState.sliceOffset} m`;
      updateVerticalSlice();
    });

    // Online historical date replay (Open-Meteo Archive)
    document.getElementById('btn-fetch-hist-wind').addEventListener('click', async () => {
      const dateVal = document.getElementById('wind-hist-date').value;
      const hourVal = document.getElementById('wind-hist-hour').value;
      if (!dateVal) return;
      const statusEl = document.getElementById('wind-solve-status');
      statusEl.textContent = `Fetching ${dateVal} ${hourVal}:00…`;
      try {
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=-27.4752&longitude=153.0026&start_date=${dateVal}&end_date=${dateVal}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=Australia%2FBrisbane`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const hrIdx = Math.min(23, Math.max(0, parseInt(hourVal, 10) || 12));
        const ws = j.hourly.wind_speed_10m[hrIdx];
        const wd = j.hourly.wind_direction_10m[hrIdx];
        const wg = j.hourly.wind_gusts_10m[hrIdx] ?? ws;
        if (ws == null || wd == null) throw new Error('No data for date');

        wState.dirDeg = Math.round(wd);
        wState.refSpeedMs = Math.max(3, Math.round(wg * 10) / 10);
        wState.presetId = null;
        wState.presetLabel = `${dateVal} ${hourVal}h`;
        document.querySelectorAll('.wind-preset-btn').forEach((b) => b.classList.remove('active'));
        document.getElementById('wind-preset-note').innerHTML =
          `<strong>Historical Replay: ${dateVal} ${hourVal}:00 AEST</strong><br/>Mean: ${ws.toFixed(1)} m/s · Peak Gust: <strong>${wg.toFixed(1)} m/s</strong> (${Math.round(wg * 3.6)} km/h) from ${Math.round(wd)}° ${global.WindTunnelEngine.dirToCompass(wd)}.`;
        resetAllParticles();
        scheduleSolve(true);
      } catch (err) {
        statusEl.textContent = `Fetch error (offline?): ${err.message}`;
      }
    });

    // 8-Direction CFD × 10-Year Brisbane Climate Edge-Case Scanner
    document.getElementById('btn-run-wind-scan').addEventListener('click', async () => {
      if (wState.scanning) return;
      wState.scanning = true;
      const btn = document.getElementById('btn-run-wind-scan');
      const progWrap = document.getElementById('wind-scan-progress');
      const progFill = document.getElementById('wind-scan-fill');
      const msgEl = document.getElementById('wind-scan-msg');
      btn.disabled = true;
      progWrap.style.display = 'block';
      progFill.style.width = '5%';
      msgEl.textContent = 'Starting 8-direction 3D CFD sweep…';

      try {
        const res = await windEngine.runWindRoseAnalysis((done, total, msg) => {
          progFill.style.width = `${Math.round((done / total) * 100)}%`;
          msgEl.textContent = `${msg} (${done}/${total})`;
        });

        // Render discovered edge cases
        const edgeCard = document.getElementById('wind-edge-card');
        const edgeList = document.getElementById('wind-edge-list');
        edgeCard.style.display = 'flex';
        edgeList.innerHTML = '';

        for (const ec of res.edgeCases.slice(0, 7)) {
          const item = document.createElement('div');
          item.className = 'wind-edge-item';
          item.innerHTML = `
            <div class="wind-edge-top">
              <span>${ec.time.slice(0, 10)} · ${ec.dirDeg}° ${ec.dir}</span>
              <span style="color:#fb7185; font-family:var(--mono)">Δ +${ec.estDeltaGust} m/s</span>
            </div>
            <div class="wind-edge-sub">
              <span>${ec.src} (${ec.gustMs} m/s gust)</span>
              <span>Site Peak: ${ec.estSitePeakGust} m/s (${ec.maxSiteK}×)</span>
            </div>
          `;
          item.addEventListener('click', () => {
            wState.dirDeg = ec.dirDeg;
            wState.refSpeedMs = Math.min(44, ec.gustMs);
            wState.presetId = null;
            wState.presetLabel = `${ec.time.slice(0, 10)} Storm`;
            document.querySelectorAll('.wind-preset-btn').forEach((b) => b.classList.remove('active'));
            document.getElementById('wind-preset-note').innerHTML =
              `<strong>Edge Case: ${ec.time.replace('T', ' ')} AEST</strong> (${ec.src})<br/>Regional gust ${ec.gustMs} m/s from ${ec.dirDeg}° ${ec.dir} → est. site peak ${ec.estSitePeakGust} m/s (Δ +${ec.estDeltaGust} m/s from 355 Coro).`;
            resetAllParticles();
            scheduleSolve(true);
            // Switch back to probe tab to inspect
            document.querySelector('[data-wtab="probe"]').click();
          });
          edgeList.appendChild(item);
        }

        // Render Condition 30 Annual Lawson Table
        const c30Card = document.getElementById('wind-cond30-card');
        const c30Body = document.getElementById('wind-cond30-body');
        c30Card.style.display = 'flex';
        c30Body.innerHTML = '';

        for (const pa of res.probeAnnual) {
          const tr = document.createElement('tr');
          const d4 = pa.pctOver4Prop - pa.pctOver4Base;
          const d8 = pa.pctOver8Prop - pa.pctOver8Base;
          tr.style.cursor = 'pointer';
          tr.innerHTML = `
            <td style="font-size:10px">${pa.label.replace(' (RL 78.4m)', '')}</td>
            <td style="font-family:var(--mono); font-size:10px; color:${d4 > 0.3 ? '#fb7185' : 'inherit'}">${pa.pctOver4Base}→${pa.pctOver4Prop}%</td>
            <td style="font-family:var(--mono); font-size:10px; color:${d8 > 0.05 ? '#fb7185' : 'inherit'}">${pa.pctOver8Base}→${pa.pctOver8Prop}%</td>
            <td style="font-family:var(--mono); font-size:9.5px">${pa.worstDir.split(' ')[0]}</td>
          `;
          tr.addEventListener('click', () => {
            wState.probe = { id: pa.id, label: pa.label, x: pa.x, y: pa.y, z: pa.z, isRooftop: pa.isRooftop };
            updateProbeUI();
            document.querySelector('[data-wtab="probe"]').click();
          });
          c30Body.appendChild(tr);
        }

        msgEl.textContent = `Done — ${res.edgeCases.length} historical storms scored across 8 CFD directions.`;
      } finally {
        btn.disabled = false;
        wState.scanning = false;
      }
    });

    populatePresets();
    populateQuickProbes();
    renderWindRoseSVG();
    updateLegendUI();

    return {
      isActive: () => wState.active,
      setMode: setAppMode,
      onProposedChanged: () => {
        if (wState.active) scheduleSolve(false);
      },
      onSceneClick: (point3D, hitProposed) => {
        if (!wState.active) return false;
        const { x, y, z } = point3D;
        if (x < windEngine.minX || x > windEngine.maxX || z < windEngine.minZ || z > windEngine.maxZ) {
          return false;
        }
        const gy = shadingEngine.sampleDem(x, z);
        const isRoof = hitProposed && y > gy + 10;
        wState.probe = {
          id: 'custom',
          label: isRoof ? `355 Coro Roof / Terrace` : `Custom Street Point`,
          x,
          y: isRoof ? y + 1.5 : gy + 1.5,
          z,
          isRooftop: isRoof
        };
        document.querySelectorAll('[data-probeid]').forEach((b) => b.classList.remove('active-cyan'));
        updateProbeUI();
        return true;
      },
      animate: (dt) => {
        stepParticles(dt);
      },
      windEngine
    };
  };
})(window);
