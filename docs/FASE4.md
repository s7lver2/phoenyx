# Fase 4: postproceso (estado)

## Qué hay
- **Render targets**: `WebGLRenderTarget` (RGBA16F con `HalfFloatType`, RGBA8 por defecto) con `DepthTexture` opcional, `renderer.setRenderTarget/getRenderTarget`, `clear/clearDepth`, `get/setClearColor`, `get/setClearAlpha`, `autoClear*`. Las texturas de un target se usan como `map` o como entrada de un pase. Un target guarda la imagen como WebGL (fila 0 abajo: y de clip invertida, cara frontal invertida y signo de `dpdy`), por eso `vUv` de los pases es el de three. Dentro de un target no hay tone mapping ni OETF sRGB (salida lineal), como three.
- **`EffectComposer`, `RenderPass`, `ShaderPass`, `MaskPass`, `Pass`** son el JS de three (copiado, no reescrito). `renderer.render(mesh con ShaderMaterial)` se reconoce como un pase de pantalla completa.
- **Pases portados a WGSL** (`crates/phoenyx-gl/src/post.wgsl`, línea a línea desde el GLSL de three 0.160.1). Se asocian al `ShaderMaterial` por el **texto exacto de su `fragmentShader`** (`packages/phoenyx/src/passes.ts` + `post-shaders.ts`); un shader desconocido avisa una vez y copia `tDiffuse`:

| id | Shader | Pase de three |
|---|---|---|
| 0 | `CopyShader` | `ShaderPass`, copias de `GTAOPass`/`UnrealBloomPass` |
| 1 | `OutputShader` | `OutputPass` (Linear, Reinhard, Cineon, ACES + sRGB) |
| 2–4 | luminancia alta, blur gaussiano separable, composición de mips | `UnrealBloomPass` |
| 5–7 | bordes, pesos, mezcla | `SMAAPass` |
| 8 | `GTAOShader` | `GTAOPass` (ambient occlusion) |
| 9 | `PoissonDenoiseShader` | `GTAOPass` (denoise) |
| 10, 11 | mezcla multiplicativa (`DstColor`/`Zero`) y profundidad lineal | `GTAOPass` |

- **`MeshNormalMaterial` y `scene.overrideMaterial`** (solo con `MeshNormalMaterial`, lo que usa `GTAOPass`): se ordena por el material original de cada objeto y se dibuja con el del override; sin tone mapping, sin espacio de color y sin niebla.
- **Profundidad como textura**: un `DepthTexture` se registra como textura legible (`Depth32Float`; three usa 24 bits) y los pases la leen con `textureLoad` (equivale al `NearestFilter` de three).
- **Mezcla**: `blendOf` convierte `blending/blendSrc/blendDst/blendEquation*` del material a la mezcla de wgpu con las mismas constantes que three.
- **Limpieza como three**: con `scene.background` (Color) three limpia siempre, según `autoClearColor`/`autoClearDepth` aunque `autoClear` sea falso, y esa limpieza va después de un `renderer.clear()` previo (RenderPass lo hace), así que su color manda.
- **Pases en un solo submit**: los pases se graban en un único `CommandEncoder` con un tramo propio del buffer de uniformes cada uno y se envían juntos (`Gl::flush`: lo llaman solos `frame`, `resize`, `create_target`/`drop_target`, y el renderer lo programa con `queueMicrotask` al acabar la tarea).

## Formatos
- `Gl::create_target(color_id, w, h, fmt, depth_id)`: `fmt` 1 = RGBA16F, 2 = RGBA8; `set_target(id | u32::MAX)`; `clear(r, g, b, a, color, depth)` (pendiente, se aplica en el siguiente dibujo al target).
- `Gl::pass(shader, uniforms f32[≤256], blend u32[7], tex u32[6])`: `blend` = `[modo, srcRGB, dstRGB, ecuación, srcA, dstA, ecuaciónA]` con las constantes de three; `tex` = 5 texturas filtrables (`t0`..`t4`) y la de profundidad (`td`, sin filtrar). Cada shader define el orden de sus uniformes en `post-shaders.ts` y en el comentario de su `fn` en `post.wgsl`.
- Pipelines de escena con clave `(flags & 31) | (fmt << 5)`; `globals[48]` = banderas de limpieza (bit 0 color, bit 1 profundidad), `globals[58]` = salida lineal.

## Fidelidad (punto de control 4, 34 escenas, 1280x720)
Las 18 escenas de las fases 1–3 no cambian. Nuevas (error medio en /255, píxeles de interior > 8):

| Escena | media | máx | >8 interior |
|---|---|---|---|
| rt (escena pequeña a render targets, mostrada como `map`) | 0 | 1 | 0 |
| composer, composer-out (RenderPass → ShaderPass / OutputPass) | 0,0002 | 1 | 0 |
| bloom, bloom-fuerte, bloom-cero | ≤ 0,0001 | 1 | 0 |
| smaa (+ las 3 texturas internas) | 0,0002 | 41 (borde) | 0 |
| ao-normales (override MeshNormalMaterial) | 0 | 1 | 0 |
| ao-ao / ao-denoise / ao-depth / ao-normal (salidas de GTAOPass) | 0,0002 / 0,0002 / 0 / 0 | 6 / 7 / 0 / 3 | 0 |
| pool-fx-salida, pool-fx-sinao | 0,0016 / 0,0023 | 104 / 40 (bordes) | 0 |
| **ao** (cadena completa), **ao-mezcla**, **pool-fx** (cadena del juego con sol, sombra y niebla) | 0,0046 / 0,0047 / 0,0052 | 37 / 21 / 41 | **1** |

El único píxel de interior > 8 de esas tres escenas es el mismo (el contorno del Nokia, 511,475): ya difiere ~13/255 en `pool-fx-sinao`, sin GTAO, donde `compare.mjs` lo cuenta como borde; con GTAO la oclusión suaviza el gradiente de la imagen de referencia por debajo del umbral de borde y pasa a contar como interior. Las salidas intermedias de GTAOPass coinciden, así que no hay error de oclusión detrás.

## Rendimiento (mediana de fotograma, ms; `fidelity/baseline/fase4-*/perf.json`)
| Escena | three 1x | Phoenyx 1x | three 4x | Phoenyx 4x |
|---|---|---|---|---|
| bloom | 0,8 | 1,1 | 5,9 | 8,0 |
| smaa | 0,6 | 0,8 | 5,3 | 6,0 |
| ao (cadena completa) | 1,2 | 1,3 | 10,9 | 11,2 |
| pool-fx-sinao | 1,2 | 1,3 | 10,8 | 9,8 |
| pool-fx | 1,6 | 1,7 | 14,5 | 13,3 |

Con un submit por pase, `ao` costaba 9 ms y `pool-fx` 4,3 ms a 1x; grabar todos los pases en un encoder lo deja a la par de three. `bloom` (15 pases pequeños) y `smaa` siguen algo por encima a 4x: el coste que queda es el de crear un bind group por pase (cachearlos es trabajo de la fase 8).

## Límites conocidos
- Pases con `ShaderMaterial` propio (`FilmShader`, `VhsShader` del juego) necesitan su WGSL: se registran con el mismo mecanismo en la fase 6; mientras tanto avisan y copian la entrada.
- `MaskPass`/stencil, `readRenderTargetPixels`, `AgXToneMapping`, `overrideMaterial` distinto de `MeshNormalMaterial`, `GTAOPass` con profundidad en el canal `w` o `NORMAL_VECTOR_TYPE` 0 con `DEPTH_VALUE_SOURCE` 1 (avisan).
- La profundidad es `Depth32Float` (three: 24 bits). Cuantizarla a 24 bits en el shader no mejoró la oclusión (probado, descartado).
- `bicorn_hat.glb` dibujado con `overrideMaterial = MeshNormalMaterial` sale con ruido en three (z-fighting); las escenas `ao*` y `pool-fx*` no lo incluyen.
- Sin resolver de fases anteriores: `MeshPhysicalMaterial` con `transmission` (fase 6), wireframe, `envMap`, `Points`/`Sprite`/`Line` y sombras de `SkinnedMesh` (fase 5), sombras de `PointLight` y `VSMShadowMap`.

## Revisión final (Sonnet) y correcciones
Sin hallazgos Críticos ni Importantes; los 5 puntos del Review Focus (resize, `enabled`/`removePass`, `render` a RT durante el composer, feedback, fondo/alpha) son correctos y el batching de pases no tiene caminos que lean o escriban entre grabar y enviar. Aplazados (menores): un RT usado como `map` antes de su primer render se ve blanco (three: negro), oyentes `dispose` acumulados por recreación, `clear()` pendiente consumido por un pase de pantalla (profundidad), pipelines de pase creados en el primer uso, `blendOf` sin Multiply/Subtractive. Pendiente para las fases 6/7: `WebGLRenderer` aún no tiene `getDrawingBufferSize`, `getContext`, `forceContextLoss` ni `compile`, que el juego llama.
