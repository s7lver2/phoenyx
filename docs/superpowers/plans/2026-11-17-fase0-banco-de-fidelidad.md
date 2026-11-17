# Fase 0: rama, modo captura y banco de fidelidad. Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar superpowers:subagent-driven-development (recomendado) o superpowers:executing-plans para ejecutar este plan tarea a tarea. Los pasos usan casillas (`- [ ]`).

**Objetivo:** dejar lista la rama de Backrooms, un modo de captura determinista del juego y una herramienta que compare imágenes y mida rendimiento, para poder juzgar la fidelidad y la velocidad de Phoenyx en cada fase siguiente.

**Arquitectura:** el juego (three 0.160, WebGL) gana un modo `?capture` solo en desarrollo que congela semilla y reloj y expone `window.__capture`. Un script Node (Playwright) abre cada escena de referencia, guarda capturas y cifras; otro compara dos carpetas de capturas y genera mapa de diferencias e informe. Las cifras de base se guardan para fijar el objetivo de la fase 8.

**Stack:** Backrooms client (Vite, React, three 0.160); Node 22; Playwright (Chromium con GPU), `pngjs` y `pixelmatch`.

**Spec:** `E:\phoenix\docs\superpowers\specs\2026-11-17-phoenyx-reemplazo-three-design.md`

## Restricciones globales
- Rama aparte en Backrooms (`phoenyx-migracion`); `master` no se toca; no se commitea `.claude/launch.json` (cambio local del dueño).
- Sin tests unitarios (regla del proyecto); la herramienta de comparación es verificación, no un conjunto de tests del juego.
- Un commit por función terminada; comentarios del código en español.
- Umbral de fidelidad propuesto: error medio < 1/255 y ningún píxel por encima de 8/255 salvo bordes.
- Todo el código nuevo de Backrooms vive en `client/src/dev/` y solo se activa con `DEV_LOCAL`; no cambia el comportamiento del juego normal.
- Capturas a 1280x720, `deviceScaleFactor` 1, mismo Chromium y GPU en las dos pasadas.

## Review Focus
- Fuentes de no determinismo que sobreviven al congelado: `Date.now`, `performance.now`, `Math.random` en código que corre antes de instalar el modo captura, `crypto.getRandomValues`, compilación asíncrona de shaders. Dos capturas de la misma escena con three deben ser idénticas.
- La resolución dinámica del juego (`drsAcc`) y el límite de FPS cambian el tamaño de render según la carga: en captura deben estar desactivados.
- Una escena que no termina de cargar produce una captura a medias: la herramienta debe esperar a `__capture.ready` y fallar con mensaje claro si no llega.
- El ruido de GTAO y el antialiasing hacen que dos pasadas no sean bit a bit iguales: el informe separa «borde» de «interior» para no confundirlo con un fallo.
- Diferencias de tamaño o formato entre dos capturas deben dar error, no un informe engañoso.

## Estructura de archivos
- Crear `client/src/dev/capture.ts` (rama Backrooms): modo captura.
- Modificar `client/src/main.tsx`: instalar el modo captura antes de arrancar el juego.
- Crear `client/src/dev/scenes.json`: escenas de referencia.
- Crear `E:\phoenix\tools\fidelity\capture.mjs`: abre escenas y guarda capturas y cifras.
- Crear `E:\phoenix\tools\fidelity\compare.mjs`: compara dos carpetas de capturas.
- Crear `E:\phoenix\tools\fidelity\package.json`: dependencias de las herramientas.
- Crear `E:\phoenix\docs\FIDELIDAD.md`: cómo usar la herramienta y qué significan las cifras.

---

### Tarea 1: Rama y línea base del repositorio

**Files:** ninguno (solo git).

**Interfaces:** Produces: rama `phoenyx-migracion` en `E:\backrooms` desde `master`.

- [ ] **Paso 1:** comprobar que `master` está limpio salvo `.claude/launch.json`: `git -C E:\backrooms status --short`. Esperado: solo esa línea.
- [ ] **Paso 2:** crear la rama: `git -C E:\backrooms switch -c phoenyx-migracion`. Esperado: `Switched to a new branch`.
- [ ] **Paso 3:** comprobar que el juego arranca en dev (puerto 5190, `client-dev-5190` de `.claude/launch.json`) y que `npm run typecheck` en `client` pasa. Anotar en el mensaje final cualquier fallo previo para no atribuírselo a la migración.

### Tarea 2: Modo captura determinista en el juego

**Files:**
- Create: `client/src/dev/capture.ts`
- Modify: `client/src/main.tsx` (importar e instalar antes de montar la app)

**Interfaces:**
- Produces: `export function installCapture(): void` (no hace nada si `DEV_LOCAL` es falso o falta `?capture`); `window.__capture: { ready: boolean; setPose(x: number, y: number, z: number, yaw: number, pitch: number): void; advance(frames: number): Promise<void>; info(): { drawCalls: number; triangles: number; geometries: number; textures: number } }`.

- [ ] **Paso 1:** implementar `installCapture` en `capture.ts`. Con `?capture` presente: sustituir `Math.random` por un generador sembrado con `Number(?seed)` (mulberry32); sustituir `performance.now` y `Date.now` por un reloj que solo avanza 1/60 s por fotograma; sustituir `requestAnimationFrame` por un planificador que avanza solo cuando `advance(n)` lo pide. Desactivar la resolución dinámica y el límite de FPS (leer cómo lo hace `settings.ts` y forzar los valores desde `capture.ts`).
- [ ] **Paso 2:** implementar `setPose` localizando el jugador y la cámara del juego (`game.ts`, objeto `player`/`camera`); implementar `info` leyendo `renderer.info.render` y `renderer.info.memory`; poner `ready = true` cuando el nivel termine de cargar.
- [ ] **Paso 3:** instalar en `main.tsx` justo antes de montar React, importando `installCapture` desde `./dev/capture`.
- [ ] **Paso 4:** verificar: abrir `http://localhost:5190/?capture&seed=1`, llamar `await __capture.advance(120)` dos veces recargando entre medias y comparar visualmente que el primer fotograma coincide. Esperado: misma imagen. Ejecutar `npm run typecheck`. Esperado: sin errores.
- [ ] **Paso 5:** commit en la rama `phoenyx-migracion`: «Modo captura determinista (solo desarrollo)».

### Tarea 3: Escenas de referencia

**Files:**
- Create: `client/src/dev/scenes.json`

**Interfaces:**
- Produces: lista de objetos `{ id: string; query: string; pose: [x, y, z, yaw, pitch]; advance: number }`, consumida por `capture.mjs`.

- [ ] **Paso 1:** elegir y escribir al menos una escena por tipo de contenido que luego migrará una fase: pasillo de nivel con luces fluorescentes; interior con sombras de linterna; Poolrooms (agua, reflejo, GTAO y bloom activos); parking; una entidad animada a la vista; partículas y niebla. Cada una con `query` (por ejemplo `capture&seed=1&god`), `pose` fija y `advance` en fotogramas (por defecto 120).
- [ ] **Paso 2:** verificar cada escena a mano con `setPose` y `advance` y ajustar la pose hasta que el contenido buscado quede a la vista. Anotar en `scenes.json` un campo `nota` con qué debe verse.
- [ ] **Paso 3:** commit: «Escenas de referencia para fidelidad».

### Tarea 4: Captura automática y cifras de rendimiento

**Files:**
- Create: `E:\phoenix\tools\fidelity\package.json` (dependencias: `playwright`, `pngjs`, `pixelmatch`)
- Create: `E:\phoenix\tools\fidelity\capture.mjs`

**Interfaces:**
- Consumes: `scenes.json`, `window.__capture`.
- Produces: `node capture.mjs --url <base> --out <carpeta> [--throttle <n>]` deja `<carpeta>/<id>.png` (1280x720) y `<carpeta>/perf.json` con, por escena, `{ drawCalls, triangles, geometries, textures, frameMsMedian, frameMsP95, cpuMsMedian }`.

- [ ] **Paso 1:** escribir `capture.mjs`: lanzar Chromium con aceleración por GPU (`--use-angle=default`, `--enable-gpu`), ventana 1280x720, `deviceScaleFactor` 1; por cada escena abrir `base + '/?' + query`, esperar `__capture.ready` (máximo 60 s; si no llega, salir con error que nombre la escena), llamar `setPose`, `advance(advance)`, guardar captura del canvas.
- [ ] **Paso 2:** medir rendimiento: tras la captura, con el reloj real restaurado (o con el modo captura pausado), tomar 300 fotogramas y registrar la mediana y el percentil 95 del tiempo de fotograma y de CPU por fotograma; con `--throttle` aplicar `Emulation.setCPUThrottlingRate` vía CDP.
- [ ] **Paso 3:** verificar: ejecutar contra el juego en dev dos veces y comparar los PNG byte a byte. Esperado: idénticos (si no, buscar la fuente de no determinismo y corregir `capture.ts`).
- [ ] **Paso 4:** commit en `E:\phoenix`: «Herramienta de captura de fidelidad».

### Tarea 5: Comparación de capturas

**Files:**
- Create: `E:\phoenix\tools\fidelity\compare.mjs`

**Interfaces:**
- Consumes: dos carpetas de capturas de `capture.mjs`.
- Produces: `node compare.mjs --a <carpetaA> --b <carpetaB> --out <carpeta>` escribe `<out>/<id>-diff.png` (mapa de diferencias amplificado) y `<out>/report.json` con, por escena, `{ mean, p99, max, pixelsOver8, pixelsOver8Interior }` (error por canal en 0 a 255; «interior» excluye píxeles a 2 px o menos de un borde detectado) y `ok: boolean` según el umbral de las restricciones globales.

- [ ] **Paso 1:** implementar la carga, la comprobación de tamaño y formato (error explícito si difieren) y el cálculo de las métricas.
- [ ] **Paso 2:** implementar el mapa de diferencias y el informe; imprimir una tabla por escena con `ok` o `FALLA`.
- [ ] **Paso 3:** verificar: comparar una carpeta consigo misma (esperado: error 0, `ok` en todas) y con una copia donde se alteró un píxel a mano (esperado: `FALLA` solo en esa escena y `pixelsOver8` igual a 1).
- [ ] **Paso 4:** commit: «Comparador de fidelidad».

### Tarea 6: Línea base y punto de control 0

**Files:**
- Create: `E:\phoenix\docs\FIDELIDAD.md`
- Create: `E:\phoenix\fidelity\baseline\` (capturas y `perf.json` de three; no se versionan los PNG, solo `perf.json`)

- [ ] **Paso 1:** ejecutar `capture.mjs` sobre el juego en dev a calidad baja, media y alta (`settings.ts`) y con `--throttle 1` y `--throttle 4`; guardar `perf.json` de cada combinación como línea base.
- [ ] **Paso 2:** escribir `FIDELIDAD.md`: cómo ejecutar las dos herramientas, qué significa cada cifra, el umbral y cómo repetir la medición en otro equipo (para el dueño: el mismo comando en un equipo más potente y en uno más modesto).
- [ ] **Paso 3:** commit en `E:\phoenix` (línea base y documento) y push.
- [ ] **Paso 4 (punto de control 0):** mostrar al dueño las capturas de las escenas, las cifras de línea base y la confirmación de que dos pasadas con three dan imágenes idénticas. Esperar su visto bueno antes del plan de la fase 1.

## Planes siguientes (no incluidos aquí)
Fase 1 (núcleo) usa la línea base y el comparador de esta fase para fijar objetivos concretos; sus tareas se escriben después del punto de control 0, con los datos medidos.
