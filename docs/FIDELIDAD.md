# Fidelidad y rendimiento: cómo medir Phoenyx frente a three

Herramientas en `tools/fidelity/` (Node 22, Chrome instalado). Instalación: `npm install` dentro de esa carpeta.

## Requisitos en Backrooms
Rama `phoenyx-migracion`. El juego en desarrollo (`npm run dev` en `client`, puerto 5190) tiene un modo `?capture` que congela la semilla y el reloj (`client/src/dev/capture.ts`) y una lista de escenas (`client/src/dev/scenes.json`). Solo funciona en desarrollo local. Parte de los ajustes de fábrica más el preajuste elegido, sin tocar los guardados del navegador; congela también `new Date()`, desactiva la resolución dinámica y la captura pulsa PLAY sola cuando hace falta.

## Capturar
```
node capture.mjs --url http://localhost:5190 --out ../../fidelity/out/three --preset high --throttle 1
```
- `--preset`: `potato`, `low`, `medium` o `high` (los preajustes de GRAPHICS del juego).
- `--throttle N`: frena la CPU N veces (equipo modesto simulado).
- `--only a,b`: solo esas escenas.
- Resultado: `<out>/<escena>.png` (solo el canvas, 1280x720) y `<out>/perf.json`.

`perf.json`, por escena: llamadas de dibujo, triángulos, geometrías y texturas del renderer; mediana y p95 del tiempo de fotograma en tiempo real (300 fotogramas); CPU de envío por fotograma (`cpuMsRender`) y resolución dinámica (`resScale`); GPU usada.

## Comparar
```
node compare.mjs --a ../../fidelity/out/three --b ../../fidelity/out/phoenyx --out ../../fidelity/out/diff
```
Por escena: `<out>/<escena>-diff.png` (gris = error por 8; rojo = píxel de interior por encima del umbral; naranja = píxel de borde por encima) y `report.json`.

| Cifra | Significado |
|---|---|
| `media` | error medio por canal (0 a 255) |
| `p99` | el 99 % de los píxeles tiene un error menor o igual |
| `max` | error máximo de un píxel |
| `>8` | píxeles con error mayor que 8 |
| `>8 int.` | los mismos, sin contar los que están a 2 px o menos de un contorno |

Opciones extra de `compare.mjs`: `--mean` y `--pixel` (umbrales). Los bordes se calculan solo sobre la imagen A. Opciones extra de `capture.mjs`: `--scenes` (otro scenes.json) y `--chrome` (ruta del navegador). `capture.mjs` borra la captura anterior de cada escena antes de repetirla.

Umbral de aprobado: `media` < 1 y `>8 int.` = 0. Los contornos se miden aparte porque el antialiasing de WebGL y el de WebGPU no coinciden bit a bit.

## Suelo de ruido
Dos pasadas con three de la misma escena (nivel 0 y Poolrooms comprobadas tras fijar semilla, reloj, `Date` y el punto de arranque) dan error 0: son idénticas bit a bit en el mismo equipo. Antes de esos arreglos el máximo era 2/255. Otro equipo o GPU puede dar pequeñas diferencias propias del hardware.

## Limitaciones conocidas
- Parking no está en las escenas: solo se llega por sala multijugador (necesita servidor).
- Las Poolrooms no admiten `setPose` (llevan su propia cámara): encuadre fijo.
- El modo captura usa un reloj virtual de 1/60 s por fotograma; las animaciones basadas en tiempo real (audio, red) no se reproducen igual.

## Repetir en otro equipo
Mismo comando en un equipo más potente y en uno más modesto: `sh baseline.sh <url>` genera la línea base completa (calidades `high`, `medium` y `low`, con CPU normal y frenada 4x) en `fidelity/baseline/`. El objetivo de rendimiento de la fase 8 se fija con esas cifras.
