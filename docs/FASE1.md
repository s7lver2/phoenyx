# Fase 1: núcleo (estado)

Paquete `packages/phoenyx` (API de three 0.160.1) + crate `crates/phoenyx-gl` (WebGPU). Banco: `web/fidelity/` (sala escrita una vez con la API de three, empaquetada con `three` real y con `three` → `phoenyx`) y `tools/fidelity/`.

## Qué hay
- **Código de three copiado sin tocar** (`tools/sync-three.mjs`, 72 archivos, MIT): matemáticas, `Object3D`, `Group`, `Scene`, `Fog`, `FogExp2`, cámaras, `BufferGeometry`, atributos, `Mesh`, materiales y luces (como clases de datos), `BoxGeometry`, `PlaneGeometry`, `Raycaster`, `Clock`…
- **`WebGLRenderer`** (`src/renderer.ts`, `src/pack.ts`): `ready`, `setSize`, `setPixelRatio`, `setClearColor`, `toneMapping` (ACES), `toneMappingExposure`, `outputColorSpace`, `info`, `render`, `dispose`. Recorre el grafo con las reglas de `projectObject` y `WebGLRenderLists` de three (visibilidad, capas, frustum, orden: opacos por grupo, `renderOrder`, material, z; transparentes por grupo, `renderOrder`, z invertida; transparentes de doble cara en dos pasadas; caras invertidas con determinante negativo).
- **Sombreado portado de three** (`crates/phoenyx-gl/src/shader.wgsl`): `MeshBasicMaterial`; `MeshStandardMaterial` (Lambert + GGX, Smith correlacionado, Schlick, rugosidad con derivadas de la normal), luces puntual (con y sin corte), direccional y ambiente, emisivo, niebla lineal y exponencial (color en el espacio de salida, como `refreshFogUniforms`), ACES filmic y OETF sRGB. Orden de salida igual que three: tone mapping, color, niebla.

## Formatos entre TypeScript y Rust
| Array | Contenido |
|---|---|
| `globals` (64 floats) | view 16, proj 16, cámara xyz + exposición, tone mapping / modo de niebla / near / far, color de niebla + densidad, fondo rgba, tamaño + nº de luces, ambiente rgb |
| `objects` (32 floats/dibujo) | matriz mundo 16, matriz normal (vista) en 3 columnas de 4, relleno |
| `materials` (12 floats) | color rgb + opacidad, emisivo·intensidad rgb + rugosidad, metalicidad + tipo (0 Basic, 1 Standard) + niebla |
| `lights` (16 floats) | tipo (0 direccional, 1 puntual) + color·intensidad, posición (vista) + distancia, decaimiento + dirección hacia la luz (vista) |
| `draws` (4 u32) | geometría, objeto, material, flags (bit 0 doble cara, 1 giro horario, 2 transparente, 3 escribe profundidad, 4 prueba de profundidad, 5 FLIP_SIDED, 6 DOUBLE_SIDED) |

## Resultado de fidelidad (punto de control 1)
Mismas 6 escenas con three y con Phoenyx, 1280x720, sin antialiasing, ACES 0,72:

| Escena | media | máx | píxeles >8 |
|---|---|---|---|
| sala-basic (sin niebla) | 0 | 0 | 0 |
| sala-basic-exp (FogExp2) | 0 | 0 | 0 |
| sala-basic-lineal (Fog) | 0 | 0 | 0 |
| sala-sinniebla (Standard + 6 luces + direccional + ambiente) | 0 | 1 | 0 |
| sala-exp | 0 | 1 | 0 |
| sala-lineal | 0 | 1 | 0 |

Umbral: media < 1 y 0 píxeles de interior > 8: **aprobado con margen** (el error máximo es 1/255 en Standard por el orden de las operaciones en coma flotante).

## Rendimiento (la sala es muy pequeña: 19 dibujos, 208 triángulos)
Mediana de fotograma en tiempo real: three 0,4 ms (CPU 1x) y 1,4–1,6 ms (CPU 4x); Phoenyx 0,4 ms y 1,9–2,1 ms. Con esta escena no hay diferencia útil: el cuello es el empaquetado en JS por fotograma (se asigna por fotograma, sin cache de materiales ni objetos estáticos). Las mejoras (objetos estáticos subidos una vez, matrices sucias, lotes, culling en GPU) son de la fase 8, y la prueba que importa es una escena de Backrooms, no esta sala. Cifras en `fidelity/baseline/fase1-*/perf.json`.

## Límites conocidos (todo esto sigue en three y se porta en fases siguientes)
- Sin antialiasing (el juego usa `antialias: false` con SMAA en postproceso, fase 4), sin sombras, sin mapas de entorno ni texturas, sin `HemisphereLight`, `SpotLight` ni `RectAreaLight`.
- Sin `MeshPhysicalMaterial` (se dibuja como Standard), `Points`, `Sprite`, `Line`, `InstancedMesh`, `SkinnedMesh`, materiales múltiples por malla ni grupos de geometría (se avisa por consola una vez).
- Hasta 64 luces por fotograma (el agrupado en clusters es de la fase 8).
- Sin efectos sobre el fondo (`scene.background` solo como color).
- Tone mapping: solo ACES (el juego solo usa ese).
- Con `DoubleSide` y matriz mundo de determinante negativo la orientación de la normal usa el `front_facing` de WebGPU ya corregido por el giro, igual que three; no está probado.
- El renderer crea la GPU de forma asíncrona: el juego tendrá que esperar `renderer.ready` (cambio de una línea en la migración).

## Rulings tomados
- Los arrays usan relleno a vec4 (globals 64, objeto 32, material 12 floats) por el alineado de WGSL; el plan decía 52/28/20.
- El orden de los opacos es el real de three (por material antes que por distancia), no «de cerca a lejos» como decía el plan.
- Verificación solo con capturas comparadas (sin tests unitarios, regla del dueño).

## Cómo repetirlo
```
node tools/sync-three.mjs
cargo build -p phoenyx-gl --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir packages/phoenyx/pkg target/wasm32-unknown-unknown/release/phoenyx_gl.wasm
node tools/fidelity/build-harness.mjs
cd tools/fidelity
node capture.mjs --url http://localhost:5200/fidelity --scenes ../../web/fidelity/scenes.json --renderer three --out ../../fidelity/out/f1-three
node capture.mjs --url http://localhost:5200/fidelity --scenes ../../web/fidelity/scenes.json --renderer phoenyx --out ../../fidelity/out/f1-phoenyx
node compare.mjs --a ../../fidelity/out/f1-three --b ../../fidelity/out/f1-phoenyx --out ../../fidelity/out/f1-diff
```
