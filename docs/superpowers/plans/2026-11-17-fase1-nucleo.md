# Fase 1: núcleo (grafo de escena, cámaras, materiales Basic y Standard, luces, niebla, tone mapping). Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:executing-plans (ejecución nativa, elegida por el dueño) o superpowers:subagent-driven-development. Los pasos usan casillas (`- [ ]`). Revisores: nunca Opus (orden del dueño).

**Objetivo:** que una sala sencilla (paredes, suelo, techo, tubos fluorescentes, niebla) escrita con la API de three se renderice con Phoenyx igual que con three 0.160, medido con la herramienta de la fase 0.

**Arquitectura:** paquete TypeScript `packages/phoenyx` con las clases de three (código no gráfico copiado de three 0.160, MIT) y un `WebGLRenderer` con el mismo nombre que recorre el grafo y empaqueta objetos, materiales y luces en arrays tipados. Un crate Rust nuevo `phoenyx-gl` (wgpu → WASM) los dibuja con WGSL portado del sombreado de three (Basic, Standard, luces, niebla, ACES, sRGB). La comparación usa la misma escena escrita una sola vez y empaquetada con esbuild dos veces: `three` real y `three` → `phoenyx`.

**Tech Stack:** Rust 2024, wgpu 30.0.2, wasm-bindgen 0.2.130 (igual que `crates/phoenix`); TypeScript + esbuild; three 0.160.1 (referencia y fuente de la copia); Node 22 y `tools/fidelity` de la fase 0.

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md`

## Restricciones globales
- El aspecto es el de three 0.160.1: mismo orden de operaciones, constantes y espacio de color (trabajo en sRGB lineal; salida con tone mapping y conversión sRGB en el shader de material cuando se dibuja directo al canvas, como three sin composer). `useLegacyLights` es falso en 0.160: luces en unidades físicas (candelas, decaimiento 2).
- El juego crea su renderer principal con `antialias: false`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 0.72`: ese es el caso de referencia. El MSAA no entra en la fase 1.
- Umbral de aprobado: error medio < 1/255 y ningún píxel de interior por encima de 8/255 (`tools/fidelity/compare.mjs`).
- Un commit por función terminada; comentarios en español; sin tests unitarios (regla del proyecto). La verificación son las capturas comparadas.
- Cabecera de licencia de three (MIT) conservada en todo archivo copiado; `packages/phoenyx/LICENSE-three.txt`.
- Nada de Backrooms en esta fase: la sala de prueba vive en `E:\phoenix\web\fidelity\`. La rama `phoenyx-migracion` no se toca.
- El constructor de `WebGLRenderer` es síncrono como en three; la creación de GPU es asíncrona: `renderer.ready: Promise<void>`; `render()` antes de estar listo no hace nada.

## Review Focus
- Una `Matrix4` mal compuesta (orden, `matrixAutoUpdate`, `matrixWorldNeedsUpdate`) da objetos fuera de sitio que la sala sencilla no destapa: cubrir objetos anidados con escala y rotación.
- Luz puntual con `distance` 0 (sin corte) y con corte: la atenuación de three tiene un caso para cada uno.
- Niebla lineal y exponencial por separado; objetos con `material.fog = false`.
- Material con `transparent`, `opacity`, `side` (Front/Back/Double) y `depthWrite`: el orden de dibujo y la mezcla deben seguir las reglas de three (opacos de cerca a lejos, transparentes de lejos a cerca, `renderOrder` primero).
- Cambiar tamaño o `setPixelRatio` tras crear el renderer; perder el dispositivo GPU no debe dejar la pantalla negra sin aviso.

## Estructura de archivos
- `packages/phoenyx/` (nuevo): `package.json`, `tsconfig.json`, `LICENSE-three.txt`
  - `src/three/` (copia de three, generada por script): matemáticas, `Object3D`, `Group`, `Scene`, `Fog`, `FogExp2`, cámaras, `BufferGeometry`, `BufferAttribute`, `Layers`, `EventDispatcher`, `Color`, `Box3`…
  - `src/materials.ts`, `src/lights.ts`, `src/geometries.ts`: clases con la API de three, solo datos.
  - `src/renderer.ts`: `WebGLRenderer`; `src/pack.ts`: grafo → arrays tipados.
  - `src/index.ts`: reexporta con los nombres de three.
- `crates/phoenyx-gl/` (nuevo): `Cargo.toml`, `src/lib.rs` (dispositivo, geometrías, cola de dibujo), `src/shader.wgsl` (Basic y Standard).
- `tools/sync-three.mjs`: copia los archivos de three 0.160.1 listados en `tools/three-files.txt`.
- `tools/fidelity/build-harness.mjs`: empaqueta la sala dos veces con esbuild.
- `web/fidelity/room.js` (escena, usa `import * as THREE from 'three'`), `room.html`, `scenes.json`.
- `docs/FASE1.md`: estado, límites conocidos.

---

### Tarea 1: Paquete `phoenyx` con el código de three copiado

**Files:** crear `tools/sync-three.mjs`, `tools/three-files.txt`, `packages/phoenyx/{package.json,tsconfig.json,LICENSE-three.txt,src/three/**,src/index.ts}`.

**Interfaces:** Produces: `import * as THREE from 'phoenyx'` expone `Vector2|3|4, Matrix3|4, Quaternion, Euler, Color, Box3, Sphere, Plane, Frustum, MathUtils, Object3D, Group, Scene, Fog, FogExp2, PerspectiveCamera, OrthographicCamera, BufferGeometry, BufferAttribute, Float32BufferAttribute, Uint16/32BufferAttribute, Layers, EventDispatcher, Clock` con el comportamiento exacto de three 0.160.1 y las constantes `SRGBColorSpace, LinearSRGBColorSpace, ACESFilmicToneMapping, NoToneMapping, FrontSide, BackSide, DoubleSide`.

- [ ] **Paso 1:** `tools/three-files.txt` lista rutas relativas a `three/src` (math/*, core/Object3D, core/BufferGeometry, core/BufferAttribute, core/Layers, core/EventDispatcher, core/Clock, scenes/*, cameras/Camera|PerspectiveCamera|OrthographicCamera, objects/Group, constants.js, utils.js).
- [ ] **Paso 2:** `tools/sync-three.mjs` copia esos archivos desde `E:\backrooms\node_modules\three\src` a `packages/phoenyx/src/three/` con rutas intactas (sin reescribir código) y escribe la licencia. Se ejecuta: `node tools/sync-three.mjs`. Esperado: lista de archivos copiados; segunda ejecución sin cambios en git.
- [ ] **Paso 3:** `src/index.ts` reexporta lo listado en Interfaces. Comprobar con `npx esbuild packages/phoenyx/src/index.ts --bundle --format=esm --outfile=%TEMP%/p.js` y `node -e` que imprime `new Vector3(1,2,3).applyMatrix4(new Matrix4().makeRotationY(1))` igual que el `three` real. Esperado: mismos tres números.
- [ ] **Paso 4:** commit «Paquete phoenyx: código no gráfico de three 0.160.1».

### Tarea 2: Sala de prueba y referencia con three

**Files:** crear `web/fidelity/{room.js,room.html,scenes.json}`, `tools/fidelity/build-harness.mjs`; modificar `tools/fidelity/package.json` (devDependencies: `esbuild`, `three@0.160.1`).

**Interfaces:** Consumes: Tarea 1 (alias `three` → `phoenyx`). Produces: `web/fidelity/dist/three.js` y `phoenyx.js` (mismo `room.js`); `room.html?renderer=three|phoenyx&scene=<id>` con `canvas.br-gl` y `window.__capture = { ready, reseed(n), advance(n), info(), release() }` (el contrato de `capture.mjs`; `info()` devuelve `{drawCalls, triangles, geometries, textures}`); `scenes.json` con `{id, query, advance}` por escena.

- [ ] **Paso 1:** `room.js` construye, con solo API de three: sala 12×3×12 m con `BoxGeometry` finas (paredes, suelo, techo; `MeshStandardMaterial` amarillentos con distintos `roughness`/`metalness`), 6 tubos (`BoxGeometry` con `MeshBasicMaterial` emisivo) con `PointLight` bajo cada uno (`color` 0xfff2c0, `intensity` 14, `distance` 0 en tres y 9 en otras tres), una `DirectionalLight` tenue, un objeto anidado (`Group` rotado y escalado con 3 cubos hijos), un cubo con `MeshBasicMaterial` y `fog:false`, un plano `transparent`/`opacity` 0,5 doble cara; `Fog`/`FogExp2` por parámetro. Escenas en `scenes.json`: `sala-exp` (FogExp2 0,07), `sala-lineal` (Fog 3..25), `sala-sinniebla`. Renderer: `antialias:false`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 0.72`, 1280×720, pixelRatio 1. Cámara y animación fijas (nada depende del reloj).
- [ ] **Paso 2:** `build-harness.mjs` empaqueta `room.js` con esbuild dos veces (`--alias:three=three` real y `three=packages/phoenyx/src/index.ts`) a `dist/three.js` y `dist/phoenyx.js`.
- [ ] **Paso 3:** servir `web/` en el puerto 5200 (ya configurado en `.claude/launch.json` de Phoenix) y capturar con three: `node capture.mjs --url http://localhost:5200/fidelity --scenes ../../web/fidelity/scenes.json --out ../../fidelity/out/f1-three` (la herramienta añade `?<query>`; las queries llevan `renderer=three`). Dos ejecuciones seguidas y `compare.mjs` entre ellas. Esperado: error 0 en las tres escenas.
- [ ] **Paso 4:** mirar las capturas: la sala debe verse (suelo, paredes, luces visibles, niebla). Commit «Sala de fidelidad de la fase 1 y referencia con three».

### Tarea 3: Crate `phoenyx-gl`: dibujo con material Basic

**Files:** crear `crates/phoenyx-gl/{Cargo.toml,src/lib.rs,src/shader.wgsl}`; modificar `Cargo.toml` del workspace (miembro).

**Interfaces:** Produces (wasm-bindgen): `create(canvas: HtmlCanvasElement) -> Promise<Gl>`; `Gl::resize(w: u32, h: u32)`; `Gl::set_geometry(id: u32, positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32])` (crea o reemplaza, `id` lo elige el anfitrión; `drop_geometry(id)`); `Gl::frame(globals: &[f32], objects: &[f32], materials: &[f32], lights: &[f32], draws: &[u32])` donde: `globals` = 52 floats (view 16, proj 16, posición de cámara 3, exposición, tone mapping modo, fog modo/color/near/far/density, color de fondo 4, ancho/alto, nº luces); `objects` = 16 floats por objeto (matriz mundo) + 12 (matriz normal 3×3 rellenada); `materials` = 20 floats por material (ver Tarea 4); `draws` = 4 u32 por dibujo `[geometry, object, material, flags]` en el orden final de pintado; `Gl::stats() -> Vec<f32>`; `Gl::is_lost()`. Targets: sRGB `Bgra8Unorm` del canvas (la conversión a sRGB y el tone mapping van en el shader, no en el formato), profundidad `Depth32Float`, sin MSAA.

- [ ] **Paso 1:** `Cargo.toml` igual que `phoenix` (wgpu 30.0.2 con `webgpu` y `wgsl`, wasm-bindgen =0.2.130, bytemuck, glam, web-sys, console_error_panic_hook). Esperado: `cargo check -p phoenyx-gl --target wasm32-unknown-unknown` sin errores.
- [ ] **Paso 2:** implementar dispositivo, superficie, depth, buffers de geometría por id (vértice 32 B: posición, normal, uv; índice u32) y un uniform/storage con globals, objetos y materiales; una pasada que limpia al color de fondo y dibuja la lista `draws` en orden.
- [ ] **Paso 3:** `shader.wgsl` con la función de salida de three portada línea a línea: `toneMapping` (ACES filmic de `tonemapping_pars_fragment`, con `exposure/0.6` y las matrices RRT/ODT), `linearToOutputTexel` (sRGB), y la mezcla de niebla de `fog_fragment` (`FogExp2`: `1 - exp(-d² · density² · depth²)`; lineal: `smoothstep(near, far, depth)`; depth = longitud en espacio de vista). Material Basic: color × opacidad, sin luces.
- [ ] **Paso 4:** compilar y generar bindings: `cargo build -p phoenyx-gl --target wasm32-unknown-unknown --release` y `wasm-bindgen --target web --out-dir packages/phoenyx/pkg target/wasm32-unknown-unknown/release/phoenyx_gl.wasm`. Esperado: `packages/phoenyx/pkg/phoenyx_gl.js` (git-ignorado salvo que el dueño diga lo contrario; el wasm se construye en local).
- [ ] **Paso 5:** commit «phoenyx-gl: dispositivo, geometrías y dibujo con material Basic, niebla y tone mapping».

### Tarea 4: `WebGLRenderer` y materiales/luces de datos; escena sin luces idéntica

**Files:** crear `packages/phoenyx/src/{renderer.ts,pack.ts,materials.ts,lights.ts,geometries.ts}`; modificar `src/index.ts`.

**Interfaces:** Consumes: Tarea 1 (grafo) y Tarea 3 (`Gl`). Produces: `class WebGLRenderer { constructor({canvas?, antialias?, alpha?, powerPreference?}); domElement; ready: Promise<void>; outputColorSpace; toneMapping; toneMappingExposure; setSize(w, h, updateStyle?); setPixelRatio(r); getPixelRatio(); setClearColor(c, a?); render(scene, camera); info: {render:{calls,triangles}, memory:{geometries,textures}, autoReset, reset()}; dispose() }`; `MeshBasicMaterial({color, opacity, transparent, side, fog, depthWrite, depthTest, wireframe no})`; `MeshStandardMaterial({color, roughness, metalness, emissive, emissiveIntensity, opacity, transparent, side, fog, depthWrite})`; `Mesh(geometry, material)` con `renderOrder`, `frustumCulled`; `BoxGeometry`, `PlaneGeometry` (código copiado de three, añadidos a `three-files.txt`); `PointLight(color, intensity, distance, decay)`, `DirectionalLight(color, intensity)` con `target`, `AmbientLight(color, intensity)`, `HemisphereLight(sky, ground, intensity)`.

- [ ] **Paso 1:** `pack.ts`: `scene.updateMatrixWorld()`, recorrido con `visible`/`layers` de la cámara, `frustumCulled` contra `Frustum` de la cámara con `geometry.boundingSphere` (copia de la lógica de three), lista opaca (de cerca a lejos por `z` de vista, con `renderOrder` primero) y transparente (de lejos a cerca) con las mismas reglas de `WebGLRenderLists` de three 0.160; empaqueta objetos, materiales (20 floats: color rgb, opacity, roughness, metalness, emissive rgb·intensity, flags side/transparent/fog/depthWrite/depthTest, tipo) y luces; convierte colores a lineal (`Color` ya trabaja en lineal con `ColorManagement` de three).
- [ ] **Paso 2:** `renderer.ts`: ids de geometría estables (`WeakMap`), subida solo cuando cambia `attribute.version`, `render()` empaqueta y llama `gl.frame`; `info` cuenta llamadas y triángulos; pérdida del dispositivo: `console.error` y `ready` rechazada.
- [ ] **Paso 3:** verificar con la sala sin luces ni Standard: añadir a `scenes.json` la escena `sala-basic` (todo `MeshBasicMaterial`, con niebla y sin ella) y comparar `f1-three` contra `f1-phoenyx` (`--url .../fidelity` con `renderer=phoenyx`). Esperado: `compare.mjs` ok en `sala-basic`; si falla, abrir el `-diff.png` y corregir niebla, tone mapping o color antes de seguir.
- [ ] **Paso 4:** commit «WebGLRenderer de Phoenyx: grafo a GPU con material Basic».

### Tarea 5: Material Standard y luces puntual, direccional y ambiente

**Files:** modificar `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}`, `packages/phoenyx/src/{pack.ts,lights.ts}`.

**Interfaces:** Consumes: Tareas 3 y 4. Produces: luces de `lights` como 16 floats por luz `[tipo, r, g, b, x, y, z, distancia, decaimiento, dx, dy, dz, 0, 0, 0, 0]` en espacio de vista (como three: posición/dirección transformadas por la matriz de vista), máximo 64 en esta fase (aviso por consola si se pasa; el agrupado en clusters es de la fase 8).

- [ ] **Paso 1:** portar a WGSL, en este orden y con los nombres de three en comentarios: `getDistanceAttenuation` (cutoff 0 → solo `1/pow(d, decay)` con `max(d,0.01)`; con `distance`: la ventana `pow(saturate(1 - (d/cutoff)^4), 2)`), `BRDF_GGX` (`D_GGX`, `V_GGX_SmithCorrelated`, `F_Schlick`), `BRDF_Lambert`, luz ambiente e irradiancia hemisférica (ambiente = `ambientLightColor * BRDF_Lambert(diffuse)`), `RE_Direct_Physical` y el emisivo; `F0` = `mix(0.04, color, metalness)`; `roughness` acotada como en three (`max(roughness, 0.0525)` y `+ geometryRoughness`).
- [ ] **Paso 2:** `pack.ts` recoge las luces visibles del grafo, ordena por tipo como three (direccionales, puntuales) y rellena el array; `distance`/`decay` de `PointLight` por defecto 0 y 2.
- [ ] **Paso 3:** verificar: `sala-sinniebla`, `sala-lineal` y `sala-exp` con `phoenyx` frente a `three`. Esperado: `compare.mjs` ok en las tres. Si fallan, comparar primero una sola luz y un solo material (reducir `room.js` con `?lights=1`) para aislar la BRDF de la atenuación.
- [ ] **Paso 4:** commit «Phoenyx: MeshStandardMaterial con luces puntual, direccional y ambiente».

### Tarea 6: Punto de control 1

**Files:** crear `docs/FASE1.md`, `fidelity/baseline/fase1-*` (solo `perf.json`).

- [ ] **Paso 1:** ejecutar las tres escenas completas con los dos renderers y la herramienta de comparación; guardar el informe y `perf.json` de ambos (CPU de envío por fotograma, llamadas, fotograma real a CPU 1x y 4x).
- [ ] **Paso 2:** `docs/FASE1.md`: qué está hecho, qué diferencias quedan (mapa de diferencias), límites conocidos (sin MSAA, sin sombras, sin mapa de entorno, 64 luces, sin transparencias ordenadas por objeto dentro del mismo `renderOrder` más allá de lo que hace three), tiempos medidos.
- [ ] **Paso 3:** commit y push en `E:\phoenix`. Mostrar al dueño las capturas lado a lado, los mapas de diferencias, el informe de error y las cifras de CPU. Esperar su visto bueno antes del plan de la fase 2.

## Planes siguientes (no incluidos aquí)
Fase 2 (geometrías, `CanvasTexture`, `GLTFLoader`, instancias) se planifica tras este punto de control con lo aprendido sobre empaquetado y rendimiento del envío.
