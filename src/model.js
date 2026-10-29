(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});
  var S = ML.sounding;

  var G = 9.80665, CP = 1004.5, RD = 287.05, RV = 461.5, EPS = RD / RV;
  var LV = 2.501e6;

  var ES_T0 = 150, ES_DT = 0.1, ES_N = 2101;
  var ES = new Float32Array(ES_N);
  (function () {
    for (var i = 0; i < ES_N; i++) {
      var Tc = ES_T0 + i * ES_DT - 273.15;
      ES[i] = 611.2 * Math.exp(17.67 * Tc / (Tc + 243.5));
    }
  })();

  function qsatFast(T, p) {
    var f = (T - ES_T0) / ES_DT;
    if (f < 0) f = 0;
    if (f > ES_N - 1.001) f = ES_N - 1.001;
    var i = f | 0, a = f - i;
    var es = ES[i] * (1 - a) + ES[i + 1] * a;
    if (es > 0.99 * p) es = 0.99 * p;
    return EPS * es / (p - es);
  }

  var GRID_CFG = {
    48: { nz: 36, dz: 340, dt: 3, sor: 30 },
    80: { nz: 28, dz: 440, dt: 3.5, sor: 22 },
    120: { nz: 16, dz: 760, dt: 4, sor: 14 }
  };

  function Model(profile, opts) {
    opts = opts || {};
    this.nx = opts.nx || 48;
    this.ny = opts.ny || 48;
    var cfg = GRID_CFG[this.nx >= 100 ? 120 : (this.nx >= 70 ? 80 : 48)];
    this.nz = opts.nz || cfg.nz;
    this.dx = 1000; this.dy = 1000;
    this.dz = (opts.dz || cfg.dz);
    var nx = this.nx, ny = this.ny, nz = this.nz;
    var n = nx * ny * nz;
    this.n = n;
    this.dt = opts.dt || cfg.dt;
    this.stepMs = 0;
    this.time = 0;
    this.stepCount = 0;
    this.seedMode = opts.mode || 'single';
    this.seedCount = opts.count || 1;
    this.heating = opts.heating === undefined ? 0.5 : opts.heating;
    this.heatPeriod = opts.heatPeriod || 150;
    this._heatTimer = 40;
    this._seed = opts.seed || 987654321;
    this.iceActive = false;
    this.rainActive = false;
    this.xmax = nx * this.dx;
    this.ymax = ny * this.dy;
    this.zmax = nz * this.dz;


    this.zc = new Float32Array(nz);
    for (var k = 0; k < nz; k++) this.zc[k] = (k + 0.5) * this.dz;

    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.w = new Float32Array(n);
    this.uf = new Float32Array(n);
    this.vf = new Float32Array(n);
    this.wf = new Float32Array(n);
    this.bf = new Float32Array(n);
    this.th = new Float32Array(n);
    this.qv = new Float32Array(n);
    this.qc = new Float32Array(n);
    this.qr = new Float32Array(n);
    this.qi = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.flux = new Float32Array(n);
    this.p2 = new Float32Array(n);
    this.div = new Float32Array(n);
    this.acc = new Float32Array(nx * ny);
    this.sfcRain = new Float32Array(nx * ny);
    this.colMaxZ = new Float32Array(nx * ny);
    this.colDbz = new Float32Array(nx * ny);
    this.colUH = new Float32Array(nx * ny);
    this.visited = new Uint8Array(nx * ny);
    this.stack = new Int32Array(nx * ny);
    this.mesoField = new Float32Array(nx * ny);
    this.colWmax = new Float32Array(nx * ny);
    this.mesoVisited = new Uint8Array(nx * ny);
    this.mesoStack = new Int32Array(nx * ny);
    this._mesoPrev = [];

    this.th0 = new Float32Array(nz);
    this.p0 = new Float32Array(nz);
    this.pi0 = new Float32Array(nz);
    this.qv0 = new Float32Array(nz);
    this.rho0 = new Float32Array(nz);
    this.u0 = new Float32Array(nz);
    this.v0 = new Float32Array(nz);
    this.T0 = new Float32Array(nz);

    this.depIdx = new Int32Array(n * 8);
    this.depW = new Float32Array(n * 8);

    this.nb = this._buildNeighbours();
    this._uh = 0;
    this.pressureIters = this.nx >= 100 ? 16 : 30;
    this.t1 = new Float32Array(n);
    this.t2 = new Float32Array(n);
    this.t3 = new Float32Array(n);
    this.t4 = new Float32Array(n);
    this.t5 = new Float32Array(n);
    this.t6 = new Float32Array(n);
    this.t7 = new Float32Array(n);
    this.t8 = new Float32Array(n);

    this.diag = {
      maxW: 0, minW: 0, cloudTop: 0, iceTop: 0, maxDBZ: 0, rainRate: 0,
      coldPool: 0, uh: 0, updraftArea: 0, cells: 0, regime: '—', mesocyclones: []
    };

    this.setProfile(profile, opts);
  }

  Model.prototype._buildNeighbours = function () {
    var nx = this.nx, ny = this.ny, nz = this.nz, n = this.n;
    var xp = new Int32Array(n), xm = new Int32Array(n);
    var yp = new Int32Array(n), ym = new Int32Array(n);
    var zp = new Int32Array(n), zm = new Int32Array(n);
    var c = 0;
    for (var k = 0; k < nz; k++) {
      for (var j = 0; j < ny; j++) {
        for (var i = 0; i < nx; i++, c++) {
          xp[c] = i === nx - 1 ? c - (nx - 1) : c + 1;
          xm[c] = i === 0 ? c + (nx - 1) : c - 1;
          yp[c] = j === ny - 1 ? c - nx * (ny - 1) : c + nx;
          ym[c] = j === 0 ? c + nx * (ny - 1) : c - nx;
          zp[c] = k === nz - 1 ? c : c + nx * ny;
          zm[c] = k === 0 ? c : c - nx * ny;
        }
      }
    }
    var nxny = nx * ny;
    var xp2 = new Int32Array(n), xm2 = new Int32Array(n);
    var yp2 = new Int32Array(n), ym2 = new Int32Array(n);
    var zp2 = new Int32Array(n), zm2 = new Int32Array(n);
    for (c = 0; c < n; c++) {
      xp2[c] = xp[xp[c]];
      xm2[c] = xm[xm[c]];
      yp2[c] = yp[yp[c]];
      ym2[c] = ym[ym[c]];
      var zpv = c + 2 * nxny;
      var zmv = c - 2 * nxny;
      zp2[c] = zpv >= n ? n - 1 : zpv;
      zm2[c] = zmv < 0 ? 0 : zmv;
    }
    return {
      xp: xp, xm: xm, yp: yp, ym: ym, zp: zp, zm: zm,
      xp2: xp2, xm2: xm2, yp2: yp2, ym2: ym2, zp2: zp2, zm2: zm2
    };
  };

  Model.prototype.setProfile = function (profile, opts) {
    opts = opts || {};
    this.profile = profile;
    var nz = this.nz, nx = this.nx, ny = this.ny, n = this.n;
    var mo = profile.storm;
    for (var k = 0; k < nz; k++) {
      var z = this.zc[k];
      var T = S.interpAt(profile.T, profile.z, z);
      var p = S.interpAt(profile.p, profile.z, z);
      var qv = S.interpAt(profile.qv, profile.z, z);
      this.p0[k] = p;
      this.pi0[k] = Math.pow(p / S.P0, RD / CP);
      this.th0[k] = T / this.pi0[k];
      this.T0[k] = T;
      this.qv0[k] = qv;
      this.rho0[k] = p / (RD * T * (1 + 0.608 * qv));
      this.u0[k] = S.interpAt(profile.u, profile.z, z) - mo.u;
      this.v0[k] = S.interpAt(profile.v, profile.z, z) - mo.v;
    }

    var seed = 1234567;
    function rnd() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    var c = 0;
    for (var kk = 0; kk < nz; kk++) {
      for (var j = 0; j < ny; j++) {
        for (var i = 0; i < nx; i++, c++) {
          this.uf[c] = this.u0[kk];
          this.vf[c] = this.v0[kk];
          this.wf[c] = 0;
          this.u[c] = this.u0[kk];
          this.v[c] = this.v0[kk];
          this.w[c] = 0;
          this.th[c] = this.th0[kk];
          this.qv[c] = this.qv0[kk];
          this.qc[c] = 0;
          this.qr[c] = 0;
          this.qi[c] = 0;
          if (this.zc[kk] < 2500) this.th[c] += (rnd() - 0.5) * 0.08;
        }
      }
    }
    this.p2.fill(0);
    this.acc.fill(0);
    this.sfcRain.fill(0);
    this.time = 0;
    this.stepCount = 0;
    this.trigger(opts.bubble || 2.6);
    this._deriveCenters();
  };

  Model.prototype._deriveCenters = function () {
    var n = this.n, nxny = this.nx * this.ny, nz = this.nz;
    var uf = this.uf, vf = this.vf, wf = this.wf;
    var u = this.u, v = this.v, w = this.w;
    var nb = this.nb, xp = nb.xp, yp = nb.yp;
    for (var c = 0; c < n; c++) {
      u[c] = 0.5 * (uf[c] + uf[xp[c]]);
      v[c] = 0.5 * (vf[c] + vf[yp[c]]);
      var k = (c / nxny) | 0;
      w[c] = k === nz - 1 ? 0.5 * wf[c] : 0.5 * (wf[c] + wf[c + nxny]);
    }
  };

  Model.prototype._rnd = function () {
    this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff;
    return this._seed / 0x7fffffff;
  };

  Model.prototype._bubble = function (xc, yc, zc, R, Rz, amp) {
    var nx = this.nx, ny = this.ny, nz = this.nz;
    var qSurf = this.qv0[0];
    var c = 0;
    var kMin = Math.max(0, Math.floor((zc - 3.2 * Rz) / this.dz));
    var kMax = Math.min(nz - 1, Math.ceil((zc + 3.2 * Rz) / this.dz));
    for (var k = 0; k < nz; k++) {
      var dz2 = (this.zc[k] - zc) / Rz;
      var use = k >= kMin && k <= kMax;
      for (var j = 0; j < ny; j++) {
        var y = (j + 0.5) * this.dy;
        if (!use) { c += nx; continue; }
        var dy2 = (y - yc) * (y - yc);
        for (var i = 0; i < nx; i++, c++) {
          var x = (i + 0.5) * this.dx;
          var r2 = (dy2 + (x - xc) * (x - xc)) / (R * R);
          var g = Math.exp(-r2 - dz2 * dz2);
          if (g < 0.02) continue;
          this.th[c] += amp * g;
          var dq = (qSurf - this.qv[c]) * 0.9;
          if (dq > 0) this.qv[c] += dq * g;
        }
      }
    }
  };

  Model.prototype.trigger = function (amp) {
    this._seed = 987654321 + this.seedCount * 7919;
    var mode = this.seedMode;
    if (mode === 'field') {
      var count = this.seedCount > 1 ? this.seedCount : 7;
      for (var n = 0; n < count; n++) {
        var xc = (0.12 + 0.76 * this._rnd()) * this.xmax;
        var yc = (0.12 + 0.76 * this._rnd()) * this.ymax;
        var R = 3500 + 3500 * this._rnd();
        var a = amp * (0.55 + 0.85 * this._rnd());
        this._bubble(xc, yc, 700 + 900 * this._rnd(), R, 1100, a);
      }
    } else if (mode === 'line') {
      var cnt = this.seedCount > 1 ? this.seedCount : 7;
      var y0 = this.ymax * 0.5;
      for (var m = 0; m < cnt; m++) {
        var xl = this.xmax * (0.14 + 0.72 * m / Math.max(1, cnt - 1));
        var yl = y0 + (this._rnd() - 0.5) * 3000;
        this._bubble(xl, yl, 1100, 4200, 1500, amp * (0.8 + 0.4 * this._rnd()));
      }
    } else {
      this._bubble(this.xmax * 0.5, this.ymax * 0.5, 1200, 9000, 1800, amp);
    }
  };

  Model.prototype._heatSurface = function (dt) {
    if (this.heating <= 0) return;
    this._heatTimer -= dt;
    if (this._heatTimer > 0) return;
    this._heatTimer = this.heatPeriod * (0.6 + 0.8 * this._rnd());
    var nx = this.nx, ny = this.ny;
    var i0 = 1 + Math.floor(this._rnd() * (nx - 2));
    var j0 = 1 + Math.floor(this._rnd() * (ny - 2));
    var R = (2500 + 3500 * this._rnd()) / this.dx;
    var amp = (0.5 + 1.1 * this._rnd()) * this.heating;
    var qSurf = this.qv0[0];
    var reach = Math.ceil(R * 2.5);
    for (var k = 0; k < 3; k++) {
      var zf = Math.exp(-(k + 0.5) * this.dz / 800);
      for (var dj = -reach; dj <= reach; dj++) {
        for (var di = -reach; di <= reach; di++) {
          var i = ((i0 + di) % nx + nx) % nx;
          var j = ((j0 + dj) % ny + ny) % ny;
          var g = Math.exp(-(di * di + dj * dj) / (R * R)) * zf;
          if (g < 0.02) continue;
          var c = i + nx * (j + ny * k);
          this.th[c] += amp * g;
          var dq = (qSurf - this.qv[c]) * 0.5;
          if (dq > 0) this.qv[c] += dq * g;
          if (this.wf[c] < 0) this.wf[c] *= 1 - 0.3 * g;
        }
      }
    }
  };

  Model.prototype._countCells = function () {
    var nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny;
    var w = this.w, qc = this.qc, qi = this.qi;
    var visited = this.visited, stack = this.stack;
    visited.fill(0);
    var active = 0;
    var kLo = Math.max(0, Math.round(1500 / this.dz));
    var kHi = Math.min(nz - 1, Math.round(8000 / this.dz));
    for (var col = 0; col < nxny; col++) {
      var hot = 0;
      for (var k = kLo; k <= kHi; k++) {
        var c = col + nxny * k;
        if (w[c] > 3 && (qc[c] + qi[c]) > 2e-5) { hot = 1; break; }
      }
      if (hot) visited[col] = 1;
      else visited[col] = 0;
      active += visited[col];
    }
    var cells = 0, biggest = 0;
    var centres = [];
    for (var start = 0; start < nxny; start++) {
      if (visited[start] !== 1) continue;
      var sp = 0;
      stack[sp++] = start;
      visited[start] = 2;
      var size = 0, si = 0, sj = 0;
      while (sp > 0) {
        var cur = stack[--sp];
        size++;
        si += cur % nx;
        sj += (cur / nx) | 0;
        var ci = cur % nx, cj = (cur / nx) | 0;
        var ciR = ci === nx - 1 ? 0 : ci + 1;
        var ciL = ci === 0 ? nx - 1 : ci - 1;
        var cjR = cj === ny - 1 ? 0 : cj + 1;
        var cjL = cj === 0 ? ny - 1 : cj - 1;
        var n1 = ciR + nx * cj, n2 = ciL + nx * cj;
        var n3 = ci + nx * cjR, n4 = ci + nx * cjL;
        if (visited[n1] === 1) { visited[n1] = 2; stack[sp++] = n1; }
        if (visited[n2] === 1) { visited[n2] = 2; stack[sp++] = n2; }
        if (visited[n3] === 1) { visited[n3] = 2; stack[sp++] = n3; }
        if (visited[n4] === 1) { visited[n4] = 2; stack[sp++] = n4; }
      }
      if (size >= 3) {
        cells++;
        if (size > biggest) biggest = size;
        centres.push({
          x: (si / size + 0.5) * this.dx,
          y: (sj / size + 0.5) * this.dy,
          area: size * this.dx * this.dy / 1000000
        });
      }
    }
    centres.sort(function (a, b) { return b.area - a.area; });
    this.diag.cellList = centres.slice(0, 12);
    this.diag.cells = cells;
    this.diag.cellArea = biggest * this.dx * this.dy / 1000000;
    this.diag.updraftArea = active;
  };

  Model.prototype._buildDepartures = function (dt) {
    var nx = this.nx, ny = this.ny, nz = this.nz;
    var dx = this.dx, dy = this.dy, dz = this.dz;
    var u = this.u, v = this.v, w = this.w;
    var idx = this.depIdx, wt = this.depW;
    var nxny = nx * ny;
    var c = 0;
    for (var k = 0; k < nz; k++) {
      var zc = (k + 0.5) * dz;
      for (var j = 0; j < ny; j++) {
        var yc = (j + 0.5) * dy;
        var rowBase = nx * j + nxny * k;
        for (var i = 0; i < nx; i++, c++) {
          var xc = (i + 0.5) * dx;
          var fx = (xc - u[c] * dt) / dx - 0.5;
          var fy = (yc - v[c] * dt) / dy - 0.5;
          var fz = (zc - w[c] * dt) / dz - 0.5;

          var i0 = Math.floor(fx), ax = fx - i0;
          i0 = i0 % nx; if (i0 < 0) i0 += nx;
          var i1 = i0 + 1; if (i1 >= nx) i1 = 0;

          var j0 = Math.floor(fy), ay = fy - j0;
          j0 = j0 % ny; if (j0 < 0) j0 += ny;
          var j1 = j0 + 1; if (j1 >= ny) j1 = 0;

          var k0 = Math.floor(fz), az = fz - k0;
          if (k0 < 0) { k0 = 0; az = 0; }
          if (k0 > nz - 2) { k0 = nz - 2; az = 1; }
          var k1 = k0 + 1;

          var w11 = (1 - ax) * (1 - ay), w21 = ax * (1 - ay);
          var w12 = (1 - ax) * ay, w22 = ax * ay;

          var b = c * 8;
          var row00 = nx * j0 + nxny * k0;
          var row10 = nx * j1 + nxny * k0;
          var row01 = nx * j0 + nxny * k1;
          var row11 = nx * j1 + nxny * k1;
          idx[b] = row00 + i0;
          idx[b + 1] = row00 + i1;
          idx[b + 2] = row10 + i0;
          idx[b + 3] = row10 + i1;
          idx[b + 4] = row01 + i0;
          idx[b + 5] = row01 + i1;
          idx[b + 6] = row11 + i0;
          idx[b + 7] = row11 + i1;

          wt[b] = w11 * (1 - az);
          wt[b + 1] = w21 * (1 - az);
          wt[b + 2] = w12 * (1 - az);
          wt[b + 3] = w22 * (1 - az);
          wt[b + 4] = w11 * az;
          wt[b + 5] = w21 * az;
          wt[b + 6] = w12 * az;
          wt[b + 7] = w22 * az;
        }
      }
    }
  };

  Model.prototype._advect = function (field) {
    var n = this.n, idx = this.depIdx, wt = this.depW, out = this.tmp;
    for (var c = 0; c < n; c++) {
      var b = c * 8;
      out[c] = field[idx[b]] * wt[b] + field[idx[b + 1]] * wt[b + 1] +
        field[idx[b + 2]] * wt[b + 2] + field[idx[b + 3]] * wt[b + 3] +
        field[idx[b + 4]] * wt[b + 4] + field[idx[b + 5]] * wt[b + 5] +
        field[idx[b + 6]] * wt[b + 6] + field[idx[b + 7]] * wt[b + 7];
    }
    field.set(out);
  };

  Model.prototype._advectAll = function () {
    var n = this.n, idx = this.depIdx, wt = this.depW;
    var uf = this.uf, vf = this.vf, wf = this.wf, th = this.th, qv = this.qv;
    var qc = this.qc, qr = this.qr, qi = this.qi;
    var t1 = this.t1, t2 = this.t2, t3 = this.t3, t4 = this.t4;
    var t5 = this.t5, t6 = this.t6, t7 = this.t7, t8 = this.t8;
    for (var c = 0; c < n; c++) {
      var b = c * 8;
      var i0 = idx[b], i1 = idx[b + 1], i2 = idx[b + 2], i3 = idx[b + 3];
      var i4 = idx[b + 4], i5 = idx[b + 5], i6 = idx[b + 6], i7 = idx[b + 7];
      var w0 = wt[b], w1 = wt[b + 1], w2 = wt[b + 2], w3 = wt[b + 3];
      var w4 = wt[b + 4], w5 = wt[b + 5], w6 = wt[b + 6], w7 = wt[b + 7];
      t1[c] = uf[i0] * w0 + uf[i1] * w1 + uf[i2] * w2 + uf[i3] * w3 +
        uf[i4] * w4 + uf[i5] * w5 + uf[i6] * w6 + uf[i7] * w7;
      t2[c] = vf[i0] * w0 + vf[i1] * w1 + vf[i2] * w2 + vf[i3] * w3 +
        vf[i4] * w4 + vf[i5] * w5 + vf[i6] * w6 + vf[i7] * w7;
      t3[c] = wf[i0] * w0 + wf[i1] * w1 + wf[i2] * w2 + wf[i3] * w3 +
        wf[i4] * w4 + wf[i5] * w5 + wf[i6] * w6 + wf[i7] * w7;
      t4[c] = th[i0] * w0 + th[i1] * w1 + th[i2] * w2 + th[i3] * w3 +
        th[i4] * w4 + th[i5] * w5 + th[i6] * w6 + th[i7] * w7;
      t5[c] = qv[i0] * w0 + qv[i1] * w1 + qv[i2] * w2 + qv[i3] * w3 +
        qv[i4] * w4 + qv[i5] * w5 + qv[i6] * w6 + qv[i7] * w7;
      t6[c] = qc[i0] * w0 + qc[i1] * w1 + qc[i2] * w2 + qc[i3] * w3 +
        qc[i4] * w4 + qc[i5] * w5 + qc[i6] * w6 + qc[i7] * w7;
      t7[c] = qr[i0] * w0 + qr[i1] * w1 + qr[i2] * w2 + qr[i3] * w3 +
        qr[i4] * w4 + qr[i5] * w5 + qr[i6] * w6 + qr[i7] * w7;
      t8[c] = qi[i0] * w0 + qi[i1] * w1 + qi[i2] * w2 + qi[i3] * w3 +
        qi[i4] * w4 + qi[i5] * w5 + qi[i6] * w6 + qi[i7] * w7;
    }
    uf.set(t1); vf.set(t2); wf.set(t3); th.set(t4);
    qv.set(t5); qc.set(t6); qr.set(t7); qi.set(t8);
  };

  Model.prototype._buoyancy = function (dt) {
    var n = this.n, nxny = this.nx * this.ny;
    var bf = this.bf, wf = this.wf;
    var th = this.th, qv = this.qv, qc = this.qc, qr = this.qr, qi = this.qi;
    var th0 = this.th0, qv0 = this.qv0;
    for (var c = 0; c < n; c++) {
      var k = (c / nxny) | 0;
      bf[c] = G * ((th[c] - th0[k]) / th0[k] + 0.61 * (qv[c] - qv0[k]) -
        (qc[c] + qr[c] + qi[c]));
    }
    for (c = 0; c < n; c++) {
      var kk = (c / nxny) | 0;
      if (kk === 0) {
        wf[c] = 0;
      } else {
        wf[c] += dt * 0.5 * (bf[c] + bf[c - nxny]);
      }
    }
  };

  Model.prototype._pressure = function (dt) {
    var nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny, n = this.n;
    var uf = this.uf, vf = this.vf, wf = this.wf, p = this.p2, div = this.div;
    var xp = this.nb.xp, xm = this.nb.xm, yp = this.nb.yp, ym = this.nb.ym;
    var dx = this.dx, dy = this.dy, dz = this.dz;
    var scale = 1 / dt;
    var c, k, i, j;

    for (c = 0; c < n; c++) {
      k = (c / nxny) | 0;
      var wtop = k === nz - 1 ? 0 : wf[c + nxny];
      div[c] = ((uf[xp[c]] - uf[c]) / dx + (vf[yp[c]] - vf[c]) / dy +
        (wtop - wf[c]) / dz) * scale;
    }

    var a = 1 / (dx * dx), b2 = 1 / (dz * dz);
    var denom = 4 * a + 2 * b2;
    var invDenom = 1 / denom;
    var omega = 1.7, om1 = 1 - omega;
    var iters = this.pressureIters || 30;

    for (c = 0; c < n; c++) p[c] *= 0.94;

    for (var it = 0; it < iters; it++) {
      for (k = 0; k < nz; k++) {
        var kOff = k * nxny;
        var kp = k === nz - 1 ? 0 : nxny;
        var km = k === 0 ? 0 : -nxny;
        for (j = 0; j < ny; j++) {
          var jOff = kOff + j * nx;
          var jp = j === ny - 1 ? -(ny - 1) * nx : nx;
          var jm = j === 0 ? (ny - 1) * nx : -nx;
          for (i = 0; i < nx; i++) {
            c = jOff + i;
            var ip = i === nx - 1 ? -(nx - 1) : 1;
            var im = i === 0 ? nx - 1 : -1;
            var target = (a * (p[c + ip] + p[c + im] + p[c + jp] + p[c + jm]) +
              b2 * (p[c + kp] + p[c + km]) - div[c]) * invDenom;
            p[c] = p[c] * om1 + target * omega;
          }
        }
      }
    }

    var cdx = dt / dx, cdy = dt / dy, cdz = dt / dz;
    for (c = 0; c < n; c++) {
      k = (c / nxny) | 0;
      uf[c] -= (p[c] - p[xm[c]]) * cdx;
      vf[c] -= (p[c] - p[ym[c]]) * cdy;
      if (k > 0) wf[c] -= (p[c] - p[c - nxny]) * cdz;
    }
  };

  Model.prototype._diffuse = function (dt, kIdx) {
    var n = this.n, nb = this.nb;
    var xp = nb.xp, xm = nb.xm, yp = nb.yp, ym = nb.ym, zp = nb.zp, zm = nb.zm;
    var kh = 60, kv = 15;
    var rxh = kh * dt / (this.dx * this.dx);
    var rxv = kv * dt / (this.dz * this.dz);
    var fields = [this.uf, this.vf, this.wf, this.th, this.qv];
    for (var fi = 0; fi < fields.length; fi++) {
      var f = fields[fi], out = this.tmp;
      for (var c = 0; c < n; c++) {
        var lap = (f[xp[c]] + f[xm[c]] + f[yp[c]] + f[ym[c]] - 4 * f[c]) * rxh +
          (f[zp[c]] + f[zm[c]] - 2 * f[c]) * rxv;
        out[c] = f[c] + lap;
      }
      f.set(out);
    }
  };

  Model.prototype._microphysics = function (dt) {
    var n = this.n, nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny;
    var th = this.th, qv = this.qv, qc = this.qc, qr = this.qr, qi = this.qi;
    var th0 = this.th0, pi0 = this.pi0, p0 = this.p0, qv0 = this.qv0, rho0 = this.rho0;
    var c;
    var qc0 = 0.001;

    for (c = 0; c < n; c++) {
      var k = (c / nxny) | 0;
      var pi = pi0[k], p = p0[k];
      var T = th[c] * pi;
      var qvv = qv[c];
      var qs = qsatFast(T, p);
      var qcl = qc[c];
      if (qvv > qs) {
        var dq = (qvv - qs) / (1 + LV * LV * qs / (CP * RV * T * T));
        if (dq > qvv) dq = qvv;
        qv[c] -= dq;
        qc[c] += dq;
        th[c] += dq * LV / (CP * pi);
      } else if (qcl > 1e-9) {
        var dq2 = Math.min(qcl, (qs - qvv) / (1 + LV * LV * qs / (CP * RV * T * T)));
        qc[c] -= dq2;
        qv[c] += dq2;
        th[c] -= dq2 * LV / (CP * pi);
      }
    }

    for (c = 0; c < n; c++) {
      var qcl2 = qc[c], qrn = qr[c];
      if (qcl2 <= 1e-7 && qrn <= 1e-9) continue;
      var kk = (c / nxny) | 0;
      var pik = pi0[kk];
      var T2 = th[c] * pik;
      var p2 = p0[kk];
      var rho = rho0[kk];

      if (qcl2 > qc0) {
        var ac = Math.min(qcl2 - qc0, 1e-3 * (qcl2 - qc0) * dt);
        qc[c] -= ac; qr[c] += ac; qrn += ac;
      }
      if (qcl2 > 1e-6 && qrn > 1e-6) {
        var acc = Math.min(qcl2, 2.2 * qcl2 * Math.pow(qrn, 0.875) * dt);
        qc[c] -= acc; qr[c] += acc;
      }

      if (qr[c] > 1e-6) {
        var qvNow = qv[c];
        var qs2 = qsatFast(T2, p2);
        if (qvNow < qs2) {
          var rh = qvNow / qs2;
          var evap = 2.0e-3 * (1 - rh) * Math.pow(rho * qr[c], 0.525) * dt;
          if (evap > qr[c]) evap = qr[c];
          if (evap > qs2 - qvNow) evap = qs2 - qvNow;
          if (evap > 0) {
            qr[c] -= evap;
            qv[c] += evap;
            th[c] -= evap * LV / (CP * pik);
          }
        }
      }

      if (T2 < 268.15 && qc[c] > 1e-7) {
        var frz = Math.min(qc[c], qc[c] * dt / 120);
        qc[c] -= frz; qi[c] += frz;
        th[c] += frz * LV / (CP * pik) * 0.35;
      }
      if (T2 > 273.15 && qi[c] > 1e-7) {
        var melt = Math.min(qi[c], qi[c] * dt / 180);
        qi[c] -= melt; qr[c] += melt;
        th[c] -= melt * LV / (CP * pik) * 0.35;
      }
    }
  };

  Model.prototype._sediment = function (dt) {
    var nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny;
    var qr = this.qr, flux = this.flux, rho0 = this.rho0;
    var acc = this.acc, sfc = this.sfcRain;
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var col = j * nx + i;
        var ground = 0;
        var below = 0;
        for (var k = 0; k < nz; k++) {
          var c = col + nxny * k;
          var rho = rho0[k];
          var q = qr[c];
          var vt = 0;
          if (q > 1e-7) {
            vt = 36.34 * Math.pow(0.001 * rho * q, 0.1364);
            if (vt > 12) vt = 12;
          }
          flux[c] = rho * q * vt;
        }
        for (k = nz - 1; k >= 0; k--) {
          c = col + nxny * k;
          var inflow = (k === nz - 1) ? 0 : flux[c + nxny];
          qr[c] += dt * (inflow - flux[c]) / (rho0[k] * this.dz);
          if (qr[c] < 0) qr[c] = 0;
        }
        ground = flux[col];
        sfc[col] = ground;
        acc[col] += ground * dt;
      }
    }
  };

  Model.prototype._surface = function (dt) {
    var nx = this.nx, ny = this.ny;
    var th = this.th, qv = this.qv, qv0 = this.qv0, th0 = this.th0;
    var tauQ = 900, tauT = 3 * 3600;
    var c = 0;
    for (var k = 0; k < 3; k++) {
      var decay = Math.exp(-(k + 0.5) * this.dz / 700);
      for (var j = 0; j < ny; j++) {
        for (var i = 0; i < nx; i++, c++) {
          var wq = Math.min(1, decay * dt / tauQ);
          if (qv[c] < qv0[k]) qv[c] += (qv0[k] - qv[c]) * wq;
          var wt = Math.min(1, decay * dt / tauT * 0.4);
          th[c] += (th0[k] - th[c]) * wt;
        }
      }
    }
  };

  Model.prototype._sponge = function (dt) {
    var nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny;
    var uf = this.uf, vf = this.vf, wf = this.wf;
    for (var k = nz - 4; k < nz; k++) {
      var f = Math.min(1, dt / 240 * (1 + (k - (nz - 4))));
      var off = nxny * k;
      for (var c = off; c < off + nxny; c++) {
        uf[c] *= 1 - f;
        vf[c] *= 1 - f;
        wf[c] *= 1 - f;
      }
    }
  };

  Model.prototype._diagnostics = function () {
    var nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny;
    var w = this.w, qc = this.qc, qr = this.qr, qi = this.qi, qv = this.qv;
    var th = this.th, rho0 = this.rho0, zc = this.zc, th0 = this.th0;
    var maxW = 0, minW = 0, cloudTop = 0, iceTop = 0, maxDBZ = 0, cold = 0;
    var maxQi = 0, maxThp = 0, maxQv = 0;
    var kQv = Math.max(0, Math.min(nz - 1, Math.round(1500 / this.dz)));
    var colDbz = this.colDbz, colZ = this.colMaxZ, sfc = this.sfcRain;
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var col = j * nx + i;
        var dmax = 0, top = 0, itop = 0;
        for (var k = 0; k < nz; k++) {
          var c = col + nxny * k;
          var wk = w[c];
          if (wk > maxW) maxW = wk;
          if (wk < minW) minW = wk;
          var cond = qc[c] + qi[c];
          if (cond > 1e-5) { top = zc[k]; }
          if (qi[c] > 1e-5) { itop = zc[k]; }
          if (qi[c] > maxQi) maxQi = qi[c];
          var dth = th[c] - th0[k];
          if (dth > maxThp) maxThp = dth;
          if (k === kQv && qv[c] > maxQv) maxQv = qv[c];
          if (qr[c] > 1e-5) {
            var z = 3.63e9 * Math.pow(rho0[k] * qr[c], 1.75) + 1e6 * Math.pow(rho0[k] * qi[c] * 0.4, 1.75);
            if (z > dmax) dmax = z;
          }
        }
        colZ[col] = top;
        var dbz = dmax > 1 ? 10 * Math.log(dmax) / Math.LN10 : 0;
        colDbz[col] = dbz;
        if (dbz > maxDBZ) maxDBZ = dbz;
        if (top > cloudTop) cloudTop = top;
        if (itop > iceTop) iceTop = itop;
      }
    }
    for (var i2 = 0; i2 < nxny; i2++) {
      var t0 = th[i2] - this.th0[0];
      if (t0 < cold) cold = t0;
    }
    var d = this.diag;
    d.maxW = maxW;
    d.minW = minW;
    d.cloudTop = cloudTop;
    d.iceTop = iceTop;
    d.maxDBZ = maxDBZ;
    d.coldPool = cold;
    var rmax = 0, rArea = 0, rSum = 0;
    for (var i3 = 0; i3 < nxny; i3++) {
      var rr = sfc[i3] * 3600;
      rSum += rr;
      if (rr > rmax) rmax = rr;
      if (rr > 0.2) rArea++;
    }
    d.rainRate = rmax;
    d.rainMean = rSum / nxny;
    d.rainArea = rArea * this.dx * this.dy / 1000000;
    d.sigQi = maxQi * 1000;
    d.sigQv = maxQv * 1000;
    d.sigThp = maxThp;
    if (this.stepCount % 10 === 0) {
      this._helicity();
      this._tornado();
    }
    if (this.stepCount % 15 === 0) this._countCells();
    d.uh = this._uh;
  };

  Model.prototype._tornado = function () {
    var d = this.diag;
    var prof = this.profile || {};
    var lcl = prof.lcl || 0;
    var srh = prof.srh || 0;
    var list = d.mesocyclones || [];
    var best = null;
    var kTop = Math.max(1, Math.round(1500 / this.dz));
    for (var m = 0; m < list.length; m++) {
      var mc = list[m];
      var ci = Math.round(mc.x / this.dx - 0.5);
      var cj = Math.round(mc.y / this.dy - 0.5);
      var peak = 0, wLow = 0;
      for (var k = 0; k <= kTop; k++) {
        var zeta = (this.v[this._idx(ci + 1, cj, k)] - this.v[this._idx(ci - 1, cj, k)]) / (2 * this.dx) -
          (this.u[this._idx(ci, cj + 1, k)] - this.u[this._idx(ci, cj - 1, k)]) / (2 * this.dy);
        if (Math.abs(zeta) > Math.abs(peak)) peak = zeta;
        var wCell = this.w[this._idx(ci, cj, k)];
        if (wCell > wLow) wLow = wCell;
      }
      if (!best || Math.abs(peak) > Math.abs(best.zLow)) best = { mc: mc, zLow: peak, wLow: wLow };
    }
    var cold = d.coldPool || 0;
    var conds = [
      {
        id: 'meso', name: 'мезоциклон', value: list.length,
        need: '≥ 1 и держится 4 мин',
        ok: list.length > 0 && !!best && best.mc.age >= 240
      },
      { id: 'lcl', name: 'LCL', value: lcl, need: '≤ 1600 м', ok: lcl > 0 && lcl <= 1600 },
      { id: 'srh', name: 'SRH 0–3 км', value: srh, need: '≥ 80 м²/с²', ok: srh >= 80 },
      {
        id: 'zeta', name: 'ζ 0–1,5 км', value: best ? best.zLow : 0,
        need: '≥ 1,8·10⁻³ с⁻¹', ok: !!best && best.zLow >= 1.8e-3
      },
      {
        id: 'stretch', name: 'поток 0–1,5 км', value: best ? best.wLow : 0,
        need: '≥ 4,5 м/с (растяжение)', ok: !!best && best.wLow >= 4.5
      },
      { id: 'cold', name: 'холодный отток', value: cold, need: 'не сильнее −5 K', ok: cold > -5 }
    ];
    var okAll = true;
    for (var i = 0; i < conds.length; i++) if (!conds[i].ok) okAll = false;
    d.tornadoConditions = conds;

    if (!okAll) {
      this._tornadoDur = 0;
      this._track = [];
      d.tornado = { active: false, ef: -1, track: [] };
      return;
    }

    var z = best.zLow;
    var ef = z >= 3.5e-3 ? 3 : (z >= 2.8e-3 ? 2 : (z >= 2.2e-3 ? 1 : 0));
    this._tornadoDur = (this._tornadoDur || 0) + 10 * this.dt;
    var dp = 1.2 * Math.pow(z * 200, 2) / 2 / 100;
    if (!this._track) this._track = [];
    this._track.push({ x: best.mc.x, y: best.mc.y, t: this.time, ef: ef });
    if (this._track.length > 400) this._track.shift();
    d.tornado = {
      active: true, ef: ef, x: best.mc.x, y: best.mc.y,
      zetaLow: z, dp: dp, radius: 120 + 900 * Math.min(1, z / 20e-3),
      duration: this._tornadoDur, track: this._track.slice()
    };
  };

  Model.prototype._helicity = function () {
    var nx = this.nx, ny = this.ny, nz = this.nz, nxny = nx * ny;
    var u = this.u, v = this.v, w = this.w, dz = this.dz, dx = this.dx, dy = this.dy;
    var th = this.th;
    var best = 0, area = 0;
    var mesoF = this.mesoField, wmaxArr = this.colWmax;
    var vis = this.mesoVisited, stack = this.mesoStack;
    var i, j, k, col;
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        col = j * nx + i;
        var sum = 0, hasUp = false, sumW = 0, sumZ = 0, wm = 0;
        for (k = 0; k < nz; k++) {
          var z = (k + 0.5) * dz;
          if (z < 2000 || z > 5000) continue;
          var c = col + nxny * k;
          var zeta = (v[this.nb.xp[c]] - v[this.nb.xm[c]]) / (2 * this.dx) -
            (u[this.nb.yp[c]] - u[this.nb.ym[c]]) / (2 * this.dy);
          sum += w[c] * zeta * dz;
          if (w[c] > 10) hasUp = true;
          if (w[c] > 1) { sumW += w[c]; sumZ += zeta * w[c]; }
          if (w[c] > wm) wm = w[c];
        }
        if (sum > best) best = sum;
        this.colUH[col] = sum;
        if (hasUp) area++;
        mesoF[col] = sumW > 1 ? sumZ / sumW : 0;
        wmaxArr[col] = wm;
      }
    }
    this._uh = best;
    this.diag.updraftArea = area;

    var thr = 2.0e-3;
    vis.fill(0);
    var found = [];
    for (col = 0; col < nxny; col++) {
      if (vis[col] || mesoF[col] < thr || wmaxArr[col] < 4) continue;
      var sp = 0;
      stack[sp++] = col;
      vis[col] = 1;
      var sumI = 0, sumJ = 0, cnt = 0, peak = 0;
      while (sp > 0) {
        var cur = stack[--sp];
        var ci = cur % nx, cj = (cur / nx) | 0;
        sumI += ci; sumJ += cj; cnt++;
        if (mesoF[cur] > peak) peak = mesoF[cur];
        for (var di = -1; di <= 1; di++) {
          for (var dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            var ii = ((ci + di) % nx + nx) % nx;
            var jj = ((cj + dj) % ny + ny) % ny;
            var nb = jj * nx + ii;
            if (vis[nb] || mesoF[nb] < thr || wmaxArr[nb] < 4) continue;
            vis[nb] = 1;
            stack[sp++] = nb;
          }
        }
      }
      if (cnt < 2) continue;
      found.push({ i: sumI / cnt, j: sumJ / cnt, strength: peak, size: cnt });
    }

    var prev = this._mesoPrev || [];
    var dtSince = 5 * this.dt;
    var now = [];
    for (var f = 0; f < found.length; f++) {
      var it = found[f];
      var match = null, bestD = 1e9;
      for (var q = 0; q < prev.length; q++) {
        var pi = prev[q];
        var ddi = Math.abs(pi.i - it.i);
        var ddj = Math.abs(pi.j - it.j);
        ddi = Math.min(ddi, nx - ddi);
        ddj = Math.min(ddj, ny - ddj);
        var dist = Math.hypot(ddi, ddj) * this.dx;
        if (dist < bestD) { bestD = dist; match = pi; }
      }
      it.age = (match && bestD < 6000) ? match.age + dtSince : 0;
      now.push(it);
    }
    this._mesoPrev = now;

    var out = [];
    for (f = 0; f < now.length; f++) {
      it = now[f];
      if (it.age < 60) continue;
      out.push({
        x: (it.i + 0.5) * this.dx,
        y: (it.j + 0.5) * this.dy,
        z: 3500,
        strength: it.strength,
        age: it.age,
        diam: Math.sqrt(it.size * this.dx * this.dy) / 1000
      });
    }

    var kLo = Math.max(0, Math.min(nz - 1, Math.round(1000 / dz)));
    var ngMax = 0;
    for (col = 0; col < nxny; col++) {
      for (k = 0; k <= kLo; k++) {
        var ccg = col + nxny * k;
        var zg = (v[this.nb.xp[ccg]] - v[this.nb.xm[ccg]]) / (2 * dx) -
          (u[this.nb.yp[ccg]] - u[this.nb.ym[ccg]]) / (2 * dy);
        if (Math.abs(zg) > ngMax) ngMax = Math.abs(zg);
      }
    }
    this.diag.sigVort = ngMax;

    for (f = 0; f < out.length; f++) {
      var mc = out[f];
      var ci0 = Math.floor(mc.x / dx), cj0 = Math.floor(mc.y / dy);
      var rad = Math.max(1, Math.ceil(3000 / dx));
      var bestNg = 0, coldHere = 0;
      for (var djj = -rad; djj <= rad; djj++) {
        for (var dii = -rad; dii <= rad; dii++) {
          var ii2 = ((ci0 + dii) % nx + nx) % nx;
          var jj2 = ((cj0 + djj) % ny + ny) % ny;
          var ccol = jj2 * nx + ii2;
          var dCold = th[ccol] - this.th0[0];
          if (dCold < coldHere) coldHere = dCold;
          for (k = 0; k <= kLo; k++) {
            var q1 = ccol + nxny * k;
            var zv = (v[this.nb.xp[q1]] - v[this.nb.xm[q1]]) / (2 * dx) -
              (u[this.nb.yp[q1]] - u[this.nb.ym[q1]]) / (2 * dy);
            if (Math.abs(zv) > bestNg) bestNg = Math.abs(zv);
          }
        }
      }
      mc.ngZeta = bestNg;
      mc.coldPool = coldHere;

      var ringSum = 0, ringN = 0;
      var ringR = 2000;
      for (k = 0; k <= kLo; k++) {
        var vmax = -1e9, vmin = 1e9;
        for (var a = 0; a < 12; a++) {
          var ang = a * Math.PI / 6;
          var px = mc.x + Math.cos(ang) * ringR;
          var py = mc.y + Math.sin(ang) * ringR;
          var ii3 = ((Math.floor(px / dx) % nx) + nx) % nx;
          var jj3 = ((Math.floor(py / dy) % ny) + ny) % ny;
          var q3 = jj3 * nx + ii3 + nxny * k;
          var vt = -u[q3] * Math.sin(ang) + v[q3] * Math.cos(ang);
          if (vt > vmax) vmax = vt;
          if (vt < vmin) vmin = vt;
        }
        ringSum += (vmax - vmin) / 2;
        ringN++;
      }
      mc.vrot = ringN ? ringSum / ringN : 0;
    }

    var prm = this.profile || {};
    var mcBest = null;
    for (f = 0; f < out.length; f++) {
      if (!mcBest || out[f].ngZeta > mcBest.ngZeta) mcBest = out[f];
    }
    var reasons = [];
    if (!mcBest) reasons.push('нет мезоциклона');
    if (!(prm.stp >= 1)) reasons.push('STP ниже 1');
    if (!(prm.srh01 >= 100)) reasons.push('SRH 0–1 км ниже 100 м²/с²');
    if (!(prm.lcl > 0 && prm.lcl <= 1200)) reasons.push('LCL выше 1200 м');
    if (!(prm.shear01 >= 6)) reasons.push('сдвиг 0–1 км меньше 6 м/с');
    if (mcBest && !(mcBest.vrot >= 6)) reasons.push('слабое приземное вращение');
    if (mcBest && !(mcBest.coldPool > -3)) reasons.push('холодный купол гасит вращение');

    var vrot = 0, ef = 0, funnel = 0;
    if (mcBest) {
      vrot = mcBest.vrot;
      funnel = Math.max(60, Math.min(1600, vrot * 40));
      var wms = vrot * 1.8;
      ef = wms < 38 ? 0 : wms < 49 ? 1 : wms < 60 ? 2 : wms < 74 ? 3 : wms < 89 ? 4 : 5;
    }
    this.diag.tornado = {
      active: reasons.length === 0,
      reasons: reasons,
      stp: prm.stp || 0,
      srh01: prm.srh01 || 0,
      lcl: prm.lcl || 0,
      shear01: prm.shear01 || 0,
      ngZeta: mcBest ? mcBest.ngZeta : 0,
      vrot: vrot,
      ef: ef,
      funnel: funnel,
      cold: mcBest ? mcBest.coldPool : 0,
      meso: mcBest ? { x: mcBest.x, y: mcBest.y, diam: mcBest.diam, strength: mcBest.strength } : null
    };
    this.diag.mesocyclones = out;
  };

  Model.prototype._idx = function (i, j, k) {
    var nx = this.nx, ny = this.ny;
    i = ((i % nx) + nx) % nx;
    j = ((j % ny) + ny) % ny;
    if (k < 0) k = 0;
    if (k >= this.nz) k = this.nz - 1;
    return i + nx * (j + ny * k);
  };

  Model.prototype.step = function () {
    var tStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var dt = this.dt;
    this._buildDepartures(dt);
    this._advectAll();
    this._buoyancy(dt);
    this._heatSurface(dt);
    if (this.stepCount % 3 === 0) this._diffuse(dt * 3);
    this._surface(dt);
    this._microphysics(dt);
    this._sediment(dt);
    this._pressure(dt);
    this._sponge(dt);
    this._deriveCenters();
    this.stepCount++;
    this.time += dt;
    this._diagnostics();
    var tEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var msStep = tEnd - tStart;
    this.stepMs = this.stepMs ? this.stepMs * 0.85 + msStep * 0.15 : msStep;
  };

  Model.prototype.columns = function () {
    return { rain: this.sfcRain, dbz: this.colDbz, top: this.colMaxZ };
  };

  ML.Model = Model;
  ML.qsatFast = qsatFast;
})(window);
