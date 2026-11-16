# Assets: `phoenix-bake`

CLI nativa (`crates/phoenix-bake`) que genera un paquete de modelos para el motor.

```
cargo build --release -p phoenix-bake
./target/release/phoenix-bake --kind glb --glb a.glb,b.glb --tex 2048 --ground <dir-superficie> --out web/assets-x
```

| Opción | Significado |
|---|---|
| `--kind glb\|rock\|statue\|demo` | `glb` importa modelos reales; el resto son procedurales de prueba. |
| `--glb a.glb,b.glb` | GLB a importar (primera malla, primera primitiva, con su transformación de nodo). |
| `--tex N` | Tamaño de las texturas del paquete (todas las capas comparten tamaño; 2048 por defecto). |
| `--ground <dir>` / `--gsize N` | Superficie tileable del suelo (base y normal) y su tamaño. |
| `--out <dir>` | Carpeta de salida. |
| `--sub`, `--models` | Subdivisión y número de modelos de los generadores procedurales. |

## Qué hace con cada modelo

- Aplica la transformación del nodo, centra en la caja y escala a esfera unidad (la escala de la instancia es el radio original).
- Genera 10 niveles de LOD (cada uno con ~4× menos triángulos) con `meshopt`: simplificación con error absoluto y «sloppy» para los niveles finales; guarda el error de cada nivel.
- Cuantiza los vértices (ver [ARQUITECTURA.md](ARQUITECTURA.md)); si falta la tangente, usa `(1, 0, 0)` y el shader la ortogonaliza.
- Texturas: base, normal y ORM (oclusión, rugosidad, metal) por modelo, remuestreadas a `--tex` con su cadena de mips.

## Paquete de salida

`meta.json` (modelos, LOD, `draws` = `[index_count, first_index, base_vertex]` por (modelo, LOD), `info` = 16 floats por modelo, tamaño y mips de las texturas), `verts.bin`, `idx.bin`, `tex_base.bin`, `tex_normal.bin`, `tex_orm.bin` y, si hay suelo, `ground_base.bin`, `ground_normal.bin`.

Se carga con `loadPackage(dir)` de `web/phoenix.js`.

## Piezas modulares (interiores)

`tools/make_suites_glb.py <salida> <wallpaper.jpg>` genera cajas con UV y textura incrustada (pared, suelo, techo, puerta, lámpara) para hornearlas con `--kind glb`. Se usa en `web/suites.html`:

```
python tools/make_suites_glb.py assets-src/suites <ruta>/wallpaper_red.jpg
./target/release/phoenix-bake --kind glb --glb assets-src/suites/wall.glb,assets-src/suites/floor.glb,assets-src/suites/ceiling.glb,assets-src/suites/door.glb,assets-src/suites/lamp.glb --tex 1024 --out web/assets-suites
```

## Licencias

Los escaneos de Megascans no se pueden redistribuir: `assets-src/` y `web/assets-*/` están en `.gitignore`.

## Pendiente

- Las texturas van sin comprimir (RGBA8): la demo de exteriores pesa ~300 MB. Falta compresión BC/ASTC con fallback y carga en streaming.
- Una sola primitiva por GLB y una sola textura por modelo.
- Las UV no pueden salir de `[0, 1]`.
