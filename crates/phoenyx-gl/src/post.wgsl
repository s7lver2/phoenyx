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

// ---- SMAAShader (three/examples/jsm/shaders/SMAAShader.js) ----
// Los offsets que el GLSL calcula en el vertex shader (vOffset, vPixcoord) se calculan aqui con la misma aritmetica.
// u[0] = (resolution.x, resolution.y, SMAA_THRESHOLD, 0). Busca con muestreo en nivel 0 (como texture2D(.., 0.0) sin mipmaps).

fn smaaMaxRgb(t: vec3<f32>) -> f32 {
    return max(max(t.r, t.g), t.b);
}

@fragment
fn fs_smaa_edges(in: VOut) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let texcoord = in.vuv;
    let offset0 = texcoord.xyxy + resolution.xyxy * vec4<f32>(-1.0, 0.0, 0.0, 1.0);
    let offset1 = texcoord.xyxy + resolution.xyxy * vec4<f32>(1.0, 0.0, 0.0, -1.0);
    let offset2 = texcoord.xyxy + resolution.xyxy * vec4<f32>(-2.0, 0.0, 0.0, 2.0);
    let threshold = vec2<f32>(u[0].z, u[0].z);
    var delta: vec4<f32>;
    let C = textureSampleLevel(t0, sl, texcoord, 0.0).rgb;
    let Cleft = textureSampleLevel(t0, sl, offset0.xy, 0.0).rgb;
    var t = abs(C - Cleft);
    delta.x = smaaMaxRgb(t);
    let Ctop = textureSampleLevel(t0, sl, offset0.zw, 0.0).rgb;
    t = abs(C - Ctop);
    delta.y = smaaMaxRgb(t);
    var edges = step(threshold, delta.xy);
    if (dot(edges, vec2<f32>(1.0, 1.0)) == 0.0) {
        discard;
    }
    let Cright = textureSampleLevel(t0, sl, offset1.xy, 0.0).rgb;
    t = abs(C - Cright);
    delta.z = smaaMaxRgb(t);
    let Cbottom = textureSampleLevel(t0, sl, offset1.zw, 0.0).rgb;
    t = abs(C - Cbottom);
    delta.w = smaaMaxRgb(t);
    var maxDelta = max(max(max(delta.x, delta.y), delta.z), delta.w);
    let Cleftleft = textureSampleLevel(t0, sl, offset2.xy, 0.0).rgb;
    t = abs(C - Cleftleft);
    delta.z = smaaMaxRgb(t);
    let Ctoptop = textureSampleLevel(t0, sl, offset2.zw, 0.0).rgb;
    t = abs(C - Ctoptop);
    delta.w = smaaMaxRgb(t);
    maxDelta = max(max(maxDelta, delta.z), delta.w);
    edges = edges * step(vec2<f32>(0.5 * maxDelta), delta.xy);
    return vec4<f32>(edges, 0.0, 0.0);
}

// pesos: t0 = bordes (lineal), t1 = area (lineal), t2 = busqueda (nearest)
const SMAA_MAX_SEARCH_STEPS = 8;

fn smaaRound(x: vec2<f32>) -> vec2<f32> {
    return sign(x) * floor(abs(x) + 0.5);
}

fn SMAASearchLength(e_in: vec2<f32>, bias: f32, scale: f32) -> f32 {
    var e = e_in;
    e.x = bias + e.x * scale;
    return 255.0 * textureSampleLevel(t2, sn, e, 0.0).r;
}

fn SMAASearchXLeft(tc: vec2<f32>, end: f32, resolution: vec2<f32>) -> f32 {
    var texcoord = tc;
    var e = vec2<f32>(0.0, 1.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        e = textureSampleLevel(t0, sl, texcoord, 0.0).rg;
        texcoord = texcoord - vec2<f32>(2.0, 0.0) * resolution;
        if (!(texcoord.x > end && e.g > 0.8281 && e.r == 0.0)) {
            break;
        }
    }
    texcoord.x = texcoord.x + 0.25 * resolution.x;
    texcoord.x = texcoord.x + resolution.x;
    texcoord.x = texcoord.x + 2.0 * resolution.x;
    texcoord.x = texcoord.x - resolution.x * SMAASearchLength(e, 0.0, 0.5);
    return texcoord.x;
}

fn SMAASearchXRight(tc: vec2<f32>, end: f32, resolution: vec2<f32>) -> f32 {
    var texcoord = tc;
    var e = vec2<f32>(0.0, 1.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        e = textureSampleLevel(t0, sl, texcoord, 0.0).rg;
        texcoord = texcoord + vec2<f32>(2.0, 0.0) * resolution;
        if (!(texcoord.x < end && e.g > 0.8281 && e.r == 0.0)) {
            break;
        }
    }
    texcoord.x = texcoord.x - 0.25 * resolution.x;
    texcoord.x = texcoord.x - resolution.x;
    texcoord.x = texcoord.x - 2.0 * resolution.x;
    texcoord.x = texcoord.x + resolution.x * SMAASearchLength(e, 0.5, 0.5);
    return texcoord.x;
}

fn SMAASearchYUp(tc: vec2<f32>, end: f32, resolution: vec2<f32>) -> f32 {
    var texcoord = tc;
    var e = vec2<f32>(1.0, 0.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        e = textureSampleLevel(t0, sl, texcoord, 0.0).rg;
        texcoord = texcoord + vec2<f32>(0.0, 2.0) * resolution;
        if (!(texcoord.y > end && e.r > 0.8281 && e.g == 0.0)) {
            break;
        }
    }
    texcoord.y = texcoord.y - 0.25 * resolution.y;
    texcoord.y = texcoord.y - resolution.y;
    texcoord.y = texcoord.y - 2.0 * resolution.y;
    texcoord.y = texcoord.y + resolution.y * SMAASearchLength(e.yx, 0.0, 0.5);
    return texcoord.y;
}

fn SMAASearchYDown(tc: vec2<f32>, end: f32, resolution: vec2<f32>) -> f32 {
    var texcoord = tc;
    var e = vec2<f32>(1.0, 0.0);
    for (var i = 0; i < SMAA_MAX_SEARCH_STEPS; i = i + 1) {
        e = textureSampleLevel(t0, sl, texcoord, 0.0).rg;
        texcoord = texcoord - vec2<f32>(0.0, 2.0) * resolution;
        if (!(texcoord.y < end && e.r > 0.8281 && e.g == 0.0)) {
            break;
        }
    }
    texcoord.y = texcoord.y + 0.25 * resolution.y;
    texcoord.y = texcoord.y + resolution.y;
    texcoord.y = texcoord.y + 2.0 * resolution.y;
    texcoord.y = texcoord.y - resolution.y * SMAASearchLength(e.yx, 0.5, 0.5);
    return texcoord.y;
}

fn SMAAArea(dist: vec2<f32>, e1: f32, e2: f32, offset: f32) -> vec2<f32> {
    let pixelSize = 1.0 / vec2<f32>(160.0, 560.0);
    var texcoord = 16.0 * smaaRound(4.0 * vec2<f32>(e1, e2)) + dist;
    texcoord = pixelSize * texcoord + (0.5 * pixelSize);
    texcoord.y = texcoord.y + (1.0 / 7.0) * offset;
    return textureSampleLevel(t1, sl, texcoord, 0.0).rg;
}

@fragment
fn fs_smaa_weights(in: VOut) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    let texcoord = in.vuv;
    let pixcoord = texcoord / resolution;
    let offset0 = texcoord.xyxy + resolution.xyxy * vec4<f32>(-0.25, 0.125, 1.25, 0.125);
    let offset1 = texcoord.xyxy + resolution.xyxy * vec4<f32>(-0.125, 0.25, -0.125, -1.25);
    let offset2 = vec4<f32>(offset0.xz, offset1.yw) + vec4<f32>(-2.0, 2.0, -2.0, 2.0) * resolution.xxyy * f32(SMAA_MAX_SEARCH_STEPS);
    var weights = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    let e = textureSampleLevel(t0, sl, texcoord, 0.0).rg;
    if (e.g > 0.0) {
        var d: vec2<f32>;
        var coords: vec2<f32>;
        coords.x = SMAASearchXLeft(offset0.xy, offset2.x, resolution);
        coords.y = offset1.y;
        d.x = coords.x;
        let e1 = textureSampleLevel(t0, sl, coords, 0.0).r;
        coords.x = SMAASearchXRight(offset0.zw, offset2.y, resolution);
        d.y = coords.x;
        d = d / resolution.x - pixcoord.x;
        let sqrt_d = sqrt(abs(d));
        coords.y = coords.y - 1.0 * resolution.y;
        // el macro SMAASampleLevelZeroOffset de three hace float(ivec2(1, 0)): solo cuenta la primera componente, el desplazamiento es (1, 1) pixeles
        let e2 = textureSampleLevel(t0, sl, coords + 1.0 * resolution, 0.0).r;
        let a = SMAAArea(sqrt_d, e1, e2, 0.0);
        weights.r = a.x;
        weights.g = a.y;
    }
    if (e.r > 0.0) {
        var d: vec2<f32>;
        var coords: vec2<f32>;
        coords.y = SMAASearchYUp(offset1.xy, offset2.z, resolution);
        coords.x = offset0.x;
        d.x = coords.y;
        let e1 = textureSampleLevel(t0, sl, coords, 0.0).g;
        coords.y = SMAASearchYDown(offset1.zw, offset2.w, resolution);
        d.y = coords.y;
        d = d / resolution.y - pixcoord.y;
        let sqrt_d = sqrt(abs(d));
        coords.y = coords.y - 1.0 * resolution.y;
        // float(ivec2(0, 1)) = 0: sin desplazamiento
        let e2 = textureSampleLevel(t0, sl, coords + 0.0 * resolution, 0.0).g;
        let a = SMAAArea(sqrt_d, e1, e2, 0.0);
        weights.b = a.x;
        weights.a = a.y;
    }
    return weights;
}

// mezcla: t0 = pesos (lineal), t1 = color (lineal)
@fragment
fn fs_smaa_blend(in: VOut) -> @location(0) vec4<f32> {
    let resolution = u[0].xy;
    var texcoord = in.vuv;
    let offset1 = texcoord.xyxy + resolution.xyxy * vec4<f32>(1.0, 0.0, 0.0, -1.0);
    var a: vec4<f32>;
    let w0 = textureSample(t0, sl, texcoord);
    a.x = w0.x;
    a.z = w0.z;
    a.y = textureSample(t0, sl, offset1.zw).g;
    a.w = textureSample(t0, sl, offset1.xy).a;
    if (dot(a, vec4<f32>(1.0, 1.0, 1.0, 1.0)) < 1e-5) {
        return textureSampleLevel(t1, sl, texcoord, 0.0);
    } else {
        var offset: vec2<f32>;
        offset.x = select(-a.b, a.a, a.a > a.b);
        offset.y = select(a.r, -a.g, a.g > a.r);
        if (abs(offset.x) > abs(offset.y)) {
            offset.y = 0.0;
        } else {
            offset.x = 0.0;
        }
        var C = textureSampleLevel(t1, sl, texcoord, 0.0);
        texcoord = texcoord + sign(offset) * resolution;
        var Cop = textureSampleLevel(t1, sl, texcoord, 0.0);
        let s = select(abs(offset.y), abs(offset.x), abs(offset.x) > abs(offset.y));
        C = vec4<f32>(pow(C.xyz, vec3<f32>(2.2)), C.w);
        Cop = vec4<f32>(pow(Cop.xyz, vec3<f32>(2.2)), Cop.w);
        var mixed = mix(C, Cop, s);
        mixed = vec4<f32>(pow(mixed.xyz, vec3<f32>(1.0 / 2.2)), mixed.w);
        return mixed;
    }
}
