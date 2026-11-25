/**
 * High-Speed 3D Geometric Ray-Traced Solar Shading Engine
 * Uses 2D Spatial Grid DDA + Exact Polygonal Prism Ray Intersection + LiDAR Terrain Occlusion.
 * Computes exact % shaded for any building wall, roof, or whole building, comparing
 * Existing Baseline (with existing buildings on 355 Coro) vs Proposed 355 Coronation Drive Tower.
 */
(function (global) {
  const CELL_SIZE = 40;

  function pointInRing(x, z, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1];
      const xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function rayHitsPrism(ox, oy, oz, dx, dy, dz, prism, maxT) {
    // 1. Fast 3D AABB slab test
    let tmin = 0.02;
    let tmax = maxT;

    if (Math.abs(dx) > 1e-9) {
      let tx1 = (prism.minX - ox) / dx;
      let tx2 = (prism.maxX - ox) / dx;
      if (tx1 > tx2) { const tmp = tx1; tx1 = tx2; tx2 = tmp; }
      if (tx1 > tmin) tmin = tx1;
      if (tx2 < tmax) tmax = tx2;
      if (tmin > tmax) return false;
    } else if (ox < prism.minX || ox > prism.maxX) {
      return false;
    }

    if (Math.abs(dz) > 1e-9) {
      let tz1 = (prism.minZ - oz) / dz;
      let tz2 = (prism.maxZ - oz) / dz;
      if (tz1 > tz2) { const tmp = tz1; tz1 = tz2; tz2 = tmp; }
      if (tz1 > tmin) tmin = tz1;
      if (tz2 < tmax) tmax = tz2;
      if (tmin > tmax) return false;
    } else if (oz < prism.minZ || oz > prism.maxZ) {
      return false;
    }

    // Y slab (dy > 0 always for daylight rays)
    if (dy > 1e-9) {
      let ty1 = (prism.yMin - oy) / dy;
      let ty2 = (prism.yTop - oy) / dy;
      if (ty1 > tmin) tmin = ty1;
      if (ty2 < tmax) tmax = ty2;
      if (tmin > tmax) return false;
    } else if (oy < prism.yMin || oy > prism.yTop) {
      return false;
    }

    // 2. Exact 2D ray vs polygon wall edges
    const ring = prism.r;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p1 = ring[i];
      const p2 = ring[(i + 1) % n];
      const ex = p2[0] - p1[0];
      const ez = p2[1] - p1[1];
      const det = dx * ez - dz * ex;
      if (Math.abs(det) < 1e-9) continue;
      const rx = p1[0] - ox;
      const rz = p1[1] - oz;
      const t = (rx * ez - rz * ex) / det;
      if (t <= 0.03 || t > maxT) continue;
      const u = (rx * dz - rz * dx) / det;
      if (u >= -1e-5 && u <= 1 + 1e-5) {
        const hitY = oy + t * dy;
        if (hitY >= prism.yMin && hitY <= prism.yTop) {
          return true;
        }
      }
    }

    // 3. Check entry through bottom face (rare slope case where oy < prism.yMin)
    if (oy < prism.yMin && dy > 1e-6) {
      const tBot = (prism.yMin - oy) / dy;
      if (tBot > 0.03 && tBot <= maxT) {
        if (pointInRing(ox + tBot * dx, oz + tBot * dz, ring)) return true;
      }
    }

    // 4. Check if ray passes through roof (e.g. origin directly under prism)
    if (oy < prism.yTop && dy > 1e-6) {
      const tTop = (prism.yTop - oy) / dy;
      if (tTop > 0.03 && tTop <= maxT) {
        if (pointInRing(ox + tTop * dx, oz + tTop * dz, ring)) return true;
      }
    }

    return false;
  }

  class ShadingEngine {
    constructor(sceneData) {
      this.meta = sceneData.meta;
      this.dem = sceneData.dem;
      this.halfW = this.meta.widthM / 2;
      this.halfD = this.meta.depthM / 2;
      this.widthM = this.meta.widthM;
      this.depthM = this.meta.depthM;

      // Precompute max DEM elevation
      let maxDem = 0;
      const dv = this.dem.v;
      const sc = this.dem.scale;
      for (let i = 0; i < dv.length; i++) {
        const e = dv[i] * sc;
        if (e > maxDem) maxDem = e;
      }
      this.maxDemY = maxDem;

      // Prepare existing building prisms
      this.prisms = [];
      this.byId = new Map();
      let maxTop = maxDem;

      for (let i = 0; i < sceneData.buildings.length; i++) {
        const b = sceneData.buildings[i];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [x, z] of b.r) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        const yTop = b.g + b.h;
        if (yTop > maxTop) maxTop = yTop;
        const prism = {
          idx: i,
          id: b.id,
          addr: b.addr,
          suburb: b.suburb,
          h: b.h,
          g: b.g,
          gMin: b.gMin,
          yMin: b.gMin - 3.0,
          yTop,
          area: b.area,
          cx: b.cx,
          cz: b.cz,
          r: b.r,
          minX, maxX, minZ, maxZ,
          onSite355: !!b.onSite355,
          isProposed: false
        };
        this.prisms.push(prism);
        this.byId.set(prism.id, prism);
      }

      this.maxExistingTopY = maxTop;

      // Build 2D spatial acceleration grid
      this.gridCols = Math.ceil(this.widthM / CELL_SIZE);
      this.gridRows = Math.ceil(this.depthM / CELL_SIZE);
      this.grid = new Array(this.gridCols * this.gridRows);
      for (let i = 0; i < this.grid.length; i++) this.grid[i] = [];

      for (const p of this.prisms) {
        const c0 = Math.max(0, Math.floor((p.minX + this.halfW) / CELL_SIZE));
        const c1 = Math.min(this.gridCols - 1, Math.floor((p.maxX + this.halfW) / CELL_SIZE));
        const r0 = Math.max(0, Math.floor((p.minZ + this.halfD) / CELL_SIZE));
        const r1 = Math.min(this.gridRows - 1, Math.floor((p.maxZ + this.halfD) / CELL_SIZE));
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            this.grid[r * this.gridCols + c].push(p);
          }
        }
      }

      this.visitStamp = new Int32Array(this.prisms.length);
      this.stampCounter = 0;

      // Proposed 355 Coronation Dr multi-tier DA prisms (Podium, Tower Shaft, Rooftop Pavilion)
      this.proposedConfig = sceneData.proposed;
      this.proposedPrism = null;
      this.proposedPrisms = [];
      this.setProposedConfig({
        enabled: true,
        height: sceneData.proposed.approvedHeight,
        siteCoverPct: 60
      });
    }

    setProposedConfig({ enabled, height, siteCoverPct }) {
      if (!enabled || height <= 0) {
        this.proposedPrism = null;
        this.proposedPrisms = [];
        this.maxSceneTopY = this.maxExistingTopY;
        return;
      }
      const cfg = this.proposedConfig;
      const [ux, uz] = cfg.uAxis;
      const [vx, vz] = cfg.vAxis;
      const origin = cfg.originCorner || [
        cfg.cx - 22.8 * ux - 15.1 * vx,
        cfg.cz - 22.8 * uz - 15.1 * vz
      ];
      const oX = origin[0];
      const oZ = origin[1];

      const uvToXZ = (u, v) => [
        Math.round((oX + u * ux + v * vx) * 100) / 100,
        Math.round((oZ + u * uz + v * vz) * 100) / 100
      ];

      const makeRoundedRectUV = (u0, u1, v0, v1, radii, segs) => {
        const maxR = Math.max(0.1, Math.min((u1 - u0) * 0.45, (v1 - v0) * 0.45));
        const r = radii.map((val) => Math.min(val, maxR));
        const corners = [
          { cu: u0 + r[0], cv: v0 + r[0], rad: r[0], a0: Math.PI, a1: 1.5 * Math.PI },
          { cu: u1 - r[1], cv: v0 + r[1], rad: r[1], a0: 1.5 * Math.PI, a1: 2.0 * Math.PI },
          { cu: u1 - r[2], cv: v1 - r[2], rad: r[2], a0: 0, a1: 0.5 * Math.PI },
          { cu: u0 + r[3], cv: v1 - r[3], rad: r[3], a0: 0.5 * Math.PI, a1: Math.PI }
        ];
        const pts = [];
        for (const c of corners) {
          for (let i = 0; i <= segs; i++) {
            const a = c.a0 + (c.a1 - c.a0) * (i / segs);
            pts.push(uvToXZ(c.cu + Math.cos(a) * c.rad, c.cv + Math.sin(a) * c.rad));
          }
        }
        // Ensure CCW in top-down (signed area in x,z < 0)
        let sa = 0;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          sa += a[0] * b[1] - b[0] * a[1];
        }
        if (sa > 0) pts.reverse();
        return { ring: pts, area: Math.round(Math.abs(sa) / 2) };
      };

      const makeTierPrism = (tierKey, tierLabel, ringObj, yMin, yTop, sampleYMin, hasSoffit) => {
        const ring = ringObj.ring;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        let sumX = 0, sumZ = 0;
        for (const [x, z] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          sumX += x;
          sumZ += z;
        }
        const n = ring.length || 1;
        return {
          idx: -1,
          id: `${cfg.id}:${tierKey}`,
          tierKey,
          tierLabel,
          addr: `${cfg.addr} — ${tierLabel}`,
          shortAddr: cfg.addr,
          suburb: 'Auchenflower',
          h: Math.round((yTop - sampleYMin) * 10) / 10,
          totalH: Math.round(height * 10) / 10,
          g: sampleYMin,
          gMin: sampleYMin,
          yMin,
          yTop: Math.round(yTop * 100) / 100,
          sampleYMin,
          area: ringObj.area,
          cx: sumX / n,
          cz: sumZ / n,
          r: ring,
          minX, maxX, minZ, maxZ,
          hasSoffit: !!hasSoffit,
          onSite355: false,
          isProposed: true
        };
      };

      // Approved DA A006954430 Rev B exact RLs & 3-tier geometry on 1,430 m2 site:
      // Ground FFL = RL 7.20 m | Podium Top (L02) = RL 18.50 m | Roof Terrace = RL 78.35 m | Roof = RL 83.60 m
      const groundFFL = cfg.groundFFL !== undefined ? cfg.groundFFL : 7.2;
      const podiumBaseH = cfg.podiumHeight !== undefined ? cfg.podiumHeight : 11.3;
      const maxPavilionH = cfg.pavilionHeight !== undefined ? cfg.pavilionHeight : 5.25;

      const crownY = groundFFL + height;
      const podiumTopY = Math.min(crownY, groundFFL + podiumBaseH);
      const pavilionH = height > 18.0 ? Math.min(maxPavilionH, (height - 18.0) * 0.25) : 0;
      const terraceY = crownY - pavilionH;

      // Scale floorplate cleanly around DA approved 60% site cover (858 m2 = 38.0m x 22.8m rounded)
      const s = Math.sqrt(Math.max(0.25, siteCoverPct) / 60);
      const rs = Math.min(1.0, s);
      const uC = 22.8;
      const vC = 15.1;

      const towerLenU = Math.min(41.6, 38.0 * s);
      const towerLenV = Math.min(26.6, 22.8 * s);
      const tu0 = uC - towerLenU / 2;
      const tu1 = uC + towerLenU / 2;
      const tv0 = vC - towerLenV / 2;
      const tv1 = vC + towerLenV / 2;

      const tiers = [];

      // Tier 1: Podium (Ground RL 7.20 -> Level 02 RL 18.50, pulled back on NE Lang Parade over lobby/driveway)
      const podU0 = tu0 + 0.7 * rs;
      const podU1 = tu1 - 0.9 * rs;
      const podV0 = tv0 + 0.8 * rs;
      const podV1 = Math.max(podV0 + 8.0, tv1 - 4.0 * rs);
      const podiumPoly = makeRoundedRectUV(podU0, podU1, podV0, podV1, [1.6 * rs, 1.6 * rs, 2.4 * rs, 1.6 * rs], 2);
      const podiumOnly = terraceY <= podiumTopY + 0.2;
      const podiumPrism = makeTierPrism(
        'podium',
        podiumOnly ? `Podium (RL ${groundFFL.toFixed(1)}–${crownY.toFixed(1)}m)` : `Podium Ground–L01 (RL ${groundFFL.toFixed(1)}–${podiumTopY.toFixed(1)}m)`,
        podiumPoly,
        cfg.gMin - 3.0,
        podiumOnly ? crownY : podiumTopY,
        cfg.gMin,
        false
      );
      tiers.push(podiumPrism);

      // Tier 2: Main Residential Tower Shaft (Level 02 RL 18.50 -> Roof Terrace RL 78.35)
      let towerPrism = null;
      if (!podiumOnly) {
        const towerPoly = makeRoundedRectUV(tu0, tu1, tv0, tv1, [2.4 * rs, 2.4 * rs, 3.8 * rs, 2.4 * rs], 3);
        towerPrism = makeTierPrism(
          'tower',
          `Residential Tower L02–Terrace (RL ${podiumTopY.toFixed(1)}–${terraceY.toFixed(2)}m)`,
          towerPoly,
          podiumTopY,
          terraceY,
          podiumTopY,
          true
        );
        tiers.push(towerPrism);
      }

      // Tier 3: Recessed Rooftop Pavilion (SW half of Roof Terrace: RL 78.35 -> Roof RL 83.60)
      let pavilionPrism = null;
      let poolRing = null;
      if (pavilionH > 0.2 && towerPrism) {
        const pavHalfU = Math.min(towerLenU * 0.42, 14.0 * s);
        const pu0 = uC - pavHalfU;
        const pu1 = uC + pavHalfU;
        const pv0 = tv0 + 1.8 * rs;
        const pv1 = pv0 + Math.min(towerLenV * 0.50, 11.0 * s);
        const pavPoly = makeRoundedRectUV(pu0, pu1, pv0, pv1, [1.5 * rs, 1.5 * rs, 1.5 * rs, 1.5 * rs], 2);
        pavilionPrism = makeTierPrism(
          'pavilion',
          `Rooftop Pavilion (RL ${terraceY.toFixed(2)}–${crownY.toFixed(2)}m)`,
          pavPoly,
          terraceY,
          crownY,
          terraceY,
          false
        );
        tiers.push(pavilionPrism);

        // Visual-only 25m lap pool outline on open NE (Lang Parade) half of Roof Terrace
        const poolU0 = Math.max(tu0 + 4.0, uC - 12.5 * Math.min(1, s));
        const poolU1 = Math.min(tu1 - 4.0, uC + 12.5 * Math.min(1, s));
        const poolV0 = pv1 + 1.8 * rs;
        const poolV1 = tv1 - 2.3 * rs;
        if (poolV1 > poolV0 + 1.5 && poolU1 > poolU0 + 4.0) {
          poolRing = [
            uvToXZ(poolU0, poolV0),
            uvToXZ(poolU1, poolV0),
            uvToXZ(poolU1, poolV1),
            uvToXZ(poolU0, poolV1)
          ];
        }
      }

      this.proposedPrisms = tiers;
      const primary = towerPrism || podiumPrism;
      primary.groundFFL = groundFFL;
      primary.crownY = Math.round(crownY * 100) / 100;
      primary.terraceY = Math.round(terraceY * 100) / 100;
      primary.podiumTopY = Math.round(podiumTopY * 100) / 100;
      primary.pavilionH = Math.round(pavilionH * 100) / 100;
      primary.towerArea = towerPrism ? towerPrism.area : podiumPrism.area;
      primary.podiumArea = podiumPrism.area;
      primary.pavilionArea = pavilionPrism ? pavilionPrism.area : 0;
      primary.poolRing = poolRing;
      primary.tiers = tiers;

      this.proposedPrism = primary;
      this.maxSceneTopY = Math.max(this.maxExistingTopY, crownY);
    }

    sampleDem(x, z) {
      const u = Math.max(0, Math.min(1, (x + this.halfW) / this.widthM));
      const v = Math.max(0, Math.min(1, (z + this.halfD) / this.depthM));
      const gx = u * (this.dem.w - 1);
      const gz = v * (this.dem.h - 1);
      const x0 = Math.floor(gx);
      const z0 = Math.floor(gz);
      const x1 = Math.min(this.dem.w - 1, x0 + 1);
      const z1 = Math.min(this.dem.h - 1, z0 + 1);
      const fx = gx - x0;
      const fz = gz - z0;
      const dv = this.dem.v;
      const w = this.dem.w;
      const e00 = dv[z0 * w + x0];
      const e10 = dv[z0 * w + x1];
      const e01 = dv[z1 * w + x0];
      const e11 = dv[z1 * w + x1];
      return ((e00 * (1 - fx) + e10 * fx) * (1 - fz) + (e01 * (1 - fx) + e11 * fx) * fz) * this.dem.scale;
    }

    /**
     * Cast a ray toward the sun.
     * Returns bitmask:
     *   bit 1 (1): hitExistingOther (existing building not on 355 site, or terrain hill)
     *   bit 2 (2): hitExistingOnSite (one of the 2 old buildings currently on 355 Coro / 6 Lang Pde)
     *   bit 4 (4): hitProposed (proposed 355 Coro tower)
     */
    traceRay(ox, oy, oz, dx, dy, dz, ignorePrismIdx) {
      if (dy <= 0.004) return 1; // Below horizon

      const maxT = Math.min(2200, (this.maxSceneTopY - oy + 1.0) / dy);
      if (maxT <= 0.05) return 0;

      let mask = 0;

      // 1. Test Proposed 355 Coro multi-tier prisms first (Podium, Tower Shaft, Rooftop Pavilion)
      if (this.proposedPrisms && this.proposedPrisms.length > 0 && ignorePrismIdx !== -1) {
        for (let i = 0; i < this.proposedPrisms.length; i++) {
          if (rayHitsPrism(ox, oy, oz, dx, dy, dz, this.proposedPrisms[i], maxT)) {
            mask |= 4;
            break;
          }
        }
      }

      // 2. 2D DDA grid traversal for existing buildings
      const stamp = ++this.stampCounter;
      const startX = (ox + this.halfW) / CELL_SIZE;
      const startZ = (oz + this.halfD) / CELL_SIZE;
      let col = Math.floor(startX);
      let row = Math.floor(startZ);

      const stepCol = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      const stepRow = dz > 0 ? 1 : dz < 0 ? -1 : 0;

      const tDeltaX = Math.abs(dx) > 1e-9 ? Math.abs(CELL_SIZE / dx) : 1e12;
      const tDeltaZ = Math.abs(dz) > 1e-9 ? Math.abs(CELL_SIZE / dz) : 1e12;

      let tMaxX =
        dx > 1e-9
          ? ((col + 1) * CELL_SIZE - (ox + this.halfW)) / dx
          : dx < -1e-9
          ? (col * CELL_SIZE - (ox + this.halfW)) / dx
          : 1e12;

      let tMaxZ =
        dz > 1e-9
          ? ((row + 1) * CELL_SIZE - (oz + this.halfD)) / dz
          : dz < -1e-9
          ? (row * CELL_SIZE - (oz + this.halfD)) / dz
          : 1e12;

      let tCurrent = 0;
      const cols = this.gridCols;
      const rows = this.gridRows;

      while (tCurrent <= maxT) {
        if (col >= 0 && col < cols && row >= 0 && row < rows) {
          const cell = this.grid[row * cols + col];
          for (let i = 0; i < cell.length; i++) {
            const p = cell[i];
            if (p.idx === ignorePrismIdx) continue;
            if (this.visitStamp[p.idx] === stamp) continue;
            this.visitStamp[p.idx] = stamp;

            // Quick height cull
            if (p.yTop <= oy + tCurrent * dy) continue;

            if (rayHitsPrism(ox, oy, oz, dx, dy, dz, p, maxT)) {
              if (p.onSite355) {
                mask |= 2;
              } else {
                mask |= 1;
                // Once hitExistingOther is true, baseline AND proposed are both shaded -> early exit!
                return mask;
              }
            }
          }
        } else {
          // If outside grid and heading away, break
          if ((col < 0 && stepCol <= 0) || (col >= cols && stepCol >= 0) || (row < 0 && stepRow <= 0) || (row >= rows && stepRow >= 0)) {
            break;
          }
        }

        if (tMaxX < tMaxZ) {
          tCurrent = tMaxX;
          tMaxX += tDeltaX;
          col += stepCol;
        } else {
          tCurrent = tMaxZ;
          tMaxZ += tDeltaZ;
          row += stepRow;
        }
      }

      // 3. Terrain ridge/hill occlusion (important for low winter sun behind Dunmore Terrace cliff!)
      if (!(mask & 1) && oy < this.maxDemY && dy < 0.5) {
        const terrainMaxT = Math.min(maxT, (this.maxDemY - oy + 0.5) / dy);
        for (let t = 14; t <= terrainMaxT; t += 14) {
          const px = ox + t * dx;
          const pz = oz + t * dz;
          if (px < -this.halfW || px > this.halfW || pz < -this.halfD || pz > this.halfD) break;
          const py = oy + t * dy;
          if (this.sampleDem(px, pz) > py + 0.45) {
            mask |= 1;
            break;
          }
        }
      }

      return mask;
    }

    /**
     * Get list of exterior surfaces (roof + walls >= 1.5m wide) for a prism.
     */
    getBuildingSurfaces(prism) {
      const surfaces = [];
      // Roof
      surfaces.push({
        type: 'roof',
        edgeIdx: -1,
        label: 'Roof Surface',
        compass: 'Horizontal',
        azimuthDeg: null,
        normal: [0, 1, 0],
        width: null,
        height: null,
        area: prism.area
      });

      // Walls
      const ring = prism.r;
      const n = ring.length;
      const minWallLen = prism.isProposed ? 3.0 : 1.0;
      const wallBase = prism.sampleYMin !== undefined ? prism.sampleYMin : prism.gMin;
      const surfH = prism.sampleYMin !== undefined ? Math.max(0.5, prism.yTop - wallBase) : prism.h;
      for (let i = 0; i < n; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % n];
        const dx = p2[0] - p1[0];
        const dz = p2[1] - p1[1];
        const len = Math.hypot(dx, dz);
        if (len < minWallLen) continue;
        // Outward normal for CCW top-down ring: (-dz/len, 0, dx/len)
        const nx = -dz / len;
        const nz = dx / len;
        // Azimuth clockwise from North (-Z): atan2(nx, -nz)
        let az = (Math.atan2(nx, -nz) * 180) / Math.PI;
        if (az < 0) az += 360;
        const compass = global.SolarCalc.azimuthToCompass(az);
        const area = Math.round(len * surfH);
        surfaces.push({
          type: 'wall',
          edgeIdx: i,
          p1,
          p2,
          label: `${compass} Wall (${Math.round(az)}°)`,
          compass,
          azimuthDeg: Math.round(az),
          normal: [nx, 0, nz],
          width: Math.round(len * 10) / 10,
          height: Math.round(surfH * 10) / 10,
          area
        });
      }
      return surfaces;
    }

    /**
     * Generate uniform sample points on a chosen surface ('wall', 'roof', or 'whole').
     */
    buildSurfaceSamples(prism, surfaceSpec, targetSamples = 220) {
      const samples = [];
      const pushWallSamples = (edgeIdx, nTarget) => {
        const ring = prism.r;
        const p1 = ring[edgeIdx];
        const p2 = ring[(edgeIdx + 1) % ring.length];
        const dx = p2[0] - p1[0];
        const dz = p2[1] - p1[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.5) return;
        const nx = -dz / len;
        const nz = dx / len;
        const wallBase = prism.sampleYMin !== undefined ? prism.sampleYMin : prism.gMin;
        const wallH = prism.yTop - wallBase;
        if (wallH <= 0.1) return;
        const area = len * wallH;
        const step = Math.max(0.6, Math.min(4.0, Math.sqrt(area / Math.max(16, nTarget))));
        const cols = Math.max(2, Math.round(len / step));
        const rows = Math.max(2, Math.round(wallH / step));
        const cellW = len / cols;
        const cellH = wallH / rows;
        const cellArea = cellW * cellH;

        for (let c = 0; c < cols; c++) {
          const u = (c + 0.5) / cols;
          const bx = p1[0] + dx * u;
          const bz = p1[1] + dz * u;
          const groundHere = this.sampleDem(bx, bz);
          const ox = bx + nx * 0.08;
          const oz = bz + nz * 0.08;
          for (let r = 0; r < rows; r++) {
            const oy = wallBase + (r + 0.5) * cellH;
            if (oy < groundHere + 0.15) continue; // Below local terrain slope
            if (oy > prism.yTop - 0.05) continue;
            samples.push({
              x: ox,
              y: oy,
              z: oz,
              nx,
              ny: 0,
              nz,
              w: cellArea,
              cellW,
              cellH,
              ux: dx / len,
              uz: dz / len,
              isRoof: false
            });
          }
        }
      };

      const pushRoofSamples = (nTarget) => {
        const boxW = prism.maxX - prism.minX;
        const boxD = prism.maxZ - prism.minZ;
        const step = Math.max(0.75, Math.min(5.0, Math.sqrt(prism.area / Math.max(20, nTarget))));
        const cols = Math.max(2, Math.ceil(boxW / step));
        const rows = Math.max(2, Math.ceil(boxD / step));
        const cw = boxW / cols;
        const cd = boxD / rows;
        const cellArea = cw * cd;
        const oy = prism.yTop + 0.08;

        for (let r = 0; r < rows; r++) {
          const oz = prism.minZ + (r + 0.5) * cd;
          for (let c = 0; c < cols; c++) {
            const ox = prism.minX + (c + 0.5) * cw;
            if (!pointInRing(ox, oz, prism.r)) continue;
            samples.push({
              x: ox,
              y: oy,
              z: oz,
              nx: 0,
              ny: 1,
              nz: 0,
              w: cellArea,
              cellW: cw,
              cellH: cd,
              ux: 1,
              uz: 0,
              isRoof: true
            });
          }
        }
        // Fallback if very narrow polygon missed grid centers
        if (samples.length === 0) {
          samples.push({
            x: prism.cx,
            y: oy,
            z: prism.cz,
            nx: 0,
            ny: 1,
            nz: 0,
            w: prism.area,
            cellW: 2,
            cellH: 2,
            ux: 1,
            uz: 0,
            isRoof: true
          });
        }
      };

      if (surfaceSpec.type === 'wall') {
        pushWallSamples(surfaceSpec.edgeIdx, targetSamples);
      } else if (surfaceSpec.type === 'roof') {
        pushRoofSamples(targetSamples);
      } else {
        // Whole building: distribute samples proportionally by area across roof + all walls
        const surfaces = this.getBuildingSurfaces(prism);
        const totalArea = surfaces.reduce((acc, s) => acc + s.area, 0) || 1;
        for (const s of surfaces) {
          const share = Math.max(6, Math.round((s.area / totalArea) * targetSamples));
          if (s.type === 'roof') pushRoofSamples(share);
          else pushWallSamples(s.edgeIdx, share);
        }
      }

      return samples;
    }

    /**
     * Evaluate shading at a single sun direction for a set of surface samples.
     * Returns detailed breakdown + per-sample status codes for 3D heatmap rendering:
     *   0 = Sunlit
     *   1 = Self-shaded (facing away from sun)
     *   2 = Shaded by existing buildings/terrain
     *   3 = Newly shaded by Proposed 355 Coro Tower
     */
    evaluateSurfaceAtSun(prism, samples, sunPos) {
      const n = samples.length;
      const states = new Uint8Array(n);
      let totalW = 0;
      let baseShadedW = 0;
      let propShadedW = 0;
      let newShade355W = 0;
      let selfShadedW = 0;
      let sunlitPropW = 0;

      const proposedActive = !!this.proposedPrism && !prism.isProposed;

      if (!sunPos.isDay) {
        states.fill(1);
        for (let i = 0; i < n; i++) totalW += samples[i].w;
        return {
          totalArea: totalW,
          baselineShadedPct: 100,
          proposedShadedPct: 100,
          deltaPct: 0,
          selfShadedPct: 100,
          sunlitPct: 0,
          newShadeAreaM2: 0,
          states
        };
      }

      const [sx, sy, sz] = sunPos.dir;

      for (let i = 0; i < n; i++) {
        const s = samples[i];
        totalW += s.w;

        // Check incidence angle (dot product with outward surface normal)
        const dot = s.nx * sx + s.ny * sy + s.nz * sz;
        if (dot <= 0.005) {
          states[i] = 1; // Self-shaded
          selfShadedW += s.w;
          baseShadedW += s.w;
          propShadedW += s.w;
          continue;
        }

        const mask = this.traceRay(s.x, s.y, s.z, sx, sy, sz, prism.idx);
        const hitOther = (mask & 1) !== 0;
        const hitOld355 = (mask & 2) !== 0;
        const hitProp355 = (mask & 4) !== 0;

        const baseShaded = hitOther || hitOld355;
        const propShaded = proposedActive ? (hitOther || hitProp355) : baseShaded;

        if (baseShaded) baseShadedW += s.w;
        if (propShaded) propShadedW += s.w;

        if (!baseShaded && propShaded) {
          states[i] = 3; // Newly shaded by 355 Coro!
          newShade355W += s.w;
        } else if (propShaded) {
          states[i] = 2; // Shaded by existing context
        } else {
          states[i] = 0; // Direct sunlight
          sunlitPropW += s.w;
        }
      }

      const denom = totalW || 1;
      const baselineShadedPct = (baseShadedW / denom) * 100;
      const proposedShadedPct = (propShadedW / denom) * 100;

      return {
        totalArea: totalW,
        baselineShadedPct,
        proposedShadedPct,
        deltaPct: proposedShadedPct - baselineShadedPct,
        selfShadedPct: (selfShadedW / denom) * 100,
        sunlitPct: (sunlitPropW / denom) * 100,
        newShadeAreaM2: newShade355W,
        states
      };
    }

    /**
     * Compute full daylight shading profile (every 15 min) for a surface on a given date.
     */
    computeDailyProfile(prism, samples, year, month, day, stepMin = 15) {
      const { centerLat, centerLon, timezoneOffsetHours } = this.meta;
      const dayInfo = global.SolarCalc.getDaySummary(year, month, day, centerLat, centerLon, timezoneOffsetHours);

      const startM = Math.max(300, Math.floor(dayInfo.sunriseMin / stepMin) * stepMin);
      const endM = Math.min(1140, Math.ceil(dayInfo.sunsetMin / stepMin) * stepMin);

      // Subsample slightly if huge to keep full-day curve under ~40ms
      const stride = samples.length > 180 ? 2 : 1;
      const subSamples = stride === 1 ? samples : samples.filter((_, i) => i % stride === 0);

      const points = [];
      let sumBaseDay = 0, sumPropDay = 0, cntDay = 0;
      let sumBase9to3 = 0, sumProp9to3 = 0, cnt9to3 = 0;
      let sunlitHoursLost = 0;
      let sunlitHoursLost9to3 = 0;
      let peakDelta = 0;
      let peakDeltaMin = 720;

      for (let m = startM; m <= endM; m += stepMin) {
        const sunPos = global.SolarCalc.getSunPosition(year, month, day, m, centerLat, centerLon, timezoneOffsetHours);
        const res = this.evaluateSurfaceAtSun(prism, subSamples, sunPos);
        points.push({
          min: m,
          basePct: res.baselineShadedPct,
          propPct: res.proposedShadedPct,
          deltaPct: res.deltaPct,
          altDeg: sunPos.altitudeDeg,
          isDay: sunPos.isDay
        });

        if (sunPos.isDay) {
          sumBaseDay += res.baselineShadedPct;
          sumPropDay += res.proposedShadedPct;
          cntDay++;
          if (res.deltaPct > 0) {
            sunlitHoursLost += (res.deltaPct / 100) * (stepMin / 60);
          }
          if (res.deltaPct > peakDelta) {
            peakDelta = res.deltaPct;
            peakDeltaMin = m;
          }
          if (m >= 540 && m <= 900) {
            // 9:00 AM - 3:00 PM statutory Brisbane solar assessment window
            sumBase9to3 += res.baselineShadedPct;
            sumProp9to3 += res.proposedShadedPct;
            cnt9to3++;
            if (res.deltaPct > 0) {
              sunlitHoursLost9to3 += (res.deltaPct / 100) * (stepMin / 60);
            }
          }
        }
      }

      return {
        dayInfo,
        points,
        avgBaseDay: cntDay ? sumBaseDay / cntDay : 100,
        avgPropDay: cntDay ? sumPropDay / cntDay : 100,
        avgDeltaDay: cntDay ? (sumPropDay - sumBaseDay) / cntDay : 0,
        avgBase9to3: cnt9to3 ? sumBase9to3 / cnt9to3 : 100,
        avgProp9to3: cnt9to3 ? sumProp9to3 / cnt9to3 : 100,
        avgDelta9to3: cnt9to3 ? (sumProp9to3 - sumBase9to3) / cnt9to3 : 0,
        sunlitHoursLost,
        sunlitHoursLost9to3,
        peakDelta,
        peakDeltaMin
      };
    }

    /**
     * Fast scan of all neighbouring buildings within radiusM of 355 Coronation Drive
     * across 9am-3pm (30-min steps) on the given date, plus instantaneous impact at currentMin.
     */
    scanImpactedBuildings(year, month, day, currentMin, radiusM = 380) {
      if (!this.proposedPrism) return [];
      const { centerLat, centerLon, timezoneOffsetHours } = this.meta;
      const pcx = this.proposedPrism.cx;
      const pcz = this.proposedPrism.cz;

      // Precompute sun positions for 8am-4pm (every 30 min) + currentMin
      const times = [];
      for (let m = 480; m <= 960; m += 30) {
        times.push({
          min: m,
          in9to3: m >= 540 && m <= 900,
          sun: global.SolarCalc.getSunPosition(year, month, day, m, centerLat, centerLon, timezoneOffsetHours)
        });
      }
      const curSun = global.SolarCalc.getSunPosition(year, month, day, currentMin, centerLat, centerLon, timezoneOffsetHours);

      const results = [];

      for (const p of this.prisms) {
        if (p.onSite355) continue;
        const dist = Math.hypot(p.cx - pcx, p.cz - pcz);
        if (dist > radiusM) continue;

        // Fast representative points: roof + walls facing roughly toward 355 Coro or sun
        const samples = this.buildSurfaceSamples(p, { type: 'whole' }, 36);
        if (samples.length === 0) continue;

        // First test if ANY ray from this building can even hit 355 Coro during the day
        let peakDelta = 0;
        let peakMin = 720;
        let sumDelta9to3 = 0;
        let cnt9to3 = 0;

        for (const t of times) {
          if (!t.sun.isDay) continue;
          const res = this.evaluateSurfaceAtSun(p, samples, t.sun);
          if (res.deltaPct > peakDelta) {
            peakDelta = res.deltaPct;
            peakMin = t.min;
          }
          if (t.in9to3) {
            sumDelta9to3 += Math.max(0, res.deltaPct);
            cnt9to3++;
          }
        }

        const curRes = this.evaluateSurfaceAtSun(p, samples, curSun);
        const avgDelta9to3 = cnt9to3 ? sumDelta9to3 / cnt9to3 : 0;

        if (peakDelta >= 1.5 || curRes.deltaPct >= 1.5) {
          results.push({
            id: p.id,
            addr: p.addr,
            h: p.h,
            g: p.g,
            dist: Math.round(dist),
            curDeltaPct: Math.max(0, curRes.deltaPct),
            curPropPct: curRes.proposedShadedPct,
            curBasePct: curRes.baselineShadedPct,
            peakDeltaPct: peakDelta,
            peakMin,
            avgDelta9to3
          });
        }
      }

      results.sort((a, b) => b.avgDelta9to3 - a.avgDelta9to3 || b.peakDeltaPct - a.peakDeltaPct);
      return results;
    }
  }

  global.ShadingEngine = ShadingEngine;
})(window);
