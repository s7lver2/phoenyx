# Fase 8: rendimiento (estado)

## Qué se hizo
- **Temporizadores de GPU** (`phoenyx-gl`, `timestamp-query`): `renderer.setGpuTiming(true)` y `renderer.gpuTimes()` devuelven los ms de `shadow`, `scene` y `pass<id>` (pases de pantalla completa). Sin soporte no hacen nada.
- **Perfilador** `tools/fidelity/profile.mjs` (CPU por función, inclusivo con `--incl`, llamadores con `--callers`), `exp.mjs` (GPU por fase), `cnt.mjs` y `chg.mjs` (llamadas y objetos que se mueven por fotograma).
- **Matrices del mundo una sola vez por `render()`**: `runBeforeRender` las actualiza y `pack` ya no repite el recorrido (`FrameState.matricesDone`). Era el mayor gasto propio: en Suites el grafo se recorría dos veces.
- **Claves sin cadenas**: `geomId` compara referencia, versión y tamaño de los atributos (sin construir una clave de texto por objeto y fotograma); `materialKey` y `samplerId` recuerdan el último resultado por material y textura.
- **`pack`**: la matriz normal se escribe directo y `emit`/`bits` se declaran una vez fuera del bucle (antes eran dos closures por objeto).

## Medidas (juego real, `?capture`, preajuste high, CPU ocupada por fotograma, CPU 4x más lenta)
| Escena | three | Phoenyx antes | Phoenyx ahora |
|---|---|---|---|
| level0-inicio | 49,3 ms | 52,1 | 49,6 |
| poolrooms | 29,8 | 28,0 | 28,0 |
| suites | 114,5 | 113 | 105 |

`render()` de Suites a 4x: 74 ms → 57 ms (`pack` inclusivo 34 → 24). GPU de Suites: 0,33 ms la escena y ~0,07 ms el postproceso: la GPU no es el cuello; lo es la CPU del juego (grafo de escena y lógica, comunes a three y Phoenyx). Con CPU normal el fotograma queda limitado por el vsync a 60 Hz en ambos. Las medidas varían ±10 % entre ejecuciones.

## Probado y descartado
- **Matrices sucias** (recomponer solo lo que cambia posición/rotación/escala): sin ganancia en Suites (el 41 % de los objetos se mueve cada fotograma, con subárboles pesados) y arriesgado (un servidor de desarrollo con la versión antigua dio imágenes desplazadas). Revertido.
- Cluster de luces: no hace falta mientras la GPU no limite.

## Fidelidad
Escenas de `web/fidelity`: solo los fallos conocidos (`ao`, `ao-mezcla`, `pool-fx`, `sh-points`, `sh-pooltile`, `sh-vhs`, `sh-vhs-corrupto`, `sh-world-carpet`). Juego: level0-inicio 0,019 y level0-semilla7 0,012, 0 píxeles de interior > 8/255.

## Pendiente
- Los pases de pantalla completa crean un bind group por pase y fotograma (~0,7 ms a 4x); cachearlos.
- El recorrido de `runBeforeRender` (hooks del Reflector) es una pasada extra por el grafo (~2 ms a 4x).
- Parking, Wait, Vents y Run sin probar (necesitan sala multijugador); MSAA del Reflector.
