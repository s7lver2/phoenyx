// Compara dos carpetas de capturas (las mismas escenas) y mide la fidelidad.
// Uso: node compare.mjs --a ../../fidelity/out/three --b ../../fidelity/out/phoenyx --out ../../fidelity/out/diff
// Por escena escribe <out>/<id>-diff.png y un informe <out>/report.json. Termina con codigo 1 si alguna escena falla.
// Umbral (docs/superpowers/specs/...-design.md): error medio < 1/255 y ningun pixel de interior por encima de 8/255
// (los bordes, a 2 px o menos de un contorno de la imagen A, se cuentan aparte: el antialiasing no es identico).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const A = path.resolve(arg('a', ''));
const B = path.resolve(arg('b', ''));
const OUT = path.resolve(arg('out', '../../fidelity/out/diff'));
const MEAN_MAX = Number(arg('mean', '1'));
const PIXEL_MAX = Number(arg('pixel', '8'));
// --box N: compara las medias de bloques de N x N (para shaders con ruido por pixel, cuyo hash sale distinto en cada compilador: el grano no se puede igualar bit a bit)
const BOX = Number(arg('box', '0'));
const ONLY = arg('only', '').split(',').filter(Boolean);
if (!arg('a', '') || !arg('b', '')) {
  console.error('uso: node compare.mjs --a <carpeta> --b <carpeta> [--out <carpeta>]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const ids = fs
  .readdirSync(A)
  .filter((f) => f.endsWith('.png') && !f.endsWith('-error.png'))
  .map((f) => f.slice(0, -4))
  .filter((id) => !ONLY.length || ONLY.includes(id));
/** Sustituye cada bloque de N x N por su media (en sitio). */
function boxAvg(img, N) {
  const { width: w, height: h, data: d } = img;
  for (let by = 0; by < h; by += N)
    for (let bx = 0; bx < w; bx += N) {
      const s = [0, 0, 0, 0];
      let c = 0;
      for (let y = by; y < Math.min(h, by + N); y++) for (let x = bx; x < Math.min(w, bx + N); x++) { const i = (y * w + x) * 4; for (let k = 0; k < 4; k++) s[k] += d[i + k]; c++; }
      for (let y = by; y < Math.min(h, by + N); y++) for (let x = bx; x < Math.min(w, bx + N); x++) { const i = (y * w + x) * 4; for (let k = 0; k < 4; k++) d[i + k] = Math.round(s[k] / c); }
    }
}
if (!ids.length) { console.error('no hay capturas en ' + A); process.exit(2); }
for (const f of fs.readdirSync(B)) if (f.endsWith('.png') && !f.endsWith('-error.png') && !ids.includes(f.slice(0, -4))) console.error('AVISO: ' + f + ' esta en B y no en A: se ignora');
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Marca como borde los pixeles con gradiente fuerte y los 2 vecinos de cada lado. */
function edgeMask(img) {
  const { width: w, height: h, data: d } = img;
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const gx = lum(d, i + 4) - lum(d, i - 4);
      const gy = lum(d, i + w * 4) - lum(d, i - w * 4);
      if (Math.abs(gx) + Math.abs(gy) > 24) e[y * w + x] = 1;
    }
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (e[y * w + x])
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < h && xx >= 0 && xx < w) m[yy * w + xx] = 1;
          }
  return m;
}

const report = {};
let failed = 0;
for (const id of ids) {
  const fb = path.join(B, id + '.png');
  if (!fs.existsSync(fb)) {
    console.error(`FALTA ${id}: no esta en ${B}`);
    report[id] = { ok: false, error: 'falta en B' };
    failed++;
    continue;
  }
  const a = PNG.sync.read(fs.readFileSync(path.join(A, id + '.png')));
  const b = PNG.sync.read(fs.readFileSync(fb));
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`TAMANO ${id}: ${a.width}x${a.height} contra ${b.width}x${b.height}`);
    report[id] = { ok: false, error: 'tamano distinto' };
    failed++;
    continue;
  }
  if (BOX > 1) (boxAvg(a, BOX), boxAvg(b, BOX));
  const n = a.width * a.height;
  const mask = edgeMask(a);
  const err = new Uint8Array(n);
  let sum = 0, over = 0, overInterior = 0, max = 0;
  const hist = new Uint32Array(256);
  const diff = new PNG({ width: a.width, height: a.height });
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    let e = 0, s = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.abs(a.data[i + c] - b.data[i + c]);
      e = Math.max(e, v);
      s += v;
    }
    sum += s / 3;
    err[p] = e;
    hist[e]++;
    if (e > max) max = e;
    const bad = e > PIXEL_MAX;
    if (bad) {
      over++;
      if (!mask[p]) overInterior++;
    }
    // Mapa: gris = error x8; rojo = por encima del umbral en el interior; naranja = en un borde.
    const g = Math.min(255, e * 8);
    diff.data[i] = bad ? 255 : g;
    diff.data[i + 1] = bad ? (mask[p] ? 160 : 0) : g;
    diff.data[i + 2] = bad ? 0 : g;
    diff.data[i + 3] = 255;
  }
  let acc = 0, p99 = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.99) { p99 = v; break; }
  }
  const mean = sum / n;
  const ok = mean < MEAN_MAX && overInterior === 0;
  fs.writeFileSync(path.join(OUT, id + '-diff.png'), PNG.sync.write(diff));
  report[id] = { ok, mean: +mean.toFixed(4), p99, max, pixelsOver8: over, pixelsOver8Interior: overInterior };
  if (!ok) failed++;
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ a: A, b: B, mean_max: MEAN_MAX, pixel_max: PIXEL_MAX, report }, null, 2));
console.log('escena'.padEnd(18), 'media'.padStart(8), 'p99'.padStart(5), 'max'.padStart(5), `>${PIXEL_MAX}`.padStart(8), `>${PIXEL_MAX} int.`.padStart(8), ' resultado');
for (const [id, r] of Object.entries(report))
  console.log(id.padEnd(18), String(r.mean ?? '-').padStart(8), String(r.p99 ?? '-').padStart(5), String(r.max ?? '-').padStart(5), String(r.pixelsOver8 ?? '-').padStart(8), String(r.pixelsOver8Interior ?? '-').padStart(8), ' ', r.ok ? 'ok' : `FALLA${r.error ? ' (' + r.error + ')' : ''}`);
process.exit(failed ? 1 : 0);
