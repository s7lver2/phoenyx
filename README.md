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
- Iluminacion: vive en su propia libreria, `crates/lux` (`lux::Lux` + `lux.wgsl`). PBR GGX, sol con sombras en 2 cascadas (PCF con disco rotado, mezcla entre cascadas, bias por pendiente), luna, ambiente segun la hora y hasta 512 luces (puntuales, focos y tubos fluorescentes) con culling por clusters 16x9x24 en compute. Phoenix solo renderiza cada cascada y enlaza el grupo 3. Limitaciones: solo proyectan sombra las instancias de las cascadas alrededor de la camara; las luces no tienen sombra; sin AO en pantalla ni GI.
- Post-proceso (`post.wgsl`): la escena se renderiza a HDR (Rgba16Float) en lineal; despues AO en espacio de pantalla (12 muestras, patron 4x4 + desenfoque que respeta bordes), bloom (4 reducciones con umbral) y composicion con exposicion + ACES + gamma (`set_post`, `set_exposure`). El AO se aplica sobre la imagen final, no solo al ambiente.
- Culling: por chunks de 64 instancias (esfera por chunk, recalculada solo si cambian las instancias) y por oclusion Hi-Z con la profundidad del frame anterior (`set_occlusion`; conservador, 1 frame de retraso). En el vuelo por el pasillo: de 602.000 a 34.500 instancias visibles y de 3,9 ms a 1,0 ms de render.
- Rendimiento (demo, 1080p, 2.000.000 estatuas; GPU por etapa en ms, `H` muestra el HUD): pasillo = culling 0,2 / render 1,1-1,4 / sombras 0,66 / hiz+post 0,3-0,5; vista aerea = culling 0,7 / render 2,4 / sombras 0,2 / post 0,1. Optimizaciones medidas: culling por chunks (cull 1,7 -> 0,8 ms), Hi-Z (render 3,9 -> 1,0 ms en el pasillo), AO a media resolucion (post en primer plano 1,5 -> 1,1 ms), tolerancia del LOD creciente con la distancia (`set_far_tolerance`; vista aerea 17 M -> 10 M triangulos, render 3,9 -> 2,4 ms).
- Uso desde JS: `web/phoenix.js` (`supported`, `loadPackage`, `createEngine`, `light.*`, `watch`). La escena la genera el anfitrion y se pasa con `instances` / `set_instances` / `set_count`.
- Aun NO hay: LOD por cluster (esto es LOD discreto por instancia, no la jerarquia de clusters de Nanite), visibility buffer ni rasterizado de microtriangulos.

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
