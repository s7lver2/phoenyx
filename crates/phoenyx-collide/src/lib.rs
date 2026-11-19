// Colision cinematica de Phoenyx: rejilla hash, formas simples, movimiento de personaje, suelo/escaleras, proyectiles y raycast.
// Sin asignaciones en el camino caliente: los buffers de trabajo viven en `World` y se reutilizan.
pub mod character;
pub mod grid;
pub mod height;
pub mod projectile;
pub mod ray;
pub mod shapes;

use grid::Grid;
use height::Floors;
pub use height::FloorKind;
pub use character::{Body, GROUNDED, HIT_WALL, STEPPED};
pub use projectile::Projectile;
pub use ray::Hit;
pub use shapes::{Shape, V3};

/// Un bloque de celdas sólidas (1 bit por celda) del laberinto de un nivel.
struct Cells {
    chunk: u32,
    alive: bool,
    origin: [f32; 2],
    cell: f32,
    w: u32,
    h: u32,
    bits: Vec<u8>,
    y0: f32,
    y1: f32,
}

struct Col {
    chunk: u32,
    alive: bool,
    shape: Shape,
}

pub struct World {
    grid: Grid,
    cols: Vec<Col>,
    cells: Vec<Cells>,
    stamp: Vec<u32>,
    epoch: u32,
    dead: usize,
    scratch: Vec<Shape>,
    pub(crate) floors: Floors,
}

pub type ColId = u32;

impl World {
    pub fn new(cell: f32) -> World {
        World { grid: Grid::new(cell), cols: Vec::new(), cells: Vec::new(), stamp: Vec::new(), epoch: 0, dead: 0, scratch: Vec::new(), floors: Floors::new(cell) }
    }

    fn add(&mut self, chunk: u32, shape: Shape) -> ColId {
        let (mn, mx) = shape.aabb();
        let id = self.cols.len() as u32;
        self.cols.push(Col { chunk, alive: true, shape });
        self.stamp.push(0);
        self.grid.insert(id, [mn[0], mn[2]], [mx[0], mx[2]]);
        id
    }

    pub fn add_box(&mut self, chunk: u32, min: V3, max: V3) -> ColId {
        self.add(chunk, Shape::Box { min, max })
    }
    pub fn add_box_y(&mut self, chunk: u32, c: V3, half: V3, yaw: f32) -> ColId {
        self.add(chunk, Shape::BoxY { c, half, yaw })
    }
    pub fn add_cylinder(&mut self, chunk: u32, c: V3, r: f32, h: f32) -> ColId {
        self.add(chunk, Shape::Cyl { c, r, h })
    }

    /// Celdas sólidas: `bits` va por filas (z) y columnas (x), 1 bit por celda, LSB primero. Ocupan de `y0` a `y1`.
    #[allow(clippy::too_many_arguments)]
    pub fn add_cells(&mut self, chunk: u32, origin: [f32; 2], cell: f32, w: u32, h: u32, bits: &[u8], y0: f32, y1: f32) -> u32 {
        self.cells.push(Cells { chunk, alive: true, origin, cell, w, h, bits: bits.to_vec(), y0, y1 });
        (self.cells.len() - 1) as u32
    }

    /// Cambia una celda de un bloque (puertas que se abren y se cierran, decorados, el ascensor).
    pub fn set_cell(&mut self, block: u32, x: u32, z: u32, solid: bool) {
        if let Some(c) = self.cells.get_mut(block as usize) {
            if x < c.w && z < c.h {
                let bit = (z * c.w + x) as usize;
                if solid {
                    c.bits[bit >> 3] |= 1 << (bit & 7);
                } else {
                    c.bits[bit >> 3] &= !(1 << (bit & 7));
                }
            }
        }
    }

    /// Quita todo lo de un trozo. La rejilla se reconstruye cuando lo muerto pasa de la mitad.
    pub fn remove_chunk(&mut self, chunk: u32) {
        self.remove_floors(chunk);
        for c in &mut self.cols {
            if c.alive && c.chunk == chunk {
                c.alive = false;
                self.dead += 1;
            }
        }
        for c in &mut self.cells {
            if c.chunk == chunk {
                c.alive = false;
            }
        }
        if self.dead * 2 > self.cols.len() {
            self.compact();
        }
    }

    fn compact(&mut self) {
        self.cols.retain(|c| c.alive);
        self.stamp.clear();
        self.stamp.resize(self.cols.len(), 0);
        self.dead = 0;
        self.grid.clear();
        for (i, c) in self.cols.iter().enumerate() {
            let (mn, mx) = c.shape.aabb();
            self.grid.insert(i as u32, [mn[0], mn[2]], [mx[0], mx[2]]);
        }
    }

    /// Las formas que tocan la caja (min, max), sin repetir. `out` se vacía antes (reutilízalo: no asigna si ya tiene capacidad).
    pub fn query_aabb(&mut self, min: V3, max: V3, out: &mut Vec<Shape>) {
        out.clear();
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.stamp.iter_mut().for_each(|s| *s = 0);
            self.epoch = 1;
        }
        let (epoch, cols, stamp) = (self.epoch, &self.cols, &mut self.stamp);
        self.grid.visit([min[0], min[2]], [max[0], max[2]], |id| {
            let i = id as usize;
            if stamp[i] == epoch || !cols[i].alive {
                return;
            }
            stamp[i] = epoch;
            let (a, b) = cols[i].shape.aabb();
            if a[1] <= max[1] && b[1] >= min[1] && a[0] <= max[0] && b[0] >= min[0] && a[2] <= max[2] && b[2] >= min[2] {
                out.push(cols[i].shape);
            }
        });
        self.append_cells(min, max, out);
    }

    /// Solo las celdas sólidas de los bloques que tocan la caja (para el raycast).
    pub fn query_cells_only(&self, min: V3, max: V3, out: &mut Vec<Shape>) {
        out.clear();
        self.append_cells(min, max, out);
    }

    fn append_cells(&self, min: V3, max: V3, out: &mut Vec<Shape>) {
        for c in self.cells.iter().filter(|c| c.alive && c.y0 <= max[1] && c.y1 >= min[1]) {
            let lo = |v: f32, o: f32| ((v - o) / c.cell).floor().max(0.0) as u32;
            let hi = |v: f32, o: f32, n: u32| (((v - o) / c.cell).floor() + 1.0).clamp(0.0, n as f32) as u32;
            let (x0, x1, z0, z1) = (lo(min[0], c.origin[0]), hi(max[0], c.origin[0], c.w), lo(min[2], c.origin[1]), hi(max[2], c.origin[1], c.h));
            for z in z0..z1 {
                for x in x0..x1 {
                    let bit = (z * c.w + x) as usize;
                    if c.bits[bit >> 3] >> (bit & 7) & 1 == 1 {
                        let (px, pz) = (c.origin[0] + x as f32 * c.cell, c.origin[1] + z as f32 * c.cell);
                        out.push(Shape::Box { min: [px, c.y0, pz], max: [px + c.cell, c.y1, pz + c.cell] });
                    }
                }
            }
        }
    }
}
