// Copia de three 0.160.1 (MIT) el codigo que no toca el renderer, con sus dependencias, a packages/phoenyx/src/three/.
// Uso: node tools/sync-three.mjs [ruta/a/three]   (por defecto E:/backrooms/node_modules/three)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'E:/backrooms/node_modules/three');
const src = path.join(root, 'src');
const out = path.resolve('packages/phoenyx/src/three');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (version !== '0.160.1') throw new Error(`se esperaba three 0.160.1 y hay ${version}`);

const entries = fs.readFileSync('tools/three-files.txt', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
// las luces y geometrias que usa el juego se anaden por carpeta
for (const dir of ['lights']) for (const f of fs.readdirSync(path.join(src, dir))) if (f.endsWith('.js')) entries.push(`${dir}/${f}`);
for (const f of ['BoxGeometry', 'PlaneGeometry']) entries.push(`geometries/${f}.js`);
entries.push('constants.js', 'utils.js');

const seen = new Set();
const visit = (rel) => {
  if (seen.has(rel)) return;
  seen.add(rel);
  const file = path.join(src, rel);
  if (!fs.existsSync(file)) throw new Error(`falta ${rel}`);
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
};
entries.forEach(visit);

fs.rmSync(out, { recursive: true, force: true });
for (const rel of seen) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(src, rel), dest);
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.resolve('packages/phoenyx/LICENSE-three.txt'));
// indice: reexporta las entradas pedidas (no las dependencias)
const idx = [...new Set(entries)].map((e) => `export * from './three/${e}';`).join('\n');
fs.writeFileSync(path.resolve('packages/phoenyx/src/three-exports.ts'), `// Generado por tools/sync-three.mjs: no editar a mano.\n${idx}\n`);
console.log(`copiados ${seen.size} archivos de three ${version}`);
