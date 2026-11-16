# Integración con Backrooms

## Qué es three.js en el juego hoy (medido)

61 archivos del cliente importan three.js. Uso aproximado: ~310 `Mesh`, ~120 `MeshBasicMaterial`, ~120 `MeshStandardMaterial`, ~100 `BoxGeometry`, ~75 `PlaneGeometry`, ~60 `BufferGeometry` a mano, ~50 `CanvasTexture`, ~30 `PointLight`, 28 `AdditiveBlending`, 24 `InstancedMesh`, 22 `ShaderMaterial`, 22 `Points`, 14 `Sprite`, 25 `Bone`, además del grafo de escena (`Group`, `Object3D`). El juego construye casi toda su geometría y texturas en código.

**Consecuencia:** sustituir three.js entero exigiría un grafo de escena, materiales genéricos, geometría procedural, texturas desde canvas, transparencias, sprites y sombras para todo. Eso no es un cambio de renderer: es otro proyecto. Phoenix está pensado para otro reparto.

## Reparto propuesto (escena por escena)

| Lo dibuja Phoenix | Se queda fuera de Phoenix |
|---|---|
| Mundo modular (paredes, suelos, techos, puertas, lámparas) como instancias | UI y HUD (React/DOM, no dependen del renderer) |
| Luces (puntuales, focos con sombra, tubos), sol y luna | Menús, lobby, tienda, inventario |
| Personajes con huesos: jugadores, Facelings, partygoers, bacteria | Efectos puntuales hechos con `ShaderMaterial` mientras no haya equivalente |
| Partículas (polvo, humo, chispas) | |
| Post-proceso (AO, bloom, ACES) | |

La primera escena que se haría así es Las Suites (aún en diseño), porque no tiene código heredado en three.js. Las demás se migran cuando haga falta, no antes.

## Qué falta para que Las Suites funcione con Phoenix

- Hornear los personajes restantes (`--kind skin` con `tools/unpack_glb.mjs`): bacteria, partygoer, cuerpos de jugador. Solo está probado el hazmat.
- El código del juego que cree las instancias a partir del mapa (hoy lo hace `web/suites.html` con un laberinto de prueba).
- Piezas del mundo reales (hoy son cajas procedurales con el papel pintado del juego).
- Mallas transparentes (cristales) si el diseño las pide: no existen.
- Una cámara y un bucle de juego que vivan en el cliente, con la red y el audio actuales.

## IA

`phoenix-ai` ya ofrece `Rng`, `Grid` (BFS, A*, visión), `in_cone`, `hears`, `Near`, `Clock` y `Store`. Migrar la IA actual (`shared/src/sim.ts` y `parking-*-ai.ts`) consiste en cambiar `bfs`, `Math.random` y `seesXZ` por llamadas a esa base; los comportamientos no se mueven. Está sin hacer: `shared/` lo ejecutan también el servidor (Node) y los tests del juego, así que hay que cargar el wasm allí y decidir qué pasa con la determinación de las partidas ya guardadas.

## Decisión pendiente (del dueño)

Definir «listo» como «puede dibujar Las Suites completa» (lo que este documento describe) o como «puede sustituir three.js en todo el juego» (proyecto grande, sin plan).
