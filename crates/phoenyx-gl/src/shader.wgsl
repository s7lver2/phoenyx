// Sombreado de three 0.160.1 portado a WGSL (MeshBasicMaterial y MeshStandardMaterial). Cada bloque nombra el chunk de three que replica.
// Orden de salida igual que en three: luces -> tonemapping_fragment -> colorspace_fragment -> fog_fragment.

struct Globals {
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
    cam: vec4<f32>,      // xyz posicion de la camara, w exposicion del tone mapping
    p0: vec4<f32>,       // x modo de tone mapping (0 ninguno, 1 ACES), y modo de niebla (0 ninguna, 1 lineal, 2 exp2), z near, w far
    fogc: vec4<f32>,     // rgb color de la niebla (en el espacio de salida, como refreshFogUniforms), w densidad
    clear: vec4<f32>,    // color de fondo (lo usa el anfitrion Rust)
    dim: vec4<f32>,      // x ancho, y alto, z numero de luces
    amb: vec4<f32>,      // rgb luz ambiente (suma de AmbientLight * intensidad)
    pad0: vec4<f32>,
    pad1: vec4<f32>,
};

struct Obj {
    model: mat4x4<f32>,
    n0: vec4<f32>,       // matriz normal (vista) por columnas
    n1: vec4<f32>,
    n2: vec4<f32>,
    pad: vec4<f32>,
};

struct Mat {
    color: vec4<f32>,    // rgb color lineal, a opacidad
    emissive: vec4<f32>, // rgb emisivo * intensidad, a rugosidad
    misc: vec4<f32>,     // x metalicidad, y tipo (0 basic, 1 standard), z niebla (1 si), w sin uso
};

struct Light {
    a: vec4<f32>,        // x tipo (0 direccional, 1 puntual), yzw color * intensidad
    b: vec4<f32>,        // xyz posicion (vista), w distancia de corte
    c: vec4<f32>,        // x decaimiento, yzw direccion hacia la luz (vista)
    d: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> objects: array<Obj>;
@group(0) @binding(2) var<storage, read> materials: array<Mat>;
@group(0) @binding(3) var<storage, read> lights: array<Light>;
@group(0) @binding(4) var<storage, read> draws: array<vec4<u32>>;

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vpos: vec3<f32>,
    @location(1) vnormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) @interpolate(flat) di: u32,
};

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let d = draws[ii];
    let o = objects[d.y];
    let mv = g.view * o.model;
    let vp = mv * vec4<f32>(position, 1.0);
    var clip = g.proj * vp;
    // three (WebGL) usa z de clip en [-w, w]; WebGPU, en [0, w]
    clip.z = (clip.z + clip.w) * 0.5;
    var out: VOut;
    out.pos = clip;
    out.vpos = vp.xyz;
    out.vnormal = mat3x3<f32>(o.n0.xyz, o.n1.xyz, o.n2.xyz) * normal;
    out.uv = uv;
    out.di = ii;
    return out;
}

// ---- tonemapping_pars_fragment: ACESFilmicToneMapping ----
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

// ---- colorspace_pars_fragment: sRGBTransferOETF ----
fn sRGBTransferOETF(v: vec3<f32>) -> vec3<f32> {
    return select(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, v <= vec3<f32>(0.0031308));
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
    let m = materials[draws[in.di].z];
    var rgb = m.color.rgb;   // MeshBasicMaterial: outgoingLight = diffuse
    let alpha = m.color.a;

    // tonemapping_fragment
    if (g.p0.x > 0.5) {
        rgb = ACESFilmicToneMapping(rgb);
    }
    // colorspace_fragment (salida sRGB)
    rgb = sRGBTransferOETF(rgb);
    // fog_fragment: se mezcla despues de codificar, con el color de la niebla ya en el espacio de salida
    if (m.misc.z > 0.5 && g.p0.y > 0.5) {
        let depth = -in.vpos.z;
        var f: f32;
        if (g.p0.y < 1.5) {
            f = smoothstep(g.p0.z, g.p0.w, depth);
        } else {
            f = 1.0 - exp(-g.fogc.w * g.fogc.w * depth * depth);
        }
        rgb = mix(rgb, g.fogc.rgb, f);
    }
    return vec4<f32>(rgb, alpha);
}
