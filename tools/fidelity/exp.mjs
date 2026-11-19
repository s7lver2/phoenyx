// Tiempos de GPU por fase del juego con Phoenyx (timestamp-query): node exp.mjs --scene suites [--throttle 1]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const url = arg('url', 'http://localhost:5192');
const sc = JSON.parse(fs.readFileSync('E:/backrooms/client/src/dev/scenes.json', 'utf8')).find((x) => x.id === arg('scene', 'suites'));
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const thr = Number(arg('throttle', '1'));
if (thr > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: thr });
await page.goto(`${url}/?${sc.query.replaceAll('@R', 'phoenyx')}&preset=high`);
let clicked = false;
while (!(await page.evaluate(() => !!window.__capture?.ready))) {
  const play = page.locator('button', { hasText: /^\s*PLAY\s*$/ }).first();
  if (!clicked && !/[?&](pool|poolmap|suites)/.test(sc.query) && (await play.isVisible().catch(() => false))) (await play.click(), (clicked = true));
  await page.waitForTimeout(250);
}
if (sc.pose) await page.evaluate((p) => window.__capture.setPose(...p), sc.pose);
await page.evaluate((n) => window.__capture.advance(n), sc.advance ?? 120);
await page.evaluate(() => window.__capture.release());
await page.waitForTimeout(1500);
await page.evaluate(() => window.__game.renderer.setGpuTiming(true));
const acc = {};
let n = 0;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(60);
  const t = await page.evaluate(() => window.__game.renderer.gpuTimes());
  if (!Object.keys(t).length) continue;
  n++;
  for (const [k, v] of Object.entries(t)) acc[k] = (acc[k] ?? 0) + v;
}
console.log(`${sc.id} x${thr}: ${n} lecturas`);
let tot = 0;
for (const [k, v] of Object.entries(acc).sort((a, c) => c[1] - a[1])) (console.log(k.padEnd(8), (v / n).toFixed(3), 'ms'), (tot += v / n));
console.log('total'.padEnd(8), tot.toFixed(3), 'ms');
await b.close();
