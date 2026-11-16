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

## M0 (hecho): demo de culling + LOD en GPU
`crates/phoenix`: N instancias de icosfera con 3 LOD (5120/320/80 tris), frustum culling y LOD por distancia en un compute shader, 3 `draw_indexed_indirect`. El CPU solo sube una matriz y los argumentos por frame. Contadores leidos con readback asincrono.

Medido en RTX (Lovelace), Chrome embebido, 1280x720: 2.000.000 instancias, ~6,6 M triangulos, 3 draws, ~0,24 ms de CPU de submit, 180 fps (tope de vsync).

```
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir web/pkg target/wasm32-unknown-unknown/release/phoenix.wasm
python -m http.server 5200 --directory web     # http://localhost:5200/?n=2000000
```
Requiere `wasm-bindgen-cli` 0.2.130 (`cargo install wasm-bindgen-cli --version 0.2.130`).

## Siguiente
Mallas reales (glTF) en vez de icosferas, jerarquia de clusters (DAG de LOD) con `meshopt`, culling por oclusion (Hi-Z), materiales/texturas, sombras, post-proceso.
