// Movimiento de personaje en XZ: pasos cortos (nunca más de medio radio) y salida de penetración por la normal del rasgo más cercano.
// Sin rechazar ejes enteros, una esquina no engancha: el empujón sale por la arista o el vértice y la velocidad tangente se conserva.
use crate::{Shape, World};

/// Cuerpo de un personaje: pies en `pos`, cilindro de radio `r` y alto `h`.
#[derive(Clone, Copy, Debug)]
pub struct Body {
    pub pos: [f32; 3],
    pub r: f32,
    pub h: f32,
    /// Lo que se puede subir de un paso: lo más bajo que eso no bloquea en XZ (lo pisa el suelo, ver `height`).
    pub step_max: f32,
    pub vel_y: f32,
    pub ground: bool,
}

impl Body {
    pub fn new(pos: [f32; 3], r: f32, h: f32) -> Body {
        Body { pos, r, h, step_max: 0.0, vel_y: 0.0, ground: false }
    }
}

pub const HIT_WALL: u32 = 1;
pub const GROUNDED: u32 = 2;
pub const STEPPED: u32 = 4;

/// Empuja el círculo (c, r) fuera de la caja alineada (min, max) en XZ. Devuelve la penetración y la normal, o None.
#[inline]
fn circle_box(c: [f32; 2], r: f32, mn: [f32; 2], mx: [f32; 2]) -> Option<(f32, [f32; 2])> {
    let (px, pz) = (c[0].clamp(mn[0], mx[0]), c[1].clamp(mn[1], mx[1]));
    let (dx, dz) = (c[0] - px, c[1] - pz);
    let d2 = dx * dx + dz * dz;
    if d2 > 1e-12 {
        if d2 >= r * r {
            return None;
        }
        let d = d2.sqrt();
        return Some((r - d, [dx / d, dz / d]));
    }
    // el centro está dentro de la caja: salir por la cara más cercana
    let l = c[0] - mn[0];
    let rr = mx[0] - c[0];
    let t = c[1] - mn[1];
    let b = mx[1] - c[1];
    let m = l.min(rr).min(t).min(b);
    Some(if m == l {
        (l + r, [-1.0, 0.0])
    } else if m == rr {
        (rr + r, [1.0, 0.0])
    } else if m == t {
        (t + r, [0.0, -1.0])
    } else {
        (b + r, [0.0, 1.0])
    })
}

/// Penetración del círculo contra una forma que cuente a la altura de los pies, o None.
#[inline]
fn push(s: &Shape, c: [f32; 2], r: f32, feet: f32, top: f32, step: f32) -> Option<(f32, [f32; 2])> {
    let (lo, hi) = s.aabb();
    // lo que cabe pisar (más bajo que el peldaño máximo) o queda por encima de la cabeza no bloquea
    if hi[1] <= feet + step || lo[1] >= top {
        return None;
    }
    match *s {
        Shape::Box { min, max } => circle_box(c, r, [min[0], min[2]], [max[0], max[2]]),
        Shape::BoxY { c: bc, half, yaw } => {
            let (sn, cs) = (yaw.sin(), yaw.cos());
            let (dx, dz) = (c[0] - bc[0], c[1] - bc[2]);
            // al marco local de la caja
            let l = [dx * cs - dz * sn, dx * sn + dz * cs];
            let (p, n) = circle_box(l, r, [-half[0], -half[2]], [half[0], half[2]])?;
            Some((p, [n[0] * cs + n[1] * sn, -n[0] * sn + n[1] * cs]))
        }
        Shape::Cyl { c: cc, r: cr, .. } => {
            let (dx, dz) = (c[0] - cc[0], c[1] - cc[2]);
            let d2 = dx * dx + dz * dz;
            let rr = r + cr;
            if d2 >= rr * rr {
                return None;
            }
            let d = d2.sqrt();
            Some(if d > 1e-6 { (rr - d, [dx / d, dz / d]) } else { (rr, [1.0, 0.0]) })
        }
    }
}

impl World {
    /// Mueve el cuerpo `delta` en XZ resolviendo contactos. Devuelve banderas (`HIT_WALL`).
    pub fn move_xz(&mut self, b: &mut Body, delta: [f32; 2]) -> u32 {
        let len = (delta[0] * delta[0] + delta[1] * delta[1]).sqrt();
        let (feet, top) = (b.pos[1], b.pos[1] + b.h);
        // una sola consulta para todo el movimiento: el cuerpo, ensanchado por lo que va a recorrer
        let m = b.r + len + 0.05;
        let mut buf = std::mem::take(&mut self.scratch);
        self.query_aabb([b.pos[0] - m, feet - b.step_max - 0.01, b.pos[2] - m], [b.pos[0] + m, top + 0.01, b.pos[2] + m], &mut buf);
        let steps = ((len / (b.r * 0.5)).ceil() as u32).max(1);
        let (sx, sz) = (delta[0] / steps as f32, delta[1] / steps as f32);
        let mut flags = 0;
        for _ in 0..steps {
            b.pos[0] += sx;
            b.pos[2] += sz;
            // varias pasadas: un empujón puede meter el cuerpo en otra forma (esquinas entre dos muros)
            for _ in 0..4 {
                let mut any = false;
                for s in &buf {
                    if let Some((pen, n)) = push(s, [b.pos[0], b.pos[2]], b.r, feet, top, b.step_max) {
                        b.pos[0] += n[0] * pen;
                        b.pos[2] += n[1] * pen;
                        any = true;
                        flags |= HIT_WALL;
                    }
                }
                if !any {
                    break;
                }
            }
        }
        self.scratch = buf;
        flags
    }
}
