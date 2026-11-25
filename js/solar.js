/**
 * Exact NOAA / Jean Meeus Solar Position Calculator for Brisbane (AEST UTC+10)
 * Right-handed ENU-to-Three.js frame:
 *   +X = East, +Y = Up (AHD), -Z = North (+Z = South)
 */
(function (global) {
  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;

  function julianDay(year, month, day, utcHours) {
    let y = year;
    let m = month;
    if (m <= 2) {
      y -= 1;
      m += 12;
    }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return (
      Math.floor(365.25 * (y + 4716)) +
      Math.floor(30.6001 * (m + 1)) +
      day +
      utcHours / 24 +
      B -
      1524.5
    );
  }

  /**
   * Compute solar position for a given calendar date and local standard time (minutes from midnight).
   * @param {number} year
   * @param {number} month 1-12
   * @param {number} day 1-31
   * @param {number} localMinutes 0..1440 in local standard time (AEST = UTC+10)
   * @param {number} latDeg default -27.47573659
   * @param {number} lonDeg default 153.003637555
   * @param {number} tzHours default 10 (Brisbane AEST, no DST)
   */
  function getSunPosition(
    year,
    month,
    day,
    localMinutes,
    latDeg = -27.47573659,
    lonDeg = 153.003637555,
    tzHours = 10
  ) {
    const utcHours = localMinutes / 60 - tzHours;
    const jd = julianDay(year, month, day, utcHours);
    const T = (jd - 2451545.0) / 36525.0;

    // Geometric mean longitude & anomaly
    let L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
    if (L0 < 0) L0 += 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

    const Mrad = M * DEG;
    const C =
      Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
      Math.sin(3 * Mrad) * 0.000289;

    const sunTrueLon = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = (sunTrueLon - 0.00569 - 0.00478 * Math.sin(omega * DEG)) * DEG;

    const eps0 =
      23 +
      (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = (eps0 + 0.00256 * Math.cos(omega * DEG)) * DEG;

    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));

    const y = Math.tan(eps / 2) * Math.tan(eps / 2);
    const L0rad = L0 * DEG;
    const eqTime =
      4 *
      RAD *
      (y * Math.sin(2 * L0rad) -
        2 * e * Math.sin(Mrad) +
        4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0rad) -
        0.5 * y * y * Math.sin(4 * L0rad) -
        1.25 * e * e * Math.sin(2 * Mrad));

    let tst = (localMinutes + eqTime + 4 * lonDeg - 60 * tzHours) % 1440;
    if (tst < 0) tst += 1440;
    const haDeg = tst / 4 - 180;
    const ha = haDeg * DEG;

    const lat = latDeg * DEG;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
    const altGeom = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    const altGeomDeg = altGeom * RAD;

    // Approximate atmospheric refraction (NOAA)
    let refractionDeg = 0;
    if (altGeomDeg > 85) {
      refractionDeg = 0;
    } else if (altGeomDeg > 5) {
      const te = Math.tan(altGeom);
      refractionDeg = (58.1 / te - 0.07 / (te * te * te) + 0.000086 / Math.pow(te, 5)) / 3600;
    } else if (altGeomDeg > -0.575) {
      refractionDeg =
        (1735 +
          altGeomDeg *
            (-518.2 + altGeomDeg * (103.4 + altGeomDeg * (-12.79 + altGeomDeg * 0.711)))) /
        3600;
    } else {
      refractionDeg = -20.774 / Math.tan(altGeom) / 3600;
    }

    const altDeg = altGeomDeg + refractionDeg;
    const altRad = altDeg * DEG;

    const cosAlt = Math.max(1e-6, Math.cos(altGeom));
    const sinAz = (-Math.cos(decl) * Math.sin(ha)) / cosAlt;
    const cosAz = (Math.sin(decl) - Math.sin(lat) * Math.sin(altGeom)) / (Math.cos(lat) * cosAlt);
    let azDeg = Math.atan2(sinAz, cosAz) * RAD;
    if (azDeg < 0) azDeg += 360;
    const azRad = azDeg * DEG;

    // Direction vector pointing TOWARD the sun in Three.js (+X=East, +Y=Up, -Z=North)
    const sx = Math.cos(altRad) * Math.sin(azRad);
    const sy = Math.sin(altRad);
    const sz = -Math.cos(altRad) * Math.cos(azRad);

    return {
      altitudeDeg: altDeg,
      azimuthDeg: azDeg,
      declinationDeg: decl * RAD,
      dir: [sx, sy, sz],
      isDay: altDeg > 0.25
    };
  }

  /**
   * Find sunrise, solar noon, and sunset (local minutes AEST) for a given date.
   */
  function getDaySummary(year, month, day, latDeg, lonDeg, tzHours = 10) {
    let sunrise = null;
    let sunset = null;
    let maxAlt = -90;
    let solarNoon = 720;
    let prevDay = false;
    for (let m = 240; m <= 1200; m += 2) {
      const p = getSunPosition(year, month, day, m, latDeg, lonDeg, tzHours);
      if (p.altitudeDeg > maxAlt) {
        maxAlt = p.altitudeDeg;
        solarNoon = m;
      }
      const isUp = p.altitudeDeg >= 0;
      if (isUp && !prevDay && sunrise === null) sunrise = m;
      if (!isUp && prevDay && sunset === null) sunset = m;
      prevDay = isUp;
    }
    return {
      sunriseMin: sunrise ?? 360,
      sunsetMin: sunset ?? 1080,
      solarNoonMin: solarNoon,
      maxAltitudeDeg: maxAlt
    };
  }

  function formatMinutes(min) {
    const m = Math.max(0, Math.min(1439, Math.round(min)));
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function azimuthToCompass(deg) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }

  global.SolarCalc = {
    getSunPosition,
    getDaySummary,
    formatMinutes,
    azimuthToCompass
  };
})(window);
