(function (global) {
  'use strict';
  var ML = global.ML || (global.ML = {});

  var BASE = {
    t0: 32, rh0: 58, lapseLow: 7.5, lapseMid: 6.8, lapseTop: 6.0, zTrop: 12,
    rhMid: 45, rhTop: 25,
    ws0: 7, ws3: 13, ws6: 23, ws10: 32,
    wd0: 160, veer: 90, bubble: 2.6
  };

  function preset(id, name, tag, desc, over, seed) {
    var p = {};
    for (var k in BASE) if (Object.prototype.hasOwnProperty.call(BASE, k)) p[k] = BASE[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) p[k] = over[k];
    return {
      id: id, name: name, tag: tag, desc: desc, params: p,
      mode: seed.mode || 'single', count: seed.count || 1,
      heating: seed.heating === undefined ? 0.4 : seed.heating,
      bubble: seed.bubble === undefined ? p.bubble : seed.bubble
    };
  }

  ML.presets = [
    preset('pulse', 'Импульсная', 'слабое вращение',
      'Высокая влажность, слабый сдвиг: одна ячейка живёт 20–30 минут и выливается дождём.',
      { t0: 34, rh0: 78, lapseLow: 7.0, lapseMid: 6.4, lapseTop: 5.5, zTrop: 13, rhMid: 60, rhTop: 35, ws0: 3, ws3: 5, ws6: 8, ws10: 12, wd0: 200, veer: 30 },
      { mode: 'single', heating: 0.3, bubble: 1.9 }),

    preset('multi', 'Мультиячейка', 'поле ячеек',
      'Умеренный сдвиг и поле термиков: несколько ячеек делят область и сливаются в кластер.',
      { t0: 31, rh0: 62, lapseLow: 7.2, lapseMid: 6.6, lapseTop: 5.8, zTrop: 11.5, rhMid: 50, rhTop: 30, ws0: 6, ws3: 11, ws6: 17, ws10: 24, wd0: 190, veer: 60 },
      { mode: 'field', count: 6, heating: 0.6, bubble: 2.2 }),

    preset('supercell', 'Суперячейка', 'вращение',
      'Классическая среда: CAPE 4 кДж/кг и сдвиг 20 м/с, правый мезоциклон и наковальня.',
      {},
      { mode: 'single', heating: 0.35, bubble: 2.8 }),

    preset('lp', 'LP-суперячейка', 'сухой воздух',
      'Сухие средние слои: узкий столб, слабые осадки, но крупный град и яркая наковальня.',
      { t0: 33, rh0: 45, lapseLow: 7.8, lapseMid: 7.2, lapseTop: 6.2, zTrop: 12.5, rhMid: 20, rhTop: 10, ws0: 8, ws3: 15, ws6: 26, ws10: 35, wd0: 160, veer: 100 },
      { mode: 'single', heating: 0.25, bubble: 3.0 }),

    preset('hp', 'HP-суперячейка', 'ливни',
      'Влажная среда: широкий отток, град и очень сильные ливни, слабая видимость в ядре.',
      { t0: 30, rh0: 75, lapseLow: 7.0, lapseMid: 6.5, lapseTop: 5.8, zTrop: 12, rhMid: 65, rhTop: 40, ws0: 8, ws3: 14, ws6: 22, ws10: 30, wd0: 170, veer: 85 },
      { mode: 'single', heating: 0.5, bubble: 2.4 }),

    preset('squall', 'Шквальная линия', 'линия',
      'Линейный запуск поперёк потока: ячейки выстраиваются в линию и дают общий фронт оттока.',
      { t0: 33, rh0: 65, lapseLow: 7.4, lapseMid: 7.0, lapseTop: 6.2, zTrop: 11.5, rhMid: 50, rhTop: 30, ws0: 10, ws3: 16, ws6: 24, ws10: 32, wd0: 240, veer: 40 },
      { mode: 'line', count: 8, heating: 0.4, bubble: 2.6 }),

    preset('mcs', 'Кластер МКС', 'много влаги',
      'Очень влажно, сдвиг слабый: поле ячеек сливается в мезомасштабный кластер с общим оттоком.',
      { t0: 29, rh0: 82, lapseLow: 6.6, lapseMid: 6.2, lapseTop: 5.5, zTrop: 13, rhMid: 70, rhTop: 45, ws0: 5, ws3: 8, ws6: 12, ws10: 18, wd0: 200, veer: 35 },
      { mode: 'field', count: 9, heating: 0.7, bubble: 2.0 }),

    preset('hail', 'Градовая', 'сильный сдвиг',
      'Большой сдвиг и умеренная влажность: наклонённый поток, крупный град, полоса града у земли.',
      { t0: 31, rh0: 55, lapseLow: 7.8, lapseMid: 7.4, lapseTop: 6.4, zTrop: 11.5, rhMid: 40, rhTop: 20, ws0: 9, ws3: 16, ws6: 28, ws10: 38, wd0: 170, veer: 110 },
      { mode: 'single', heating: 0.3, bubble: 3.2 }),

    preset('tornado', 'Торнадо', 'изогнутый годограф',
      'Торнадная среда: юго-восточный ветер у земли, сильный поворот к юго-западу, низкий LCL и большая спиральность 0–1 км.',
      { t0: 30, rh0: 72, lapseLow: 7.4, lapseMid: 6.8, lapseTop: 6.0, zTrop: 12, rhMid: 55, rhTop: 30, ws0: 14, ws3: 26, ws6: 30, ws10: 36, wd0: 150, veer: 190 },
      { mode: 'single', heating: 0.35, bubble: 2.6 }),

    preset('dry', 'Сухая конвекция', 'без осадков',
      'Высокая база и сухой воздух: мощные кучевые, но дождь испаряется, не доходя до земли.',
      { t0: 35, rh0: 22, lapseLow: 8.6, lapseMid: 7.8, lapseTop: 7.0, zTrop: 13, rhMid: 10, rhTop: 5, ws0: 5, ws3: 9, ws6: 15, ws10: 22, wd0: 240, veer: 50 },
      { mode: 'single', heating: 0.25, bubble: 3.4 }),

    preset('tropical', 'Тропическая', 'слабый сдвиг',
      'Малый CAPE, но много влаги: облака низкие, дождь частый, вращения почти нет.',
      { t0: 30, rh0: 88, lapseLow: 6.2, lapseMid: 5.6, lapseTop: 5.0, zTrop: 15, rhMid: 70, rhTop: 45, ws0: 2, ws3: 3, ws6: 5, ws10: 8, wd0: 120, veer: 25 },
      { mode: 'field', count: 8, heating: 0.8, bubble: 1.2 }),

    preset('field', 'Поле кучевых', 'много облаков',
      'Много слабых термиков над прогретой поверхностью: живое поле развивающихся кучевых облаков.',
      { t0: 32, rh0: 66, lapseLow: 7.4, lapseMid: 6.8, lapseTop: 6.0, zTrop: 12.5, rhMid: 50, rhTop: 30, ws0: 5, ws3: 9, ws6: 14, ws10: 20, wd0: 180, veer: 55 },
      { mode: 'field', count: 8, heating: 1.0, bubble: 1.6 })
  ];

  ML.getPreset = function (id) {
    for (var i = 0; i < ML.presets.length; i++) {
      if (ML.presets[i].id === id) return ML.presets[i];
    }
    return ML.presets[0];
  };
})(window);
