# Limitaciones y trabajo pendiente

## Lo que no hace el motor
- **No es Nanite de verdad:** el LOD es discreto por instancia, sin jerarquía de clusters, sin visibility buffer ni rasterizado de microtriángulos.
- **Personajes con huesos:** sí (skinning en GPU con animación horneada, ver docs/ASSETS.md), con límites: 4 huesos por vértice, hasta 255 huesos, una malla y una textura base por personaje, sin mezcla entre clips, con sombras proyectadas por los personajes (sin comprobar visualmente en detalle), sin culling (hasta 2.048 instancias por modelo) y sin retargeting ni IK.
- **Partículas:** hay (GPU, sin estado, billboards con mezcla alfa o aditiva, hasta 65.536, `emit_particles`); sin sorting ni sombras, y sin texturas de sprite (disco suave). **Sin transparencias en mallas ni UI.**
- **Solo WebGPU** con `indirect-first-instance`. Sin WebGPU, el anfitrión tiene que usar otro renderer.
- Rotación de instancias solo en Y; sin jerarquías de transformaciones.
- Las UV no pueden salir de `[0, 1]`; un solo material por modelo.

## Iluminación
- Las luces puntuales y los tubos no proyectan sombra; solo hasta 4 focos a la vez.
- Sin iluminación global, reflejos de entorno ni oclusión ambiental correcta (el AO se multiplica sobre la imagen final).
- Sombras del sol solo en 2 cascadas cercanas a la cámara.
- El Hi-Z va con un frame de retraso: con cámaras muy rápidas puede ocultar una instancia un frame.

## Assets
- Texturas sin comprimir y sin streaming.
- La demo de exteriores usa escaneos de Megascans que no se pueden redistribuir.

## Rendimiento (ideas evidentes, sin hacer)
- (Hecho) `count` guarda el resultado de `pick` en un buffer de trabajo y `scatter` lo lee; pide hasta 10 buffers de almacenamiento por etapa de shader (el límite por defecto es 8).
- Una jerarquía espacial de chunks (en lugar de bloques contiguos de 64) mejoraría el descarte cuando las instancias no están ordenadas por posición.
- Escalado dinámico de resolución (el post-proceso ya permite renderizar a menos resolución y componer).
- Exposición automática (ya hay HDR).

## Integración con el juego (Backrooms / Las Suites)
- No está integrado. Las Suites está en fase de diseño (`docs/suites.md` en Backrooms) y el juego usa three.js con personajes esqueléticos y UI.
- `web/suites.html` demuestra el caso de interior (laberinto, paredes con el papel pintado del juego, focos con sombra, culling Hi-Z) con piezas procedurales.
- Antes de integrar hay que decidir cómo conviven personajes y mundo (híbrido o skinning propio) y medir contra el renderer actual.

## Verificación
- Sin tests automáticos (regla del proyecto). Todo se ha comprobado a mano en el navegador de la app.
- La demo de exteriores no se volvió a ejecutar tras los últimos cambios de iluminación de focos (sombras de focos, tangentes y NaN); la de interiores sí.

## Avisos de validación sin resolver
- En Chrome aparece a menudo `Both beginningOfPassWriteIndex and endOfPassWriteIndex are undefined` seguido de `Invalid CommandBuffer`. Ya estaba antes del skinning (se comprobó con el commit 9fb8f6b) y el render sigue saliendo, pero no se ha localizado qué pasada lo causa.
