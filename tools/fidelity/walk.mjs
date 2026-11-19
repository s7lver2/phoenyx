// Paseo aleatorio por el nivel 0 con el jugador real: cuenta pasos dentro de paredes y parados. Uso: node walk.mjs new|old [seed] (old = ?collide=old)
import { chromium } from 'playwright-core';
const mode = process.argv[2] || 'new';
const b = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, args: ['--enable-gpu','--use-angle=default','--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 800, height: 450 } });
await ctx.addInitScript(() => localStorage.setItem('br-welcome', '1'));
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('pageerror', String(e)));
await p.goto(`http://localhost:5192/?capture${process.env.Q ? "&" + process.env.Q : ""}&seed=${process.argv[3] || 1}&god${mode === 'old' ? '&collide=old' : ''}`);
for (let i = 0; i < 100 && !(await p.evaluate(() => !!window.__capture?.ready)); i++) {
  const play = p.locator('button', { hasText: /^\s*PLAY\s*$/ }).first();
  if (await play.isVisible().catch(() => false)) await play.click().catch(() => {});
  await p.waitForTimeout(500);
}
const r = await p.evaluate(() => {
  const g = window.__game, pl = g.player, w = g.world;
  let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dbg = (() => { const cw = w.cw; const B = pl.cbody.constructor; const out = []; for (const x of [10.5, 40.5, 62.5, 63.5, 80.5, 100.5, 120.5]) { const bb = new B(x, 0, 37.5, 0.3, 1.8, 0); cw.moveXZ(bb, 0, 0); out.push([x, bb.a[0]]); } return [out, w.blockers?.length, w.maze.h, w.maze.open.constructor.name]; })();
  const c = new Proxy({ look: { x: 0, y: 0 }, move: { x: 0, y: 1, length() { return Math.hypot(this.x, this.y); } } }, { get: (t, k) => (k in t ? t[k] : false) });
  const t1 = (() => { pl.pos.set(30.75, 0, 30.75); pl.yaw = 0; c.move.x = 0; c.move.y = 1; const a = [pl.pos.x, pl.pos.z]; pl.update(1 / 60, c); return [a, pl.pos.x, pl.pos.z, pl.speed, pl.yaw, pl.frozen, pl.dead]; })();
  const CELLV = 1.5; let inside = 0, stuck = 0, dist = 0, frames = 0;
  for (let run = 0; run < 30; run++) {
    // un punto abierto al azar
    const m = w.maze; let i; do i = Math.floor(rnd() * m.w * m.h); while (!m.open[i]);
    pl.pos.set((i % m.w + 0.5) * CELLV, 0, (Math.floor(i / m.w) + 0.5) * CELLV);
    pl.falling = false; pl.fell = false; pl.ground = true; pl.velY = 0; pl.frozen = false; pl.dead = false; pl.fallT = 0;
    let yaw = rnd() * 6.28; pl.yaw = yaw;
    for (let f = 0; f < 600; f++) {
      if (f % 40 === 0) yaw += (rnd() - 0.5) * 3, pl.yaw = yaw;
      const x0 = pl.pos.x, z0 = pl.pos.z;
      c.move.x = 0.3 * Math.sin(f / 30); c.move.y = 1;
      pl.update(1 / 60, c); if (pl.pos.y < -1) { pl.pos.y = 0; pl.velY = 0; pl.falling = false; pl.ground = true; }
      const d = Math.hypot(pl.pos.x - x0, pl.pos.z - z0); dist += d; frames++;
      if (d < 0.01) stuck++;
      if (w.solid(pl.pos.x, pl.pos.z)) inside++;
    }
  }
  return { inside, stuck, dist: +dist.toFixed(1), frames, pos: [pl.pos.x, pl.pos.y, pl.pos.z], cellw: w.maze.w, speed: pl.speed, t1 };
});
console.log(mode, JSON.stringify(r));
await b.close();
