// Pases de pantalla completa (postproceso). Cada fragment portado linea a linea del GLSL de three 0.160.1
// (examples/jsm/shaders/*.js). Convencion de three/WebGL: vUv con v hacia arriba y textura con la fila 0 abajo.

// uniformes empaquetados por pass.ts (cada shader define su orden)
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 64>;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(3) var t2: texture_2d<f32>;
@group(0) @binding(4) var t3: texture_2d<f32>;
@group(0) @binding(5) var t4: texture_2d<f32>;
// profundidad u otra textura sin filtrado: se lee con textureLoad
@group(0) @binding(6) var td: texture_2d<f32>;
@group(0) @binding(7) var sl: sampler; // lineal, clamp
@group(0) @binding(8) var sn: sampler; // nearest, clamp

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vuv: vec2<f32>,
};

// el mismo triangulo que FullscreenTriangleGeometry de three
fn tri(i: u32) -> VOut {
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, 3.0), vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0));
    var uv = array<vec2<f32>, 3>(vec2<f32>(0.0, 2.0), vec2<f32>(0.0, 0.0), vec2<f32>(2.0, 0.0));
    var o: VOut;
    o.pos = vec4<f32>(p[i], 0.0, 1.0);
    o.vuv = uv[i];
    return o;
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    return tri(i);
}

// a un render target la imagen se guarda con la fila 0 abajo: y de clip invertida
@vertex
fn vs_flip(@builtin(vertex_index) i: u32) -> VOut {
    var o = tri(i);
    o.pos.y = -o.pos.y;
    return o;
}

// ---- CopyShader ----  u[0].x = opacity
@fragment
fn fs_copy(in: VOut) -> @location(0) vec4<f32> {
    let texel = textureSample(t0, sl, in.vuv);
    return u[0].x * texel;
}

// ---- tonemapping_pars_fragment y colorspace_pars_fragment (para OutputShader) ----
const ACESInputMat = mat3x3<f32>(vec3<f32>(0.59719, 0.07600, 0.02840), vec3<f32>(0.35458, 0.90834, 0.13383), vec3<f32>(0.04823, 0.01566, 0.83777));
const ACESOutputMat = mat3x3<f32>(vec3<f32>(1.60475, -0.10208, -0.00327), vec3<f32>(-0.53108, 1.10813, -0.07276), vec3<f32>(-0.07367, -0.00605, 1.07602));

fn RRTAndODTFit(v: vec3<f32>) -> vec3<f32> {
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}

fn ACESFilmicToneMapping(c: vec3<f32>, exposure: f32) -> vec3<f32> {
    var color = c * (exposure / 0.6);
    color = ACESInputMat * color;
    color = RRTAndODTFit(color);
    color = ACESOutputMat * color;
    return saturate(color);
}

fn LinearToneMapping(c: vec3<f32>, exposure: f32) -> vec3<f32> {
    return saturate(exposure * c);
}

fn ReinhardToneMapping(c: vec3<f32>, exposure: f32) -> vec3<f32> {
    let color = c * exposure;
    return saturate(color / (vec3<f32>(1.0) + color));
}

fn OptimizedCineonToneMapping(c: vec3<f32>, exposure: f32) -> vec3<f32> {
    var color = c * exposure;
    color = max(vec3<f32>(0.0), color - 0.004);
    return pow((color * (6.2 * color + 0.5)) / (color * (6.2 * color + 1.7) + 0.06), vec3<f32>(2.2));
}

fn sRGBTransferOETF(v: vec3<f32>) -> vec3<f32> {
    return select(pow(v, vec3<f32>(0.41666)) * 1.055 - vec3<f32>(0.055), v * 12.92, v <= vec3<f32>(0.0031308));
}

// ---- OutputShader ----  u[0] = (toneMappingExposure, modo: 0 ninguno 1 Linear 2 Reinhard 3 Cineon 4 ACES, SRGB_TRANSFER, 0)
@fragment
fn fs_output(in: VOut) -> @location(0) vec4<f32> {
    var c = textureSample(t0, sl, in.vuv);
    let e = u[0].x;
    let mode = u32(u[0].y);
    if (mode == 1u) {
        c = vec4<f32>(LinearToneMapping(c.rgb, e), c.a);
    } else if (mode == 2u) {
        c = vec4<f32>(ReinhardToneMapping(c.rgb, e), c.a);
    } else if (mode == 3u) {
        c = vec4<f32>(OptimizedCineonToneMapping(c.rgb, e), c.a);
    } else if (mode == 4u) {
        c = vec4<f32>(ACESFilmicToneMapping(c.rgb, e), c.a);
    }
    if (u[0].z > 0.5) {
        c = vec4<f32>(sRGBTransferOETF(c.rgb), c.a);
    }
    return c;
}

// ---- LuminosityHighPassShader ----  u[0] = (luminosityThreshold, smoothWidth, defaultOpacity, 0), u[1].rgb = defaultColor
@fragment
fn fs_lum(in: VOut) -> @location(0) vec4<f32> {
    let texel = textureSample(t0, sl, in.vuv);
    let luma = vec3<f32>(0.299, 0.587, 0.114);
    let v = dot(texel.xyz, luma);
    let outputColor = vec4<f32>(u[1].rgb, u[0].z);
    let alpha = smoothstep(u[0].x, u[0].x + u[0].y, v);
    return mix(outputColor, texel, alpha);
}

// ---- UnrealBloomPass: blur gaussiano separable ----
// u[0] = (invSize.x, invSize.y, direction.x, direction.y), u[1].x = KERNEL_RADIUS, u[2..4] = gaussianCoefficients[0..11]
fn coef(i: u32) -> f32 {
    return u[2u + i / 4u][i % 4u];
}

@fragment
fn fs_blur(in: VOut) -> @location(0) vec4<f32> {
    let invSize = u[0].xy;
    let direction = u[0].zw;
    let kr = i32(u[1].x);
    var weightSum = coef(0u);
    var diffuseSum = textureSampleLevel(t0, sl, in.vuv, 0.0).rgb * weightSum;
    for (var i = 1; i < kr; i = i + 1) {
        let x = f32(i);
        let w = coef(u32(i));
        let uvOffset = direction * invSize * x;
        let sample1 = textureSampleLevel(t0, sl, in.vuv + uvOffset, 0.0).rgb;
        let sample2 = textureSampleLevel(t0, sl, in.vuv - uvOffset, 0.0).rgb;
        diffuseSum = diffuseSum + (sample1 + sample2) * w;
        weightSum = weightSum + 2.0 * w;
    }
    return vec4<f32>(diffuseSum / weightSum, 1.0);
}

// ---- UnrealBloomPass: composicion de los mips ----
// u[0] = (bloomStrength, bloomRadius, 0, 0), u[1..2] = bloomFactors[0..4], u[3..7].rgb = bloomTintColors[0..4]
fn lerpBloomFactor(factor: f32) -> f32 {
    let mirrorFactor = 1.2 - factor;
    return mix(factor, mirrorFactor, u[0].y);
}

fn bloomFactor(i: u32) -> f32 {
    return u[1u + i / 4u][i % 4u];
}

@fragment
fn fs_bloom(in: VOut) -> @location(0) vec4<f32> {
    return u[0].x * (lerpBloomFactor(bloomFactor(0u)) * vec4<f32>(u[3].rgb, 1.0) * textureSample(t0, sl, in.vuv) +
        lerpBloomFactor(bloomFactor(1u)) * vec4<f32>(u[4].rgb, 1.0) * textureSample(t1, sl, in.vuv) +
        lerpBloomFactor(bloomFactor(2u)) * vec4<f32>(u[5].rgb, 1.0) * textureSample(t2, sl, in.vuv) +
        lerpBloomFactor(bloomFactor(3u)) * vec4<f32>(u[6].rgb, 1.0) * textureSample(t3, sl, in.vuv) +
        lerpBloomFactor(bloomFactor(4u)) * vec4<f32>(u[7].rgb, 1.0) * textureSample(t4, sl, in.vuv));
}
