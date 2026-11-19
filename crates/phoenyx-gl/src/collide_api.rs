// Puente de JS a `phoenyx-collide`: todo por numeros y arrays tipados (un cruce por paso).
// Cuerpo (8 floats): [x, y, z, radio, alto, paso_max, vel_y, en_suelo]. Proyectil (12 floats): [pos3, vel3, radio, restitucion, rozamiento, vivo, reposo, 0].
use phoenyx_collide::{Body, Hit, Projectile, World};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Collide {
    w: World,
}

#[wasm_bindgen]
impl Collide {
    #[wasm_bindgen(constructor)]
    pub fn new(cell: f32) -> Collide {
        Collide { w: World::new(cell) }
    }

    pub fn add_box(&mut self, chunk: u32, x0: f32, y0: f32, z0: f32, x1: f32, y1: f32, z1: f32) {
        self.w.add_box(chunk, [x0, y0, z0], [x1, y1, z1]);
    }
    pub fn add_box_y(&mut self, chunk: u32, cx: f32, cy: f32, cz: f32, hx: f32, hy: f32, hz: f32, yaw: f32) {
        self.w.add_box_y(chunk, [cx, cy, cz], [hx, hy, hz], yaw);
    }
    pub fn add_cylinder(&mut self, chunk: u32, x: f32, y: f32, z: f32, r: f32, h: f32) {
        self.w.add_cylinder(chunk, [x, y, z], r, h);
    }
    pub fn add_cells(&mut self, chunk: u32, ox: f32, oz: f32, cell: f32, w: u32, h: u32, bits: &[u8], y0: f32, y1: f32) {
        self.w.add_cells(chunk, [ox, oz], cell, w, h, bits, y0, y1);
    }
    pub fn add_floor(&mut self, chunk: u32, x0: f32, z0: f32, x1: f32, z1: f32, y: f32) {
        self.w.add_floor(chunk, [x0, z0], [x1, z1], y);
    }
    pub fn add_ramp(&mut self, chunk: u32, x0: f32, z0: f32, x1: f32, z1: f32, ya: f32, yb: f32, axis: u8) {
        self.w.add_ramp(chunk, [x0, z0], [x1, z1], ya, yb, axis);
    }
    pub fn add_steps(&mut self, chunk: u32, x0: f32, z0: f32, x1: f32, z1: f32, y0: f32, rise: f32, tread: f32, count: u32, axis: u8, from_max: bool) {
        self.w.add_steps(chunk, [x0, z0], [x1, z1], y0, rise, tread, count, axis, from_max);
    }
    pub fn remove_chunk(&mut self, chunk: u32) {
        self.w.remove_chunk(chunk);
    }

    /// Mueve un cuerpo `[dx, dz]` y avanza su vertical `dt`. Escribe la posición y el estado en `body`; devuelve banderas.
    pub fn move_body(&mut self, body: &mut [f32], dx: f32, dz: f32, dt: f32, gravity: f32) -> u32 {
        let mut b = Body { pos: [body[0], body[1], body[2]], r: body[3], h: body[4], step_max: body[5], vel_y: body[6], ground: body[7] > 0.5 };
        let f = self.w.move_capsule(&mut b, [dx, dz], dt, gravity);
        body[..3].copy_from_slice(&b.pos);
        body[6] = b.vel_y;
        body[7] = if b.ground { 1.0 } else { 0.0 };
        f
    }

    /// Solo XZ con contactos (sin suelo ni gravedad), para quien lleva su propia vertical.
    pub fn move_xz(&mut self, body: &mut [f32], dx: f32, dz: f32) -> u32 {
        let mut b = Body { pos: [body[0], body[1], body[2]], r: body[3], h: body[4], step_max: body[5], vel_y: body[6], ground: body[7] > 0.5 };
        let f = self.w.move_xz(&mut b, [dx, dz]);
        body[..3].copy_from_slice(&b.pos);
        f
    }

    /// Altura del suelo bajo (x, z) para unos pies a `feet` y un peldaño máximo; NaN si no hay.
    pub fn floor_at(&mut self, x: f32, z: f32, feet: f32, step_max: f32) -> f32 {
        self.w.floor_at(x, z, feet, step_max).unwrap_or(f32::NAN)
    }

    /// Rayo: escribe `[t, nx, ny, nz]` en `out` y devuelve true si da.
    pub fn raycast(&mut self, ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, max: f32, out: &mut [f32]) -> bool {
        let mut h = Hit::default();
        let ok = self.w.raycast([ox, oy, oz], [dx, dy, dz], max, &mut h);
        if ok {
            out[0] = h.t;
            out[1..4].copy_from_slice(&h.normal);
        }
        ok
    }

    /// Avanza `n` proyectiles del buffer `buf` (12 floats cada uno).
    pub fn step_projectiles(&mut self, buf: &mut [f32], n: u32, dt: f32, gravity: f32) {
        let n = (n as usize).min(buf.len() / 12);
        let mut ps: Vec<Projectile> = (0..n)
            .map(|i| {
                let b = &buf[i * 12..i * 12 + 12];
                Projectile { pos: [b[0], b[1], b[2]], vel: [b[3], b[4], b[5]], r: b[6], restitution: b[7], friction: b[8], alive: b[9] > 0.5, resting: b[10] > 0.5 }
            })
            .collect();
        self.w.step_projectiles(&mut ps, dt, gravity);
        for (i, p) in ps.iter().enumerate() {
            let b = &mut buf[i * 12..i * 12 + 12];
            b[..3].copy_from_slice(&p.pos);
            b[3..6].copy_from_slice(&p.vel);
            b[9] = p.alive as u8 as f32;
            b[10] = p.resting as u8 as f32;
        }
    }
}
