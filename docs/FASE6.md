# Fase 6: ShaderMaterial y parches de material (estado)

## Qué hay
- **Shaders de usuario** (`ShaderMaterial` del juego): el GLSL del juego se copia tal cual a `packages/phoenyx/src/user-shaders/<archivo>.ts` y se registra con `registerUserShader(vertexGLSL, fragmentGLSL, { id, pack, textures?, points?, attributes? })`; un material se reconoce por el texto exacto de su `vertexShader` + `fragmentShader`. El WGSL, portado a mano línea a línea, vive en `crates/phoenyx-gl/src/user/<archivo>.wgsl` (con la cabecera común `_header.wgsl`: `clip_of`, `tone_out`, `fog_out`, `modelOf`, `instMat`, `ub`, `sstep`) y `user_src(id)` de `lib.rs` lo une.
- **Uniformes** en plazas extra de `materials` (16 vec4 cada una; el vec4 0 es la niebla del material, los uniformes del shader empiezan en el 1). Una malla con `ShaderMaterial` puede ser **instanciada** (`instMat`); la mezcla (`blending` de three) viaja empaquetada en el dibujo y se cachea un pipeline por (id, banderas, formato, mezcla).
- **`Points` con `ShaderMaterial`** (`user/_points.wgsl`): seis vértices por punto leídos de la geometría como buffer de almacenamiento; `gl_PointSize`/`gl_PointCoord` se reproducen (con el mínimo de 1 px del rasterizador de WebGL en los polvos); los atributos propios (`aLife`, `aSeed`…) van en los huecos normal/uv/color del vértice. `PointsMaterial`, `Sprite` y `Line` siguen en la fase 7.
- **Pases de pantalla** `FilmShader` y `VhsShader` (`post.wgsl`: `fs_film`, `fs_vhs`) con `registerPassShader`.
- **Parches de `onBeforeCompile`** del Standard (`patches.ts` + ganchos en `shader.wgsl` por `m.pad.x`): `cos-tint` (cosmetics), la luz horneada de `lightmap.ts` (dos texturas RGBA8 globales, bindings 11-13 del grupo 0), la rugosidad mínima del hormigón del parking y `poolTile` (poolmap). Un parche se identifica ejecutando su `onBeforeCompile` sobre un sombreador de mentira y tomando la huella FNV del texto resultante; uno desconocido avisa por consola con su huella y se dibuja sin él. `THREE.ShaderChunk` queda reducido a `lights_fragment_begin`.

## Qué cubre del juego
| Archivo del juego | Qué | Escena |
|---|---|---|
| `vhsPass.ts` | FilmShader y VhsShader | `sh-vhs` |
| `waterjet.ts` | chorro (Points) | `sh-waterjet` |
| `parking-atmosphere.ts` | niebla volumétrica (4 y 10 pasos) y haz | `sh-parking-atm`, `sh-parking-atm-dentro` |
| `remote.ts` | haces de linterna remotos | `sh-remote` |
| `vents.ts` | gas (Points con textura) | `sh-vents` |
| `game.ts` | polvo de la cámara | `sh-dust-cam` |
| `world.ts` | polvo del pasillo, haces de los paneles (instanciados), cielo de la cúpula | `sh-dust-world`, `sh-world-shaft`, `sh-world-sky` |
| `cosmetics.ts`, `lightmap.ts`, `parking.ts` (hormigón), `poolmap.ts` | parches de material | `sh-cosmetics`, `sh-lightmap`, `sh-concrete`, `sh-pooltile` |

## Fidelidad (1280x720; media en /255, píxeles de interior > 8)
| Escena | media | máx | >8 interior |
|---|---|---|---|
| sh-prueba, sh-waterjet, sh-parking-atm, sh-parking-atm-dentro, sh-remote | 0 | 1 | 0 |
| sh-vents | 0,0003 | 1 | 0 |
| sh-dust-cam, sh-dust-world, sh-world-shaft, sh-world-sky | 0 | 1 | 0 |
| sh-lightmap, sh-concrete | 0 | 1–7 | 0 |
| sh-cosmetics | 0,03 | 129 (bordes) | 0 |
| sh-vhs (`compare --box 16`, ver abajo) | 0,39 | 8 | 0 |
| sh-pooltile | 0,11 | 12 | 233 (un blob; ver abajo) |

Las 55 escenas anteriores y nuevas se repiten en cada tarea; solo fallan las conocidas: `ao`, `ao-mezcla` y `pool-fx` (un píxel de interior, desde la fase 4), `sh-vhs` en bruto (grano) y `sh-pooltile`.

- **Grano de VHS**: el hash `fract(sin(dot(...)))` del grano da valores distintos en ANGLE y Tint (media 3,1 en bruto); se valida con `compare.mjs --box 16` (media de bloques de 16 px).
- **poolTile**: `h31` es caótico (`fract` de ~1e5): con `fma` explícito coincide con three salvo un blob residual en el suelo lejano (365 px de 921 600, máx 12/255). Es un límite de precisión flotante entre compiladores, no del parche.

## Rendimiento (mediana de fotograma, ms; `fidelity/baseline/fase6-*/perf.json`)
| Escena | three 1x | Phoenyx 1x | three 4x | Phoenyx 4x |
|---|---|---|---|---|
| sh-prueba | 0,4 | 0,5 | 1,9 | 2,9 |
| sh-vhs | 0,4 | 0,5 | 1,4 | 3,1 |
| sh-waterjet | 0,4 | 0,5 | 1,3 | 2,3 |
| sh-parking-atm | 0,4 | 0,5 | 1,4 | 2,3 |
| sh-remote | 0,4 | 0,5 | 1,5 | 2,9 |
| sh-vents | 0,4 | 0,6 | 1,9 | 2,3 |
| sh-dust-cam | 0,4 | 0,5 | 1,5 | 2,2 |
| sh-dust-world | 0,4 | 0,5 | 1,3 | 2,3 |
| sh-world-shaft | 0,4 | 0,5 | 1,3 | 2,1 |
| sh-world-sky | 0,4 | 0,5 | 1,4 | 2,4 |
| sh-cosmetics | 0,4 | 0,5 | 1,4 | 2,7 |
| sh-lightmap | 0,4 | 0,5 | 1,4 | 2,6 |
| sh-concrete | 0,4 | 0,5 | 1,4 | 2,4 |
| sh-pooltile | 0,4 | 0,5 | 1,6 | 2,2 |

Son escenas mínimas (~20 dibujos): el coste fijo por fotograma de Phoenyx (empaquetado, subida de buffers y llamada a wasm) pesa más que el de three, ~1 ms con CPU 4x más lenta. No es una regresión de esta fase (los ganchos de parche son una comparación por píxel), pero es trabajo de la fase 8 (rendimiento).

## Rulings y límites conocidos
- Los uniformes viven en plazas extra de `materials`; los ganchos de parche son ramas por `m.pad.x` en el mismo sombreador (sin variantes de pipeline).
- Reflector (agua de `pool`, `poolmap`, `world`, charcos del parking), `PointsMaterial` (incluido el parche de polvo del parking) y los extras de `MeshPhysicalMaterial` (clearcoat, `specularIntensity`, `envMap`, `transmission`) siguen en la fase 7: la baldosa de las Poolrooms se valida aquí con `clearcoat` 0,0001 (three necesita `USE_CLEARCOAT` para compilar el parche).
- `ShaderMaterial` con piel no está (el juego no lo usa). Los `Points` con shader de usuario no pueden ser instanciados.
- Los Points de menos de 1 px se dibujan a 1 px (como el rasterizador de WebGL en este equipo): si otro equipo no lo hace, el polvo cambiaría un poco.
