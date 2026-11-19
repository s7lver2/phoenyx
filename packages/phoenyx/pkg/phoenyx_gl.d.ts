/* tslint:disable */
/* eslint-disable */

export class Collide {
    free(): void;
    [Symbol.dispose](): void;
    add_box(chunk: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void;
    add_box_y(chunk: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number): void;
    /**
     * Devuelve el id del bloque (para `set_cell`).
     */
    add_cells(chunk: number, ox: number, oz: number, cell: number, w: number, h: number, bits: Uint8Array | number[], y0: number, y1: number): number;
    add_cylinder(chunk: number, x: number, y: number, z: number, r: number, h: number): void;
    add_floor(chunk: number, x0: number, z0: number, x1: number, z1: number, y: number): void;
    add_ramp(chunk: number, x0: number, z0: number, x1: number, z1: number, ya: number, yb: number, axis: number): void;
    add_steps(chunk: number, x0: number, z0: number, x1: number, z1: number, y0: number, rise: number, tread: number, count: number, axis: number, from_max: boolean): void;
    /**
     * Altura del suelo bajo (x, z) para unos pies a `feet` y un peldaño máximo; NaN si no hay.
     */
    floor_at(x: number, z: number, feet: number, step_max: number): number;
    /**
     * Mueve un cuerpo `[dx, dz]` y avanza su vertical `dt`. Escribe la posición y el estado en `body`; devuelve banderas.
     */
    move_body(body: Float32Array, dx: number, dz: number, dt: number, gravity: number): number;
    /**
     * Solo XZ con contactos (sin suelo ni gravedad), para quien lleva su propia vertical.
     */
    move_xz(body: Float32Array, dx: number, dz: number): number;
    constructor(cell: number);
    /**
     * Rayo: escribe `[t, nx, ny, nz]` en `out` y devuelve true si da.
     */
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, out: Float32Array): boolean;
    remove_chunk(chunk: number): void;
    set_cell(block: number, x: number, z: number, solid: boolean): void;
    /**
     * Avanza `n` proyectiles del buffer `buf` (12 floats cada uno).
     */
    step_projectiles(buf: Float32Array, n: number, dt: number, gravity: number): void;
}

export class Gl {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `WebGLRenderer.clear`: el siguiente dibujo sobre el destino actual limpia color y/o profundidad.
     */
    clear(r: number, g: number, b: number, a: number, color: boolean, depth: boolean): void;
    /**
     * Crea (o reemplaza) un render target. `color_id` es su id de textura (para leerlo como `map` o entrada de un pase);
     * `depth_id` != 0 registra tambien su profundidad como textura legible. `fmt`: 1 RGBA16F, 2 RGBA8.
     */
    create_target(color_id: number, w: number, h: number, fmt: number, depth_id: number): void;
    /**
     * Destruye el dispositivo (los renderers secundarios, como los de iconos, no lo dejan vivo hasta el GC).
     */
    destroy(): void;
    drop_geometry(id: number): void;
    drop_instances(mesh: number): void;
    drop_target(color_id: number): void;
    drop_texture(id: number): void;
    /**
     * Activa o desactiva los temporizadores de GPU (no hacen nada sin timestamp-query).
     */
    enable_timing(on: boolean): void;
    /**
     * Envia a la GPU los pases de pantalla completa grabados (un solo submit). Lo llaman solos frame(), resize() y los
     * cambios de render targets; el renderer lo programa ademas al final de la tarea para que lo grabado llegue a pantalla.
     */
    flush(): void;
    /**
     * Dibuja un fotograma. Los formatos de los arrays: ver docs/FASE1.md.
     * `draws`: 12 u32 por dibujo `[geometria, objeto, material, flags, primer indice, n indices, clave de texturas, malla instanciada (u32::MAX si no), n instancias, primera instancia, 0, 0]`, ya en el orden final de pintado.
     */
    frame(globals: Float32Array | number[], objects: Float32Array | number[], materials: Float32Array | number[], lights: Float32Array | number[], draws: Uint32Array | number[], shadows: Float32Array | number[], shadow_passes: Uint32Array | number[], main_draws: number, gpu_groups: Float32Array | number[]): boolean;
    gpu_ok(): boolean;
    is_lost(): boolean;
    /**
     * Un pase de pantalla completa sobre el destino actual (`set_target`). `shader` es el indice del fragment en
     * `post.wgsl` (ver pass-registry.ts); `blend` = [modo (0 sin mezcla), srcRGB, dstRGB, ecuacion, srcA, dstA, ecuacionA]
     * con las constantes de three; `tex`: ids de las 5 texturas filtrables y de la de profundidad (0 = blanca).
     */
    pass(shader: number, uniforms: Float32Array | number[], blend: Uint32Array | number[], tex: Uint32Array | number[]): boolean;
    /**
     * Si el adaptador permite el culling y LOD en GPU (INDIRECT_FIRST_INSTANCE).
     * Cuántos pipelines de dibujo hay creados (depuración: un salto al entrar en un sitio nuevo es una compilación).
     */
    pipeline_count(): number;
    resize(w: number, h: number): void;
    /**
     * Entorno de la escena (scene.environment): id de un render target PMREM (formato CubeUV) o u32::MAX para ninguno.
     */
    set_environment(id: number): void;
    /**
     * Crea o reemplaza una geometria: posiciones y normales de 3 floats, uvs de 2 (puede venir vacio) e indices u32.
     */
    set_geometry(id: number, positions: Float32Array | number[], normals: Float32Array | number[], uvs: Float32Array | number[], colors: Float32Array | number[], indices: Uint32Array | number[], skin_idx: Uint32Array | number[], skin_w: Float32Array | number[]): void;
    /**
     * Sube las matrices (16 floats) y los colores (3 floats, opcionales) de un `InstancedMesh` a la reserva de instancias.
     */
    set_instances(mesh: number, matrices: Float32Array | number[], colors: Float32Array | number[]): void;
    /**
     * Lightmap del juego (parche de lightmap.ts): dos texturas RGBA8 de `w` x `h` (luz + oclusion, y tubos que parpadean).
     */
    set_lightmap(w: number, h: number, d0: Uint8Array | number[], d1: Uint8Array | number[]): void;
    /**
     * Tablas LTC de RectAreaLight (64x64 RGBA float, las de `RectAreaLightUniformsLib`).
     */
    set_ltc(ltc1: Float32Array | number[], ltc2: Float32Array | number[]): void;
    /**
     * Define el conjunto de texturas y muestreadores (ids; 0 = ninguno) de una clave de material:
     * `[map, normalMap, roughnessMap, emissiveMap, bumpMap]`.
     */
    set_material_textures(key: number, tex: Uint32Array | number[], samp: Uint32Array | number[]): void;
    /**
     * `wrap`: 0 repetir, 1 sujetar al borde, 2 espejo. `mip`: 0 sin mipmaps, 1 vecino mas cercano, 2 lineal.
     */
    set_sampler(id: number, wrap_s: number, wrap_t: number, mag_linear: boolean, min_linear: boolean, mip: number, anisotropy: number): void;
    /**
     * Reserva los mapas de sombra (una capa por luz con sombra, todas de `size` x `size`). Deja los mapas vacios.
     */
    set_shadow_maps(layers: number, size: number): void;
    /**
     * Destino de los siguientes dibujos: el id de un render target o u32::MAX para la pantalla.
     */
    set_target(id: number): void;
    /**
     * Sube una textura RGBA de 8 bits (filas ya en el orden de `flipY`) y calcula sus mipmaps si `mips`.
     */
    set_texture(id: number, w: number, h: number, rgba: Uint8Array | number[], srgb: boolean, mips: boolean): void;
    /**
     * Viewport y scissor del destino actual, como los de un WebGLRenderTarget (origen abajo a la izquierda = fila 0 de la memoria del destino).
     * `vw == 0` quita el viewport (todo el destino); `sw == 0` quita el scissor.
     */
    set_viewport(vx: number, vy: number, vw: number, vh: number, sx: number, sy: number, sw: number, sh: number): void;
    /**
     * `[dibujos, triangulos, geometrias]` del ultimo fotograma.
     */
    stats(): Float32Array;
    take_error(): string;
    /**
     * `[tipo, ms, tipo, ms, ...]` de la ultima lectura: 1 sombras, 2 escena, 100 + id de pase de pantalla completa (sumados por tipo).
     */
    timings(): Float32Array;
}

export function create(canvas: HTMLCanvasElement, alpha: boolean): Promise<Gl>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_collide_free: (a: number, b: number) => void;
    readonly __wbg_gl_free: (a: number, b: number) => void;
    readonly collide_add_box: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly collide_add_box_y: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly collide_add_cells: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => number;
    readonly collide_add_cylinder: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly collide_add_floor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly collide_add_ramp: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly collide_add_steps: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => void;
    readonly collide_floor_at: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly collide_move_body: (a: number, b: number, c: number, d: any, e: number, f: number, g: number, h: number) => number;
    readonly collide_move_xz: (a: number, b: number, c: number, d: any, e: number, f: number) => number;
    readonly collide_new: (a: number) => number;
    readonly collide_raycast: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: any) => number;
    readonly collide_remove_chunk: (a: number, b: number) => void;
    readonly collide_set_cell: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly collide_step_projectiles: (a: number, b: number, c: number, d: any, e: number, f: number, g: number) => void;
    readonly create: (a: any, b: number) => any;
    readonly gl_clear: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly gl_create_target: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly gl_destroy: (a: number) => void;
    readonly gl_drop_geometry: (a: number, b: number) => void;
    readonly gl_drop_instances: (a: number, b: number) => void;
    readonly gl_drop_target: (a: number, b: number) => void;
    readonly gl_drop_texture: (a: number, b: number) => void;
    readonly gl_enable_timing: (a: number, b: number) => void;
    readonly gl_flush: (a: number) => void;
    readonly gl_frame: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => number;
    readonly gl_gpu_ok: (a: number) => number;
    readonly gl_is_lost: (a: number) => number;
    readonly gl_pass: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly gl_pipeline_count: (a: number) => number;
    readonly gl_resize: (a: number, b: number, c: number) => void;
    readonly gl_set_environment: (a: number, b: number) => void;
    readonly gl_set_geometry: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => void;
    readonly gl_set_instances: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly gl_set_lightmap: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly gl_set_ltc: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly gl_set_material_textures: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly gl_set_sampler: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly gl_set_shadow_maps: (a: number, b: number, c: number) => void;
    readonly gl_set_target: (a: number, b: number) => void;
    readonly gl_set_texture: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly gl_set_viewport: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly gl_stats: (a: number) => [number, number];
    readonly gl_take_error: (a: number) => [number, number];
    readonly gl_timings: (a: number) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h14d3297b61464c3f: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h27b091ef5e220e15: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h27b091ef5e220e15_50: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h27b091ef5e220e15_51: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h45a38795a3ce41ab: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h2bd702dad721f783: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h2bd702dad721f783_49: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
