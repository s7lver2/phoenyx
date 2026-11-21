// Convierte texturas a KTX2/Basis (KHR_texture_basisu) sin tocar la geometria.
//
//   node tools/ktx_convert.mjs glb  <entrada.glb|carpeta> <salida.glb|carpeta> [opciones]
//   node tools/ktx_convert.mjs tex  <imagen|carpeta>      <carpeta salida>     [opciones]   (png/jpg/webp -> .ktx2 suelto)
//
// Opciones:
//   --mode auto|uastc|etc1s   auto (por defecto): ETC1S para todo (normales con --normal-mode). uastc: calidad maxima (BC7 casi sin
//                             perdida, pesa mas). etc1s: el mas pequeno.
//   --q N                     calidad de ETC1S, 1-255 (220 por defecto; 128, el de basisu, se nota en texturas con detalle fino)
//   --uastc-level N           nivel de UASTC 0-4 (2 por defecto)
//   --rdo X                   RDO de UASTC (lambda; menor = mejor calidad; sin el, no hay RDO). 1 a 4 reduce mucho el tamano
//   --normal-mode uastc|etc1s codec de los mapas de normales en `auto` (etc1s por defecto; uastc los triplica de tamano)
//   --normal-q N              calidad ETC1S de las normales si --normal-mode etc1s (255 por defecto)
//   --jobs N                  procesos basisu en paralelo (nucleos - 1 por defecto)
//   --report fichero.json     escribe tamanos antes/despues por textura
//
// Los GLB se reescriben a nivel de bytes: solo cambian las imagenes (y el JSON que las nombra); la geometria, incluida la comprimida
// con meshopt, queda tal cual. Requiere `basisu` (ver tools/build-basisu.mjs) y `sharp` (viene con @gltf-transform/cli global).
import { createRequire } from 'node:module';
import { execSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = execSync('npm root -g').toString().trim();
const sharp = createRequire(path.join(root, '@gltf-transform/cli/package.json'))('sharp');
const BASISU = process.env.BASISU ?? path.resolve(import.meta.dirname, '../target/basisu-src/bin/Release/basisu.exe');
if (!fs.existsSync(BASISU)) throw new Error(`falta basisu en ${BASISU}: ejecuta node tools/build-basisu.mjs`);

const argv = process.argv.slice(2);
const [cmd, input, output] = argv;
const opt = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i > 0 ? argv[i + 1] : d;
};
const mode = opt('mode', 'auto');
const quality = opt('q', '220');
const uastcLevel = opt('uastc-level', '2');
const rdo = opt('rdo', '');
const normalMode = opt('normal-mode', 'etc1s');
const normalQ = opt('normal-q', '255');
const jobs = Number(opt('jobs', Math.max(1, os.cpus().length - 1)));
const reportPath = opt('report', '');
const cache = path.join(os.tmpdir(), 'phoenyx-ktx-cache');
fs.mkdirSync(cache, { recursive: true });

/** Cola con limite de procesos simultaneos. */
let active = 0;
const waiting = [];
const slot = () => new Promise((res) => (active < jobs ? (active++, res()) : waiting.push(res)));
const release = () => (waiting.length ? waiting.shift()() : active--);

/**
 * Codifica una imagen (cualquier formato de sharp) a KTX2 con mipmaps.
 * `kind`: 'color' (sRGB), 'data' (lineal: rugosidad, oclusion) o 'normal'.
 */
const inflight = new Map(); // imagenes iguales (misma clave) se codifican una sola vez aunque se pidan a la vez
function encode(imageBytes, kind) {
  const k = crypto.createHash('sha1').update(imageBytes).update(kind).digest('hex');
  if (!inflight.has(k)) inflight.set(k, encodeNow(imageBytes, kind));
  return inflight.get(k);
}

async function encodeNow(imageBytes, kind) {
  const codec = mode === 'auto' ? (kind === 'normal' ? normalMode : 'etc1s') : mode;
  const q = kind === 'normal' && mode === 'auto' ? normalQ : quality;
  const key = crypto.createHash('sha1').update(imageBytes).update(`${kind}|${codec}|${q}|${uastcLevel}|${rdo}`).digest('hex');
  const cached = path.join(cache, key + '.ktx2');
  if (fs.existsSync(cached)) return { data: fs.readFileSync(cached), codec };
  // el nivel base debe ser multiplo de 4 (bloques de BC/ETC2/ASTC): se ajusta al multiplo mas cercano
  const img = sharp(imageBytes);
  const { width, height } = await img.metadata();
  const w = Math.max(4, Math.round(width / 4) * 4), h = Math.max(4, Math.round(height / 4) * 4);
  const png = await (w === width && h === height ? img : img.resize(w, h, { kernel: 'lanczos3' })).png().toBuffer();
  const src = path.join(cache, key + '.png');
  fs.writeFileSync(src, png);
  const args = ['-ktx2', '-mipmap', '-output_file', cached, src];
  if (codec === 'uastc') args.unshift('-uastc', '-uastc_level', uastcLevel, ...(rdo ? ['-uastc_rdo_l', rdo] : []));
  else args.unshift('-q', q);
  if (kind !== 'color') args.unshift('-linear');
  if (kind === 'normal') args.unshift('-normal_map');
  await slot();
  try {
    await new Promise((res, rej) => execFile(BASISU, args, { maxBuffer: 1 << 26 }, (e, so, se) => (e ? rej(new Error(`basisu: ${e.message}\n${so}${se}`)) : res())));
  } finally {
    release();
    fs.rmSync(src, { force: true });
  }
  return { data: fs.readFileSync(cached), codec };
}

const report = [];

/** Reescribe un GLB: imagenes -> KTX2, con KHR_texture_basisu. */
async function convertGlb(inp, out) {
  const buf = fs.readFileSync(inp);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${inp}: no es un GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  const images = json.images ?? [];
  if (!images.length) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(inp, out);
    return;
  }
  const sourceOf = (t) => t.extensions?.EXT_texture_webp?.source ?? t.extensions?.KHR_texture_basisu?.source ?? t.source;
  // para que se usa cada imagen: color (sRGB), normal o dato lineal
  const kindOfImage = new Map(); // indice de imagen -> Set de tipos
  const mark = (info, kind) => {
    if (!info) return;
    const src = sourceOf(json.textures[info.index]);
    if (!kindOfImage.has(src)) kindOfImage.set(src, new Set());
    kindOfImage.get(src).add(kind);
  };
  for (const m of json.materials ?? []) {
    const p = m.pbrMetallicRoughness ?? {};
    mark(p.baseColorTexture, 'color');
    mark(m.emissiveTexture, 'color');
    mark(m.normalTexture, 'normal');
    mark(p.metallicRoughnessTexture, 'data');
    mark(m.occlusionTexture, 'data');
  }
  const views = json.bufferViews;
  // una imagen se codifica una vez por tipo con el que se use; cada textura apunta a la de su tipo
  const newImages = [];
  const imageIndex = new Map(); // `${imagen}|${tipo}` -> indice de imagen nueva
  const jobsList = [];
  for (let i = 0; i < images.length; i++) {
    const v = views[images[i].bufferView];
    const bytes = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    for (const kind of [...(kindOfImage.get(i) ?? ['color'])]) {
      const idx = newImages.length;
      newImages.push(null);
      imageIndex.set(`${i}|${kind}`, idx);
      jobsList.push(encode(bytes, kind).then((r) => {
        newImages[idx] = { name: images[i].name, data: r.data };
        report.push({ glb: path.basename(inp), image: images[i].name ?? i, kind, codec: r.codec, before: bytes.length, after: r.data.length });
      }));
    }
  }
  await Promise.all(jobsList);
  // texturas: cada una usa la imagen nueva del tipo con que la usa su material (si varios materiales la usan con tipos distintos,
  // se duplica la textura por tipo y se reapunta el material)
  const texKind = new Map(); // indice de textura -> tipo
  const retarget = (info, kind) => {
    if (!info) return;
    const t = json.textures[info.index];
    const k = `${info.index}|${kind}`;
    if (!texKind.has(info.index)) texKind.set(info.index, new Map());
    const byKind = texKind.get(info.index);
    if (!byKind.has(kind)) {
      if (byKind.size === 0) byKind.set(kind, info.index);
      else {
        json.textures.push(JSON.parse(JSON.stringify(t)));
        byKind.set(kind, json.textures.length - 1);
      }
    }
    info.index = byKind.get(kind);
    void k;
  };
  const originalTextures = JSON.parse(JSON.stringify(json.textures ?? []));
  for (const m of json.materials ?? []) {
    const p = m.pbrMetallicRoughness ?? {};
    retarget(p.baseColorTexture, 'color');
    retarget(m.emissiveTexture, 'color');
    retarget(m.normalTexture, 'normal');
    retarget(p.metallicRoughnessTexture, 'data');
    retarget(m.occlusionTexture, 'data');
  }
  // cada textura (original o duplicada) recibe la imagen nueva de su tipo
  const kindOfTexture = new Map();
  for (const [orig, byKind] of texKind) for (const [kind, idx] of byKind) kindOfTexture.set(idx, { kind, src: sourceOf(originalTextures[orig]) });
  json.textures.forEach((t, i) => {
    const k = kindOfTexture.get(i);
    const src = k ? k.src : sourceOf(t);
    const kind = k ? k.kind : [...(kindOfImage.get(src) ?? ['color'])][0];
    t.extensions = { KHR_texture_basisu: { source: imageIndex.get(`${src}|${kind}`) ?? 0 } };
    delete t.source;
  });
  // reconstruye el BIN: todo menos las imagenes viejas, mas las KTX2 nuevas
  const chunks = [];
  let pos = 0;
  const put = (data) => {
    const o = pos;
    chunks.push(data);
    pos += data.length;
    const pad = (4 - (pos % 4)) % 4;
    if (pad) (chunks.push(Buffer.alloc(pad)), (pos += pad));
    return o;
  };
  const moved = new Map();
  const move = (o, len) => {
    const k = `${o}:${len}`;
    if (!moved.has(k)) moved.set(k, put(bin.subarray(o, o + len)));
    return moved.get(k);
  };
  const oldImageViews = new Set(images.map((im) => im.bufferView));
  const fallback = (b) => !!json.buffers[b].extensions?.EXT_meshopt_compression?.fallback;
  const viewsOut = [];
  const remap = new Map();
  views.forEach((v, i) => {
    if (oldImageViews.has(i)) return;
    const nv = { ...v };
    const e = v.extensions?.EXT_meshopt_compression;
    if (v.buffer === 0 && !fallback(0)) nv.byteOffset = move(v.byteOffset ?? 0, v.byteLength);
    if (e && e.buffer === 0 && !fallback(0)) nv.extensions = { ...v.extensions, EXT_meshopt_compression: { ...e, byteOffset: move(e.byteOffset ?? 0, e.byteLength) } };
    remap.set(i, viewsOut.length);
    viewsOut.push(nv);
  });
  for (const a of json.accessors ?? []) {
    if (a.bufferView !== undefined) a.bufferView = remap.get(a.bufferView);
    if (a.sparse) {
      a.sparse.indices.bufferView = remap.get(a.sparse.indices.bufferView);
      a.sparse.values.bufferView = remap.get(a.sparse.values.bufferView);
    }
  }
  json.images = newImages.map((n) => {
    const o = put(n.data);
    viewsOut.push({ buffer: 0, byteOffset: o, byteLength: n.data.length });
    return { name: n.name, mimeType: 'image/ktx2', bufferView: viewsOut.length - 1 };
  });
  json.bufferViews = viewsOut;
  json.buffers[0].byteLength = pos;
  const ext = (list) => [...new Set([...(list ?? []).filter((e) => e !== 'EXT_texture_webp'), 'KHR_texture_basisu'])];
  json.extensionsUsed = ext(json.extensionsUsed);
  json.extensionsRequired = ext(json.extensionsRequired);
  const jbuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jpad = Buffer.alloc((4 - (jbuf.length % 4)) % 4, 0x20);
  const binBuf = Buffer.concat(chunks);
  const total = 12 + 8 + jbuf.length + jpad.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([head, ch(jbuf.length + jpad.length, 0x4e4f534a), jbuf, jpad, ch(binBuf.length, 0x004e4942), binBuf]));
  console.log(`${path.basename(inp)}: ${(buf.length / 1024).toFixed(0)} KB -> ${(total / 1024).toFixed(0)} KB (${images.length} imagenes)`);
}

const listFiles = (p, ext) =>
  fs.statSync(p).isDirectory()
    ? fs.readdirSync(p, { recursive: true }).filter((f) => ext.some((e) => f.toLowerCase().endsWith(e))).map((f) => path.join(p, f))
    : [p];

if (cmd === 'glb') {
  const dir = fs.statSync(input).isDirectory();
  for (const f of listFiles(input, ['.glb'])) await convertGlb(f, dir ? path.join(output, path.relative(input, f)) : output);
} else if (cmd === 'tex') {
  fs.mkdirSync(output, { recursive: true });
  await Promise.all(
    listFiles(input, ['.png', '.jpg', '.jpeg', '.webp']).map(async (f) => {
      const bytes = fs.readFileSync(f);
      const kind = /normal|nrm|_n\./i.test(f) ? 'normal' : /rough|metal|orm|occl|_ao|height|bump/i.test(f) ? 'data' : 'color';
      const r = await encode(bytes, kind);
      fs.writeFileSync(path.join(output, path.basename(f).replace(/\.[^.]+$/, '.ktx2')), r.data);
      report.push({ file: path.basename(f), kind, codec: r.codec, before: bytes.length, after: r.data.length });
      console.log(`${path.basename(f)} (${kind}, ${r.codec}): ${bytes.length} -> ${r.data.length}`);
    }),
  );
} else {
  console.log('uso: node tools/ktx_convert.mjs glb|tex <entrada> <salida> [--mode auto|uastc|etc1s] [--q N] [--report r.json]');
  process.exit(1);
}
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
const sum = (k) => report.reduce((a, r) => a + r[k], 0);
if (report.length) console.log(`texturas: ${report.length}, ${(sum('before') / 1048576).toFixed(2)} MB -> ${(sum('after') / 1048576).toFixed(2)} MB`);
