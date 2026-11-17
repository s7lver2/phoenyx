// Captura las escenas de referencia de Backrooms y mide rendimiento.
// Uso: node capture.mjs --url http://localhost:5190 --out ../../fidelity/out/three [--scenes ruta/scenes.json] [--throttle 1] [--preset high] [--only id1,id2]
// Deja <out>/<id>.png (canvas del juego, 1280x720) y <out>/perf.json.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const base = arg('url', 'http://localhost:5190');
const out = path.resolve(arg('out', '../../fidelity/out/three'));
const scenesPath = path.resolve(arg('scenes', 'E:/backrooms/client/src/dev/scenes.json'));
const throttle = Number(arg('throttle', '1'));
const preset = arg('preset', 'high');
const only = arg('only', '').split(',').filter(Boolean);
const renderer = arg('renderer', 'three'); // sustituye @R en las queries de las escenas (banco de la fase 1)
const chrome = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');

const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8')).filter((s) => !only.length || only.includes(s.id));
fs.mkdirSync(out, { recursive: true });

// Solo se ve el canvas del juego: HUD, texto y estadisticas fuera.
const HIDE = '* { visibility: hidden !important } canvas.br-gl { visibility: visible !important }';
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];

const browser = await chromium.launch({
  executablePath: chrome,
  headless: false,
  args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const perf = {};
let failed = 0;
for (const s of scenes) {
  for (const f of [`${s.id}.png`, `${s.id}-error.png`]) fs.rmSync(path.join(out, f), { force: true }); // sin restos de ejecuciones anteriores
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    if (throttle > 1) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (process.argv.includes('--console')) page.on('console', (m) => console.log(`  [${s.id}] ${m.type()}: ${m.text()}`));
    await page.goto(`${base}/?${s.query.replaceAll('@R', renderer)}&preset=${preset}`);
    const ready = () => page.evaluate(() => !!window.__capture?.ready);
    // Algunas escenas arrancan solas (&pool, &suites); las demas piden pulsar PLAY (una vez, cuando aparece el menu).
    const t0 = Date.now();
    let clicked = false;
    while (!(await ready()) && Date.now() - t0 < 120000) {
      const play = page.locator('button', { hasText: /^\s*PLAY\s*$/ }).first();
      if (!clicked && !/[?&](pool|poolmap|suites)/.test(s.query) && (await play.isVisible().catch(() => false))) {
        await play.click({ timeout: 5000 });
        clicked = true;
      }
      await page.waitForTimeout(250);
    }
    if (!(await ready())) throw new Error(`la escena ${s.id} no llego a estar lista en 120 s${errors.length ? ': ' + errors[0] : ''}`);
    if (s.pose) await page.evaluate((p) => window.__capture.setPose(...p), s.pose);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => window.__capture.reseed(12345));
    await page.evaluate((n) => window.__capture.advance(n), s.advance ?? 120);
    await page.addStyleTag({ content: HIDE });
    const info = await page.evaluate(() => window.__capture.info());
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, `${s.id}.png`) });

    // Rendimiento con el reloj real: 300 fotogramas.
    await page.evaluate(() => window.__capture.release());
    await page.waitForTimeout(500);
    const frames = await page.evaluate(
      () =>
        new Promise((res) => {
          const d = [];
          let last = performance.now();
          const f = (t) => {
            d.push(t - last);
            last = t;
            d.length < 300 ? requestAnimationFrame(f) : res(d.slice(10));
          };
          requestAnimationFrame(f);
        }),
    );
    const ctxInfo = await page.evaluate(() => window.__game?.crashContext?.() ?? {});
    perf[s.id] = { ...info, frameMsMedian: +median(frames).toFixed(2), frameMsP95: +p95(frames).toFixed(2), cpuMsRender: ctxInfo.renderMs ?? null, resScale: ctxInfo.res ?? null, gpu: ctxInfo.gpu ?? null };
    console.log(`ok ${s.id}  calls ${info.drawCalls}  tris ${info.triangles}  frame ${perf[s.id].frameMsMedian} ms (p95 ${perf[s.id].frameMsP95})`);
  } catch (e) {
    failed++;
    await page.screenshot({ path: path.join(out, `${s.id}-error.png`) }).catch(() => {});
    console.error(`FALLA ${s.id}: ${e.message}`);
  } finally {
    await ctx.close();
  }
}
fs.writeFileSync(path.join(out, 'perf.json'), JSON.stringify({ url: base, preset, throttle, perf }, null, 2));
await browser.close();
process.exit(failed ? 1 : 0);
