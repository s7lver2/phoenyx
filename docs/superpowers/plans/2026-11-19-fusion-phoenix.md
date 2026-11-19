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

### Tarea 2: Módulo `gpu_driven` sobre el dispositivo compartido (Fase A)

**Archivos:** crear `crates/phoenyx-gl/src/gpu_driven/{mod.rs,cull.wgsl,hiz.wgsl,draw.wgsl}`; mover de `crates/phoenix/src/` el culling, `pick`, Hi-Z y el dibujo indirecto; `crates/phoenyx-gl/Cargo.toml` (dependencia `phoenyx-lux`, opcional).

**Interfaces:**
- Produce: `pub struct GpuDriven` con
  - `GpuDriven::new(device: &wgpu::Device, hdr: wgpu::TextureFormat, depth: wgpu::TextureFormat) -> GpuDriven`
  - `set_models(&mut self, device, queue, pkg: &Package)` (paquete bakeado: verts, idx, texturas, `info`, `draws`)
  - `set_instances(&mut self, queue, first: u32, data: &[f32])` (8 floats por instancia, formato de `docs/ARQUITECTURA.md`)
  - `encode(&mut self, enc: &mut wgpu::CommandEncoder, view: &ViewParams, color: &wgpu::TextureView, depth: &wgpu::TextureView)` que añade culling + pase de dibujo al encoder de Phoenyx
  - `resize(&mut self, device, w: u32, h: u32)`
- Consume: el `Device`/`Queue` de `Gl` (`crates/phoenyx-gl/src/lib.rs`, función `create`).

- [ ] **Paso 1:** extraer de `crates/phoenix/src/lib.rs` (struct `Phoenix`, 1288 líneas) lo que no es cielo/suelo/post-proceso/ventana: buffers de instancias, `chunk_build`/`count`/`scan`/`scatter`, tabla de modelos, args indirectos, Hi-Z, bundle de dibujo. Los shaders WGSL se copian a `gpu_driven/` sin cambios de lógica.
- [ ] **Paso 2:** el pase de dibujo escribe en el color HDR y profundidad que se le pasan (los de Phoenyx), con `LoadOp::Load`; no crea superficie ni cielo/suelo/post (los de Phoenyx mandan).
- [ ] **Paso 3:** con la lista de instancias vacía, `encode` no hace nada. Esperado: `cargo build -p phoenyx-gl --release --target wasm32-unknown-unknown` y `wasm-bindgen` sin errores; escenas de fidelidad sin cambios. Commit.

### Tarea 3: Pasarela TypeScript y marca de objetos compatibles (Fase B)

**Archivos:** `packages/phoenyx/src/pack.ts`, `renderer.ts`, nuevo `packages/phoenyx/src/gpuDriven.ts`.

**Interfaces:**
- Produce: `WebGLRenderer.setModelPackage(pkg: ModelPackage | null)`; un `InstancedMesh` con `userData.gpuModel: number` (índice del modelo en el paquete) se dibuja por el camino GPU en vez de por el normal. `renderer.gpuDriven: boolean` (por defecto `true` si hay paquete).
- Consume: `GpuDriven` de la Tarea 2 vía los enlaces wasm.

- [ ] **Paso 1:** en `pack`, los objetos con `userData.gpuModel` definido y matriz con solo rotación en Y/escala uniforme se sacan de la lista normal y se convierten a 8 floats (`[x,y,z,escala,modelo,yaw,hash,0]`); los que no cumplan siguen por el camino normal (Review Focus).
- [ ] **Paso 2:** `renderer.gpuDriven = false` devuelve el dibujo por el camino normal para todos. Esperado: con el flag apagado, las capturas son idénticas a las de hoy. Commit.

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
