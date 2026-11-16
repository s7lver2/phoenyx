# Arquitectura

Phoenix es un renderer GPU-driven en Rust + WebGPU (`wgpu`), compilado a WASM. La CPU solo sube la cámara y los datos que cambian; el trabajo por instancia (culling, elección de LOD, generación de draws) ocurre en compute.

## Crates

| Crate | Qué es |
|---|---|
| `crates/phoenix` | El motor (cdylib WASM). Culling, draws indirectos, cielo/suelo, post-proceso, Hi-Z. |
| `crates/lux` | Iluminación independiente: WGSL, recursos de GPU y cálculo de cascadas/focos. Ver [LUX.md](LUX.md). |
| `crates/phoenix-bake` | Herramienta nativa (CLI) que convierte GLB/procedurales en un paquete de modelos con LOD y texturas. Ver [ASSETS.md](ASSETS.md). |
| `web/phoenix.js` | Envoltorio JS: soporte, carga de paquetes, creación del motor, ayudantes de luces, vigilancia de errores. |

El anfitrión (la página o el juego) decide la escena: genera las instancias y las pasa al motor.

## Frame

Todo va en un solo `CommandEncoder`:

1. **Compute de culling** (una pasada, varios dispatches):
   - `chunk_build` (solo si cambiaron las instancias): esfera de cada grupo de 64 instancias.
   - Por cada vista (cámara principal, cascadas del sol, focos con sombra): `count` → `scan` → `scatter`.
     - Cada workgroup es un chunk de 64 instancias; si su esfera está fuera del frustum, no lee las instancias.
     - `pick` por instancia: frustum, descarte por tamaño, oclusión Hi-Z (solo vista principal), elección de LOD por error en pantalla y fundido.
   - `cluster_cull` (lux): reparte las luces en clusters 16×9×24.
2. **Sombras**: una pasada de profundidad por vista activa, ejecutando un render bundle con los draws indirectos.
3. **Pase principal** a un buffer HDR (`Rgba16Float`) + profundidad: cielo, suelo y el bundle de instancias.
4. **Hi-Z**: pirámide R32Float (nivel 0 = media resolución, profundidad más lejana) para el culling del frame siguiente.
5. **Post-proceso**: AO a media resolución → bloom (4 reducciones) → composición (AO + bloom + exposición + ACES + gamma) a la pantalla.
6. Cada 45 frames se copian los contadores y los timestamps para las estadísticas.

## Culling y LOD

- Cada modelo tiene `lods` niveles; los draws indirectos son uno por (modelo, LOD), con `first_instance` = desplazamiento en el buffer `vis`.
- LOD: el nivel más grueso cuyo error proyectado (px) cabe en la tolerancia `tau`. La tolerancia crece con la distancia entre 100 y 500 m (`set_far_tolerance`).
- Fundido: si el siguiente nivel grueso está a punto de ser aceptable, la instancia se emite en los dos niveles y se reparten los píxeles con ruido complementario (sin saltos visibles). `vis` guarda `instancia | peso << 24 | rol << 31`.
- Hi-Z: se proyecta la esfera con la matriz del frame anterior y se compara su profundidad más cercana con la más lejana del Hi-Z. Es conservador (ante la duda, visible) y tiene un frame de retraso.
- `count` y `scatter` recalculan `pick`; es una optimización pendiente (ver [LIMITACIONES.md](LIMITACIONES.md)).

## Formatos

- **Vértice (20 B):** posición `snorm16x4` (w = signo de la tangente), normal `snorm16x2` octaédrica, tangente `snorm16x2` octaédrica, UV `unorm16x2`. Las UV no pueden pasar de `[0, 1]` (no hay tiling por UV).
- **Instancia (8 floats):** `[x, y, z, escala, modelo, yaw, hash, 0]`. `escala` es también el radio de culling (los modelos se normalizan a esfera unidad). Solo hay rotación en Y.
- **Tabla de modelos (`info`, 16 floats por modelo):** `[radio, err0..err9, 2 libres, base_off, alto, 1 libre]`. Para apoyar un modelo en `y0`, la posición es `y0 + escala * base_off`.
- **Luces (16 floats):** ver [LUX.md](LUX.md).

## Bind groups

| Grupo | Contenido |
|---|---|
| 0 | `Globals` (uniform) + instancias, tabla de modelos, args indirectos, contadores, `vis`, chunks |
| 1 | `vis` (vertex, binding 0) / Hi-Z (compute, binding 1) |
| 2 | Texturas de modelos (base sRGB, normal, ORM) en `texture_2d_array` + sampler |
| 3 | Suelo (bindings 0..2) + iluminación de lux (3..7) |
