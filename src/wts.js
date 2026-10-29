(function (global) {
  'use strict';

  var API_CANDIDATES = [];
  if (global.location && /^https?:$/.test(global.location.protocol)) API_CANDIDATES.push('');
  API_CANDIDATES.push('http://127.0.0.1:8770');

  var FALLBACK_STATIONS = [
    { name: 'Якутск', wmo: '24959' },
    { name: 'Оймякон', wmo: '24944' },
    { name: 'Тикси', wmo: '24691' },
    { name: 'Верхоянск', wmo: '24266' },
    { name: 'Среднеколымск', wmo: '25123' },
    { name: 'Алдан', wmo: '24982' },
    { name: 'Мирный', wmo: '89471' },
    { name: 'Ленск', wmo: '24804' },
    { name: 'Нерюнгри', wmo: '24856' },
    { name: 'Черский', wmo: '25173' },
    { name: 'Певек', wmo: '25034' },
    { name: 'Анадырь', wmo: '25563' },
    { name: 'Магадан', wmo: '25913' },
    { name: 'Хабаровск', wmo: '31735' },
    { name: 'Москва', wmo: '27612' },
    { name: 'Санкт-Петербург', wmo: '26063' },
    { name: 'Новосибирск', wmo: '29634' },
    { name: 'Иркутск', wmo: '30710' },
    { name: 'Владивосток', wmo: '31960' }
  ];

  var STATUS_LABELS = { ok: 'готово', skip: 'пропуск', error: 'ошибка', info: 'инфо', header: 'итог' };
  var TERMINAL = { done: 1, stopped: 1, error: 1 };

  var state = {
    base: null,
    online: false,
    jobId: null,
    seq: 0,
    polling: null,
    tab: 'log',
    filesLoaded: false,
    logRows: 0
  };

  function $(id) { return document.getElementById(id); }

  function storageGet(key) {
    try { return global.localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try { global.localStorage.setItem(key, value); } catch (err) { /* приватный режим */ }
  }

  function apiUrl(path) {
    return (state.base || '') + path;
  }

  function request(path, options) {
    var init = options || {};
    init.headers = init.headers || {};
    if (init.body) init.headers['Content-Type'] = 'application/json';
    return fetch(apiUrl(path), init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!response.ok) {
          var message = (data && data.error) || ('HTTP ' + response.status);
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function probe(base) {
    return fetch(base + '/api/wts/health', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  function connect() {
    var override = storageGet('meteolab.wts.api');
    var candidates = override ? [override] : API_CANDIDATES.slice();
    var attempt = 0;

    function tryNext() {
      if (attempt >= candidates.length) {
        setConnection(false, 'сервер WtS не найден');
        return Promise.resolve(null);
      }
      var base = candidates[attempt++];
      return probe(base).then(function (info) {
        state.base = base;
        state.online = true;
        storageSet('meteolab.wts.api', base);
        setConnection(true, 'сервер WtS ' + (info.version || '') + ' · задач активно ' + (info.active || 0));
        return info;
      }).catch(function () {
        return tryNext();
      });
    }

    return tryNext();
  }

  function setConnection(online, text) {
    state.online = online;
    var box = $('wts-conn');
    if (box) {
      box.textContent = text;
      box.classList.toggle('is-on', !!online);
      box.classList.toggle('is-off', !online);
    }
    var startBtn = $('wts-start-btn');
    if (startBtn) startBtn.disabled = !online;
    var note = $('wts-note');
    if (note) {
      note.textContent = online
        ? 'Загрузка идёт на сервере: Wyoming → разбор → .snd для SHARPpy. Демо-данные не подставляются.'
        : 'Python-сервер не отвечает. Запустите WtS.cmd двойным щелчком — он поднимет сервер и откроет сайт. Кнопка СТАРТ тоже сама пробует подключиться.';
    }
  }

  function fillStations(list) {
    var select = $('wts-station');
    if (!select) return;
    var stations = list && list.length ? list : FALLBACK_STATIONS;
    var current = select.value || '24959';
    select.innerHTML = '';
    var known = false;
    stations.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.wmo;
      option.textContent = item.name + ' · ' + item.wmo;
      if (item.wmo === current) known = true;
      select.appendChild(option);
    });
    if (!known && select.options.length) current = select.options[0].value;
    select.value = current;
    $('wts-wmo').value = current;
  }

  function isoDate(value) {
    var month = String(value.getMonth() + 1);
    var day = String(value.getDate());
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return value.getFullYear() + '-' + month + '-' + day;
  }

  function setRange(start, end) {
    $('wts-start').value = isoDate(start);
    $('wts-end').value = isoDate(end);
  }

  function quickMonth() {
    var today = new Date();
    var start = today.getMonth() === 0
      ? new Date(today.getFullYear() - 1, 11, 1)
      : new Date(today.getFullYear(), today.getMonth() - 1, 1);
    setRange(start, today);
  }

  function quickYear() {
    var today = new Date();
    setRange(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()), today);
  }

  function collectHours() {
    var hours = [];
    if ($('wts-h00').checked) hours.push('00');
    if ($('wts-h12').checked) hours.push('12');
    return hours;
  }

  function note(text, isError) {
    var box = $('wts-note');
    if (!box) return;
    box.textContent = text;
    box.classList.toggle('is-error', !!isError);
  }

  function validatePayload(payload) {
    if (!/^\d{1,5}$/.test(payload.station)) return 'WMO ID: 1–5 цифр';
    if (!payload.start || !payload.end) return 'Укажите начало и конец периода';
    if (payload.start > payload.end) return 'Начальная дата позже конечной';
    if (!payload.hours.length) return 'Выберите хотя бы один срок (00 или 12 UTC)';
    if (!(payload.workers >= 1 && payload.workers <= 10)) return 'Число потоков: от 1 до 10';
    if (!(payload.delay >= 0 && payload.delay <= 30)) return 'Задержка: от 0 до 30 секунд';
    return '';
  }

  function setRunning(running) {
    $('wts-start-btn').disabled = running || !state.online;
    $('wts-stop-btn').disabled = !running;
  }

  function clearLog() {
    var box = $('wts-log');
    box.innerHTML = '<p class="wts__empty">Журнал пуст: запустите загрузку.</p>';
    state.logRows = 0;
  }

  function appendLog(entries) {
    var box = $('wts-log');
    if (!entries || !entries.length) return;
    var empty = box.querySelector('.wts__empty');
    if (empty) empty.remove();
    var nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    entries.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'wts__row wts__row--' + (entry.status || 'info');
      var cells = [
        entry.ts || '',
        entry.date || '—',
        entry.hour ? entry.hour + 'Z' : '',
        STATUS_LABELS[entry.status] || entry.status
      ];
      cells.forEach(function (text) {
        var span = document.createElement('span');
        span.textContent = text;
        row.appendChild(span);
      });
      var message = document.createElement('span');
      message.className = 'wts__msg';
      message.textContent = entry.message || '';
      row.appendChild(message);
      box.appendChild(row);
      state.logRows++;
    });
    while (box.children.length > 800) box.removeChild(box.firstChild);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderCounts(snapshot) {
    var counts = snapshot.counts || {};
    $('wts-total').textContent = counts.total || 0;
    $('wts-progress').textContent = (counts.completed || 0) + ' / ' + (counts.total || 0);
    $('wts-ok').textContent = counts.ok || 0;
    $('wts-failed').textContent = counts.failed || 0;
    $('wts-skipped').textContent = counts.skipped || 0;
    $('wts-fill').style.width = Math.max(0, Math.min(100, snapshot.percent || 0)) + '%';
  }

  function statusText(snapshot) {
    var map = {
      queued: 'в очереди',
      running: 'идёт загрузка',
      stopping: 'остановка…',
      done: 'завершено',
      stopped: 'остановлено',
      error: 'прервано ошибкой'
    };
    var label = map[snapshot.status] || snapshot.status;
    if (snapshot.status === 'running') {
      label += ' · ' + (snapshot.percent || 0).toFixed(0) + '% · ' + (snapshot.counts.completed) + ' из ' + snapshot.counts.total;
    }
    return label;
  }

  function poll() {
    if (!state.jobId) return;
    var id = state.jobId;
    request('/api/wts/jobs/' + id + '?since=' + state.seq, { cache: 'no-store' }).then(function (snapshot) {
      if (id !== state.jobId) return;
      renderCounts(snapshot);
      appendLog(snapshot.log || []);
      if (typeof snapshot.seq === 'number') state.seq = snapshot.seq;
      $('wts-status').textContent = statusText(snapshot);
      if (TERMINAL[snapshot.status]) {
        setRunning(false);
        if (snapshot.status === 'error' && snapshot.error) note('Сервер сообщил: ' + snapshot.error, true);
        loadFiles();
        return;
      }
      state.polling = global.setTimeout(poll, 700);
    }).catch(function (err) {
      if (id !== state.jobId) return;
      $('wts-status').textContent = 'связь потеряна: ' + err.message;
      state.polling = global.setTimeout(poll, 2000);
    });
  }

  function startJob(event) {
    if (event) event.preventDefault();
    var payload = {
      station: ($('wts-wmo').value || '').trim(),
      start: $('wts-start').value,
      end: $('wts-end').value,
      hours: collectHours(),
      workers: parseInt($('wts-workers').value, 10) || 3,
      delay: parseFloat($('wts-delay').value) || 0,
      organize: $('wts-organize').checked
    };
    var problem = validatePayload(payload);
    if (problem) {
      note(problem, true);
      return;
    }

    if (state.online) {
      submit(payload);
      return;
    }

    note('Проверяю Python-сервер…', false);
    setRunning(true);
    connect().then(function (info) {
      if (!info) {
        setRunning(false);
        note('Python-сервер не отвечает. Запустите WtS.cmd двойным щелчком — он поднимет сервер и откроет сайт.', true);
        $('wts-status').textContent = 'сервер недоступен';
        return;
      }
      refreshStations();
      submit(payload);
    });
  }

  function submit(payload) {
    note('Задача отправлена на сервер…', false);
    setRunning(true);
    clearLog();
    state.filesLoaded = false;
    $('wts-files').innerHTML = '';
    $('wts-zip').hidden = true;

    request('/api/wts/jobs', { method: 'POST', body: JSON.stringify(payload) }).then(function (snapshot) {
      state.jobId = snapshot.id;
      state.seq = 0;
      $('wts-status').textContent = 'принято: ' + snapshot.counts.total + ' зондов';
      setRunning(true);
      global.clearTimeout(state.polling);
      poll();
    }).catch(function (err) {
      setRunning(false);
      note('Не удалось создать задачу: ' + err.message, true);
      $('wts-status').textContent = 'ошибка запуска';
    });
  }

  function stopJob() {
    if (!state.jobId) return;
    $('wts-stop-btn').disabled = true;
    request('/api/wts/jobs/' + state.jobId + '/stop', { method: 'POST', body: '{}' }).then(function (snapshot) {
      $('wts-status').textContent = statusText(snapshot);
    }).catch(function (err) {
      note('Остановка не удалась: ' + err.message, true);
    });
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' КБ';
    return bytes + ' Б';
  }

  function applySoundingFile(file) {
    var app = global.ML && global.ML.app;
    if (!app || !app.applySounding) {
      note('Модуль симуляции не загрузился — зондаж применить нельзя.', true);
      return;
    }
    note('Загружаю ' + file.name + ' …', false);
    fetch(apiUrl(file.url), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.text();
    }).then(function (text) {
      var prof = app.applySounding(text, file.name);
      if (!prof) {
        note('Файл прочитан, но профиль не построен: ' + file.name, true);
        return;
      }
      close();
    }).catch(function (err) {
      note('Файл не загрузился: ' + err.message, true);
    });
  }

  function loadFiles() {
    if (!state.jobId) return;
    request('/api/wts/jobs/' + state.jobId + '/files', { cache: 'no-store' }).then(function (data) {
      var box = $('wts-files');
      box.innerHTML = '';
      var files = data.files || [];
      if (!files.length) {
        box.innerHTML = '<p class="wts__empty">Файлов нет: все сроки пропущены или завершились ошибкой.</p>';
        $('wts-zip').hidden = true;
        return;
      }
      var groups = {};
      var order = [];
      files.forEach(function (file) {
        var key = file.folder || '—';
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(file);
      });
      order.forEach(function (key) {
        var head = document.createElement('div');
        head.className = 'wts__folder';
        head.textContent = key + ' · ' + groups[key].length + ' файл(ов)';
        box.appendChild(head);
        groups[key].forEach(function (file) {
          var row = document.createElement('div');
          row.className = 'wts__file';
          var name = document.createElement('span');
          name.className = 'wts__fname';
          name.textContent = file.name;
          var size = document.createElement('span');
          size.className = 'wts__fsize';
          size.textContent = formatSize(file.size);
          var apply = document.createElement('button');
          apply.className = 'btn btn--small';
          apply.type = 'button';
          apply.textContent = 'В модель';
          apply.title = 'Построить профиль из этого .snd и запустить симуляцию';
          apply.addEventListener('click', function () { applySoundingFile(file); });
          var link = document.createElement('a');
          link.className = 'btn btn--small';
          link.href = apiUrl(file.url);
          link.textContent = 'скачать';
          link.setAttribute('download', file.name);
          row.appendChild(name);
          row.appendChild(size);
          row.appendChild(apply);
          row.appendChild(link);
          box.appendChild(row);
        });
      });
      $('wts-zip').hidden = !data.zip;
      if (data.zip) $('wts-zip').href = apiUrl(data.zip);
      state.filesLoaded = true;
    }).catch(function (err) {
      $('wts-files').innerHTML = '<p class="wts__empty">Не удалось получить список файлов: ' + err.message + '</p>';
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    var buttons = document.querySelectorAll('#wts-tabs .seg__btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('is-on', buttons[i].getAttribute('data-wts-tab') === tab);
    }
    $('wts-log').hidden = tab !== 'log';
    $('wts-files').hidden = tab !== 'files';
    if (tab === 'files' && !state.filesLoaded) loadFiles();
  }

  function open() {
    $('wts').hidden = false;
    if (state.online) refreshStations();
  }

  function refreshStations() {
    request('/api/wts/stations', { cache: 'no-store' }).then(function (data) {
      fillStations(data.stations);
    }).catch(function () {
      fillStations(FALLBACK_STATIONS);
    });
  }

  function close() {
    $('wts').hidden = true;
  }

  function bind() {
    var openBtn = $('btn-wts');
    if (!openBtn || !$('wts')) return;

    openBtn.addEventListener('click', open);
    $('wts-close').addEventListener('click', close);
    $('wts').addEventListener('click', function (event) {
      if (event.target === $('wts')) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('wts').hidden) close();
    });

    $('wts-form').addEventListener('submit', startJob);
    $('wts-stop-btn').addEventListener('click', stopJob);
    $('wts-last-month').addEventListener('click', quickMonth);
    $('wts-last-year').addEventListener('click', quickYear);
    $('wts-clear-log').addEventListener('click', clearLog);
    $('wts-conn').addEventListener('click', function () {
      setConnection(false, 'проверка связи…');
      connect().then(function (info) {
        if (info) refreshStations();
      });
    });
    $('wts-station').addEventListener('change', function (event) {
      $('wts-wmo').value = event.target.value;
    });
    $('wts-wmo').addEventListener('input', function (event) {
      var value = (event.target.value || '').trim();
      var select = $('wts-station');
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === value) { select.value = value; return; }
      }
    });

    var tabs = document.querySelectorAll('#wts-tabs .seg__btn');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (event) {
        switchTab(event.currentTarget.getAttribute('data-wts-tab'));
      });
    }

    fillStations(FALLBACK_STATIONS);
    quickMonth();
    setConnection(false, 'сервер не проверен');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  global.ML = global.ML || {};
  global.ML.wts = { open: open, close: close, state: state };
})(window);
