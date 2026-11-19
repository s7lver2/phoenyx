# Phoenyx

Motor de render para juegos en la web, en Rust + WebGPU (`wgpu`) compilado a WASM, con la API de three.js (0.160) para que un juego three pueda cambiar de motor sin reescribirse. Es el motor de Backrooms. Desde 2026-11-19 es **el único motor**: lo que fue «Phoenix» (render GPU-driven) quedó dentro de él como culling y LOD en GPU, y su código antiguo está solo en el historial de git.

## Qué incluye

- **`crates/phoenyx-gl` + `packages/phoenyx`:** el renderer (WebGPU, iluminación y sombreado del modelo de three, post-proceso, materiales de usuario). Los `InstancedMesh` con `userData.gpuLods` pasan por culling de frustum, descarte por tamaño y elección de LOD por error en pantalla en un compute (`gpu_cull.*`); el dibujo es el normal. `renderer.gpuDriven = false` lo apaga.
- **`phoenyx-bake`** (`crates/phoenyx-bake`): CLI que convierte GLB en paquetes con 10 LOD y texturas PBR (formato propio, ver [docs/ASSETS.md](docs/ASSETS.md)). Los LOD de los modelos de Backrooms los hornea `tools/bake_lods.mjs` del juego.
- **`phoenyx-lux`** (`crates/phoenyx-lux`): iluminación independiente y opcional (PBR GGX, cascadas, clustering de luces); por ahora no está conectada al renderer, la iluminación por defecto es la legacy.
- **`phoenix-ai`** (`crates/phoenix-ai`): utilidad aparte, base de IA (RNG, rejilla de navegación, percepción).
- **`tools/fidelity`:** banco de capturas y medidas contra three.

## Documentación

| Documento | Contenido |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Crates, culling y LOD en GPU |
| [docs/LUX.md](docs/LUX.md) | La librería de iluminación |
| [docs/ASSETS.md](docs/ASSETS.md) | Bake de modelos y LOD |
| [docs/FIDELIDAD.md](docs/FIDELIDAD.md) | El banco de fidelidad |
| [docs/RENDIMIENTO.md](docs/RENDIMIENTO.md) | Mediciones |
| [docs/IA.md](docs/IA.md) | `phoenix-ai` |
| [docs/LIMITACIONES.md](docs/LIMITACIONES.md) | Lo que no hace |
| [docs/FASE9.md](docs/FASE9.md) | La fusión de Phoenix en Phoenyx |

## Compilar

Requiere Rust (target `wasm32-unknown-unknown`) y `wasm-bindgen-cli` 0.2.130.

```
cargo build -p phoenyx-gl --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/phoenyx/pkg target/wasm32-unknown-unknown/release/phoenyx_gl.wasm
node tools/fidelity/build-harness.mjs
```

## Reglas del proyecto

Sin tests unitarios (se verifica con capturas de fidelidad y medidas), un commit por función terminada, comentarios del código en español.
