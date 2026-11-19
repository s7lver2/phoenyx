# Fusión de Phoenix en Phoenyx (diseño)

## Intención
Hoy conviven dos motores en `E:\phoenix` sin dependencia entre ellos: **Phoenyx** (`crates/phoenyx-gl` + `packages/phoenyx`, API de three.js, el que usa Backrooms) y **Phoenix** (`crates/phoenix`, `crates/lux`, `crates/phoenix-bake`, `web/phoenix.js`, GPU-driven con LOD). Duplican shaders y cada uno crea su dispositivo wgpu. El dueño quiere **un solo motor, Phoenyx**, que absorba de Phoenix: (1) culling y LOD en GPU, (2) bake de modelos en el build, (3) el sistema de iluminación lux, y que Phoenix desaparezca.

Por qué: menos confusión, y un motor que pueda dar el LOD que el juego necesita (distancia de dibujo, "pasillo infinito" en los niveles).

## Objetivos
- Un único producto y un único workspace con el nombre Phoenyx; sin `crates/phoenix` ni `web/phoenix.js` al final.
- Un dispositivo y una superficie wgpu compartidos.
- LOD + culling GPU aplicados a los objetos instanciados del juego que lo permitan.
- Bake de GLB con niveles de detalle como paso del build del juego.
- Lux disponible como sistema de iluminación **aparte y opcional**.

## No objetivos
- No se sustituye la iluminación legacy (modelo de three, `shader.wgsl` de Phoenyx). Decisión del dueño: se mantiene tal cual, sin cambio de aspecto.
- No se reescribe Phoenyx sobre Phoenix ni se convierte en un Nanite real (sin clusters jerárquicos ni visibility buffer; ver `docs/LIMITACIONES.md`).
- No se tocan los materiales de usuario ni la API de three.

## Anti-objetivos (fracaso aunque "funcione")
- Que cambie el aspecto del juego: las capturas de fidelidad (`tools/fidelity`) deben seguir igual.
- Que el juego pierda rendimiento de CPU (hoy: paridad con three; la GPU no es el cuello).

## Restricciones
- Phoenix solo admite instancias con rotación en Y y modelos normalizados a esfera unidad; UV en [0, 1] (sin tiling). Lo que no cumpla eso (paredes y suelos tileados, materiales de usuario, objetos con rotación libre) sigue por el camino actual de Phoenyx.
- Los niveles del juego se generan en tiempo de ejecución; el bake solo cubre los GLB del juego (props), no la geometría procedural.
- Rust 2024, wgpu 30.0.2, wasm-bindgen =0.2.130 (versiones ya fijadas). Sin tests unitarios; se verifica con capturas de fidelidad y medidas (`tools/fidelity`).

## Enfoques considerados
1. **Solo organizar** (un nombre, un workspace, Phoenix como módulo sin conectar): barato, no aporta rendimiento ni LOD.
2. **Núcleo común + camino rápido para props** (elegido): dispositivo compartido, y los objetos instanciados compatibles pasan por culling/LOD GPU; el resto, como hoy.
3. **Reescribir Phoenyx sobre Phoenix**: lo más limpio, pero casi una fase desde cero y alto riesgo para el juego.

Elegido por el dueño: 2, con lux como sistema separado (ver abajo).

## Diseño
- **Fase A, base común.** Un solo workspace con Phoenyx como nombre. Un módulo de dispositivo/superficie compartido; Phoenix y Phoenyx dejan de crear el suyo. Código duplicado de shaders (`post.wgsl`, `shader.wgsl`) se unifica cuando sea idéntico; si difiere, se conserva la versión de Phoenyx.
- **Fase B, LOD y bake.** `phoenix-bake` se integra como herramienta de build de Phoenyx (paso de `vite build` del juego): GLB → paquete con N niveles de detalle y texturas. En ejecución, un camino GPU-driven dentro de Phoenyx (chunks de 64 instancias, `pick` por frustum/tamaño/Hi-Z, LOD por error en pantalla con fundido, draws indirectos) dibuja los `InstancedMesh` marcados como compatibles. Cómo se marca un objeto como compatible (flag de material/objeto o detección automática) lo decide quien construya.
- **Fase C, lux aparte.** `crates/lux` (cluster_cull 16×9×24) se integra como un sistema de iluminación **independiente y opcional**, activable por escena/renderer. La iluminación legacy sigue siendo la por defecto y no se modifica. Qué escenas lo activan y cómo conviven ambos (por ejemplo, lux solo para el camino GPU-driven) lo decide quien construya, midiendo.
- **Fase D, retirada de Phoenix.** Cuando A–C estén verdes (fidelidad igual, rendimiento igual o mejor), se borran `crates/phoenix`, `web/phoenix.js` y sus páginas de demo. Queda en el historial de git. Se actualiza `README.md` y `docs/`.

## Qué queda para quien construya
Formato exacto del paquete bakeado; cómo se detecta un objeto compatible con el camino GPU; cómo conviven lux y la iluminación legacy; qué demos (`web/*.html`) se conservan como ejemplos de Phoenyx.

## Verificación
Capturas de fidelidad de `tools/fidelity` (escenas sintéticas y las del juego `level0-inicio`/`level0-semilla7`) sin cambios fuera de tolerancia; medidas de CPU/GPU con `profile.mjs`/`exp.mjs` antes y después de cada fase; el LOD se mide con la distancia de dibujo y los tris dibujados.
