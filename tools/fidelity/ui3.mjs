import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu','--use-angle=default','--ignore-gpu-blocklist'] });
for (const [name, port, nogpu] of [['ask', 5192, false], ['none', 5192, true], ['three', 5193, false]]) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  if (nogpu) await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(3000);
  console.log('==', name, '\n' + (await page.innerText('body')).slice(0, 260));
  await page.screenshot({ path: `E:/tmp/gn-${name}.png` });
  if (name === 'ask') { await page.getByText('CONTINUE', { exact: true }).click(); await page.waitForTimeout(2500); console.log('-- tras continuar:', (await page.innerText('body')).slice(0, 60).replace(/\n/g, ' ')); }
  await ctx.close();
}
await b.close();
