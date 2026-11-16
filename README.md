# Phoenix (nombre en clave)

Motor para juegos en la web, en Rust + WebGPU (`wgpu`) compilado a WASM. Criterio de desempate en cada decision: la opcion mas eficiente.
Pensado primero para el juego Backrooms (`E:/backrooms`), pero sin depender de el.

## Decisiones
- Solo WebGPU. Quien no lo tenga sigue con el renderer three.js de Backrooms.
- Render GPU-driven: culling, eleccion de LOD y generacion de draws en compute; draws indirectos (pocas decenas, no cientos).
- Migracion por escena: Phoenix convive con three.js hasta que merezca la pena mover cada nivel.
- Orden de trabajo: 1 render, 2 pipeline de assets (bake offline a clusters), 3 nucleo de simulacion (ECS, determinista, nativo + WASM), 4 IA.
- Sin tests salvo peticion, un commit por feature, nunca push sin permiso. Comentarios en espanol.
- Vercel: solo estaticos. El `.wasm` se compila en local y se versiona/copia al cliente.

## Estado
**M0** (commits anteriores): culling y LOD de una malla en GPU, draws indirectos, timestamps de GPU.

**M1 (demo avanzada):**
- `phoenix-bake` (nativo): genera 8 modelos procedurales de 327.680 triangulos (`--sub 8` = 1,3 M) con relieve de fbm, 6 LOD por modelo con `meshopt` (simplificacion con error absoluto, orden de cache, bloques de vertices compactos), vertices de 12 B (pos snorm16 + normal octaedrica).
- Runtime: LOD por error en pantalla (px) con la tabla de errores del bake, frustum culling, y generacion de draws en 3 pasadas de compute (count, scan, scatter). `first_instance` indirecto indexa un unico buffer de visibles. 48 draws indirectos por frame, constante.
- Demo: `web/index.html` (piloto automatico; `F` = vuelo libre con WASD).

Medido (RTX Lovelace, Chrome, 1280x720, vsync 180 Hz):

| instancias | tris a resolucion completa | tris dibujados | GPU cull+render | CPU submit |
|---|---|---|---|---|
| 160 k | 6,0 G | 6,2 M | 0,53 ms | 0,25 ms |
| 1 M | 35,5 G | 11,6 M | 1,5 ms | 0,26 ms |

Los timestamps de Chrome se cuantizan, tomalos como orden de magnitud. No esta comparado todavia con el renderer three.js de Backrooms.

```
cargo run --release -p phoenix-bake -- --sub 7 --models 8 --out web/assets   # una vez (web/assets esta en .gitignore)
cargo build --release --target wasm32-unknown-unknown -p phoenix
wasm-bindgen --target web --out-dir web/pkg target/wasm32-unknown-unknown/release/phoenix.wasm
python -m http.server 5200 --directory web     # http://localhost:5200/?n=1000000
```
Requiere `wasm-bindgen-cli` 0.2.130 (`cargo install wasm-bindgen-cli --version 0.2.130`).

## Siguiente
Jerarquia de clusters (DAG de LOD por cluster) en vez de LOD por instancia, culling por oclusion (Hi-Z), cargar glTF reales, materiales/texturas, sombras, post-proceso, integracion en Las Suites y medir contra el renderer actual.
