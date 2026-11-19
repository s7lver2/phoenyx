# Fusión de Phoenix en Phoenyx: plan de implementación

> **Para quien ejecute:** usar superpowers:executing-plans (o subagent-driven-development). Los pasos usan casillas `- [ ]`. Regla del proyecto: sin tests unitarios; se verifica con capturas de fidelidad (`tools/fidelity`) y medidas.

**Objetivo:** un solo motor, Phoenyx, que incluya el culling+LOD GPU, el bake de modelos en el build y lux (aparte y opcional); borrar Phoenix al final.

**Arquitectura:** Phoenyx sigue siendo la capa three.js (`packages/phoenyx` + `crates/phoenyx-gl`) con la iluminación legacy intacta. El código de `crates/phoenix` pasa a ser un módulo `gpu_driven` dentro de `phoenyx-gl` que usa el mismo `Device`/`Queue`/superficie, dibuja en el mismo buffer HDR y profundidad (`Depth32Float`, igual en ambos), y se activa solo para los `InstancedMesh` marcados. `lux` pasa a `crates/phoenyx-lux`, opcional. `phoenix-bake` pasa a `crates/phoenyx-bake` y se invoca desde el build del juego.

**Tecnología:** Rust 2024, wgpu 30.0.2, wasm-bindgen =0.2.130, meshopt (bake), TypeScript/esbuild, vite (juego en `E:\backrooms\client`).

**Spec:** `docs/superpowers/specs/2026-11-19-fusion-phoenix-en-phoenyx-design.md`

## Restricciones globales
- La iluminación legacy y los materiales de usuario no cambian; las capturas de fidelidad (`level0-inicio` 0,019; `level0-semilla7` 0,012; escenas sintéticas con solo los fallos conocidos de `docs/FASE8.md`) no empeoran.
- Rendimiento de CPU del juego: paridad o mejor (medir con `profile.mjs` a 4x, preset high: level0-inicio ≤ 49,6 ms, suites ≤ 105 ms).
- Instancias del camino GPU: solo rotación en Y, modelo normalizado a esfera unidad, UV en [0,1], un material por modelo (limitación de Phoenix).
- Un commit por tarea terminada, con la firma `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; comentarios en español.

## Review Focus
- Una escena con 0 objetos marcados para el camino GPU: no debe crear buffers ni costar nada por fotograma.
- Pérdida de contexto WebGPU (`isContextLost`) con el módulo GPU activo: no debe lanzar excepciones.
- Redimensionar el lienzo con el camino GPU activo: el Hi-Z y los buffers de profundidad deben reconstruirse.
- Un modelo del juego con varios materiales o UV fuera de [0,1]: debe quedarse en el camino normal, no dibujarse mal.
- Desactivar el camino GPU (flag) debe dar exactamente la imagen de hoy.

---

### Tarea 1: Workspace y nombres (Fase A)

**Archivos:** `Cargo.toml`, `crates/*`, `README.md`, `docs/ARQUITECTURA.md`.

**Interfaces:** Produce: workspace con miembros `phoenyx-gl`, `phoenyx-lux` (antes `lux`), `phoenyx-bake` (antes `phoenix-bake`); `phoenix-ai` se queda como está y se anota en la doc como utilidad aparte.

- [ ] **Paso 1:** renombrar con `git mv` `crates/lux` → `crates/phoenyx-lux` y `crates/phoenix-bake` → `crates/phoenyx-bake`; actualizar `name` en sus `Cargo.toml` y las dependencias de `crates/phoenix`. Esperado: `cargo check --workspace --target wasm32-unknown-unknown` sin errores (el bake es nativo: `cargo check -p phoenyx-bake`).
- [ ] **Paso 2:** actualizar `README.md` y `docs/ARQUITECTURA.md` para decir «Phoenyx» como único nombre del motor. Commit.

### Tarea 2: Culling y LOD en GPU dentro de `phoenyx-gl` (Fase A/B) — REVISADA

**Ruling (2026-11-19):** el sombreado de Phoenix (lux) no se copia. De Phoenix solo se reutiliza la idea de culling + elección de LOD en compute; el dibujo lo hace Phoenyx con su fragment shader legacy (mismo aspecto, lightmap incluido). Decisión del dueño: «adapta el sombreado de phoenix para que use también el legacy».

**Archivos:** crear `crates/phoenyx-gl/src/gpu_cull.rs` y `gpu_cull.wgsl`; modificar `crates/phoenyx-gl/src/lib.rs` (`frame`, creación de dispositivo con `INDIRECT_FIRST_INSTANCE`, bind group 0 con `gpu_vis`) y `shader.wgsl` (`vs`).

**Interfaces:**
- Dibujo marcado con el bit 8192 de `flags` (palabra 3 de un dibujo de `draws`): `draw_indexed_indirect` con el slot de argumentos en la palabra 10; en `vs`, `k = gpu_vis[draws[di*3+2].y + k]` (palabra 9 = base en `gpu_vis`).
- `frame(..., gpu_groups: &[f32])`: por grupo 16 floats `[obj, inst_offset, count, lod_count, slot0, vis_base, radius, 0, cx, cy, cz, tau_scale, err0, err1, err2, err3]`; Rust escribe los argumentos indirectos de cada (grupo, LOD) en CPU con `instance_count = 0` y `first_instance = índice_de_dibujo << 16`, y el compute suma con `atomicAdd` y rellena `gpu_vis`.
- Compute `cull`: una invocación por instancia; frustum (planos de view·proj), tamaño mínimo, LOD = el más grueso cuyo error proyectado (px) ≤ tolerancia.

- [ ] **Paso 1:** pedir `INDIRECT_FIRST_INSTANCE` si el adaptador lo tiene (`gpu_ok`); sin él, `frame` ignora `gpu_groups` y los dibujos marcados salen por el camino normal (Review Focus).
- [ ] **Paso 2:** `gpu_cull.wgsl` + `gpu_cull.rs` (pipeline, buffers `gpu_args`, `gpu_vis`, `gpu_groups`, dispatch antes del pase principal).
- [ ] **Paso 3:** `vs` con remapeo y `frame` con `draw_indexed_indirect`; en sombras y en la pasada de normales los grupos GPU salen por el camino normal (LOD 0, todas las instancias).
- [ ] **Paso 4:** `cargo build --release` + `wasm-bindgen`; escenas de fidelidad sin cambios (sin grupos GPU). Commit.

### Tarea 3: Pasarela TypeScript y marca de objetos (Fase B) — REVISADA

**Archivos:** `packages/phoenyx/src/pack.ts`, `renderer.ts`.

**Interfaces:** Produce `InstancedMesh.userData.gpuLods: { geometry: BufferGeometry; error: number }[]` (el LOD 0 es la geometría del propio mesh, error 0) y `renderer.gpuDriven: boolean` (true por defecto). `pack` emite, por cada LOD, un dibujo con el bit 8192 y rellena `gpu_groups`.

- [ ] **Paso 1:** `pack` emite los dibujos de LOD y el registro del grupo; con `renderer.gpuDriven = false` o con matrices que no sean rotación Y + escala uniforme, el mesh sale por el camino normal.
- [ ] **Paso 2:** prueba en el harness con una escena sintética de 2 LOD visibles; con el flag apagado, capturas idénticas a las de hoy. Commit.

### Tarea 4: Bake en el build (Fase B)

**Archivos:** `crates/phoenyx-bake/src/main.rs`, nuevo `tools/bake-game.mjs`, `E:\backrooms\client\vite.config.ts` (plugin), `docs/ASSETS.md`.

**Interfaces:** Produce: `phoenyx-bake --kind glb --glb <lista> --tex N --out <dir>` (ya existe) ampliado con `--manifest <json>` que lista GLB y el nombre de modelo; y un plugin de vite `phoenyxBake()` que, en `vite build` (y en dev, solo si falta el paquete), ejecuta el bake y deja el paquete en `client/public/models/baked/`.

- [ ] **Paso 1:** elegir de `client/public/models/` los GLB aptos (una malla, una primitiva, un material, UV en [0,1]): mobiliario de Suites, tubos, cajas, papeleras. Los demás no se hornean (decisión de quien construya, anotada en el manifiesto).
- [ ] **Paso 2:** el plugin de vite invoca el binario y falla el build si el bake falla. Esperado: `npm run build` en `E:\backrooms` genera el paquete; `meta.json` lista los modelos del manifiesto. Commit.

### Tarea 5: Props del juego por el camino GPU (Fase B)

**Archivos:** `E:\backrooms\client\src\game\world.ts` (función `instanced` y `SUITE_PROPS`), `client\src\game\game.ts` (carga del paquete).

**Interfaces:** Consume `renderer.setModelPackage` y `userData.gpuModel` de la Tarea 3.

- [ ] **Paso 1:** el juego carga el paquete bakeado al arrancar y llama a `setModelPackage`. En `instanced()`, los props de la lista de aptos reciben `userData.gpuModel`.
- [ ] **Paso 2:** capturas de fidelidad de `level0-inicio`, `level0-semilla7` y una de Suites con el flag encendido y apagado; medir tris dibujados y tiempo de CPU/GPU con `profile.mjs`/`exp.mjs`. Esperado: sin diferencia visible fuera de tolerancia y CPU en paridad o mejor. Commit.

### Tarea 6: Distancia de dibujo y niebla (Fase B)

**Archivos:** `client/src/game/game.ts` (niebla y `camera.far`), `packages/phoenyx/src/renderer.ts` (`setFarTolerance`).

**Interfaces:** Produce: `renderer.gpuTolerance(px: number, farK: number)` que llama a `set_tolerance`/`set_far_tolerance`.

- [ ] **Paso 1:** con el LOD activo, subir la distancia de dibujo de los props en el nivel 0 y comprobar que el pasillo se siente largo y las entidades no aparecen de golpe. Medir antes y después. Commit.

### Tarea 7: Lux opcional (Fase C)

**Archivos:** `crates/phoenyx-lux/`, `crates/phoenyx-gl/src/lib.rs`, `packages/phoenyx/src/renderer.ts`.

**Interfaces:** Produce: `renderer.lighting: 'legacy' | 'lux'` (por defecto `'legacy'`); con `'lux'`, las luces se reparten con `Lux::cluster_cull` (16×9×24) y se evalúan por clusters solo en el camino GPU-driven; el camino three-compatible no cambia.

- [ ] **Paso 1:** integrar `Lux::new(device)`, `set_lights`, `fit_cascades` y los bind groups 3..7 en `gpu_driven`, detrás del flag. Con `'legacy'`, ni se crea.
- [ ] **Paso 2:** escena de prueba con 100+ luces en `web/fidelity`, midiendo GPU con `exp.mjs`; documentar cuándo conviene. Esperado: `'legacy'` da las mismas capturas que hoy. Commit.

### Tarea 8: Retirada de Phoenix (Fase D)

**Archivos:** borrar `crates/phoenix`, `web/phoenix.js`, páginas de demo que dependan de ellos; actualizar `Cargo.toml`, `README.md`, `docs/`.

- [ ] **Paso 1:** comprobar que ningún `import` ni miembro del workspace referencia `crates/phoenix` ni `web/phoenix.js` (`grep`), borrar y compilar todo (`cargo build --workspace`, `wasm-bindgen`, build del harness `tools/fidelity/build-harness.mjs`).
- [ ] **Paso 2:** pasar toda la batería de fidelidad y las medidas de CPU; escribir `docs/FASE9.md` con resultados. Commit y push.

## Cobertura del diseño
Fase A → Tareas 1–2; Fase B → 3–6; Fase C → 7; Fase D → 8. «Iluminación legacy intacta» → restricciones globales y Tarea 7 (`'legacy'` por defecto).
