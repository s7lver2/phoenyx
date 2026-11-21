// Empaqueta web/fidelity/room.js dos veces: con three real y con phoenyx (alias de `three`).
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const common = { entryPoints: [path.join(root, 'web/fidelity/room.js')], bundle: true, format: 'esm', sourcemap: false, logLevel: 'warning' };
await build({ ...common, outfile: path.join(root, 'web/fidelity/dist/three.js'), alias: { 'three/examples/jsm': path.join(import.meta.dirname, 'node_modules/three/examples/jsm'), three: path.join(import.meta.dirname, 'node_modules/three/build/three.module.js') } });
await build({ ...common, outfile: path.join(root, 'web/fidelity/dist/phoenyx.js'), alias: { 'three/examples/jsm': path.join(root, 'packages/phoenyx/src/jsm'), three: path.join(root, 'packages/phoenyx/src/index.ts') } });
import fs from 'node:fs';
fs.copyFileSync(path.join(root, 'packages/phoenyx/pkg/phoenyx_gl_bg.wasm'), path.join(root, 'web/fidelity/dist/phoenyx_gl_bg.wasm'));
// transcodificador Basis del KTX2Loader (escena ktx)
fs.mkdirSync(path.join(root, 'web/fidelity/dist/basis'), { recursive: true });
for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) fs.copyFileSync(path.join(root, 'packages/phoenyx/basis', f), path.join(root, 'web/fidelity/dist/basis', f));
console.log('harness listo: web/fidelity/dist/{three,phoenyx}.js');
