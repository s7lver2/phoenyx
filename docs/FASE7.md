# Fase 7: Points, Sprite, Line, Physical, Reflector y migración del juego (estado)

## Qué hay
- **Points / Sprite / Line** integrados (ids de usuario 20, 21, 22; `user/points_basic.wgsl`, `sprite_basic.wgsl`, `line_basic.wgsl`): `PointsMaterial` (tamaño con atenuación, `map`, color de vértice, `alphaTest`, mínimo 1 px), `SpriteMaterial` (`center`, rotación, ordenación por z proyectada) y `LineBasicMaterial` (`Line`, `LineLoop`, `LineSegments` como `line-list`). Parche de `onBeforeCompile` del polvo del parking (`PointsMaterial`, id 5).
- **MeshPhysicalMaterial**: `ior`, `specularIntensity/Color`, `clearcoat`, `clearcoatRoughness`, `sheen` (luces directas) y **entorno PMREM** (`scene.environment`, formato CubeUV): `PMREMGenerator` de three sin tocar + el desenfoque esférico en `post.wgsl` (pase 14), `cube_uv.wgsl` compartido, `envMapIntensity`. Los render targets respetan `viewport` y `scissor`.
- **Reflector**: `jsm/objects/Reflector.js` sin tocar. `render()` ejecuta antes de empaquetar el `onBeforeRender` de los objetos visibles (visibilidad, capas, frustum); el render anidado termina entero antes del exterior. Resguardos `xr`, `state`, `shadowMap.autoUpdate`. Sin MSAA (el `samples` del RT se ignora).
- **Shaders de agua** (ids 30–33): `pool.ts` (PoolWater), `poolmap.ts` (profundidad y borde por vértice, cara trasera), alfombra pulida de `world.ts`, charcos del parking.
- **API del renderer** que usa el juego: `getDrawingBufferSize`, `getContext()` (isContextLost, `WEBGL_debug_renderer_info`), `extensions`, `capabilities`, `initTexture`, `setAnimationLoop`, `forceContextLoss`, `compile`/`compileAsync`. `Raycaster` es el de three sin cambios. `GridHelper` y `OrbitControls` (herramientas de desarrollo).
- **Cambio de importaciones**: `RENDERER=phoenyx` en `client/vite.config.ts` aliasa `three` y `three/examples/jsm/*` a Phoenyx (`PHOENYX_DIR`, por defecto `E:/phoenix`). Configuraciones de arranque: `client-phoenyx-5192` y `client-three-5193` (`.claude/launch.json`).

## Fidelidad (escenas de `web/fidelity`)
| Escena | media | máx | >8 interior |
|---|---|---|---|
| sh-points-patch, sh-sprite, sh-line, sh-physical, sh-ibl | ≤ 0,007 | ≤ 168 (bordes) | 0 |
| sh-pool-water, sh-poolmap-water, sh-poolmap-water-under, sh-puddles | ≤ 0,0003 | ≤ 52 | 0 |
| sh-world-carpet | 0,017 | 14 | 331 (bordes del reflejo; three usa MSAA x4 por defecto) |
| sh-points | 0,008 | 89 | 12 |
| sh-pooltile | 0,12 | 13 | 316 (el blob de fase 6, ahora con clearcoat real) |

Siguen fallando las conocidas: `ao`, `ao-mezcla`, `pool-fx` (1 px), `sh-vhs` en bruto y `sh-pooltile`.

## El juego con Phoenyx (`?capture`, preajuste high)
- Nivel 0 (`level0-inicio`, `level0-semilla7`): media 0,019 y 0,012, 0 píxeles de interior > 8.
- Poolrooms y Suites: iguales a la vista (agua, reflejos, cúpula, alfombra), pero la cifra no se puede comparar. Las texturas de ruido y el polvo salen de `Math.random()`; el orden de las cargas asíncronas hace que el flujo difiera entre ejecuciones (three contra three en Poolrooms ya da media 25). Un relleno de UUID en el constructor no lo arregla.
- **No probados**: Parking, Wait, Vents y Run solo se alcanzan por sala multijugador (necesita servidor); quedan para una pasada manual.

## Pendiente / conocido
- MSAA de los render targets (Reflector) no implementado.
- Phoenyx dibuja más triángulos que three en Suites (503 k contra 445 k) y es más lento en escenas mínimas (gasto fijo por fotograma): fase 8.
- Mejoras menores de fases anteriores siguen en el ledger antiguo.
