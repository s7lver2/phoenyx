import { chromium } from 'playwright-core';
import fs from 'node:fs';
const dsf = Number(process.argv[2] ?? 1.25);
const sc = JSON.parse(fs.readFileSync('E:/backrooms/client/src/dev/scenes.json', 'utf8')).find((x) => x.id === 'level0-inicio');
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu','--use-angle=default','--ignore-gpu-blocklist'] });
for (const [r, port] of [['three', 5193], ['phoenyx', 5192]]) {
  const page = await (await b.newContext({ viewport: { width: 1600, height: 778 }, deviceScaleFactor: dsf })).newPage();
  await page.goto(`http://localhost:${port}/?${sc.query.replaceAll('@R', r)}&preset=high`);
  await page.waitForTimeout(2000);
  await page.getByText('CONTINUE', { exact: true }).click().catch(() => {});
  let clicked = false;
  while (!(await page.evaluate(() => !!window.__capture?.ready))) { await page.getByText('LATER', { exact: true }).first().click({ timeout: 300 }).catch(() => {}); const p = page.locator('button', { hasText: /^\s*PLAY\s*$/ }).first(); if (!clicked && (await p.isVisible().catch(() => false))) (await p.click(), (clicked = true)); await page.waitForTimeout(250); }
  if (sc.pose) await page.evaluate((p) => window.__capture.setPose(...p), sc.pose);
  await page.evaluate(() => window.__capture.advance(120));
  await page.waitForTimeout(300);
  console.log(r, JSON.stringify(await page.evaluate(() => { const R = window.__game.renderer; const v = new (R.getDrawingBufferSize.length >= 0 ? Object : Object)(); const o = { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; return this; }, floor() { return this; } }; R.getDrawingBufferSize(o); const c = R.domElement; return { buf: [o.x, o.y], canvas: [c.width, c.height], css: [c.clientWidth, c.clientHeight], pr: R.getPixelRatio(), dpr: devicePixelRatio }; })));
  await page.screenshot({ path: `E:/tmp/dpr-${r}.png` });
  await page.close();
}
await b.close();
