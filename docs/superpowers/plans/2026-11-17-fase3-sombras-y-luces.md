# Fase 3: sombras PCFSoft y luces restantes. Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:executing-plans (ejecución nativa). Casillas `- [ ]`. Revisores: nunca Opus (orden del dueño); usar Sonnet.

**Objetivo:** que una escena con `HemisphereLight`, `SpotLight` (la linterna), `RectAreaLight` y sombras `PCFSoftShadowMap` de un `SpotLight` y de un `DirectionalLight` (el sol) se vea con Phoenyx igual que con three 0.160.1.

**Arquitectura:** igual que las fases 1 y 2. Las luces siguen siendo clases de datos copiadas de three; `pack.ts` las serializa en el buffer de luces (16 floats cada una, ya existente) con tipos nuevos. Las sombras añaden: una pasada de profundidad por luz con sombra (pipeline solo de profundidad en `phoenyx-gl`, matrices de la cámara de sombra calculadas por `LightShadow.updateMatrices` de three), un `texture_depth_2d_array` de mapas de sombra y el muestreo con comparación en el shader portado del chunk `shadowmap_pars_fragment` de three.

**Tech Stack:** el de la fase 2; `three/examples/jsm/lights/RectAreaLightUniformsLib.js` (tablas LTC).

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md` (fase 3). Estado anterior y límites: `docs/FASE2.md`.

## Restricciones globales
- Aspecto de three 0.160.1 (mismo orden de operaciones y constantes). Referencia: `antialias:false`, sRGB, ACES, exposición 0,72, `shadowMap.type = PCFSoftShadowMap`.
- Umbral: error medio < 1/255 y ningún píxel de interior > 8/255 (`tools/fidelity/compare.mjs`). Las sombras se comparan con el mismo criterio; si el borde de penumbra supera el umbral se ajusta el algoritmo, no el umbral, y se anota en `docs/FASE3.md`.
- Un commit por función terminada; comentarios en español; sin tests unitarios (regla del dueño): verifican las capturas comparadas.
- Código de three no se edita a mano (se regenera con `tools/sync-three.mjs`); el WGSL se porta chunk a chunk desde `tools/fidelity/node_modules/three/src/renderers/shaders/ShaderChunk/` conservando el orden de operaciones.
- Uso real en `client/src` (medido): `HemisphereLight` en 12 sitios (`game.ts`, `pool.ts`, `poolmap.ts`, `parking.ts`, ...), `SpotLight` = la linterna `flash` (`game.ts:419`, `castShadow`, `mapSize` = calidad, `radius = 4`, `camera.near 0.2 / far 22`, `bias -0.002`), `DirectionalLight` solar en `poolmap.ts` (`castShadow`, cámara ortográfica ±34, `near 1 / far 220`, `bias -0.0004`, `normalBias 0.04`, `radius 3`, `mapSize` 1024 o 2048), `RectAreaLight` (3 en `poolmap.ts`, con `RectAreaLightUniformsLib.init()`), `castShadow`/`receiveShadow` en mallas (`entity.ts`, `vents.ts`, `poolmap.ts`, `remote.ts`), `shadowMap.autoUpdate` activado y desactivado (`game.ts:1246`, `:1487`). **Ninguna `PointLight` proyecta sombra**: las sombras de punto (cubo) quedan fuera.
- Fuera de esta fase: sombras de `SkinnedMesh` (fase 5, el esqueleto aún no existe), `LightProbe`, `IESSpotLight`, sombras de punto, `VSMShadowMap`/`BasicShadowMap`, `shadow.autoUpdate` por luz.
- Máximo 4 luces con sombra a la vez (el juego usa 2 como mucho); las demás se dibujan sin sombra con un aviso.

## Review Focus
- Casters con `side` distinto de `FrontSide`: three usa `shadowSide` (FrontSide proyecta con caras traseras, BackSide con delanteras, DoubleSide ambas); un error aclara o ensombrece una pared entera.
- Casters con `alphaTest` o `map` transparente (rejas, hojas): no deben proyectar la silueta del quad completo.
- `receiveShadow = false` con luz que sí proyecta, `castShadow` en malla sin `receiveShadow` (y al revés), y `InstancedMesh` como caster.
- Sombra de linterna con la luz apagada (`intensity = 0`) o `shadowMap.autoUpdate = false`/`needsUpdate`: el mapa no debe repintarse ni quedar corrupto al encender de nuevo.
- Objetos fuera de la cámara de sombra pero dentro de la vista (o al revés), y `bias`/`normalBias` en cara plana frente a curva (acné y peter-panning).

## Estructura de archivos
- `tools/three-files.txt`, `tools/three-jsm-files.txt`: añadir lo que falte (`HemisphereLight`, `SpotLight`, `RectAreaLight`, `LightShadow`, `DirectionalLightShadow`, `SpotLightShadow`; jsm `lights/RectAreaLightUniformsLib.js`).
- `packages/phoenyx/src/pack.ts`, `renderer.ts`: nuevos tipos de luz, lista de casters, matrices de sombra, `shadowMap.enabled/type/autoUpdate/needsUpdate`.
- `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}` y `shadow.wgsl` (nuevo): pipeline de profundidad, mapas de sombra, muestreo.
- `web/fidelity/{room.js,scenes.json}`: escenas `luces`, `sombra-spot`, `sombra-sol`, `rect`.
- `docs/FASE3.md`.

---

### Tarea 1: HemisphereLight y SpotLight (sin sombra)

**Files:** modificar `tools/three-files.txt`, `pack.ts`, `crates/phoenyx-gl/src/shader.wgsl`, `web/fidelity/{room.js,scenes.json}`.

**Interfaces:** Consumes: buffer `lights` (16 floats, tipo en el primer float: 0 direccional, 1 puntual). Produces: tipos 2 (hemisferio) y 3 (foco) en el mismo registro: hemisferio = color cielo·intensidad, color suelo·intensidad en los slots libres y dirección hacia arriba en vista; foco = puntual + dirección del eje en vista + `coneCos` y `penumbraCos` (`cos(angle)`, `cos(angle*(1-penumbra))`, como `getSpotLightInfo`).

- [ ] **Paso 1:** comprobar que `HemisphereLight`, `SpotLight` y las clases de sombra están en la copia de three; añadirlas a la lista y ejecutar `node tools/sync-three.mjs` si faltan.
- [ ] **Paso 2:** `pack.ts`: serializar `isHemisphereLight` y `isSpotLight` (posición y eje en espacio de vista como la direccional; `SpotLight.target.matrixWorld`).
- [ ] **Paso 3:** `shader.wgsl`: `getHemisphereLightIrradiance` (mezcla por `dot(normal, up)·0.5+0.5`, como `lights_pars_begin`) sumada a la irradiancia difusa indirecta (`irradiance` de `lights_fragment_begin`), y `getSpotLightInfo` (atenuación `smoothstep(coneCos, penumbraCos, angleCos)` × distancia) en el bucle de luces.
- [ ] **Paso 4:** escena `luces`: sala del banco con `HemisphereLight(0xfff1c4, 0x3a2c0c, 0.6)`, un `SpotLight` (`angle 0.55`, `penumbra 0.75`, `distance 22`, `decay 1.2`, intensidad de la linterna) apuntando al suelo y una pared, y las luces puntuales ya existentes. Capturar con three y con Phoenyx. Esperado: ok bajo el umbral.
- [ ] **Paso 5:** commit «Phoenyx: HemisphereLight y SpotLight».

### Tarea 2: RectAreaLight

**Files:** modificar `tools/three-jsm-files.txt`, `pack.ts`, `renderer.ts`, `lib.rs`, `shader.wgsl`, escenas.

**Interfaces:** Consumes: Tarea 1. Produces: tipo de luz 4 con posición, `halfWidth` y `halfHeight` en vista (los vectores `width/2` y `height/2` rotados por `matrixWorld` y `view`), y dos texturas `ltc_1`/`ltc_2` (64×64 RGBA float16/32 del `RectAreaLightUniformsLib`) con `LTC_Evaluate`, `LTC_Uv` y `LTC_EdgeVectorFormFactor` portados de `lights_physical_pars_fragment`/`ltc`.

- [ ] **Paso 1:** sincronizar `RectAreaLightUniformsLib.js` (el juego lo importa por esa ruta; el alias de `three/examples/jsm` ya cubre `src/jsm`) y hacer que `RectAreaLightUniformsLib.init()` deje `UniformsLib.LTC_FLOAT_1/2` (o `LTC_HALF`); `phoenyx` los lee de ahí y los sube una vez como texturas.
- [ ] **Paso 2:** `lib.rs`: `set_ltc(ltc1: &[f32], ltc2: &[f32])`, texturas 64×64 `Rgba32Float` con muestreador lineal, enlazadas en el bind group 0; `RectAreaLight` suma difuso (`ltcDiffuse`) y especular (`ltcSpecular` con `ltc_2`/`ltc_1` y `material.specularColor`) en `RE_Direct_RectArea_Physical`.
- [ ] **Paso 3:** escena `rect`: tres `RectAreaLight` (`1.1 × 0.28`, como el juego) sobre un suelo `MeshStandardMaterial` con rugosidad 0.45 y una pared. Esperado: ok bajo el umbral; si el especular difiere, comparar `LTC_Evaluate` constante a constante.
- [ ] **Paso 4:** commit «Phoenyx: RectAreaLight (LTC)».

### Tarea 3: pasada de sombras (profundidad)

**Files:** modificar `pack.ts`, `renderer.ts`, `lib.rs`; crear `crates/phoenyx-gl/src/shadow.wgsl`.

**Interfaces:** Consumes: lista de dibujos ya empaquetada (mismos buffers de objetos, geometrías e instancias). Produces: `Gl::set_shadow_maps(count: u32, size: u32)`, `Gl::set_shadow_view(index: u32, view_proj: &[f32])`, `Gl::draw_shadow(index: u32, draws: &[u32])` y un `texture_depth_2d_array` `Depth32Float` de `count` capas; `renderer.shadowMap.{enabled, type, autoUpdate, needsUpdate}` con la semántica de three (la pasada solo se repite si `autoUpdate` o `needsUpdate`).

- [ ] **Paso 1:** `pack.ts`: por cada luz con `castShadow` y `renderer.shadowMap.enabled`: `light.shadow.updateMatrices(light)` (copiado de three: `DirectionalLightShadow`, `SpotLightShadow`) y matriz `projScreen = shadow.matrix`/`shadow.camera.projectionMatrix × matrixWorldInverse`; recoger casters (`castShadow`, visibles, capas, `frustumCulled` contra el frustum de la cámara de sombra) con las reglas de `WebGLShadowMap.renderObject`.
- [ ] **Paso 2:** `shadowSide` como three (`material.shadowSide ?? {FrontSide: Back, BackSide: Front, DoubleSide: Double}[side]`): flags de culling del dibujo de sombra. Materiales con `alphaTest > 0` o `map` con alfa: el vertex+fragment de sombra descarta con el mismo umbral (`alphatest_fragment` con `map`), sin `discard` en el resto para no perder early-z.
- [ ] **Paso 3:** `shadow.wgsl`: vértice con `instanceMatrix` opcional y matriz del objeto, solo profundidad; `lib.rs`: pipeline solo de profundidad con `depth_bias` 0 (el bias de three va en el muestreo, no aquí) y vista por capa; renderizar los casters en `Depth32Float` limpiando a 1.0.
- [ ] **Paso 4:** `needsUpdate`/`autoUpdate`: si la pasada no se repite, el mapa se conserva; con la luz a `intensity = 0` no se pinta.
- [ ] **Paso 5:** verificar con una escena mínima que el mapa se genera (volcar la capa 0 a una textura de depuración desde la ruta `?debug=shadow` del harness). Esperado: silueta de los casters en la vista de la luz, sin ruido.
- [ ] **Paso 6:** commit «Phoenyx: pasada de profundidad para sombras».

### Tarea 4: muestreo PCFSoft y escenas con sombras

**Files:** modificar `shader.wgsl`, `lib.rs`, `pack.ts`, escenas.

**Interfaces:** Consumes: Tarea 3. Produces: por luz con sombra, en el buffer de luces: índice de mapa, matriz de sombra (16 floats en una estructura aparte `shadows[]`), `shadowBias`, `shadowNormalBias`, `shadowRadius`, `mapSize`; bit de material `receiveShadow` en las flags del dibujo (bit 8).

- [ ] **Paso 1:** portar `shadowmap_pars_fragment` (`getShadow` para `PCFSoftShadowMap`: 9 muestras con `texture2DCompare` y `shadowRadius` como en la versión 0.160; leer el chunk real, no su descripción), `shadowmap_vertex` (el vértice calcula `shadowCoord = shadowMatrix * (worldPosition + shadowWorldNormal*normalBias)`) y la integración en `lights_fragment_begin` (`directLight.color *= receiveShadow ? getShadow(...) : 1.0`, con `spotLightShadow` y `directionalLightShadow`).
- [ ] **Paso 2:** la comparación manual (`textureLoad` y `step`) sustituye a `sampler_comparison` si hace falta igualar los 9 pesos del chunk; aceptable cualquier forma que reproduzca el chunk dentro del umbral.
- [ ] **Paso 3:** escenas `sombra-spot` (linterna con `shadow.camera.near 0.2/far 22`, `radius 4`, `bias -0.002`, `mapSize 1024`; muros, columna y caja como casters, suelo receptor) y `sombra-sol` (`DirectionalLight` con la cámara ortográfica del juego, `bias -0.0004`, `normalBias 0.04`, `radius 3`, `mapSize 2048`, objetos curvos y planos). Capturar con ambos renderers y comparar. Esperado: ok bajo el umbral; si no, abrir el `-diff.png` y separar acné, penumbra y desplazamiento de la sombra con escenas reducidas.
- [ ] **Paso 4:** casos de Review Focus en las escenas: caster `BackSide`, caster con `alphaTest`, `receiveShadow=false`, luz de linterna con `intensity` 0 y `needsUpdate` manual.
- [ ] **Paso 5:** commit «Phoenyx: sombras PCFSoft de foco y direccional».

### Tarea 5: interior con sombras y punto de control 3

**Files:** `web/fidelity/{room.js,scenes.json}`, `fidelity/baseline/fase3-*`, `docs/FASE3.md`.

**Interfaces:** Consumes: Tareas 1–4. Produces: escenas `interior` (la sala del banco con linterna que proyecta sombra sobre mallas del juego: `bat`, `locker`, instancias, y `HemisphereLight` del juego) y `piscina-sol` (sol con sombra sobre las instancias de `inst` y un modelo GLB).

- [ ] **Paso 1:** escribir las dos escenas con solo API de three; capturar con three (dos pasadas iguales, error 0) y con Phoenyx; comparar las 16 escenas acumuladas (fases 1 a 3). Esperado: todas bajo el umbral y ninguna de las anteriores empeora.
- [ ] **Paso 2:** cifras de CPU y llamadas (CPU 1x y 4x) con sombras activadas y desactivadas para ambos renderers, a `fidelity/baseline/fase3-*/perf.json`.
- [ ] **Paso 3:** `docs/FASE3.md` (hecho, diferencias, límites, formato de luces/sombras, rulings) y commit.
- [ ] **Paso 4:** revisión final con un revisor Sonnet (no Opus; foco: la lista de Review Focus), un solo pase de arreglos, commit y push. Mostrar al dueño capturas lado a lado, mapas de diferencias y cifras; esperar su visto bueno antes del plan de la fase 4.

## Planes siguientes (no incluidos aquí)
Fase 4 (postproceso: AO, SMAA, bloom, etc.) se planifica tras este punto de control.
