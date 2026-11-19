# Fase 9: Phoenix dentro de Phoenyx

Fecha: 2026-11-19. Spec y plan en `docs/superpowers/`.

## Qué se hizo
- **Un solo motor.** `crates/phoenix` y `web/phoenix.js` (con sus demos `web/index.html`, `web/suites.html` y `docs/API.md`, `docs/INTEGRACION.md`) se han borrado; quedan en el historial. `lux` y `phoenix-bake` pasan a `phoenyx-lux` y `phoenyx-bake`.
- **Culling y LOD en GPU** en `phoenyx-gl` (`gpu_cull.*`), con el sombreado legacy de Phoenyx (decisión del dueño: no se copia el sombreado de lux). Marca: `userData.gpuLods`. Ver `docs/ARQUITECTURA.md`.
- **Bake en el build** del juego: `tools/bake_lods.mjs` (Node, gltf-transform + meshoptimizer) y plugin `bakeLods` de vite. Ruling: no se usa el binario Rust porque los GLB del juego van comprimidos con meshopt y el crate `gltf` no los lee.
- **Alcance de vista** de los niveles: niebla 19→28 m (hotel 24→30) y props hasta 36 m.

## Verificación
- `inst-lod` (esferas, escena sintética): diferencia media 0,11/255 frente al LOD 0.
- Escenas sintéticas: sin fallos nuevos con el camino GPU activo.
- Juego, con y sin `?nogpulod`: `level0-inicio`, `level0-semilla7` y `suites` idénticos (diferencia 0) a la distancia de captura; con tolerancia forzada a 300 px el LOD sí actúa (media 1,6/255).
- CPU a 4x (preset high): level0-inicio 22,6 ms de render (frame 30 ms), suites 29,2 ms (frame 46 ms); dentro del presupuesto de la fase 8 (49,6 / 105 ms).

## Pendiente / decisiones
- **lux opcional** (`renderer.lighting`): no se ha conectado. Con el dibujo legacy, lux solo cabe como un sombreado alternativo del camino GPU; queda `phoenyx-lux` como crate independiente. Es una fase aparte.
- La mayoría de props del juego son de pocos triángulos y no se hornean (< 600); la ganancia se ve sobre todo en mobiliario pesado de Suites/Pool.
