import fs from 'fs';
import path from 'path';

const BBOX = [152.99485990, -27.48253927, 153.01241521, -27.46893391];
const [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX] = BBOX;
const LON0 = (LON_MIN + LON_MAX) / 2;
const LAT0 = (LAT_MIN + LAT_MAX) / 2;

// WGS84 local metric scale at -27.4757 deg
const M_PER_DEG_LAT = 110808.5;
const M_PER_DEG_LON = 111319.49 * Math.cos((LAT0 * Math.PI) / 180);

// Right-handed Three.js Y-up: +X = East, +Y = Up (m AHD), -Z = North (+Z = South)
function lonLatToXZ(lon, lat) {
  const x = (lon - LON0) * M_PER_DEG_LON;
  const z = -(lat - LAT0) * M_PER_DEG_LAT;
  return [x, z];
}

const PB_BASE = 'https://services2.arcgis.com/dEKgZETqwmDAh1rP/arcgis/rest/services/Prop_Boundaries/FeatureServer';

async function fetchAllArcGIS(layerUrl, outFields, extraParams = {}) {
  const features = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const params = new URLSearchParams({
      geometry: BBOX.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields,
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: 'json',
      ...extraParams
    });
    const res = await fetch(`${layerUrl}/query?${params.toString()}`);
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`ArcGIS error: ${JSON.stringify(json.error)}`);
    const batch = json.features || [];
    features.push(...batch);
    console.log(`  fetched ${batch.length} (total ${features.length})`);
    if (!json.exceededTransferLimit || batch.length === 0) break;
    offset += batch.length;
  }
  return features;
}

function parseTiffF32(buf) {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifdOff = u32(4);
  const numEntries = u16(ifdOff);
  const tags = {};
  for (let i = 0; i < numEntries; i++) {
    const off = ifdOff + 2 + i * 12;
    const tag = u16(off);
    const type = u16(off + 2);
    const count = u32(off + 4);
    const valOff = off + 8;
    let val;
    if (count === 1 && (type === 3 || type === 4)) {
      val = type === 3 ? u16(valOff) : u32(valOff);
    } else {
      const ptr = u32(valOff);
      const arr = [];
      for (let k = 0; k < count; k++) {
        if (type === 3) arr.push(u16(ptr + k * 2));
        else if (type === 4) arr.push(u32(ptr + k * 4));
      }
      val = arr;
    }
    tags[tag] = { type, count, val };
  }
  const w = tags[256].val;
  const h = tags[257].val;
  const out = new Float32Array(w * h);
  if (tags[322] && tags[324]) {
    const tw = tags[322].val;
    const th = tags[323].val;
    const tileOffsets = Array.isArray(tags[324].val) ? tags[324].val : [tags[324].val];
    const tilesAcross = Math.ceil(w / tw);
    const tilesDown = Math.ceil(h / th);
    let tIdx = 0;
    for (let ty = 0; ty < tilesDown; ty++) {
      for (let tx = 0; tx < tilesAcross; tx++) {
        const off = tileOffsets[tIdx++];
        for (let r = 0; r < th; r++) {
          const y = ty * th + r;
          if (y >= h) continue;
          for (let c = 0; c < tw; c++) {
            const x = tx * tw + c;
            if (x >= w) continue;
            const p = off + (r * tw + c) * 4;
            out[y * w + x] = le ? buf.readFloatLE(p) : buf.readFloatBE(p);
          }
        }
      }
    }
  } else {
    const offsets = Array.isArray(tags[273].val) ? tags[273].val : [tags[273].val];
    const counts = Array.isArray(tags[279].val) ? tags[279].val : [tags[279].val];
    let idx = 0;
    for (let s = 0; s < offsets.length; s++) {
      const start = offsets[s];
      const nFloats = counts[s] / 4;
      for (let k = 0; k < nFloats && idx < out.length; k++) {
        out[idx++] = le ? buf.readFloatLE(start + k * 4) : buf.readFloatBE(start + k * 4);
      }
    }
  }
  return { w, h, data: out };
}

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

function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[(i + 1) % ring.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

function cleanRingXZ(lonLatRing) {
  if (!lonLatRing || lonLatRing.length < 3) return null;
  let pts = lonLatRing.map(([lon, lat]) => lonLatToXZ(lon, lat));
  // Remove closing duplicate if present
  if (pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05) pts.pop();
  }
  // Remove consecutive near-duplicates
  const dedup = [];
  for (const p of pts) {
    if (dedup.length === 0 || Math.hypot(p[0] - dedup[dedup.length - 1][0], p[1] - dedup[dedup.length - 1][1]) > 0.15) {
      dedup.push(p);
    }
  }
  if (dedup.length < 3) return null;
  // Ensure consistent orientation: positive signed area in (x, z) -> CW when looking down -Y, or CCW
  // Let's make signed area in (x, z) NEGATIVE (CCW when looking down from +Y, i.e., x right, -z up)
  // Wait: in (x, -z) standard math plane, CCW means sum(x1*(-z2) - x2*(-z1)) > 0 => sum(x1*z2 - x2*z1) < 0!
  // Let's check outward normal for edge p1 -> p2 with CCW in top-down view:
  // If p1=(0,0) -> p2=(1,0) -> p3=(1,-1) -> p4=(0,-1) (square going East then North = CCW looking down from +Y):
  // area = (0*0 - 1*0) + (1*(-1) - 1*0) + (1*(-1) - 0*(-1)) + (0*0 - 0*(-1)) = -2 < 0!
  // Edge p1->p2 = (1, 0), outward normal (to South, +Z) = (0, +1) = (-dz, dx)!
  // Let's verify edge p2->p3 = (0, -1): (-dz, dx) = (+1, 0) = East (+X)! YES!
  // Edge p3->p4 = (-1, 0): (-dz, dx) = (0, -1) = North (-Z)! YES!
  // Edge p4->p1 = (0, +1): (-dz, dx) = (-1, 0) = West (-X)! YES!
  if (ringSignedArea(dedup) > 0) dedup.reverse();
  const area = Math.abs(ringSignedArea(dedup));
  if (area < 4) return null;
  return dedup.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]);
}

function titleCase(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatAddress(attrs) {
  const num = attrs.UNIT_HOUSE_NUMBER || (attrs.HOUSE_NUMBER ? String(attrs.HOUSE_NUMBER) : '');
  const street = [attrs.CORRIDOR_NAME, attrs.CORRIDOR_SUFFIX_CODE].filter(Boolean).join(' ');
  const suburb = attrs.SUBURB || '';
  if (!street) return titleCase(attrs.PROPERTY_NAME_1 || attrs.FEAT_NAME || suburb || 'Building');
  const main = [num, titleCase(street)].filter(Boolean).join(' ');
  return suburb ? `${main}, ${titleCase(suburb)}` : main;
}

// Compute inset polygon for a convex/nearly-convex quadrilateral parcel (for 355 Coro tower footprint)
function scalePolygonAroundCentroid(ring, scaleX, scaleY, uAxis, vAxis) {
  let cx = 0, cz = 0;
  for (const [x, z] of ring) { cx += x; cz += z; }
  cx /= ring.length; cz /= ring.length;
  return ring.map(([x, z]) => {
    const dx = x - cx, dz = z - cz;
    const u = dx * uAxis[0] + dz * uAxis[1];
    const v = dx * vAxis[0] + dz * vAxis[1];
    const nu = u * scaleX;
    const nv = v * scaleY;
    return [
      Math.round((cx + nu * uAxis[0] + nv * vAxis[0]) * 100) / 100,
      Math.round((cz + nu * uAxis[1] + nv * vAxis[1]) * 100) / 100
    ];
  });
}

async function main() {
  fs.mkdirSync('c:/Scratch/dev3d/data', { recursive: true });

  // 1. Fetch DEM (200 x 174 = ~8.7m resolution across 1734m x 1508m)
  console.log('1. Fetching QLD 0.5m LiDAR DEM grid (200x174)...');
  const demW = 200, demH = 174;
  const demUrl = `https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer/exportImage?bbox=${BBOX.join(',')}&bboxSR=4326&imageSR=4326&size=${demW},${demH}&format=tiff&pixelType=F32&noData=-9999&f=image`;
  const demBuf = Buffer.from(await (await fetch(demUrl)).arrayBuffer());
  const dem = parseTiffF32(demBuf);

  // Clean noData and record min/max; also clamp underwater riverbed cleanly while keeping true dry land
  const demClean = new Float32Array(dem.w * dem.h);
  for (let i = 0; i < dem.data.length; i++) {
    let v = dem.data[i];
    if (!Number.isFinite(v) || v < -50 || v > 400) v = 0.5;
    // Clamp deep river channel to 0.2m so terrain looks smooth at water surface
    if (v < 0.2) v = 0.2;
    demClean[i] = Math.round(v * 10) / 10;
  }

  const widthM = (LON_MAX - LON_MIN) * M_PER_DEG_LON;
  const depthM = (LAT_MAX - LAT_MIN) * M_PER_DEG_LAT;
  const halfW = widthM / 2;
  const halfD = depthM / 2;

  function sampleDemXZ(x, z) {
    const u = Math.max(0, Math.min(1, (x + halfW) / widthM));
    const v = Math.max(0, Math.min(1, (z + halfD) / depthM));
    const gx = u * (dem.w - 1);
    const gz = v * (dem.h - 1);
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const x1 = Math.min(dem.w - 1, x0 + 1), z1 = Math.min(dem.h - 1, z0 + 1);
    const fx = gx - x0, fz = gz - z0;
    const e00 = demClean[z0 * dem.w + x0];
    const e10 = demClean[z0 * dem.w + x1];
    const e01 = demClean[z1 * dem.w + x0];
    const e11 = demClean[z1 * dem.w + x1];
    return (e00 * (1 - fx) + e10 * fx) * (1 - fz) + (e01 * (1 - fx) + e11 * fx) * fz;
  }

  console.log(`  Region size: ${widthM.toFixed(1)}m (E-W) x ${depthM.toFixed(1)}m (N-S)`);

  // 2. Fetch all Property Holdings (Layer 2) for real street addresses & 355 Coro / 6 Lang parcels
  console.log('2. Fetching BCC Property Holdings (Layer 2) for street addresses...');
  const parcelsRaw = await fetchAllArcGIS(
    `${PB_BASE}/2`,
    'OBJECTID,UNIT_HOUSE_NUMBER,HOUSE_NUMBER,CORRIDOR_NAME,CORRIDOR_SUFFIX_CODE,SUBURB,PROPERTY_NAME_1,LAND_USE,Shape__Area'
  );

  // Build spatial grid of parcels for fast point-in-polygon lookup
  const parcels = [];
  let parcel355 = null;
  let parcel6Lang = null;
  for (const f of parcelsRaw) {
    const ring0 = f.geometry?.rings?.[0];
    if (!ring0 || ring0.length < 3) continue;
    const ring = ring0.map(([lon, lat]) => lonLatToXZ(lon, lat));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const addr = formatAddress(f.attributes);
    const pObj = {
      id: f.attributes.OBJECTID,
      address: addr,
      suburb: titleCase(f.attributes.SUBURB || ''),
      street: titleCase([f.attributes.CORRIDOR_NAME, f.attributes.CORRIDOR_SUFFIX_CODE].filter(Boolean).join(' ')),
      houseNo: f.attributes.UNIT_HOUSE_NUMBER || (f.attributes.HOUSE_NUMBER ? String(f.attributes.HOUSE_NUMBER) : ''),
      area: Math.round((f.attributes.Shape__Area || 0) * 10) / 10,
      ring,
      minX, maxX, minZ, maxZ
    };
    parcels.push(pObj);
    if (f.attributes.CORRIDOR_NAME === 'CORONATION' && f.attributes.HOUSE_NUMBER === 355) {
      parcel355 = pObj;
    }
    if (f.attributes.CORRIDOR_NAME === 'LANG' && f.attributes.HOUSE_NUMBER === 6 && f.attributes.CORRIDOR_SUFFIX_CODE === 'PDE') {
      parcel6Lang = pObj;
    }
  }
  console.log(`  Parsed ${parcels.length} parcels. Found 355 Coro: ${!!parcel355}, 6 Lang Pde: ${!!parcel6Lang}`);

  // Spatial hash for parcels (50m cells)
  const PCELL = 50;
  const pGrid = new Map();
  for (const p of parcels) {
    const cx0 = Math.floor(p.minX / PCELL), cx1 = Math.floor(p.maxX / PCELL);
    const cz0 = Math.floor(p.minZ / PCELL), cz1 = Math.floor(p.maxZ / PCELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = `${cx},${cz}`;
        if (!pGrid.has(key)) pGrid.set(key, []);
        pGrid.get(key).push(p);
      }
    }
  }

  function findParcel(x, z) {
    const key = `${Math.floor(x / PCELL)},${Math.floor(z / PCELL)}`;
    const list = pGrid.get(key);
    if (list) {
      for (const p of list) {
        if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ) {
          if (pointInRing(x, z, p.ring)) return p;
        }
      }
    }
    return null;
  }

  // 3. Fetch all Building Footprints (Layer 6) with actual BUILDINGHEIGHTM
  console.log('3. Fetching BCC Building Footprints (Layer 6) with actual heights...');
  const bldgsRaw = await fetchAllArcGIS(
    `${PB_BASE}/6`,
    'OBJECTID,BUILDINGHEIGHTM,AREASQM,SURVEYDATE,CONFIDENCE'
  );

  const buildings = [];
  let matchedAddr = 0;
  let onSiteCount = 0;
  for (const f of bldgsRaw) {
    const rings = f.geometry?.rings;
    if (!rings || !rings[0]) continue;
    const ring = cleanRingXZ(rings[0]);
    if (!ring) continue;

    // Centroid & bbox
    let cx = 0, cz = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      cx += x; cz += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    cx /= ring.length;
    cz /= ring.length;

    // Sample ground elevation at centroid & vertices
    let sumG = sampleDemXZ(cx, cz);
    let minG = sumG;
    let maxG = sumG;
    for (const [x, z] of ring) {
      const g = sampleDemXZ(x, z);
      sumG += g;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
    }
    const meanG = sumG / (ring.length + 1);

    // Height
    let h = Number(f.attributes.BUILDINGHEIGHTM);
    if (!Number.isFinite(h) || h < 2.2) h = 3.0;
    h = Math.round(h * 10) / 10;

    // Match address
    const parcel = findParcel(cx, cz);
    if (parcel) matchedAddr++;
    const onSite355 =
      (parcel355 && pointInRing(cx, cz, parcel355.ring)) ||
      (parcel6Lang && pointInRing(cx, cz, parcel6Lang.ring));
    if (onSite355) onSiteCount++;

    buildings.push({
      id: f.attributes.OBJECTID,
      addr: parcel ? parcel.address : 'Brisbane Building',
      suburb: parcel ? parcel.suburb : '',
      h,
      g: Math.round(meanG * 10) / 10,
      gMin: Math.round(minG * 10) / 10,
      area: Math.round(Math.abs(ringSignedArea(ring))),
      cx: Math.round(cx * 10) / 10,
      cz: Math.round(cz * 10) / 10,
      r: ring,
      ...(onSite355 ? { onSite355: true } : {})
    });
  }
  console.log(`  Built ${buildings.length} buildings (${matchedAddr} matched to street addresses, ${onSiteCount} existing on 355 Coro / 6 Lang site)`);

  // 4. Construct EXACT combined parcel & proposed tower footprint for 355 Coronation Dr & 6 Lang Pde
  // Combined parcel vertices (outer boundary of L.16 SP.135237 + L.3 RP.52037)
  // From our exact Layer 2 query:
  // 355 Coro + 6 Lang outer boundary in lon/lat:
  // Corner N (Lang Pde): [153.002502509222, -27.475021254095]
  // Corner E (Lang Pde x Coro Dr corner): [153.002796061733, -27.4752600296685], [153.002813846735, -27.4752855929483], [153.002814844459, -27.4753136004386], [153.002799980912, -27.4753382985881]
  // Corner S (Coro Dr): [153.002633341961, -27.4754963781766]
  // Corner W (Rear boundary w/ Dunmore Ter): [153.002295248587, -27.4752213538472]
  const combinedSiteLonLat = [
    [153.002502509222, -27.475021254095],
    [153.002796061733, -27.4752600296685],
    [153.002813846735, -27.4752855929483],
    [153.002814844459, -27.4753136004386],
    [153.002799980912, -27.4753382985881],
    [153.002633341961, -27.4754963781766],
    [153.002295248587, -27.4752213538472]
  ];
  const combinedSiteRing = cleanRingXZ(combinedSiteLonLat);
  const siteAreaM2 = Math.round(Math.abs(ringSignedArea(combinedSiteRing)));

  // Compute exact orthonormal parcel axes aligned to SW & NW survey boundaries:
  // SW boundary: siteParcel[0] (W corner) -> siteParcel[1] (S corner), pointing NW -> SE along Lang Pde / SW edge
  const pW = combinedSiteRing[0];
  const pS = combinedSiteRing[1];
  const pN = combinedSiteRing[combinedSiteRing.length - 1];
  const uVec = [pS[0] - pW[0], pS[1] - pW[1]];
  const uLen = Math.hypot(uVec[0], uVec[1]);
  const uAxis = [uVec[0] / uLen, uVec[1] / uLen];

  // Perpendicular axis V pointing SW -> NE (toward Lang Parade)
  let vAxis = [uAxis[1], -uAxis[0]];
  const nwVec = [pN[0] - pW[0], pN[1] - pW[1]];
  const vLen = Math.hypot(nwVec[0], nwVec[1]);
  if (nwVec[0] * vAxis[0] + nwVec[1] * vAxis[1] < 0) {
    vAxis = [-vAxis[0], -vAxis[1]];
  }

  // Center of site in (u, v) relative to W corner (parcel is 45.56m along u x 30.18m along v)
  const siteCx = pW[0] + 22.8 * uAxis[0] + 15.1 * vAxis[0];
  const siteCz = pW[1] + 22.8 * uAxis[1] + 15.1 * vAxis[1];

  // Make rectangular tower footprint aligned with parcel axes:
  // Approved DA A006954430 (Rev B, 16/10/2026):
  //   Official DA survey site area: 1,430 m2 (Lot 3 RP52037 & Lot 16 SP135237)
  //   Approved site cover: 59.99% (~858 m2 rounded-corner floorplate, ~38.0m x 22.8m)
  //   Ground FFL: RL 7.20 m AHD (existing NGL avg 6.9 m AHD)
  //   Podium (Ground, Mezz RL 10.70, L01 RL 13.35): RL 7.20 -> RL 18.50 m AHD
  //   Main Tower (L02-L19 + Roof Undercroft RL 75.65): RL 18.50 -> Roof Terrace RL 78.35 m AHD
  //   Recessed Rooftop Pavilion (SW half, cinema/dining/core): RL 78.35 -> Roof RL 83.60 m AHD
  function makeRectRing(cx, cz, halfU, halfV) {
    const corners = [
      [cx - halfU * uAxis[0] - halfV * vAxis[0], cz - halfU * uAxis[1] - halfV * vAxis[1]],
      [cx + halfU * uAxis[0] - halfV * vAxis[0], cz + halfU * uAxis[1] - halfV * vAxis[1]],
      [cx + halfU * uAxis[0] + halfV * vAxis[0], cz + halfU * uAxis[1] + halfV * vAxis[1]],
      [cx - halfU * uAxis[0] + halfV * vAxis[0], cz - halfU * uAxis[1] + halfV * vAxis[1]]
    ];
    if (ringSignedArea(corners) > 0) corners.reverse();
    return corners.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]);
  }

  const proposedGround = Math.round(sampleDemXZ(siteCx, siteCz) * 10) / 10;
  const tower60Ring = makeRectRing(siteCx, siteCz, 19.0, 11.4); // 38.0m x 22.8m (~858 m2 rounded = 60% of 1,430 m2)
  const tower50Ring = makeRectRing(siteCx, siteCz, 17.35, 10.4); // 34.7m x 20.8m (~715 m2 rounded = 50% of 1,430 m2)

  const proposed355 = {
    id: 'proposed-355-coro',
    addr: '355 Coronation Dr & 6 Lang Pde, Auchenflower (Proposed DA A006954430)',
    shortName: '355 Coronation Dr (Proposed)',
    daRef: 'DA A006954430 ("Bloom")',
    g: proposedGround, // Existing NGL from 0.5m QLD LiDAR DEM (~6.9 m AHD)
    groundFFL: 7.2,    // Approved Ground Floor FFL (RL 7.200 m AHD, Sheet DA 02-05 / 03-01)
    gMin: proposedGround - 2,
    cx: Math.round(siteCx * 10) / 10,
    cz: Math.round(siteCz * 10) / 10,
    originCorner: pW,  // SW-W parcel corner in scene (x, z)
    siteParcel: combinedSiteRing,
    siteArea: 1430,    // Official DA survey site area (Lot 3 RP52037 + Lot 16 SP135237)
    parcelAreaGeo: siteAreaM2,
    frontageCoroM: Math.round(vLen * 10) / 10,
    frontageLangM: Math.round(uLen * 10) / 10,
    uAxis,
    vAxis,
    tower60: tower60Ring,
    tower50: tower50Ring,
    // Approved DA A006954430 Rev B exact RLs (m AHD) & heights above Ground FFL RL 7.20 m
    mezzanineRL: 10.7,
    level01RL: 13.35,
    podiumTopRL: 18.5,
    roofUndercroftRL: 75.65,
    roofTerraceRL: 78.35,
    approvedRoofRL: 83.6,
    podiumHeight: 11.3,     // 18.50 - 7.20
    terraceHeight: 71.15,   // 78.35 - 7.20 (main 22-level shaft + roof undercroft)
    pavilionHeight: 5.25,   // 83.60 - 78.35 (recessed rooftop pavilion on SW half)
    typicalFloorH: 3.15,    // Levels 02-19 typical residential floor-to-floor
    approvedHeight: 76.4,   // 83.60 - 7.20 (23 storeys total)
    statutoryHeight: 27.0,  // 8 storeys TANP limit (<1,500 m2 lot)
    hdr2Height: 50.0        // 15 storeys HDR2 zone cap
  };
  console.log('  Proposed 355 Coro:', {
    cx: proposed355.cx,
    cz: proposed355.cz,
    groundAHD: proposed355.g,
    siteAreaM2,
    frontageCoroM: proposed355.frontageCoroM,
    frontageLangM: proposed355.frontageLangM,
    tower60Area: Math.round(Math.abs(ringSignedArea(tower60Ring))),
    tower50Area: Math.round(Math.abs(ringSignedArea(tower50Ring)))
  });

  // 5. Fetch high-res basemap textures (1600x1392 JPEG) and encode as base64 data URIs for offline/file:// compatibility!
  console.log('4. Fetching high-res basemap textures (Light Gray, Streets, Satellite Aerial)...');
  const mapW = 1600, mapH = Math.round(1600 * (depthM / widthM));
  const basemaps = {};
  for (const [key, svc] of [
    ['light', 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/export'],
    ['streets', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/export'],
    ['aerial', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export']
  ]) {
    const url = `${svc}?bbox=${BBOX.join(',')}&bboxSR=4326&imageSR=4326&size=${mapW},${mapH}&format=jpg&f=image`;
    const r = await fetch(url);
    const buf = Buffer.from(await r.arrayBuffer());
    basemaps[key] = 'data:image/jpeg;base64,' + buf.toString('base64');
    console.log(`  Basemap "${key}": ${(buf.length / 1024).toFixed(1)} KB (${mapW}x${mapH})`);
  }

  // 6. Write compact data/scene-data.js and data/basemaps.js
  // Quantize DEM elevations to integers in decimetres (0.1m) for ultra-compact storage!
  const demDm = Array.from(demClean, (v) => Math.round(v * 10));

  const sceneData = {
    meta: {
      bbox: BBOX,
      centerLon: LON0,
      centerLat: LAT0,
      widthM: Math.round(widthM * 10) / 10,
      depthM: Math.round(depthM * 10) / 10,
      mPerDegLon: M_PER_DEG_LON,
      mPerDegLat: M_PER_DEG_LAT,
      timezoneOffsetHours: 10,
      buildingSource: 'Brisbane City Council Nearmap/LiDAR Building Footprints (Prop_Boundaries/FeatureServer/6)',
      demSource: 'Queensland Government 0.5m LiDAR DEM (Elevation/QldDem)',
      generatedAt: new Date().toISOString()
    },
    dem: {
      w: dem.w,
      h: dem.h,
      scale: 0.1,
      v: demDm
    },
    proposed: proposed355,
    buildings
  };

  const sceneJs = 'window.SCENE_DATA = ' + JSON.stringify(sceneData) + ';\n';
  fs.writeFileSync('c:/Scratch/dev3d/data/scene-data.js', sceneJs);
  console.log(`Wrote data/scene-data.js (${(sceneJs.length / 1024 / 1024).toFixed(2)} MB)`);

  const basemapsJs = 'window.BASEMAPS = ' + JSON.stringify(basemaps) + ';\n';
  fs.writeFileSync('c:/Scratch/dev3d/data/basemaps.js', basemapsJs);
  console.log(`Wrote data/basemaps.js (${(basemapsJs.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
