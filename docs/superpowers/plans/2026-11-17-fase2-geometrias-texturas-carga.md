# Fase 2: geometrías, texturas, carga e instancias. Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:executing-plans (ejecución nativa) o superpowers:subagent-driven-development. Casillas `- [ ]`. Revisores: nunca Opus (orden del dueño); usar Sonnet.

**Objetivo:** que una escena con modelos del juego (GLB con meshopt), texturas de lienzo y de imagen, bump, normal, rugosidad, emisivo, colores por vértice, `alphaTest`, todas las geometrías que usa el juego e `InstancedMesh` se vea con Phoenyx igual que con three 0.160.1.

**Arquitectura:** igual que la fase 1 (paquete TypeScript `phoenyx` + crate `phoenyx-gl`). Se amplían: la sincronización de código copiado de three (geometrías, texturas, cargadores, utilidades de `examples/jsm`); el crate gana texturas con mipmaps y muestreadores, un bind group por material con hasta 5 texturas y buffers de instancias; el shader gana los chunks `map`, `color`, `alphatest`, `roughnessmap`, `emissivemap`, `normalmap` y `bumpmap`. El código de `jsm` se copia con la misma regla (sin reescribir) y sus importaciones de `three` se resuelven al alias.

**Tech Stack:** el de la fase 1; `three/examples/jsm` 0.160.1 (GLTFLoader, `MeshoptDecoder`, `BufferGeometryUtils`, `DecalGeometry`).

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md`. Estado de la fase anterior y pendientes: `docs/FASE1.md`.

## Restricciones globales
- Aspecto de three 0.160.1 (mismo orden de operaciones y constantes). Caso de referencia: `antialias:false`, sRGB, ACES, exposición 0,72.
- Umbral: error medio < 1/255 y ningún píxel de interior > 8/255 (`tools/fidelity/compare.mjs`). Con texturas se espera algo de diferencia por mipmaps y filtrado anisótropo; si el error supera el umbral se ajusta el algoritmo (no el umbral) y se anota en `docs/FASE2.md`.
- Un commit por función terminada; comentarios en español; sin tests unitarios (regla del dueño): verifican las capturas comparadas.
- Código copiado de three conserva la licencia MIT; no se edita a mano (se regenera con `tools/sync-three.mjs`).
- Sin Backrooms: las escenas viven en `web/fidelity/`; los GLB y texturas de prueba se leen de `E:\backrooms\client\public\models` (servidos por el servidor estático de `web/` con una ruta `/models` → carpeta del juego; no se copian al repositorio de Phoenix).
- Alcance del juego medido en `client/src`: `map` (83 usos), `bumpMap` (8), `roughnessMap` (7), `emissiveMap` (6), `normalMap` (4), `vertexColors` (6), `alphaTest` (3), `CanvasTexture` (50), `DataTexture` (2), `TextureLoader` (4), `InstancedMesh` (12; `setMatrixAt` 16, `instanceColor` 6), `GLTFLoader` + meshopt (23), `wireframe` (2). Fuera de esta fase: `envMap` y `MeshPhysicalMaterial` extra (clearcoat, sheen; fases 4 y 6), `Points`, `Sprite`, `LineSegments` (fase 7), `SkinnedMesh` (fase 5), sombras (fase 3).
- El juego importa `three/examples/jsm/...`: el alias de la migración debe cubrir también esas rutas; este plan deja esos archivos en `packages/phoenyx/src/jsm/` con las mismas rutas relativas.

## Review Focus
- Texturas `CanvasTexture` que se modifican después de usarse (`needsUpdate = true`) y texturas compartidas entre materiales: deben resubirse una vez y liberarse con `dispose`.
- `flipY`, `colorSpace` (sRGB frente a lineal para `normalMap`, `roughnessMap`, `bumpMap`) y `wrapS/wrapT`, `repeat`, `offset`, `rotation`: un error invierte o satura la imagen entera.
- Texturas no potencia de dos, de 1×1 o muy grandes (≥ 4096): mipmaps y límites del dispositivo.
- `InstancedMesh` con `count` menor que la capacidad, `instanceColor` ausente y matrices que cambian cada fotograma (`instanceMatrix.needsUpdate`).
- Geometrías sin `normal` o sin `uv`, índices `Uint16`/`Uint32` y atributos interleaved o cuantizados (GLB con meshopt): no deben dar NaN ni cuelgues.

## Estructura de archivos
- Ampliar `tools/sync-three.mjs` y `tools/three-files.txt` (+ lista `tools/three-jsm-files.txt`): geometrías completas, `Texture`, `CanvasTexture`, `DataTexture`, `Source`, `Cache`, `Loader`, `FileLoader`, `ImageLoader`, `TextureLoader`, `ImageBitmapLoader`, `LoadingManager`, `InstancedMesh` (ya), curvas, `Shape*`; `jsm`: `GLTFLoader`, `meshopt_decoder.module`, `BufferGeometryUtils`, `DecalGeometry`.
- `packages/phoenyx/src/textures.ts`: subida y caché de texturas (clave por `Source`/`version`), generación de mipmaps.
- `packages/phoenyx/src/pack.ts`, `renderer.ts`: texturas por material, instancias, `vertexColors`, `alphaTest`, `wireframe` (diferido si no cabe).
- `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}`: texturas, muestreadores, bind group por material, instancias.
- `web/fidelity/{models.js,models.html?}`: escenas de modelos (reutilizan `index.html` con `scene=...`).
- `docs/FASE2.md`.

---

### Tarea 1: Geometrías, cargadores y utilidades copiadas de three

**Files:** modificar `tools/sync-three.mjs`, `tools/three-files.txt`; crear `tools/three-jsm-files.txt`; regenerar `packages/phoenyx/src/three/**` y crear `packages/phoenyx/src/jsm/**`, `packages/phoenyx/src/three-exports.ts`.

**Interfaces:** Produces: `import * as THREE from 'phoenyx'` expone además `CylinderGeometry, SphereGeometry, CapsuleGeometry, CircleGeometry, ConeGeometry, RingGeometry, TorusGeometry, TubeGeometry, LatheGeometry, ExtrudeGeometry, ShapeGeometry, OctahedronGeometry, DodecahedronGeometry, IcosahedronGeometry, EdgesGeometry, WireframeGeometry, Shape, Path, curvas (CatmullRomCurve3, QuadraticBezierCurve3, CubicBezierCurve3, LineCurve3, CurvePath), Texture, CanvasTexture, DataTexture, TextureLoader, ImageLoader, FileLoader, ImageBitmapLoader, LoadingManager, Cache, InterleavedBuffer, InterleavedBufferAttribute, InstancedBufferAttribute`, y los módulos `phoenyx/jsm/loaders/GLTFLoader.js`, `.../libs/meshopt_decoder.module.js`, `.../utils/BufferGeometryUtils.js`, `.../geometries/DecalGeometry.js`, `.../utils/SkeletonUtils.js` (esta última para la fase 5).

- [ ] **Paso 1:** extender las listas y la regla de cierre de dependencias de `sync-three.mjs` a `examples/jsm` (las importaciones `from 'three'` de esos archivos se dejan tal cual: las resuelve el alias). `node tools/sync-three.mjs`. Esperado: lista de archivos copiados; segunda ejecución sin cambios en git.
- [ ] **Paso 2:** comprobar que el paquete empaqueta: `npx esbuild packages/phoenyx/src/index.ts --bundle --format=esm --outfile=%TEMP%/p.mjs` sin errores y que `import { GLTFLoader } from 'phoenyx/jsm/loaders/GLTFLoader.js'` resuelve con el alias `three` → `phoenyx`.
- [ ] **Paso 3:** verificar los vértices de cada geometría nueva frente a three real con un script de Node (para cada clase del listado, mismos parámetros que usa el juego: `position.array` y `index.array` idénticos). Esperado: igualdad exacta (es código copiado; el script confirma el empaquetado).
- [ ] **Paso 4:** commit «Phoenyx: geometrías, cargadores y utilidades de three copiados».

### Tarea 2: Subida de geometrías completa

**Files:** modificar `packages/phoenyx/src/renderer.ts`, `crates/phoenyx-gl/src/lib.rs`.

**Interfaces:** Consumes: Tarea 1. Produces: `Gl::set_geometry(id, positions, normals, uvs, colors, indices)` con `colors: &[f32]` (3 floats por vértice, vacío si no hay; el vértice pasa a 44 bytes: posición, normal, uv, color) y `Gl::frame(...)` con dibujos que llevan `first_index` y `count` (de `geometry.drawRange` y `groups`); normales calculadas con `computeVertexNormals()` cuando falten (como hace three para materiales con luz, que las exigen).

- [ ] **Paso 1:** subir `color` (`vertexColors`) y respetar `drawRange`; para geometrías sin `normal`, llamar a `geometry.computeVertexNormals()` antes de subir; atributos interleaved o normalizados/cuantizados leídos con `getX/getY/getZ` (ya soportado para posición, normal y uv).
- [ ] **Paso 2:** `groups` + `material[]`: un dibujo por grupo con su material (cierra el aviso de «materiales múltiples» de la fase 1).
- [ ] **Paso 3:** verificar con escena `geoms` (Tarea 6) más adelante; aquí solo `cargo build` y las 6 escenas de la fase 1 siguen con error máximo ≤ 1/255.
- [ ] **Paso 4:** commit «Phoenyx: colores por vértice, drawRange y materiales múltiples».

### Tarea 3: Texturas: subida, mipmaps y muestreo

**Files:** crear `packages/phoenyx/src/textures.ts`; modificar `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}`, `pack.ts`, `renderer.ts`.

**Interfaces:** Consumes: Tarea 2. Produces: `Gl::set_texture(id: u32, width: u32, height: u32, rgba: &[u8], srgb: bool, mips: bool)` (ya con el orden de filas de `flipY` aplicado) y `Gl::set_material_textures(material: u32, slots: &[u32], samplers: &[u32])`; `Gl::set_sampler(id, wrap_s, wrap_t, mag, min, anisotropy)`; materiales: array de 12 → 24 floats (`map`, `normalMap`, `roughnessMap`, `emissiveMap`, `bumpMap` + `uvTransform` por mapa en vec4 de escala/desplazamiento y rotación, `normalScale`, `bumpScale`, `alphaTest`, flags de qué mapas hay). `textures.ts`: `class TextureCache { id(texture: THREE.Texture): number; dispose(texture) }` que sube `CanvasTexture`/`Texture` con `image` en `HTMLCanvasElement | HTMLImageElement | ImageBitmap | OffscreenCanvas` y `DataTexture` con `Uint8Array`/`Float32Array` (se convierten a 8 bits).

- [ ] **Paso 1:** `textures.ts`: leer píxeles con un lienzo auxiliar (`getImageData`; `premultiplyAlpha` falso como three), invertir filas si `flipY`, elegir formato (`Rgba8UnormSrgb` si `colorSpace === SRGBColorSpace`, `Rgba8Unorm` si no), reenviar cuando cambia `texture.version`, liberar con el evento `dispose`.
- [ ] **Paso 2:** mipmaps: caja 2×2 en espacio lineal por pasada de cómputo o en CPU (el algoritmo exacto se decide con la escena `tex` de la Tarea 6 comparando contra el `generateMipmap` de Chrome; anotar el elegido en `docs/FASE2.md`). Muestreador: filtros de `magFilter/minFilter` de three (`LinearMipmapLinear` por defecto), `wrapS/wrapT` (`Repeat`, `ClampToEdge`, `MirroredRepeat`), `anisotropy` acotada por el dispositivo.
- [ ] **Paso 3:** bind group 1 por material con 5 texturas y 5 muestreadores (textura blanca de 1×1 por defecto en los huecos vacíos); `uvTransform` por mapa como `texture.matrix` de three tras `updateMatrix()`.
- [ ] **Paso 4:** shader: chunks `map_fragment` (`diffuseColor *= sampledDiffuseColor`; la textura sRGB ya llega lineal por el formato), `color_fragment` (`vertexColors`), `alphatest_fragment` (`discard` si `diffuseColor.a < alphaTest`; con `alphaToCoverage` se ignora), `roughnessmap_fragment` (canal G), `metalnessmap` (B, aunque el juego no lo usa), `emissivemap_fragment`, y aplicados también a `MeshBasicMaterial`.
- [ ] **Paso 5:** verificación parcial: escena `tex` de una sola pared con `CanvasTexture` en `map` (Tarea 6 la completa). Esperado: ok bajo el umbral; si no, ajustar mipmaps/muestreo.
- [ ] **Paso 6:** commit «Phoenyx: texturas con mipmaps, muestreadores y mapas de color, rugosidad y emisivo».

### Tarea 4: `normalMap` y `bumpMap`

**Files:** modificar `crates/phoenyx-gl/src/shader.wgsl`, `pack.ts`.

**Interfaces:** Consumes: Tarea 3. Produces: `normalScale: Vector2` y `bumpScale: number` por material; sin atributo de tangentes (three usa derivadas de pantalla cuando no hay tangentes).

- [ ] **Paso 1:** portar `normal_fragment_maps` con `perturbNormal2Arb` (`normalMap`, espacio tangente por derivadas `dpdx/dpdy` de la posición de vista y de las UV, `normalScale`, `faceDirection`) y `bumpmap_pars_fragment` con `dHdxy_fwd` / `perturbNormalArb` (`bumpScale`), tal cual están en `ShaderChunk` de three 0.160.1. Las derivadas se calculan antes de cualquier rama (control uniforme).
- [ ] **Paso 2:** verificar con la escena `tex` + paredes con `bumpMap` de lienzo (como `concreteTex` del juego) y un suelo con `normalMap`. Esperado: ok bajo el umbral.
- [ ] **Paso 3:** commit «Phoenyx: mapas de normales y de relieve».

### Tarea 5: `InstancedMesh`

**Files:** modificar `pack.ts`, `renderer.ts`, `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}`.

**Interfaces:** Consumes: Tarea 3. Produces: `Gl::set_instances(mesh: u32, matrices: &[f32], colors: &[f32])` (matrices 16 floats, colores 3 floats opcionales) y dibujos con `instance_count`; el vértice aplica `instanceMatrix` antes de la matriz del objeto y `instanceColor` multiplica el color difuso como `color_vertex`/`instancing` de three; la matriz normal usa `instanceMatrix` (three: `transformedNormal = mat3(instanceMatrix) * normal` con `normalMatrix`).

- [ ] **Paso 1:** subir `instanceMatrix`/`instanceColor` solo cuando cambia su `version` (`needsUpdate`), respetar `mesh.count`; el sorting usa `boundingSphere` del `InstancedMesh` (ya copiado; `computeBoundingSphere` se llama si es null).
- [ ] **Paso 2:** `frustumCulled` con la esfera de instancias; `InstancedMesh` con `count = 0` no genera dibujo.
- [ ] **Paso 3:** verificar con la escena `inst`: 400 cubos con matrices y colores distintos y una instancia con `count` a medias. Esperado: ok bajo el umbral y 1 dibujo por `InstancedMesh`.
- [ ] **Paso 4:** commit «Phoenyx: InstancedMesh con matrices y color por instancia».

### Tarea 6: Escenas de modelos y punto de control 2

**Files:** crear `web/fidelity/models.js` (escenas añadidas al `room.js` o módulo aparte), ampliar `web/fidelity/scenes.json`, `tools/fidelity/serve.mjs` (servidor estático con `/models` → `E:\backrooms\client\public\models`), `docs/FASE2.md`.

**Interfaces:** Consumes: Tareas 1–5. Produces: escenas `geoms` (todas las geometrías del juego en fila con `MeshStandardMaterial`), `tex` (paredes con `CanvasTexture` de color, bump y rugosidad, textura de imagen con `TextureLoader`, `vertexColors`, `alphaTest`), `inst` (instancias) y `modelos` (3 GLB reales del juego cargados con `GLTFLoader` + `MeshoptDecoder`: un prop, un personaje sin animar y una sala de `suites`).

- [ ] **Paso 1:** escribir las escenas con solo API de three; los GLB y texturas con rutas relativas `/models/...`; esperar a que carguen antes de `__capture.ready`.
- [ ] **Paso 2:** capturar con three (dos pasadas iguales, error 0) y con Phoenyx; comparar. Esperado: aprobado en las cuatro escenas. Si una falla, abrir el `-diff.png`, aislar el chunk responsable con una escena reducida y corregir antes de seguir.
- [ ] **Paso 3:** cifras de CPU y llamadas con la escena `modelos` (CPU 1x y 4x) para ambos renderers, a `fidelity/baseline/fase2-*/perf.json`.
- [ ] **Paso 4:** `docs/FASE2.md` (hecho, diferencias, límites, formato de materiales y de instancias, rulings) y commit.
- [ ] **Paso 5:** revisión final con un revisor Sonnet (no Opus), un solo pase de arreglos, commit y push. Mostrar al dueño las capturas lado a lado, los mapas de diferencias y las cifras. Esperar su visto bueno antes del plan de la fase 3.

## Planes siguientes (no incluidos aquí)
Fase 3 (sombras PCFSoft, `SpotLight`, `HemisphereLight`, `RectAreaLight`) se planifica tras este punto de control, con el formato de materiales y de luces ya estabilizado.
