(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});

  var phase = 0;

  function draw(canvas, state, dt) {
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    if (W < 40 || H < 40) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var active = !!(state && state.active);
    var vrot = state ? state.vrot || 0 : 0;
    var ef = state ? state.ef || 0 : 0;
    var lcl = state ? state.lcl || 0 : 0;

    phase += (active ? 0.05 + Math.min(0.09, vrot / 400) : 0.012);

    var horizon = H * 0.72;
    var sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#101820');
    sky.addColorStop(0.55, '#1b2733');
    sky.addColorStop(1, '#2a3540');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizon);

    ctx.fillStyle = '#0d1a14';
    ctx.fillRect(0, horizon, W, H - horizon);
    ctx.strokeStyle = 'rgba(120,170,150,0.10)';
    for (var i = 0; i < 14; i++) {
      var yy = horizon + (H - horizon) * (i / 14);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
    }

    var baseY = horizon * 0.30;
    ctx.fillStyle = 'rgba(70,86,100,0.55)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W, 0);
    ctx.lineTo(W, baseY * 0.75);
    for (var x = W; x >= 0; x -= 18) {
      var bump = Math.sin(x * 0.021 + 1.7) * 10 + Math.sin(x * 0.047) * 6;
      ctx.lineTo(x, baseY + bump);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(150,170,190,0.10)';
    ctx.beginPath();
    for (var x2 = 0; x2 < W; x2 += 6) {
      var yy2 = baseY + 6 + Math.sin(x2 * 0.03) * 4;
      if (x2 === 0) ctx.moveTo(x2, yy2); else ctx.lineTo(x2, yy2);
    }
    ctx.stroke();

    var rainX = W * 0.62;
    ctx.fillStyle = 'rgba(90,120,150,0.18)';
    for (var r = 0; r < 40; r++) {
      var rx = rainX + Math.sin(r * 2.3 + phase * 0.4) * W * 0.16;
      var ry = baseY + 10 + (r % 20) * 6;
      ctx.fillRect(rx, ry, 1, 9);
    }

    if (!active) {
      ctx.fillStyle = 'rgba(255,184,77,0.75)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('торнадо не формируется: условий нет', 12, H - 14);
      return;
    }

    var groundY = horizon + 6;
    var topY = baseY + 14;
    var height = groundY - topY;
    var vmax = Math.min(1, vrot / 26);
    var topW = 26 + 30 * vmax;
    var botW = 7 + 5 * vmax;
    var tilt = Math.sin(phase * 0.35) * 10 + (state.shear01 || 0) * 0.6;

    var cx = W * 0.46;

    ctx.save();
    ctx.globalAlpha = 0.9;
    for (var layer = 0; layer < 3; layer++) {
      var wob = 1 + layer * 0.22;
      ctx.beginPath();
      var steps = 26;
      for (var s = 0; s <= steps; s++) {
        var f = s / steps;
        var y0 = topY + height * f;
        var w0 = (topW * (1 - f) * 0.55 + botW * f) * wob;
        var off = Math.sin(f * 7 + phase * (2.2 + layer)) * (10 * f + 2) + tilt * f;
        var px = cx + off - w0;
        if (s === 0) ctx.moveTo(px, y0); else ctx.lineTo(px, y0);
      }
      for (s = steps; s >= 0; s--) {
        f = s / steps;
        y0 = topY + height * f;
        w0 = (topW * (1 - f) * 0.55 + botW * f) * wob;
        off = Math.sin(f * 7 + phase * (2.2 + layer)) * (10 * f + 2) + tilt * f;
        ctx.lineTo(cx + off + w0, y0);
      }
      ctx.closePath();
      var grad = ctx.createLinearGradient(0, topY, 0, groundY);
      grad.addColorStop(0, 'rgba(120,140,160,0.55)');
      grad.addColorStop(0.55, 'rgba(150,165,180,0.42)');
      grad.addColorStop(1, 'rgba(90,80,70,0.55)');
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.restore();

    for (var d = 0; d < 26; d++) {
      var a = d * 0.9 + phase * 3.4;
      var rr = (10 + Math.abs(Math.sin(a * 0.7)) * 34) * (0.5 + vmax);
      var dx = cx + Math.cos(a) * rr + tilt * (0.9 + Math.sin(a) * 0.1);
      var dy = groundY - Math.abs(Math.sin(a)) * 16 + 4;
      ctx.fillStyle = 'rgba(170,150,120,' + (0.10 + 0.20 * Math.abs(Math.cos(a))) + ')';
      ctx.beginPath();
      ctx.arc(dx, dy, 5 + Math.abs(Math.cos(a)) * 9, 0, 6.2832);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(230,240,250,0.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('Vrot ' + vrot.toFixed(0) + ' м/с · EF' + ef + ' · LCL ' + Math.round(lcl) + ' м', 10, 14);
  }

  function checklist(state) {
    var items = [];
    var s = state || {};
    function item(label, ok, value) {
      items.push({ label: label, ok: !!ok, value: value || '' });
    }
    item('мезоциклон', !!(s.meso), s.meso ? (s.meso.strength * 1000).toFixed(1) + '·10⁻³ с⁻¹' : '—');
    item('STP ≥ 1', s.stp >= 1, (s.stp || 0).toFixed(2));
    item('SRH 0–1 км ≥ 100', s.srh01 >= 100, Math.round(s.srh01 || 0) + ' м²/с²');
    item('LCL ≤ 1200 м', s.lcl > 0 && s.lcl <= 1200, Math.round(s.lcl || 0) + ' м');
    item('сдвиг 0–1 км ≥ 6 м/с', s.shear01 >= 6, (s.shear01 || 0).toFixed(1) + ' м/с');
    item('вращение у земли ≥ 6 м/с', s.ngZeta !== undefined && s.vrot >= 6, (s.vrot || 0).toFixed(1) + ' м/с');
    item('холодный купол не гасит', s.cold > -3, (s.cold || 0).toFixed(1) + ' K');
    return items;
  }

  ML.tornado = { draw: draw, checklist: checklist };
})(window);
