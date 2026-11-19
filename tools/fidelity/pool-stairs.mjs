// Escaleras de las Poolrooms: sube corriendo cada tramo y mide la altura alcanzada. Uso: node pool-stairs.mjs new|old [seed]
import { chromium } from 'playwright-core';
const mode = process.argv[2] || 'new';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 800, height: 450 } });
await ctx.addInitScript(() => localStorage.setItem('br-welcome', '1'));
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror', String(e)));
await p.goto(`http://localhost:5192/?capture&poolmap&seed=${process.argv[3] || 1}${mode === 'old' ? '&collide=old' : ''}`);
for (let i = 0; i < 200 && !(await p.evaluate(() => !!window.__capture?.ready)); i++) await p.waitForTimeout(500);
const r = await p.evaluate(() => {
  const g = window.__game, lv = g.pool, m = lv.map, C = 1.5;
  const c = new Proxy({ look: { x: 0, y: 0 }, run: true, move: { x: 0, y: 1, length() { return 1; }, lengthSq() { return 1; } } }, { get: (t, k) => (k in t ? t[k] : false) });
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const out = [];
  for (let i = 0; i < m.w * m.h && out.length < 12; i++) {
    if (m.ramp[i] !== 1 || m.layer?.[i]) continue;
    const [dx, dz] = D[m.dir[i]];
    const prev = i - dx - dz * m.w;
    if (m.ramp[prev] === 1 && m.dir[prev] === m.dir[i]) continue; // solo el primer tramo de cada escalera
    for (const dtv of [1 / 60, 1 / 20]) {
      const x = ((i % m.w) + 0.5) * C - dx * (C / 2 - 0.25), z = (Math.floor(i / m.w) + 0.5) * C - dz * (C / 2 - 0.25);
      const y0 = m.ya[i];
      lv.px = x; lv.pz = z; lv.py = y0; lv.vy = 0; lv.air = false; lv.swim = false; lv.lay = 0; lv.surf = lv.surf; lv.fx = lv.fz = 0; lv.speedK = 3;
      lv.yaw = Math.atan2(-dx, -dz); lv.pitch = 0;
      const pre = [lv.px, lv.py, lv.pz, lv.lay, lv.air, lv.swim, m.ramp[i], m.dir[i], x, z];
      const steps = Math.round(1.6 / dtv);
      for (let f = 0; f < steps; f++) lv.update(dtv, c);
      const top = m.yb[i];
      out.push({ pre, i, dt: +dtv.toFixed(3), y0: +y0.toFixed(2), top: +top.toFixed(2), y: +lv.py.toFixed(2), dist: +Math.hypot(lv.px - x, lv.pz - z).toFixed(2) });
    }
  }
  return out;
});
for (const o of r) console.log(JSON.stringify(o));
await b.close();
