(function (global) {
  'use strict';
  var ML = global.ML;
  if (!ML || !ML.sounding || !ML.Model || !ML.presets) {
    document.body.innerHTML = '<p style="padding:24px;color:#ffb84d">Не загрузилось расчётное ядро модели.</p>';
    return;
  }

  var S = ML.sounding;

  var params = {
    t0: 32, rh0: 66, lapseLow: 7.4, lapseMid: 6.8, lapseTop: 6.0, zTrop: 12.5,
    rhMid: 50, rhTop: 30,
    ws0: 5, ws3: 9, ws6: 14, ws10: 20,
    wd0: 180, veer: 55, bubble: 1.6, heating: 1.0
  };

  var seedMode = 'field';
  var seedCount = 8;
  var gridSize = 120;
  var activePreset = 'field';

  var profile = null;
  var observed = null;
  var model = null;
  var view = null;
  var running = true;
  var speed = 2;
  var series = [];
  var lastSeriesTime = -1;
  var chartKey = 'w';
  var panelMode = 'plan';
  var radarOpen = false;
  var radarTab = 'dbz';
  var radarField = 'dbz';
  var tornadoOpen = false;
  var tornadoAutoShown = false;
  var markerEls = [];

  var frameCount = 0;
  var fpsFrames = 0;
  var lastFpsTime = performance.now();

  var RANGE_NAMES = {
    t0: 'Температура у земли',
    rh0: 'Влажность у земли',
    lapseLow: 'Градиент температуры 0–3 км',
    lapseMid: 'Градиент температуры 3–8 км',
    zTrop: 'Высота тропопаузы',
    rhMid: 'Влажность на 5 км',
    rhTop: 'Влажность у тропопаузы',
    ws0: 'Скорость ветра у земли',
    ws3: 'Скорость ветра на 3 км',
    ws6: 'Скорость ветра на 6 км',
    ws10: 'Скорость ветра на 10 км',
    wd0: 'Направление ветра у земли',
    veer: 'Поворот ветра к 10 км',
    bubble: 'Импульс запуска конвекции',
    heating: 'Прогрев поверхности',
    clip: 'Обрезка объёма по высоте',
    quality: 'Качество объёмной визуализации'
  };

  function $(id) { return document.getElementById(id); }

  function fmt(v, d) {
    if (!isFinite(v)) return '—';
    return v.toFixed(d === undefined ? 0 : d).replace('.', ',');
  }

  function windParams() {
    params.wd3 = params.wd0 + params.veer * 0.33;
    params.wd6 = params.wd0 + params.veer * 0.66;
    params.wd10 = params.wd0 + params.veer;
  }

  function syncLabels() {
    $('out-t0').textContent = fmt(params.t0, 1) + ' °C';
    $('out-rh0').textContent = fmt(params.rh0) + ' %';
    $('out-lapseLow').textContent = fmt(params.lapseLow, 1) + ' K/км';
    $('out-lapseMid').textContent = fmt(params.lapseMid, 1) + ' K/км';
    $('out-zTrop').textContent = fmt(params.zTrop, 1) + ' км';
    $('out-rhMid').textContent = fmt(params.rhMid) + ' %';
    $('out-rhTop').textContent = fmt(params.rhTop) + ' %';
    $('out-windlow').textContent = params.ws0 + ' · ' + params.ws3 + ' · ' + params.ws6 + ' · ' + params.ws10;
    $('out-wd0').textContent = fmt(params.wd0) + '°';
    $('out-veer').textContent = (params.veer > 0 ? '+' : '') + fmt(params.veer) + '°';
    $('out-bubble').textContent = fmt(params.bubble, 1) + ' K';
    $('out-heating').textContent = fmt(params.heating, 1);
  }

  function applyParamsToDom() {
    var inputs = document.querySelectorAll('input[data-param]');
    for (var i = 0; i < inputs.length; i++) {
      var key = inputs[i].getAttribute('data-param');
      if (key in params) inputs[i].value = params[key];
    }
    $('sel-mode').value = seedMode;
    $('sel-grid').value = String(gridSize);
    syncLabels();
  }

  function buildPresets() {
    var box = $('presets');
    box.innerHTML = '';
    ML.presets.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'storm' + (p.id === activePreset ? ' is-on' : '');
      b.setAttribute('data-preset', p.id);
      b.innerHTML = '<b>' + p.name + '</b><i>' + p.tag + '</i>';
      b.addEventListener('click', function () { applyPreset(p.id, true); });
      box.appendChild(b);
    });
  }

  function markPreset(id) {
    var btns = document.querySelectorAll('[data-preset]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('is-on', btns[i].getAttribute('data-preset') === id);
    }
  }

  function applyPreset(id, autostart) {
    var p = ML.getPreset(id);
    var k;
    for (k in p.params) if (Object.prototype.hasOwnProperty.call(p.params, k)) params[k] = p.params[k];
    params.heating = p.heating;
    params.bubble = p.bubble;
    seedMode = p.mode;
    seedCount = p.count;
    activePreset = id;
    $('preset-desc').textContent = p.desc;
    markPreset(id);
    applyParamsToDom();
    rebuild();
    if (autostart) { running = true; syncRunUi(); }
  }

  function rebuild() {
    windParams();
    try {
      profile = observed || S.buildProfile(params);
    } catch (e) { console.error(e); return; }
    S.drawSkewT($('skew'), profile);
    S.drawHodograph($('hodo'), profile);
    updateEnvStats();
    resetModel();
  }

  function setObserved(prof, metaLabel) {
    observed = prof;
    observed.meta = observed.meta || {};
    $('obs-status').textContent = metaLabel || 'наблюдение';
    $('obs-note').textContent = 'Источник: ' + (metaLabel || 'импорт') +
      ' · уровней: ' + (prof.meta.levels || '—') + ' · CAPE ' + Math.round(prof.cape) + ' Дж/кг';
    rebuild();
  }

  function observationLabel(entry) {
    return entry.label || 'Зондирование';
  }

  function refreshObsList(selectId) {
    var sel = $('sel-obs');
    var list = ML.observations.storage();
    var cur = selectId || sel.value;
    sel.innerHTML = '<option value="">— мои зондирования (' + list.length + ') —</option>';
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i].id;
      o.textContent = observationLabel(list[i]);
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  }

  function applyObsText(text, hintLabel) {
    var parsed;
    try {
      parsed = ML.observations.parse(text, hintLabel);
    } catch (e) {
      $('obs-note').textContent = 'Не разобрано: ' + e.message;
      return null;
    }
    var prof;
    try {
      prof = S.fromObserved(parsed.levels, parsed.meta);
    } catch (e2) {
      $('obs-note').textContent = 'Профиль не построен: ' + e2.message;
      return null;
    }
    prof.meta.levels = parsed.levels.length;
    var entry = ML.observations.save(text, { meta: parsed.meta });
    refreshObsList(entry.id);
    setObserved(prof, observationLabel(entry));
    return prof;
  }

  function bindObservations() {
    refreshObsList();
    $('sel-obs').addEventListener('change', function (e) {
      var id = e.target.value;
      if (!id) return;
      var list = ML.observations.storage();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          $('obs-text').value = list[i].text;
          applyObsText(list[i].text, observationLabel(list[i]));
          break;
        }
      }
    });
    $('btn-obs-apply').addEventListener('click', function () {
      var text = $('obs-text').value.trim();
      if (!text) { $('obs-note').textContent = 'Вставьте текст зондирования.'; return; }
      applyObsText(text);
    });
    $('btn-obs-del').addEventListener('click', function () {
      var id = $('sel-obs').value;
      if (!id) { $('obs-note').textContent = 'Выберите зондирование в списке.'; return; }
      if (!ML.observations.remove(id)) { $('obs-note').textContent = 'Не удалось удалить.'; return; }
      refreshObsList('');
      observed = null;
      $('obs-status').textContent = '—';
      rebuild();
    });
    $('btn-obs-template').addEventListener('click', function () {
      $('obs-text').value = ML.observations.templates()[0].text;
      $('obs-note').textContent = 'Шаблон формата UWyo. Замените строки своими данными из архива.';
    });
    $('obs-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        $('obs-text').value = String(reader.result || '');
        applyObsText($('obs-text').value, f.name);
      };
      reader.readAsText(f);
    });
    $('btn-obs-fetch').addEventListener('click', function () {
      var url = $('obs-url').value.trim();
      if (!url) return;
      $('obs-note').textContent = 'Загружаю ' + url + ' …';
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (text) {
        $('obs-text').value = text.slice(0, 20000);
        applyObsText(text, url.split('/').pop());
      }).catch(function (err) {
        $('obs-note').textContent = 'Не загрузилось (' + err.message +
          '). Архивы часто блокируют запросы из браузера — скачайте файл и загрузите его кнопкой «Файл».';
      });
    });
  }

  function resetModel() {
    try {
      model = new ML.Model(profile, {
        nx: gridSize, ny: gridSize, mode: seedMode, count: seedCount,
        heating: params.heating, bubble: params.bubble
      });
    } catch (e) {
      console.error(e);
      $('gl-hint').textContent = 'Ошибка инициализации модели: ' + e.message;
      return;
    }
    series = [];
    lastSeriesTime = -1;
    $('pill-grid').innerHTML = '<i>сетка</i> ' + model.nx + '×' + model.ny + '×' + model.nz;
    if (view) view.setModel(model);
    updateLiveStats();
    drawPanels();
  }

  function updateEnvStats() {
    $('st-cape').textContent = fmt(profile.cape) + ' Дж/кг';
    $('st-cin').textContent = fmt(profile.cin) + ' Дж/кг';
    $('st-dcape').textContent = fmt(profile.dcape) + ' Дж/кг';
    $('st-pwat').textContent = fmt(profile.pwat, 1) + ' мм';
    $('st-lcl').textContent = fmt(profile.lcl / 1000, 1) + ' км';
    $('st-lfc').textContent = profile.lfc > 0 ? fmt(profile.lfc / 1000, 1) + ' км' : '—';
    $('st-el').textContent = profile.el > 0 ? fmt(profile.el / 1000, 1) + ' км' : '—';
    $('st-shear').textContent = fmt(profile.shear06) + ' м/с';
    $('st-shear01').textContent = fmt(profile.shear01, 1) + ' м/с';
    $('st-srh').textContent = fmt(profile.srh) + ' м²/с²';
    $('st-brn').textContent = fmt(profile.brn, 1);
    $('st-regime').textContent = S.classify(profile);
  }

  function liveRegime() {
    var d = model.diag;
    if (d.maxW < 1.5) return 'конвекции нет';
    if (d.uh > 200) return 'суперячейка (вращение)';
    if (d.cells >= 4) return 'мультиячейковый кластер';
    if (d.cells === 3) return 'несколько ячеек';
    if (d.uh > 60) return 'наклонённый поток';
    return 'одиночная ячейка';
  }

  function updateLiveStats() {
    if (!model) return;
    var d = model.diag;
    $('st-w').textContent = fmt(Math.max(0, d.maxW), 1) + ' м/с';
    $('st-cells').textContent = fmt(d.cells);
    $('st-top').textContent = fmt(d.cloudTop / 1000, 1) + ' км';
    $('st-dbz').textContent = d.maxDBZ > 1 ? fmt(d.maxDBZ) + ' dBZ' : '—';
    $('st-rain').textContent = fmt(d.rainRate, 1) + ' мм/ч';
    $('st-rainarea').textContent = fmt(d.rainArea) + ' км²';
    $('st-cold').textContent = fmt(d.coldPool, 1) + ' K';
    $('st-uh').textContent = fmt(d.uh) + ' м²/с²';
    $('st-meso').textContent = fmt((d.mesocyclones || []).length);
    updateSignatures();
    updateTornadoUi();
    $('st-area').textContent = fmt(d.updraftArea) + ' из ' + (model.nx * model.ny);
    $('st-mode').textContent = liveRegime();

    $('live-cells').textContent = 'ячеек: ' + fmt(d.cells);
    $('live-area').textContent = 'восходящих столбцов: ' + fmt(d.updraftArea);
    $('live-top').textContent = 'верх: ' + fmt(d.cloudTop / 1000, 1) + ' км';
    $('live-rain').textContent = 'дождь: ' + fmt(d.rainRate, 1) + ' мм/ч';
    $('pill-cells').innerHTML = '<i>ячеек</i> ' + fmt(d.cells);
    $('pill-ms').innerHTML = '<i>шаг</i> ' + Math.round(model.stepMs) + ' мс';

    var t = model.time;
    var mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    $('sim-time').textContent = 'T+' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    $('sim-meta').textContent = 'шагов ' + model.stepCount + ' · Δt ' + model.dt + ' с';
    $('sim-bars').style.width = Math.min(100, t / 3600 * 100).toFixed(1) + '%';
    $('panel-meta').textContent = d.maxDBZ > 1 ? 'Zmax ' + fmt(d.maxDBZ) + ' dBZ' : 'без эха';
  }

  function drawPanels() {
    if (!model) return;
    if (panelMode === 'plan') ML.radar.drawPlan($('radar'), model);
    else ML.radar.drawSection($('section'), model);
    drawChart();
  }

  function pushSeries() {
    if (!model) return;
    if (model.time - lastSeriesTime < 10 && lastSeriesTime >= 0) return;
    lastSeriesTime = model.time;
    series.push({
      t: model.time,
      w: Math.max(0, model.diag.maxW),
      top: model.diag.cloudTop / 1000,
      dbz: model.diag.maxDBZ,
      rain: model.diag.rainRate,
      uh: model.diag.uh,
      cells: model.diag.cells
    });
    if (series.length > 900) series.shift();
  }

  var SERIES = {
    w: { label: 'max w, м/с', unit: 'м/с', min: 20 },
    top: { label: 'верх облака, км', unit: 'км', min: 12 },
    dbz: { label: 'max dBZ', unit: 'dBZ', min: 60 },
    rain: { label: 'дождь, мм/ч', unit: 'мм/ч', min: 10 },
    uh: { label: 'UH, м²/с²', unit: '', min: 100 },
    cells: { label: 'число ячеек', unit: '', min: 4 }
  };

  function drawChart() {
    var canvas = $('chart');
    var ctx = canvas.getContext('2d');
    var W = canvas.clientWidth, H = canvas.clientHeight;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#070b0f';
    ctx.fillRect(0, 0, W, H);

    var meta = SERIES[chartKey];
    var padL = 24, padR = 8, padT = 6, padB = 12;
    var pw = W - padL - padR, ph = H - padT - padB;

    if (series.length < 2) {
      ctx.fillStyle = '#3a4756';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText('нет данных — запустите модель', padL, padT + ph / 2);
      $('chart-legend').textContent = meta.label;
      $('chart-peak').textContent = '—';
      return;
    }

    var peak = meta.min;
    for (var i = 0; i < series.length; i++) if (series[i][chartKey] > peak) peak = series[i][chartKey];
    var tMax = Math.max(series[series.length - 1].t, 60);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var yy = padT + ph * g / 4;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + pw, yy); ctx.stroke();
    }
    ctx.fillStyle = '#4c5c6d';
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(String(Math.round(peak)), 2, padT + 6);
    ctx.fillText('0', 12, padT + ph + 1);
    ctx.fillText(Math.round(tMax / 60) + ' мин', W - 40, padT + ph + 10);

    function xOf(t) { return padL + pw * (t / tMax); }
    function yOf(v) { return padT + ph * (1 - Math.min(1, v / peak)); }

    ctx.strokeStyle = chartKey === 'top' ? '#35e0c0' : (chartKey === 'dbz' ? '#ff7a6b' : '#ffb84d');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var j = 0; j < series.length; j++) {
      var p = series[j];
      if (j === 0) ctx.moveTo(xOf(p.t), yOf(p[chartKey]));
      else ctx.lineTo(xOf(p.t), yOf(p[chartKey]));
    }
    ctx.stroke();

    var last = series[series.length - 1][chartKey];
    $('chart-legend').textContent = meta.label;
    $('chart-peak').textContent = 'пик ' + fmt(peak, 1) + (meta.unit ? ' ' + meta.unit : '') +
      ' · сейчас ' + fmt(last, 1);
  }

  function updateMarkers() {
    var box = $('markers');
    if (!box || !model || !view || !view.ok) return;
    var list = (model.diag && model.diag.mesocyclones) || [];
    while (markerEls.length < list.length) {
      var el = document.createElement('div');
      el.className = 'mc';
      el.innerHTML = '<span class="mc__dot"></span><span class="mc__txt"></span>';
      box.appendChild(el);
      markerEls.push(el);
    }
    for (var i = 0; i < markerEls.length; i++) {
      var node = markerEls[i];
      if (i >= list.length) { node.style.display = 'none'; continue; }
      var mc = list[i];
      var p = view.project(mc.x / 1000, mc.z / 1000, mc.y / 1000);
      if (!p) { node.style.display = 'none'; continue; }
      node.style.display = 'flex';
      node.style.left = p.x + 'px';
      node.style.top = p.y + 'px';
      node.querySelector('.mc__txt').textContent =
        'МЕЗОЦИКЛОН ' + (mc.strength * 1000).toFixed(1) + ' · ' + Math.round(mc.age) + ' с';
    }
  }

  function drawRadarWindow() {
    if (!radarOpen || !model) return;
    var canvas = $('radarwin-canvas');
    if (!canvas.clientWidth) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    if (radarTab === 'field') ML.radar.drawField(canvas, model, radarField, dpr);
    else ML.radar.drawWindow(canvas, model, radarTab, dpr);
    var d = model.diag;
    var meso = (d.mesocyclones || []).length;
    var parts = [
      'T+' + fmt(model.time / 60, 1) + ' мин',
      'dBZ ' + (d.maxDBZ > 1 ? fmt(d.maxDBZ) : '—'),
      'ячеек ' + d.cells,
      'мезоциклонов ' + meso
    ];
    if (radarTab === 'vel') parts.push('радиальная скорость на 1,5 км');
    if (radarTab === 'section') parts.push('разрез по центру области');
    if (radarTab === 'cells') {
      var cl = d.cellList || [];
      parts.push(cl.length
        ? 'ячейки: ' + cl.map(function (c, n) { return '#' + (n + 1) + ' ' + c.area.toFixed(0) + ' км²'; }).join(', ')
        : 'ячеек нет');
    }
    $('radarwin-foot').textContent = parts.join(' · ');
  }

  function toggleRadarWindow(on) {
    radarOpen = on === undefined ? !radarOpen : on;
    $('radarwin').hidden = !radarOpen;
    $('btn-radarwin').classList.toggle('is-on', radarOpen);
    if (radarOpen) drawRadarWindow();
  }

  function bindRadarWindow() {
    $('btn-radarwin').addEventListener('click', function () { toggleRadarWindow(); });
    $('radarwin-close').addEventListener('click', function () { toggleRadarWindow(false); });

    var tabs = document.querySelectorAll('#radarwin-tabs .seg__btn');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        radarTab = e.currentTarget.getAttribute('data-radar-tab');
        drawRadarWindow();
      });
    }

    $('radar-field').addEventListener('change', onFieldChange);
    $('radar-field').addEventListener('input', onFieldChange);

    function onFieldChange(e) {
      radarField = e.target.value;
      radarTab = 'field';
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('is-on');
      drawRadarWindow();
    }

    var win = $('radarwin');
    var head = $('radarwin-head');
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      var r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      win.style.right = 'auto';
      win.style.left = ox + 'px';
      win.style.top = oy + 'px';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      win.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      win.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    head.addEventListener('pointerup', function (e) {
      dragging = false;
      try { head.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
  }

  function updateSignatures() {
    if (!model) return;
    var d = model.diag;
    $('sig-dbz').textContent = d.maxDBZ > 1 ? fmt(d.maxDBZ) + ' dBZ' : '—';
    $('sig-ice').textContent = fmt(d.sigQi || 0, 2) + ' г/кг';
    $('sig-vort').textContent = (d.sigVort || 0).toFixed(4) + ' 1/с';
    $('sig-temp').textContent = (d.sigThp > 0 ? '+' : '') + fmt(d.sigThp || 0, 1) + ' K';
    $('sig-w').textContent = fmt(Math.max(0, d.maxW), 1) + ' м/с';
    $('sig-qv').textContent = fmt(d.sigQv || 0, 1) + ' г/кг';
    $('sig-uh').textContent = fmt(d.uh) + ' м²/с²';
    $('sig-cold').textContent = fmt(d.coldPool, 1) + ' K';
  }

  function tornadoState() {
    if (!model || !model.diag) return null;
    return model.diag.tornado || { active: false, reasons: ['нет данных'], vrot: 0, ef: 0 };
  }

  function updateTornadoUi() {
    var t = tornadoState();
    if (!t) return;
    var btn = $('btn-tornado');
    btn.classList.toggle('is-on', !!t.active);
    if (!tornadoOpen) return;
    var verdict = $('tornadown-verdict');
    var row = (model && model.diag && model.diag.tornado) || null;
    var conds = (model && model.diag && model.diag.tornadoConditions) || [];
    if (row && row.active) {
      verdict.classList.add('is-on');
      verdict.textContent = 'торнадо на земле: EF' + row.ef + ' · ζ ' + (row.zetaLow * 1000).toFixed(2) +
        '·10⁻³ с⁻¹ · Δp ' + row.dp.toFixed(1) + ' гПа · на земле ' + Math.floor(row.duration / 60) + ':' +
        String(Math.round(row.duration % 60)).padStart(2, '0');
    } else {
      verdict.classList.remove('is-on');
      verdict.textContent = 'условий нет — торнадо не симулируется';
    }
    var html = '';
    for (var i = 0; i < conds.length; i++) {
      var c = conds[i];
      var val = c.id === 'zeta' ? (c.value * 1000).toFixed(2) + '·10⁻³'
        : (c.id === 'lcl' ? Math.round(c.value) + ' м' : (c.value || 0).toFixed(1));
      html += '<li class="' + (c.ok ? 'ok' : 'no') + '">' + (c.ok ? '✓' : '✗') +
        ' <b>' + c.name + '</b><span>' + val + ' · нужно ' + c.need + '</span></li>';
    }
    var box = $('tornadown-list');
    if (box.getAttribute('data-sig') !== html) {
      box.innerHTML = html;
      box.setAttribute('data-sig', html);
    }
  }

  function drawTornado() {
    if (!tornadoOpen) return;
    var canvas = $('tornadown-canvas');
    if (!canvas.clientWidth) return;
    ML.tornado.draw(canvas, tornadoState(), 0.1);
  }

  function bindTornadoWindow() {
    $('btn-tornado').addEventListener('click', function () {
      tornadoOpen = true;
      $('tornadown').hidden = false;
      updateTornadoUi();
      drawTornado();
    });
    $('tornadown-close').addEventListener('click', function () {
      tornadoOpen = false;
      $('tornadown').hidden = true;
    });
    var win = $('tornadown');
    var head = $('tornadown-head');
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      dragging = true;
      var r = win.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      win.style.left = ox + 'px';
      win.style.top = oy + 'px';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      win.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      win.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    head.addEventListener('pointerup', function (e) {
      dragging = false;
      try { head.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
  }

  function syncRunUi() {
    var btn = $('btn-play');
    var pill = $('pill-state');
    btn.textContent = running ? 'Пауза' : 'Запустить';
    pill.innerHTML = '<i>состояние</i> ' + (running ? 'счёт' : 'пауза');
    pill.classList.toggle('is-run', running);
  }

  function frame() {
    requestAnimationFrame(frame);
    var t0 = performance.now();
    if (running && model) {
      var budget = 20 + speed * 16;
      var maxSteps = (speed > 1 && model.n > 200000) ? 1 : speed;
      try {
        for (var s = 0; s < maxSteps; s++) {
          model.step();
          if (performance.now() - t0 > budget) break;
        }
        if (view) view._needUpload = true;
        pushSeries();
      } catch (e) {
        running = false;
        syncRunUi();
        console.error(e);
        $('gl-hint').textContent = 'Счёт остановлен: ' + e.message;
      }
    }

    if (view && view.ok) {
      view.render();
      updateMarkers();
    }

    frameCount++;
    fpsFrames++;
    var now = performance.now();
    if (now - lastFpsTime > 700) {
      $('pill-fps').innerHTML = '<i>fps</i> ' + Math.round(fpsFrames * 1000 / (now - lastFpsTime));
      lastFpsTime = now;
      fpsFrames = 0;
    }
    if (frameCount % 6 === 0) {
      updateLiveStats();
      drawPanels();
      if (radarOpen) drawRadarWindow();
      var tor = model && model.diag && model.diag.tornado;
      if (tor && tor.active && !tornadoAutoShown) {
        tornadoAutoShown = true;
        tornadoOpen = true;
        $('tornadown').hidden = false;
      }
      updateTornadoUi();
    }
    if (tornadoOpen && frameCount % 2 === 0) drawTornado();
  }

  function runMinutes(min) {
    if (!model) return;
    var target = model.time + min * 60;
    var guard = 0;
    while (model.time < target && guard++ < 4000) model.step();
    if (view) view._needUpload = true;
    pushSeries();
    updateLiveStats();
    drawPanels();
    if (view && view.ok) view.render();
  }

  function bindInputs() {
    var inputs = document.querySelectorAll('input[data-param]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('input', function (e) {
        var key = e.target.getAttribute('data-param');
        params[key] = parseFloat(e.target.value);
        activePreset = null;
        observed = null;
        $('obs-status').textContent = 'параметры';
        markPreset(null);
        syncLabels();
        rebuild();
      });
    }

    $('sel-mode').addEventListener('change', function (e) {
      seedMode = e.target.value;
      resetModel();
    });
    $('sel-grid').addEventListener('change', function (e) {
      gridSize = parseInt(e.target.value, 10) || 48;
      resetModel();
    });

    $('btn-play').addEventListener('click', function () {
      running = !running;
      syncRunUi();
    });
    $('btn-reset').addEventListener('click', function () {
      running = false;
      syncRunUi();
      resetModel();
    });
    $('btn-step').addEventListener('click', function () { runMinutes(1); });
    $('btn-step5').addEventListener('click', function () { runMinutes(5); });
    $('sel-speed').addEventListener('change', function (e) {
      speed = parseInt(e.target.value, 10) || 1;
    });

    $('btn-focus').addEventListener('click', toggleFocus);

    var chanBtns = document.querySelectorAll('#view-mode .seg__btn');
    for (i = 0; i < chanBtns.length; i++) {
      chanBtns[i].addEventListener('click', function (e) {
        for (var j = 0; j < chanBtns.length; j++) chanBtns[j].classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        if (view) {
          view.channel = parseInt(e.currentTarget.getAttribute('data-channel'), 10) || 0;
          view._needUpload = true;
        }
      });
    }

    $('clip').addEventListener('input', function (e) {
      var v = parseFloat(e.target.value);
      $('clip-out').textContent = fmt(v, 1) + ' км';
      if (view) { view.clip = v; view._needUpload = true; }
    });
    $('quality').addEventListener('input', function (e) {
      if (view) view.quality = parseInt(e.target.value, 10);
    });
    $('btn-rotate').addEventListener('click', function (e) {
      if (!view) return;
      view.autoRotate = !view.autoRotate;
      e.currentTarget.classList.toggle('is-on', view.autoRotate);
    });
    $('btn-png').addEventListener('click', exportPng);

    var panelBtns = document.querySelectorAll('#panel-mode .seg__btn');
    for (i = 0; i < panelBtns.length; i++) {
      panelBtns[i].addEventListener('click', function (e) {
        for (var j = 0; j < panelBtns.length; j++) panelBtns[j].classList.remove('is-on');
        e.currentTarget.classList.add('is-on');
        panelMode = e.currentTarget.getAttribute('data-panel');
        $('radar').hidden = panelMode !== 'plan';
        $('section').hidden = panelMode !== 'section';
        drawPanels();
      });
    }

    $('sel-series').addEventListener('change', function (e) {
      chartKey = e.target.value;
      drawChart();
    });

    $('btn-about').addEventListener('click', function () { $('modal').hidden = false; });
    $('modal-close').addEventListener('click', function () { $('modal').hidden = true; });
    $('modal').addEventListener('click', function (e) {
      if (e.target === $('modal')) $('modal').hidden = true;
    });
    $('btn-csv').addEventListener('click', exportCsv);
    $('btn-json').addEventListener('click', exportJson);

    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        running = !running;
        syncRunUi();
      } else if (e.key === 'r' || e.key === 'к' || e.key === 'К') {
        running = false;
        syncRunUi();
        resetModel();
      } else if (e.key === 'f' || e.key === 'а' || e.key === 'А') {
        toggleFocus();
      }
    });

    global.addEventListener('resize', function () {
      if (profile) {
        S.drawSkewT($('skew'), profile);
        S.drawHodograph($('hodo'), profile);
      }
      drawChart();
      drawPanels();
    if (view && view.ok) {
      view.render();
      updateMarkers();
    }

    });
  }

  function toggleFocus() {
    var on = $('layout').classList.toggle('is-focus');
    $('btn-focus').textContent = on ? 'Свернуть' : 'Во весь экран';
    if (view && view.ok) {
      setTimeout(function () {
        view.resize();
        view.render();
      }, 60);
    }
  }

  function download(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function exportCsv() {
    if (!series.length) {
      $('gl-hint').textContent = 'Нет данных для выгрузки: запустите модель.';
      return;
    }
    var lines = ['time_s,time_min,max_w_ms,cloud_top_m,max_dbz,rain_mm_h,rain_area_km2,cold_pool_K,uh_m2s2,cells'];
    for (var i = 0; i < series.length; i++) {
      var p = series[i];
      lines.push([
        Math.round(p.t), (p.t / 60).toFixed(1), p.w.toFixed(2), Math.round(p.top * 1000),
        p.dbz.toFixed(1), p.rain.toFixed(2), (model ? model.diag.rainArea.toFixed(0) : '0'),
        (model ? model.diag.coldPool.toFixed(2) : '0'), Math.round(p.uh), p.cells
      ].join(','));
    }
    download('meteolab-lite-diag.csv', new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  }

  function exportJson() {
    if (!profile) return;
    var out = {
      preset: activePreset,
      grid: [model ? model.nx : gridSize, model ? model.ny : gridSize, model ? model.nz : 36],
      seed: { mode: seedMode, count: seedCount, heating: params.heating, bubble: params.bubble },
      params: params,
      thermodynamics: {
        cape: Math.round(profile.cape), cin: Math.round(profile.cin),
        dcape: Math.round(profile.dcape), pwat: +profile.pwat.toFixed(1),
        lcl: Math.round(profile.lcl), lfc: Math.round(profile.lfc), el: Math.round(profile.el),
        shear06: +profile.shear06.toFixed(1), shear01: +profile.shear01.toFixed(1),
        srh: Math.round(profile.srh), brn: +profile.brn.toFixed(1)
      },
      time_s: model ? model.time : 0
    };
    download('meteolab-lite-profile.json',
      new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  }

  function exportPng() {
    if (!view || !view.ok) {
      $('gl-hint').textContent = 'Снимок недоступен: WebGL 2 не запущен.';
      return;
    }
    var url = view.capture();
    if (!url) return;
    var a = document.createElement('a');
    a.href = url;
    a.download = 'meteolab-lite-3d.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function nameRanges() {
    var inputs = document.querySelectorAll('input[type="range"]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.getAttribute('aria-label')) continue;
      var key = el.getAttribute('data-param');
      var label = key && RANGE_NAMES[key];
      if (!label) {
        var lab = el.closest('label');
        var head = lab ? lab.querySelector('.slider__head, span') : null;
        label = head ? head.textContent.replace(/\s+/g, ' ').trim() : 'Параметр модели';
      }
      el.setAttribute('aria-label', label);
    }
  }

  function initView() {
    var canvas = $('gl');
    view = new ML.VolumeView(canvas);
    if (!view.ok) {
      $('gl-fallback').hidden = false;
      $('gl-fallback').querySelector('b').textContent = 'WebGL 2 недоступен (' + (view.error || 'нет контекста') + ').';
      view = null;
      return;
    }
    var dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || !view) return;
      view.autoRotate = false;
      $('btn-rotate').classList.remove('is-on');
      view.orbit(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
    });
    canvas.addEventListener('pointerup', function (e) {
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (view) view.zoom(e.deltaY);
    }, { passive: false });
    view.dist = 78;
    view.pitch = 0.38;
  }

  function boot() {
    buildPresets();
    bindInputs();
    bindObservations();
    bindRadarWindow();
    bindTornadoWindow();
    initView();

    applyParamsToDom();
    nameRanges();
    windParams();
    profile = S.buildProfile(params);
    S.drawSkewT($('skew'), profile);
    S.drawHodograph($('hodo'), profile);
    updateEnvStats();
    resetModel();
    markPreset(activePreset);
    var p = ML.getPreset(activePreset);
    $('preset-desc').textContent = p.desc;
    syncRunUi();
    requestAnimationFrame(frame);
    setInterval(function () {
      if (running && model) {
        updateLiveStats();
        drawPanels();
      }
    }, 1500);
  }

  ML.app = {
    applySounding: function (text, label, autostart) {
      var prof = applyObsText(text, label);
      if (!prof) return null;
      if (autostart !== false) {
        running = true;
        syncRunUi();
      }
      return prof;
    },
    isRunning: function () { return running; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
