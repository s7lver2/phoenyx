// Escenarios de verificacion: recorridos programados; sale con error si alguno se atasca o atraviesa.
use phoenyx_collide::{Body, World};

fn fail(m: &str) -> ! {
    eprintln!("FALLA: {m}");
    std::process::exit(1)
}

fn main() {
    // 1. Esquina interior a 90 grados: pasillo en L de 1,2 m de ancho. Andar a lo largo de la pared y girar a mitad.
    let mut w = World::new(3.0);
    w.add_box(0, [-10.0, 0.0, -1.0], [30.0, 3.0, 0.0]); // pared sur
    w.add_box(0, [-10.0, 0.0, 1.2], [30.0, 3.0, 2.2]); // pared norte
    let mut b = Body::new([0.0, 0.0, 0.6], 0.3, 1.8);
    for _ in 0..600 {
        w.move_xz(&mut b, [0.05, 0.002]); // empujando contra la pared norte, en diagonal
    }
    if b.pos[0] < 25.0 {
        fail(&format!("pegado en la pared: x = {}", b.pos[0]));
    }
    println!("ok pasillo: x = {:.2}", b.pos[0]);

    // 2. Esquina exterior: caja y rodearla pegado, con la vista de lado.
    let mut w = World::new(3.0);
    w.add_box(0, [0.0, 0.0, 0.0], [2.0, 3.0, 2.0]);
    let mut b = Body::new([-0.4, 0.0, 1.0], 0.3, 1.8);
    for _ in 0..80 {
        w.move_xz(&mut b, [0.0, -0.05]); // bajando por el lado oeste, pegado
    }
    for _ in 0..80 {
        w.move_xz(&mut b, [0.05, -0.002]); // y doblando la esquina sur
    }
    if b.pos[0] < 2.0 {
        fail(&format!("enganchado en la esquina exterior: x = {}", b.pos[0]));
    }
    println!("ok esquina exterior: x = {:.2}", b.pos[0]);

    // 3. Carrera contra una pared a 10x: no la atraviesa.
    let mut w = World::new(3.0);
    w.add_box(0, [5.0, 0.0, -5.0], [5.3, 3.0, 5.0]);
    let mut b = Body::new([0.0, 0.0, 0.0], 0.3, 1.8);
    for _ in 0..20 {
        w.move_xz(&mut b, [3.0, 0.0]);
    }
    if b.pos[0] > 5.0 {
        fail(&format!("atraviesa la pared: x = {}", b.pos[0]));
    }
    println!("ok carrera: x = {:.2}", b.pos[0]);

    // 4. Esquina a 45 grados: dos cajas giradas formando una V; el cuerpo desliza por ellas.
    let mut w = World::new(3.0);
    w.add_box_y(0, [3.0, 1.0, 1.5], [3.0, 1.0, 0.2], 0.785);
    let mut b = Body::new([0.0, 0.0, 0.0], 0.3, 1.8);
    for _ in 0..200 {
        w.move_xz(&mut b, [0.05, 0.01]);
    }
    if b.pos[0] < 6.0 {
        fail(&format!("atascado en la pared a 45: x = {}", b.pos[0]));
    }
    println!("ok pared a 45 grados: x = {:.2}", b.pos[0]);

    // 5. Nacer dentro de un muro: sale por el camino corto.
    let mut w = World::new(3.0);
    w.add_box(0, [0.0, 0.0, 0.0], [4.0, 3.0, 1.0]);
    let mut b = Body::new([2.0, 0.0, 0.2], 0.3, 1.8);
    w.move_xz(&mut b, [0.0, 0.0]);
    if b.pos[2] > -0.29 || b.pos[2] < -0.31 {
        fail(&format!("salida de penetracion rara: z = {}", b.pos[2]));
    }
    println!("ok spawn en muro: z = {:.2}", b.pos[2]);
}
