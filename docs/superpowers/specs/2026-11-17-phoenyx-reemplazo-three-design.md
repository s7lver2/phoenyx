# Phoenyx como sustituto de three.js en Backrooms: diseño

## Intención
Backrooms debe rendir mejor en cualquier ordenador y aprovechar el hardware potente, **sin cambiar cómo se ve ni cómo se juega**. El dueño quiere seguir desarrollando el juego sin preocuparse del rendimiento, así que Phoenyx tiene que ser, para quien programa, lo mismo que three.js: mismas clases, mismos nombres, mismo modo de trabajar.

## Objetivos
- Sustituir three.js por Phoenyx en todo el cliente de Backrooms (61 archivos).
- Imagen fiel a la actual, medida con capturas comparadas (ver «Fidelidad»).
- Rendimiento claramente mejor: menos CPU por frame (sin recorrer grafo ni cambiar estado por objeto) y trabajo repartido en GPU (culling, LOD, instancias).
- Desarrollo cómodo: la API que usa el juego existe con el mismo nombre y comportamiento.

## No objetivos
- Mejorar el aspecto (nada de PBR propio de `lux`, ACES nuevo, AO nuevo): el aspecto es el de three.js.
- Cubrir la API completa de three: solo lo que usa el juego (medido).
- Cambiar la jugabilidad, la red, el audio o la UI.

## Antiobjetivos
- Un renderer que rinda más pero «se vea parecido». Si la fidelidad falla, no se avanza.
- Tocar Backrooms sin rama aparte ni punto de control.

## Restricciones (cómo trabajar)
- **Rama aparte en Backrooms** antes de tocar nada; `master` no se toca hasta que el dueño lo apruebe.
- **Puntos de control por fases**: al final de cada fase hay capturas lado a lado (three vs Phoenyx) y cifras de rendimiento para que el dueño decida si sigue.
- Reglas del proyecto: sin tests salvo petición (las comparaciones de imagen son una herramienta de verificación, no un conjunto de tests del juego), un commit por función terminada, comentarios en español.

## Alcance medido (uso actual de three en el juego)
- Escena: `Object3D`, `Group`, `Scene`, `Mesh`, `InstancedMesh`, `Points`, `Sprite`, `LineSegments`, `LOD`, `SkinnedMesh`, `Bone`, `Skeleton`.
- Materiales: `MeshBasic` (121 usos), `MeshStandard` (118), `MeshPhysical` (14), `Points`, `Sprite`, `LineBasic`, **`ShaderMaterial` (22 usos en 12 archivos)**.
- Geometrías: Box, Plane, Cylinder, Sphere, Capsule, Tube, Ring, Circle, Lathe, Extrude, Cone, Torus, Octahedron, Dodecahedron, Edges, Decal, `BufferGeometry` a mano y fusionadas.
- Luces: Point (30), Hemisphere, Directional, Spot, RectArea, Ambient; sombras PCFSoft.
- Cámaras: Perspective, Orthographic.
- Niebla: `Fog`, `FogExp2`. Tone mapping: ACESFilmic. Color: sRGB.
- Texturas: `CanvasTexture` (50), `DataTexture`, `TextureLoader`, `PMREMGenerator`, render targets.
- Animación: `AnimationMixer`, `AnimationClip`, `AnimationAction`, `SkeletonUtils.clone`.
- Carga: `GLTFLoader` con meshopt.
- Postproceso: `EffectComposer` con `RenderPass`, `GTAOPass`, `UnrealBloomPass`, `SMAAPass`, `OutputPass`, `ShaderPass`.
- Otros: `Raycaster`, `Reflector`, `OrbitControls` (solo herramientas de desarrollo), `Curve*`, matemáticas (`Vector2/3/4`, `Quaternion`, `Matrix4`, `Euler`, `Box3`, `Plane`, `Color`, `MathUtils`).

## Enfoques considerados
- **A. Reimplementar la API de three con renderer propio** (elegido por el dueño): clases con los mismos nombres; el renderer es 100 % Phoenyx. Máxima velocidad posible (el grafo puede escribir transformaciones directo a buffers de GPU) y control total. Coste: mucho trabajo y riesgo de diferencias visuales, que se controla con la comparación de imágenes.
- **B. Quedarse en three con su renderer WebGPU:** el más barato, pero no es Phoenyx y rinde menos.
- **C. Mantener las clases de three y sustituir solo el renderer:** diferencia de rendimiento con A pequeña a la escala de Backrooms (estimada, no medida), más barato y menos riesgo. Descartado por el dueño a favor de A; si A se atasca, C es la salida natural.

## Decisiones de diseño (mías, a revisar)
1. **Código que no toca el renderer se copia de three** (MIT, con su aviso de licencia): matemáticas, curvas, geometrías procedurales, `GLTFLoader`, `AnimationMixer`, `SkeletonUtils`, utilidades de buffer. Es lo que hace la API idéntica sin rehacerla y evita errores. Lo nuevo de verdad es: grafo → GPU, materiales → WGSL, luces y sombras, postproceso, `Raycaster` sobre la escena propia.
2. **Los materiales reproducen el sombreado de three** (misma BRDF, mismo orden de operaciones, mismo tone mapping y espacio de color), no el de `lux`. `lux` se queda como componente aparte para juegos nuevos.
3. **Los 22 `ShaderMaterial` se portan a mano a WGSL** (12 archivos: cosmetics, game, lightmap, parking-atmosphere, parking-puddles, parking, pool, poolmap, remote, vents, waterjet, world). No hay traducción automática fiable de GLSL de three.
4. **Escena retenida y sucia por cambios:** los objetos estáticos se suben una vez; solo se actualizan los que cambian (`matrixWorldNeedsUpdate`). Lotes automáticos de mallas iguales a instancias y culling en GPU; el motor GPU-driven actual (`phoenix`) es la vía para lo masivo.
5. **Rendimiento escalable:** calidad ajustable (resolución de render, sombras, AO) para equipos modestos; en equipos potentes, los mismos efectos a mayor resolución y más instancias, nunca un aspecto distinto.

## Fidelidad (cómo se mide)
Cada fase termina en un **punto de control**: se renderizan las mismas escenas (cámara, hora, semilla fijas) con three y con Phoenyx y se comparan píxel a píxel. Se muestra al dueño: las dos imágenes, el mapa de diferencias y el máximo y media del error. Umbral propuesto: error medio < 1/255 y ningún píxel por encima de 8/255 salvo bordes de antialiasing; el dueño puede endurecerlo. WebGL y WebGPU no son bit a bit iguales, de modo que se valida con tolerancia, no con igualdad exacta.

## Fases y puntos de control (orden propuesto)
0. **Rama y banco de pruebas:** rama en Backrooms, herramienta de captura y comparación, escenas de referencia. Punto de control: la herramienta funciona sobre three.
1. **Núcleo:** grafo de escena, cámaras, matemáticas, materiales Basic y Standard, luces puntuales y direccionales, niebla, tone mapping. Punto de control: una sala sencilla idéntica.
2. **Geometrías, texturas y carga:** todas las geometrías usadas, `CanvasTexture`, `GLTFLoader`, instancias. Punto de control: una escena con modelos del juego.
3. **Sombras y luces restantes:** PCFSoft, focos, hemisferio, RectArea. Punto de control: interior con sombras.
4. **Postproceso:** GTAO, bloom, SMAA, salida. Punto de control: Poolrooms con sus efectos.
5. **Animación y personajes:** esqueletos, mezclador, clonado. Punto de control: entidades animadas.
6. **`ShaderMaterial`:** los 22 casos por archivo, de uno en uno. Un punto de control por cada archivo portado.
7. **Resto y migración final:** `Reflector`, `Raycaster`, `Points`/`Sprite`/`Line`, cambio de importaciones. Punto de control: partida completa en cada nivel.
8. **Rendimiento:** medición antes/después en equipos de distinta potencia y optimización.

## Qué se deja al constructor
- Estructura interna de paquetes y nombres de módulos.
- Mecanismo de lotes e instancias automáticas.
- Orden exacto dentro de cada fase y herramientas de comparación (siempre que cumplan «Fidelidad»).

## Decisiones pendientes del dueño
- **Equipos sin WebGPU:** Phoenyx solo funciona con WebGPU. Con A el juego no tendría renderer alternativo. Propuesta mía: mantener three como respaldo cargado solo si falta WebGPU (la API es la misma). Si no, esos equipos no podrían jugar.
- **Umbral de fidelidad:** el propuesto arriba, o más estricto.

## Aclaraciones tras la revisión del constructor
- **Estado actual:** el juego usa `THREE.WebGLRenderer` (three 0.160). Phoenix es un renderer WebGPU (Rust + wgpu a WASM) con culling/LOD/Hi-Z en GPU, sombras de sol y focos, luces en clusters, post-proceso, partículas y personajes con huesos (ver `ARQUITECTURA.md` y `LIMITACIONES.md`). Las fases 1 a 4 reutilizan esa base, pero hay que construir el grafo de escena, los materiales con el sombreado de three y las luces/sombras con su aspecto, que hoy no existen.
- **Fidelidad de efectos:** el código de los pases de three (GTAO, bloom, SMAA, Output) se porta línea a línea a WGSL con sus patrones de muestreo; no se reimplementan para «aprobar la métrica». La métrica se aplica por escena de referencia, no por fotograma suelto. El ruido de GTAO se compara con semilla fija o promediado.
- **Determinismo de las escenas de prueba:** la fase 0 añade, en la rama de Backrooms, un modo de captura (hora, semilla y reloj congelados). Es el único cambio de juego previo a la migración, y vive solo en la rama.
- **Uso de internos de three medido en el cliente:** `onBeforeCompile` (5 usos) y `customProgramCacheKey` (2) cuentan como `ShaderMaterial` ocultos que hay que portar (además de los 22); `.uniforms` (56), `renderOrder` (27), `transparent` (105), `layers` (4), `setRenderTarget` (6), `userData` (45). No se usan `overrideMaterial`, `sortObjects` ni `three-mesh-bvh`. El orden de transparencias y `renderOrder` se reproducen tal cual.
- **Lotes automáticos:** el comportamiento observable se conserva: orden de dibujo, raycast por malla y cambio de material por malla en ejecución siguen funcionando (un objeto que muta su material sale del lote).
- **Desarrollo en paralelo:** el juego sigue evolucionando en `master`. La migración usa un alias de importación (`three` apunta a Phoenyx en la rama) para que casi ningún archivo cambie; se reincorpora `master` a la rama de forma periódica.
- **Rendimiento:** la fase 0 incluye una medición de base con el panel de rendimiento del juego en tres equipos (gama baja, media, alta). El objetivo numérico se fija con esa medición, antes de la fase 1; la fase 8 compara contra ella.
- **Equipos sin WebGPU:** three queda como respaldo cargado bajo demanda (propuesta aprobada con el documento).
