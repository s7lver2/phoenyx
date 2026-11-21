// Compila el `basisu` oficial (Binomial) a target/basisu-src/bin/Release/basisu.exe. Usa la fuente que trae el crate
// `basis-universal-sys` 0.3.1 (en el registro de cargo) y CMake con MSVC. Hace falta una vez por maquina.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const reg = path.join(os.homedir(), '.cargo/registry/src');
let vendor = null;
for (const d of fs.existsSync(reg) ? fs.readdirSync(reg) : []) {
  const c = path.join(reg, d, 'basis-universal-sys-0.3.1/vendor/basis_universal');
  if (fs.existsSync(c)) vendor = c;
}
if (!vendor) throw new Error('falta la fuente: baja el crate basis-universal-sys 0.3.1 (cargo fetch en cualquier proyecto que lo use)');
const dst = path.resolve('target/basisu-src');
fs.cpSync(vendor, dst, { recursive: true });
const run = (c) => execSync(c, { cwd: dst, stdio: 'inherit' });
run('cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSTATIC=TRUE -DCMAKE_POLICY_VERSION_MINIMUM=3.5');
run('cmake --build build --config Release -j 8');
console.log('listo:', path.join(dst, 'bin/Release/basisu.exe'));
