// Cabecera comun de los shaders de usuario (ShaderMaterial portados a mano). Se antepone a cada `user/<archivo>.wgsl`.
// Un dibujo de usuario (bit 1024 de sus banderas) lleva en `draws` la primera plaza de sus uniformes en `materials` (vista
// aqui como array<vec4>; cada plaza son 16 vec4) en la palabra `z` de su primer vec4.
// vec4 0 de los uniformes: x = material.fog (1 si); los uniformes del material siguen desde el vec4 1 (orden definido en
// packages/phoenyx/src/user-shaders/<archivo>.ts).

struct Globals {
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
    cam: vec4<f32>,      // xyz posicion de la camara, w exposicion del tone mapping
    p0: vec4<f32>,       // x modo de tone mapping (0 ninguno, 1 ACES), y modo de niebla (0 ninguna, 1 lineal, 2 exp2), z near, w far
    fogc: vec4<f32>,     // rgb color de la niebla (en el espacio de salida), w densidad
    clear: vec4<f32>,
    dim: vec4<f32>,      // x ancho, y alto
    amb: vec4<f32>,
    pad0: vec4<f32>,     // z salida lineal (render target)
    pad1: vec4<f32>,
};

struct Obj {
    model: mat4x4<f32>,
    n0: vec4<f32>,       // matriz normal (vista) por columnas
    n1: vec4<f32>,
    n2: vec4<f32>,
    pad: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> objects: array<Obj>;
@group(0) @binding(2) var<storage, read> uu: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> draws: array<vec4<u32>>;

@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var t1: texture_2d<f32>;
@group(1) @binding(2) var t2: texture_2d<f32>;
@group(1) @binding(3) var t3: texture_2d<f32>;
@group(1) @binding(4) var t4: texture_2d<f32>;
@group(1) @binding(5) var s0: sampler;
@group(1) @binding(6) var s1: sampler;
@group(1) @binding(7) var s2: sampler;
@group(1) @binding(8) var s3: sampler;
@group(1) @binding(9) var s4: sampler;

/// vec4 `k` de los uniformes del dibujo `di` (k = 0 es la cabecera: x = fog).
fn ub(di: u32, k: u32) -> vec4<f32> {
    return uu[draws[di * 3u].z * 16u + k];
}

fn modelOf(di: u32) -> mat4x4<f32> { return objects[draws[di * 3u].y].model; }
fn normalMatrixOf(di: u32) -> mat3x3<f32> {
    let o = objects[draws[di * 3u].y];
    return mat3x3<f32>(o.n0.xyz, o.n1.xyz, o.n2.xyz);
}

/// Posicion de clip como la deja el vertex shader estandar: three (WebGL) usa z en [-w, w] y WebGPU en [0, w]; un render target
/// guarda la imagen con la fila 0 abajo (y de clip invertida). `mv` = modelViewMatrix * position.
fn clip_of(mv: vec4<f32>) -> vec4<f32> {
    var clip = g.proj * mv;
    clip.z = (clip.z + clip.w) * 0.5;
    if (g.pad0.z > 0.5) {
        clip.y = -clip.y;
    }
    return clip;
}

// ---- tonemapping_fragment (ACESFilmic) y colorspace_fragment (sRGB), como en shader.wgsl ----
const ACESInputMat = mat3x3<f32>(vec3<f32>(0.59719, 0.07600, 0.02840), vec3<f32>(0.35458, 0.90834, 0.13383), vec3<f32>(0.04823, 0.01566, 0.83777));
const ACESOutputMat = mat3x3<f32>(vec3<f32>(1.60475, -0.10208, -0.00327), vec3<f32>(-0.53108, 1.10813, -0.07276), vec3<f32>(-0.07367, -0.00605, 1.07602));

fn RRTAndODTFit(v: vec3<f32>) -> vec3<f32> {
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}

fn ACESFilmicToneMapping(c: vec3<f32>) -> vec3<f32> {
    var color = c * (g.cam.w / 0.6);
    color = ACESInputMat * color;
    color = RRTAndODTFit(color);
    color = ACESOutputMat * color;
    return saturate(color);
}

fn sRGBTransferOETF(v: vec3<f32>) -> vec3<f32> {
    return select(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, v <= vec3<f32>(0.0031308));
}

/// tonemapping_fragment + colorspace_fragment de un ShaderMaterial (material.toneMapped = true).
fn tone_out(c: vec3<f32>) -> vec3<f32> {
    var rgb = c;
    if (g.p0.x > 0.5) { rgb = ACESFilmicToneMapping(rgb); }
    if (g.pad0.z < 0.5) { rgb = sRGBTransferOETF(rgb); }
    return rgb;
}

/// fog_fragment: `depth` = -mvPosition.z; solo si el material pide niebla (x de la cabecera) y la escena tiene.
fn fog_out(c: vec3<f32>, depth: f32, fog_on: f32) -> vec3<f32> {
    if (fog_on > 0.5 && g.p0.y > 0.5) {
        var f: f32;
        if (g.p0.y < 1.5) {
            f = smoothstep(g.p0.z, g.p0.w, depth);
        } else {
            f = 1.0 - exp(-g.fogc.w * g.fogc.w * depth * depth);
        }
        return mix(c, g.fogc.rgb, f);
    }
    return c;
}
