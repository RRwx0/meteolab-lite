(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});
  var STORE_KEY = 'meteolab.lite.observations.v1';

  function num(s) {
    if (s === undefined || s === null) return NaN;
    var t = String(s).trim().replace(',', '.');
    if (!t || t === '-' || t === '---' || t === 'NaN') return NaN;
    var v = parseFloat(t);
    return isFinite(v) ? v : NaN;
  }

  function isNum(s) {
    var v = num(s);
    return isFinite(v);
  }

  function splitLine(line) {
    if (line.indexOf(';') >= 0) return line.split(';');
    if (line.indexOf('\t') >= 0) return line.split('\t');
    if (line.indexOf(',') >= 0) return line.split(',');
    return line.trim().split(/\s+/);
  }

  var HEADER_KEYS = {
    p: ['pres', 'pressure', 'pressure_mb', 'p_hpa', 'p'],
    z: ['hght', 'height', 'height_m', 'gph', 'z', 'h'],
    t: ['temp', 'tmpc', 'temperature', 't_c', 't'],
    td: ['dwpt', 'dwpc', 'dewpoint', 'dewp', 'td_c', 'td'],
    rh: ['relh', 'rh', 'rhum'],
    dir: ['drct', 'wdir', 'dir', 'wind_dir'],
    spd: ['sknt', 'speed_kts', 'spd', 'speed', 'wind_speed', 'ff', 'ws'],
    station: ['station', 'stid', 'stnm'],
    time: ['validutc', 'valid', 'time', 'datetime']
  };

  function headerIndex(cells) {
    var idx = {};
    for (var i = 0; i < cells.length; i++) {
      var key = String(cells[i]).trim().toLowerCase();
      for (var name in HEADER_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(HEADER_KEYS, name)) continue;
        if (HEADER_KEYS[name].indexOf(key) >= 0 && idx[name] === undefined) idx[name] = i;
      }
    }
    return idx;
  }

  function parseCsv(text) {
    var lines = text.split(/\r?\n/);
    var header = null;
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var cells = splitLine(line);
      if (!header) {
        var idx = headerIndex(cells);
        if (idx.p !== undefined && idx.t !== undefined) { header = idx; continue; }
        continue;
      }
      var level = {
        p: num(cells[header.p]),
        z: header.z !== undefined ? num(cells[header.z]) : NaN,
        t: num(cells[header.t]),
        td: header.td !== undefined ? num(cells[header.td]) : NaN,
        dir: header.dir !== undefined ? num(cells[header.dir]) : NaN,
        spd: header.spd !== undefined ? num(cells[header.spd]) : NaN
      };
      if (!isFinite(level.t)) continue;
      if (!isFinite(level.p) && !isFinite(level.z)) continue;
      rows.push(level);
    }
    return rows;
  }

  function parseUwyo(text) {
    var lines = text.split(/\r?\n/);
    var rows = [];
    var started = false;
    var station = '', title = '';
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      if (!line) continue;
      if (!started && /^\d{5}\s+\w{3}/.test(line)) { station = line; continue; }
      if (!started && /Observations at/i.test(line)) { title = line; continue; }
      if (/PRES\s+HGHT/i.test(line)) { started = true; continue; }
      if (/^-{5,}/.test(line)) continue;
      var cells = line.split(/\s+/);
      if (cells.length < 4) continue;
      var nums = 0;
      for (var c = 0; c < cells.length; c++) if (isNum(cells[c])) nums++;
      if (nums < 4) continue;
      if (!started) started = true;
      var dirIdx = cells.length >= 11 ? 6 : (cells.length >= 6 ? 4 : -1);
      var spdIdx = cells.length >= 11 ? 7 : (cells.length >= 6 ? 5 : -1);
      var level = {
        p: num(cells[0]),
        z: num(cells[1]),
        t: num(cells[2]),
        td: num(cells[3]),
        dir: dirIdx > 0 ? num(cells[dirIdx]) : NaN,
        spd: spdIdx > 0 ? num(cells[spdIdx]) : NaN
      };
      if (!isFinite(level.t)) continue;
      if (!isFinite(level.p) && !isFinite(level.z)) continue;
      rows.push(level);
    }
    return { rows: rows, station: station, title: title };
  }

  function parseSnd(text) {
    var lines = text.split(/\r?\n/);
    var rows = [];
    var inRaw = false;
    var station = '';
    var when = '';
    var title = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (/^%TITLE%/i.test(line)) continue;
      if (/^%RAW%/i.test(line)) { inRaw = true; continue; }
      if (/^%END%/i.test(line)) break;
      if (!inRaw) {
        var stamp = line.match(/^(\d{5})\s+(\d{2})(\d{2})(\d{2})\/(\d{2})(\d{2})/);
        if (stamp) {
          station = stamp[1];
          when = stamp[4] + '.' + stamp[3] + '.' + stamp[2] + ' ' + stamp[5] + ':' + stamp[6] + ' UTC';
          title = when;
        } else if (!title && !/LEVEL|HGHT|^-+$/i.test(line) && line.length < 60) {
          title = line;
        }
        continue;
      }
      var cells = line.split(',');
      if (cells.length < 4) continue;
      var level = {
        p: num(cells[0]),
        z: num(cells[1]),
        t: num(cells[2]),
        td: num(cells[3]),
        dir: cells.length > 4 ? num(cells[4]) : NaN,
        spd: cells.length > 5 ? num(cells[5]) * 0.514444 : NaN
      };
      if (!isFinite(level.t)) continue;
      if (!isFinite(level.p) && !isFinite(level.z)) continue;
      rows.push(level);
    }
    return { rows: rows, station: station, title: title };
  }

  function parseJson(text) {
    var data = JSON.parse(text);
    if (data && data.levels && Array.isArray(data.levels)) {
      return { rows: data.levels.map(normalizeLevel), meta: data.meta || {} };
    }
    if (Array.isArray(data)) {
      return { rows: data.map(normalizeLevel), meta: {} };
    }
    throw new Error('в JSON нет массива уровней');
  }

  function normalizeLevel(o) {
    return {
      p: num(o.p !== undefined ? o.p : o.pressure_mb),
      z: num(o.z !== undefined ? o.z : o.height_m),
      t: num(o.t !== undefined ? o.t : (o.tmpc !== undefined ? o.tmpc : o.temperature)),
      td: num(o.td !== undefined ? o.td : (o.dwpc !== undefined ? o.dwpc : o.dewpoint)),
      dir: num(o.dir !== undefined ? o.dir : o.drct),
      spd: num(o.spd !== undefined ? o.spd : (o.speed_kts !== undefined ? o.speed_kts : o.speed))
    };
  }

  function parse(text, hint) {
    var raw = String(text || '').trim();
    if (!raw) throw new Error('пустой текст');
    var rows = [], meta = {};
    if (/%RAW%/i.test(raw) || /^%TITLE%/im.test(raw)) {
      var k = parseSnd(raw);
      rows = k.rows;
      meta.station = k.station;
      meta.title = k.title;
      meta.units = 'knots→m/s';
      meta.format = 'SHARPpy .snd';
    } else if (raw.charAt(0) === '[' || raw.charAt(0) === '{') {
      var j = parseJson(raw);
      rows = j.rows;
      meta = j.meta || {};
    } else if (/PRES\s+HGHT/i.test(raw) || /^\s*\d{5}\s+\w{3}/m.test(raw)) {
      var u = parseUwyo(raw);
      rows = u.rows;
      meta.station = u.station;
      meta.title = u.title;
    } else {
      rows = parseCsv(raw);
    }
    rows = rows.filter(function (r) { return isFinite(r.t) && (isFinite(r.p) || isFinite(r.z)); });
    if (rows.length < 3) throw new Error('не удалось разобрать уровни (нужно ≥ 3 строк с температурой)');
    var hasKnots = !meta.units && (/\b(sknt|speed_kts|knots|kt)\b/i.test(raw) ||
      (rows.length && Math.max.apply(null, rows.map(function (r) { return isFinite(r.spd) ? r.spd : 0; })) > 60));
    if (hasKnots) {
      rows.forEach(function (r) { if (isFinite(r.spd)) r.spd = r.spd * 0.514444; });
      meta.units = 'knots→m/s';
    }
    if (!meta.station && hint) meta.station = hint;
    return { levels: rows, meta: meta };
  }

  function label(obs) {
    var m = obs.meta || {};
    var st = (m.station || '').replace(/\s+/g, ' ').trim();
    var when = (m.title || m.time || '').replace(/Observations at\s*/i, '').replace(/\s+/g, ' ').trim();
    var parts = [];
    if (st) parts.push(st);
    if (when) parts.push(when);
    if (!parts.length) parts.push('Зондирование ' + new Date(obs.added).toLocaleString('ru-RU'));
    return parts.join(' · ');
  }

  function storage() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function persist(list) {
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-40)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function save(text, parsed) {
    var list = storage();
    var entry = {
      id: 'obs' + Date.now().toString(36),
      added: Date.now(),
      text: text,
      meta: parsed.meta,
      label: label({ meta: parsed.meta, added: Date.now() })
    };
    list.push(entry);
    var ok = persist(list);
    entry.persisted = ok;
    return entry;
  }

  function remove(id) {
    var list = storage().filter(function (e) { return e.id !== id; });
    return persist(list) ? list : null;
  }

  function templates() {
    return [
      {
        id: 'tpl-supercell',
        name: 'Суперячейка (типовая среда)',
        note: 'Идеализированный профиль, не наблюдение: CAPE ≈ 4 кДж/кг, сдвиг 0–6 км ≈ 20 м/с.',
        text: [
          '   PRES   HGHT   TEMP   DWPT   DRCT   SKNT',
          '  1000.0     50   32.0   23.0    160      4',
          '   950.0    500   28.4   22.2    170      7',
          '   900.0    980   24.6   21.2    180     11',
          '   850.0   1480   20.6   19.0    195     14',
          '   800.0   2000   17.0   15.6    205     18',
          '   700.0   3100   10.2    6.0    215     24',
          '   600.0   4300    3.0   -4.0    225     29',
          '   500.0   5800   -6.0  -16.0    235     33',
          '   400.0   7600  -16.0  -31.0    245     36',
          '   300.0   9800  -30.0  -47.0    250     38'
        ].join('\n')
      },
      {
        id: 'tpl-tropical',
        name: 'Тропическая (типовая среда)',
        note: 'Идеализированный профиль, не наблюдение: очень влажно, малый сдвиг.',
        text: [
          '   PRES   HGHT   TEMP   DWPT   DRCT   SKNT',
          '  1010.0     20   30.0   26.0    120      2',
          '   950.0    520   26.4   24.0    130      3',
          '   900.0   1000   23.2   21.6    140      4',
          '   850.0   1500   20.2   18.8    150      5',
          '   700.0   3200   11.0    8.6    160      7',
          '   500.0   5900   -3.4   -9.0    170      9',
          '   300.0   9800  -24.0  -36.0    175     10'
        ].join('\n')
      }
    ];
  }

  ML.observations = {
    parse: parse,
    storage: storage,
    save: save,
    remove: remove,
    templates: templates,
    label: label
  };
})(window);
