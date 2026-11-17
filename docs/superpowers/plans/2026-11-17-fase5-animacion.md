# Fase 5: animación y personajes (SkinnedMesh, AnimationMixer, clonado). Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:executing-plans (ejecución nativa). Casillas `- [ ]`. Revisores: nunca Opus (orden del dueño); usar Sonnet.

**Objetivo:** que las entidades del juego (GLB con esqueleto: `hazmat`, `partygoer`, `parking/skinwalker`, smilers…) animadas con `AnimationMixer` y clonadas con `SkeletonUtils.clone` se vean con Phoenyx igual que con three, con sombras y con el postproceso de la fase 4.

**Arquitectura:** el lado JS ya es código de three copiado (`SkinnedMesh`, `Skeleton`, `Bone`, `AnimationMixer/Clip/Action/PropertyBinding`, `SkeletonUtils`): calcula huesos y `skeleton.boneMatrices` exactamente igual. Lo que falta es la GPU: atributos `skinIndex`/`skinWeight` en el buffer de vértices, un buffer de almacenamiento con las matrices de hueso de todas las mallas con piel (un tramo por esqueleto, subido solo si `skeleton.update()` cambió algo), y el skinning en `vs` y `vs_shadow` portado de `skinning_vertex`/`skinbase_vertex`/`skinnormal_vertex` de three. `SkinnedMesh` sigue la ruta de `Mesh` en el empaquetado (orden, material, culling); solo añade el tramo de huesos y `bindMatrix`.

**Tech Stack:** el de la fase 4; `three/examples/jsm/utils/SkeletonUtils.js`, `loaders/GLTFLoader.js` (ya copiados).

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md` (fase 5). Estado anterior y límites: `docs/FASE4.md`.

## Restricciones globales
- Aspecto de three 0.160.1: orden de operaciones de `skinning_vertex` (`skinMatrix = boneMatX * skinWeight.x + …; transformed = (bindMatrixInverse * skinMatrix * bindMatrix * vec4(transformed,1)).xyz`) y de `skinnormal_vertex` para la normal; `bindMode` `attached`/`detached`. Referencia: `antialias:false`, sRGB, ACES, exposición 0,72.
- Umbral: error medio < 1/255 y ningún píxel de interior > 8/255 (`tools/fidelity/compare.mjs`). Sin retocar el shader para «aprobar la métrica».
- Un commit por función terminada; comentarios en español; sin tests unitarios (regla del dueño): verifican las capturas comparadas.
- Código de three no se edita a mano; el tiempo de las animaciones en las escenas es fijo (`mixer.update(dt)` con pasos fijos y la misma secuencia en ambos renderers) para que la pose sea idéntica.
- Uso real en `client/src` (medido): `SkeletonUtils.clone` (`rig.ts`, `world.ts`, `pickups.ts`…), `AnimationMixer` con `fadeIn`/`fadeOut` (24 usos), `timeScale` (13), `setLoop` (1), `frustumCulled = false` (30) y `computeBoundingSphere` (10) sobre mallas con piel; sin morph targets; sin `bindMode` personalizado (se comprueba con los GLB reales). Los materiales de las entidades son Standard/Basic (Physical con `transmission` sigue fuera, fase 6).
- Fuera de esta fase: morph targets (no los usa el juego; aviso), `SkeletonHelper` (solo desarrollo), `Points`/`Sprite`/`Line`, `ShaderMaterial` con piel.

## Review Focus
- Varios clones de un mismo GLB (misma geometría, distinto esqueleto y distinta pose): cada uno usa su tramo de huesos, no el del vecino.
- Una malla con piel que se quita de la escena, se oculta o se clona y destruye (`dispose` de esqueleto) mientras otras siguen: el buffer de huesos no se corrompe ni crece sin límite.
- Esqueleto con más huesos que los de un GLB típico (hasta ~100) y `skinWeight` con suma 0 o sin normalizar: sin NaN ni vértices en el origen.
- `frustumCulled = false` con `computeBoundingSphere` ya calculado y objeto fuera de pantalla; `visible = false` en un hueso padre: la entidad no se dibuja ni proyecta sombra fantasma.
- `AnimationMixer` con `fadeIn/fadeOut` cruzados y `timeScale` negativo o 0: la pose del primer fotograma tras crear la acción no sale en T-pose.

## Estructura de archivos
- `packages/phoenyx/src/{pack.ts,renderer.ts,skin.ts (nuevo)}`: atributos de piel, tramos de huesos, `bindMatrix`.
- `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}`: vértices con 2 atributos más, buffer de huesos, skinning en `vs`, `vs_shadow`.
- `web/fidelity/{room.js,scenes.json}`: escenas `skin`, `skin-sombra`, `entidades`, `entidades-pool`.
- `docs/FASE5.md`, `fidelity/baseline/fase5-*`.

---

### Tarea 1: skinning en la GPU

**Files:** crear `skin.ts`; modificar `pack.ts`, `renderer.ts`, `lib.rs`, `shader.wgsl`; escena `skin` en `room.js`/`scenes.json`.

- [ ] **Paso 1:** escena `skin`: cilindro con `SkinnedMesh` de 3 huesos (generado en código, sin GLB) y `AnimationMixer` con un clip de rotación; `advance` fijo. Capturar three, comprobar que la pose no es la de reposo.
- [ ] **Paso 2:** `lib.rs`: geometría con `skinIndex` (4×u16 empaquetados) y `skinWeight` (4×f32) como atributos extra (por defecto a 0 para mallas sin piel, un solo pipeline); buffer de huesos `array<mat4x4<f32>>` crecedero; `set_bones(slot_offset, f32[])`.
- [ ] **Paso 3:** `shader.wgsl`: en `vs`, si el dibujo tiene tramo de huesos (palabra nueva del dibujo), aplicar `skinning_vertex` y `skinnormal_vertex` en el orden de three (`bindMatrix`, `bindMatrixInverse` por objeto).
- [ ] **Paso 4:** `skin.ts`/`pack.ts`: para cada `SkinnedMesh` visible llamar `skeleton.update()` (como `WebGLRenderer` hace en `projectObject`/`renderBufferDirect`), copiar `boneMatrices` a su tramo (reuso por `skeleton.uuid`; liberar tramos no vistos en N fotogramas), pasar `bindMatrix`/`bindMatrixInverse`, `bindMode`.
- [ ] **Paso 5:** capturar `skin` con ambos renderers y `compare.mjs`. **Expected:** media < 1, `>8 int.` = 0; las 34 escenas previas sin cambios. Commit: «Fase 5: SkinnedMesh en la GPU».

### Tarea 2: sombras, culling y normales con piel

**Files:** `lib.rs`, `shader.wgsl` (`vs_shadow`), `pack.ts`; escena `skin-sombra`.

- [ ] **Paso 1:** `vs_shadow` con el mismo skinning; `castShadow` de `SkinnedMesh` en la lista de sombras (hoy se omite).
- [ ] **Paso 2:** culling: `frustumCulled` con la `boundingSphere` del `SkinnedMesh` (`computeBoundingSphere` de three 0.160 la calcula con `getVertexPosition` skinned en `applyBoneTransform`) y `frustumCulled = false`.
- [ ] **Paso 3:** `MeshNormalMaterial` + `overrideMaterial` con piel (las normales de GTAO).
- [ ] **Paso 4:** escena `skin-sombra` (sol + foco, la malla proyecta y recibe sombra, fuera de pantalla con `frustumCulled` verdadero y falso). **Expected:** media < 1, `>8 int.` = 0. Commit: «Fase 5: sombras y culling de SkinnedMesh».

### Tarea 3: entidades del juego (GLB, clonado y mezclador)

**Files:** `room.js`/`scenes.json` (escena `entidades`); correcciones en `pack.ts`/`skin.ts` que salgan.

- [ ] **Paso 1:** escena `entidades`: `hazmat.glb`, `partygoer.glb` y `parking/skinwalker.glb` cargados con `GLTFLoader`+meshopt, 2–3 clones cada uno con `SkeletonUtils.clone`, clips distintos con `fadeIn/fadeOut` cruzados y `timeScale` (1, 0,5, 0, −1), `frustumCulled = false` como el juego; pasos fijos de `mixer.update`.
- [ ] **Paso 2:** capturar y comparar. Si algún GLB usa algo no soportado (materiales Physical, `bindMode`, morph targets) se anota y se avisa con `warnOnce`, sin falsear la métrica. **Expected:** media < 1, `>8 int.` = 0. Commit: «Fase 5: entidades animadas».

### Tarea 4: punto de control, rendimiento y documentación

**Files:** `room.js`/`scenes.json` (`entidades-pool`), `docs/FASE5.md`, `fidelity/baseline/fase5-*`.

- [ ] **Paso 1:** escena `entidades-pool`: entidades en las Poolrooms con la cadena de la fase 4 (GTAO, bloom, salida, SMAA), sol con sombra y niebla. **Expected:** media < 1, `>8 int.` = 0; las 38 escenas previas pasan.
- [ ] **Paso 2:** rendimiento: `capture.mjs --throttle 1` y `4` con `entidades` y `entidades-pool`, three y Phoenyx (`fidelity/baseline/fase5-*/perf.json`). Anotar mediana y coste de subir huesos; objetivo: no peor que three.
- [ ] **Paso 3:** `docs/FASE5.md`, ledger `.superpowers/progress-fase5.md`.
- [ ] **Paso 4:** revisión final con un revisor Sonnet sobre toda la rama (con el Review Focus de este plan), una sola pasada de correcciones, push y presentación del punto de control 5 al dueño.
