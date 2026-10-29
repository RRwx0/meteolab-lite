const fs = require('fs');
const path = require('path');
global.window = global;
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
eval(src('sounding.js'));
eval(src('model.js'));
const S = global.ML.sounding;
const M = global.ML;

const params = {
  t0: 32, rh0: 58, lapseLow: 7.6, lapseMid: 6.9, lapseTop: 6.0, zTrop: 12,
  rhMid: 45, rhTop: 25, ws0: 7, ws3: 13, ws6: 23, ws10: 32,
  wd0: 150, veer: 95, bubble: 2.8
};
params.wd3 = 150 + 95 * 0.33; params.wd6 = 150 + 95 * 0.66; params.wd10 = 245;
const prof = S.buildProfile(params);

function run(tag, opts, steps) {
  const m = new M.Model(prof, opts);
  const t0 = Date.now();
  for (let i = 0; i < steps; i++) m.step();
  const ms = (Date.now() - t0) / steps;
  const d = m.diag;
  console.log(tag.padEnd(26),
    'сетка', m.nx + '×' + m.ny + '×' + m.nz,
    '| w', d.maxW.toFixed(1),
    '| верх', (d.cloudTop / 1000).toFixed(1),
    '| dbz', d.maxDBZ.toFixed(0),
    '| ячеек', d.cells,
    '| площадь', d.updraftArea,
    '| мс/шаг', ms.toFixed(1));
}

run('одна ячейка 48²', { nx: 48, ny: 48, mode: 'single', bubble: 2.8, heating: 0 }, 300);
run('поле термиков 48²', { nx: 48, ny: 48, mode: 'field', count: 7, bubble: 2.8, heating: 0.5 }, 300);
run('линия шквала 48²', { nx: 48, ny: 48, mode: 'line', count: 7, bubble: 2.8, heating: 0.4 }, 300);
run('поле термиков 40²', { nx: 40, ny: 40, mode: 'field', count: 7, bubble: 2.8, heating: 0.5 }, 300);
