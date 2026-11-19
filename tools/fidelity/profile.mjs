// Perfil de CPU del juego en una escena: tiempo propio por funcion (Chrome Profiler por CDP).
// Uso: node profile.mjs --url http://localhost:5192 --scene suites [--throttle 4] [--top 30]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const base = arg('url', 'http://localhost:5192');
const sceneId = arg('scene', 'suites');
const throttle = Number(arg('throttle', '4'));
const top = Number(arg('top', '30'));
const scenes = JSON.parse(fs.readFileSync(arg('scenes', 'E:/backrooms/client/src/dev/scenes.json'), 'utf8'));
const s = scenes.find((x) => x.id === sceneId);
if (!s) throw new Error('escena desconocida ' + sceneId);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: false,
  args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
await page.goto(`${base}/?${s.query.replaceAll('@R', 'phoenyx')}&preset=high`);
const ready = () => page.evaluate(() => !!window.__capture?.ready);
const t0 = Date.now();
let clicked = false;
while (!(await ready()) && Date.now() - t0 < 120000) {
  const play = page.locator('button', { hasText: /^\s*PLAY\s*$/ }).first();
  if (!clicked && !/[?&](pool|poolmap|suites)/.test(s.query) && (await play.isVisible().catch(() => false))) {
    await play.click({ timeout: 5000 });
    clicked = true;
  }
  await page.waitForTimeout(250);
}
if (s.pose) await page.evaluate((p) => window.__capture.setPose(...p), s.pose);
await page.waitForLoadState('networkidle').catch(() => {});
await page.evaluate((n) => window.__capture.advance(n), s.advance ?? 120);
await page.evaluate(() => window.__capture.release());
await page.waitForTimeout(1500);

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const nFrames = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const f = () => (++n < 200 ? requestAnimationFrame(f) : res(n));
      requestAnimationFrame(f);
    }),
);
const { profile } = await cdp.send('Profiler.stop');

const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
profile.samples.forEach((id, i) => {
  const n = byId.get(id);
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
const idle = self.get("(idle) :0") ?? 0;
console.log(`escena ${sceneId} x${throttle}: ${nFrames} fotogramas, ${((total - idle) / 1000 / nFrames).toFixed(2)} ms de CPU ocupada por fotograma (inactivo ${(idle / 1000 / nFrames).toFixed(2)})`);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / 1000 / nFrames).toFixed(3).padStart(8)} ms  ${k}`);
// quien llama (primer ancestro que no es la propia funcion) con tiempo propio+hijos de la funcion --callers
const fn = arg('callers', '');
if (fn) {
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const selfT = new Map();
  profile.samples.forEach((id, i) => selfT.set(id, (selfT.get(id) ?? 0) + (dt[i] ?? 0)));
  const by = new Map();
  for (const [id, t] of selfT) {
    let cur = id, hit = null;
    while (cur != null) { const n = byId.get(cur); if (n.callFrame.functionName === fn) hit = cur; cur = parent.get(cur); }
    if (hit == null) continue;
    let up = parent.get(hit);
    while (up != null && byId.get(up).callFrame.functionName === fn) up = parent.get(up);
    const cf = up != null ? byId.get(up).callFrame : { functionName: '?', url: '', lineNumber: 0 };
    const key = `${cf.functionName} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
    by.set(key, (by.get(key) ?? 0) + t);
  }
  console.log('llamadores de ' + fn);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${(v / 1000 / nFrames).toFixed(3).padStart(8)} ms  ${k}`);
}
const incl = arg('incl', '');
if (incl) {
  const parent2 = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent2.set(c, n.id);
  const names = incl.split(',');
  const tot2 = Object.fromEntries(names.map((n) => [n, 0]));
  profile.samples.forEach((id, i) => {
    const seen = new Set();
    for (let cur = id; cur != null; cur = parent2.get(cur)) seen.add(byId.get(cur).callFrame.functionName);
    for (const n of names) if (seen.has(n)) tot2[n] += dt[i] ?? 0;
  });
  console.log('inclusivo (ms/fotograma):');
  for (const n of names) console.log(`${(tot2[n] / 1000 / nFrames).toFixed(2).padStart(8)}  ${n}`);
}
await browser.close();
