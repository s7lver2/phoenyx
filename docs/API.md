# API

## Desde JS (`web/phoenix.js`)

```js
import { supported, loadPackage, createEngine, light, watch } from "./phoenix.js";

if (!(await supported())) { /* sin WebGPU con indirect-first-instance */ }
const pkg = await loadPackage("assets-ms");                  // paquete de phoenix-bake
const p = await createEngine(canvas, pkg, {
  capacity: 200000,                                           // máximo de instancias
  instances: new Float32Array(/* 8 floats por instancia */),
  environment: true,                                          // cielo, suelo y sombras del sol
});
const guard = watch(p, (msg, perdido) => { /* mostrar aviso */ });

function loop() {
  p.frame(x, y, z, yaw, pitch);   // render de un frame
  guard();                        // barato; revisa errores y pérdida de GPU
  requestAnimationFrame(loop);
}
```

Convenciones: `yaw = 0` mira hacia `-z`; `pitch` en radianes; las unidades son metros.

## Objeto del motor (`Phoenix`)

| Método | Para qué |
|---|---|
| `frame(ex, ey, ez, yaw, pitch)` | Renderiza un frame. |
| `resize(w, h)` | Tras cambiar el tamaño del canvas (recrea los buffers de pantalla y el Hi-Z). |
| `set_instances(first, data)` | Escribe instancias desde la posición `first` (8 floats cada una); amplía el contador. |
| `set_count(n)` / `count()` | Instancias activas (0..capacidad). |
| `set_tolerance(px)` | Tolerancia de error del LOD en píxeles (1 por defecto). |
| `set_far_tolerance(k)` | Aumento de la tolerancia con la distancia (0,6 por defecto; a 500 m o más, `tau * (1 + k)`). |
| `set_min_pixels(px)` | Diámetro mínimo para dibujar una instancia (1 por defecto). |
| `set_occlusion(on)` | Culling por oclusión Hi-Z. |
| `set_environment(on)` | Dibuja o no el cielo y el suelo (apágalo en interiores). |
| `stats()` | `[visibles, tris dibujados, tris a resolución completa, draws no vacíos, ms culling, ms render, ms sombras, ms hiz+post]`; se actualiza cada 45 frames. |
| `is_lost()` / `take_error()` | Pérdida del dispositivo y último error de GPU. Si se perdió, hay que recrear el motor. |

Iluminación y post-proceso:

| Método | Para qué |
|---|---|
| `set_lights(data)` | Luces (16 floats por luz, máximo 512). |
| `set_sun(r, g, b, ambient)` / `set_sun_dir(az, el)` | Radiancia del sol, escala del ambiente y dirección (radianes). |
| `set_moon(az, el, r, g, b)` | Luna direccional sin sombras (0 la apaga). |
| `set_flat_ambient(r, g, b, scale)` | Ambiente plano para interiores (`scale = 0` vuelve al ambiente por hora). |
| `set_shadows(on)` | Sombras del sol (2 cascadas). Las de los focos van con las luces. |
| `set_exposure(e)` | Exposición del mapeo de tonos. |
| `set_post(bloom, ao, radio)` | Intensidad del bloom, fuerza del AO (0..1) y radio del AO en metros. |

## Ayudantes de luces

```js
light.point(x, y, z, radio, r, g, b, intensidad)
light.spot(x, y, z, radio, r, g, b, intensidad, dx, dy, dz, conoGrados)
light.tube(x, y, z, radio, r, g, b, intensidad, dx, dy, dz, largo)   // centrado en xyz, eje dx,dy,dz
```

Para que un foco proyecte sombra, pon `luz[14] = 1` en el array que devuelve `light.spot`. Los 4 focos con sombra más cercanos a la cámara la usan; el resto iluminan sin sombra.

## Reglas de uso

- `set_lights` reinicia la asignación de sombras de focos. En escenas grandes, selecciona en el anfitrión las luces cercanas a la cámara y vuelve a llamarla solo cuando la cámara se mueva (la demo de interiores lo hace cada 1,2 m).
- Si el anfitrión cambia instancias cada frame, usa `set_instances` solo con el rango modificado; se recalculan los chunks de culling.
- La escena (colocación, rotación, escala) la genera el anfitrión; Phoenix no guarda jerarquías ni transformaciones.
- Ejemplos completos: `web/index.html` (exteriores) y `web/suites.html` (interior).

## Partículas

`engine.emit_particles(p, count)` con `p` = 17 floats `[x, y, z, vx, vy, vz, dispersión, variación de velocidad, vida, tamaño inicial, tamaño final, gravedad, r, g, b, a, aditivo]`. Buffer circular de 65.536; posición y fundido se calculan en el vertex shader por edad, sin CPU ni compute. Se dibujan tras la escena, con test de profundidad y sin escribirla.
