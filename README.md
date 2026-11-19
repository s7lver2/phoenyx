# Phoenyx

> **Un solo motor: Phoenyx.** La capa compatible con three.js (`crates/phoenyx-gl` + `packages/phoenyx`) es la que ejecuta Backrooms. El render GPU-driven (`crates/phoenix`, hoy en proceso de integrarse) pasa a ser un módulo suyo; ver `docs/superpowers/specs/2026-11-19-fusion-phoenix-en-phoenyx-design.md`.

Motor de render para juegos en la web, en Rust + WebGPU (`wgpu`) compilado a WASM. Todo el trabajo por instancia (culling, LOD por error en pantalla, oclusión, generación de draws) ocurre en la GPU; la CPU solo sube la cámara y los datos que cambian. Criterio de desempate en cada decisión: la opción más eficiente.

Pensado primero para el juego Backrooms, pero sin depender de él. Alojable como estáticos (p. ej. Vercel): el `.wasm` se compila en local.

## Qué incluye

- **Render GPU-driven:** culling por chunks y por oclusión Hi-Z, LOD por error en pantalla con fundido, draws indirectos, render bundles. Probado con 2.000.000 de estatuas de 2 M de triángulos (~7–10 M dibujados) y con un interior de 125.000 piezas.
- **`lux`** (`crates/phoenyx-lux`): iluminación independiente. PBR GGX, sol con sombras en 2 cascadas, luna, hasta 512 luces (puntuales, focos, tubos fluorescentes) con clustering en compute y 4 focos con sombra.
- **Post-proceso:** buffer HDR, AO en pantalla, bloom, ACES.
- **`phoenyx-bake`:** CLI que convierte GLB en paquetes con 10 niveles de LOD y texturas PBR.
- **`phoenix-ai`** (`crates/phoenix-ai`): base de IA con RNG determinista, rejilla de navegación (BFS, A*, visión) y percepción; los algoritmos de comportamiento los pone el juego.
- **`web/phoenix.js`:** envoltorio JS (soporte, carga, creación, luces, vigilancia de GPU).

## Documentación

| Documento | Contenido |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Crates, orden del frame, culling y LOD, formatos, bind groups |
| [docs/API.md](docs/API.md) | API de JS y del objeto del motor |
| [docs/LUX.md](docs/LUX.md) | La librería de iluminación y cómo integrarla |
| [docs/ASSETS.md](docs/ASSETS.md) | `phoenyx-bake`, formato del paquete, piezas modulares |
| [docs/RENDIMIENTO.md](docs/RENDIMIENTO.md) | Mediciones y mejoras |
| [docs/INTEGRACION.md](docs/INTEGRACION.md) | Qué usa Backrooms de three.js y cómo se reparte con Phoenix |
| [docs/IA.md](docs/IA.md) | `phoenix-ai`: base de IA (RNG, navegación, percepción) |
| [docs/LIMITACIONES.md](docs/LIMITACIONES.md) | Lo que no hace y lo pendiente |

## Compilar y ejecutar

Requiere Rust (target `wasm32-unknown-unknown`) y `wasm-bindgen-cli` 0.2.130.

```
cargo build --release --target wasm32-unknown-unknown -p phoenix
wasm-bindgen --target web --out-dir web/pkg target/wasm32-unknown-unknown/release/phoenix.wasm
cargo build --release -p phoenyx-bake
python -m http.server 5200 --directory web
```

- `web/index.html`: demo de exteriores (necesita un paquete en `web/assets-ms`, hecho con `phoenyx-bake` y escaneos propios). Teclas: `F` vuelo libre, `H` estadísticas, `L` panel de iluminación, `R` reiniciar.
- `web/suites.html`: interior tipo Las Suites con piezas procedurales (ver [docs/ASSETS.md](docs/ASSETS.md)).

## Estado

Demo funcional y motor usable por un anfitrión que genere sus instancias. **No es Nanite de verdad** (LOD discreto por instancia), no anima personajes con huesos y no está integrado en ningún juego todavía. Detalle en [docs/LIMITACIONES.md](docs/LIMITACIONES.md).

## Licencias y datos

Los escaneos de Quixel Megascans usados en la demo no se pueden redistribuir: `assets-src/` y `web/assets-*/` están en `.gitignore` y no forman parte del repositorio.

## Reglas del proyecto

Sin tests salvo petición, un commit por función terminada, comentarios del código en español.
