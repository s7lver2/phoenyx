// Suelo: parches de altura (plano, rampa, peldaños) y cajas pisables, en su propia rejilla. `floor_at` elige por la altura de los pies:
// el suelo más alto que se alcanza de un paso, nunca el de otro piso de un hueco con niveles apilados.
use crate::character::{Body, GROUNDED, STEPPED};
use crate::grid::Grid;
use crate::World;

#[derive(Clone, Copy, Debug)]
pub enum FloorKind {
    /// Suelo plano a `y`.
    Flat(f32),
    /// Rampa: altura `y0` en el borde mínimo del eje y `y1` en el máximo (eje 0 = x, 1 = z).
    Ramp { y0: f32, y1: f32, axis: u8 },
    /// Peldaños de huella `tread` y alzada `rise`: la altura sube `rise` al cruzar cada huella, hasta `count`. `from_max`: se cuenta desde el borde máximo.
    Steps { y0: f32, rise: f32, tread: f32, count: u32, axis: u8, from_max: bool },
}

pub(crate) struct Floor {
    pub chunk: u32,
    pub alive: bool,
    pub min: [f32; 2],
    pub max: [f32; 2],
    pub kind: FloorKind,
}

impl Floor {
    #[inline]
    fn height(&self, x: f32, z: f32) -> Option<f32> {
        if x < self.min[0] || x > self.max[0] || z < self.min[1] || z > self.max[1] {
            return None;
        }
        Some(match self.kind {
            FloorKind::Flat(y) => y,
            FloorKind::Ramp { y0, y1, axis } => {
                let (p, a, b) = if axis == 0 { (x, self.min[0], self.max[0]) } else { (z, self.min[1], self.max[1]) };
                y0 + (y1 - y0) * ((p - a) / (b - a)).clamp(0.0, 1.0)
            }
            FloorKind::Steps { y0, rise, tread, count, axis, from_max } => {
                let (p, a, b) = if axis == 0 { (x, self.min[0], self.max[0]) } else { (z, self.min[1], self.max[1]) };
                let d = if from_max { b - p } else { p - a };
                y0 + rise * ((d / tread).ceil().clamp(0.0, count as f32))
            }
        })
    }
}

/// Estado de la rejilla de suelos (se guarda en `World`).
pub(crate) struct Floors {
    pub list: Vec<Floor>,
    pub grid: Grid,
}

impl Floors {
    pub fn new(cell: f32) -> Floors {
        Floors { list: Vec::new(), grid: Grid::new(cell) }
    }
}

impl World {
    pub fn add_floor(&mut self, chunk: u32, min: [f32; 2], max: [f32; 2], y: f32) {
        self.add_floor_kind(chunk, min, max, FloorKind::Flat(y));
    }
    pub fn add_ramp(&mut self, chunk: u32, min: [f32; 2], max: [f32; 2], y0: f32, y1: f32, axis: u8) {
        self.add_floor_kind(chunk, min, max, FloorKind::Ramp { y0, y1, axis });
    }
    #[allow(clippy::too_many_arguments)]
    pub fn add_steps(&mut self, chunk: u32, min: [f32; 2], max: [f32; 2], y0: f32, rise: f32, tread: f32, count: u32, axis: u8, from_max: bool) {
        self.add_floor_kind(chunk, min, max, FloorKind::Steps { y0, rise, tread, count, axis, from_max });
    }

    pub fn add_floor_kind(&mut self, chunk: u32, min: [f32; 2], max: [f32; 2], kind: FloorKind) {
        let id = self.floors.list.len() as u32;
        self.floors.list.push(Floor { chunk, alive: true, min, max, kind });
        self.floors.grid.insert(id, min, max);
    }

    pub(crate) fn remove_floors(&mut self, chunk: u32) {
        let mut any = false;
        for f in &mut self.floors.list {
            if f.alive && f.chunk == chunk {
                f.alive = false;
                any = true;
            }
        }
        if any {
            self.floors.list.retain(|f| f.alive);
            self.floors.grid.clear();
            for (i, f) in self.floors.list.iter().enumerate() {
                self.floors.grid.insert(i as u32, f.min, f.max);
            }
        }
    }

    /// Suelo de los parches (rejilla propia) bajo (x, z) que no pasa de `lim`.
    fn patch_floor(&self, x: f32, z: f32, lim: f32) -> Option<f32> {
        let mut best: Option<f32> = None;
        let fl = &self.floors;
        fl.grid.visit([x, z], [x, z], |id| {
            if let Some(h) = fl.list[id as usize].height(x, z) {
                if h <= lim && best.is_none_or(|b| h > b) {
                    best = Some(h);
                }
            }
        });
        best
    }

    fn box_floor(shapes: &[crate::Shape], x: f32, z: f32, lim: f32, mut best: Option<f32>) -> Option<f32> {
        for s in shapes {
            let (lo, hi) = s.aabb();
            if hi[1] <= lim && lo[0] <= x && hi[0] >= x && lo[2] <= z && hi[2] >= z && best.is_none_or(|b| hi[1] > b) {
                best = Some(hi[1]);
            }
        }
        best
    }

    /// El suelo más alto bajo (x, z) que no pasa de `feet + step_max` (parches de suelo y la cara superior de las cajas pisables).
    pub fn floor_at(&mut self, x: f32, z: f32, feet: f32, step_max: f32) -> Option<f32> {
        let lim = feet + step_max + 1e-4;
        let best = self.patch_floor(x, z, lim);
        let mut buf = std::mem::take(&mut self.scratch);
        self.query_aabb([x, feet - 64.0, z], [x, lim, z], &mut buf);
        let best = Self::box_floor(&buf, x, z, lim, best);
        self.scratch = buf;
        best
    }

    /// Como `floor_at`, pero las cajas salen de la última consulta de `move_xz` (ya hecha para este mismo cuerpo): sin otra búsqueda.
    pub(crate) fn floor_near(&self, x: f32, z: f32, feet: f32, step_max: f32) -> Option<f32> {
        let lim = feet + step_max + 1e-4;
        Self::box_floor(&self.scratch, x, z, lim, self.patch_floor(x, z, lim))
    }

    /// Un paso completo de personaje: XZ con contactos, subida de peldaño, pegado al suelo al bajar y gravedad/aterrizaje.
    /// `gravity` es la aceleración (positiva) hacia abajo. Devuelve banderas.
    pub fn move_capsule(&mut self, b: &mut Body, delta: [f32; 2], dt: f32, gravity: f32) -> u32 {
        let feet0 = b.pos[1];
        let mut flags = self.move_xz(b, delta);
        let (x, z) = (b.pos[0], b.pos[2]);
        if b.ground && b.vel_y <= 0.0 {
            // en el suelo: seguirlo (subir peldaños, bajar escaleras) mientras la diferencia quepa en un paso
            match self.floor_near(x, z, feet0, b.step_max) {
                Some(h) if h >= feet0 - b.step_max => {
                    if h > feet0 + 1e-3 {
                        flags |= STEPPED;
                    }
                    b.pos[1] = h;
                    b.vel_y = 0.0;
                }
                _ => b.ground = false, // sin suelo a un paso de los pies: se cae
            }
        }
        if !b.ground {
            b.vel_y -= gravity * dt;
            let y1 = b.pos[1] + b.vel_y * dt;
            // el suelo que se cruza en este paso: el más alto que no pasa de los pies de antes (+ un peldaño si sube)
            let from = b.pos[1];
            if b.vel_y <= 0.0 {
                if let Some(h) = self.floor_at(x, z, from, b.step_max.min(0.05)) {
                    if y1 <= h {
                        b.pos[1] = h;
                        b.vel_y = 0.0;
                        b.ground = true;
                    } else {
                        b.pos[1] = y1;
                    }
                } else {
                    b.pos[1] = y1;
                }
            } else {
                b.pos[1] = y1;
            }
        }
        if b.ground {
            flags |= GROUNDED;
        }
        flags
    }
}
