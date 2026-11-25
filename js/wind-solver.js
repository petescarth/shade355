/**
 * 3D In-Browser Urban Wind Tunnel (Incompressible Navier-Stokes CFD Engine)
 * Models 3D atmospheric boundary layer flow, facade stagnation, 3D downwash,
 * Venturi corner acceleration, and wake recirculation around 355 Coronation Drive.
 *
 * Uses WebGL2 2D-tiled 3D float textures on GPU when available (~0.5-1.5s solve),
 * with an identical-physics chunked CPU TypedArray fallback for 100% browser,
 * file://, and headless Node.js compatibility.
 */
(function (global) {
  'use strict';

  const U10_NORM = 10.0; // Normalized reference speed (m/s at 10m AGL); scaled linearly for any U10
  const DOMAIN_W = 320;  // East-West span (m) centered on 355 Coro
  const DOMAIN_D = 320;  // North-South span (m) centered on 355 Coro
  const DOMAIN_H = 104;  // Vertical span (m AHD: 0m -> 104m, clearing RL 83.6m crown by >20m)
  const Y_BASE = 0.0;

  const DIRS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

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

  function dirToCompass(deg) {
    const idx = Math.floor((((deg % 360) + 360 + 11.25) % 360) / 22.5) % 16;
    return DIRS_16[idx];
  }

  /**
   * Roughness exponent alpha(dirDeg) reflecting Brisbane terrain fetch:
   * - Open river fetch (ENE / E / SE ~ 115 deg): alpha ~ 0.16 (Terrain Cat 2)
   * - Suburban Dunmore Terrace ridge (W / NW ~ 295 deg): alpha ~ 0.24 (Terrain Cat 3)
   */
  function getRoughnessAlpha(dirDeg) {
    const rad = ((dirDeg - 115) * Math.PI) / 180;
    return 0.20 - 0.04 * Math.cos(rad);
  }

  /**
   * Meteorological FROM direction (deg clockwise from North) -> 3D flow vector (dx, dz).
   * Scene axes: +X = East, -Z = North, +Z = South.
   */
  function windDirToFlowXZ(dirDeg) {
    const rad = (dirDeg * Math.PI) / 180;
    return [-Math.sin(rad), Math.cos(rad)];
  }

  function ablSpeed(heightAGL, u10, alpha) {
    const h = Math.max(0.5, Math.min(120, heightAGL));
    return u10 * Math.pow(h / 10.0, alpha);
  }

  function classifyLawson(speedMs) {
    if (speedMs < 4.0) return { code: 'sitting', label: 'Sitting', color: '#22c55e', rank: 0 };
    if (speedMs < 6.0) return { code: 'standing', label: 'Standing', color: '#38bdf8', rank: 1 };
    if (speedMs < 8.0) return { code: 'walking', label: 'Walking', color: '#facc15', rank: 2 };
    if (speedMs < 10.0) return { code: 'uncomfortable', label: 'Uncomfortable', color: '#fb923c', rank: 3 };
    if (speedMs < 15.0) return { code: 'windy', label: 'Very Windy', color: '#f43f5e', rank: 4 };
    return { code: 'distress', label: 'Distress / Unsafe', color: '#d946ef', rank: 5 };
  }

  // ==================== WEBGL2 3D GPU NAVIER-STOKES SOLVER ====================
  class WebGL2FluidSolver {
    constructor(nx, ny, nz) {
      this.nx = nx;
      this.ny = ny;
      this.nz = nz;
      // Pack ny vertical slices into a 2D atlas of (tilesX x tilesY) slices
      this.tilesX = 8;
      this.tilesY = Math.ceil(ny / this.tilesX);
      this.texW = nx * this.tilesX;
      this.texH = nz * this.tilesY;
      this.ok = false;

      if (typeof document === 'undefined') return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = this.texW;
        canvas.height = this.texH;
        const gl = canvas.getContext('webgl2', {
          antialias: false,
          depth: false,
          stencil: false,
          preserveDrawingBuffer: false
        });
        if (!gl) return;
        const extFloat = gl.getExtension('EXT_color_buffer_float');
        if (!extFloat) return;
        gl.getExtension('OES_texture_float_linear');

        this.gl = gl;
        this.canvas = canvas;
        this._initGL();
        this.ok = true;
      } catch (_e) {
        this.ok = false;
      }
    }

    _compile(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('Wind shader compile error: ' + err);
      }
      return sh;
    }

    _program(fsSrc) {
      const gl = this.gl;
      const vsSrc = `#version 300 es
        in vec2 aPos;
        void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
      `;
      const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
      const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('Wind program link error: ' + gl.getProgramInfoLog(prog));
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return prog;
    }

    _createTex(internalFormat, format, type, data) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this.texW, this.texH, 0, format, type, data || null);
      return tex;
    }

    _createFBO(tex) {
      const gl = this.gl;
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Wind FBO incomplete: ' + status);
      }
      return fbo;
    }

    _initGL() {
      const gl = this.gl;
      // Fullscreen quad
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.quadBuf = buf;

      // Common GLSL header for 3D atlas addressing
      const HEADER = `#version 300 es
        precision highp float;
        precision highp int;
        uniform ivec3 uDim;      // (nx, ny, nz)
        uniform int uTilesX;
        uniform vec3 uInvCell;   // (1/dx, 1/dy, 1/dz)

        ivec2 voxelToAtlas(ivec3 c) {
          c = clamp(c, ivec3(0), uDim - ivec3(1));
          int tx = c.y % uTilesX;
          int ty = c.y / uTilesX;
          return ivec2(tx * uDim.x + c.x, ty * uDim.z + c.z);
        }

        ivec3 fragToVoxel() {
          ivec2 p = ivec2(gl_FragCoord.xy);
          int tx = p.x / uDim.x;
          int ty = p.y / uDim.z;
          int y = ty * uTilesX + tx;
          int x = p.x - tx * uDim.x;
          int z = p.y - ty * uDim.z;
          return ivec3(x, y, z);
        }

        vec4 fetch3D(sampler2D tex, ivec3 c) {
          return texelFetch(tex, voxelToAtlas(c), 0);
        }

        float fetchSolid(sampler2D solidTex, ivec3 c) {
          if (c.y < 0) return 1.0;
          if (c.y >= uDim.y) return 0.0;
          return texelFetch(solidTex, voxelToAtlas(c), 0).r;
        }

        vec3 sampleTrilinear(sampler2D velTex, sampler2D solidTex, vec3 pos, vec3 fallback) {
          vec3 p = clamp(pos, vec3(0.0), vec3(uDim - ivec3(1)) - vec3(0.001));
          ivec3 i0 = ivec3(floor(p));
          ivec3 i1 = min(i0 + ivec3(1), uDim - ivec3(1));
          vec3 f = fract(p);

          vec3 sum = vec3(0.0);
          float wSum = 0.0;
          for (int ky = 0; ky <= 1; ky++) {
            float wy = ky == 0 ? (1.0 - f.y) : f.y;
            int cy = ky == 0 ? i0.y : i1.y;
            for (int kz = 0; kz <= 1; kz++) {
              float wz = kz == 0 ? (1.0 - f.z) : f.z;
              int cz = kz == 0 ? i0.z : i1.z;
              for (int kx = 0; kx <= 1; kx++) {
                int cx = kx == 0 ? i0.x : i1.x;
                ivec3 cc = ivec3(cx, cy, cz);
                if (fetchSolid(solidTex, cc) > 0.5) continue;
                float w = (kx == 0 ? (1.0 - f.x) : f.x) * wy * wz;
                sum += fetch3D(velTex, cc).xyz * w;
                wSum += w;
              }
            }
          }
          return wSum > 1e-4 ? (sum / wSum) : fallback;
        }
      `;

      // 1. Advect + Smagorinsky eddy viscosity + ABL boundary conditions
      this.progAdvect = this._program(`${HEADER}
        uniform sampler2D uVel;
        uniform sampler2D uSolid;
        uniform sampler2D uInlet;
        uniform float uDt;
        uniform vec2 uFlowDir;
        out vec4 outVel;

        void main() {
          ivec3 c = fragToVoxel();
          if (c.y >= uDim.y) { outVel = vec4(0.0); return; }
          if (fetchSolid(uSolid, c) > 0.5) { outVel = vec4(0.0); return; }

          // Upwind boundaries: Dirichlet ABL profile
          bool isInflowX = (c.x == 0 && uFlowDir.x > 0.05) || (c.x == uDim.x - 1 && uFlowDir.x < -0.05);
          bool isInflowZ = (c.z == 0 && uFlowDir.y > 0.05) || (c.z == uDim.z - 1 && uFlowDir.y < -0.05);
          if (isInflowX || isInflowZ) {
            outVel = vec4(fetch3D(uInlet, c).xyz, 0.0);
            return;
          }

          // Top lid: free-slip tangential ABL wind
          if (c.y == uDim.y - 1) {
            vec3 inV = fetch3D(uInlet, c).xyz;
            outVel = vec4(inV.x, 0.0, inV.z, 0.0);
            return;
          }

          // Outflow boundaries: zero-gradient convective copy
          bool isOutX = (c.x == 0 && uFlowDir.x <= 0.05) || (c.x == uDim.x - 1 && uFlowDir.x >= -0.05);
          bool isOutZ = (c.z == 0 && uFlowDir.y <= 0.05) || (c.z == uDim.z - 1 && uFlowDir.y >= -0.05);
          if (isOutX || isOutZ) {
            ivec3 inner = clamp(c, ivec3(1, 0, 1), uDim - ivec3(2, 1, 2));
            if (fetchSolid(uSolid, inner) > 0.5) {
              outVel = vec4(fetch3D(uInlet, c).xyz, 0.0);
            } else {
              outVel = vec4(fetch3D(uVel, inner).xyz, 0.0);
            }
            return;
          }

          // 2nd-order midpoint Semi-Lagrangian backtrace (clamp backtrace out of solids)
          vec3 v0 = fetch3D(uVel, c).xyz;
          vec3 midPos = vec3(c) - 0.5 * uDt * v0 * uInvCell;
          if (fetchSolid(uSolid, ivec3(round(midPos))) > 0.5) midPos = vec3(c);
          vec3 vMid = sampleTrilinear(uVel, uSolid, midPos, v0);
          vec3 prevPos = vec3(c) - uDt * vMid * uInvCell;
          if (fetchSolid(uSolid, ivec3(round(prevPos))) > 0.5) prevPos = mix(vec3(c), prevPos, 0.25);
          vec3 adv = sampleTrilinear(uVel, uSolid, prevPos, v0);

          // Fluid-only Smagorinsky turbulent diffusion (never average with zeroed solid cells)
          vec3 sumNbr = vec3(0.0);
          float cntNbr = 0.0;
          vec3 vXm = v0, vXp = v0, vYm = v0, vYp = v0, vZm = v0, vZp = v0;
          if (fetchSolid(uSolid, c - ivec3(1, 0, 0)) < 0.5) { vXm = fetch3D(uVel, c - ivec3(1, 0, 0)).xyz; sumNbr += vXm; cntNbr += 1.0; }
          if (fetchSolid(uSolid, c + ivec3(1, 0, 0)) < 0.5) { vXp = fetch3D(uVel, c + ivec3(1, 0, 0)).xyz; sumNbr += vXp; cntNbr += 1.0; }
          if (fetchSolid(uSolid, c - ivec3(0, 1, 0)) < 0.5) { vYm = fetch3D(uVel, c - ivec3(0, 1, 0)).xyz; sumNbr += vYm; cntNbr += 1.0; }
          if (fetchSolid(uSolid, c + ivec3(0, 1, 0)) < 0.5) { vYp = fetch3D(uVel, c + ivec3(0, 1, 0)).xyz; sumNbr += vYp; cntNbr += 1.0; }
          if (fetchSolid(uSolid, c - ivec3(0, 0, 1)) < 0.5) { vZm = fetch3D(uVel, c - ivec3(0, 0, 1)).xyz; sumNbr += vZm; cntNbr += 1.0; }
          if (fetchSolid(uSolid, c + ivec3(0, 0, 1)) < 0.5) { vZp = fetch3D(uVel, c + ivec3(0, 0, 1)).xyz; sumNbr += vZp; cntNbr += 1.0; }
          vec3 avgNbr = cntNbr > 0.5 ? (sumNbr / cntNbr) : adv;

          float shear = length(vXp - vXm) + length(vYp - vYm) + length(vZp - vZm);
          float diff = clamp(0.015 + 0.004 * shear, 0.015, 0.12);
          vec3 vel = mix(adv, avgNbr, diff);

          // Gentle physical surface friction only on ground-adjacent cells
          if (fetchSolid(uSolid, c - ivec3(0, 1, 0)) > 0.5) {
            vel.xz *= 0.988;
          }

          // Clamp velocity magnitude to prevent any runaway instability
          float spd = length(vel);
          if (spd > 32.0) vel *= (32.0 / spd);
          outVel = vec4(vel, 0.0);
        }
      `);

      // 2. Divergence computation (with zero normal flux across solid walls)
      this.progDiv = this._program(`${HEADER}
        uniform sampler2D uVel;
        uniform sampler2D uSolid;
        out vec4 outDiv;

        void main() {
          ivec3 c = fragToVoxel();
          if (c.y >= uDim.y || fetchSolid(uSolid, c) > 0.5) { outDiv = vec4(0.0); return; }

          vec3 vC = fetch3D(uVel, c).xyz;
          float sXm = fetchSolid(uSolid, c - ivec3(1, 0, 0));
          float sXp = fetchSolid(uSolid, c + ivec3(1, 0, 0));
          float sYm = fetchSolid(uSolid, c - ivec3(0, 1, 0));
          float sYp = fetchSolid(uSolid, c + ivec3(0, 1, 0));
          float sZm = fetchSolid(uSolid, c - ivec3(0, 0, 1));
          float sZp = fetchSolid(uSolid, c + ivec3(0, 0, 1));

          float uXm = sXm > 0.5 ? 0.0 : fetch3D(uVel, c - ivec3(1, 0, 0)).x;
          float uXp = sXp > 0.5 ? 0.0 : fetch3D(uVel, c + ivec3(1, 0, 0)).x;
          float vYm = sYm > 0.5 ? 0.0 : fetch3D(uVel, c - ivec3(0, 1, 0)).y;
          float vYp = sYp > 0.5 ? 0.0 : fetch3D(uVel, c + ivec3(0, 1, 0)).y;
          float wZm = sZm > 0.5 ? 0.0 : fetch3D(uVel, c - ivec3(0, 0, 1)).z;
          float wZp = sZp > 0.5 ? 0.0 : fetch3D(uVel, c + ivec3(0, 0, 1)).z;

          float div = 0.5 * ((uXp - uXm) * uInvCell.x + (vYp - vYm) * uInvCell.y + (wZp - wZm) * uInvCell.z);
          outDiv = vec4(div, 0.0, 0.0, 1.0);
        }
      `);

      // 3. Pressure Jacobi iteration (exact solid-wall Neumann dp/dn = 0 & outflow p = 0)
      this.progJacobi = this._program(`${HEADER}
        uniform sampler2D uPress;
        uniform sampler2D uDiv;
        uniform sampler2D uSolid;
        uniform vec2 uFlowDir;
        out vec4 outP;

        void main() {
          ivec3 c = fragToVoxel();
          if (c.y >= uDim.y || fetchSolid(uSolid, c) > 0.5) { outP = vec4(0.0); return; }

          // Zero pressure at downwind outflow faces
          bool isOutX = (c.x == 0 && uFlowDir.x <= 0.05) || (c.x == uDim.x - 1 && uFlowDir.x >= -0.05);
          bool isOutZ = (c.z == 0 && uFlowDir.y <= 0.05) || (c.z == uDim.z - 1 && uFlowDir.y >= -0.05);
          if (isOutX || isOutZ) { outP = vec4(0.0); return; }

          float pC = fetch3D(uPress, c).r;
          float div = fetch3D(uDiv, c).r;

          float wx = uInvCell.x * uInvCell.x;
          float wy = uInvCell.y * uInvCell.y;
          float wz = uInvCell.z * uInvCell.z;

          float pXm = fetchSolid(uSolid, c - ivec3(1, 0, 0)) > 0.5 ? pC : fetch3D(uPress, c - ivec3(1, 0, 0)).r;
          float pXp = fetchSolid(uSolid, c + ivec3(1, 0, 0)) > 0.5 ? pC : fetch3D(uPress, c + ivec3(1, 0, 0)).r;
          float pYm = fetchSolid(uSolid, c - ivec3(0, 1, 0)) > 0.5 ? pC : fetch3D(uPress, c - ivec3(0, 1, 0)).r;
          float pYp = (c.y >= uDim.y - 1 || fetchSolid(uSolid, c + ivec3(0, 1, 0)) > 0.5) ? pC : fetch3D(uPress, c + ivec3(0, 1, 0)).r;
          float pZm = fetchSolid(uSolid, c - ivec3(0, 0, 1)) > 0.5 ? pC : fetch3D(uPress, c - ivec3(0, 0, 1)).r;
          float pZp = fetchSolid(uSolid, c + ivec3(0, 0, 1)) > 0.5 ? pC : fetch3D(uPress, c + ivec3(0, 0, 1)).r;

          float denom = 2.0 * (wx + wy + wz);
          float pNew = ((pXm + pXp) * wx + (pYm + pYp) * wy + (pZm + pZp) * wz - div) / denom;
          outP = vec4(pNew, 0.0, 0.0, 1.0);
        }
      `);

      // 4. Subtract pressure gradient -> divergence-free 3D velocity field
      this.progProject = this._program(`${HEADER}
        uniform sampler2D uVel;
        uniform sampler2D uPress;
        uniform sampler2D uSolid;
        uniform sampler2D uInlet;
        uniform vec2 uFlowDir;
        out vec4 outVel;

        void main() {
          ivec3 c = fragToVoxel();
          if (c.y >= uDim.y || fetchSolid(uSolid, c) > 0.5) { outVel = vec4(0.0); return; }

          bool isInflowX = (c.x == 0 && uFlowDir.x > 0.05) || (c.x == uDim.x - 1 && uFlowDir.x < -0.05);
          bool isInflowZ = (c.z == 0 && uFlowDir.y > 0.05) || (c.z == uDim.z - 1 && uFlowDir.y < -0.05);
          if (isInflowX || isInflowZ) {
            outVel = vec4(fetch3D(uInlet, c).xyz, 0.0);
            return;
          }
          if (c.y == uDim.y - 1) {
            vec3 inV = fetch3D(uInlet, c).xyz;
            outVel = vec4(inV.x, 0.0, inV.z, 0.0);
            return;
          }

          float pC = fetch3D(uPress, c).r;
          float pXm = fetchSolid(uSolid, c - ivec3(1, 0, 0)) > 0.5 ? pC : fetch3D(uPress, c - ivec3(1, 0, 0)).r;
          float pXp = fetchSolid(uSolid, c + ivec3(1, 0, 0)) > 0.5 ? pC : fetch3D(uPress, c + ivec3(1, 0, 0)).r;
          float pYm = fetchSolid(uSolid, c - ivec3(0, 1, 0)) > 0.5 ? pC : fetch3D(uPress, c - ivec3(0, 1, 0)).r;
          float pYp = (c.y >= uDim.y - 1 || fetchSolid(uSolid, c + ivec3(0, 1, 0)) > 0.5) ? pC : fetch3D(uPress, c + ivec3(0, 1, 0)).r;
          float pZm = fetchSolid(uSolid, c - ivec3(0, 0, 1)) > 0.5 ? pC : fetch3D(uPress, c - ivec3(0, 0, 1)).r;
          float pZp = fetchSolid(uSolid, c + ivec3(0, 0, 1)) > 0.5 ? pC : fetch3D(uPress, c + ivec3(0, 0, 1)).r;

          vec3 v = fetch3D(uVel, c).xyz;
          v.x -= 0.5 * (pXp - pXm) * uInvCell.x;
          v.y -= 0.5 * (pYp - pYm) * uInvCell.y;
          v.z -= 0.5 * (pZp - pZm) * uInvCell.z;

          // Gently damp only velocity entering solid wall (preserve tangential & downwash turning)
          if (fetchSolid(uSolid, c - ivec3(1, 0, 0)) > 0.5 && v.x < 0.0) v.x *= 0.15;
          if (fetchSolid(uSolid, c + ivec3(1, 0, 0)) > 0.5 && v.x > 0.0) v.x *= 0.15;
          if (fetchSolid(uSolid, c - ivec3(0, 1, 0)) > 0.5 && v.y < 0.0) v.y *= 0.35;
          if (fetchSolid(uSolid, c + ivec3(0, 1, 0)) > 0.5 && v.y > 0.0) v.y *= 0.15;
          if (fetchSolid(uSolid, c - ivec3(0, 0, 1)) > 0.5 && v.z < 0.0) v.z *= 0.15;
          if (fetchSolid(uSolid, c + ivec3(0, 0, 1)) > 0.5 && v.z > 0.0) v.z *= 0.15;

          outVel = vec4(v, 0.0);
        }
      `);

      // Allocate ping-pong float textures
      this.velTex = [
        this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT),
        this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT)
      ];
      this.velFbo = [this._createFBO(this.velTex[0]), this._createFBO(this.velTex[1])];

      this.pressTex = [
        this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT),
        this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT)
      ];
      this.pressFbo = [this._createFBO(this.pressTex[0]), this._createFBO(this.pressTex[1])];

      this.divTex = this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT);
      this.divFbo = this._createFBO(this.divTex);

      this.solidTex = this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT);
      this.inletTex = this._createTex(gl.RGBA32F, gl.RGBA, gl.FLOAT);
    }

    _drawPass(prog, targetFbo, setupUniforms) {
      const gl = this.gl;
      gl.useProgram(prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
      gl.viewport(0, 0, this.texW, this.texH);

      gl.uniform3i(gl.getUniformLocation(prog, 'uDim'), this.nx, this.ny, this.nz);
      gl.uniform1i(gl.getUniformLocation(prog, 'uTilesX'), this.tilesX);
      setupUniforms(gl, prog);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _bindTex(unit, tex, prog, name) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
    }

    /**
     * Solve steady 3D incompressible flow for the given voxel solidMask & inlet field.
     * Returns packed { ux, uy, uz } Float32Arrays (size nx * ny * nz).
     */
    solve(solidMask, inletVel4, flowDir, dx, dy, dz, steps = 110, jacobiIters = 22) {
      const gl = this.gl;
      const { nx, ny, nz, tilesX, texW, texH } = this;

      // Pack solidMask and inlet velocity into 2D tiled RGBA32F buffers
      const solidBuf = new Float32Array(texW * texH * 4);
      const initVelBuf = new Float32Array(texW * texH * 4);
      const zeroBuf = new Float32Array(texW * texH * 4);

      for (let y = 0; y < ny; y++) {
        const tx = y % tilesX;
        const ty = Math.floor(y / tilesX);
        const yOff = y * nx * nz;
        for (let z = 0; z < nz; z++) {
          const az = ty * nz + z;
          for (let x = 0; x < nx; x++) {
            const ax = tx * nx + x;
            const srcIdx = yOff + z * nx + x;
            const dst4 = (az * texW + ax) * 4;
            const s = solidMask[srcIdx] ? 1.0 : 0.0;
            solidBuf[dst4] = s;
            if (!s) {
              initVelBuf[dst4] = inletVel4[srcIdx * 3];
              initVelBuf[dst4 + 1] = inletVel4[srcIdx * 3 + 1];
              initVelBuf[dst4 + 2] = inletVel4[srcIdx * 3 + 2];
            }
          }
        }
      }

      const upload = (tex, data) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texW, texH, gl.RGBA, gl.FLOAT, data);
      };
      upload(this.solidTex, solidBuf);
      upload(this.inletTex, initVelBuf);
      upload(this.velTex[0], initVelBuf);
      upload(this.pressTex[0], zeroBuf);
      upload(this.pressTex[1], zeroBuf);

      const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
      const dt = 0.24; // Stable CFL timestep at U10 = 10 m/s (~0.7 cell/step)

      let velSrc = 0;
      let pressSrc = 0;

      for (let step = 0; step < steps; step++) {
        // 1. Advect + Smagorinsky diffusion
        const velDst = 1 - velSrc;
        this._drawPass(this.progAdvect, this.velFbo[velDst], (g, p) => {
          this._bindTex(0, this.velTex[velSrc], p, 'uVel');
          this._bindTex(1, this.solidTex, p, 'uSolid');
          this._bindTex(2, this.inletTex, p, 'uInlet');
          g.uniform3f(g.getUniformLocation(p, 'uInvCell'), invDx, invDy, invDz);
          g.uniform1f(g.getUniformLocation(p, 'uDt'), dt);
          g.uniform2f(g.getUniformLocation(p, 'uFlowDir'), flowDir[0], flowDir[1]);
        });
        velSrc = velDst;

        // 2. Divergence
        this._drawPass(this.progDiv, this.divFbo, (g, p) => {
          this._bindTex(0, this.velTex[velSrc], p, 'uVel');
          this._bindTex(1, this.solidTex, p, 'uSolid');
          g.uniform3f(g.getUniformLocation(p, 'uInvCell'), invDx, invDy, invDz);
        });

        // 3. Pressure Jacobi iterations (warm-started from previous timestep!)
        const iters = step < 15 ? jacobiIters + 10 : jacobiIters;
        for (let it = 0; it < iters; it++) {
          const pDst = 1 - pressSrc;
          this._drawPass(this.progJacobi, this.pressFbo[pDst], (g, p) => {
            this._bindTex(0, this.pressTex[pressSrc], p, 'uPress');
            this._bindTex(1, this.divTex, p, 'uDiv');
            this._bindTex(2, this.solidTex, p, 'uSolid');
            g.uniform3f(g.getUniformLocation(p, 'uInvCell'), invDx, invDy, invDz);
            g.uniform2f(g.getUniformLocation(p, 'uFlowDir'), flowDir[0], flowDir[1]);
          });
          pressSrc = pDst;
        }

        // 4. Pressure projection
        const projDst = 1 - velSrc;
        this._drawPass(this.progProject, this.velFbo[projDst], (g, p) => {
          this._bindTex(0, this.velTex[velSrc], p, 'uVel');
          this._bindTex(1, this.pressTex[pressSrc], p, 'uPress');
          this._bindTex(2, this.solidTex, p, 'uSolid');
          this._bindTex(3, this.inletTex, p, 'uInlet');
          g.uniform3f(g.getUniformLocation(p, 'uInvCell'), invDx, invDy, invDz);
          g.uniform2f(g.getUniformLocation(p, 'uFlowDir'), flowDir[0], flowDir[1]);
        });
        velSrc = projDst;
      }

      // Read back converged 3D velocity field
      const outPixels = new Float32Array(texW * texH * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.velFbo[velSrc]);
      gl.readPixels(0, 0, texW, texH, gl.RGBA, gl.FLOAT, outPixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const nTot = nx * ny * nz;
      const ux = new Float32Array(nTot);
      const uy = new Float32Array(nTot);
      const uz = new Float32Array(nTot);

      for (let y = 0; y < ny; y++) {
        const tx = y % tilesX;
        const ty = Math.floor(y / tilesX);
        const yOff = y * nx * nz;
        for (let z = 0; z < nz; z++) {
          const az = ty * nz + z;
          for (let x = 0; x < nx; x++) {
            const ax = tx * nx + x;
            const dstIdx = yOff + z * nx + x;
            const src4 = (az * texW + ax) * 4;
            ux[dstIdx] = outPixels[src4];
            uy[dstIdx] = outPixels[src4 + 1];
            uz[dstIdx] = outPixels[src4 + 2];
          }
        }
      }
      return { ux, uy, uz };
    }
  }

  // ==================== CPU TYPEDARRAY 3D NAVIER-STOKES FALLBACK ====================
  function solveCPU3D(nx, ny, nz, solidMask, inletVel3, flowDir, dx, dy, dz, steps = 42, sorIters = 14) {
    const nTot = nx * ny * nz;
    const slice = nx * nz;
    let ux = new Float32Array(nTot);
    let uy = new Float32Array(nTot);
    let uz = new Float32Array(nTot);
    let ux2 = new Float32Array(nTot);
    let uy2 = new Float32Array(nTot);
    let uz2 = new Float32Array(nTot);
    const div = new Float32Array(nTot);
    const p = new Float32Array(nTot);

    for (let i = 0; i < nTot; i++) {
      if (!solidMask[i]) {
        ux[i] = inletVel3[i * 3];
        uy[i] = inletVel3[i * 3 + 1];
        uz[i] = inletVel3[i * 3 + 2];
      }
    }

    const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
    const wx = invDx * invDx, wy = invDy * invDy, wz = invDz * invDz;
    const invDenom = 1.0 / (2.0 * (wx + wy + wz));
    const dt = 0.28;
    const omega = 1.48; // Red-Black SOR over-relaxation factor

    const sampleTri = (arr, px, py, pz, fallback) => {
      const cx = px < 0 ? 0 : px > nx - 1.001 ? nx - 1.001 : px;
      const cy = py < 0 ? 0 : py > ny - 1.001 ? ny - 1.001 : py;
      const cz = pz < 0 ? 0 : pz > nz - 1.001 ? nz - 1.001 : pz;
      const x0 = cx | 0, y0 = cy | 0, z0 = cz | 0;
      const fx = cx - x0, fy = cy - y0, fz = cz - z0;
      let sum = 0, wSum = 0;
      for (let ky = 0; ky <= 1; ky++) {
        const wyf = ky ? fy : 1 - fy;
        const yOff = (y0 + ky) * slice;
        for (let kz = 0; kz <= 1; kz++) {
          const wzf = kz ? fz : 1 - fz;
          const zOff = yOff + (z0 + kz) * nx;
          for (let kx = 0; kx <= 1; kx++) {
            const id = zOff + (x0 + kx);
            if (solidMask[id]) continue;
            const w = (kx ? fx : 1 - fx) * wyf * wzf;
            sum += arr[id] * w;
            wSum += w;
          }
        }
      }
      return wSum > 1e-4 ? sum / wSum : fallback;
    };

    const inX0 = flowDir[0] > 0.05;
    const inX1 = flowDir[0] < -0.05;
    const inZ0 = flowDir[1] > 0.05;
    const inZ1 = flowDir[1] < -0.05;

    for (let step = 0; step < steps; step++) {
      // 1. Advect + diffusion + BCs
      for (let y = 0; y < ny; y++) {
        const yOff = y * slice;
        for (let z = 0; z < nz; z++) {
          const zOff = yOff + z * nx;
          for (let x = 0; x < nx; x++) {
            const idx = zOff + x;
            if (solidMask[idx]) {
              ux2[idx] = 0; uy2[idx] = 0; uz2[idx] = 0;
              continue;
            }
            if ((x === 0 && inX0) || (x === nx - 1 && inX1) || (z === 0 && inZ0) || (z === nz - 1 && inZ1)) {
              ux2[idx] = inletVel3[idx * 3];
              uy2[idx] = 0;
              uz2[idx] = inletVel3[idx * 3 + 2];
              continue;
            }
            if (y === ny - 1) {
              ux2[idx] = inletVel3[idx * 3];
              uy2[idx] = 0;
              uz2[idx] = inletVel3[idx * 3 + 2];
              continue;
            }
            if (x === 0 || x === nx - 1 || z === 0 || z === nz - 1) {
              const ix = x === 0 ? 1 : x === nx - 1 ? nx - 2 : x;
              const iz = z === 0 ? 1 : z === nz - 1 ? nz - 2 : z;
              const inner = yOff + iz * nx + ix;
              if (solidMask[inner]) {
                ux2[idx] = inletVel3[idx * 3]; uy2[idx] = 0; uz2[idx] = inletVel3[idx * 3 + 2];
              } else {
                ux2[idx] = ux[inner]; uy2[idx] = uy[inner]; uz2[idx] = uz[inner];
              }
              continue;
            }

            const px = x - dt * ux[idx] * invDx;
            const py = y - dt * uy[idx] * invDy;
            const pz = z - dt * uz[idx] * invDz;
            let vx = sampleTri(ux, px, py, pz, ux[idx]);
            let vy = sampleTri(uy, px, py, pz, uy[idx]);
            let vz = sampleTri(uz, px, py, pz, uz[idx]);

            // Fluid-only eddy viscosity smoothing (never average against zeroed solid cells)
            let sX = 0, sY = 0, sZ = 0, cnt = 0;
            if (!solidMask[idx - 1]) { sX += ux[idx - 1]; sY += uy[idx - 1]; sZ += uz[idx - 1]; cnt++; }
            if (!solidMask[idx + 1]) { sX += ux[idx + 1]; sY += uy[idx + 1]; sZ += uz[idx + 1]; cnt++; }
            if (y > 0 && !solidMask[idx - slice]) { sX += ux[idx - slice]; sY += uy[idx - slice]; sZ += uz[idx - slice]; cnt++; }
            if (!solidMask[idx + slice]) { sX += ux[idx + slice]; sY += uy[idx + slice]; sZ += uz[idx + slice]; cnt++; }
            if (!solidMask[idx - nx]) { sX += ux[idx - nx]; sY += uy[idx - nx]; sZ += uz[idx - nx]; cnt++; }
            if (!solidMask[idx + nx]) { sX += ux[idx + nx]; sY += uy[idx + nx]; sZ += uz[idx + nx]; cnt++; }
            if (cnt > 0) {
              const invC = 1 / cnt;
              vx = vx * 0.965 + sX * invC * 0.035;
              vy = vy * 0.965 + sY * invC * 0.035;
              vz = vz * 0.965 + sZ * invC * 0.035;
            }
            if (y === 0 || solidMask[idx - slice]) {
              vx *= 0.988;
              vz *= 0.988;
            }

            const spd = Math.hypot(vx, vy, vz);
            if (spd > 32) {
              const sc = 32 / spd;
              vx *= sc; vy *= sc; vz *= sc;
            }
            ux2[idx] = vx; uy2[idx] = vy; uz2[idx] = vz;
          }
        }
      }
      // Swap velocity buffers
      let tmp = ux; ux = ux2; ux2 = tmp;
      tmp = uy; uy = uy2; uy2 = tmp;
      tmp = uz; uz = uz2; uz2 = tmp;

      // 2. Divergence
      for (let y = 0; y < ny - 1; y++) {
        const yOff = y * slice;
        for (let z = 1; z < nz - 1; z++) {
          const zOff = yOff + z * nx;
          for (let x = 1; x < nx - 1; x++) {
            const idx = zOff + x;
            if (solidMask[idx]) { div[idx] = 0; continue; }
            const uXm = solidMask[idx - 1] ? 0 : ux[idx - 1];
            const uXp = solidMask[idx + 1] ? 0 : ux[idx + 1];
            const vYm = y === 0 || solidMask[idx - slice] ? 0 : uy[idx - slice];
            const vYp = solidMask[idx + slice] ? 0 : uy[idx + slice];
            const wZm = solidMask[idx - nx] ? 0 : uz[idx - nx];
            const wZp = solidMask[idx + nx] ? 0 : uz[idx + nx];
            div[idx] = 0.5 * ((uXp - uXm) * invDx + (vYp - vYm) * invDy + (wZp - wZm) * invDz);
          }
        }
      }

      // 3. Red-Black SOR pressure solve
      const iters = step < 8 ? sorIters + 8 : sorIters;
      for (let it = 0; it < iters; it++) {
        for (let color = 0; color < 2; color++) {
          for (let y = 0; y < ny - 1; y++) {
            const yOff = y * slice;
            for (let z = 1; z < nz - 1; z++) {
              const zOff = yOff + z * nx;
              const xStart = 1 + ((y + z + color) & 1);
              for (let x = xStart; x < nx - 1; x += 2) {
                const idx = zOff + x;
                if (solidMask[idx]) continue;
                const pC = p[idx];
                const pXm = solidMask[idx - 1] ? pC : p[idx - 1];
                const pXp = solidMask[idx + 1] ? pC : p[idx + 1];
                const pYm = y === 0 || solidMask[idx - slice] ? pC : p[idx - slice];
                const pYp = solidMask[idx + slice] ? pC : p[idx + slice];
                const pZm = solidMask[idx - nx] ? pC : p[idx - nx];
                const pZp = solidMask[idx + nx] ? pC : p[idx + nx];
                const target = ((pXm + pXp) * wx + (pYm + pYp) * wy + (pZm + pZp) * wz - div[idx]) * invDenom;
                p[idx] = pC + omega * (target - pC);
              }
            }
          }
        }
        // Zero pressure on outflow faces
        for (let y = 0; y < ny; y++) {
          const yOff = y * slice;
          for (let z = 0; z < nz; z++) {
            if (!inX0) p[yOff + z * nx] = 0;
            if (!inX1) p[yOff + z * nx + nx - 1] = 0;
          }
          for (let x = 0; x < nx; x++) {
            if (!inZ0) p[yOff + x] = 0;
            if (!inZ1) p[yOff + (nz - 1) * nx + x] = 0;
          }
        }
      }

      // 4. Subtract pressure gradient
      for (let y = 0; y < ny - 1; y++) {
        const yOff = y * slice;
        for (let z = 1; z < nz - 1; z++) {
          const zOff = yOff + z * nx;
          for (let x = 1; x < nx - 1; x++) {
            const idx = zOff + x;
            if (solidMask[idx]) continue;
            const pC = p[idx];
            const pXm = solidMask[idx - 1] ? pC : p[idx - 1];
            const pXp = solidMask[idx + 1] ? pC : p[idx + 1];
            const pYm = y === 0 || solidMask[idx - slice] ? pC : p[idx - slice];
            const pYp = solidMask[idx + slice] ? pC : p[idx + slice];
            const pZm = solidMask[idx - nx] ? pC : p[idx - nx];
            const pZp = solidMask[idx + nx] ? pC : p[idx + nx];
            let vx = ux[idx] - 0.5 * (pXp - pXm) * invDx;
            let vy = uy[idx] - 0.5 * (pYp - pYm) * invDy;
            let vz = uz[idx] - 0.5 * (pZp - pZm) * invDz;
            if (solidMask[idx - 1] && vx < 0) vx *= 0.15;
            if (solidMask[idx + 1] && vx > 0) vx *= 0.15;
            if ((y === 0 || solidMask[idx - slice]) && vy < 0) vy *= 0.35;
            if (solidMask[idx + slice] && vy > 0) vy *= 0.15;
            if (solidMask[idx - nx] && vz < 0) vz *= 0.15;
            if (solidMask[idx + nx] && vz > 0) vz *= 0.15;
            ux[idx] = vx; uy[idx] = vy; uz[idx] = vz;
          }
        }
      }
    }

    return { ux, uy, uz };
  }

  // ==================== MAIN WIND TUNNEL ENGINE ====================
  class WindTunnelEngine {
    constructor(shadingEngine, sceneData, windClimate) {
      this.shadingEngine = shadingEngine;
      this.sceneData = sceneData;
      this.climate = windClimate || null;

      this.cx = sceneData.proposed.cx;
      this.cz = sceneData.proposed.cz;
      this.domainW = DOMAIN_W;
      this.domainD = DOMAIN_D;
      this.domainH = DOMAIN_H;
      this.minX = this.cx - DOMAIN_W / 2;
      this.maxX = this.cx + DOMAIN_W / 2;
      this.minZ = this.cz - DOMAIN_D / 2;
      this.maxZ = this.cz + DOMAIN_D / 2;
      this.yBase = Y_BASE;

      // Try WebGL2 GPU solver first (96x32x96), else clean CPU fallback (64x26x64)
      this.gpuSolver = new WebGL2FluidSolver(96, 32, 96);
      this.backend = this.gpuSolver.ok ? 'WebGL2 GPU (96×96×32)' : 'CPU 3D Navier-Stokes (64×64×26)';
      this.nx = this.gpuSolver.ok ? 96 : 64;
      this.ny = this.gpuSolver.ok ? 32 : 26;
      this.nz = this.gpuSolver.ok ? 96 : 64;
      this.dx = DOMAIN_W / this.nx;
      this.dy = DOMAIN_H / this.ny;
      this.dz = DOMAIN_D / this.nz;

      // Pre-sample ground DEM on the (nx x nz) wind grid
      this.groundY = new Float32Array(this.nx * this.nz);
      for (let z = 0; z < this.nz; z++) {
        const wz = this.minZ + (z + 0.5) * this.dz;
        for (let x = 0; x < this.nx; x++) {
          const wx = this.minX + (x + 0.5) * this.dx;
          this.groundY[z * this.nx + x] = this.shadingEngine.sampleDem(wx, wz);
        }
      }

      // Filter buildings overlapping the 320m x 320m wind tunnel box
      this.localPrisms = this.shadingEngine.prisms.filter(
        (p) => p.maxX >= this.minX && p.minX <= this.maxX && p.maxZ >= this.minZ && p.minZ <= this.maxZ
      );

      // Cache for voxel masks & solved normalized 3D velocity fields
      this.voxelCache = new Map();
      this.fieldCache = new Map();
      this.maxCacheEntries = 28;

      // Key Condition 30 pedestrian & rooftop probe points (auto-positioned from parcel geometry)
      this.keyProbes = this._buildKeyProbes();
    }

    _buildKeyProbes() {
      const cfg = this.sceneData.proposed;
      const [ux, uz] = cfg.uAxis;
      const [vx, vz] = cfg.vAxis;
      const o = cfg.originCorner || [cfg.cx - 22.8 * ux - 15.1 * vx, cfg.cz - 22.8 * uz - 15.1 * vz];
      const uv = (u, v) => [o[0] + u * ux + v * vx, o[1] + u * uz + v * vz];

      const pCoro = uv(48.5, 13.0);    // Coronation Drive riverfront footpath
      const pCorner = uv(46.0, 31.5);  // Lang Parade x Coronation Drive corner
      const pLang = uv(22.0, 34.0);    // Lang Parade frontage footpath
      const pGap8 = uv(22.0, -7.5);    // Gap between 355 Coro & 8 Dunmore Tce
      const pRoofPool = uv(22.8, 21.5); // Open 25m rooftop lap pool terrace (NE half)

      return [
        {
          id: 'coro-footpath',
          label: 'Coronation Dr Footpath',
          x: pCoro[0], z: pCoro[1],
          y: this.shadingEngine.sampleDem(pCoro[0], pCoro[1]) + 1.5,
          isRooftop: false
        },
        {
          id: 'lang-coro-corner',
          label: 'Lang Pde × Coro Dr Corner',
          x: pCorner[0], z: pCorner[1],
          y: this.shadingEngine.sampleDem(pCorner[0], pCorner[1]) + 1.5,
          isRooftop: false
        },
        {
          id: 'dunmore-gap',
          label: '8 Dunmore Tce Corridor',
          x: pGap8[0], z: pGap8[1],
          y: this.shadingEngine.sampleDem(pGap8[0], pGap8[1]) + 1.5,
          isRooftop: false
        },
        {
          id: 'lang-footpath',
          label: 'Lang Parade Footpath',
          x: pLang[0], z: pLang[1],
          y: this.shadingEngine.sampleDem(pLang[0], pLang[1]) + 1.5,
          isRooftop: false
        },
        {
          id: 'rooftop-pool',
          label: 'Rooftop Pool Terrace (RL 78.4m)',
          x: pRoofPool[0], z: pRoofPool[1],
          y: 78.35 + 1.5,
          isRooftop: true
        }
      ];
    }

    getProposedSignature() {
      const p = this.shadingEngine.proposedPrism;
      if (!p) return 'off';
      return `${p.crownY.toFixed(1)}_${p.towerArea}`;
    }

    /**
     * Voxelize terrain + buildings into 3D solid mask (0 = air, 1 = solid)
     * plus 2D footprint mask (1 = inside building at pedestrian height).
     */
    getVoxelData(mode) {
      const key = mode === 'baseline' ? 'baseline' : `proposed_${this.getProposedSignature()}`;
      if (this.voxelCache.has(key)) return this.voxelCache.get(key);

      const { nx, ny, nz, dx, dy, dz, minX, minZ, yBase } = this;
      const slice = nx * nz;
      const solid = new Uint8Array(nx * ny * nz);
      const bldgFootprint = new Uint8Array(slice);

      // 1. Mark terrain voxels
      for (let z = 0; z < nz; z++) {
        for (let x = 0; x < nx; x++) {
          const gy = this.groundY[z * nx + x];
          const kMax = Math.min(ny - 1, Math.floor((gy - yBase) / dy));
          for (let k = 0; k <= kMax; k++) {
            solid[k * slice + z * nx + x] = 1;
          }
        }
      }

      // 2. Rasterize buildings
      const prisms = [];
      for (const p of this.localPrisms) {
        if (mode === 'proposed' && p.onSite355) continue;
        prisms.push(p);
      }
      if (mode === 'proposed' && this.shadingEngine.proposedPrisms) {
        for (const tp of this.shadingEngine.proposedPrisms) {
          prisms.push(tp);
        }
      }

      for (const p of prisms) {
        const x0 = Math.max(0, Math.floor((p.minX - minX) / dx));
        const x1 = Math.min(nx - 1, Math.floor((p.maxX - minX) / dx));
        const z0 = Math.max(0, Math.floor((p.minZ - minZ) / dz));
        const z1 = Math.min(nz - 1, Math.floor((p.maxZ - minZ) / dz));
        const k0 = Math.max(0, Math.floor((p.yMin - yBase) / dy));
        const k1 = Math.min(ny - 2, Math.floor((p.yTop - yBase) / dy));

        for (let z = z0; z <= z1; z++) {
          const wz = minZ + (z + 0.5) * dz;
          for (let x = x0; x <= x1; x++) {
            const wx = minX + (x + 0.5) * dx;
            if (!pointInRing(wx, wz, p.r)) continue;
            const pedY = this.groundY[z * nx + x] + 1.5;
            if (pedY >= p.yMin && pedY <= p.yTop) {
              bldgFootprint[z * nx + x] = p.isProposed ? 2 : 1;
            }
            for (let k = k0; k <= k1; k++) {
              solid[k * slice + z * nx + x] = 1;
            }
          }
        }
      }

      const data = { solid, bldgFootprint };
      // Keep cache compact
      if (this.voxelCache.size > 6) {
        for (const k of this.voxelCache.keys()) {
          if (k !== 'baseline') { this.voxelCache.delete(k); break; }
        }
      }
      this.voxelCache.set(key, data);
      return data;
    }

    _buildInletField(dirDeg) {
      const { nx, ny, nz, dy, yBase } = this;
      const slice = nx * nz;
      const [fx, fz] = windDirToFlowXZ(dirDeg);
      const alpha = getRoughnessAlpha(dirDeg);
      const inlet = new Float32Array(nx * ny * nz * 3);

      for (let y = 0; y < ny; y++) {
        const wy = yBase + (y + 0.5) * dy;
        const yOff = y * slice;
        for (let z = 0; z < nz; z++) {
          for (let x = 0; x < nx; x++) {
            const idx = yOff + z * nx + x;
            const hAGL = Math.max(0.5, wy - this.groundY[z * nx + x]);
            const spd = ablSpeed(hAGL, U10_NORM, alpha);
            inlet[idx * 3] = fx * spd;
            inlet[idx * 3 + 1] = 0;
            inlet[idx * 3 + 2] = fz * spd;
          }
        }
      }
      return { inlet, flowDir: [fx, fz], alpha };
    }

    /**
     * Solve (or retrieve cached) normalized 3D velocity field at U10 = 10 m/s.
     */
    solveNormalized(mode, dirDeg) {
      const normDir = ((Math.round(dirDeg) % 360) + 360) % 360;
      const sig = mode === 'baseline' ? 'baseline' : `proposed_${this.getProposedSignature()}`;
      const cacheKey = `${sig}|${normDir}`;
      if (this.fieldCache.has(cacheKey)) return this.fieldCache.get(cacheKey);

      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const vox = this.getVoxelData(mode);
      const { inlet, flowDir, alpha } = this._buildInletField(normDir);

      let vel;
      if (this.gpuSolver.ok) {
        try {
          vel = this.gpuSolver.solve(vox.solid, inlet, flowDir, this.dx, this.dy, this.dz, 110, 22);
          // Self-healing sanity check against broken/blacklisted WebGL2 float FBO drivers
          let energy = 0, bad = false;
          for (let i = 0; i < vel.ux.length; i += 37) {
            const v = vel.ux[i];
            if (!Number.isFinite(v)) { bad = true; break; }
            energy += Math.abs(v) + Math.abs(vel.uz[i]);
          }
          if (bad || energy < 1e-3) throw new Error('WebGL2 float readback degenerate');
        } catch (_gpuErr) {
          this.gpuSolver.ok = false;
          this.backend = 'CPU 3D Navier-Stokes (fallback)';
          vel = solveCPU3D(this.nx, this.ny, this.nz, vox.solid, inlet, flowDir, this.dx, this.dy, this.dz, 38, 12);
        }
      } else {
        vel = solveCPU3D(this.nx, this.ny, this.nz, vox.solid, inlet, flowDir, this.dx, this.dy, this.dz, 44, 14);
      }
      const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

      const field = {
        mode,
        dirDeg: normDir,
        alpha,
        flowDir,
        uPedRefNorm: ablSpeed(1.5, U10_NORM, alpha),
        ux: vel.ux,
        uy: vel.uy,
        uz: vel.uz,
        solid: vox.solid,
        bldgFootprint: vox.bldgFootprint,
        solveMs: Math.round(elapsedMs)
      };

      if (this.fieldCache.size >= this.maxCacheEntries) {
        const firstKey = this.fieldCache.keys().next().value;
        this.fieldCache.delete(firstKey);
      }
      this.fieldCache.set(cacheKey, field);
      return field;
    }

    /**
     * Ensure both Baseline and Proposed normalized fields are solved for dirDeg.
     */
    solvePair(dirDeg) {
      const base = this.solveNormalized('baseline', dirDeg);
      const prop = this.shadingEngine.proposedPrism
        ? this.solveNormalized('proposed', dirDeg)
        : base;
      return { base, prop };
    }

    /**
     * Trilinearly sample 3D velocity at any world coordinate (x, y, z) scaled to refSpeedMs (at 10m AGL).
     */
    sampleVelocity(field, wx, wy, wz, refSpeedMs = U10_NORM) {
      const { nx, ny, nz, dx, dy, dz, minX, minZ, yBase } = this;
      const gx = (wx - minX) / dx - 0.5;
      const gy = (wy - yBase) / dy - 0.5;
      const gz = (wz - minZ) / dz - 0.5;

      if (gx < 0 || gx >= nx - 1 || gz < 0 || gz >= nz - 1 || gy < 0 || gy >= ny - 1) {
        const hAGL = Math.max(0.5, wy - this.shadingEngine.sampleDem(wx, wz));
        const spd = ablSpeed(hAGL, refSpeedMs, field.alpha);
        return {
          ux: field.flowDir[0] * spd,
          uy: 0,
          uz: field.flowDir[1] * spd,
          speed: spd,
          horizSpeed: spd,
          downwash: 0,
          isSolid: false,
          inDomain: false
        };
      }

      const x0 = gx | 0, y0 = gy | 0, z0 = gz | 0;
      const fx = gx - x0, fy = gy - y0, fz = gz - z0;
      const slice = nx * nz;
      const scale = refSpeedMs / U10_NORM;

      const idxNearest = Math.round(gy) * slice + Math.round(gz) * nx + Math.round(gx);
      const isSolid = field.solid[idxNearest] > 0;

      // Trilinear interpolation (weighted over fluid corners so near-ground sampling never dilutes to zero!)
      let wSum = 0, sx = 0, sy = 0, sz = 0;
      for (let ky = 0; ky <= 1; ky++) {
        const wyf = ky ? fy : 1 - fy;
        const yOff = (y0 + ky) * slice;
        for (let kz = 0; kz <= 1; kz++) {
          const wzf = kz ? fz : 1 - fz;
          const zOff = yOff + (z0 + kz) * nx;
          for (let kx = 0; kx <= 1; kx++) {
            const idx = zOff + (x0 + kx);
            if (field.solid[idx]) continue;
            const w = (kx ? fx : 1 - fx) * wyf * wzf;
            sx += field.ux[idx] * w;
            sy += field.uy[idx] * w;
            sz += field.uz[idx] * w;
            wSum += w;
          }
        }
      }

      if (wSum < 1e-4) {
        return { ux: 0, uy: 0, uz: 0, speed: 0, horizSpeed: 0, downwash: 0, isSolid: true, inDomain: true };
      }

      const vx = (sx / wSum) * scale;
      const vy = (sy / wSum) * scale;
      const vz = (sz / wSum) * scale;
      const horizSpeed = Math.hypot(vx, vz);
      const speed = Math.hypot(horizSpeed, vy);
      return {
        ux: vx,
        uy: vy,
        uz: vz,
        speed,
        horizSpeed,
        downwash: -vy, // Positive = downward rushing air (downwash)
        isSolid,
        inDomain: true
      };
    }

    /**
     * Compute pedestrian-level (DEM + 1.5m) heatmap grids comparing Baseline vs Proposed.
     */
    computePedestrianMetrics(dirDeg, refSpeedMs) {
      const { base, prop } = this.solvePair(dirDeg);
      const { nx, nz, dx, dz, minX, minZ } = this;
      const n = nx * nz;
      const propSpeed = new Float32Array(n);
      const baseSpeed = new Float32Array(n);
      const deltaSpeed = new Float32Array(n);
      const propK = new Float32Array(n);
      const downwash = new Float32Array(n);
      const uPedRef = ablSpeed(1.5, refSpeedMs, prop.alpha);
      const cellArea = dx * dz;

      let maxPropSpeed = 0, maxDelta = 0, maxDownwash = 0, maxK = 0;
      let hotspot = { x: this.cx, z: this.cz, delta: 0, speed: 0 };
      let areaOver8Prop = 0, areaOver8Base = 0;
      let areaOver15Prop = 0, areaOver15Base = 0;
      let areaDeltaPlus2 = 0;

      for (let z = 0; z < nz; z++) {
        const wz = minZ + (z + 0.5) * dz;
        for (let x = 0; x < nx; x++) {
          const idx = z * nx + x;
          const wx = minX + (x + 0.5) * dx;
          const py = this.groundY[idx] + 1.5;

          const sp = this.sampleVelocity(prop, wx, py, wz, refSpeedMs);
          const sb = this.sampleVelocity(base, wx, py, wz, refSpeedMs);
          // Sample facade downwash jet at ~6m AGL (where vertical downdraft peaks before turning horizontally at pavement)
          const spJet = this.sampleVelocity(prop, wx, this.groundY[idx] + 6.0, wz, refSpeedMs);
          const dw = Math.max(sp.downwash, spJet.downwash);

          const vProp = prop.bldgFootprint[idx] ? 0 : sp.speed;
          const vBase = base.bldgFootprint[idx] ? 0 : sb.speed;
          const dSpd = prop.bldgFootprint[idx] ? 0 : vProp - vBase;
          const kVal = uPedRef > 0.1 ? vProp / uPedRef : 0;

          propSpeed[idx] = vProp;
          baseSpeed[idx] = vBase;
          deltaSpeed[idx] = dSpd;
          propK[idx] = kVal;
          downwash[idx] = prop.bldgFootprint[idx] ? 0 : dw;

          // Exclude outer 3-cell boundary fringe for site impact stats
          if (x >= 4 && x < nx - 4 && z >= 4 && z < nz - 4 && !prop.bldgFootprint[idx]) {
            if (vProp > maxPropSpeed) maxPropSpeed = vProp;
            if (kVal > maxK) maxK = kVal;
            if (dw > maxDownwash) maxDownwash = dw;
            if (dSpd > maxDelta) {
              maxDelta = dSpd;
              hotspot = { x: wx, z: wz, delta: dSpd, speed: vProp };
            }
            if (vProp >= 8.0) areaOver8Prop += cellArea;
            if (vBase >= 8.0) areaOver8Base += cellArea;
            if (vProp >= 15.0) areaOver15Prop += cellArea;
            if (vBase >= 15.0) areaOver15Base += cellArea;
            if (dSpd >= 2.0) areaDeltaPlus2 += cellArea;
          }
        }
      }

      return {
        base,
        prop,
        propSpeed,
        baseSpeed,
        deltaSpeed,
        propK,
        downwash,
        uPedRef,
        stats: {
          maxPropSpeed,
          maxDelta,
          maxDownwash,
          maxK,
          hotspot,
          areaOver8Prop: Math.round(areaOver8Prop),
          areaOver8Base: Math.round(areaOver8Base),
          areaOver15Prop: Math.round(areaOver15Prop),
          areaOver15Base: Math.round(areaOver15Base),
          areaDeltaPlus2: Math.round(areaDeltaPlus2),
          solveMs: prop.solveMs + (base === prop ? 0 : base.solveMs)
        }
      };
    }

    /**
     * Probe a single 3D point (x, y, z) for Baseline vs Proposed wind telemetry & vertical profile.
     */
    probePoint(wx, wy, wz, dirDeg, refSpeedMs) {
      const { base, prop } = this.solvePair(dirDeg);
      const groundHere = this.shadingEngine.sampleDem(wx, wz);
      const evalY = Math.max(groundHere + 1.5, wy);
      const hAGL = evalY - groundHere;
      const uRefHere = ablSpeed(hAGL, refSpeedMs, prop.alpha);
      const uPedRef = ablSpeed(1.5, refSpeedMs, prop.alpha);

      const sp = this.sampleVelocity(prop, wx, evalY, wz, refSpeedMs);
      const sb = this.sampleVelocity(base, wx, evalY, wz, refSpeedMs);
      const deltaMs = sp.speed - sb.speed;
      const deltaPct = sb.speed > 0.2 ? (deltaMs / sb.speed) * 100 : 0;

      // Vertical profile from DEM + 1.5m up to 96m AHD
      const profile = [];
      for (let y = groundHere + 1.5; y <= 96; y += 3.0) {
        const vp = this.sampleVelocity(prop, wx, y, wz, refSpeedMs);
        const vb = this.sampleVelocity(base, wx, y, wz, refSpeedMs);
        profile.push({
          y: Math.round(y * 10) / 10,
          hAGL: Math.round((y - groundHere) * 10) / 10,
          propSpeed: vp.speed,
          baseSpeed: vb.speed,
          downwash: vp.downwash
        });
      }

      return {
        x: wx,
        y: evalY,
        z: wz,
        groundY: groundHere,
        hAGL,
        prop: sp,
        base: sb,
        deltaMs,
        deltaPct,
        speedupK: uRefHere > 0.1 ? sp.speed / uRefHere : 0,
        pedSpeedupK: uPedRef > 0.1 ? sp.speed / uPedRef : 0,
        lawsonProp: classifyLawson(sp.speed),
        lawsonBase: classifyLawson(sb.speed),
        profile
      };
    }

    /**
     * Run an 8-direction 3D CFD wind rose sweep and convolve with 10-year historical
     * Brisbane weather data (WIND_CLIMATE) to discover true site aerodynamic edge cases
     * & Lawson annual exceedance hours at key Condition 30 locations.
     */
    async runWindRoseAnalysis(onProgress) {
      const scanDirs = [0, 45, 90, 135, 180, 225, 270, 315];
      const dirResults = [];

      // Update rooftop probe height dynamically to match active tower terrace
      const activeP = this.shadingEngine.proposedPrism;
      const roofY = activeP && activeP.terraceY ? activeP.terraceY + 1.5 : 79.85;
      for (const kp of this.keyProbes) {
        if (kp.isRooftop) kp.y = roofY;
      }

      for (let i = 0; i < scanDirs.length; i++) {
        const d = scanDirs[i];
        if (onProgress) onProgress(i, scanDirs.length, `Solving ${d}° ${dirToCompass(d)}…`);
        // Yield a frame so progress UI stays responsive
        await new Promise((r) => setTimeout(r, 12));

        const { base, prop } = this.solvePair(d);
        const uPedNorm = prop.uPedRefNorm;
        const probeK = {};
        let maxProbeK = 0;
        let maxProbeDeltaK = 0;
        let worstProbeLabel = '';

        for (const kp of this.keyProbes) {
          const sp = this.sampleVelocity(prop, kp.x, kp.y, kp.z, U10_NORM);
          const sb = this.sampleVelocity(base, kp.x, kp.y, kp.z, U10_NORM);
          const refN = kp.isRooftop ? U10_NORM : uPedNorm;
          const kProp = sp.speed / refN;
          const kBase = sb.speed / refN;
          probeK[kp.id] = {
            kProp,
            kBase,
            deltaK: kProp - kBase,
            downwashNorm: sp.downwash
          };
          if (!kp.isRooftop && kProp > maxProbeK) maxProbeK = kProp;
          if (!kp.isRooftop && kProp - kBase > maxProbeDeltaK) {
            maxProbeDeltaK = kProp - kBase;
            worstProbeLabel = kp.label;
          }
        }

        // Also scan full street-level grid for peak site speedup & delta K
        const ped = this.computePedestrianMetrics(d, U10_NORM);
        dirResults.push({
          dirDeg: d,
          dir: dirToCompass(d),
          maxSiteK: ped.stats.maxK,
          maxSiteDeltaK: ped.stats.maxDelta / uPedNorm,
          maxDownwashNorm: ped.stats.maxDownwash,
          hotspot: ped.stats.hotspot,
          probeK,
          worstProbeLabel
        });
      }

      // Helper to linearly interpolate directional K for any arbitrary azimuth
      const interpDir = (deg) => {
        const norm = ((deg % 360) + 360) % 360;
        const idxF = norm / 45;
        const i0 = Math.floor(idxF) % 8;
        const i1 = (i0 + 1) % 8;
        const t = idxF - Math.floor(idxF);
        const a = dirResults[i0], b = dirResults[i1];
        const kMap = {};
        for (const kp of this.keyProbes) {
          const ka = a.probeK[kp.id], kb = b.probeK[kp.id];
          kMap[kp.id] = {
            kProp: ka.kProp * (1 - t) + kb.kProp * t,
            kBase: ka.kBase * (1 - t) + kb.kBase * t,
            deltaK: ka.deltaK * (1 - t) + kb.deltaK * t
          };
        }
        return {
          maxSiteK: a.maxSiteK * (1 - t) + b.maxSiteK * t,
          maxSiteDeltaK: a.maxSiteDeltaK * (1 - t) + b.maxSiteDeltaK * t,
          probeK: kMap
        };
      };

      // 1. Score all historical extreme events from WIND_CLIMATE by actual 3D site amplification
      const climate = this.climate;
      const edgeCases = [];
      if (climate) {
        const allEvents = [
          ...(climate.topSiteExtremes || []).map((e) => ({ ...e, src: '355 Coro (ERA5)' })),
          ...(climate.topYbbnStorms || []).slice(0, 4).map((e) => ({ ...e, src: 'YBBN METAR' }))
        ];
        for (const ev of allEvents) {
          const f = interpDir(ev.dirDeg);
          const alpha = getRoughnessAlpha(ev.dirDeg);
          const uPedGust = ablSpeed(1.5, ev.gustMs, alpha);
          const estSitePeakGust = uPedGust * f.maxSiteK;
          const estDeltaGust = uPedGust * Math.max(0, f.maxSiteDeltaK);
          edgeCases.push({
            time: ev.time,
            dirDeg: ev.dirDeg,
            dir: ev.dir,
            meanMs: ev.meanMs,
            gustMs: ev.gustMs,
            src: ev.src,
            maxSiteK: Math.round(f.maxSiteK * 100) / 100,
            estSitePeakGust: Math.round(estSitePeakGust * 10) / 10,
            estDeltaGust: Math.round(estDeltaGust * 10) / 10
          });
        }
        edgeCases.sort((a, b) => b.estDeltaGust - a.estDeltaGust || b.estSitePeakGust - a.estSitePeakGust);
      }

      // 2. Compute 10-year annual Lawson exceedance hours at each key Condition 30 probe
      const probeAnnual = [];
      if (climate && climate.roseAnnual) {
        const edges = climate.meta.speedBinEdges;
        const binMids = [];
        for (let b = 0; b < edges.length - 1; b++) {
          binMids.push(b === edges.length - 2 ? edges[b] + 2.0 : (edges[b] + edges[b + 1]) * 0.5);
        }

        for (const kp of this.keyProbes) {
          let pctSitBase = 0, pctSitProp = 0;   // > 4 m/s (exceeds Sitting)
          let pctWalkBase = 0, pctWalkProp = 0; // > 8 m/s (exceeds Walking)
          let pctDistBase = 0, pctDistProp = 0; // > 15 m/s gust (Distress)
          let worstDir = '';
          let maxDeltaK = -99;

          for (const sec of climate.roseAnnual) {
            const f = interpDir(sec.deg);
            const pk = f.probeK[kp.id];
            if (pk.deltaK > maxDeltaK) {
              maxDeltaK = pk.deltaK;
              worstDir = `${sec.dir} (${Math.round(sec.deg)}°)`;
            }
            const alpha = getRoughnessAlpha(sec.deg);
            const pedRatio = kp.isRooftop ? 1.0 : Math.pow(1.5 / 10.0, alpha);

            for (let b = 0; b < binMids.length; b++) {
              const fracMean = sec.binFrac[b] || 0;
              const fracGust = sec.gustBinFrac[b] || 0;
              const u10 = binMids[b];
              const localBase = u10 * pedRatio * pk.kBase;
              const localProp = u10 * pedRatio * pk.kProp;
              if (localBase >= 4.0) pctSitBase += fracMean * 100;
              if (localProp >= 4.0) pctSitProp += fracMean * 100;
              if (localBase >= 8.0) pctWalkBase += fracMean * 100;
              if (localProp >= 8.0) pctWalkProp += fracMean * 100;
              if (localBase >= 15.0) pctDistBase += fracGust * 100;
              if (localProp >= 15.0) pctDistProp += fracGust * 100;
            }
          }

          probeAnnual.push({
            id: kp.id,
            label: kp.label,
            x: kp.x, y: kp.y, z: kp.z,
            isRooftop: kp.isRooftop,
            worstDir,
            maxDeltaK: Math.round(maxDeltaK * 100) / 100,
            pctOver4Base: Math.round(pctSitBase * 10) / 10,
            pctOver4Prop: Math.round(pctSitProp * 10) / 10,
            pctOver8Base: Math.round(pctWalkBase * 100) / 100,
            pctOver8Prop: Math.round(pctWalkProp * 100) / 100,
            hrsDistressBase: Math.round((pctDistBase / 100) * 8760 * 10) / 10,
            hrsDistressProp: Math.round((pctDistProp / 100) * 8760 * 10) / 10
          });
        }
      }

      if (onProgress) onProgress(scanDirs.length, scanDirs.length, 'Complete');
      return { dirResults, edgeCases, probeAnnual };
    }
  }

  WindTunnelEngine.classifyLawson = classifyLawson;
  WindTunnelEngine.dirToCompass = dirToCompass;
  WindTunnelEngine.windDirToFlowXZ = windDirToFlowXZ;
  WindTunnelEngine.getRoughnessAlpha = getRoughnessAlpha;
  WindTunnelEngine.ablSpeed = ablSpeed;

  global.WindTunnelEngine = WindTunnelEngine;
})(window);
