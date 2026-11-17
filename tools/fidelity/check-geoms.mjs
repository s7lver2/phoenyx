// Comprueba que las geometrias de phoenyx (copiadas de three) dan los mismos vertices e indices que three real.
// Uso: node check-geoms.mjs   (desde tools/fidelity)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = path.join(root, 'fidelity/out/check');
fs.mkdirSync(tmp, { recursive: true });
const entry = path.join(tmp, 'entry.js');
// las mismas llamadas con el namespace que se le pase
fs.writeFileSync(entry, `
import * as T from 'three';
export const make = () => {
  const L = [
    ['Box', () => new T.BoxGeometry(1, 2, 3, 2, 2, 2)],
    ['Plane', () => new T.PlaneGeometry(2, 3, 2, 2)],
    ['Cylinder', () => new T.CylinderGeometry(0.5, 1, 2, 12, 2)],
    ['Sphere', () => new T.SphereGeometry(1, 16, 12)],
    ['Capsule', () => new T.CapsuleGeometry(0.4, 1, 4, 10)],
    ['Circle', () => new T.CircleGeometry(1, 16)],
    ['Cone', () => new T.ConeGeometry(1, 2, 12)],
    ['Ring', () => new T.RingGeometry(0.5, 1, 16)],
    ['Torus', () => new T.TorusGeometry(1, 0.3, 8, 16)],
    ['Tube', () => new T.TubeGeometry(new T.CatmullRomCurve3([new T.Vector3(0, 0, 0), new T.Vector3(1, 1, 0), new T.Vector3(2, 0, 1)]), 20, 0.1, 6)],
    ['Lathe', () => new T.LatheGeometry([new T.Vector2(0.2, 0), new T.Vector2(0.5, 0.5), new T.Vector2(0.3, 1)], 12)],
    ['Extrude', () => { const s = new T.Shape(); s.moveTo(0, 0); s.lineTo(1, 0); s.lineTo(1, 1); s.lineTo(0, 1); return new T.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false }); }],
    ['Octahedron', () => new T.OctahedronGeometry(1, 1)],
    ['Dodecahedron', () => new T.DodecahedronGeometry(1)],
    ['Edges', () => new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1))],
  ];
  return L.map(([n, f]) => { const g = f(); return [n, Array.from(g.attributes.position.array), g.index ? Array.from(g.index.array) : []]; });
};
`);
const bundle = (alias, outfile) => build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, alias: { three: alias }, logLevel: 'warning' });
const a = path.join(tmp, 'three.mjs'), b = path.join(tmp, 'phoenyx.mjs');
await bundle(path.join(import.meta.dirname, 'node_modules/three/build/three.module.js'), a);
await bundle(path.join(root, 'packages/phoenyx/src/index.ts'), b);
const A = (await import('file:///' + a.replace(/\\/g, '/'))).make();
const B = (await import('file:///' + b.replace(/\\/g, '/'))).make();
let bad = 0;
for (let i = 0; i < A.length; i++) {
  const ok = JSON.stringify(A[i]) === JSON.stringify(B[i]);
  if (!ok) bad++;
  console.log(ok ? 'ok   ' : 'FALLA', A[i][0], A[i][1].length / 3, 'vertices');
}
process.exit(bad ? 1 : 0);
