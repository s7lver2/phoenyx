import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu','--use-angle=default','--ignore-gpu-blocklist'] });
for (const [name, port] of [['three', 5193], ['phoenyx', 5192]]) {
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(2500);
  if (port === 5192) { await page.getByText('CONTINUE', { exact: true }).click().catch(()=>{}); }
  await page.waitForTimeout(9000);
  await page.getByText('LATER', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `E:/tmp/menu-${name}.png` });
  console.log(name, JSON.stringify(await page.evaluate(() => { const c = document.querySelector('canvas'); const m = document.querySelector('.br-menu'); const cs = m && getComputedStyle(m); const root = document.querySelector('.br'); return { canvas: c && { cls: c.className, vis: getComputedStyle(c).visibility, op: getComputedStyle(c).opacity, disp: getComputedStyle(c).display }, menuBg: cs && cs.backgroundColor, rootBg: root && getComputedStyle(root).backgroundColor, screen: root && root.getAttribute('data-screen') }; })));
}
await b.close();
