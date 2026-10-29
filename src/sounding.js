(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});

  var G = 9.80665;
  var CP = 1004.5;
  var RD = 287.05;
  var RV = 461.5;
  var EPS = RD / RV;
  var LV = 2.501e6;
  var P0 = 100000;

  function esat(T) {
    var Tc = T - 273.15;
    return 611.2 * Math.exp(17.67 * Tc / (Tc + 243.5));
  }

  function qsat(T, p) {
    var es = Math.min(esat(T), 0.99 * p);
    return EPS * es / Math.max(1, p - es);
  }

  function dewpoint(q, p) {
    var e = q * p / (EPS + q);
    e = Math.min(Math.max(e, 1e-4), 0.985 * p);
    var l = Math.log(e / 611.2);
    return 243.5 * l / (17.67 - l) + 273.15;
  }

  function tempFromTheta(th, p) {
    return th * Math.pow(p / P0, RD / CP);
  }

  function lapseAt(zkm, prm) {
    if (zkm < 3) return prm.lapseLow;
    if (zkm < 8) return prm.lapseMid;
    if (zkm < prm.zTrop) {
      var t = (zkm - 8) / Math.max(0.5, prm.zTrop - 8);
      return prm.lapseMid + (prm.lapseTop - prm.lapseMid) * t;
    }
    return -1.2;
  }

  function rhAt(zm, prm) {
    var z = zm / 1000;
    var nodes = [0, 1.5, 5, prm.zTrop];
    var vals = [prm.rh0, prm.rh0, prm.rhMid, prm.rhTop];
    if (z <= 0) return vals[0];
    for (var k = 0; k < nodes.length - 1; k++) {
      if (z <= nodes[k + 1]) {
        var f = (z - nodes[k]) / (nodes[k + 1] - nodes[k]);
        return vals[k] + (vals[k + 1] - vals[k]) * f;
      }
    }
    return vals[vals.length - 1];
  }

  function windAt(zm, prm) {
    var z = zm / 1000;
    var nodes = [0, 3, 6, 10];
    var sp = [prm.ws0, prm.ws3, prm.ws6, prm.ws10];
    var dr = [prm.wd0, prm.wd3, prm.wd6, prm.wd10];
    var s = sp[0], d = dr[0];
    if (z >= 10) { s = sp[3]; d = dr[3]; }
    else {
      for (var k = 0; k < 3; k++) {
        if (z <= nodes[k + 1]) {
          var f = (z - nodes[k]) / (nodes[k + 1] - nodes[k]);
          s = sp[k] + (sp[k + 1] - sp[k]) * f;
          d = dr[k] + (dr[k + 1] - dr[k]) * f;
          break;
        }
      }
    }
    var rad = d * Math.PI / 180;
    return { u: -s * Math.sin(rad), v: -s * Math.cos(rad), spd: s, dir: d };
  }

  function buildProfile(prm) {
    var dz = 50, zTop = 15000;
    var nz = Math.round(zTop / dz) + 1;
    var z = new Float64Array(nz);
    var T = new Float64Array(nz);
    var p = new Float64Array(nz);
    var qv = new Float64Array(nz);
    var RH = new Float64Array(nz);
    var th = new Float64Array(nz);
    var u = new Float64Array(nz);
    var v = new Float64Array(nz);
    var Tv = new Float64Array(nz);

    for (var k = 0; k < nz; k++) z[k] = k * dz;

    T[0] = prm.t0 + 273.15;
    for (k = 1; k < nz; k++) {
      T[k] = T[k - 1] - lapseAt((z[k] - dz / 2) / 1000, prm) * dz / 1000;
    }

    p[0] = 101325;
    for (k = 1; k < nz; k++) {
      var Tm = 0.5 * (T[k] + T[k - 1]);
      p[k] = p[k - 1] * Math.exp(-G * dz / (RD * Tm));
    }

    for (k = 0; k < nz; k++) {
      RH[k] = Math.min(1, Math.max(0.02, rhAt(z[k], prm) / 100));
      qv[k] = RH[k] * qsat(T[k], p[k]);
    }

    for (k = 1; k < nz; k++) {
      var qm = 0.5 * (qv[k] + qv[k - 1]);
      var Tm2 = 0.5 * (T[k] + T[k - 1]);
      var Tvm = Tm2 * (1 + 0.608 * qm);
      p[k] = p[k - 1] * Math.exp(-G * dz / (RD * Tvm));
    }

    for (k = 0; k < nz; k++) {
      qv[k] = RH[k] * qsat(T[k], p[k]);
      th[k] = T[k] * Math.pow(P0 / p[k], RD / CP);
      Tv[k] = T[k] * (1 + 0.608 * qv[k]);
      var wnd = windAt(z[k], prm);
      u[k] = wnd.u;
      v[k] = wnd.v;
    }

    var prof = {
      z: z, T: T, p: p, qv: qv, RH: RH, th: th, u: u, v: v, Tv: Tv,
      nz: nz, dz: dz, params: prm, source: 'synthetic'
    };
    return finishProfile(prof);
  }

  function finishProfile(prof) {
    var par = liftParcel(prof);
    prof.parcel = par;
    prof.cape = par.cape;
    prof.cin = par.cin;
    prof.lcl = par.lcl;
    prof.lfc = par.lfc;
    prof.el = par.el;
    var sm = bunkers(prof);
    prof.storm = sm;
    prof.shear06 = sm.shear06;
    prof.srh = srh(prof, sm);
    prof.t500 = interpAt(prof.T, prof.z, 5500);
    prof.t850 = interpAt(prof.T, prof.z, 1500);
    prof.pwat = precipWater(prof);
    prof.dcape = downCape(prof);
    prof.shear01 = Math.hypot(
      interpAt(prof.u, prof.z, 1000) - interpAt(prof.u, prof.z, 0),
      interpAt(prof.v, prof.z, 1000) - interpAt(prof.v, prof.z, 0));
    prof.brn = prof.cape / Math.max(10, 0.5 * prof.shear06 * prof.shear06);
    prof.srh01 = srhLayer(prof, sm, 1000);
    var capeTerm = Math.max(0, prof.cape / 1500);
    var lclTerm = Math.max(0, Math.min(2, (2000 - prof.lcl) / 1000));
    var srhTerm = Math.max(0, Math.min(3, prof.srh01 / 150));
    var shrTerm = Math.max(0, Math.min(2, prof.shear06 / 20));
    var cinTerm = Math.max(0, Math.min(1, (200 + prof.cin) / 150));
    prof.stp = capeTerm * lclTerm * srhTerm * shrTerm * cinTerm;
    return prof;
  }

  function srhLayer(prof, sm, depth) {
    var sum = 0;
    var step = 100;
    for (var z = 0; z < depth; z += step) {
      var u1 = interpAt(prof.u, prof.z, z), v1 = interpAt(prof.v, prof.z, z);
      var u2 = interpAt(prof.u, prof.z, z + step), v2 = interpAt(prof.v, prof.z, z + step);
      sum += (v1 - sm.v) * (u2 - u1) - (u1 - sm.u) * (v2 - v1);
    }
    return sum;
  }

  function fromObserved(levels, meta) {
    var pts = [];
    for (var i = 0; i < levels.length; i++) {
      var L = levels[i];
      var p = isFinite(L.p) ? L.p : null;
      var z = isFinite(L.z) ? L.z : null;
      if (p === null && z === null) continue;
      if (!isFinite(L.t)) continue;
      pts.push({
        z: z, p: p, t: L.t + 273.15,
        td: isFinite(L.td) ? L.td + 273.15 : null,
        dir: isFinite(L.dir) ? L.dir : null,
        spd: isFinite(L.spd) ? L.spd : null
      });
    }
    if (pts.length < 2) throw new Error('в зондировании меньше двух уровней с температурой');

    pts.sort(function (a, b) {
      var pa = a.p !== null ? a.p : 1000 - (a.z || 0) / 100;
      var pb = b.p !== null ? b.p : 1000 - (b.z || 0) / 100;
      return pb - pa;
    });

    var prevZ = 0, prevP = pts[0].p, prevT = pts[0].t;
    for (i = 0; i < pts.length; i++) {
      L = pts[i];
      if (L.p === null) L.p = prevP * Math.exp(-G * ((L.z || prevZ) - prevZ) / (RD * prevT));
      if (L.z === null) {
        var tv = 0.5 * (L.t + prevT);
        L.z = prevZ + (RD * tv / G) * Math.log(prevP / L.p);
      }
      if (i === 0) L.z = 0;
      if (L.z < prevZ) L.z = prevZ;
      prevZ = L.z; prevP = L.p; prevT = L.t;
    }

    var zLast = pts[pts.length - 1].z;
    var zTop = Math.min(15000, Math.max(12000, zLast + 400));
    var dz = 50;
    var nz = Math.floor(zTop / dz) + 1;
    var zArr = new Float64Array(nz), T = new Float64Array(nz), pArr = new Float64Array(nz);
    var qv = new Float64Array(nz), RH = new Float64Array(nz), th = new Float64Array(nz);
    var u = new Float64Array(nz), v = new Float64Array(nz), Tv = new Float64Array(nz);
    var TdArr = new Float64Array(nz);

    function sampleZ(zq) {
      if (zq <= pts[0].z) {
        return { a: pts[0], b: pts.length > 1 ? pts[1] : pts[0], f: 0 };
      }
      for (var k = 0; k < pts.length - 1; k++) {
        if (zq <= pts[k + 1].z) {
          var f = (zq - pts[k].z) / Math.max(1, pts[k + 1].z - pts[k].z);
          return { a: pts[k], b: pts[k + 1], f: f };
        }
      }
      return null;
    }

    var lastLapse = -6.5;
    if (pts.length >= 2) {
      var a0 = pts[pts.length - 2], b0 = pts[pts.length - 1];
      lastLapse = (b0.t - a0.t) / Math.max(50, b0.z - a0.z) * 1000;
      if (!isFinite(lastLapse) || lastLapse < -9.8 || lastLapse > 2) lastLapse = -6.5;
    }

    var lastU = 0, lastV = 0;
    for (var k2 = 0; k2 < nz; k2++) {
      var zq = k2 * dz;
      zArr[k2] = zq;
      var s = sampleZ(zq);
      var tq, tdq, pq, uq = 0, vq = 0;
      if (s) {
        tq = s.a.t + (s.b.t - s.a.t) * s.f;
        var tda = s.a.td !== null ? s.a.td : s.a.t - 8;
        var tdb = s.b.td !== null ? s.b.td : s.b.t - 8;
        tdq = tda + (tdb - tda) * s.f;
        pq = Math.exp(Math.log(s.a.p) + (Math.log(s.b.p) - Math.log(s.a.p)) * s.f) * 100;
        var ua = s.a.spd !== null ? -s.a.spd * Math.sin(s.a.dir * Math.PI / 180) : null;
        var va = s.a.spd !== null ? -s.a.spd * Math.cos(s.a.dir * Math.PI / 180) : null;
        var ub = s.b.spd !== null ? -s.b.spd * Math.sin(s.b.dir * Math.PI / 180) : null;
        var vb = s.b.spd !== null ? -s.b.spd * Math.cos(s.b.dir * Math.PI / 180) : null;
        if (ua === null) ua = ub;
        if (ub === null) ub = ua;
        if (va === null) va = vb;
        if (vb === null) vb = va;
        uq = (ua || 0) + ((ub || 0) - (ua || 0)) * s.f;
        vq = (va || 0) + ((vb || 0) - (va || 0)) * s.f;
      } else {
        var last = pts[pts.length - 1];
        var dzx = zq - last.z;
        tq = last.t + lastLapse / 1000 * dzx;
        tdq = tq - 20;
        pq = last.p * 100 * Math.exp(-G * dzx / (RD * 0.5 * (tq + last.t)));
        uq = lastU;
        vq = lastV;
      }
      T[k2] = tq;
      TdArr[k2] = Math.min(tdq, tq);
      pArr[k2] = pq;
      qv[k2] = Math.max(1e-7, qsat(TdArr[k2], pq));
      RH[k2] = Math.min(1, qv[k2] / qsat(tq, pq));
      th[k2] = tq * Math.pow(P0 / pq, RD / CP);
      Tv[k2] = tq * (1 + 0.608 * qv[k2]);
      u[k2] = uq;
      v[k2] = vq;
      lastU = uq;
      lastV = vq;
    }

    var prof = {
      z: zArr, T: T, p: pArr, qv: qv, RH: RH, th: th, u: u, v: v, Tv: Tv,
      nz: nz, dz: dz, params: null, source: 'observed', meta: meta || {}
    };
    return finishProfile(prof);
  }

  function buildProfileFromObs(obs) {
    var dz = 50, zTop = 15500;
    var nz = Math.round(zTop / dz) + 1;
    var z = new Float64Array(nz);
    var T = new Float64Array(nz);
    var p = new Float64Array(nz);
    var qv = new Float64Array(nz);
    var RH = new Float64Array(nz);
    var th = new Float64Array(nz);
    var u = new Float64Array(nz);
    var v = new Float64Array(nz);
    var Tv = new Float64Array(nz);

    var oz = obs.z, op = obs.p, ot = obs.t, otd = obs.td, owd = obs.wd, ows = obs.ws;
    var n = oz.length;
    var uo = [], vo = [];
    for (var i = 0; i < n; i++) {
      var rad = (owd[i] || 0) * Math.PI / 180;
      uo.push(-(ows[i] || 0) * Math.sin(rad));
      vo.push(-(ows[i] || 0) * Math.cos(rad));
    }

    function lin(arr, zq) {
      if (zq <= oz[0]) {
        return arr[0];
      }
      if (zq >= oz[n - 1]) {
        return arr[n - 1];
      }
      for (var k = 1; k < n; k++) {
        if (zq <= oz[k]) {
          var f = (zq - oz[k - 1]) / Math.max(1, oz[k] - oz[k - 1]);
          return arr[k - 1] + (arr[k] - arr[k - 1]) * f;
        }
      }
      return arr[n - 1];
    }

    function logp(zq) {
      if (zq <= oz[0]) {
        var s0 = n > 1 ? (Math.log(op[1]) - Math.log(op[0])) / Math.max(1, oz[1] - oz[0]) : 0;
        return Math.exp(Math.log(op[0]) + s0 * (zq - oz[0]));
      }
      if (zq >= oz[n - 1]) {
        var s1 = n > 1 ? (Math.log(op[n - 1]) - Math.log(op[n - 2])) / Math.max(1, oz[n - 1] - oz[n - 2]) : 0;
        return Math.exp(Math.log(op[n - 1]) + s1 * (zq - oz[n - 1]));
      }
      for (var k = 1; k < n; k++) {
        if (zq <= oz[k]) {
          var f = (zq - oz[k - 1]) / Math.max(1, oz[k] - oz[k - 1]);
          return Math.exp(Math.log(op[k - 1]) + (Math.log(op[k]) - Math.log(op[k - 1])) * f);
        }
      }
      return op[n - 1];
    }

    for (var g = 0; g < nz; g++) {
      z[g] = g * dz;
      var pp = logp(z[g]) * 100;
      var tt = lin(ot, z[g]) + 273.15;
      var td = Math.min(lin(otd, z[g]) + 273.15, tt - 0.15);
      p[g] = pp;
      T[g] = tt;
      var qs = qsat(tt, pp);
      qv[g] = Math.min(qs, qsat(td, pp));
      RH[g] = qs > 0 ? Math.min(1, qv[g] / qs) : 0;
      th[g] = tt * Math.pow(P0 / pp, RD / CP);
      Tv[g] = tt * (1 + 0.608 * qv[g]);
      u[g] = lin(uo, z[g]);
      v[g] = lin(vo, z[g]);
    }

    var prof = {
      z: z, T: T, p: p, qv: qv, RH: RH, th: th, u: u, v: v, Tv: Tv,
      nz: nz, dz: dz, params: { observed: true }, source: 'observed', obs: obs
    };
    return finishProfile(prof);
  }

  function parseSoundingText(text) {
    if (!text) return null;
    var lines = String(text).replace(/\r/g, '').split('\n');
    var hdr = -1, cols = null;
    for (var i = 0; i < lines.length; i++) {
      if (/PRES/i.test(lines[i]) && /HGHT/i.test(lines[i]) && /TEMP/i.test(lines[i])) {
        hdr = i;
        var tokens = lines[i].trim().split(/\s+/);
        cols = {};
        for (var t = 0; t < tokens.length; t++) {
          var key = tokens[t].toUpperCase();
          if (/PRES/.test(key)) cols.p = t;
          else if (/HGHT/.test(key)) cols.z = t;
          else if (/^TEMP/.test(key)) cols.t = t;
          else if (/^DWPT|DEWP/.test(key)) cols.td = t;
          else if (/^DRCT|WDIR/.test(key)) cols.wd = t;
          else if (/^SKNT|WSPD/.test(key)) cols.ws = t;
        }
        break;
      }
    }
    var rows = [];
    if (hdr >= 0 && cols && cols.p !== undefined && cols.z !== undefined) {
      for (var j = hdr + 1; j < lines.length; j++) {
        var line = lines[j];
        if (/station information|indices|^</i.test(line.trim())) break;
        var f = line.trim().split(/\s+/);
        if (f.length < 3) continue;
        var pv = parseFloat(f[cols.p]);
        var zv = parseFloat(f[cols.z]);
        if (!isFinite(pv) || !isFinite(zv)) continue;
        rows.push({
          p: pv, z: zv,
          t: cols.t !== undefined && isFinite(parseFloat(f[cols.t])) ? parseFloat(f[cols.t]) : null,
          td: cols.td !== undefined && isFinite(parseFloat(f[cols.td])) ? parseFloat(f[cols.td]) : null,
          wd: cols.wd !== undefined && isFinite(parseFloat(f[cols.wd])) ? parseFloat(f[cols.wd]) : 0,
          ws: cols.ws !== undefined && isFinite(parseFloat(f[cols.ws])) ? parseFloat(f[cols.ws]) * 0.514444 : 0
        });
      }
    }
    if (!rows.length) {
      for (var k = 0; k < lines.length; k++) {
        var L = lines[k];
        if (L.length < 51) continue;
        var pi = parseInt(L.substring(9, 15), 10);
        var zi = parseInt(L.substring(16, 21), 10);
        if (!isFinite(pi) || pi === -9999 || !isFinite(zi) || zi === -9999) continue;
        var ti = parseInt(L.substring(22, 27), 10);
        var di = parseInt(L.substring(34, 39), 10);
        var wi = parseInt(L.substring(40, 45), 10);
        var si = parseInt(L.substring(46, 51), 10);
        rows.push({
          p: pi / 10, z: zi,
          t: ti === -9999 ? null : ti / 10,
          td: di === -9999 ? null : di / 10,
          wd: wi === -9999 ? 0 : wi,
          ws: si === -9999 ? 0 : si / 10
        });
      }
    }
    rows = rows.filter(function (r) { return r.z !== null && r.p !== null; }).sort(function (a, b) { return a.z - b.z; });
    if (rows.length < 4) return null;
    function fill(key) {
      var known = rows.filter(function (r) { return r[key] !== null; });
      if (!known.length) return rows.map(function () { return 0; });
      return rows.map(function (r) {
        if (r[key] !== null) return r[key];
        var before = null, after = null;
        for (var q = 0; q < known.length; q++) { if (known[q].z <= r.z) before = known[q]; }
        for (q = 0; q < known.length; q++) { if (known[q].z >= r.z) { after = known[q]; break; } }
        if (before && after && after.z !== before.z) {
          var f = (r.z - before.z) / (after.z - before.z);
          return before[key] + (after[key] - before[key]) * f;
        }
        return (before || after)[key];
      });
    }
    var ts = fill('t'), tds = fill('td'), wds = fill('wd'), wss = fill('ws');
    return {
      z: rows.map(function (r) { return Math.round(r.z); }),
      p: rows.map(function (r) { return +r.p.toFixed(1); }),
      t: ts.map(function (v) { return +v.toFixed(1); }),
      td: tds.map(function (v) { return +v.toFixed(1); }),
      wd: wds.map(function (v) { return Math.round(v); }),
      ws: wss.map(function (v) { return +v.toFixed(1); })
    };
  }

  function precipWater(prof) {
    var sum = 0;
    for (var k = 0; k < prof.nz; k++) {
      var rho = prof.p[k] / (RD * prof.T[k] * (1 + 0.608 * prof.qv[k]));
      sum += prof.qv[k] * rho * prof.dz;
    }
    return sum;
  }

  function downCape(prof) {
    var kBest = Math.round(3000 / prof.dz), thE = 1e9;
    for (var z = 1200; z <= 7000; z += 100) {
      var i = Math.round(z / prof.dz);
      var p = prof.p[i], T = prof.T[i], q = prof.qv[i];
      var tlcl = dewpoint(q, p);
      var te = T * Math.pow(P0 / p, RD / CP) * Math.exp(LV * q / (CP * T)) *
        Math.pow(273.15 / tlcl, 0.28 * q);
      if (te < thE) { thE = te; kBest = i; }
    }
    var Tp = prof.T[kBest];
    var energy = 0;
    for (var k = kBest; k > 0; k--) {
      var pk = prof.p[k];
      var rs = qsat(Tp, pk);
      var num = 1 + LV * rs / (RD * Tp);
      var den = 1 + (LV * LV * rs * EPS) / (CP * RD * Tp * Tp);
      Tp += (G / CP) * (num / den) * prof.dz;
      var TvP = Tp * (1 + 0.608 * Math.min(rs, prof.qv[k]));
      var vb = G * (prof.Tv[k] - TvP) / prof.Tv[k];
      if (vb > 0) energy += vb * prof.dz;
    }
    return energy;
  }

  function interpAt(arr, zs, zq) {
    var dz = zs[1] - zs[0];
    var f = zq / dz;
    var i = Math.min(arr.length - 2, Math.max(0, Math.floor(f)));
    var a = f - i;
    return arr[i] * (1 - a) + arr[i + 1] * a;
  }

  function liftParcel(prof) {
    var dz = prof.dz;
    var nz = prof.nz;
    var Tp = prof.T[0] + 0.5;
    var qp = prof.qv[0];
    var sat = false, lcl = -1;
    var b = new Float64Array(nz);
    var Tpar = new Float64Array(nz);
    var zs = prof.z;

    for (var k = 0; k < nz; k++) {
      var pk = prof.p[k];
      if (!sat) {
        var Td = dewpoint(qp, pk);
        if (Tp <= Td) { sat = true; lcl = zs[k]; }
      }
      var qUse = sat ? Math.min(qp, qsat(Tp, pk)) : qp;
      var TvP = Tp * (1 + 0.608 * qUse);
      b[k] = G * (TvP - prof.Tv[k]) / prof.Tv[k];
      Tpar[k] = Tp;
      if (k < nz - 1) {
        var pk1 = prof.p[k + 1];
        if (!sat) {
          Tp = Tp * Math.pow(pk1 / pk, RD / CP);
        } else {
          var rs = qsat(Tp, pk);
          var num = 1 + LV * rs / (RD * Tp);
          var den = 1 + (LV * LV * rs * EPS) / (CP * RD * Tp * Tp);
          Tp -= (G / CP) * (num / den) * dz;
        }
      }
    }
    if (lcl < 0) lcl = zs[0];

    var lfc = -1, el = -1;
    for (k = 0; k < nz; k++) {
      if (zs[k] > lcl && b[k] > 0) { lfc = zs[k]; break; }
    }
    if (lfc > 0) {
      for (k = nz - 1; k >= 0; k--) {
        if (zs[k] > lfc && b[k] > 0) { el = zs[k]; break; }
      }
    }
    var cape = 0, cin = 0;
    for (k = 0; k < nz; k++) {
      if (zs[k] < lcl) continue;
      if (lfc > 0 && zs[k] > lfc && b[k] > 0) cape += b[k] * dz;
      else if ((lfc < 0 || zs[k] < lfc) && b[k] < 0) cin += b[k] * dz;
    }
    return {
      T: Tpar, b: b, cape: cape, cin: cin, lcl: lcl, lfc: lfc, el: el,
      lclT: interpAt(Tpar, zs, Math.max(lcl, 0))
    };
  }

  function bunkers(prof) {
    var u0 = interpAt(prof.u, prof.z, 0), v0 = interpAt(prof.v, prof.z, 0);
    var u6 = interpAt(prof.u, prof.z, 6000), v6 = interpAt(prof.v, prof.z, 6000);
    var su = 0, sv = 0, cnt = 0;
    for (var z = 0; z <= 6000; z += 250) {
      su += interpAt(prof.u, prof.z, z);
      sv += interpAt(prof.v, prof.z, z);
      cnt++;
    }
    var mu = su / cnt, mv = sv / cnt;
    var du = u6 - u0, dv = v6 - v0;
    var mag = Math.hypot(du, dv);
    var cu = mu, cv = mv;
    if (mag > 0.5) {
      cu = mu + 7.5 * (dv / mag);
      cv = mv - 7.5 * (du / mag);
    }
    return {
      u: cu, v: cv, shear06: mag,
      u0: u0, v0: v0, u6: u6, v6: v6,
      srhMotion: { u: cu, v: cv }
    };
  }

  function srh(prof, sm) {
    return srhLayer(prof, sm, 3000);
  }

  function classify(prof) {
    var cape = prof.cape, shear = prof.shear06;
    if (cape < 200) return 'Конвекции нет';
    if (cape < 800) return 'Слабый потенциал';
    if (shear < 8) return 'Импульсная гроза';
    if (shear < 18) return 'Мультиячейка';
    if (cape > 1500) return 'Суперячейка';
    return 'Наклонённая ячейка';
  }

  /* ---------- Skew-T' diagram ---------- */
  function drawSkewT(canvas, prof, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 60 || H < 60) return;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var padL = 26, padR = 30, padT = 8, padB = 18;
    var pw = W - padL - padR, ph = H - padT - padB;
    var pBot = 1050, pTop = 150;

    function yOf(p) {
      return padT + ph * Math.log(pBot / p) / Math.log(pBot / pTop);
    }
    var skewK = 0.55;
    function xOf(Tk, p) {
      var xBase = padL + pw * 0.52;
      return xBase + (Tk - 273.15) * (pw / 130) + skewK * (Math.log(pBot / p) / Math.log(pBot / pTop)) * pw * 0.42;
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (var p = pTop; p <= pBot; p += 100) {
      var yy = yOf(p);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + pw, yy); ctx.stroke();
    }
    ctx.fillStyle = '#5f7183';
    ctx.font = '9px ui-monospace, monospace';
    [1000, 850, 700, 500, 300, 200].forEach(function (pl) {
      var yy = yOf(pl);
      ctx.fillText(String(pl), 2, yy + 3);
    });

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();

    ctx.strokeStyle = 'rgba(120,160,200,0.14)';
    for (var tc = -70; tc <= 40; tc += 10) {
      ctx.beginPath();
      var first = true;
      for (var pk = pBot; pk >= pTop; pk -= 10) {
        var xx = xOf(tc + 273.15, pk), yv = yOf(pk);
        if (xx < padL - 40 || xx > padL + pw + 40) { first = true; continue; }
        if (first) { ctx.moveTo(xx, yv); first = false; } else ctx.lineTo(xx, yv);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(230,170,90,0.10)';
    for (var thv = 260; thv <= 400; thv += 10) {
      ctx.beginPath();
      first = true;
      for (pk = pBot; pk >= pTop; pk -= 20) {
        var Tk2 = thv * Math.pow(pk * 100 / P0, RD / CP);
        xx = xOf(Tk2, pk); yv = yOf(pk);
        if (xx < padL - 40 || xx > padL + pw + 40) { first = true; continue; }
        if (first) { ctx.moveTo(xx, yv); first = false; } else ctx.lineTo(xx, yv);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(xOf(273.15, pBot), yOf(pBot));
    for (pk = pBot; pk >= pTop; pk -= 20) ctx.lineTo(xOf(273.15, pk), yOf(pk));
    ctx.stroke();

    function curve(arr, color, width, dash) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      var started = false;
      for (var k = 0; k < prof.nz; k++) {
        var pp = prof.p[k] / 100;
        if (pp > pBot || pp < pTop) continue;
        var xx2 = xOf(arr[k], pp), yy2 = yOf(pp);
        if (!started) { ctx.moveTo(xx2, yy2); started = true; } else ctx.lineTo(xx2, yy2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    var tdArr = new Float64Array(prof.nz);
    for (var k = 0; k < prof.nz; k++) tdArr[k] = dewpoint(prof.qv[k], prof.p[k]);
    curve(prof.T, '#ff7a6b', 1.8);
    curve(tdArr, '#4ec9a0', 1.6);
    curve(prof.parcel.T, '#ffc857', 1.4, [4, 3]);

    function marker(zm, color, label) {
      if (zm <= 0) return;
      var kk = Math.min(prof.nz - 1, Math.round(zm / prof.dz));
      var pp = prof.p[kk] / 100;
      if (pp > pBot || pp < pTop) return;
      var xx3 = xOf(prof.parcel.T[kk], pp), yy3 = yOf(pp);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(xx3, yy3, 3, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(230,237,243,0.75)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(label, xx3 + 5, yy3 + 3);
    }
    marker(prof.lcl, '#6fd3ff', 'LCL');
    marker(prof.lfc, '#ffc857', 'LFC');
    marker(prof.el, '#c8a2ff', 'EL');

    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.strokeRect(padL, padT, pw, ph);
  }

  /* ---------- hodograph ---------- */
  function drawHodograph(canvas, prof, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 40 || H < 40) return;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H / 2;
    var R = Math.min(W, H) / 2 - 12;
    var maxSpd = 40;
    function toXY(u, v) {
      return [cx + u / maxSpd * R, cy - v / maxSpd * R];
    }

    ctx.strokeStyle = 'rgba(120,160,200,0.16)';
    [10, 20, 30, 40].forEach(function (s) {
      ctx.beginPath();
      ctx.arc(cx, cy, s / maxSpd * R, 0, 6.2832);
      ctx.stroke();
    });
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.fillStyle = '#5f7183';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('u', cx + R - 8, cy - 4);
    ctx.fillText('v', cx + 4, cy - R + 8);

    var pts = [];
    for (var z = 0; z <= 10000; z += 250) {
      pts.push({ z: z, u: interpAt(prof.u, prof.z, z), v: interpAt(prof.v, prof.z, z) });
    }
    for (var i = 0; i < pts.length - 1; i++) {
      var a = toXY(pts[i].u, pts[i].v), b = toXY(pts[i + 1].u, pts[i + 1].v);
      var f = pts[i].z / 10000;
      ctx.strokeStyle = 'rgb(' + Math.round(80 + 175 * f) + ',' + Math.round(220 - 120 * f) + ',' + Math.round(200 - 120 * f) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    var sm = toXY(prof.storm.u, prof.storm.v);
    ctx.fillStyle = '#ffc857';
    ctx.beginPath();
    ctx.moveTo(sm[0], sm[1] - 5); ctx.lineTo(sm[0] + 4, sm[1] + 3); ctx.lineTo(sm[0] - 4, sm[1] + 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(230,237,243,0.7)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('правая ячейка', Math.min(sm[0] + 6, W - 78), sm[1] + 14);
  }

  ML.sounding = {
    esat: esat, qsat: qsat, dewpoint: dewpoint,
    tempFromTheta: tempFromTheta, intepAt: interpAt, interpAt: interpAt,
    buildProfile: buildProfile, fromObserved: fromObserved, classify: classify,
    drawSkewT: drawSkewT, drawHodograph: drawHodograph,
    G: G, CP: CP, RD: RD, RV: RV, EPS: EPS, LV: LV, P0: P0
  };
})(window);
