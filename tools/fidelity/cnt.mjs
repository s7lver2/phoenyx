import { chromium } from 'playwright-core';
import fs from 'node:fs';
const sc = JSON.parse(fs.readFileSync('E:/backrooms/client/src/dev/scenes.json', 'utf8')).find((x) => x.id === 'suites');
const THR = Number(process.argv[2] ?? 4);
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
for (const [r, port] of [['three', 5193], ['phoenyx', 5192]]) {
  const cx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await cx.newPage();
  await (await cx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THR });
  await page.goto(`http://localhost:${port}/?${sc.query.replaceAll('@R', r)}&preset=high`);
  while (!(await page.evaluate(() => !!window.__capture?.ready))) await page.waitForTimeout(250);
  await page.evaluate((n) => window.__capture.advance(n), 120);
  await page.evaluate(() => window.__capture.release());
  await page.waitForTimeout(1500);
  const o = await page.evaluate(() => new Promise((res) => {
    const sc = window.__game.scene; const orig = sc.updateMatrixWorld.bind(sc); let calls = 0, ms = 0;
    sc.updateMatrixWorld = (f) => { const t = performance.now(); orig(f); ms += performance.now() - t; calls++; };
    let n = 0; sc.traverse(() => n++);
    let f = 0; const t0 = performance.now();
    const t = () => (++f < 60 ? requestAnimationFrame(t) : res({ objects: n, frames: f, scUpdPerFrame: calls / f, scUpdMsPerFrame: +(ms / f).toFixed(2), frameMs: +((performance.now() - t0) / f).toFixed(1) }));
    requestAnimationFrame(t);
  }));
  console.log(r, o);
  await page.close();
}
await b.close();
