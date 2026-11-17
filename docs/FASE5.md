# Fase 5: animación y personajes (estado)

## Qué hay
- **`SkinnedMesh`, `Skeleton`, `Bone`, `AnimationMixer/Clip/Action`, `SkeletonUtils.clone`** son el JS de three (copiado): las poses salen idénticas. Phoenyx solo aporta la GPU.
- **Skinning en la GPU** (`shader.wgsl`: `skin_pos`, `skin_normal`, portados de `skinning_vertex`/`skinnormal_vertex` con `bindMatrix`/`bindMatrixInverse`), en `vs` y en `vs_shadow` (las sombras y el `overrideMaterial = MeshNormalMaterial` de GTAO llevan piel).
- **Vértice de 68 bytes** para todas las geometrías: `skinIndex` (4 × u16) y `skinWeight` (4 × f32), a cero sin piel (un solo pipeline).
- **Huesos en la reserva de matrices de instancias** (`inst_mats`): por cada `SkinnedMesh`, un tramo `[bindMatrix, bindMatrixInverse, hueso 0, hueso 1…]` (se sube `skeleton.update()` una vez por `render()`). El dibujo lo señala con la palabra 11 (offset + 1; 0 = sin piel). No hay buffer ni binding nuevos (la etapa de vértices ya usaba 7 de los 8 buffers de almacenamiento permitidos).
- **Reserva con huecos reutilizables**: `drop_instances` recoge los huecos del final y guarda el resto en una lista libre que `set_instances` reutiliza con la misma capacidad. Los tramos de huesos de mallas que llevan 512 `render()` sin dibujarse (quitadas, ocultas, destruidas) se liberan (barrido cada 256).
- Culling y orden por profundidad usan la `boundingSphere` de la `SkinnedMesh` (el `Frustum` es el de three); `frustumCulled = false` se respeta.

## Fidelidad (1280x720; media en /255, píxeles de interior > 8)
| Escena | media | máx | >8 interior |
|---|---|---|---|
| skin (2 cilindros de 3 huesos, distinta pose, mismo material y geometría) | 0,0001 | 1 | 0 |
| skin-sombra (sol con sombra, dos mallas fuera de cuadro con y sin `frustumCulled`) | 0,0001 | 4 | 0 |
| skin-normales (`overrideMaterial = MeshNormalMaterial`) | 0 | 0 | 0 |
| entidades (hazmat, partygoer y skinwalker, 2 clones cada uno, fundidos cruzados con `timeScale` 1, 0,5, 0 y −1) | 0,0171 | 160 (bordes) | 0 |
| entidades-pool (Poolrooms + sol con sombra + niebla + GTAO, bloom, salida y SMAA) | 0,0293 | 85 (bordes) | 0 |

Las 34 escenas anteriores no cambian (`ao`, `ao-mezcla` y `pool-fx` siguen con el único píxel de interior de la fase 4).

## Rendimiento (mediana de fotograma, ms; `fidelity/baseline/fase5-*/perf.json`)
| Escena | three 1x | Phoenyx 1x | three 4x | Phoenyx 4x |
|---|---|---|---|---|
| skin-sombra | 0,8 | 0,6 | 5,1 | 5,2 |
| entidades | 0,8 | 0,9 | 5,6 | 6,0 |
| entidades-pool | 1,8 | 1,8 | 15,6 | 14,7 |

`entidades` a 4x queda ~7 % por encima de three (subida de huesos por malla sin detección de cambios y vértice más ancho): se revisa en la fase 8.

## Límites conocidos
- Morph targets (el juego no los usa) y `SkeletonHelper` no están; `ShaderMaterial` con piel tampoco. Una `SkinnedMesh` sin `skinIndex`/`skinWeight` o sin esqueleto avisa y se dibuja como `Mesh`.
- Los huesos se suben cada `render()` sin comparar con el fotograma anterior (three hace igual con su textura de huesos); optimizable en la fase 8.
- Más de 65535 huesos por esqueleto o índices de hueso > 65535 no caben en `skinIndex` (u16): nunca ocurre con GLB reales (≤ 65).
