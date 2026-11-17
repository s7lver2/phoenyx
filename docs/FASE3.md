# Fase 3: sombras PCFSoft y luces restantes (estado)

## Qué hay
- **Luces nuevas** (registro de 16 floats por luz; tipo en el primer float): 2 `HemisphereLight` (irradiancia con la normal tras los mapas, como `lights_fragment_begin`), 3 `SpotLight` (`smoothstep(coneCos, penumbraCos, angleCos)` × atenuación de distancia), 4 `RectAreaLight` (LTC portado de `lights_physical_pars_fragment`; las tablas salen de `RectAreaLightUniformsLib.init()` y se leen con bilinear a mano porque `Rgba32Float` no es filtrable).
- **Sombras** (`renderer.shadowMap.{enabled, type, autoUpdate, needsUpdate}` con la semántica de `WebGLShadowMap.render`): un foco y/o un direccional con `castShadow`, hasta 4 a la vez. Pasada de profundidad por luz en un `texture_depth_2d_array` (una capa por luz, `Depth32Float`), con `shadowSide` (FrontSide proyecta con las caras traseras y al revés), instancias, `alphaTest` con `map`, culling con el frustum de la cámara de sombra y los mismos `updateMatrices` de three.
- **Muestreo** portado de `shadowmap_pars_fragment`: PCFSoft (el del juego), PCF y Basic; coordenada de sombra por vértice con `normalBias` (como `shadowmap_vertex`), `bias` en el muestreo, `receiveShadow` por malla (bit 8 de las flags del dibujo).

## Formatos
- Luz: `a` tipo + color·intensidad (hemisferio: cielo); `b` posición vista (hemisferio: suelo; área: centro); `c` decaimiento + dirección hacia la luz; `d` foco: cos(ángulo), cos(ángulo·(1-penumbra)); foco y direccional: `d.z` = capa de sombra + 1 (0 sin sombra); área: medio ancho en `c.yzw` y medio alto en `d.xyz`.
- Sombra (48 floats): matriz de consulta (`LightShadow.matrix`), matriz de la cámara de sombra, bias, normalBias, radius, ancho y alto del mapa.
- Los dibujos de sombras van tras los de la escena en el mismo array (palabra 10 = capa); `frame(..., shadows, shadow_passes, main_draws)`; cada pasada = `[capa, primer dibujo, n dibujos, ancho, alto]`.
- La pasada de sombras usa un bind group con un mapa vacío (no puede leer el que escribe).

## Fidelidad (punto de control 3, 17 escenas, 1280x720)
Aprobadas todas (media < 1 y ningún píxel de interior > 8):

| Escena | media | máx | >8 interior |
|---|---|---|---|
| luces (Hemisphere + Spot) | 0 | 1 | 0 |
| rect (3 RectAreaLight) | 0 | 1 | 0 |
| sombra-spot (linterna, PCFSoft) | 0,0087 | 151 (borde) | 0 |
| sombra-sol (direccional, PCFSoft) | 0,0099 | 175 (borde) | 0 |
| sombra-casos (BackSide, alphaTest, transparente, instancias, receiveShadow falso, mapa congelado) | 0 | 5 | 0 |
| interior (linterna con sombra sobre GLB del juego) | 0,0032 | 19 | 0 |
| piscina-sol (sol sobre GLB e instancias) | 0,0042 | 26 | 0 |
| las 10 de las fases 1 y 2 | sin cambios | | 0 |

## Rendimiento (mediana de fotograma, ms; `fidelity/baseline/fase3-*/perf.json`)
| Escena | three 1x | Phoenyx 1x | three 4x | Phoenyx 4x |
|---|---|---|---|---|
| sombra-spot | 0,5 | 0,4 | 1,8 | 2,2 |
| interior | 0,6 | 0,6 | 2,3 | 2,5 |
| piscina-sol | 0,6 | 0,5 | 2,7 | 2,6 |

Con sombras, Phoenyx queda a la par de three (el empaquetado en JS por fotograma domina; fase 8). Las llamadas y triángulos que cuenta Phoenyx no incluyen la pasada de sombras.

## Límites conocidos
- Sombras de `PointLight` (cubo), de `RectAreaLight` y `VSMShadowMap` (se trata como PCFSoft); `SkinnedMesh` no proyecta sombra hasta la fase 5; más de 4 luces con sombra (aviso).
- `MeshPhysicalMaterial` con `transmission` (la botella del GLB de cerveza, que tiene `KHR_materials_transmission`) se dibuja como Standard y queda ~10 % más clara que three bajo un foco; las escenas `interior` y `piscina-sol` no la incluyen. Se resuelve en las fases 4 y 6.
- Un mapa reasignado por crecer (más capas o lado mayor) se repinta ese fotograma aunque `autoUpdate` de la luz sea falso.
- Todos los mapas comparten el lado máximo pedido; cada luz usa su `mapSize` como viewport.

## Revisión final (Sonnet) y correcciones
Corregido: mapa recién reservado y vacío con `autoUpdate = false` (se pinta siempre al reservarse), capas de sombra estables por luz (una luz que desaparece ya no desplaza a las demás), fotograma que no llega a dibujarse (`frame()` devuelve `bool` y los mapas se repintan el siguiente), `shadowMap.needsUpdate` ya no se consume sin luces con sombra, aviso al pasar de 65536 dibujos entre escena y sombras.
Aplazado: una luz fuera de las 64 del buffer sigue ocupando capa; con `intensity = 0` el mapa se sigue pintando (three hace lo mismo).
