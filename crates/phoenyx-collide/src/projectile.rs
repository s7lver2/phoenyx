// Proyectiles: esferas con gravedad, rozamiento y restitución que rebotan contra las formas y los suelos.
// La predicción de un arco usa exactamente esta función sobre una copia del estado (misma física que el lanzamiento real).
use crate::{Shape, World};

#[derive(Clone, Copy, Debug)]
pub struct Projectile {
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub r: f32,
    /// Fracción de la velocidad normal que se conserva al rebotar (0 = se queda, 1 = elástico).
    pub restitution: f32,
    /// Fracción de la velocidad tangente que se pierde en cada contacto.
    pub friction: f32,
    pub alive: bool,
    pub resting: bool,
}

impl Projectile {
    pub fn new(pos: [f32; 3], vel: [f32; 3], r: f32, restitution: f32, friction: f32) -> Projectile {
        Projectile { pos, vel, r, restitution, friction, alive: true, resting: false }
    }
}

/// Penetración de la esfera (p, r) en la forma: (profundidad, normal) o None.
fn sphere_push(s: &Shape, p: [f32; 3], r: f32) -> Option<(f32, [f32; 3])> {
    match *s {
        Shape::Box { min, max } => sphere_box(p, r, min, max),
        Shape::BoxY { c, half, yaw } => {
            let (sn, cs) = (yaw.sin(), yaw.cos());
            let (dx, dz) = (p[0] - c[0], p[2] - c[2]);
            let l = [dx * cs - dz * sn, p[1] - c[1], dx * sn + dz * cs];
            let (pen, n) = sphere_box(l, r, [-half[0], -half[1], -half[2]], half)?;
            Some((pen, [n[0] * cs + n[2] * sn, n[1], -n[0] * sn + n[2] * cs]))
        }
        Shape::Cyl { c, r: cr, h } => {
            let q = [p[0], p[1].clamp(c[1], c[1] + h), p[2]];
            let (dx, dz) = (p[0] - c[0], p[2] - c[2]);
            let d = (dx * dx + dz * dz).sqrt();
            let k = if d > cr { cr / d } else { 1.0 };
            let cp = [c[0] + dx * k, q[1], c[2] + dz * k];
            let v = [p[0] - cp[0], p[1] - cp[1], p[2] - cp[2]];
            let d2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
            if d2 >= r * r {
                return None;
            }
            if d2 > 1e-12 {
                let d = d2.sqrt();
                Some((r - d, [v[0] / d, v[1] / d, v[2] / d]))
            } else {
                Some((r, [1.0, 0.0, 0.0]))
            }
        }
    }
}

fn sphere_box(p: [f32; 3], r: f32, mn: [f32; 3], mx: [f32; 3]) -> Option<(f32, [f32; 3])> {
    let q = [p[0].clamp(mn[0], mx[0]), p[1].clamp(mn[1], mx[1]), p[2].clamp(mn[2], mx[2])];
    let v = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    let d2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if d2 > 1e-12 {
        if d2 >= r * r {
            return None;
        }
        let d = d2.sqrt();
        return Some((r - d, [v[0] / d, v[1] / d, v[2] / d]));
    }
    // el centro dentro de la caja: salir por la cara más cercana
    let mut best = (f32::INFINITY, [0.0; 3]);
    for a in 0..3 {
        for (dist, s) in [(p[a] - mn[a], -1.0), (mx[a] - p[a], 1.0)] {
            if dist < best.0 {
                let mut n = [0.0; 3];
                n[a] = s;
                best = (dist, n);
            }
        }
    }
    Some((best.0 + r, best.1))
}

impl World {
    /// Avanza los proyectiles `dt` segundos. `gravity` positiva hacia abajo.
    pub fn step_projectiles(&mut self, ps: &mut [Projectile], dt: f32, gravity: f32) {
        let mut buf = std::mem::take(&mut self.scratch);
        for p in ps.iter_mut().filter(|p| p.alive && !p.resting) {
            p.vel[1] -= gravity * dt;
            let d = [p.vel[0] * dt, p.vel[1] * dt, p.vel[2] * dt];
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            let m = p.r + len + 0.05;
            self.query_aabb([p.pos[0] - m, p.pos[1] - m, p.pos[2] - m], [p.pos[0] + m, p.pos[1] + m, p.pos[2] + m], &mut buf);
            // pasos de medio radio como mucho: no atraviesa nada fino
            let steps = ((len / (p.r * 0.5)).ceil() as u32).max(1);
            let sd = [d[0] / steps as f32, d[1] / steps as f32, d[2] / steps as f32];
            for _ in 0..steps {
                p.pos = [p.pos[0] + sd[0], p.pos[1] + sd[1], p.pos[2] + sd[2]];
                let mut contact: Option<[f32; 3]> = None;
                for s in &buf {
                    if let Some((pen, n)) = sphere_push(s, p.pos, p.r) {
                        p.pos = [p.pos[0] + n[0] * pen, p.pos[1] + n[1] * pen, p.pos[2] + n[2] * pen];
                        contact = Some(n);
                    }
                }
                // suelo: el más alto que no pasa de la parte baja de la esfera (+ lo que ha bajado en este sub-paso)
                if let Some(h) = self.floor_at(p.pos[0], p.pos[2], p.pos[1] - p.r, p.r * 0.5 + sd[1].abs()) {
                    if p.pos[1] - p.r < h {
                        p.pos[1] = h + p.r;
                        contact = Some([0.0, 1.0, 0.0]);
                    }
                }
                if let Some(n) = contact {
                    let vn = p.vel[0] * n[0] + p.vel[1] * n[1] + p.vel[2] * n[2];
                    if vn < 0.0 {
                        let t = 1.0 - p.friction;
                        // normal: rebote; tangente: rozamiento
                        let vt = [p.vel[0] - vn * n[0], p.vel[1] - vn * n[1], p.vel[2] - vn * n[2]];
                        p.vel = [vt[0] * t - p.restitution * vn * n[0], vt[1] * t - p.restitution * vn * n[1], vt[2] * t - p.restitution * vn * n[2]];
                        // en reposo: casi sin velocidad y apoyado en el suelo
                        let sp2 = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1] + p.vel[2] * p.vel[2];
                        if n[1] > 0.7 && sp2 < 0.25 {
                            p.vel = [0.0; 3];
                            p.resting = true;
                            break;
                        }
                    }
                }
            }
        }
        self.scratch = buf;
    }
}
