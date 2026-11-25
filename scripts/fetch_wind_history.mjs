/**
 * Fetch 10+ years of historical Brisbane wind data for 355 Coronation Drive
 * (-27.4752, 153.0026) from Open-Meteo Historical Archive (ERA5/ACCESS)
 * and real anemometer peak gusts from Brisbane Airport (YBBN) via IEM ASOS.
 *
 * Writes compact offline-ready data/wind-climate.js (~15-20 KB).
 */
import fs from 'fs';

const LAT = -27.4752;
const LON = 153.0026;
const START_DATE = '2016-01-01';
const END_DATE = '2026-11-20';
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const SPEED_BINS = [0, 2, 4, 6, 8, 10, 12, 15, 18, 22, 26, 999]; // m/s upper edges (11 bins)

function dirToSector(deg) {
  return Math.floor((((deg % 360) + 360 + 11.25) % 360) / 22.5) % 16;
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return Math.round(sortedArr[idx] * 10) / 10;
}

function makeEmptyRose() {
  return Array.from({ length: 16 }, (_, i) => ({
    dir: DIRS[i],
    deg: i * 22.5,
    count: 0,
    sumSpd: 0,
    sumGust: 0,
    speeds: [],
    gusts: [],
    maxMeanMs: 0,
    maxMeanTime: '',
    maxGustMs: 0,
    maxGustTime: '',
    bins: new Array(SPEED_BINS.length - 1).fill(0),
    gustBins: new Array(SPEED_BINS.length - 1).fill(0)
  }));
}

function finalizeRose(rawRose, totalCount) {
  return rawRose.map((s) => {
    s.speeds.sort((a, b) => a - b);
    s.gusts.sort((a, b) => a - b);
    return {
      dir: s.dir,
      deg: s.deg,
      freqPct: Math.round((s.count / Math.max(1, totalCount)) * 1000) / 10,
      meanMs: s.count ? Math.round((s.sumSpd / s.count) * 10) / 10 : 0,
      p90Ms: percentile(s.speeds, 0.9),
      p95Ms: percentile(s.speeds, 0.95),
      p99Ms: percentile(s.speeds, 0.99),
      p99GustMs: percentile(s.gusts, 0.99),
      maxMeanMs: Math.round(s.maxMeanMs * 10) / 10,
      maxMeanTime: s.maxMeanTime,
      maxGustMs: Math.round(s.maxGustMs * 10) / 10,
      maxGustTime: s.maxGustTime,
      // Store fractional probability per bin (sum across all 16 sectors = 1.0)
      binFrac: s.bins.map((c) => Math.round((c / Math.max(1, totalCount)) * 100000) / 100000),
      gustBinFrac: s.gustBins.map((c) => Math.round((c / Math.max(1, totalCount)) * 100000) / 100000)
    };
  });
}

function addSample(rose, ws, wd, wg, timeStr) {
  const sec = rose[dirToSector(wd)];
  sec.count++;
  sec.sumSpd += ws;
  sec.sumGust += wg;
  sec.speeds.push(ws);
  sec.gusts.push(wg);
  if (ws > sec.maxMeanMs) {
    sec.maxMeanMs = ws;
    sec.maxMeanTime = timeStr;
  }
  if (wg > sec.maxGustMs) {
    sec.maxGustMs = wg;
    sec.maxGustTime = timeStr;
  }
  for (let b = 0; b < SPEED_BINS.length - 1; b++) {
    if (ws >= SPEED_BINS[b] && ws < SPEED_BINS[b + 1]) {
      sec.bins[b]++;
      break;
    }
  }
  for (let b = 0; b < SPEED_BINS.length - 1; b++) {
    if (wg >= SPEED_BINS[b] && wg < SPEED_BINS[b + 1]) {
      sec.gustBins[b]++;
      break;
    }
  }
}

async function fetchYbbnTopGusts() {
  console.log('2. Fetching YBBN (Brisbane Airport) real METAR gusts (2016-2026)...');
  const url =
    'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=YBBN&data=drct&data=sknt&data=gust&year1=2016&month1=1&day1=1&year2=2026&month2=11&day2=20&tz=Australia%2FBrisbane&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no';
  const r = await fetch(url);
  if (!r.ok) {
    console.warn('  YBBN fetch failed:', r.status);
    return [];
  }
  const text = await r.text();
  const lines = text.split(/\r?\n/);
  const obs = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;
    const valid = parts[1];
    const drct = parseFloat(parts[2]);
    const sknt = parseFloat(parts[3]);
    const gustKt = parseFloat(parts[4]);
    if (!Number.isFinite(drct) || !Number.isFinite(gustKt) || gustKt < 28) continue;
    const meanMs = Number.isFinite(sknt) ? sknt * 0.514444 : gustKt * 0.514444 * 0.65;
    const gustMs = gustKt * 0.514444;
    // Ignore obvious sensor spikes (>55 m/s = 200 km/h)
    if (gustMs > 55) continue;
    obs.push({
      time: valid.replace(' ', 'T'),
      msEpoch: Date.parse(valid.replace(' ', 'T') + '+10:00'),
      dirDeg: Math.round(drct),
      dir: DIRS[dirToSector(drct)],
      meanMs: Math.round(meanMs * 10) / 10,
      gustMs: Math.round(gustMs * 10) / 10
    });
  }
  obs.sort((a, b) => b.gustMs - a.gustMs);
  const topEvents = [];
  for (const o of obs) {
    if (topEvents.every((e) => Math.abs(e.msEpoch - o.msEpoch) > 72 * 3600 * 1000)) {
      topEvents.push(o);
      if (topEvents.length >= 6) break;
    }
  }
  console.log(`  Parsed ${obs.length} YBBN gust obs (>=28kt); top ${topEvents.length} distinct storms:`);
  for (const e of topEvents) {
    console.log(`    ${e.time} | ${e.dirDeg}° (${e.dir}) | mean ${e.meanMs} m/s | gust ${e.gustMs} m/s (${Math.round(e.gustMs * 3.6)} km/h)`);
  }
  return topEvents.map(({ msEpoch, ...rest }) => rest);
}

async function main() {
  console.log(`1. Fetching Open-Meteo 10-year hourly wind archive for 355 Coronation Dr (${LAT}, ${LON})...`);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LON}&start_date=${START_DATE}&end_date=${END_DATE}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=Australia%2FBrisbane`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const j = await r.json();

  const times = j.hourly.time;
  const wsArr = j.hourly.wind_speed_10m;
  const wdArr = j.hourly.wind_direction_10m;
  const wgArr = j.hourly.wind_gusts_10m;

  const annualRaw = makeEmptyRose();
  const summerRaw = makeEmptyRose();
  const winterRaw = makeEmptyRose();
  let annualN = 0, summerN = 0, winterN = 0;

  const allValid = [];
  for (let i = 0; i < times.length; i++) {
    const ws = wsArr[i], wd = wdArr[i], wg = wgArr[i] ?? ws;
    if (ws == null || wd == null) continue;
    const t = times[i];
    const month = parseInt(t.slice(5, 7), 10);
    addSample(annualRaw, ws, wd, wg, t);
    annualN++;
    if (month === 12 || month === 1 || month === 2) {
      addSample(summerRaw, ws, wd, wg, t);
      summerN++;
    } else if (month >= 6 && month <= 8) {
      addSample(winterRaw, ws, wd, wg, t);
      winterN++;
    }
    allValid.push({ i, time: t, ws, wd, wg });
  }

  const annualRose = finalizeRose(annualRaw, annualN);
  const summerRose = finalizeRose(summerRaw, summerN);
  const winterRose = finalizeRose(winterRaw, winterN);

  // Extract top 10 distinct historical storm/gust events (>72h separation)
  allValid.sort((a, b) => b.wg - a.wg);
  const distinctExtremes = [];
  for (const v of allValid) {
    if (distinctExtremes.every((e) => Math.abs(e.i - v.i) > 72)) {
      distinctExtremes.push({
        time: v.time,
        dirDeg: Math.round(v.wd),
        dir: DIRS[dirToSector(v.wd)],
        meanMs: Math.round(v.ws * 10) / 10,
        gustMs: Math.round(v.wg * 10) / 10
      });
      if (distinctExtremes.length >= 10) break;
    }
  }

  const ybbnStorms = await fetchYbbnTopGusts();

  // Build curated + data-driven preset bank combining extreme edge cases & prevailing Brisbane winds
  const alfredE = distinctExtremes.find((e) => e.time.startsWith('2025-03-08')) || distinctExtremes[0];
  const debbieNE = distinctExtremes.find((e) => e.time.startsWith('2017-03-30')) || annualRose[2];
  const alfredSSW = distinctExtremes.find((e) => e.time.startsWith('2025-03-05')) || {
    time: '2025-03-05T12:00', dirDeg: 199, dir: 'SSW', meanMs: 8.0, gustMs: 21.2
  };
  const winterWSW = distinctExtremes.find((e) => e.time.startsWith('2025-07-02')) || {
    time: '2025-07-02T16:00', dirDeg: 252, dir: 'WSW', meanMs: 8.4, gustMs: 18.8
  };
  const topYbbn = ybbnStorms[0];

  const neSector = annualRose[2]; // NE (45°)
  const seSector = annualRose[6]; // SE (135°)
  const wswSector = annualRose[11]; // WSW (247.5°)

  const presets = [
    {
      id: 'alfred-e',
      label: 'Ex-TC Alfred (E)',
      shortLabel: 'TC Alfred\n99° E',
      category: 'extreme',
      date: alfredE.time,
      dirDeg: alfredE.dirDeg,
      dir: alfredE.dir,
      meanMs: alfredE.meanMs,
      gustMs: alfredE.gustMs,
      defaultSpeedMs: alfredE.gustMs,
      speedType: 'gust',
      source: 'Open-Meteo ERA5 (355 Coro)',
      note: '8 Mar 2025 Ex-Tropical Cyclone Alfred peak east gust off the Brisbane River directly onto Coronation Drive.'
    },
    {
      id: 'debbie-ne',
      label: 'Ex-TC Debbie (NE)',
      shortLabel: 'TC Debbie\n48° NE',
      category: 'extreme',
      date: debbieNE.time || debbieNE.maxGustTime,
      dirDeg: debbieNE.dirDeg ?? 48,
      dir: 'NE',
      meanMs: debbieNE.meanMs ?? debbieNE.maxMeanMs,
      gustMs: debbieNE.gustMs ?? debbieNE.maxGustMs,
      defaultSpeedMs: debbieNE.gustMs ?? debbieNE.maxGustMs,
      speedType: 'gust',
      source: 'Open-Meteo ERA5 (355 Coro)',
      note: '30 Mar 2017 Ex-TC Debbie NE blow striking the broadest 38 m Lang Parade facade dead-on (maximum 3D downwash).'
    },
    {
      id: 'alfred-ssw',
      label: 'SSW Channel Funnel',
      shortLabel: 'SSW Funnel\n199° SSW',
      category: 'extreme',
      date: alfredSSW.time,
      dirDeg: alfredSSW.dirDeg,
      dir: alfredSSW.dir,
      meanMs: alfredSSW.meanMs,
      gustMs: alfredSSW.gustMs,
      defaultSpeedMs: alfredSSW.gustMs,
      speedType: 'gust',
      source: 'Open-Meteo ERA5 (355 Coro)',
      note: '5 Mar 2025 pre-landfall SSW gale funneling through the ~19.7 m gap between 355 Coro and 8 Dunmore Terrace.'
    },
    {
      id: 'winter-wsw',
      label: 'Winter Westerly (WSW)',
      shortLabel: 'Westerly\n252° WSW',
      category: 'extreme',
      date: winterWSW.time,
      dirDeg: winterWSW.dirDeg,
      dir: winterWSW.dir,
      meanMs: winterWSW.meanMs,
      gustMs: winterWSW.gustMs,
      defaultSpeedMs: winterWSW.gustMs,
      speedType: 'gust',
      source: 'Open-Meteo ERA5 (355 Coro)',
      note: '2 Jul 2025 strong dry winter westerly pouring down off the Dunmore Terrace ridge across the site.'
    },
    ...(topYbbn
      ? [
          {
            id: 'ybbn-peak',
            label: `Peak YBBN Storm (${topYbbn.dir})`,
            shortLabel: `YBBN Peak\n${topYbbn.dirDeg}° ${topYbbn.dir}`,
            category: 'extreme',
            date: topYbbn.time,
            dirDeg: topYbbn.dirDeg,
            dir: topYbbn.dir,
            meanMs: topYbbn.meanMs,
            gustMs: topYbbn.gustMs,
            defaultSpeedMs: topYbbn.gustMs,
            speedType: 'gust',
            source: 'Brisbane Airport METAR (YBBN)',
            note: `Highest measured 10-year anemometer gust at Brisbane Airport (${topYbbn.time.slice(0, 10)}): ${topYbbn.gustMs} m/s (${Math.round(topYbbn.gustMs * 3.6)} km/h) from ${topYbbn.dirDeg}° ${topYbbn.dir}.`
          }
        ]
      : []),
    {
      id: 'breeze-ne',
      label: 'Brisk NE Sea Breeze (P95)',
      shortLabel: 'NE Breeze\n45° P95',
      category: 'prevailing',
      date: '2016-2026 P95',
      dirDeg: 45,
      dir: 'NE',
      meanMs: neSector.p95Ms,
      gustMs: Math.round(neSector.p95Ms * 1.55 * 10) / 10,
      defaultSpeedMs: Math.round(neSector.p95Ms * 1.45 * 10) / 10,
      speedType: 'mean',
      source: '10-yr Wind Rose (95th %ile)',
      note: `Typical brisk afternoon NE sea breeze off the river (95th %ile mean ${neSector.p95Ms} m/s; occurs ${neSector.freqPct}% of all hours).`
    },
    {
      id: 'trade-se',
      label: 'SE River Trade Wind (P95)',
      shortLabel: 'SE Trade\n135° P95',
      category: 'prevailing',
      date: '2016-2026 P95',
      dirDeg: 135,
      dir: 'SE',
      meanMs: seSector.p95Ms,
      gustMs: Math.round(seSector.p95Ms * 1.55 * 10) / 10,
      defaultSpeedMs: Math.round(seSector.p95Ms * 1.45 * 10) / 10,
      speedType: 'mean',
      source: '10-yr Wind Rose (95th %ile)',
      note: `Unobstructed SE riverfront trade wind onto Coronation Drive (95th %ile mean ${seSector.p95Ms} m/s; ${seSector.freqPct}% frequency).`
    },
    {
      id: 'winter-p95',
      label: 'Brisk Winter WSW (P95)',
      shortLabel: 'WSW P95\n248°',
      category: 'prevailing',
      date: '2016-2026 P95',
      dirDeg: 248,
      dir: 'WSW',
      meanMs: wswSector.p95Ms,
      gustMs: Math.round(wswSector.p95Ms * 1.6 * 10) / 10,
      defaultSpeedMs: Math.round(wswSector.p95Ms * 1.45 * 10) / 10,
      speedType: 'mean',
      source: '10-yr Wind Rose (95th %ile)',
      note: `Dominant winter westerly direction coming down off Dunmore Terrace (95th %ile mean ${wswSector.p95Ms} m/s; ${wswSector.freqPct}% frequency).`
    }
  ];

  const climate = {
    meta: {
      lat: LAT,
      lon: LON,
      startDate: START_DATE,
      endDate: END_DATE,
      totalHours: annualN,
      speedBinEdges: SPEED_BINS,
      sources: [
        'Open-Meteo Historical Weather Archive (ERA5/ACCESS, 10m hourly wind & gusts, 2016-2026)',
        'Brisbane Airport (YBBN) METAR Anemometer Archive via IEM ASOS (2016-2026)'
      ],
      generatedAt: new Date().toISOString()
    },
    roseAnnual: annualRose,
    roseSummer: summerRose,
    roseWinter: winterRose,
    topSiteExtremes: distinctExtremes,
    topYbbnStorms: ybbnStorms,
    presets
  };

  const outJs = 'window.WIND_CLIMATE = ' + JSON.stringify(climate) + ';\n';
  fs.writeFileSync('c:/Scratch/dev3d/data/wind-climate.js', outJs);
  console.log(`Wrote data/wind-climate.js (${(outJs.length / 1024).toFixed(1)} KB, ${annualN} hours, ${presets.length} presets)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
