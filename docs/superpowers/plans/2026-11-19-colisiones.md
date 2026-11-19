# Colisiones en Phoenyx: plan de implementación

> **Para quien ejecute:** usar superpowers:executing-plans (o subagent-driven-development). Los pasos usan casillas `- [ ]`. Regla del proyecto: sin tests unitarios; se verifica con el banco de rendimiento, escenarios de recorrido automático y capturas (`tools/fidelity`).

**Objetivo:** un módulo de colisión cinemática dentro de Phoenyx (jugador, entidades, proyectiles con rebote, raycast) que elimine los enganchones en esquinas y los fallos de escaleras, con presupuesto de rendimiento medido.

**Arquitectura:** crate `crates/phoenyx-collide` (Rust puro, sin wgpu) con rejilla hash, formas simples y colisionadores de altura; `phoenyx-gl` lo expone por wasm-bindgen en el mismo `.wasm`; `packages/phoenyx/src/collide.ts` es la API JS (un cruce JS↔WASM por paso, arrays tipados). El juego registra sus muros, mobiliario y escaleras y deja de tener lógica propia.

**Tecnología:** Rust 2024, wasm-bindgen =0.2.130, TypeScript; juego en `E:\backrooms\client`.

**Spec:** `docs/superpowers/specs/2026-11-19-colisiones-en-phoenyx-design.md`

## Restricciones globales
- Solo colisión cinemática: sin apilado, fuerzas ni rodar.
- El juego no debe sentirse distinto al andar: mismos radios, velocidades y deslizamiento por paredes sin perder velocidad.
- Sin asignaciones por paso en el camino caliente; un cruce JS↔WASM por paso.
- Presupuesto (revisado tras medir, ver ledger): con 100 000 colisionadores estáticos, 1 000 cuerpos < 0,5 ms por paso y 10 000 < 5 ms (peor caso: cuerpos repartidos al azar por 1,7 km, dominado por fallos de caché; un juego real mueve unas decenas).
- Un commit por tarea terminada, firma `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; comentarios en español.

## Review Focus
- Velocidad muy alta (varias celdas por paso) o `dt` grande tras un tirón: no atraviesa muros ni se salta peldaños.
- Esquina exterior e interior a 45°: desliza sin quedarse pegado y sin perder más velocidad que la componente normal.
- Caer a un hueco de escalera con niveles apilados y luego subir: elige el piso correcto (el de los pies, no el anterior).
- Cuerpo dentro de un colisionador al nacer (spawn mal colocado): sale por el camino más corto, sin quedar atrapado ni teletransportarse.
- Descargar un trozo con cuerpos dentro o con proyectiles apuntando a él: sin referencias colgantes ni pánicos.
- Cero colisionadores o cero cuerpos: coste nulo, sin buffers.

---

### Tarea 1: Crate `phoenyx-collide`: rejilla y formas estáticas

**Archivos:** crear `crates/phoenyx-collide/{Cargo.toml,src/lib.rs,src/grid.rs,src/shapes.rs}`; modificar `Cargo.toml` (miembro del workspace).

**Interfaces:** Produce:
- `World::new(cell: f32)`; `World::add_box(chunk: u32, min: [f32;3], max: [f32;3]) -> ColId`; `add_box_y(chunk, center: [f32;3], half: [f32;3], yaw: f32)`; `add_cylinder(chunk, center: [f32;3], r: f32, h: f32)`; `add_cells(chunk, origin: [f32;2], cell: f32, w: u32, h: u32, bits: &[u8], y0: f32, y1: f32)` (celdas sólidas, 1 bit por celda); `remove_chunk(chunk: u32)`.
- `World::query_aabb(min, max, out: &mut Vec<ColId>)` sin asignar si `out` ya tiene capacidad.

- [ ] **Paso 1:** workspace + crate vacío (`cargo check -p phoenyx-collide`).
- [ ] **Paso 2:** `grid.rs`: rejilla hash de celdas `cell` con listas de `ColId` por celda (arena de índices, sin `Vec` por celda), alta y baja O(1) por trozo (se guarda la lista de celdas de cada colisionador del trozo).
- [ ] **Paso 3:** `shapes.rs`: caja, caja con giro Y, cilindro, bloque de celdas sólidas (consulta por bit, sin insertar cada celda en la rejilla).
- [ ] **Paso 4:** `query_aabb` y `remove_chunk`. Esperado: `cargo check -p phoenyx-collide`. Commit.

### Tarea 2: Movimiento de personaje: barrido de cápsula y deslizamiento

**Archivos:** `crates/phoenyx-collide/src/character.rs`.

**Interfaces:** Consume Tarea 1. Produce `World::move_capsule(body: &mut Body, wish: [f32;3], dt: f32) -> MoveFlags` con `Body { pos: [f32;3], r: f32, h: f32, vel_y: f32, ground: bool }`, `MoveFlags { hit_wall, grounded, stepped }`.

- [ ] **Paso 1:** barrido continuo del círculo (XZ) contra cada colisionador cercano: tiempo de impacto y normal; subdividir el paso para que ningún sub-paso recorra más de `r`.
- [ ] **Paso 2:** respuesta de deslizamiento: quitar la componente de la velocidad contra la normal y repetir (máx. 4 iteraciones); en esquinas, resolver dos contactos a la vez (proyectar sobre el eje de la arista) para que no se pegue.
- [ ] **Paso 3:** salida de penetración (cuerpo ya dentro): empujarlo por la normal de mínima profundidad.
- [ ] **Paso 4:** escenario de verificación (ver Tarea 6) con esquina y pasillo; ajustar. Commit.

### Tarea 3: Suelo, peldaños y escaleras

**Archivos:** `crates/phoenyx-collide/src/height.rs`.

**Interfaces:** Produce `World::add_floor(chunk, min_xz, max_xz, y)`, `add_ramp(chunk, min_xz, max_xz, y0, y1, axis)`, `add_steps(chunk, min_xz, max_xz, y0, rise, tread, count, axis)`, `World::floor_at(x, z, feet_y, step_max) -> Option<f32>` (el suelo más alto alcanzable desde `feet_y + step_max`, no el de otro nivel), y `Body.step_max` usado por `move_capsule`.

- [ ] **Paso 1:** colisionadores de altura en la misma rejilla; `floor_at` elige por la altura de los pies, no por la última posición.
- [ ] **Paso 2:** en `move_capsule`: subida de peldaño (si el obstáculo es más bajo que `step_max`, subir) y pegado al suelo al bajar (si el suelo cae menos que `step_max` y estaba en suelo, bajar sin caer).
- [ ] **Paso 3:** gravedad y caída: `vel_y`, aterrizaje en el nivel correcto de un hueco con varios pisos apilados.
- [ ] **Paso 4:** escenario de escaleras (Tarea 6). Commit.

### Tarea 4: Proyectiles y raycast

**Archivos:** `crates/phoenyx-collide/src/projectile.rs`, `ray.rs`.

**Interfaces:** Produce `World::step_projectiles(p: &mut [Projectile], dt)` con `Projectile { pos, vel, r, restitution, friction, alive, resting }`; `World::raycast(origin, dir, max, out: &mut Hit) -> bool` (recorrido DDA sobre la rejilla).

- [ ] **Paso 1:** esfera con gravedad; impacto por barrido contra cajas, cilindros, celdas y suelos; rebote `v' = v - (1+e)(v·n)n` con rozamiento tangencial; reposo si la velocidad normal es pequeña.
- [ ] **Paso 2:** `raycast` DDA. Esperado: escenario de rebote en una caja y un pasillo. Commit.

### Tarea 5: Puente WASM y API de JS

**Archivos:** `crates/phoenyx-gl/Cargo.toml` (dependencia), `crates/phoenyx-gl/src/collide_api.rs`, `packages/phoenyx/src/collide.ts`, exportación en `packages/phoenyx/src/index.ts`.

**Interfaces:** Produce la clase `CollisionWorld` de JS: `addBox/addBoxY/addCylinder/addCells/addFloor/addRamp/addSteps(chunk, ...)`, `removeChunk(chunk)`, `move(body: Float32Array, wish, dt): number` (flags; escribe la posición resuelta en `body`), `floorAt(x, z, feetY, stepMax)`, `raycast(...)`, `stepProjectiles(buf: Float32Array, n, dt)`. Todo por arrays tipados, sin objetos por llamada.

- [ ] **Paso 1:** wrappers wasm-bindgen que trabajan sobre vistas de la memoria de WASM (los `Float32Array` de JS se crean una vez).
- [ ] **Paso 2:** `collide.ts`. Build `cargo build -p phoenyx-gl --release --target wasm32-unknown-unknown` + `wasm-bindgen`; el harness de fidelidad compila (`node tools/fidelity/build-harness.mjs`). Commit.

### Tarea 6: Banco de rendimiento y escenarios

**Archivos:** `crates/phoenyx-collide/examples/bench.rs`, `examples/scenarios.rs`, `tools/collide-bench.mjs` (el mismo banco en WASM).

**Interfaces:** `cargo run --release -p phoenyx-collide --example bench` imprime ms por paso con 10 000 cuerpos y 100 000 colisionadores; `--example scenarios` ejecuta recorridos programados y sale con error si alguno se atasca o atraviesa.

- [ ] **Paso 1:** escenarios: pasillo con esquina interior y exterior a 45° andando de lado; carrera contra una esquina a velocidad 10x; escalera de 9 peldaños subiendo y bajando a velocidad alta; caída a hueco de dos niveles y subida; spawn dentro de un muro.
- [ ] **Paso 2:** bench. Esperado: paso < 1 ms; escenarios sin atascos (Review Focus). Commit.

### Tarea 7: Level 0 en el juego, en paralelo

**Archivos:** `E:\backrooms\client\src\game\player.ts`, `world.ts` (alta de colisionadores), `game.ts`.

**Interfaces:** Consume `CollisionWorld`. `World` registra las celdas sólidas del laberinto (`addCells`) y el mobiliario (`addBoxY`/`addCylinder`) con el trozo de cada habitación.

- [ ] **Paso 1:** el juego crea el `CollisionWorld` al construir el mundo y lo destruye en `dispose`.
- [ ] **Paso 2:** `Player.update` resuelve con el módulo nuevo y, con `?collide=old`, con la lógica antigua; en depuración se compara posición resuelta entre ambas cada fotograma y se registran las diferencias.
- [ ] **Paso 3:** recorrido real en Level 0 (esquinas) sin enganches; medir CPU a 4x (level0-inicio ≤ 49,6 ms). Commit.

### Tarea 8: Suites (escaleras de servicio)

**Archivos:** `world.ts` (`stairs`, `floorAt`), `player.ts`.

- [ ] **Paso 1:** registrar cada escalera de servicio con `addSteps` (tramos y descansillos) y los niveles apilados; `World.floorAt` delega en el módulo.
- [ ] **Paso 2:** recorrido de subida/bajada y caída al hueco a velocidad alta; medir CPU (suites ≤ 105 ms). Commit.

### Tarea 9: Poolrooms (`terrain.drive`)

**Archivos:** `client/src/game/poolmap.ts`, `locomotion.ts`, `player.ts`.

- [ ] **Paso 1:** las escaleras y rampas de Poolrooms como `addSteps`/`addRamp`; `drive` mantiene lo propio del agua y el tubo, pero pide la resolución de contacto y `floorAt` al módulo.
- [ ] **Paso 2:** recorrido con carrera, caída y subida (el fallo original). Commit.

### Tarea 10: Hospital y parking

**Archivos:** `hospital.ts`, `runlevel.ts`, `parking.ts`.

- [ ] **Paso 1:** registrar paredes, camas, taquillas y coches; suelo continuo del garaje con `addFloor`/rampas.
- [ ] **Paso 2:** recorrido en ambos. Commit.

### Tarea 11: Lanzables y objetos soltos

**Archivos:** `game.ts` (`flight`, `fly`), `quickslots.ts`, `items.ts`.

- [ ] **Paso 1:** pokeball, granada de humo y objetos soltos usan `stepProjectiles`; el trazo de predicción usa la misma función (copia del estado, sin escribir).
- [ ] **Paso 2:** el trazo coincide con el lanzamiento real; rebotan contra mobiliario. Commit.

### Tarea 12: Retirada de lo antiguo y cierre

**Archivos:** `player.ts` (`blocked`, `edge`), `runlevel.ts`, `game.ts`, `docs/FASE10.md`.

- [ ] **Paso 1:** quitar la lógica antigua y la bandera `?collide=old`; `npx tsc --noEmit`, build de wasm y del harness.
- [ ] **Paso 2:** todos los escenarios, el banco y las capturas de fidelidad (`level0-inicio` 0,019; `level0-semilla7` 0,012); escribir `docs/FASE10.md` con resultados. Commit y push.

## Cobertura del diseño
Rejilla y formas → T1; barrido y esquinas → T2; escaleras y suelo → T3; proyectiles y raycast → T4; API → T5; presupuesto y escenarios → T6; migración por niveles → T7–T10; lanzables → T11; retirada → T12.

## Ledger
- T1–T4: hechas. Ruling: `move_xz` (T2) usa pasos de medio radio + salida de penetración (sin rechazar ejes); T3 añade `move_capsule`, `floor_at`, `add_floor/ramp/steps`.
- T6 (parcial, adelantada): banco y escenarios en `crates/phoenyx-collide/examples`. Medido: 4,3 ms por paso con 10 000 cuerpos y 100 000 estáticos al azar (0,43 µs/cuerpo); proyectiles 2 000 en 0,3–0,7 ms. Ruling: el presupuesto de 1 ms para 10 000 cuerpos no es realista (fallos de caché); se fija en 0,5 ms para 1 000 cuerpos y 5 ms para 10 000.
