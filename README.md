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
**M0:** culling y LOD de una malla en GPU, draws indirectos, timestamps de GPU.

**M1:** bake de modelos con cadena de LOD (meshopt), culling en 3 pasadas (count, scan, scatter), draws indirectos.

**M2 (demo cinematografica, ~55 s):** escaneos reales de Quixel Megascans (estatua Komainu de 2.000.006 triangulos y rocas), texturas PBR (base, normal, ORM) con mipmaps y anisotropia, suelo Megascans tileable, cielo atmosferico con nubes y montanas, 2.000.000 de estatuas en bloques con pasillos, planos de aproximacion a las estatuas.
- `phoenix-bake --kind glb --glb a.glb,b.glb --ground <dir> --out web/assets-ms`: importa glTF/GLB (con texturas de hasta 8192), centra/escala a esfera unidad, 10 niveles de LOD (simplificacion con error absoluto y "sloppy" para los niveles finales), vertices de 20 B (pos snorm16, normal y tangente octaedricas, UV unorm16), mips de las texturas.
- LOD por error en pantalla (1 px) con la tabla de errores del bake.
- Medido en el vuelo por el pasillo: ~918 G de triangulos a resolucion completa, ~17 M dibujados (antes de ampliar la cadena de LOD de 6 a 10 niveles se dibujaban ~893 M). GPU: culling ~0,7 ms, render ~2,2 ms con 460 k estatuas visibles.
- Aun NO hay: sombras, culling por oclusion (Hi-Z), LOD por cluster (esto es LOD discreto por instancia, no la jerarquia de clusters de Nanite), visibility buffer ni rasterizado de microtriangulos.

Los datos de Megascans (`assets-src/`, `web/assets-*/`) no se versionan: la licencia no permite redistribuir los originales. Se descargan de Fab con sesion iniciada.

```
cargo build --release -p phoenix-bake
./target/release/phoenix-bake --kind glb --glb <a.glb,b.glb,...> --tex 2048 --ground <dir-superficie> --out web/assets-ms
cargo build --release --target wasm32-unknown-unknown -p phoenix
wasm-bindgen --target web --out-dir web/pkg target/wasm32-unknown-unknown/release/phoenix.wasm
python -m http.server 5200 --directory web     # http://localhost:5200/   (F vuelo libre, H estadisticas, R reiniciar)
```
Requiere `wasm-bindgen-cli` 0.2.130.

## Siguiente
Hi-Z, jerarquia de clusters, sombras, libreria modular (`phoenix-render`, `phoenix-bake`, `phoenix-net`, `phoenix-sim`), motor multijugador (red, voz, desconexiones), integracion en Las Suites.
