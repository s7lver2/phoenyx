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

    // 6. Escalera de 9 peldaños (alzada 0,17, huella 0,3) subiendo y bajando a 3x de velocidad: sube entera y vuelve.
    let mut w = World::new(3.0);
    w.add_floor(0, [-5.0, -5.0], [20.0, 5.0], 0.0);
    w.add_steps(0, [2.0, -1.0], [4.7, 1.0], 0.0, 0.17, 0.3, 9, 0, false);
    w.add_floor(0, [4.7, -1.0], [9.0, 1.0], 1.53);
    let mut b = Body::new([0.0, 0.0, 0.0], 0.3, 1.8);
    (b.step_max, b.ground) = (0.35, true);
    for _ in 0..80 {
        w.move_capsule(&mut b, [0.09, 0.0], 1.0 / 60.0, 20.0);
    }
    if (b.pos[1] - 1.53).abs() > 0.01 || !b.ground {
        fail(&format!("no sube la escalera: y = {} suelo = {}", b.pos[1], b.ground));
    }
    for _ in 0..80 {
        w.move_capsule(&mut b, [-0.09, 0.0], 1.0 / 60.0, 20.0);
    }
    if b.pos[1].abs() > 0.01 || !b.ground {
        fail(&format!("no baja la escalera pegado al suelo: y = {} suelo = {}", b.pos[1], b.ground));
    }
    println!("ok escalera: y = {:.2}", b.pos[1]);

    // 7. Hueco con dos niveles apilados: se cae desde el nivel alto por el hueco y aterriza en el bajo; y subiendo no se cuela al alto.
    let mut w = World::new(3.0);
    w.add_floor(0, [-5.0, -5.0], [20.0, 5.0], 0.0); // nivel bajo
    w.add_floor(0, [-5.0, -5.0], [2.0, 5.0], 3.0); // nivel alto con un hueco desde x = 2
    w.add_floor(0, [4.0, -5.0], [20.0, 5.0], 3.0);
    let mut b = Body::new([1.0, 3.0, 0.0], 0.3, 1.8);
    (b.step_max, b.ground) = (0.35, true);
    for _ in 0..120 {
        w.move_capsule(&mut b, [0.03, 0.0], 1.0 / 60.0, 20.0);
    }
    if b.pos[1].abs() > 0.01 || !b.ground {
        fail(&format!("no aterriza en el nivel bajo del hueco: y = {} suelo = {}", b.pos[1], b.ground));
    }
    println!("ok hueco de dos niveles: y = {:.2}", b.pos[1]);

    // 8. Pokeball: rebota contra una caja (la velocidad normal se invierte con restitucion) y acaba en reposo en el suelo.
    use phoenyx_collide::{Hit, Projectile};
    let mut w = World::new(3.0);
    w.add_floor(0, [-50.0, -50.0], [50.0, 50.0], 0.0);
    w.add_box(0, [5.0, 0.0, -5.0], [5.5, 3.0, 5.0]);
    let mut p = [Projectile::new([0.0, 1.0, 0.0], [12.0, 2.0, 0.0], 0.1, 0.6, 0.2)];
    let mut rebotó = false;
    for _ in 0..600 {
        w.step_projectiles(&mut p, 1.0 / 60.0, 20.0);
        if p[0].vel[0] < -1.0 {
            rebotó = true;
        }
        if p[0].pos[0] > 5.0 {
            fail("atraviesa la caja");
        }
    }
    if !rebotó || !p[0].resting || (p[0].pos[1] - 0.1).abs() > 0.01 {
        fail(&format!("pokeball: rebote = {rebotó}, reposo = {}, y = {}", p[0].resting, p[0].pos[1]));
    }
    println!("ok proyectil: x = {:.2} y = {:.2}", p[0].pos[0], p[0].pos[1]);

    // 9. Raycast contra caja, cilindro y caja girada.
    let mut w = World::new(3.0);
    w.add_box(0, [5.0, 0.0, -1.0], [6.0, 2.0, 1.0]);
    w.add_cylinder(0, [20.0, 0.0, 0.0], 1.0, 2.0);
    let mut h = Hit::default();
    if !w.raycast([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], 50.0, &mut h) || (h.t - 5.0).abs() > 1e-3 || h.normal[0] > -0.9 {
        fail(&format!("raycast caja: t = {}", h.t));
    }
    if w.raycast([10.0, 1.0, 0.0], [1.0, 0.0, 0.0], 5.0, &mut h) {
        fail("raycast: dio mas alla del maximo");
    }
    if !w.raycast([10.0, 1.0, 0.0], [1.0, 0.0, 0.0], 50.0, &mut h) || (h.t - 9.0).abs() > 1e-3 {
        fail(&format!("raycast cilindro: t = {}", h.t));
    }
    println!("ok raycast");
}
