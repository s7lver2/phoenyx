# Fase 2: geometrías, texturas y carga de modelos (estado)

## Qué hay
- **Geometrías** copiadas de three (Box, Sphere, Cylinder, Cone, Capsule, Torus, Octahedron, Dodecahedron, Lathe, Extrude, Tube, Ring, Circle, Plane), con grupos y `drawRange`.
- **Texturas** (`src/textures.ts`): se leen con un canvas 2D (`flipY` aplicado), subida RGBA8 (formato sRGB si `colorSpace` es sRGB), cadena de mips en CPU con filtro de caja 2x2 en espacio lineal, samplers por clave (wrap, filtros, anisotropía), un bind group por conjunto de texturas del material.
- **Mapas en el shader**: `map`, `normalMap` (tangentes por derivadas, `normalScale`), `bumpMap` (Mikkelsen, `bumpScale`), `roughnessMap`, `emissiveMap`, `alphaTest`; `metalnessMap` solo si es la misma textura que `roughnessMap` (como la emite `GLTFLoader`).
- **`InstancedMesh`** con matriz y color por instancia y `count` parcial (arenas `inst_mats` / `inst_cols`, hasta 65535 instancias por dibujo).
- **Carga de modelos**: `GLTFLoader` + `MeshoptDecoder` copiados de three (`src/jsm`), con el alias `three/examples/jsm`.

## Formatos
- Dibujo: 12 u32. Flags: 0 doble cara, 1 giro horario, 2 transparente, 3 escribe profundidad, 4 prueba de profundidad, 5 FLIP_SIDED, 6 DOUBLE_SIDED, 7 color por instancia.
- Material: 64 floats (16 vec4); máscara de mapas: 1 map, 2 normal, 4 roughness, 8 emissive, 16 bump, 32 metalness (= roughness).
- Globals 64 floats, objeto 32, luz 16 (máx. 64), vértice 44 B.

## Decisiones que importan
- Mips en espacio lineal (el filtro en sRGB daba error visible).
- La y de pantalla de WebGPU es la contraria a GL: `dFdy` de GLSL = `-dpdy`.
- `alphaTest` con borde suave como three.
- La normal se normaliza por vértice (three lo hace en `defaultnormal_vertex`); sin esto `LatheGeometry`, cuyas normales no son unitarias, difería ~8/255.

## Fidelidad (punto de control 2)
10 escenas, 1280x720, three real contra Phoenyx:

| Escena | media | máx | >8 (interior) |
|---|---|---|---|
| sala-basic, -exp, -lineal | 0 | 0–1 | 0 |
| sala-exp, -lineal, -sinniebla | 0 | 1 | 0 |
| tex (todos los mapas) | 0,0045 | 142 (borde) | 0 |
| inst | 0,0001 | 5 | 0 |
| geoms (14 geometrías) | 0,0008 | 112 (1 px de borde) | 0 |
| modelos (6 GLB con meshopt) | 0,0023 | 26 | 0 |

Aprobado (media < 1, ningún píxel de interior > 8).

## Rendimiento (mediana de fotograma, ms; `fidelity/baseline/fase2-*/perf.json`)
| Escena | three 1x | Phoenyx 1x | three 4x | Phoenyx 4x |
|---|---|---|---|---|
| tex | 0,5 | 0,5 | 2,3 | 2,7 |
| inst | 0,4 | 0,4 | 1,4 | 2,5 |
| modelos | 1,3 | 0,5 | 7,1 | 3,0 |

`modelos` (la más cercana al juego): Phoenyx es 2,4x más rápido. `inst` y `tex` son más lentas en 4x por el empaquetado en JS por fotograma (fase 8).
Los contadores de `modelos` difieren (three 62 llamadas / 60350 triángulos, Phoenyx 33 / 31392) con imagen idéntica: se trata como diferencia de conteo, sin investigar más.

## Límites conocidos
- Sin wireframe, `envMap`, extras de `MeshPhysicalMaterial`, `Points`/`Sprite`/`Line`, `SkinnedMesh` (fase 5) ni sombras (fase 3).
- `metalnessMap` distinto de `roughnessMap` no se soporta; `alphaToCoverage` se ignora.
- Sin `shadowMap`, `setAnimationLoop`, `setRenderTarget`, `getDrawingBufferSize`, `getContext`, `forceContextLoss`, ni recuperación de pérdida de GPU / respaldo sin WebGPU.
- Asignaciones por fotograma en `pack.ts` (fase 8); la reserva de instancias no se libera al crecer.
- Aviso de Chrome sobre timestamp-writes sin resolver.

## Revisión final (Sonnet) y correcciones
Corregido: geometría sin `position` o vacía (se omite), materiales sin `color` (aviso y se omiten), imagen con CORS que no se puede leer (aviso, no cae el fotograma), texturas mayores de 8192 (se reducen), bit de mapa solo con imagen cargada, `dispose` repetido (un solo descuento), versión de atributos interleaved, colores de instancia con menos elementos que `count`, `forceSinglePass`.
Aplazado: RGB perdido bajo alfa bajo (el canvas 2D premultiplica; decodificar con `createImageBitmap({premultiplyAlpha:'none'})`, fase 8); `DataTexture` float / half-float / 1 canal (se avisa, resultado no fiable); `ImageBitmap` con `flipY` (three lo ignora).
