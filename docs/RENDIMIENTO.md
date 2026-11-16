# Rendimiento

Medido en el navegador de la app de escritorio (Chrome/WebGPU, vsync a 60 Hz). Tiempos de GPU por etapa con timestamps; `H` en la demo de exteriores muestra el HUD con `frame`, `culling`, `render`, `sombras` y `hiz+post`; la de interiores lo muestra siempre.

## Exteriores: 2.000.000 estatuas de 2.000.006 triángulos (1080p)

| Plano | Culling | Render | Sombras | Hi-Z + post |
|---|---|---|---|---|
| Estatua héroe | 0,13 | 0,72 | 0,13 | 1,1 |
| Pasillo | 0,2 | 1,1–1,4 | 0,66 | 0,3–0,5 |
| Vista aérea | 0,7 | 2,4 | 0,2 | 0,1 |

Triángulos a resolución completa: ~1.100 G. Dibujados: 7–10 M en el pasillo y la vista aérea. (Tiempos en ms.)

## Interior (`web/suites.html`): laberinto de 200×200 celdas, 124.890 instancias

Visibles 42–130 instancias por frame; GPU ~1 ms en total (culling 0,07 / render 0,3–0,5 / sombras 0,13 / post 0,2). Frame limitado por vsync. Los focos con sombra se probaron activos (el tiempo de sombras es > 0); la comparación visual con y sin sombra de focos no se llegó a hacer en la misma pose.

## Mejoras medidas

| Cambio | Antes | Después |
|---|---|---|
| LOD de 6 a 10 niveles | ~893 M tris dibujados | ~17 M |
| Culling por chunks de 64 | culling 1,7 ms | 0,8 ms |
| Hi-Z (pasillo) | 602.000 visibles, render 3,9 ms | 34.500 visibles, render 1,0 ms |
| AO a media resolución (primer plano) | post 1,5 ms | 1,1 ms |
| Tolerancia de LOD creciente (aérea) | 17 M tris, render 3,9 ms | 10 M, 2,4 ms |

CPU: el envío de un frame cuesta ~0,3–0,4 ms (un encoder, draws indirectos grabados una vez en un render bundle).

## Notas de medida

- El navegador de la app limita a 60 Hz: el tiempo de frame refleja el vsync; usa los tiempos de GPU.
- Los valores de `stats()` se actualizan cada 45 frames.
- No hay comparación directa con el renderer three.js de Backrooms.
