// Prepara un GLB del juego para phoenix-bake: descomprime meshopt, quita la cuantizacion y pasa las
// texturas webp a png (el crate `gltf` no lee esas extensiones).
// Uso: node tools/unpack_glb.mjs entrada.glb salida.glb
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
const root = execSync('npm root -g').toString().trim();
const req = createRequire(path.join(root, '@gltf-transform/cli/package.json'));
const { NodeIO } = req('@gltf-transform/core');
const { EXTTextureWebP, KHRMeshQuantization, EXTMeshoptCompression } = req('@gltf-transform/extensions');
const { dequantize } = req('@gltf-transform/functions');
const { MeshoptDecoder } = req('meshoptimizer');
const sharp = req('sharp');

const [inp, out] = process.argv.slice(2);
const io = new NodeIO()
  .registerExtensions([EXTTextureWebP, KHRMeshQuantization, EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
await MeshoptDecoder.ready;
const doc = await io.read(inp);
await doc.transform(dequantize());
for (const t of doc.getRoot().listTextures()) {
  if (t.getMimeType() === 'image/png') continue;
  t.setImage(new Uint8Array(await sharp(Buffer.from(t.getImage())).png().toBuffer()));
  t.setMimeType('image/png');
}
for (const e of doc.getRoot().listExtensionsUsed()) e.dispose();
await io.write(out, doc);
console.log('ok', out);
