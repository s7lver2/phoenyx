// Mide texturas normales frente a KTX2 en la escena `ktx` del banco: VRAM de texturas, bytes descargados, tiempo de carga y captura.
// Uso: node ktx.mjs --out ../../fidelity/out/ktx [--variants plain,models-ktx,models-ktx-e1s] [--chrome ruta]
// `<carpeta>+nocomp` finge una GPU sin compresion (RGBA8 transcodificado). `plain` lee /models (GLB originales, WebP/PNG); cualquier otro nombre es una carpeta de web/ con GLB convertidos (tools/ktx_convert.mjs).
// Deja <out>/<variante>.png y <out>/ktx.json. Compara luego con compare.mjs.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const out = path.resolve(arg('out', '../../fidelity/out/ktx'));
const variants = arg('variants', 'plain,models-ktx').split(',');
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const web = path.resolve(import.meta.dirname, '../../web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.json': 'application/json' };
fs.mkdirSync(out, { recursive: true });

const server = http.createServer((req, res) => {
  const f = path.join(web, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(web) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return (res.writeHead(404), res.end());
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'content-length': fs.statSync(f).size });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch({ executablePath: chrome, headless: false, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const result = {};
for (const v of variants) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.text()));
  let bytes = 0, files = 0;
  page.on('response', async (r) => {
    if (/\.(glb|ktx2|wasm)$/.test(new URL(r.url()).pathname) && !r.url().includes('phoenyx_gl')) {
      const b = (await r.body().catch(() => Buffer.alloc(0))).length;
      bytes += b;
      files++;
    }
  });
  const t0 = Date.now();
  await page.goto(`${base}/fidelity/index.html?renderer=phoenyx&scene=ktx${v === 'plain' ? '' : '&ktx=' + v.split('+')[0]}${v.endsWith('+nocomp') ? '&nocomp=1' : ''}`);
  await page.waitForFunction(() => window.__capture?.ready, null, { timeout: 120000 });
  const tReady = Date.now() - t0;
  await page.evaluate(() => window.__capture.advance(4));
  const info = await page.evaluate(() => window.__capture.info());
  await (await page.$('canvas.br-gl')).screenshot({ path: path.join(out, `${v.replace('+', '-')}.png`) });
  result[v] = { ...info, vramMB: +(info.textureBytes / 1048576).toFixed(2), downloadedMB: +(bytes / 1048576).toFixed(2), files, readyMs: tReady, errors };
  console.log(v, JSON.stringify(result[v]));
  await ctx.close();
}
fs.writeFileSync(path.join(out, 'ktx.json'), JSON.stringify(result, null, 1));
await browser.close();
server.close();
