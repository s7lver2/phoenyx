# Fase 8: rendimiento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Ledger: `.superpowers/progress-fase8.md`.

**Goal:** que el juego con Phoenyx gaste menos CPU y GPU por fotograma que con three, sin cambiar la imagen.

**Spec:** `docs/superpowers/specs/2026-11-17-phoenyx-reemplazo-three-design.md` (punto 8: medición antes/después y optimización).

## Línea base (medida 2026-11-19, `fidelity/baseline/fase8/game-*`, ms por fotograma, rAF sin vsync)
| escena | three x1 | phoenyx x1 | three x4 | phoenyx x4 |
|---|---|---|---|---|
| level0-inicio | 17,2 | 6,0 | 27,6 | 31,4 |
| level0-semilla7 | 4,4 | 6,7 | 27,1 | 37,3 |
| poolrooms | 1,8 | 2,4 | 11,9 | 12,6 |
| suites | 13,0 | 17,6 | 62,5 | 87,5 |

Perfil de CPU (`tools/fidelity/profile.mjs`, suites x4, ms/fotograma): `updateMatrixWorld`+`multiplyMatrices` 38 (three: 17; Phoenyx lo hacía dos veces), pack 6,2, project 3,9, geomId 2,2, visit (hook) 1,9, materialKey 1,6, matIndex 1,4. A x1 suites Phoenyx está limitado por GPU (CPU 2,7 ms de 20).

## Objetivo
En las cuatro escenas Phoenyx ≤ three, a x1 y x4 (mediana de `capture.mjs`).

## Tareas
- **T1 (hecha)** Perfilador (`tools/fidelity/profile.mjs`) y `updateMatrixWorld` una sola vez por `render()` (`FrameState.matricesDone`).
- **T2** Temporizadores de GPU en `phoenyx-gl` (timestamps por fase: sombras, principal, post) expuestos como `renderer.info.gpu`; medir suites x1 para decidir T3/T4. Verificación: cifras por fase en el ledger.
- **T3** GPU de suites: según T2 (candidatos: bucle de luces por fragmento sin descarte por distancia → lista de luces por celdas o descarte barato; triángulos 503 k contra 445 k de three → causa del culling). Verificación: suites x1 ≤ three y fidelidad igual.
- **T4** CPU de `pack`/`project`/`geomId`/`materialKey`/`matIndex`: reutilizar arrays tipados y cachés por identidad (sin asignaciones por fotograma); fundir el recorrido de `runBeforeRender` si el perfil lo justifica. Verificación: perfil suites x4 y level0-semilla7 x4.
- **T5** Regresión: escenas de `web/fidelity` (solo fallos conocidos) y capturas del juego (level0 0 px de interior); `docs/FASE8.md` con antes/después.

## Review Focus
- Cambios de escena entre fotogramas con caches (un objeto que cambia de material/geometría debe seguir dibujándose bien).
- Reflector / render anidado con las matrices ya actualizadas.
