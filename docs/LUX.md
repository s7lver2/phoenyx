# Lux

Librería de iluminación en GPU (`crates/lux`). No dibuja la escena: aporta el WGSL, los recursos y el cálculo de las vistas de sombra. Se puede usar con otro motor wgpu.

## Qué incluye

- PBR Cook-Torrance (GGX, Smith, Schlick) con materiales base / normal / ORM.
- Sol con sombras en 2 cascadas (25 m y 130 m, 2048 px): PCF con disco de Poisson rotado por píxel, mezcla entre cascadas, bias por pendiente, fundido al final.
- Luna direccional sin sombras.
- Ambiente según la hora (cielo, relleno cálido del horizonte, noche) o ambiente plano para interiores.
- Hasta 512 luces con culling por clusters 16×9×24 en compute: puntuales, focos con cono suave y tubos (punto representativo de Karis).
- Hasta 4 focos con sombra a la vez (mapas en perspectiva).
- Funciones de día/noche y color del horizonte (`day_k`, `horizon_col`), que el motor usa también para cielo y niebla, y `aces`.

## Integración en un motor wgpu

1. `let lux = Lux::new(&device);`
2. Antepón `lux::WGSL` a tu shader. Contrato: declara `g: Globals` con `cam`, `light` (xyz = dirección al sol), `inv_vp`, `grid` (ancho, alto, near y far del clustering) y `vw` (w = número de luces).
3. Crea el grupo de bind 3 con `Lux::layout_entries()` (bindings 3..=7) y `lux.bind_entries()`; los bindings 0..=2 son tuyos.
4. Cada frame:
   - `lux.update_shadow_spots(&queue, eye)` → vistas de focos con sombra.
   - `lux.fit_cascades(eye, forward)` → cascadas del sol (si `shadows_active()`).
   - Renderiza la escena (solo profundidad) con cada `view_proj` en `lux.layer(i)` (cascadas 0 y 1, focos `2 + slot`).
   - `lux.write_uniform(&queue, cascadas, &focos)`.
   - Si hay luces: dispatch de `cluster_cull` con `Lux::cluster_groups()` workgroups.
   - En tu fragment shader: `lit_surface(pos, normal, vista, albedo, rugosidad, metal, ao, frag.xy, profundidad_de_vista)` devuelve radiancia lineal HDR.

## Formato de luz (16 floats)

`[x, y, z, radio, r, g, b, intensidad, tipo, dx, dy, dz, cono_grados, largo_tubo, sombra, 0]`

- `tipo`: 0 puntual, 1 foco (`dx..dz` = dirección, `cono_grados` = semiángulo), 2 tubo (`dx..dz` = eje, `largo_tubo`, centrado en `xyz`).
- `sombra` (índice 14): 1 = el foco puede proyectar sombra (los 4 más cercanos a la cámara la usan).
- Atenuación: ventana suave `(1 - (d/r)^4)^2 / (d^2 + 0.5)`.

## Limitaciones

- Solo proyectan sombra las instancias dentro de cada vista; las puntuales y los tubos no tienen sombra.
- Los focos con sombra se eligen por cercanía a la cámara; al cambiar la selección puede haber un salto de sombra.
- No hay iluminación global ni reflejos de entorno (el ambiente es una aproximación analítica).
- Máximo 31 luces por cluster.
