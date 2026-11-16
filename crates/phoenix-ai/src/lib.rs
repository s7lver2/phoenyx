//! Base de IA de Phoenix: solo primitivas, sin algoritmos de comportamiento.
//! El juego decide qué hace cada entidad; aquí vive lo que es caro o debe ser determinista:
//! números aleatorios con semilla, navegación en rejilla y percepción.
use std::collections::BinaryHeap;
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

/// Generador PCG32: determinista, mismo resultado en servidor y cliente con la misma semilla.
#[wasm_bindgen]
pub struct Rng {
    s: u64,
}

#[wasm_bindgen]
impl Rng {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> Rng {
        let mut r = Rng { s: (seed as u64) ^ 0x853c49e6748fea9b };
        r.u32();
        r
    }
    /// Entero de 32 bits.
    pub fn u32(&mut self) -> u32 {
        let o = self.s;
        self.s = o.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let x = (((o >> 18) ^ o) >> 27) as u32;
        x.rotate_right((o >> 59) as u32)
    }
    /// Real en [0, 1).
    pub fn next(&mut self) -> f32 {
        (self.u32() >> 8) as f32 / 16777216.0
    }
    /// Real en [a, b).
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.next()
    }
    /// Entero en [0, n).
    pub fn below(&mut self, n: u32) -> u32 {
        ((self.u32() as u64 * n as u64) >> 32) as u32
    }
}

#[derive(Copy, Clone, PartialEq)]
struct Node(f32, u32);
impl Eq for Node {}
impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// Rejilla de navegación: celdas libres u ocupadas, cuatro vecinos. Reutiliza sus buffers.
#[wasm_bindgen]
pub struct Grid {
    w: i32,
    h: i32,
    cell: f32,
    solid: Vec<u8>,
    dist: Vec<i32>,
    g: Vec<f32>,
    from: Vec<i32>,
    queue: Vec<u32>,
    path: Vec<f32>,
}

#[wasm_bindgen]
impl Grid {
    /// `cell` = lado de celda en metros.
    #[wasm_bindgen(constructor)]
    pub fn new(w: u32, h: u32, cell: f32) -> Grid {
        let n = (w * h) as usize;
        Grid { w: w as i32, h: h as i32, cell, solid: vec![0; n], dist: vec![-1; n], g: vec![0.0; n], from: vec![-1; n], queue: Vec::with_capacity(n), path: Vec::new() }
    }
    pub fn set_solid(&mut self, x: u32, y: u32, v: bool) {
        if (x as i32) < self.w && (y as i32) < self.h {
            self.solid[(y as i32 * self.w + x as i32) as usize] = v as u8;
        }
    }
    /// Carga todas las celdas de golpe (1 = ocupada), fila a fila.
    pub fn load(&mut self, data: &[u8]) {
        let n = self.solid.len().min(data.len());
        self.solid[..n].copy_from_slice(&data[..n]);
    }
    pub fn is_solid(&self, x: i32, y: i32) -> bool {
        x < 0 || y < 0 || x >= self.w || y >= self.h || self.solid[(y * self.w + x) as usize] != 0
    }
    /// Celda que contiene el punto del mundo.
    pub fn cell_x(&self, x: f32) -> i32 {
        (x / self.cell).floor() as i32
    }
    pub fn cell_y(&self, z: f32) -> i32 {
        (z / self.cell).floor() as i32
    }

    /// Mapa de distancias en celdas desde (x, y) (BFS). -1 = inalcanzable. Se lee con `dist_at`.
    /// `limit` corta la búsqueda (0 = sin límite).
    pub fn flood(&mut self, x: i32, y: i32, limit: u32) {
        self.dist.fill(-1);
        self.queue.clear();
        if self.is_solid(x, y) {
            return;
        }
        let s = (y * self.w + x) as usize;
        self.dist[s] = 0;
        self.queue.push(s as u32);
        let mut i = 0;
        while i < self.queue.len() {
            let c = self.queue[i] as i32;
            i += 1;
            let d = self.dist[c as usize];
            if limit > 0 && d as u32 >= limit {
                continue;
            }
            let (cx, cy) = (c % self.w, c / self.w);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (cx + dx, cy + dy);
                if self.is_solid(nx, ny) {
                    continue;
                }
                let n = (ny * self.w + nx) as usize;
                if self.dist[n] < 0 {
                    self.dist[n] = d + 1;
                    self.queue.push(n as u32);
                }
            }
        }
    }
    pub fn dist_at(&self, x: i32, y: i32) -> i32 {
        if x < 0 || y < 0 || x >= self.w || y >= self.h { -1 } else { self.dist[(y * self.w + x) as usize] }
    }
    /// Celda vecina que más se acerca al origen del último `flood` (para huir: úsala al revés con `flee`).
    /// Devuelve `y * ancho + x`, o -1 si no hay.
    pub fn descend(&self, x: i32, y: i32) -> i32 {
        let mut best = self.dist_at(x, y);
        let mut out = -1;
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let d = self.dist_at(x + dx, y + dy);
            if d >= 0 && (best < 0 || d < best) {
                best = d;
                out = (y + dy) * self.w + x + dx;
            }
        }
        out
    }
    /// Igual que `descend` pero hacia donde más se aleja.
    pub fn flee(&self, x: i32, y: i32) -> i32 {
        let mut best = self.dist_at(x, y);
        let mut out = -1;
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let d = self.dist_at(x + dx, y + dy);
            if d > best {
                best = d;
                out = (y + dy) * self.w + x + dx;
            }
        }
        out
    }

    /// A* entre dos celdas. Deja el camino (centros de celda, en metros, `[x, z, x, z, …]`)
    /// en `path()`; devuelve el número de puntos (0 si no hay ruta). Con `smooth` quita puntos
    /// intermedios cuando hay línea de visión directa.
    pub fn astar(&mut self, ax: i32, ay: i32, bx: i32, by: i32, smooth: bool) -> u32 {
        self.path.clear();
        if self.is_solid(ax, ay) || self.is_solid(bx, by) {
            return 0;
        }
        self.g.fill(f32::INFINITY);
        self.from.fill(-1);
        let (s, t) = ((ay * self.w + ax) as u32, (by * self.w + bx) as u32);
        let mut open = BinaryHeap::new();
        self.g[s as usize] = 0.0;
        open.push(Node(0.0, s));
        while let Some(Node(_, c)) = open.pop() {
            if c == t {
                break;
            }
            let (cx, cy) = (c as i32 % self.w, c as i32 / self.w);
            let gc = self.g[c as usize];
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (cx + dx, cy + dy);
                if self.is_solid(nx, ny) {
                    continue;
                }
                let n = (ny * self.w + nx) as usize;
                if gc + 1.0 < self.g[n] {
                    self.g[n] = gc + 1.0;
                    self.from[n] = c as i32;
                    let hh = ((nx - bx).abs() + (ny - by).abs()) as f32;
                    open.push(Node(gc + 1.0 + hh, n as u32));
                }
            }
        }
        if self.from[t as usize] < 0 && s != t {
            return 0;
        }
        let mut cells = vec![t as i32];
        let mut c = t as i32;
        while c != s as i32 {
            c = self.from[c as usize];
            cells.push(c);
        }
        cells.reverse();
        let pts: Vec<(f32, f32)> = cells.iter().map(|&c| (((c % self.w) as f32 + 0.5) * self.cell, ((c / self.w) as f32 + 0.5) * self.cell)).collect();
        let mut i = 0;
        while i < pts.len() {
            self.path.push(pts[i].0);
            self.path.push(pts[i].1);
            if !smooth {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            for k in (i + 1..pts.len()).rev() {
                if self.sees(pts[i].0, pts[i].1, pts[k].0, pts[k].1) {
                    j = k;
                    break;
                }
            }
            i = j;
        }
        (self.path.len() / 2) as u32
    }
    pub fn path(&self) -> Vec<f32> {
        self.path.clone()
    }

    /// Línea de visión entre dos puntos del mundo (recorrido de celdas, DDA).
    pub fn sees(&self, ax: f32, az: f32, bx: f32, bz: f32) -> bool {
        let (dx, dz) = (bx - ax, bz - az);
        let steps = ((dx.abs().max(dz.abs()) / self.cell) * 2.0).ceil().max(1.0) as i32;
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            if self.is_solid(self.cell_x(ax + dx * t), self.cell_y(az + dz * t)) {
                return false;
            }
        }
        true
    }
}

/// ¿Está el punto dentro del cono (dirección unitaria, `cos_min` = coseno del semiángulo)?
#[wasm_bindgen]
pub fn in_cone(px: f32, pz: f32, tx: f32, tz: f32, dx: f32, dz: f32, range: f32, cos_min: f32) -> bool {
    let (x, z) = (tx - px, tz - pz);
    let d2 = x * x + z * z;
    d2 <= range * range && d2 > 1e-12 && (x * dx + z * dz) > d2.sqrt() * cos_min
}

/// ¿Oye un ruido de radio `r` a esa distancia, dada la agudeza del oído?
#[wasm_bindgen]
pub fn hears(px: f32, pz: f32, nx: f32, nz: f32, r: f32, hearing: f32) -> bool {
    let (x, z) = (nx - px, nz - pz);
    x * x + z * z < (r * hearing) * (r * hearing)
}

/// Hash espacial uniforme para «quién está cerca»: se reconstruye cada tick sin reservar memoria.
#[wasm_bindgen]
pub struct Near {
    cell: f32,
    w: i32,
    h: i32,
    start: Vec<u32>,
    items: Vec<u32>,
    ids: Vec<u32>,
    xs: Vec<f32>,
    zs: Vec<f32>,
    out: Vec<u32>,
}

#[wasm_bindgen]
impl Near {
    #[wasm_bindgen(constructor)]
    pub fn new(world_w: f32, world_h: f32, cell: f32) -> Near {
        let (w, h) = ((world_w / cell).ceil() as i32 + 1, (world_h / cell).ceil() as i32 + 1);
        Near { cell, w, h, start: vec![0; (w * h) as usize + 1], items: vec![], ids: vec![], xs: vec![], zs: vec![], out: vec![] }
    }
    /// Reconstruye con posiciones `[x, z, x, z, …]`; el id de cada una es su índice.
    pub fn rebuild(&mut self, pos: &[f32]) {
        let n = pos.len() / 2;
        self.xs.clear();
        self.zs.clear();
        self.ids.clear();
        self.start.fill(0);
        for i in 0..n {
            self.xs.push(pos[2 * i]);
            self.zs.push(pos[2 * i + 1]);
            let c = self.slot(pos[2 * i], pos[2 * i + 1]);
            self.ids.push(c as u32);
            self.start[c + 1] += 1;
        }
        for c in 0..self.start.len() - 1 {
            self.start[c + 1] += self.start[c];
        }
        self.items.clear();
        self.items.resize(n, 0);
        let mut fill = self.start.clone();
        for i in 0..n {
            let c = self.ids[i] as usize;
            self.items[fill[c] as usize] = i as u32;
            fill[c] += 1;
        }
    }
    fn slot(&self, x: f32, z: f32) -> usize {
        let cx = ((x / self.cell) as i32).clamp(0, self.w - 1);
        let cz = ((z / self.cell) as i32).clamp(0, self.h - 1);
        (cz * self.w + cx) as usize
    }
    /// Índices a menos de `r` metros de (x, z).
    pub fn query(&mut self, x: f32, z: f32, r: f32) -> Vec<u32> {
        self.out.clear();
        let (x0, x1) = ((((x - r) / self.cell) as i32).max(0), (((x + r) / self.cell) as i32).min(self.w - 1));
        let (z0, z1) = ((((z - r) / self.cell) as i32).max(0), (((z + r) / self.cell) as i32).min(self.h - 1));
        for cz in z0..=z1 {
            for cx in x0..=x1 {
                let c = (cz * self.w + cx) as usize;
                for k in self.start[c]..self.start[c + 1] {
                    let i = self.items[k as usize] as usize;
                    let (dx, dz) = (self.xs[i] - x, self.zs[i] - z);
                    if dx * dx + dz * dz <= r * r {
                        self.out.push(i as u32);
                    }
                }
            }
        }
        self.out.clone()
    }
}

/// Reloj de paso fijo: convierte el tiempo real en ticks enteros (determinista; tope anti-espiral).
#[wasm_bindgen]
pub struct Clock {
    step: f32,
    acc: f32,
    max_ticks: u32,
    tick: u64,
}

#[wasm_bindgen]
impl Clock {
    #[wasm_bindgen(constructor)]
    pub fn new(hz: f32, max_ticks: u32) -> Clock {
        Clock { step: 1.0 / hz, acc: 0.0, max_ticks, tick: 0 }
    }
    /// Suma `dt` segundos y devuelve cuántos ticks hay que simular ahora.
    pub fn advance(&mut self, dt: f32) -> u32 {
        self.acc += dt.max(0.0);
        let n = ((self.acc / self.step) as u32).min(self.max_ticks);
        self.acc = if n == self.max_ticks { 0.0 } else { self.acc - n as f32 * self.step };
        self.tick += n as u64;
        n
    }
    pub fn step(&self) -> f32 {
        self.step
    }
    /// Fracción hasta el siguiente tick (para interpolar el dibujo).
    pub fn alpha(&self) -> f32 {
        self.acc / self.step
    }
    pub fn tick(&self) -> f64 {
        self.tick as f64
    }
}

/// Almacén de entidades en columnas (SoA): ids con generación, columnas f32 contiguas por campo.
/// El juego define qué significa cada columna (x, z, yaw, hp, temporizadores…).
#[wasm_bindgen]
pub struct Store {
    cols: usize,
    data: Vec<f32>,
    gens: Vec<u32>,
    alive: Vec<u8>,
    free: Vec<u32>,
    live: Vec<u32>,
}

#[wasm_bindgen]
impl Store {
    #[wasm_bindgen(constructor)]
    pub fn new(capacity: u32, cols: u32) -> Store {
        let (c, k) = (capacity as usize, cols as usize);
        Store { cols: k, data: vec![0.0; c * k], gens: vec![0; c], alive: vec![0; c], free: (0..capacity).rev().collect(), live: vec![] }
    }
    /// Crea una entidad; devuelve `generación << 20 | índice` (u32::MAX si está lleno).
    pub fn spawn(&mut self) -> u32 {
        match self.free.pop() {
            Some(i) => {
                let i = i as usize;
                self.alive[i] = 1;
                self.data[i * self.cols..(i + 1) * self.cols].fill(0.0);
                (self.gens[i] << 20) | i as u32
            }
            None => u32::MAX,
        }
    }
    pub fn despawn(&mut self, id: u32) {
        if self.valid(id) {
            let i = (id & 0xFFFFF) as usize;
            self.alive[i] = 0;
            self.gens[i] = (self.gens[i] + 1) & 0xFFF;
            self.free.push(i as u32);
        }
    }
    pub fn valid(&self, id: u32) -> bool {
        let i = (id & 0xFFFFF) as usize;
        i < self.alive.len() && self.alive[i] == 1 && self.gens[i] == id >> 20
    }
    pub fn get(&self, id: u32, col: u32) -> f32 {
        self.data[(id & 0xFFFFF) as usize * self.cols + col as usize]
    }
    pub fn set(&mut self, id: u32, col: u32, v: f32) {
        self.data[(id & 0xFFFFF) as usize * self.cols + col as usize] = v;
    }
    /// Índices vivos (para iterar sin recorrer los huecos).
    pub fn alive_ids(&mut self) -> Vec<u32> {
        self.live.clear();
        for (i, &a) in self.alive.iter().enumerate() {
            if a == 1 {
                self.live.push((self.gens[i] << 20) | i as u32);
            }
        }
        self.live.clone()
    }
    /// Todas las columnas de una entidad `[col0, col1, …]` (p. ej. para enviar por red).
    pub fn row(&self, id: u32) -> Vec<f32> {
        let i = (id & 0xFFFFF) as usize;
        self.data[i * self.cols..(i + 1) * self.cols].to_vec()
    }
}
