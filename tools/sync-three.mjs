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
// todas las geometrias, texturas, curvas, formas y los cargadores de imagen
for (const dir of ['geometries', 'textures', 'extras/curves']) for (const f of fs.readdirSync(path.join(src, dir))) if (f.endsWith('.js') && f !== 'Geometries.js' && f !== 'Curves.js') entries.push(`${dir}/${f}`);
for (const f of ['extras/core/Shape.js', 'extras/core/Path.js', 'extras/core/CurvePath.js', 'extras/core/Curve.js', 'extras/ShapeUtils.js', 'extras/DataUtils.js', 'loaders/TextureLoader.js', 'loaders/ImageLoader.js', 'loaders/FileLoader.js', 'loaders/ImageBitmapLoader.js', 'loaders/LoadingManager.js', 'loaders/Cache.js', 'loaders/Loader.js', 'loaders/LoaderUtils.js', 'loaders/MaterialLoader.js', 'core/InterleavedBuffer.js', 'core/InterleavedBufferAttribute.js']) entries.push(f);
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
// examples/jsm: cargadores y utilidades (sus importaciones de 'three' las resuelve el alias)
const jsm = fs.readFileSync('tools/three-jsm-files.txt', 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const jseen = new Set();
const jvisit = (rel) => {
  if (jseen.has(rel)) return;
  jseen.add(rel);
  const text = fs.readFileSync(path.join(root, 'examples/jsm', rel), 'utf8');
  for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) jvisit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
};
jsm.forEach(jvisit);
const jout = path.resolve('packages/phoenyx/src/jsm');
fs.rmSync(jout, { recursive: true, force: true });
for (const rel of jseen) {
  const dest = path.join(jout, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, 'examples/jsm', rel), dest);
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.resolve('packages/phoenyx/LICENSE-three.txt'));
// indice: reexporta las entradas pedidas (no las dependencias)
const idx = [...new Set(entries)].map((e) => `export * from './three/${e}';`).join('\n');
fs.writeFileSync(path.resolve('packages/phoenyx/src/three-exports.ts'), `// Generado por tools/sync-three.mjs: no editar a mano.\n${idx}\n`);
console.log(`copiados ${seen.size} + ${jseen.size} (jsm) archivos de three ${version}`);
