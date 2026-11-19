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
    pad0: vec4<f32>,     // x numero de sombras, y tipo de sombra (0 Basic, 1 PCF, 2 PCFSoft), z salida lineal (render target)
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
    misc: vec4<f32>,     // x metalicidad, y tipo (0 basic, 1 standard), z niebla (1 si), w vertexColors (1 si)
    tp: vec4<f32>,       // x alphaTest, yz normalScale, w bumpScale
    maps: vec4<f32>,     // x mascara de mapas: 1 map, 2 normalMap, 4 roughnessMap, 8 emissiveMap, 16 bumpMap, 32 metalnessMap (misma textura que roughnessMap)
    uv: array<vec4<f32>, 10>, // por mapa (mismo orden): (a, b, c, d) y (tx, ty, 0, 0) de la matriz de uv de la textura
    pad: vec4<f32>,
};

struct Light {
    a: vec4<f32>,        // x tipo (0 direccional, 1 puntual, 2 hemisferio, 3 foco, 4 area rectangular), yzw color * intensidad (hemisferio: cielo)
    b: vec4<f32>,        // xyz posicion (vista; hemisferio: color del suelo), w distancia de corte
    c: vec4<f32>,        // x decaimiento, yzw direccion hacia la luz (vista; foco: eje desde el objetivo)
    d: vec4<f32>,        // foco: x cos(angle), y cos(angle * (1 - penumbra)); spot y direccional: z capa de sombra + 1 (0 sin sombra)
};

// una por luz con sombra: matriz de consulta (la de LightShadow.matrix), matriz de la camara de sombra y parametros
struct Shadow {
    mat: mat4x4<f32>,
    vp: mat4x4<f32>,
    p0: vec4<f32>,       // x bias, y normalBias, z radius, w ancho del mapa
    p1: vec4<f32>,       // x alto del mapa
    pad0: vec4<f32>,
    pad1: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> objects: array<Obj>;
@group(0) @binding(2) var<storage, read> materials: array<Mat>;
@group(0) @binding(3) var<storage, read> lights: array<Light>;
@group(0) @binding(4) var<storage, read> draws: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read> inst_mats: array<mat4x4<f32>>;
@group(0) @binding(6) var<storage, read> inst_cols: array<vec4<f32>>;

@group(1) @binding(0) var tex_map: texture_2d<f32>;
@group(1) @binding(1) var tex_normal: texture_2d<f32>;
@group(1) @binding(2) var tex_rough: texture_2d<f32>;
@group(1) @binding(3) var tex_emis: texture_2d<f32>;
@group(1) @binding(4) var tex_bump: texture_2d<f32>;
@group(1) @binding(5) var smp_map: sampler;
@group(1) @binding(6) var smp_normal: sampler;
@group(1) @binding(7) var smp_rough: sampler;
@group(1) @binding(8) var smp_emis: sampler;
@group(1) @binding(9) var smp_bump: sampler;

/// Parches de `onBeforeCompile` portados (packages/phoenyx/src/patches.ts): 1 tinte de cosmeticos (cos-tint), 2 luz de lightmap.ts,
/// 3 rugosidad minima del hormigon del parking, 4 baldosa de las Poolrooms (poolTile).
fn h31(p: vec3<f32>) -> f32 {
    var q = fract(fma(p, vec3<f32>(0.3183099), vec3<f32>(0.1)));
    q = q * 17.0;
    return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
fn vn(p: vec3<f32>) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3<f32>(1.0, 0.0, 0.0)), f.x), mix(h31(i + vec3<f32>(0.0, 1.0, 0.0)), h31(i + vec3<f32>(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(h31(i + vec3<f32>(0.0, 0.0, 1.0)), h31(i + vec3<f32>(1.0, 0.0, 1.0)), f.x), mix(h31(i + vec3<f32>(0.0, 1.0, 1.0)), h31(i + vec3<f32>(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
/// smoothstep de GLSL: admite bordes en cualquier orden (en WGSL low >= high es indeterminado).
fn sstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

/// uv de un mapa: matriz de uv de la textura (texture.matrix) aplicada a las uv interpoladas.
fn uvT(m: Mat, k: u32, uv: vec2<f32>) -> vec2<f32> {
    let a = m.uv[k * 2u];
    let b = m.uv[k * 2u + 1u];
    return vec2<f32>(a.x * uv.x + a.z * uv.y + b.x, a.y * uv.x + a.w * uv.y + b.y);
}

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vpos: vec3<f32>,
    @location(1) vnormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) @interpolate(flat) di: u32,
    @location(4) color: vec3<f32>,
    @location(5) sc0: vec4<f32>,
    @location(6) sc1: vec4<f32>,
    @location(7) sc2: vec4<f32>,
    @location(8) sc3: vec4<f32>,
    @location(9) wpos: vec3<f32>,   // posicion y normal de mundo (los parches de material las leen como vWp / vLmP y vUp / vLmN)
    @location(10) wnrm: vec3<f32>,
};

// skinbase_vertex / skinning_vertex / skinnormal_vertex de three: el tramo de huesos vive en la reserva de matrices (inst_mats):
// [bindMatrix, bindMatrixInverse, hueso 0, hueso 1, ...] y `bo` = su offset + 1 (0 = sin piel)
fn skin_pos(bo: u32, si: vec4<u32>, sw: vec4<f32>, p: vec4<f32>) -> vec4<f32> {
    let skinVertex = inst_mats[bo - 1u] * p;
    var skinned = vec4<f32>(0.0);
    skinned += inst_mats[bo + 1u + si.x] * skinVertex * sw.x;
    skinned += inst_mats[bo + 1u + si.y] * skinVertex * sw.y;
    skinned += inst_mats[bo + 1u + si.z] * skinVertex * sw.z;
    skinned += inst_mats[bo + 1u + si.w] * skinVertex * sw.w;
    return vec4<f32>((inst_mats[bo] * skinned).xyz, 1.0);
}

fn skin_normal(bo: u32, si: vec4<u32>, sw: vec4<f32>, n: vec3<f32>) -> vec3<f32> {
    var m = mat4x4<f32>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
    m += sw.x * inst_mats[bo + 1u + si.x];
    m += sw.y * inst_mats[bo + 1u + si.y];
    m += sw.z * inst_mats[bo + 1u + si.z];
    m += sw.w * inst_mats[bo + 1u + si.w];
    m = inst_mats[bo] * m * inst_mats[bo - 1u];
    return (m * vec4<f32>(n, 0.0)).xyz;
}

@vertex
fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @location(4) si: vec4<u32>, @location(5) sw: vec4<f32>, @builtin(instance_index) ii: u32) -> VOut {
    // el indice de dibujo va en los 16 bits altos de instance_index y la instancia en los bajos
    let di = ii >> 16u;
    let k = ii & 0xFFFFu;
    let d = draws[di * 3u];
    let d1 = draws[di * 3u + 1u];
    let bo = draws[di * 3u + 2u].w;
    let o = objects[d.y];
    var p = vec4<f32>(position, 1.0);
    var nrm = normal;
    var icol = vec3<f32>(1.0);
    if (bo != 0u) {
        // skinnormal_vertex antes de la matriz normal y skinning_vertex antes de la proyeccion
        nrm = skin_normal(bo, si, sw, nrm);
        p = skin_pos(bo, si, sw, p);
    }
    if (d1.w != 0xFFFFFFFFu) {
        // instancing_vertex / defaultnormal_vertex: instanceMatrix antes de la matriz del objeto
        let im4 = inst_mats[d1.w + k];
        p = im4 * p;
        let a0 = im4[0].xyz;
        let a1 = im4[1].xyz;
        let a2 = im4[2].xyz;
        nrm = mat3x3<f32>(a0, a1, a2) * (normal / vec3<f32>(dot(a0, a0), dot(a1, a1), dot(a2, a2)));
        if ((d.w & 128u) != 0u) {
            icol = inst_cols[d1.w + k].xyz;
        }
    }
    let mv = g.view * o.model;
    let vp = mv * p;
    var clip = g.proj * vp;
    // three (WebGL) usa z de clip en [-w, w]; WebGPU, en [0, w]
    clip.z = (clip.z + clip.w) * 0.5;
    // un render target guarda la imagen como WebGL (fila 0 = abajo): se invierte la y de clip
    if (g.pad0.z > 0.5) {
        clip.y = -clip.y;
    }
    var out: VOut;
    out.pos = clip;
    out.vpos = vp.xyz;
    out.wpos = (o.model * p).xyz;
    out.wnrm = normalize(mat3x3<f32>(o.model[0].xyz, o.model[1].xyz, o.model[2].xyz) * nrm);
    // FLIP_SIDED (material BackSide): three invierte la normal en el vertex shader
    let flip = select(1.0, -1.0, (d.w & 32u) != 0u);
    out.vnormal = normalize(mat3x3<f32>(o.n0.xyz, o.n1.xyz, o.n2.xyz) * nrm) * flip;   // beginnormal/defaultnormal: three normaliza por vertice
    out.uv = uv;
    out.di = di;
    // shadowmap_vertex: posicion de mundo desplazada por normalBias a lo largo de la normal de mundo (inverseTransformDirection)
    let nsh = u32(g.pad0.x);
    if (nsh > 0u) {
        let wp = o.model * p;
        let nv = mat3x3<f32>(o.n0.xyz, o.n1.xyz, o.n2.xyz) * nrm * flip;
        let swn = normalize((vec4<f32>(nv, 0.0) * g.view).xyz);
        var sc = array<vec4<f32>, 4>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
        for (var i = 0u; i < min(nsh, 4u); i = i + 1u) {
            sc[i] = shadows[i].mat * (wp + vec4<f32>(swn * shadows[i].p0.y, 0.0));
        }
        out.sc0 = sc[0];
        out.sc1 = sc[1];
        out.sc2 = sc[2];
        out.sc3 = sc[3];
    }
    // color_vertex: color de vertice (si el material lo pide) por color de instancia
    out.color = select(vec3<f32>(1.0), color, materials[d.z].misc.w > 0.5) * icol;
    return out;
}

// ---- pasada de sombras: solo profundidad desde la camara de la luz (MeshDepthMaterial) ----
struct SOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) di: u32,
};

@vertex
fn vs_shadow(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @location(4) si: vec4<u32>, @location(5) sw: vec4<f32>, @builtin(instance_index) ii: u32) -> SOut {
    let di = ii >> 16u;
    let k = ii & 0xFFFFu;
    let d = draws[di * 3u];
    let d1 = draws[di * 3u + 1u];
    let d2 = draws[di * 3u + 2u];
    let o = objects[d.y];
    var p = vec4<f32>(position, 1.0);
    if (d2.w != 0u) {
        p = skin_pos(d2.w, si, sw, p);
    }
    if (d1.w != 0xFFFFFFFFu) {
        p = inst_mats[d1.w + k] * p;
    }
    var clip = shadows[d2.z].vp * (o.model * p);
    clip.z = (clip.z + clip.w) * 0.5;
    var out: SOut;
    out.pos = clip;
    out.uv = uv;
    out.di = di;
    return out;
}

// alphatest_fragment de la pasada de sombras: el alfa del mapa (la profundidad no usa la opacidad del material)
@fragment
fn fs_shadow(in: SOut) {
    let d = draws[in.di * 3u];
    let m = materials[d.z];
    let a = textureSample(tex_map, smp_map, uvT(m, 0u, in.uv)).a;
    if (a < m.tp.x) {
        discard;
    }
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


// ---- common.glsl / bsdfs.glsl ----
const RECIPROCAL_PI = 0.3183098861837907;
const EPSILON = 1e-6;

fn pow2(x: f32) -> f32 { return x * x; }
fn pow4(x: f32) -> f32 { let x2 = x * x; return x2 * x2; }

// lights_pars_begin: getDistanceAttenuation
fn getDistanceAttenuation(lightDistance: f32, cutoffDistance: f32, decayExponent: f32) -> f32 {
    var distanceFalloff = 1.0 / max(pow(lightDistance, decayExponent), 0.01);
    if (cutoffDistance > 0.0) {
        distanceFalloff *= pow2(saturate(1.0 - pow4(lightDistance / cutoffDistance)));
    }
    return distanceFalloff;
}

fn F_Schlick(f0: vec3<f32>, f90: f32, dotVH: f32) -> vec3<f32> {
    let fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + (f90 * fresnel);
}

fn V_GGX_SmithCorrelated(alpha: f32, dotNL: f32, dotNV: f32) -> f32 {
    let a2 = pow2(alpha);
    let gv = dotNL * sqrt(a2 + (1.0 - a2) * pow2(dotNV));
    let gl = dotNV * sqrt(a2 + (1.0 - a2) * pow2(dotNL));
    return 0.5 / max(gv + gl, EPSILON);
}

fn D_GGX(alpha: f32, dotNH: f32) -> f32 {
    let a2 = pow2(alpha);
    let denom = pow2(dotNH) * (a2 - 1.0) + 1.0;
    return RECIPROCAL_PI * a2 / pow2(denom);
}

struct PhysMat {
    diffuseColor: vec3<f32>,
    roughness: f32,
    specularColor: vec3<f32>,
    specularF90: f32,
};

// ---- RectAreaLight: tablas LTC (lights_physical_pars_fragment), muestreadas con bilinear a mano (Rgba32Float no filtrable) ----
// el lightmap del parche de luz de lightmap.ts (se sube con set_lightmap): textura de luz (rgb, a = oclusion) y de tubos que parpadean
@group(0) @binding(11) var lm0: texture_2d<f32>;
@group(0) @binding(12) var lm1: texture_2d<f32>;
@group(0) @binding(13) var lm_smp: sampler;
@group(0) @binding(7) var ltc_1: texture_2d<f32>;
@group(0) @binding(8) var ltc_2: texture_2d<f32>;
@group(0) @binding(9) var<storage, read> shadows: array<Shadow>;
@group(0) @binding(10) var shadow_map: texture_depth_2d_array;

fn ltcSample(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
    let p = uv * 64.0 - 0.5;
    let f = fract(p);
    let i = vec2<i32>(floor(p));
    let a = textureLoad(t, clamp(i, vec2<i32>(0), vec2<i32>(63)), 0);
    let b = textureLoad(t, clamp(i + vec2<i32>(1, 0), vec2<i32>(0), vec2<i32>(63)), 0);
    let c = textureLoad(t, clamp(i + vec2<i32>(0, 1), vec2<i32>(0), vec2<i32>(63)), 0);
    let d = textureLoad(t, clamp(i + vec2<i32>(1, 1), vec2<i32>(0), vec2<i32>(63)), 0);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn LTC_Uv(N: vec3<f32>, V: vec3<f32>, roughness: f32) -> vec2<f32> {
    let LUT_SIZE = 64.0;
    let LUT_SCALE = (LUT_SIZE - 1.0) / LUT_SIZE;
    let LUT_BIAS = 0.5 / LUT_SIZE;
    let dotNV = saturate(dot(N, V));
    return vec2<f32>(roughness, sqrt(1.0 - dotNV)) * LUT_SCALE + LUT_BIAS;
}

fn LTC_ClippedSphereFormFactor(f: vec3<f32>) -> f32 {
    let l = length(f);
    return max((l * l + f.z) / (l + 1.0), 0.0);
}

fn LTC_EdgeVectorFormFactor(v1: vec3<f32>, v2: vec3<f32>) -> vec3<f32> {
    let x = dot(v1, v2);
    let y = abs(x);
    let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
    let b = 3.4175940 + (4.1616724 + y) * y;
    let v = a / b;
    let theta_sintheta = select(0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - v, v, x > 0.0);
    return cross(v1, v2) * theta_sintheta;
}

fn LTC_Evaluate(N: vec3<f32>, V: vec3<f32>, P: vec3<f32>, mInv: mat3x3<f32>, r0: vec3<f32>, r1: vec3<f32>, r2: vec3<f32>, r3: vec3<f32>) -> vec3<f32> {
    let v1 = r1 - r0;
    let v2 = r3 - r0;
    let lightNormal = cross(v1, v2);
    if (dot(lightNormal, P - r0) < 0.0) { return vec3<f32>(0.0); }
    let T1 = normalize(V - N * dot(V, N));
    let T2 = -cross(N, T1);
    let mt = mInv * transpose(mat3x3<f32>(T1, T2, N));
    let c0 = normalize(mt * (r0 - P));
    let c1 = normalize(mt * (r1 - P));
    let c2 = normalize(mt * (r2 - P));
    let c3 = normalize(mt * (r3 - P));
    var vff = vec3<f32>(0.0);
    vff += LTC_EdgeVectorFormFactor(c0, c1);
    vff += LTC_EdgeVectorFormFactor(c1, c2);
    vff += LTC_EdgeVectorFormFactor(c2, c3);
    vff += LTC_EdgeVectorFormFactor(c3, c0);
    return vec3<f32>(LTC_ClippedSphereFormFactor(vff));
}

// ---- shadowmap_pars_fragment: texture2DCompare y getShadow (Basic, PCF y PCFSoft; el mapa de GL tiene la v hacia arriba y el de WebGPU hacia abajo) ----
fn texture2DCompare(layer: i32, size: vec2<f32>, uv: vec2<f32>, compare: f32) -> f32 {
    let isz = vec2<i32>(size);
    let c = clamp(vec2<i32>(floor(uv * size)), vec2<i32>(0), isz - vec2<i32>(1));
    return step(compare, textureLoad(shadow_map, vec2<i32>(c.x, isz.y - 1 - c.y), layer, 0));
}

fn getShadow(layer: i32, shadowCoordIn: vec4<f32>) -> f32 {
    let sh = shadows[layer];
    let shadowMapSize = vec2<f32>(sh.p0.w, sh.p1.x);
    var shadow = 1.0;
    var shadowCoord = shadowCoordIn;
    shadowCoord = vec4<f32>(shadowCoord.xyz / shadowCoord.w, shadowCoord.w);
    shadowCoord.z += sh.p0.x;
    let inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
    let frustumTest = inFrustum && shadowCoord.z <= 1.0;
    if (frustumTest) {
        let z = shadowCoord.z;
        let texelSize = vec2<f32>(1.0) / shadowMapSize;
        let st = g.pad0.y;
        if (st > 1.5) {
            // PCFSoftShadowMap
            let dx = texelSize.x;
            let dy = texelSize.y;
            var uv = shadowCoord.xy;
            let f = fract(uv * shadowMapSize + 0.5);
            uv -= f * texelSize;
            shadow = (
                texture2DCompare(layer, shadowMapSize, uv, z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx, 0.0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, dy), z) +
                texture2DCompare(layer, shadowMapSize, uv + texelSize, z) +
                mix(texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(-dx, 0.0), z), texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(2.0 * dx, 0.0), z), f.x) +
                mix(texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(-dx, dy), z), texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(2.0 * dx, dy), z), f.x) +
                mix(texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, -dy), z), texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, 2.0 * dy), z), f.y) +
                mix(texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx, -dy), z), texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx, 2.0 * dy), z), f.y) +
                mix(mix(texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(-dx, -dy), z), texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(2.0 * dx, -dy), z), f.x),
                    mix(texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(-dx, 2.0 * dy), z), texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(2.0 * dx, 2.0 * dy), z), f.x), f.y)
            ) * (1.0 / 9.0);
        } else if (st > 0.5) {
            // PCFShadowMap
            let r = sh.p0.z;
            let dx0 = -texelSize.x * r;
            let dy0 = -texelSize.y * r;
            let dx1 = texelSize.x * r;
            let dy1 = texelSize.y * r;
            let dx2 = dx0 / 2.0;
            let dy2 = dy0 / 2.0;
            let dx3 = dx1 / 2.0;
            let dy3 = dy1 / 2.0;
            let uv = shadowCoord.xy;
            shadow = (
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx0, dy0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, dy0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx1, dy0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx2, dy2), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, dy2), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx3, dy2), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx0, 0.0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx2, 0.0), z) +
                texture2DCompare(layer, shadowMapSize, uv, z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx3, 0.0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx1, 0.0), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx2, dy3), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, dy3), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx3, dy3), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx0, dy1), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(0.0, dy1), z) +
                texture2DCompare(layer, shadowMapSize, uv + vec2<f32>(dx1, dy1), z)
            ) * (1.0 / 17.0);
        } else {
            shadow = texture2DCompare(layer, shadowMapSize, shadowCoord.xy, z);
        }
    }
    return shadow;
}

// BRDF_GGX
fn BRDF_GGX(lightDir: vec3<f32>, viewDir: vec3<f32>, normal: vec3<f32>, material: PhysMat) -> vec3<f32> {
    let f0 = material.specularColor;
    let f90 = material.specularF90;
    let alpha = pow2(material.roughness);
    let halfDir = normalize(lightDir + viewDir);
    let dotNL = saturate(dot(normal, lightDir));
    let dotNV = saturate(dot(normal, viewDir));
    let dotNH = saturate(dot(normal, halfDir));
    let dotVH = saturate(dot(viewDir, halfDir));
    let F = F_Schlick(f0, f90, dotVH);
    let V = V_GGX_SmithCorrelated(alpha, dotNL, dotNV);
    let D = D_GGX(alpha, dotNH);
    return F * (V * D);
}

fn BRDF_Lambert(diffuseColor: vec3<f32>) -> vec3<f32> {
    return RECIPROCAL_PI * diffuseColor;
}

@fragment
fn fs(in: VOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
    let dr = draws[in.di * 3u];
    let m = materials[dr.z];
    // derivadas antes de cualquier rama (control uniforme)
    let nUn = normalize(in.vnormal);
    let ddx = dpdx(nUn);
    let ddy = dpdy(nUn);
    // texturas: todas se muestrean sin ramas (control uniforme); la mascara decide cuales cuentan
    let maps = u32(m.maps.x);
    let sMap = textureSample(tex_map, smp_map, uvT(m, 0u, in.uv));
    let sRough = textureSample(tex_rough, smp_rough, uvT(m, 2u, in.uv));
    let sEmis = textureSample(tex_emis, smp_emis, uvT(m, 3u, in.uv));
    // normal_fragment_maps / bumpmap_pars_fragment / normalmap_pars_fragment: derivadas y muestras fuera de cualquier rama
    let backSgn = select(1.0, -1.0, (dr.w & 32u) != 0u);   // three niega normalScale y bumpScale con BackSide
    let uvN = uvT(m, 1u, in.uv);
    let uvB = uvT(m, 4u, in.uv);
    let q0 = dpdx(in.vpos);
    // WebGPU tiene la y de pantalla hacia abajo y GL hacia arriba: dFdy de GLSL = -dpdy
    // (en un render target la y ya va hacia arriba)
    let gy = select(-1.0, 1.0, g.pad0.z > 0.5);
    let q1 = gy * dpdy(in.vpos);
    let stN0 = dpdx(uvN);
    let stN1 = gy * dpdy(uvN);
    let dSTdx = dpdx(uvB);
    let dSTdy = gy * dpdy(uvB);
    let sNormal = textureSample(tex_normal, smp_normal, uvN);
    let bumpScale = m.tp.w * backSgn;
    let Hll = bumpScale * textureSample(tex_bump, smp_bump, uvB).x;
    let dBx = bumpScale * textureSample(tex_bump, smp_bump, uvB + dSTdx).x - Hll;
    let dBy = bumpScale * textureSample(tex_bump, smp_bump, uvB + dSTdy).x - Hll;
    // parche de material (0 = ninguno): sus uniformes (hasta dos vec4) viven en la plaza `m.pad.y` de `materials`
    let pid = u32(m.pad.x);
    var pe0 = vec4<f32>(0.0);
    var pe1 = vec4<f32>(0.0);
    if (pid != 0u) {
        let ex = materials[u32(m.pad.y)];
        pe0 = ex.color;
        pe1 = ex.emissive;
    }
    let wp = in.wpos;
    // map_fragment: diffuseColor *= sampledDiffuseColor; color_fragment: diffuseColor.rgb *= vColor
    var diffuse = m.color.rgb;
    var diffuseA = m.color.a;
    if ((maps & 1u) != 0u) {
        diffuse = diffuse * sMap.rgb;
        diffuseA = diffuseA * sMap.a;
    }
    // cos-tint (tras map_fragment): la luminosidad de la textura pintada con el color elegido
    if (pid == 1u) {
        let l = dot(diffuse, vec3<f32>(0.299, 0.587, 0.114));
        diffuse = mix(diffuse, pe0.rgb * l * 1.3, pe0.w);
    }
    diffuse = diffuse * in.color;
    // poolTile (tras color_fragment): cada baldosa un poco distinta, manchas anchas y suciedad pegada al suelo
    if (pid == 4u) {
        let t = h31(floor(wp / 0.12 + 0.01));
        let b = vn(wp * 0.35);
        let s = vn(wp * 1.7 + 9.0);
        diffuse = diffuse * ((0.93 + 0.1 * t) * (0.86 + 0.28 * b)) * vec3<f32>(1.0 + 0.05 * (b - 0.5), 1.0, 1.0 - 0.06 * (b - 0.5));
        diffuse = diffuse * (1.0 - 0.28 * sstep(0.55, 0.9, s) * (0.4 + 0.6 * sstep(1.2, -0.2, wp.y)));
    }
    // alphatest_fragment
    if (m.tp.x > 0.0 && diffuseA < m.tp.x) {
        discard;
    }
    var rgb = diffuse;   // MeshBasicMaterial: outgoingLight = diffuse

    if (m.misc.y > 1.5) {
        // ---- MeshNormalMaterial: normal_fragment_begin + packNormalToRGB ----
        var normal = nUn;
        if ((dr.w & 64u) != 0u) {
            normal = normal * select(-1.0, 1.0, frontFacing);
        }
        // meshnormal_frag no incluye tone mapping, codificacion de color ni niebla
        return vec4<f32>(normal * 0.5 + 0.5, select(1.0, diffuseA, (dr.w & 4u) != 0u));
    } else if (m.misc.y > 0.5) {
        // ---- MeshStandardMaterial: meshphysical.glsl.js sin sheen, clearcoat, iridiscencia ni transmision ----
        // normal_fragment_begin + normal_fragment_maps
        let faceDirection = select(-1.0, 1.0, frontFacing);
        var normal = nUn;
        let doubleSided = (dr.w & 64u) != 0u;
        if (doubleSided) {
            normal = normal * faceDirection;
        }
        if ((maps & 2u) != 0u) {
            // normalmap_pars_fragment: getTangentFrame (sin tangentes precalculadas) y espacio tangente
            let N = normal;
            let q1perp = cross(q1, N);
            let q0perp = cross(N, q0);
            let T = q1perp * stN0.x + q0perp * stN1.x;
            let B = q1perp * stN0.y + q0perp * stN1.y;
            let det = max(dot(T, T), dot(B, B));
            let tscale = select(inverseSqrt(det), 0.0, det == 0.0);
            var tT = T * tscale;
            var tB = B * tscale;
            if (doubleSided) {
                tT = tT * faceDirection;
                tB = tB * faceDirection;
            }
            var mapN = sNormal.xyz * 2.0 - 1.0;
            mapN = vec3<f32>(mapN.xy * (m.tp.yz * backSgn), mapN.z);
            normal = normalize(tT * mapN.x + tB * mapN.y + N * mapN.z);
        } else if ((maps & 16u) != 0u) {
            // perturbNormalArb (Mikkelsen)
            let vSigmaX = normalize(q0);
            let vSigmaY = normalize(q1);
            let vN = normal;
            let R1 = cross(vSigmaY, vN);
            let R2 = cross(vN, vSigmaX);
            let fDet = dot(vSigmaX, R1) * faceDirection;
            let vGrad = sign(fDet) * (dBx * R1 + dBy * R2);
            normal = normalize(abs(fDet) * vN - vGrad);
        }
        let metalnessFactor = m.misc.x * select(1.0, sRough.b, (maps & 32u) != 0u);   // metalnessMap comparte textura con roughnessMap (glTF)
        var roughnessFactor = m.emissive.a * select(1.0, sRough.g, (maps & 4u) != 0u);
        if (pid == 3u) {
            roughnessFactor = max(roughnessFactor, 0.85);   // parking: el hormigon nunca brilla
        }
        var material: PhysMat;
        material.diffuseColor = diffuse * (1.0 - metalnessFactor);
        let dxy = max(abs(ddx), abs(ddy));
        let geometryRoughness = max(max(dxy.x, dxy.y), dxy.z);
        material.roughness = max(roughnessFactor, 0.0525);
        material.roughness += geometryRoughness;
        material.roughness = min(material.roughness, 1.0);
        if (pid == 4u) {
            // poolTile: solo los suelos (cara hacia arriba) conservan su brillo; el resto, rugosidad >= 0.6
            let fl = sstep(0.6, 0.9, in.wnrm.y);
            material.roughness = mix(max(material.roughness, 0.6), material.roughness, fl);
        }
        material.specularColor = mix(vec3<f32>(0.04), diffuse, metalnessFactor);
        material.specularF90 = 1.0;

        // lights_fragment_begin
        let geometryPosition = in.vpos;
        // isOrthographic (g.dim.w): la direccion de vista es fija
        let geometryViewDir = select(normalize(-in.vpos), vec3<f32>(0.0, 0.0, 1.0), g.dim.w > 0.5);
        var directDiffuse = vec3<f32>(0.0);
        var directSpecular = vec3<f32>(0.0);
        var hemiIrradiance = vec3<f32>(0.0);
        let nl = u32(g.dim.z);
        for (var i = 0u; i < nl; i = i + 1u) {
            let l = lights[i];
            var dirL: vec3<f32>;
            var col = l.a.yzw;
            if (l.a.x > 3.5) {
                // RE_Direct_RectArea_Physical
                let lightPos = l.b.xyz;
                let halfWidth = l.c.yzw;
                let halfHeight = l.d.xyz;
                let r0 = lightPos + halfWidth - halfHeight;
                let r1 = lightPos - halfWidth - halfHeight;
                let r2 = lightPos - halfWidth + halfHeight;
                let r3 = lightPos + halfWidth + halfHeight;
                let uvL = LTC_Uv(normal, geometryViewDir, material.roughness);
                let t1 = ltcSample(ltc_1, uvL);
                let t2 = ltcSample(ltc_2, uvL);
                let mInv = mat3x3<f32>(vec3<f32>(t1.x, 0.0, t1.y), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(t1.z, 0.0, t1.w));
                let fresnel = material.specularColor * t2.x + (vec3<f32>(1.0) - material.specularColor) * t2.y;
                directSpecular += l.a.yzw * fresnel * LTC_Evaluate(normal, geometryViewDir, geometryPosition, mInv, r0, r1, r2, r3);
                directDiffuse += l.a.yzw * material.diffuseColor * LTC_Evaluate(normal, geometryViewDir, geometryPosition, mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)), r0, r1, r2, r3);
                continue;
            }
            if (l.a.x > 1.5 && l.a.x < 2.5) {
                // getHemisphereLightIrradiance (geometryNormal = normal tras los mapas)
                let hemiW = 0.5 * dot(normal, l.c.yzw) + 0.5;
                hemiIrradiance += mix(l.b.xyz, l.a.yzw, hemiW);
                continue;
            }
            if (l.a.x > 0.5) {
                // getPointLightInfo / getSpotLightInfo
                let lVector = l.b.xyz - geometryPosition;
                dirL = normalize(lVector);
                let lightDistance = length(lVector);
                col = col * getDistanceAttenuation(lightDistance, l.b.w, l.c.x);
                if (l.a.x > 2.5) {
                    col = col * smoothstep(l.d.x, l.d.y, dot(dirL, l.c.yzw));
                }
            } else {
                // getDirectionalLightInfo
                dirL = l.c.yzw;
                if (pid == 4u) {
                    col = col * sstep(0.5, 0.8, in.wnrm.y);   // poolTile: el sol solo calienta lo que mira hacia arriba
                }
            }
            // lights_fragment_begin: directLight.color *= receiveShadow ? getShadow(...) : 1.0 (d.z = capa de sombra + 1)
            let sl = i32(l.d.z) - 1;
            if (sl >= 0 && (dr.w & 256u) != 0u && any(col != vec3<f32>(0.0))) {
                var scs = array<vec4<f32>, 4>(in.sc0, in.sc1, in.sc2, in.sc3);
                col = col * getShadow(sl, scs[sl]);
            }
            if (any(col != vec3<f32>(0.0))) {
                // RE_Direct_Physical
                let dotNL = saturate(dot(normal, dirL));
                let irradiance = dotNL * col;
                directSpecular += irradiance * BRDF_GGX(dirL, geometryViewDir, normal, material);
                directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
            }
        }
        // RE_IndirectDiffuse_Physical con la luz ambiente
        let indirectDiffuse = (g.amb.rgb + hemiIrradiance) * BRDF_Lambert(material.diffuseColor);
        let totalDiffuse = directDiffuse + indirectDiffuse;
        let emissive = m.emissive.rgb * select(vec3<f32>(1.0), sEmis.rgb, (maps & 8u) != 0u);
        rgb = totalDiffuse + directSpecular + emissive;
    }

    // lightmap.ts (antes de opaque_fragment): la luz horneada del mapa. pe0 = uFlick; pe1 = (uLmSize.xy, uLmGain, _)
    if (pid == 2u) {
        let n = normalize(in.wnrm);
        let lmUv = (wp.xz + n.xz * 0.45) / pe1.xy;
        let lmA = textureSampleLevel(lm0, lm_smp, lmUv, 0.0);
        let lmB = textureSampleLevel(lm1, lm_smp, lmUv, 0.0);
        let lmRgb = lmA.rgb + vec3<f32>(1.0, 0.93, 0.74) * dot(lmB, pe0);
        let side = 1.0 - abs(n.y);
        let grad = mix(1.0, 0.5 + 0.5 * sstep(-0.1, 0.8, wp.y), side) * mix(1.0, 0.82, side * sstep(2.1, 2.7, wp.y));
        let up = select(1.0, 0.42, n.y < -0.5);
        rgb = rgb * lmA.a * grad + diffuse * lmRgb * 1.5 * lmA.a * grad * up * pe1.z;
    }
    // tonemapping_fragment
    if (g.p0.x > 0.5) {
        rgb = ACESFilmicToneMapping(rgb);
    }
    // colorspace_fragment (salida sRGB; con salida lineal, a un render target, no se codifica)
    if (g.pad0.z < 0.5) {
        rgb = sRGBTransferOETF(rgb);
    }
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
    // opaque_fragment: los materiales opacos escriben alfa 1
    let outA = select(1.0, diffuseA, (dr.w & 4u) != 0u);
    return vec4<f32>(rgb, outA);
}
