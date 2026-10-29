(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});

  var STOPS = [
    [5, [24, 34, 52]],
    [10, [28, 62, 110]],
    [20, [22, 122, 168]],
    [30, [26, 176, 130]],
    [38, [176, 214, 46]],
    [45, [250, 224, 62]],
    [52, [250, 158, 44]],
    [58, [238, 82, 54]],
    [65, [196, 44, 96]],
    [75, [236, 168, 255]]
  ];

  function colorDbz(dbz) {
    if (dbz < STOPS[0][0]) return null;
    for (var i = 0; i < STOPS.length - 1; i++) {
      if (dbz <= STOPS[i + 1][0]) {
        var f = (dbz - STOPS[i][0]) / (STOPS[i + 1][0] - STOPS[i][0]);
        var a = STOPS[i][1], b = STOPS[i + 1][1];
        return [
          Math.round(a[0] + (b[0] - a[0]) * f),
          Math.round(a[1] + (b[1] - a[1]) * f),
          Math.round(a[2] + (b[2] - a[2]) * f)
        ];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }

  function drawPlan(canvas, model, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var nx = model.nx, ny = model.ny;
    var d = Math.min(W, H);
    var ox = (W - d) / 2, oy = (H - d) / 2;

    ctx.fillStyle = '#080c11';
    ctx.fillRect(ox, oy, d, d);

    var img = ctx.createImageData(nx, ny);
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var col = j * nx + i;
        var dbz = model.colDbz[col];
        var rgb = colorDbz(dbz);
        var p = ((ny - 1 - j) * nx + i) * 4;
        if (rgb) {
          img.data[p] = rgb[0];
          img.data[p + 1] = rgb[1];
          img.data[p + 2] = rgb[2];
          img.data[p + 3] = 235;
        } else {
          img.data[p] = 10;
          img.data[p + 1] = 16;
          img.data[p + 2] = 22;
          img.data[p + 3] = 255;
        }
      }
    }
    var off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, ox, oy, d, d);

    ctx.strokeStyle = 'rgba(120,170,200,0.18)';
    ctx.lineWidth = 1;
    for (var r = 10; r < 40; r += 10) {
      ctx.beginPath();
      ctx.arc(ox + d / 2, oy + d / 2, d * r / 40, 0, 6.2832);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120,170,200,0.10)';
    ctx.beginPath();
    ctx.moveTo(ox + d / 2, oy); ctx.lineTo(ox + d / 2, oy + d);
    ctx.moveTo(ox, oy + d / 2); ctx.lineTo(ox + d, oy + d / 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(150,200,220,0.35)';
    ctx.strokeRect(ox + 0.5, oy + 0.5, d - 1, d - 1);

    ctx.fillStyle = 'rgba(160,190,210,0.75)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('С', ox + d / 2 - 3, oy + 9);
    ctx.fillText('Ю', ox + d / 2 - 4, oy + d - 3);

    var maxDbz = -1, best = -1;
    for (var c = 0; c < nx * ny; c++) {
      if (model.colDbz[c] > maxDbz) { maxDbz = model.colDbz[c]; best = c; }
    }
    if (maxDbz > 25 && best >= 0) {
      var bi = best % nx, bj = (best / nx) | 0;
      var bx = ox + (bi + 0.5) / nx * d;
      var by = oy + d - (bj + 0.5) / ny * d;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(bx, by, 9, 0, 6.2832); ctx.stroke();
      ctx.fillStyle = 'rgba(230,240,250,0.9)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(Math.round(maxDbz) + ' dBZ', bx + 12, by + 3);
    }
    drawMeso(ctx, model, ox, oy, d, false);
  }

  function drawMeso(ctx, model, ox, oy, d, withLabel) {
    var list = (model.diag && model.diag.mesocyclones) || [];
    for (var i = 0; i < list.length; i++) {
      var mc = list[i];
      var mx = ox + (mc.x / model.xmax) * d;
      var my = oy + d - (mc.y / model.ymax) * d;
      ctx.strokeStyle = 'rgba(255,120,90,0.95)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(6, mc.diam * 2.2), 0, 6.2832);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx - 4, my); ctx.lineTo(mx + 4, my);
      ctx.moveTo(mx, my - 4); ctx.lineTo(mx, my + 4);
      ctx.stroke();
      if (withLabel) {
        ctx.fillStyle = 'rgba(255,170,150,0.95)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText('МЕЗОЦИКЛОН ' + (mc.strength * 1000).toFixed(1) + '·10⁻³ с⁻¹', mx + 10, my - 8);
      }
    }
  }

  function drawVelocity(canvas, model, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 40 || H < 40) return;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var nx = model.nx, ny = model.ny, nz = model.nz;
    var d = Math.min(W, H);
    var ox = (W - d) / 2, oy = (H - d) / 2;
    ctx.fillStyle = '#080c11';
    ctx.fillRect(ox, oy, d, d);

    var k = Math.max(0, Math.min(nz - 1, Math.round(1500 / model.dz)));
    var nxny = nx * ny;
    var xc = model.xmax / 2, yc = model.ymax / 2;
    var img = ctx.createImageData(nx, ny);
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var c = i + nx * j + nxny * k;
        var x = (i + 0.5) * model.dx - xc;
        var y = (j + 0.5) * model.dy - yc;
        var r = Math.hypot(x, y) || 1;
        var vr = (model.u[c] * x + model.v[c] * y) / r;
        var f = Math.max(-1, Math.min(1, vr / 30));
        var p = ((ny - 1 - j) * nx + i) * 4;
        if (f >= 0) {
          img.data[p] = 40 + 200 * f;
          img.data[p + 1] = 60 + 40 * (1 - f);
          img.data[p + 2] = 90 * (1 - f);
        } else {
          var g = -f;
          img.data[p] = 40 + 40 * (1 - g);
          img.data[p + 1] = 60 + 180 * g;
          img.data[p + 2] = 90 + 60 * g;
        }
        img.data[p + 3] = 255;
      }
    }
    var off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, ox, oy, d, d);

    ctx.strokeStyle = 'rgba(120,170,200,0.18)';
    for (var rr = 10; rr < model.xmax / 1000; rr += 10) {
      ctx.beginPath();
      ctx.arc(ox + d / 2, oy + d / 2, d * rr / (model.xmax / 1000), 0, 6.2832);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(220,235,245,0.8)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('к радару', ox + 6, oy + 14);
    ctx.fillText('от радара', ox + d - 66, oy + d - 8);
    ctx.strokeStyle = 'rgba(150,200,220,0.35)';
    ctx.strokeRect(ox + 0.5, oy + 0.5, d - 1, d - 1);
    drawMeso(ctx, model, ox, oy, d, false);
  }

  function drawWindow(canvas, model, mode, dpr) {
    if (mode === 'vel') return drawVelocity(canvas, model, dpr);
    if (mode === 'section') return drawSection(canvas, model, dpr);
    if (mode === 'cells') {
      drawPlan(canvas, model, dpr);
      var ctx2 = canvas.getContext('2d');
      var W2 = canvas.clientWidth, H2 = canvas.clientHeight;
      var d2 = Math.min(W2, H2);
      var ox2 = (W2 - d2) / 2, oy2 = (H2 - d2) / 2;
      var list = (model.diag && model.diag.cellList) || [];
      ctx2.font = '10px ui-monospace, monospace';
      for (var n = 0; n < list.length; n++) {
        var cell = list[n];
        var cx = ox2 + (cell.x / model.xmax) * d2;
        var cy = oy2 + d2 - (cell.y / model.ymax) * d2;
        var rad = Math.max(5, Math.sqrt(cell.area / Math.PI) * d2 / (model.xmax / 1000));
        ctx2.strokeStyle = 'rgba(255,220,120,0.9)';
        ctx2.lineWidth = 1.4;
        ctx2.beginPath();
        ctx2.arc(cx, cy, rad, 0, 6.2832);
        ctx2.stroke();
        ctx2.fillStyle = 'rgba(255,235,170,0.95)';
        ctx2.fillText('#' + (n + 1) + ' ' + cell.area.toFixed(0) + ' км²', cx + rad + 3, cy + 3);
      }
      drawMeso(ctx2, model, ox2, oy2, d2, true);
      return;
    }
    if (mode === 'dbz') {
      drawPlan(canvas, model, dpr);
      var ctx = canvas.getContext('2d');
      var W = canvas.clientWidth, H = canvas.clientHeight;
      var d = Math.min(W, H);
      var ox = (W - d) / 2, oy = (H - d) / 2;
      drawMeso(ctx, model, ox, oy, d, true);
      return;
    }
    drawPlan(canvas, model, dpr);
  }

  function drawSection(canvas, model, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var nx = model.nx, nz = model.nz;
    var jc = (model.ny / 2) | 0;
    var padL = 4, padB = 4;
    var cw = (W - padL) / nx, ch = (H - padB) / nz;

    ctx.fillStyle = '#080c11';
    ctx.fillRect(0, 0, W, H);

    for (var k = 0; k < nz; k++) {
      for (var i = 0; i < nx; i++) {
        var c = i + nx * (jc + model.ny * k);
        var qc = model.qc[c] + model.qi[c];
        var qr = model.qr[c];
        var col;
        if (qr > 1e-7) {
          var dbz = 3.63e9 * Math.pow(model.rho0[k] * qr, 1.75);
          var r = colorDbz(dbz > 1 ? 10 * Math.log(dbz) / Math.LN10 : 0);
          col = r ? 'rgb(' + r[0] + ',' + r[1] + ',' + r[2] + ')' : 'rgba(30,50,70,0.5)';
        } else if (qc > 2e-6) {
          var a = Math.min(0.85, 0.25 + Math.sqrt(qc) * 12);
          col = 'rgba(210,225,240,' + a.toFixed(3) + ')';
        } else {
          var w = model.w[c];
          var thp = model.th[c] - model.th0[k];
          if (w > 1) col = 'rgba(80,190,255,' + Math.min(0.4, w / 60).toFixed(3) + ')';
          else if (thp < -1) col = 'rgba(90,140,190,' + Math.min(0.35, -thp / 12).toFixed(3) + ')';
          else col = 'rgba(12,18,26,1)';
        }
        ctx.fillStyle = col;
        ctx.fillRect(padL + i * cw, H - padB - (k + 1) * ch, cw + 0.6, ch + 0.6);
      }
    }

    ctx.strokeStyle = 'rgba(120,170,200,0.12)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(160,190,210,0.55)';
    for (var km = 2; km <= 12; km += 2) {
      var y = H - padB - (km / (model.zmax / 1000)) * (H - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(km + ' км', W - 34, y - 3);
    }
    ctx.strokeStyle = 'rgba(150,200,220,0.3)';
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  ML.radar = {
    drawPlan: drawPlan, drawVelocity: drawVelocity, drawSection: drawSection,
    drawWindow: drawWindow, drawField: drawField, drawTornado: drawTornado, colorDbz: colorDbz
  };

  var FIELD_COLORS = {

    dbz: null,
    ice: null,
    temp: null,
    w: null,
    moist: null,
    zeta: null,
    uh: null,
    cold: null
  };

  function lerp(a, b, f) { return a + (b - a) * f; }

  function ramp(stops, f) {
    f = Math.max(0, Math.min(1, f));
    for (var i = 0; i < stops.length - 1; i++) {
      if (f <= stops[i + 1][0]) {
        var k = (f - stops[i][0]) / (stops[i + 1][0] - stops[i][0] || 1);
        return [
          Math.round(lerp(stops[i][1], stops[i + 1][1], k)),
          Math.round(lerp(stops[i][2], stops[i + 1][2], k)),
          Math.round(lerp(stops[i][3], stops[i + 1][3], k))
        ];
      }
    }
    var last = stops[stops.length - 1];
    return [last[1], last[2], last[3]];
  }

  var RAMP_W = [[0,10,16,26],[0.25,26,90,140],[0.5,40,180,170],[0.75,230,230,120],[1,255,255,240]];
  var RAMP_DIV = [[0,30,90,200],[0.5,16,22,30],[1,220,70,50]];
  var RAMP_MOIST = [[0,18,22,28],[0.4,40,110,140],[0.75,80,190,170],[1,220,250,235]];
  var RAMP_ICE = [[0,20,26,34],[0.4,90,120,200],[0.7,180,200,245],[1,255,255,255]];
  var RAMP_UH = [[0,20,22,26],[0.35,70,40,110],[0.7,170,60,160],[1,250,140,220]];

  function drawField(canvas, model, mode, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 40 || H < 40) return;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var nx = model.nx, ny = model.ny, nz = model.nz, nxny = nx * ny;
    var d = Math.min(W, H), ox = (W - d) / 2, oy = (H - d) / 2;
    ctx.fillStyle = '#080c11';
    ctx.fillRect(ox, oy, d, d);

    var kLow = Math.max(0, Math.min(nz - 1, Math.round(1500 / model.dz)));
    var kMid = Math.max(0, Math.min(nz - 1, Math.round(3000 / model.dz)));
    var img = ctx.createImageData(nx, ny);
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var col = j * nx + i;
        var rgb = [10, 14, 20];
        if (mode === 'dbz') {
          var r = colorDbz(model.colDbz[col]);
          if (r) rgb = r;
        } else if (mode === 'uh') {
          rgb = ramp(RAMP_UH, model.colUH[col] / 300);
        } else if (mode === 'cold') {
          var cth = model.th[col] - model.th0[0];
          var cf = 0.5 + Math.max(-1, Math.min(1, cth / 8)) * 0.5;
          rgb = ramp(RAMP_DIV, cf);
        } else {
          var maxQi = 0, maxW = 0;
          for (var k = 0; k < nz; k++) {
            var cc = col + nxny * k;
            if (model.qi[cc] > maxQi) maxQi = model.qi[cc];
            if (model.w[cc] > maxW) maxW = model.w[cc];
          }
          if (mode === 'ice') {
            var dbzIce = maxQi > 1e-8 ? 10 * Math.log(1e9 * Math.pow(model.rho0[kMid] * maxQi, 1.75)) / Math.LN10 : 0;
            rgb = ramp(RAMP_ICE, Math.max(0, dbzIce - 5) / 55);
          } else if (mode === 'w') {
            rgb = ramp(RAMP_W, maxW / 40);
          } else if (mode === 'zeta') {
            var c2 = col + nxny * kMid;
            var ip = i === nx - 1 ? 0 : i + 1, im = i === 0 ? nx - 1 : i - 1;
            var jp = j === ny - 1 ? 0 : j + 1, jm = j === 0 ? ny - 1 : j - 1;
            var zeta = (model.v[ip + nx * j + nxny * kMid] - model.v[im + nx * j + nxny * kMid]) / (2 * model.dx) -
              (model.u[i + nx * jp + nxny * kMid] - model.u[i + nx * jm + nxny * kMid]) / (2 * model.dy);
            rgb = ramp(RAMP_DIV, 0.5 + Math.max(-1, Math.min(1, zeta / 0.008)) * 0.5);
          } else if (mode === 'temp') {
            var thp2 = model.th[col + nxny * kMid] - model.th0[kMid];
            rgb = ramp(RAMP_DIV, 0.5 + Math.max(-1, Math.min(1, thp2 / 6)) * 0.5);
          } else if (mode === 'moist') {
            rgb = ramp(RAMP_MOIST, model.qv[col + nxny * kLow] / 0.018);
          }
        }
        var p = ((ny - 1 - j) * nx + i) * 4;
        img.data[p] = rgb[0];
        img.data[p + 1] = rgb[1];
        img.data[p + 2] = rgb[2];
        img.data[p + 3] = 255;
      }
    }
    var off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, ox, oy, d, d);

    ctx.strokeStyle = 'rgba(120,170,200,0.18)';
    for (var rr = 20; rr < model.xmax / 1000; rr += 20) {
      ctx.beginPath();
      ctx.arc(ox + d / 2, oy + d / 2, d * rr / (model.xmax / 1000), 0, 6.2832);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(150,200,220,0.35)';
    ctx.strokeRect(ox + 0.5, oy + 0.5, d - 1, d - 1);
    drawMeso(ctx, model, ox, oy, d, true);
  }

  function drawTornado(canvas, model, tNow, dpr) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 40 || H < 40) return;
    dpr = dpr || global.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a1017');
    g.addColorStop(1, '#12181c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var tor = (model.diag && model.diag.tornado) || { active: false };
    var conds = (model.diag && model.diag.tornadoConditions) || [];

    if (!tor.active) {
      ctx.fillStyle = '#ffb84d';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('ТОРНАДО НЕ СИМУЛИРУЕТСЯ — УСЛОВИЯ НЕ ВЫПОЛНЕНЫ', 12, 22);
      ctx.font = '10.5px ui-monospace, monospace';
      for (var i = 0; i < conds.length; i++) {
        var c = conds[i];
        var y = 48 + i * 26;
        ctx.fillStyle = c.ok ? '#4ee6a8' : '#ff7a6b';
        ctx.fillText(c.ok ? '✓' : '✗', 14, y);
        ctx.fillStyle = '#cdd9e4';
        ctx.fillText(c.name, 30, y);
        var shown = c.id === 'zeta' ? (c.value * 1000).toFixed(2) + '·10⁻³' :
          (c.id === 'lcl' ? Math.round(c.value) + ' м' : c.value.toFixed(1));
        ctx.fillStyle = c.ok ? '#9fe8c8' : '#ffb0a4';
        ctx.fillText(shown, 160, y);
        ctx.fillStyle = '#6f8296';
        ctx.fillText(c.need, 250, y);
      }
      ctx.fillStyle = '#5f7183';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('Нужны: мезоциклон ≥ 4 мин, LCL ≤ 1600 м, SRH ≥ 80 м²/с²,', 12, H - 30);
      ctx.fillText('ζ 0–1,5 км ≥ 1,8·10⁻³ с⁻¹, поток ≥ 4,5 м/с, отток не сильнее −5 K.', 12, H - 15);
      return;
    }

    var lcl = Math.max(400, (model.profile && model.profile.lcl) || 1200);
    var baseY = H * 0.34;
    var groundY = H - 46;
    var cx = W * 0.42;
    var phase = tNow / 260;
    var ef = tor.ef;
    var topW = 26 + 8 * ef;
    var botW = 3 + 2.2 * ef;

    ctx.fillStyle = 'rgba(160,175,190,0.10)';
    ctx.beginPath();
    ctx.ellipse(cx, baseY - 16, W * 0.32, 30, 0, 0, 6.2832);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - topW, baseY);
    for (var s = 1; s <= 18; s++) {
      var f = s / 18;
      var yy = baseY + (groundY - baseY) * f;
      var wob = Math.sin(phase + f * 5.2) * (5 + 4 * f) * (1 - f * 0.4);
      var ww = topW + (botW - topW) * Math.pow(f, 0.7);
      ctx.lineTo(cx - ww + wob, yy);
    }
    for (s = 18; s >= 0; s--) {
      f = s / 18;
      yy = baseY + (groundY - baseY) * f;
      wob = Math.sin(phase + f * 5.2 + 1.7) * (5 + 4 * f) * (1 - f * 0.4);
      ww = topW + (botW - topW) * Math.pow(f, 0.7);
      ctx.lineTo(cx + ww + wob, yy);
    }
    ctx.closePath();
    var fg = ctx.createLinearGradient(0, baseY, 0, groundY);
    fg.addColorStop(0, 'rgba(215,224,235,0.85)');
    fg.addColorStop(0.55, 'rgba(150,165,180,0.75)');
    fg.addColorStop(1, 'rgba(90,80,70,0.85)');
    ctx.fillStyle = fg;
    ctx.fill();

    ctx.strokeStyle = 'rgba(235,245,255,0.30)';
    ctx.lineWidth = 1;
    for (var b = -2; b <= 2; b++) {
      ctx.beginPath();
      for (s = 0; s <= 18; s++) {
        f = s / 18;
        yy = baseY + (groundY - baseY) * f;
        var ww2 = topW + (botW - topW) * Math.pow(f, 0.7);
        var ph = Math.sin(phase + f * 5.2 + b * 0.55) * (5 + 4 * f);
        var xx = cx + ww2 * Math.sin(phase * 1.6 + b * 0.9 + f * 3) * 0.55 + ph;
        if (s === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(120,105,90,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, groundY, topW * 1.5, 9, 0, 0, 6.2832);
    ctx.fill();
    for (var dd = 0; dd < 26; dd++) {
      var ang = phase * 2 + dd * 0.7;
      var rad = topW * (1.1 + 0.9 * ((dd % 5) / 5));
      ctx.fillStyle = 'rgba(180,170,150,' + (0.10 + 0.12 * (dd % 3)) + ')';
      ctx.fillRect(cx + Math.cos(ang) * rad, groundY + Math.sin(ang) * 5 - 4, 2, 2);
    }

    ctx.fillStyle = '#0e1418';
    ctx.save();
    ctx.beginPath();
    ctx.rect(8, H - 78, 116, 70);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,12,16,0.9)';
    ctx.fillRect(8, H - 78, 116, 70);
    var tr = tor.track || [];
    var sc = 106 / (model.xmax / 1000);
    ctx.strokeStyle = 'rgba(255,150,110,0.85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (var q = 0; q < tr.length; q++) {
      var px = 10 + (tr[q].x / 1000) * sc;
      var py = H - 12 - (tr[q].y / 1000) * sc;
      if (q === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    var lastPt = tr.length ? tr[tr.length - 1] : { x: tor.x, y: tor.y };
    ctx.fillStyle = '#ff8a5c';
    ctx.beginPath();
    ctx.arc(10 + (lastPt.x / 1000) * sc, H - 12 - (lastPt.y / 1000) * sc, 3, 0, 6.2832);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(150,200,220,0.35)';
    ctx.strokeRect(8.5, H - 77.5, 115, 69);

    ctx.fillStyle = '#ffb0a4';
    ctx.font = 'bold 20px ui-monospace, monospace';
    ctx.fillText('EF' + ef, 16, 34);
    ctx.fillStyle = '#cdd9e4';
    ctx.font = '10.5px ui-monospace, monospace';
    ctx.fillText('ζ ' + (tor.zetaLow * 1000).toFixed(2) + '·10⁻³ с⁻¹', 16, 52);
    ctx.fillText('Δp ' + tor.dp.toFixed(1) + ' гПа', 16, 67);
    ctx.fillText('R ' + Math.round(tor.radius) + ' м', 16, 82);
    ctx.fillText('на земле ' + fmtDur(tor.duration), 16, 97);
    ctx.fillStyle = '#6f8296';
    ctx.fillText('LCL ' + Math.round(lcl) + ' м · трек в плане', 16, 112);
  }

  function fmtDur(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
})(window);
