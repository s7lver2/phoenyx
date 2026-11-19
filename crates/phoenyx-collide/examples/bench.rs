// Banco de rendimiento: 10 000 cuerpos dinamicos contra 100 000 colisionadores estaticos en un mundo de 3 km2. Presupuesto: < 1 ms por paso.
use phoenyx_collide::{Body, Projectile, World};
use std::time::Instant;

fn rnd(s: &mut u64) -> f32 {
    *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((*s >> 33) as f32) / (1u64 << 31) as f32
}

fn main() {
    let mut s = 1u64;
    let mut w = World::new(3.0);
    let side = 1700.0;
    for i in 0..100_000 {
        let (x, z) = (rnd(&mut s) * side, rnd(&mut s) * side);
        match i % 3 {
            0 => drop(w.add_box(i / 1000, [x, 0.0, z], [x + 1.0 + rnd(&mut s) * 2.0, 2.5, z + 0.3])),
            1 => drop(w.add_cylinder(i / 1000, [x, 0.0, z], 0.4, 1.0)),
            _ => drop(w.add_box_y(i / 1000, [x, 1.0, z], [0.8, 1.0, 0.3], rnd(&mut s) * 3.14)),
        }
    }
    w.add_floor(0, [0.0, 0.0], [side, side], 0.0);
    let mut bodies: Vec<Body> = (0..10_000)
        .map(|_| {
            let mut b = Body::new([rnd(&mut s) * side, 0.0, rnd(&mut s) * side], 0.3, 1.8);
            (b.step_max, b.ground) = (0.35, true);
            b
        })
        .collect();
    let mut dirs: Vec<[f32; 2]> = (0..10_000).map(|_| [rnd(&mut s) - 0.5, rnd(&mut s) - 0.5]).collect();
    let mut ps: Vec<Projectile> = (0..2_000).map(|_| Projectile::new([rnd(&mut s) * side, 2.0, rnd(&mut s) * side], [3.0, 4.0, 1.0], 0.1, 0.5, 0.2)).collect();
    for k in 0..3 {
        let t = Instant::now();
        for _ in 0..60 {
            for (b, d) in bodies.iter_mut().zip(&dirs) {
                w.move_capsule(b, [d[0] * 0.1, d[1] * 0.1], 1.0 / 60.0, 20.0);
            }
        }
        let ms = t.elapsed().as_secs_f64() * 1000.0 / 60.0;
        println!("ronda {k}: {ms:.3} ms por paso con 10000 cuerpos");
        let t = Instant::now();
        for _ in 0..60 {
            w.step_projectiles(&mut ps, 1.0 / 60.0, 20.0);
        }
        println!("  proyectiles (2000): {:.3} ms por paso", t.elapsed().as_secs_f64() * 1000.0 / 60.0);
        for d in dirs.iter_mut() {
            *d = [rnd(&mut s) - 0.5, rnd(&mut s) - 0.5];
        }
    }
}
