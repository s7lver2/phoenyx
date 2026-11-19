// Raycast: recorrido DDA de la rejilla (formas), de cada bloque de celdas y de los suelos planos/rampas por muestreo analítico.
use crate::{Shape, World};

#[derive(Clone, Copy, Debug, Default)]
pub struct Hit {
    pub t: f32,
    pub normal: [f32; 3],
}

/// Rayo contra caja alineada (slab). Devuelve (t, normal) con t >= 0.
fn ray_box(o: [f32; 3], d: [f32; 3], mn: [f32; 3], mx: [f32; 3]) -> Option<(f32, [f32; 3])> {
    let (mut t0, mut t1) = (0.0f32, f32::INFINITY);
    let mut n = [0.0; 3];
    let mut nn = [0.0; 3];
    for a in 0..3 {
        if d[a].abs() < 1e-9 {
            if o[a] < mn[a] || o[a] > mx[a] {
                return None;
            }
            continue;
        }
        let (mut ta, mut tb) = ((mn[a] - o[a]) / d[a], (mx[a] - o[a]) / d[a]);
        let mut s = -1.0;
        if ta > tb {
            std::mem::swap(&mut ta, &mut tb);
            s = 1.0;
        }
        if ta > t0 {
            t0 = ta;
            n = [0.0; 3];
            n[a] = s;
        }
        if tb < t1 {
            t1 = tb;
        }
        if t0 > t1 {
            return None;
        }
        nn = n;
    }
    Some((t0, nn))
}

pub(crate) fn ray_shape(s: &Shape, o: [f32; 3], d: [f32; 3]) -> Option<(f32, [f32; 3])> {
    match *s {
        Shape::Box { min, max } => ray_box(o, d, min, max),
        Shape::BoxY { c, half, yaw } => {
            let (sn, cs) = (yaw.sin(), yaw.cos());
            let to = |v: [f32; 3]| [v[0] * cs - v[2] * sn, v[1], v[0] * sn + v[2] * cs];
            let lo = to([o[0] - c[0], o[1] - c[1], o[2] - c[2]]);
            let (t, n) = ray_box(lo, to(d), [-half[0], -half[1], -half[2]], half)?;
            Some((t, [n[0] * cs + n[2] * sn, n[1], -n[0] * sn + n[2] * cs]))
        }
        Shape::Cyl { c, r, h } => {
            // lateral: círculo en XZ; tapas: planos
            let (ox, oz) = (o[0] - c[0], o[2] - c[2]);
            let a = d[0] * d[0] + d[2] * d[2];
            let mut best: Option<(f32, [f32; 3])> = None;
            if a > 1e-12 {
                let bq = ox * d[0] + oz * d[2];
                let cq = ox * ox + oz * oz - r * r;
                let disc = bq * bq - a * cq;
                if disc >= 0.0 {
                    let t = (-bq - disc.sqrt()) / a;
                    let y = o[1] + d[1] * t;
                    if t >= 0.0 && y >= c[1] && y <= c[1] + h {
                        best = Some((t, [(ox + d[0] * t) / r, 0.0, (oz + d[2] * t) / r]));
                    }
                }
            }
            if d[1].abs() > 1e-9 {
                for (py, ny) in [(c[1] + h, 1.0), (c[1], -1.0)] {
                    let t = (py - o[1]) / d[1];
                    let (x, z) = (ox + d[0] * t, oz + d[2] * t);
                    if t >= 0.0 && x * x + z * z <= r * r && best.is_none_or(|b| t < b.0) {
                        best = Some((t, [0.0, ny, 0.0]));
                    }
                }
            }
            best
        }
    }
}

impl World {
    /// Primer impacto del rayo (origen `o`, dirección unitaria `d`) hasta `max`. Escribe `hit` y devuelve true si da en algo.
    pub fn raycast(&mut self, o: [f32; 3], d: [f32; 3], max: f32, hit: &mut Hit) -> bool {
        let mut best = (max, [0.0f32; 3]);
        let mut found = false;
        // formas de la rejilla: DDA en XZ, sin repetir (sello por época)
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.epoch = 1;
        }
        {
            let (epoch, cols, stamp) = (self.epoch, &self.cols, &mut self.stamp);
            let (bt, bn, fnd) = (&mut best.0, &mut best.1, &mut found);
            self.grid.visit_ray([o[0], o[2]], [d[0], d[2]], max, |id| {
                let i = id as usize;
                if stamp[i] != epoch && cols[i].alive {
                    stamp[i] = epoch;
                    if let Some((t, n)) = ray_shape(&cols[i].shape, o, d) {
                        if t < *bt {
                            (*bt, *bn, *fnd) = (t, n, true);
                        }
                    }
                }
                *bt
            });
        }
        // bloques de celdas: se prueban como cajas con la consulta por segmento (los bloques son pocos y el recorrido es corto)
        let end = [o[0] + d[0] * best.0, o[1] + d[1] * best.0, o[2] + d[2] * best.0];
        let (mn, mx) = ([o[0].min(end[0]), o[1].min(end[1]), o[2].min(end[2])], [o[0].max(end[0]), o[1].max(end[1]), o[2].max(end[2])]);
        if !self.cells.is_empty() {
            let mut buf = std::mem::take(&mut self.scratch);
            self.query_cells_only(mn, mx, &mut buf);
            for s in &buf {
                if let Some((t, n)) = ray_shape(s, o, d) {
                    if t < best.0 {
                        (best.0, best.1, found) = (t, n, true);
                    }
                }
            }
            self.scratch = buf;
        }
        if found {
            *hit = Hit { t: best.0, normal: best.1 };
        }
        found
    }
}
