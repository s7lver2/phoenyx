# Fase 6: ShaderMaterial y parches de material (`onBeforeCompile`). Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:executing-plans (ejecución nativa). Casillas `- [ ]`. Revisores: nunca Opus (orden del dueño); usar Sonnet.

**Objetivo:** que todos los `ShaderMaterial` del juego y los materiales estándar parcheados con `onBeforeCompile` se vean con Phoenyx igual que con three, y que los pases `FilmShader`/`VhsShader` (pendientes de la fase 4) funcionen.

**Arquitectura:** hoy el renderer solo dibuja Basic/Standard/MeshNormal y los pases de pantalla completa conocidos (por el texto exacto de su `fragmentShader`). Esta fase añade dos mecanismos con el mismo criterio (registro por texto exacto del GLSL, WGSL portado a mano, sin traducción automática):
1. **Shader de usuario** (`ShaderMaterial` en la escena): `crates/phoenyx-gl/src/user/<archivo>.wgsl` aporta `vs_user`/`fs_user` por material; `packages/phoenyx/src/user-shaders/<archivo>.ts` registra por `vertexShader + fragmentShader` el id, el empaquetado de `uniforms` (los `value` de three: números, `Color`, `Vector*`, `Matrix*`, texturas) y los atributos. Pipeline propio por (shader, blending, side, depthWrite/Test), con la niebla de escena si `fog: true` y los defines. Uniformes por dibujo en un tramo del buffer (como los pases), texturas en el grupo 1.
2. **Parche de material estándar** (`onBeforeCompile`): el parche reescribe chunks GLSL (`#include <…>`) de un Standard/Basic. Cada parche se porta a una **variante del sombreador estándar** (`shader.wgsl`) con ganchos por chunk (constantes de pipeline y funciones de inserción); clave = `customProgramCacheKey()` o el hash del texto del parche; los uniformes añadidos viajan en un registro de uniformes por material.

**Tech Stack:** el de las fases 1–5. **Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md` (fase 6: «los 22 `ShaderMaterial` se portan a mano a WGSL… un punto de control por cada archivo portado»). Estado anterior y límites: `docs/FASE5.md`, `docs/FASE4.md`.

## Inventario (cliente `E:\backrooms\client\src`, medido)
| Archivo | Casos | Notas |
|---|---|---|
| `game/vhsPass.ts` (+ `game.ts:425`) | `FilmShader`, `VhsShader` (`ShaderPass`) | pases de pantalla completa (mecanismo de la fase 4) |
| `game/waterjet.ts` | 1 `ShaderMaterial` | chorro |
| `game/parking-atmosphere.ts` | 2 (niebla volumétrica en cajas, haces en conos) | transparentes, aditivos |
| `game/remote.ts` | 1 | jugadores remotos |
| `game/vents.ts` | 1 (+ target a pantallas) | conductos |
| `game/game.ts:431` | polvo (`dust`, uniforms animados) | |
| `game/world.ts` | 3: haces (733), cielo (966), polvo (1451) | + `rf.material` (Reflector → fase 7) |
| `game/cosmetics.ts:107` | `onBeforeCompile`, clave `cos-tint` | tinte de cosméticos |
| `game/lightmap.ts:40` | `onBeforeCompile` (lightmap) | parcha Standard |
| `game/parking.ts:125,1101` | 2 parches (hormigón/rugosidad y otro) | |
| `game/poolmap.ts:442` | parche `poolTile` | |
| `pool.ts`, `poolmap.ts`, `parking-puddles.ts`, `world.ts:603` | materiales de `Reflector` | **fase 7**, no se portan aquí |

## Restricciones globales
- Mismo criterio que las fases previas: error medio < 1/255 y ningún píxel de interior > 8/255 por escena de referencia; el shader se porta línea a línea, sin retocarlo para «aprobar la métrica»; comentarios en español; un commit por archivo del juego portado; sin tests unitarios.
- Las escenas de fidelidad construyen el **material real del juego** (se copia a `web/fidelity/games/<archivo>.js` el GLSL y los uniforms de la fábrica, sin las dependencias del juego) y fijan el tiempo (`uTime` constante) para que ambos renderers dibujen lo mismo.
- Un `ShaderMaterial` o parche sin WGSL registrado avisa una vez y no se dibuja (los pases avisan y copian), nunca rompe el fotograma.
- Código de three no se edita a mano.

## Review Focus
- Mismo `ShaderMaterial` clonado o con `uniforms` compartidos entre mallas: cada dibujo lee los `value` actuales, no los de otro.
- Uniforms que cambian cada fotograma (`uTime`, `Vector3.set`, texturas intercambiadas): se reempaquetan sin recrear pipelines.
- `transparent`, `blending` (Additive/Normal), `depthWrite=false`, `side` y `fog` del material dentro del orden de dibujo de la fase 1.
- Dos materiales con la misma `customProgramCacheKey` y distinto texto de parche: se toma la de three (misma clave = mismo programa).
- `defines`, `extensions`, `derivatives` y `glslVersion` en el material: se avisan si no están soportados.
- Materiales con `map` + parche: el grupo de texturas del Standard sigue vigente.

## Estructura de archivos
- `packages/phoenyx/src/{user-shaders/*.ts,pack.ts,renderer.ts,textures.ts}`: registro, empaquetado de uniforms, pipeline por shader.
- `crates/phoenyx-gl/src/{lib.rs,user/*.wgsl,shader.wgsl}`: pipelines de usuario, variantes del Standard con ganchos.
- `web/fidelity/{room.js,scenes.json,games/*.js}`: escenas `sh-<archivo>`.
- `docs/FASE6.md`, `fidelity/baseline/fase6-*`.

---

### Tarea 1: mecanismo de shader de usuario (sin archivos del juego)
**Files:** `lib.rs`, `renderer.ts`, `pack.ts`, `user-shaders/index.ts` (nuevo), `user/_prueba.wgsl`; escena `sh-prueba`.
- [ ] **Paso 1:** `registerUserShader({ vertex, fragment }, { id, attributes, pack(material) → f32[], textures(material) → id[] })` y un `ShaderMaterial` de prueba (gradiente por `uTime`, color `uColor`, textura) en la escena `sh-prueba`; capturar three.
- [ ] **Paso 2:** `lib.rs`: pipeline de usuario por `(id, flags)`; el dibujo lleva el tramo de uniformes (ampliar `draws` a 16 u32 si hace falta); `vs_user`/`fs_user` comparten cabecera (`Globals`, matrices, niebla) y el material aporta su cuerpo.
- [ ] **Paso 3:** `pack.ts`: `material.isShaderMaterial` se ordena y dibuja como los demás (transparencia, `renderOrder`, culling, `side`, `depthWrite`, blending con `blendOf`); los `uniforms` se empaquetan cada fotograma desde sus `value`.
- [ ] **Paso 4:** comparar. **Expected:** media < 1, `>8 int.` = 0; las 39 escenas previas sin cambios. Commit: «Fase 6: mecanismo de ShaderMaterial».

### Tarea 2: `vhsPass.ts` (FilmShader y VhsShader)
- [ ] Portar los dos fragment shaders al mecanismo de pases (ids nuevos en `post.wgsl`/`post-shaders.ts`); escena `sh-vhs` (RenderPass → Film → Vhs → Output con `time` fijo); comparar; commit «Fase 6: vhsPass».

### Tareas 3 a 8: un archivo del juego por tarea (punto de control cada una)
Para cada una: leer el GLSL, portarlo a `user/<archivo>.wgsl`, registrar, escena `sh-<archivo>` con el material real y tiempo fijo, comparar, commit «Fase 6: <archivo>». Orden (de menor a mayor riesgo):
- [ ] **T3** `waterjet.ts`. **T4** `parking-atmosphere.ts` (2 materiales, aditivos/transparentes). **T5** `remote.ts`. **T6** `vents.ts`. **T7** `game.ts` (polvo). **T8** `world.ts` (haces, cielo, polvo; sin los Reflector).

### Tarea 9: `onBeforeCompile` (variantes del Standard)
**Files:** `shader.wgsl` (ganchos por chunk), `lib.rs`, `pack.ts`, `user-shaders/patches.ts`; escenas `sh-cosmetics`, `sh-lightmap`, `sh-parking`, `sh-poolmap`.
- [ ] **Paso 1:** ganchos en `shader.wgsl` para los chunks que tocan los parches (se listan al leer los 5 parches: `roughnessmap_fragment`, `map_fragment`, `color_fragment`, `lights_fragment_*`…) como funciones sustituibles por pipeline; el Standard sin parche usa la función por defecto (sin cambio visual ni de coste).
- [ ] **Paso 2:** registro de parches por `customProgramCacheKey()` (o hash del texto): WGSL de cada gancho y empaquetado de los uniformes que el parche añade a `shader.uniforms`.
- [ ] **Paso 3:** portar de uno en uno, con su escena y su commit: `cosmetics.ts`, `lightmap.ts`, `parking.ts` (2 parches), `poolmap.ts` (`poolTile`). **Expected:** media < 1, `>8 int.` = 0.

### Tarea 10: cierre
- [ ] **Paso 1:** rendimiento: `capture.mjs --throttle 1` y `4` con las escenas `sh-*`, three y Phoenyx (`fidelity/baseline/fase6-*/perf.json`).
- [ ] **Paso 2:** `docs/FASE6.md`, ledger `.superpowers/progress-fase6.md`.
- [ ] **Paso 3:** revisión final con un revisor Sonnet sobre toda la rama (Review Focus de este plan), una sola pasada de correcciones (solo Críticos/Importantes), push y punto de control 6 al dueño.

## Notas de alcance
- Los `Reflector` (agua de `pool`, `poolmap`, `world`, charcos de `parking-puddles`) llevan su propio `ShaderMaterial` interno y entran en la fase 7 con `Reflector`.
- `ShaderMaterial` con piel o instanciado: no lo usa el juego (se avisa).
- La animación (`uTime`) no se mide por métrica: cada escena fija el tiempo y se compara el fotograma.
