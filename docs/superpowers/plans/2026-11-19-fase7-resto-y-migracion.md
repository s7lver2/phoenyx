# Fase 7: resto (Points, Sprite, Line, Physical, Reflector) y migración final

> **Para el ejecutor:** superpowers:executing-plans (inline), con el ledger `.superpowers/progress-fase7.md` (git-ignorado). Sin tests unitarios: la verificación es el banco de fidelidad (media < 1/255, ningún píxel de interior > 8/255) y, al final, partida real.

**Meta:** que el juego (`E:\backrooms\client`, rama `phoenyx-migracion`) funcione sustituyendo `three` por Phoenyx en todos los niveles.

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md` (fase 7). Estado de partida: `docs/FASE6.md`.

## Restricciones globales
- Comentarios en español. Un commit por función/archivo terminado, con `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Máx. 2 subagentes a la vez; revisores Sonnet (nunca Opus); navegador solo si hace falta.
- WGSL portado línea a línea del GLSL de three 0.160.1 (`points_vert/frag`, `sprite_vert/frag`, `linedashed`/`meshbasic` de línea).
- Cada material nuevo se valida con una escena `sh-*` en `web/fidelity` (three vs Phoenyx).
- Orden de las tareas = orden de dependencia. Sin pausas entre tareas; las dudas se deciden y se anotan como `Ruling:` en el ledger.

## Inventario del juego (medido)
| Qué | Dónde |
|---|---|
| `PointsMaterial` (size, sizeAttenuation, map, vertexColors, opacity, alphaTest, additive) | entity, explosion, game (marcador), runlevel, tvRoom, waitKit, world (motas), parking (polvo con `onBeforeCompile`) |
| `Sprite`/`SpriteMaterial` (map, color, opacity, additive, fog:false) | game (humo), holo, mission, rarityFx, remote, waitDecor |
| `LineSegments`/`Line` + `LineBasicMaterial` (color, opacity, fog, depthTest false) | game (rayos X, línea de apuntado), parking (grietas), parking-atmosphere (goteo) |
| `MeshPhysicalMaterial` extras | pool/poolmap/parking: `clearcoat`, `clearcoatRoughness`, `specularIntensity`; `envMapIntensity` sin `envMap` |
| `Reflector` con shader propio | pool.ts (agua), poolmap.ts (agua), world.ts (alfombra pulida), parking-puddles.ts (charcos) |
| `Raycaster` | game (aimRay), parking (focusRay, colisiones): es de three copiado; solo comprobar |
| Renderer: `getDrawingBufferSize`, `getContext()`, `extensions`, `compile`, `forceContextLoss`, `capabilities`, `state`, `initTexture`, `setAnimationLoop` | game.ts, compile.ts, Computer/InvAvatar/invIcons/ItemView/wardThumbs (renderers secundarios) |

## Tareas
- [ ] **T1 Points/PointsMaterial.** Camino de dibujo integrado (id de usuario reservado, p. ej. 20, con `_points.wgsl`): `size`, `sizeAttenuation` (`scale = H/2`), `map` (+`uvTransform`), `vertexColors`, `opacity`, `alphaTest`, niebla, mezcla, `depthWrite/Test`, `toneMapped`. `pack.ts` deja de omitir `isPoints` con material estándar. Escena `sh-points`.
- [ ] **T2 Sprite/SpriteMaterial.** Quad en pantalla (`sprite_vert`: `center`, `rotation`, `sizeAttenuation`, escala de la matriz del mundo), `map`, `color`, `opacity`, `alphaTest`, `fog`, mezcla. Escena `sh-sprite`.
- [ ] **T3 Line/LineSegments/LineBasicMaterial.** Pipeline `line-list` (Line se expande a pares al empaquetar; 1 px), color/opacity/fog/depthTest. Escena `sh-line`.
- [ ] **T4 Polvo del parking.** Parche de `onBeforeCompile` de `PointsMaterial` (huella FNV como en fase 6): movimiento por `dustTime`. Escena `sh-points-patch`.
- [ ] **T5 `MeshPhysicalMaterial`.** `clearcoat`, `clearcoatRoughness`, `specularIntensity`/`specularColor` en `shader.wgsl` (puerto de `lights_physical_*`); `envMapIntensity` sin `envMap` no hace nada. Sacar el hack `clearcoat: 0.0001` de `sh-pooltile`. Escena `sh-physical`.
- [ ] **T6 Reflector (núcleo).** Sincronizar `Reflector.js` de three (jsm); `render()` ejecuta antes del empaquetado `onBeforeRender` de los objetos visibles que lo definan (re-entrante: el render anidado usa su propio Packer/RT); resguardos en el renderer que el Reflector toca (`xr.enabled`, `state.buffers.depth.setMask`, `shadowMap.autoUpdate`); `WebGLRenderTarget` HalfFloat sin MSAA. Validar con el agua de `pool.ts`.
- [ ] **T7 Agua de `pool.ts`.** `PoolWater` (vert+frag del juego) a WGSL como shader de usuario con `tDiffuse`, `textureMatrix`, niebla. Escena `sh-pool-water`.
- [ ] **T8 Agua de `poolmap.ts`.** Variante (caras traseras, cáusticas, espuma por vértice). Escena `sh-poolmap-water`.
- [ ] **T9 Alfombra de `world.ts` y charcos de `parking-puddles.ts`.** Escenas `sh-world-carpet`, `sh-puddles`.
- [ ] **T10 Raycaster y API del renderer.** Comprobar `Raycaster` sobre mallas/instancias de Phoenyx (script en navegador contra la sala de pruebas); añadir `getDrawingBufferSize`, `getContext()` (shim con `isContextLost`/`getExtension`), `extensions`, `capabilities`, `compile`, `compileAsync`, `forceContextLoss`, `initTexture`, `setAnimationLoop`, `state`, `xr`.
- [ ] **T11 Cambio de importaciones.** En el cliente: `RENDERER=phoenyx` en `vite.config.ts` aliasa `three` → `E:/phoenix/packages/phoenyx/src/index.ts` y `three/examples/jsm/*` → `…/src/jsm/*` (faltan: `Reflector`, `OrbitControls` solo para dev). Build y arranque limpio sin errores de consola.
- [ ] **T12 Partida en cada nivel.** Cargar cada nivel con Phoenyx (Backrooms, Parking, Poolrooms, Wait, Vents, Run, Computer, etc.), capturar con `window.__capture` (cliente) y comparar con la misma captura en three. Cada divergencia de fidelidad > umbral se arregla aquí o se registra como ruling.
- [ ] **T13 Docs y cierre.** `docs/FASE7.md` (qué hay, cobertura, fidelidad, rendimiento, rulings), revisión final Sonnet de la rama, UNA pasada de arreglos (solo Critical/Important), push y punto de control 7.

## Review Focus (lo que ningún test cubre y puede romper)
1. Render anidado del Reflector: el reflejo no debe dejar el destino ni el packer del fotograma exterior en estado inválido.
2. `Points` fuera de pantalla y de menos de 1 px: igual que WebGL (mínimo 1 px).
3. Renderers secundarios (iconos, avatares, ItemView): muchos dispositivos wgpu a la vez; no deben fallar ni filtrarse.
4. `Line` con `depthTest:false` y `renderOrder`: el orden de dibujo respeta `renderOrder`.
5. Pérdida de contexto (`isContextLost`) que el juego consulta: el shim debe devolver false mientras la GPU viva y true tras `forceContextLoss`.
