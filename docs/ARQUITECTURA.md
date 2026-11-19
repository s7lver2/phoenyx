# Arquitectura

Phoenyx = capa three.js en TypeScript (`packages/phoenyx`: recorre la escena, empaqueta los dibujos en arrays tipados) + núcleo Rust/WebGPU (`crates/phoenyx-gl`: `Gl::frame` recibe esos arrays y dibuja).

## Crates

| Crate | Qué es |
|---|---|
| `crates/phoenyx-gl` | El núcleo (cdylib WASM): pase principal, sombras, post-proceso, materiales de usuario, culling y LOD en GPU. |
| `crates/phoenyx-lux` | Iluminación independiente y opcional (sin conectar al renderer). Ver [LUX.md](LUX.md). |
| `crates/phoenyx-bake` | CLI nativa: GLB/procedurales a paquete de modelos con LOD y texturas. Ver [ASSETS.md](ASSETS.md). |
| `crates/phoenix-ai` | Utilidad de IA aparte. Ver [IA.md](IA.md). |

## Culling y LOD en GPU (`gpu_cull.rs`, `gpu_cull.wgsl`)

- Un `InstancedMesh` con `userData.gpuLods = [{ geometry, error }]` (LOD 1..3, mismos vértices o no; el LOD 0 es la geometría del mesh) lo empaqueta `pack.ts` como un dibujo por LOD con el bit 8192 de `flags`, más un registro de grupo (16 floats) que va en `gpu_groups`.
- Antes del pase principal, un compute (una invocación por instancia) calcula el frustum con las filas de la proyección, descarta lo menor que `gpuMinPx` y elige el LOD más grueso cuyo error proyectado cabe en `gpuTolerance` píxeles. Suma con `atomicAdd` al `instance_count` del dibujo indirecto de ese LOD y escribe la instancia en `gpu_vis`.
- El dibujo es `draw_indexed_indirect` con el sombreado normal: `vs` remapea la instancia con `gpu_vis`. Sombras y pasada de normales dibujan esos grupos por el camino normal (LOD 0, todas las instancias). Sin `INDIRECT_FIRST_INSTANCE` en el adaptador, o con `renderer.gpuDriven = false`, todo sale por el camino normal.
- Limitaciones: solo mallas no transparentes, sin shaders de usuario, hasta 65 535 instancias por mesh; sin oclusión Hi-Z ni fundido entre LOD (saltos de LOD con tolerancia de ~1 px).
