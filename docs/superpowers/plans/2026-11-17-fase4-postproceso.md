# Fase 4: postproceso (EffectComposer, GTAO, bloom, SMAA, salida). Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:executing-plans (ejecución nativa). Casillas `- [ ]`. Revisores: nunca Opus (orden del dueño); usar Sonnet.

**Objetivo:** que `EffectComposer` con `RenderPass`, `GTAOPass`, `UnrealBloomPass`, `OutputPass`, `SMAAPass` y `ShaderPass` (copiados de three 0.160.1) produzcan con Phoenyx la misma imagen que con three, y que los render targets que usa el juego (`WebGLRenderTarget`, `setRenderTarget`, `HalfFloatType`, textura de un RT usada como `map`) funcionen.

**Arquitectura:** los pases siguen siendo código de three copiado tal cual (`tools/sync-three.mjs`); lo que cambia es el renderer. Se añaden a `phoenyx-gl` render targets (color RGBA16F/RGBA8 + profundidad opcional legible), una pasada de pantalla completa y un registro de shaders WGSL de pase, indexado por el texto del `fragmentShader` GLSL de three (el pase de three construye su `ShaderMaterial` como siempre; Phoenyx reconoce el shader por su hash y usa el WGSL portado línea a línea; un shader desconocido avisa y copia la entrada). La escena a un RT sale en lineal sin tone mapping (como three: el tone mapping solo se aplica al dibujar a pantalla), y `OutputPass` hace ACES + sRGB.

**Tech Stack:** el de la fase 3; `three/examples/jsm/postprocessing/{EffectComposer,Pass,RenderPass,ShaderPass,MaskPass,GTAOPass,UnrealBloomPass,SMAAPass,OutputPass}.js` y `shaders/{CopyShader,GTAOShader,PoissonDenoiseShader,LuminosityHighPassShader,SMAAShader,OutputShader}.js`.

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md` (fase 4 y «Fidelidad de efectos»). Estado anterior y límites: `docs/FASE3.md`.

## Restricciones globales
- Aspecto de three 0.160.1 (mismo orden de operaciones, constantes y patrones de muestreo). Referencia: `antialias:false`, sRGB, ACES, exposición 0,72.
- Umbral: error medio < 1/255 y ningún píxel de interior > 8/255 (`tools/fidelity/compare.mjs`). Los pases se portan línea a línea; no se retocan para «aprobar la métrica». El ruido de GTAO de three sale de una `DataTexture` determinista (cuadrado mágico) y del poisson fijo: se compara tal cual, sin semilla aparte.
- Un commit por función terminada; comentarios en español; sin tests unitarios (regla del dueño): verifican las capturas comparadas.
- Código de three no se edita a mano. El WGSL se porta de los `fragmentShader` de `three/examples/jsm/shaders/*.js` y de `ShaderChunk` conservando el orden de operaciones.
- Uso real en `client/src` (medido): `game.ts` crea `EffectComposer(renderer)`, `RenderPass(scene, camera)` (accedido como `composer.passes[0] as RenderPass` en ~10 sitios para cambiar `scene`/`camera`), `UnrealBloomPass(Vector2(256,256), 0.55, 0.6, 0.92)` con `strength/threshold/radius/enabled` cambiados en ejecución, `OutputPass`, dos `ShaderPass` propios (`FilmShader`, `VhsShader` en `vhsPass.ts`, GLSL del juego → fase 6), y en las Poolrooms `GTAOPass(scene, camera, w>>1, h>>1)` con `setSize` y `render` reemplazados por el juego, `updateGtaoMaterial({radius:0.9, distanceExponent:1.5, thickness:1.2, scale:1, samples:8})`, `blendIntensity = 0.85`, `insertPass`/`removePass`/`dispose` y `SMAAPass(w*pr, h*pr)` tras `OutputPass`. Render targets sueltos: `compile.ts:71` (`HalfFloatType`, `setRenderTarget`), `game.ts:1724` (`snap`, mitad de tamaño), `vents.ts:543` (256×192, su textura se usa como `map` de una pantalla).
- Fuera de esta fase: `FilmShader`/`VhsShader` (fase 6; el mecanismo de registro de esta fase es el que usarán), `MSAA`/`samples` de RT, `MaskPass`/stencil, `PMREMGenerator`, `readRenderTargetPixels` (no lo usa el juego), `ShaderMaterial` general.
- Los pases que dibujan la escena con `scene.overrideMaterial` (GTAO normales con `MeshNormalMaterial`) se soportan solo con ese material; `overrideMaterial` genérico se deja con aviso.

## Review Focus
- Cambio de tamaño/`setPixelRatio` con el composer activo (resolución dinámica del juego) y `setSize` de GTAO reemplazado a mitad de resolución: los RT se recrean sin dejar texturas viejas ni imagen estirada.
- Pase `enabled = false` a mitad de cadena (bloom apagado en calidad baja, AO/SMAA según ajustes) y `removePass` + `dispose` en caliente: el ping-pong no debe invertirse ni mostrar el fotograma anterior.
- `renderer.render` a un RT mientras el composer está en marcha (`snap`, pantallas de `vents`) y `setRenderTarget(null)` al terminar: el estado (clear color, autoClear, RT activo) se restaura.
- Textura de un RT usada como `map` en la misma escena que se dibuja al RT (feedback): no debe leer y escribir el mismo recurso (pantalla negra en lugar de error de validación).
- Fondo/alpha: `clearAlpha 0` en pases intermedios, bloom con `strength 0` o `threshold` ≥ luminancia máxima, y GTAO sobre escena sin geometría o con `scene.visible` parcial (`aoCull`): imagen sin NaN ni píxeles negros.

## Estructura de archivos
- `tools/three-jsm-files.txt`: añadir los `postprocessing/*` y `shaders/*` listados arriba.
- `packages/phoenyx/src/{renderTarget.ts,renderer.ts,pack.ts,passes.ts}` y `src/shaders/pass-registry.ts` (nuevo): RT, estado de render, registro de WGSL de pase, ejecución de pases.
- `crates/phoenyx-gl/src/{lib.rs,shader.wgsl}` y `post.wgsl` (nuevo, un `fn` por pase): RT, pasada de pantalla completa, shaders de pase.
- `web/fidelity/{room.js,scenes.json}`: escenas `rt`, `composer`, `bloom`, `smaa`, `ao`, `pool-fx`.
- `docs/FASE4.md`, `fidelity/baseline/fase4-*`.

---

### Tarea 1: render targets y estado del renderer

**Files:** crear `renderTarget.ts`; modificar `renderer.ts`, `pack.ts`, `lib.rs`, `shader.wgsl`; escena `rt` en `room.js`/`scenes.json`.

**Interfaces:**
- Produce (TS): `WebGLRenderTarget(w, h, {type, depthBuffer, depthTexture, minFilter, magFilter})` (clase de three copiada; `texture` es usable como `map`), `DepthTexture`; `renderer.setRenderTarget(rt | null, layer?)`, `getRenderTarget()`, `clear(color?, depth?, stencil?)`, `clearDepth()`, `setClearColor`, `getClearColor(target)`, `setClearAlpha`, `getClearAlpha`, `autoClear/autoClearColor/autoClearDepth/autoClearStencil`, `setPixelRatio/getPixelRatio`, `setSize(w,h,updateStyle)`, `getSize(target)`.
- Produce (WASM): `gl.create_target(id: u32, w: u32, h: u32, hdr: bool, depth: bool)`, `gl.drop_target(id)`, `gl.begin_target(id | 0xFFFFFFFF)` (el siguiente `frame` dibuja ahí), `gl.clear(r,g,b,a, color: bool, depth: bool)`.

- [ ] **Paso 1:** añadir a `three-files.txt` (si falta) `WebGLRenderTarget`, `RenderTarget`, `DepthTexture` y a `renderer.ts` los métodos de estado con la semántica de `WebGLRenderer` 0.160.1 (`autoClear` por defecto true; `render` limpia solo si `autoClear`).
- [ ] **Paso 2:** `lib.rs`: tabla de targets (`Rgba16Float`/`Rgba8Unorm`, profundidad `Depth32Float` con vista de textura legible); `frame` acepta destino; la escena a RT usa el sombreado **sin tone mapping y sin conversión a sRGB** (bandera nueva en globals, p.ej. `g[58]` = 1 para salida lineal; el WGSL salta `tonemapping_fragment` y `colorspace_fragment`, igual que three cuando `renderTarget !== null`).
- [ ] **Paso 3:** `textures.ts`: una `Texture` cuyo `source` es un RT resuelve a la vista del target (sin copiar); si ese RT es el destino del dibujo en curso, se usa una textura negra con aviso (feedback).
- [ ] **Paso 4:** escena `rt`: sala de fase 1 dibujada a un RT 512×384 `HalfFloatType` con una cámara aparte y mostrada como `map` de un plano (como `vents.ts:543`); más un `snap` de mitad de tamaño con `UnsignedByteType`. Capturar three y Phoenyx y comparar. **Expected:** media < 1, `>8 int.` = 0, y las 17 escenas anteriores sin cambios.
- [ ] **Paso 5:** commit `Fase 4: render targets y estado del renderer`.

### Tarea 2: pasada de pantalla completa, registro de shaders y EffectComposer (Copy)

**Files:** copiar `EffectComposer, Pass, RenderPass, ShaderPass` y `CopyShader` con `sync-three.mjs`; crear `passes.ts`, `shaders/pass-registry.ts`, `post.wgsl`; modificar `renderer.ts`, `lib.rs`; escena `composer`.

**Interfaces:**
- Consume: Tarea 1 (`setRenderTarget`, `create_target`).
- Produce: `registerPassShader(key: string, wgsl: { fn: string; uniforms: string[]; defines?: string[] })`; `key` = hash FNV-1a del `fragmentShader` GLSL (función `hashGlsl(src: string): string`). `renderer.render(fsQuad mesh, camera)` desde `Pass.FullScreenQuad` detecta un `ShaderMaterial` con shader registrado y ejecuta `gl.pass(key, uniformsF32: Float32Array, inputs: u32[], out: u32)`. Shader desconocido → `warnOnce` y copia `tDiffuse` a la salida.

- [ ] **Paso 1:** `sync-three.mjs`: añadir los cuatro `.js` de pases y `CopyShader.js`; regenerar; comprobar que `import ... from 'three'` resuelve por el alias (clases `ShaderMaterial`, `Mesh`, `OrthographicCamera`, `BufferGeometry` ya existen; `ShaderMaterial` mínimo: `uniforms`, `defines`, `vertexShader`, `fragmentShader`, `blending`, `depthTest/Write`, `clone`).
- [ ] **Paso 2:** `lib.rs`: `pass(key, uniforms, inputs, out)` con un pipeline por clave (vértice de triángulo único, sin buffers; entradas como texturas filtrables lineal/clamp como `ShaderPass`); mezcla `NoBlending`/`AdditiveBlending`/`CustomBlending` según `material.blending`.
- [ ] **Paso 3:** `CopyShader` en `post.wgsl` (`opacity * texture2D(tDiffuse, vUv)`); orden de uniformes definido por `Object.keys(material.uniforms)` de three.
- [ ] **Paso 4:** escena `composer`: `RenderPass` + `ShaderPass(CopyShader)` con `opacity 1` y luego 0.5 sobre fondo (sala con `toneMapping=NoToneMapping` y salida lineal → sin `OutputPass`). **Expected:** media < 1, `>8 int.` = 0.
- [ ] **Paso 5:** `EffectComposer` real: `composer.passes[0] as RenderPass`, `insertPass`, `removePass`, `setSize`, `setPixelRatio`, `swapBuffers`, `renderToScreen` último pase habilitado; verificar con el mismo script de captura que añadir y quitar un `CopyShader` en caliente no cambia el resultado final. Commit `Fase 4: EffectComposer y pasada de pantalla completa`.

### Tarea 3: OutputPass

**Files:** copiar `OutputPass.js`, `OutputShader.js`; `post.wgsl` (+`output`); escena `composer-out`.

**Interfaces:** Consume Tarea 2. Produce WGSL para `OutputShader` con los `#define` `SRGB_TRANSFER`, `LINEAR_TONE_MAPPING|REINHARD|CINEON|ACES_FILMIC|AGX|NEUTRAL` (los elige `OutputPass.setSize/render` en `material.defines`); el juego usa `ACESFilmicToneMapping` y `toneMappingExposure 0.72`.

- [ ] **Paso 1:** portar `OutputShader` con `ACESFilmicToneMapping` (constantes de `tonemapping_pars_fragment`: matrices `ACESInputMat/ACESOutputMat`, `RRTAndODTFit`, división del exposure por 0.6) y `sRGBTransferOETF`; soportar además Linear/Reinhard/Cineon por ser trivial; AgX/Neutral → aviso.
- [ ] **Paso 2:** escena `composer-out`: sala + niebla + luces de fase 1 con `RenderPass → OutputPass` frente a la misma con tone mapping directo del renderer. **Expected:** media < 1, `>8 int.` = 0; esta escena es el equivalente exacto de `sala-lineal` y debe coincidir con three.
- [ ] **Paso 3:** commit `Fase 4: OutputPass`.

### Tarea 4: UnrealBloomPass

**Files:** copiar `UnrealBloomPass.js`, `LuminosityHighPassShader.js`; `post.wgsl` (+`luminosity_high_pass`, `blur_gauss`, `bloom_composite`); escena `bloom`.

**Interfaces:** Consume Tareas 2–3 y `create_target` con cadena de mips (resx/2, resy/2, ...). El blur separable usa `kernelSizeArray = [3,5,7,9,11]` y `SEPARABLE_BLUR` de `UnrealBloomPass.getSeperableBlurMaterial` (define `KERNEL_RADIUS`, uniforme `gaussianCoefficients[]` array de 5 floats), mezcla `AdditiveBlending` al final con `bloomTintColors`/`bloomFactors`. Parámetros del juego: strength 0.55–0.62, radius 0.6, threshold 0.9–0.92.

- [ ] **Paso 1:** portar los tres shaders de `UnrealBloomPass` (alto contraste de luminancia con `smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, l)` y `defaultColor/defaultOpacity`, blur gaussiano separable con `direction`, composición con `lerpBloomFactor`).
- [ ] **Paso 2:** escena `bloom`: fluorescentes de las Poolrooms (planos emisivos con `emissiveIntensity` alta, `MeshBasic` blanco) con `RenderPass → UnrealBloomPass → OutputPass`. Variantes: strength 0.55 y 0.62/threshold 0.9, y strength 0 (no cambia nada). **Expected:** media < 1, `>8 int.` = 0.
- [ ] **Paso 3:** commit `Fase 4: UnrealBloomPass`.

### Tarea 5: SMAAPass

**Files:** copiar `SMAAPass.js`, `SMAAShader.js`; `post.wgsl` (+`smaa_edges`, `smaa_weights`, `smaa_blend`); escena `smaa`.

**Interfaces:** Consume Tareas 2–3. `SMAAPass` genera las texturas de búsqueda y área (`searchTexBase64`/`areaTexBase64` de `SMAAShader.js`) con `Image` → `Texture`; Phoenyx debe subirlas sin filtrado de más (área `LinearFilter`, búsqueda `NearestFilter`, `flipY false`). Tamaños `edgesRT`/`weightsRT` `RGBA8`. `SMAAPass(w, h)` va tras `OutputPass` (el juego) y su `setSize`.

- [ ] **Paso 1:** portar las tres etapas de `SMAAShader.js` (`SMAAEdgesShader`, `SMAAWeightsShader` con `SMAA_MAX_SEARCH_STEPS 8` y diagonales desactivadas como en three, `SMAABlendShader`).
- [ ] **Paso 2:** `textures.ts`: carga asíncrona de las imágenes base64; el pase no se ejecuta hasta que están listas (como three: se dibuja sin ellas una copia y no se rompe).
- [ ] **Paso 3:** escena `smaa`: bordes inclinados (cajas rotadas y el techo con rejilla) tras `OutputPass`. **Expected:** media < 1, `>8 int.` = 0 (el AA debe dar los mismos píxeles, no solo parecidos).
- [ ] **Paso 4:** commit `Fase 4: SMAAPass`.

### Tarea 6: `MeshNormalMaterial`, `overrideMaterial` y profundidad legible

**Files:** `MeshNormalMaterial` (copiar de three), `pack.ts` (override), `shader.wgsl` (modo normales), `lib.rs` (profundidad como textura).

**Interfaces:** Produce `scene.overrideMaterial = MeshNormalMaterial` aplicado en `Packer` a cada dibujo opaco/alphaTest como en `WebGLRenderer.renderObject` (mantiene `geometry` y el flag de instancias; ignora `visible=false`), el RT `normalRenderTarget` de GTAO con `HalfFloatType`, `NearestFilter` y `depthTexture` (`DepthTexture(width,height)`, `type FloatType`) cuya vista se pasa a `gl.pass(...)` como `tDepth`. Normales en espacio vista, `packNormalToRGB` (`0.5·n+0.5`) como en `normal_fragment_begin` de three.

- [ ] **Paso 1:** `MeshNormalMaterial` y el flag `overrideMaterial` en `pack.ts`; fuera de ese material → `warnOnce` y se ignora.
- [ ] **Paso 2:** escena `ao-normales` (solo `RenderPass` con `overrideMaterial = MeshNormalMaterial`, salida a pantalla): sala + modelos de fase 2. **Expected:** media < 1, `>8 int.` = 0 (comprueba normales con `flatShading` falso, instancias y `DoubleSide`).
- [ ] **Paso 3:** profundidad: escena `ao-profundidad` que muestra `depthTexture` con un `ShaderPass` de depuración (WGSL propio solo en la escena); comparar `linearizeDepth` con `perspectiveDepthToViewZ` en ambos. **Expected:** media < 1.
- [ ] **Paso 4:** commit `Fase 4: MeshNormalMaterial, overrideMaterial y profundidad como textura`.

### Tarea 7: GTAOPass

**Files:** copiar `GTAOPass.js`, `GTAOShader.js`, `PoissonDenoiseShader.js`; `post.wgsl` (+`gtao`, `poisson_denoise`, `gtao_blend`); escena `ao`.

**Interfaces:** Consume Tareas 2, 3 y 6. `GTAOPass(scene, camera, w, h)` crea `gtaoRenderTarget`, `pdRenderTarget` y `normalRenderTarget`, el ruido `generateMagicSquareNoise` (DataTexture RGBA8 5×5 → 64×64) y las muestras `generatePdSamplePointInitializer` (poisson de `samples = 16` por defecto). Defines `PERSPECTIVE_CAMERA`, `SAMPLES` (el juego usa 8), `NORMAL_VECTOR_TYPE`, `DEPTH_SWIZZLING`; uniformes `cameraProjectionMatrix`, `cameraProjectionMatrixInverse`, `cameraWorldMatrix`, `radius`, `distanceExponent`, `thickness`, `scale`, `sceneBoxMin/Max`, `resolution`. Mezcla final `CustomBlending` con `blendIntensity` (el juego 0.85) sobre `readBuffer`.

- [ ] **Paso 1:** portar `GTAOShader` entero (cosine-weighted horizon search, `FastAcos`, `Bilinear` del buffer de profundidad) y `PoissonDenoiseShader` con `RGBToDepth` si procede; tamaños de grupo/`SAMPLES` por `defines`.
- [ ] **Paso 2:** el juego reemplaza `ao.render` y `ao.setSize` (envoltorios JS) y llama `updateGtaoMaterial` y `updatePdMaterial`: no deben depender de nada interno distinto del código de three copiado (ya lo es).
- [ ] **Paso 3:** escena `ao`: Poolrooms sintéticas (suelo, pilares, techo, agua `visible=false` durante el AO como `setWater(false)`), mitad de resolución con los parámetros del juego; `RenderPass → GTAOPass → UnrealBloomPass → OutputPass → SMAAPass`. **Expected:** media < 1 y ningún píxel de interior > 8; si falla por el ruido, comparar primero `gtaoRenderTarget` aislado con `output = GTAOPass.OUTPUT.AO` y luego con `Denoise`, para localizar la etapa.
- [ ] **Paso 4:** commit `Fase 4: GTAOPass`.

### Tarea 8: punto de control, rendimiento y documentación

**Files:** `web/fidelity/{room.js,scenes.json}` (escena `pool-fx`), `docs/FASE4.md`, `fidelity/baseline/fase4-*`.

- [ ] **Paso 1:** escena `pool-fx`: cadena del juego en las Poolrooms con GLB reales (`RenderPass → GTAO(½) → Bloom → Output → SMAA`, sol con sombra de fase 3, niebla, `ao.enabled` alternado). Capturar con `--renderer three` y `phoenyx`, `compare.mjs`. **Expected:** media < 1 y `>8 int.` = 0; las 17 escenas previas y las nuevas pasan (`composer`, `composer-out`, `rt`, `bloom`, `smaa`, `ao-normales`, `ao-profundidad`, `ao`, `pool-fx`).
- [ ] **Paso 2:** rendimiento: `capture.mjs --throttle 1` y `--throttle 4` con `pool-fx` y `bloom`, para three y Phoenyx (`fidelity/baseline/fase4-*/perf.json`). Anotar mediana de fotograma y número de pasadas; objetivo: no peor que three.
- [ ] **Paso 3:** `docs/FASE4.md` (qué hay, formatos, fidelidad, rendimiento, límites y revisión), ledger `.superpowers/progress-fase4.md`.
- [ ] **Paso 4:** revisión final con un revisor Sonnet sobre toda la rama (con el Review Focus de este plan), una sola pasada de correcciones, push y presentación del punto de control 4 al dueño.
