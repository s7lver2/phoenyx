import { chromium } from 'playwright-core';
import fs from 'node:fs';
const sc = JSON.parse(fs.readFileSync('E:/backrooms/client/src/dev/scenes.json', 'utf8')).find((x) => x.id === 'suites');
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.goto(`http://localhost:5192/?${sc.query.replaceAll('@R', 'phoenyx')}&preset=high`);
while (!(await page.evaluate(() => !!window.__capture?.ready))) await page.waitForTimeout(250);
await page.evaluate((n) => window.__capture.advance(n), 120);
await page.evaluate(() => window.__capture.release());
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(() => new Promise((res) => {
  const sc = window.__game.scene; const all = []; sc.traverse((o) => all.push(o));
  const snap = () => all.map((o) => Array.from(o.matrixWorld.elements));
  const a = snap();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const c = snap(); let moved = 0; const byType = {}; const auto = { true: 0, false: 0 };
    all.forEach((o, i) => { auto[o.matrixAutoUpdate]++; if (a[i].some((v, k) => v !== c[i][k])) { moved++; const t = o.type + (o.name ? ':' + o.name : ''); byType[t] = (byType[t] ?? 0) + 1; } });
    res({ total: all.length, moved, auto, top: Object.entries(byType).sort((x, y) => y[1] - x[1]).slice(0, 8) });
  }));
}))));
await b.close();
