# Colisiones en Phoenyx (diseño)

## Intención
Hoy cada sistema del juego (jugador, lanzables, objetos soltos, entidades) hace sus propias colisiones y son la fuente constante de errores. El dueño quiere un módulo de colisiones **dentro del motor Phoenyx**, lo más eficiente posible en rendimiento y escala, que sustituya a todos.

## Síntomas que hay que resolver (del dueño)
1. Engancharse en esquinas.
2. Escaleras (sobre todo en Poolrooms) que se bugean al moverse rápido, al caer y luego subir, etc.

Causas vistas en `client/src/game/player.ts`:
- Esquinas: `blocked()` prueba las 4 esquinas de un cuadrado de lado 2R contra celdas y, aparte, el mobiliario. Se mueve primero en x y luego en z, con el paso entero: una esquina que roza una celda rechaza el eje entero y se queda pegado en vez de deslizarse.
- Escaleras: la altura del suelo (`floorAt`) se pregunta solo en la posición final tras el paso, sin barrido. A mucha velocidad el paso salta de escalón o se queda dentro de un escalón; al caer, `floorAt` con la `y` anterior elige otro piso (el hueco de escalera apila niveles). En Poolrooms, `terrain.drive` mueve el cuerpo con otro código aparte.

## Objetivos
- Un módulo único de colisión **cinemática** (sin física general): movimiento de personajes, proyectiles con rebote (pokeball, granada, objetos soltos) y raycast.
- Sin atravesar ni engancharse: barrido continuo de cápsula con deslizamiento por esquinas.
- Escaleras y suelo robustos: la altura sale de una consulta sobre el mismo índice, con subida de peldaños y pegado al suelo al bajar.
- Eficiencia: ver presupuesto.

## No objetivos
- Física de cuerpos rígidos (apilado, fuerzas, rotación, rodar). Sería una fase aparte.
- Colisión contra mallas arbitrarias en el primer corte.

## Anti-objetivos (fracaso aunque "funcione")
- Que el juego se sienta distinto al caminar (velocidades, radios, deslizamiento por paredes sin perder velocidad).
- Que cueste CPU de más en el bucle del juego (hoy ~1 ms o menos).

## Diseño
- **Crate `crates/phoenyx-collide`**, compilado en el mismo `.wasm` de `phoenyx-gl`. Datos en arrays contiguos, cero asignaciones por paso, un solo cruce JS↔WASM por paso (entra: posiciones y velocidades deseadas; sale: posiciones resueltas y banderas).
- **Broadphase:** rejilla hash uniforme (celdas del tamaño del colisionador típico, 3 m como las del juego); alta/baja O(1). El mundo se organiza en trozos estáticos (paredes, mobiliario) cargados con su trozo, más cuerpos dinámicos actualizados cada paso.
- **Formas:** caja alineada, caja con giro en Y, cilindro/cápsula, celda sólida de rejilla (1 bit) para laberintos, y **rampas/peldaños** como colisionador de altura (para escaleras).
- **Movimiento de personaje:** barrido de cápsula con respuesta de deslizamiento (proyectar la velocidad sobre el plano de contacto, pocas iteraciones), subida de peldaños (step-up hasta una altura máxima), pegado al suelo al bajar escaleras, y `floorAt(x, z, y)` que usa la altura de pies del barrido, no la del fotograma anterior.
- **Proyectiles:** esfera con gravedad, rozamiento y restitución por material; sustituye a `flight()` y a `fly` de `game.ts`. La predicción del arco usa el mismo código que el lanzamiento.
- **Raycast:** recorrido DDA sobre la misma rejilla.
- **API JS** (`packages/phoenyx`): `world.addBox/addCylinder/addGrid/addStairs(...)`, `world.move(body, wish, dt)`, `world.raycast(...)`, `world.step(projectiles, dt)`. El juego registra lo que antes eran sus `solid()`, `furniture()` y `floorAt()`.

## Presupuesto de rendimiento
- 10 000 cuerpos dinámicos y 100 000 colisionadores estáticos: paso completo < 1 ms en el portátil de desarrollo, sin asignaciones. Banco: `tools/collide-bench`.
- Cargar un trozo: proporcional a sus colisionadores, sin reconstruir el resto.

## Migración
1. Crear el crate y el banco; sin tocar el juego.
2. Conectar Level 0 (laberinto de celdas) en paralelo con la lógica antigua, comparando resultados durante unos fotogramas.
3. Pasar Suites (escaleras de servicio), Poolrooms (hoy `terrain.drive`), hospital, parking; después lanzables y objetos soltos. Retirar la lógica antigua de `player.ts`, `runlevel.ts` y `game.ts`.

Verificación: banco de rendimiento; escenas de prueba de esquinas y escaleras (recorrido automático a velocidad alta, caída y subida) en `tools/fidelity`; sin tests unitarios.

## Qué queda para quien construya
Radio y altura de cápsula por entidad, altura máxima de peldaño, restitución por material, formato exacto del puente JS↔WASM.
