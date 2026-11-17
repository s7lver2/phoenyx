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

// ---- GTAOPass: GTAOShader, PoissonDenoiseShader, GTAODepthShader y GTAOBlendShader ----
const PI_F = 3.141592653589793;

fn g_mat(i: u32) -> mat4x4<f32> {
    return mat4x4<f32>(u[i], u[i + 1u], u[i + 2u], u[i + 3u]);
}

fn g_view_pos(uv: vec2<f32>, depth: f32, projInv: mat4x4<f32>) -> vec3<f32> {
    let clip = vec4<f32>(vec3<f32>(uv, depth) * 2.0 - 1.0, 1.0);
    let v = projInv * clip;
    return v.xyz / v.w;
}

// textureLod con filtro nearest y clamp-to-edge (profundidad y normales de three)
fn nload(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
    let sz = vec2<f32>(textureDimensions(t));
    let p = clamp(vec2<i32>(floor(uv * sz)), vec2<i32>(0), vec2<i32>(sz) - vec2<i32>(1));
    return textureLoad(t, p, 0);
}

// textureLod con filtro nearest y RepeatWrapping (ruido)
fn wload(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
    let d = vec2<i32>(textureDimensions(t));
    let p = vec2<i32>(floor(uv * vec2<f32>(d)));
    return textureLoad(t, ((p % d) + d) % d, 0);
}

fn g_depth(uv: vec2<f32>) -> f32 {
    return nload(td, uv).x;
}

fn g_fetch_depth(p: vec2<i32>) -> f32 {
    return textureLoad(td, p, 0).x;
}

fn g_normal_from_depth(uv: vec2<f32>, projInv: mat4x4<f32>) -> vec3<f32> {
    let size = vec2<f32>(textureDimensions(td));
    let p = vec2<i32>(uv * size);
    let c0 = g_fetch_depth(p);
    let l2 = g_fetch_depth(p - vec2<i32>(2, 0));
    let l1 = g_fetch_depth(p - vec2<i32>(1, 0));
    let r1 = g_fetch_depth(p + vec2<i32>(1, 0));
    let r2 = g_fetch_depth(p + vec2<i32>(2, 0));
    let b2 = g_fetch_depth(p - vec2<i32>(0, 2));
    let b1 = g_fetch_depth(p - vec2<i32>(0, 1));
    let t1 = g_fetch_depth(p + vec2<i32>(0, 1));
    let t2 = g_fetch_depth(p + vec2<i32>(0, 2));
    let dl = abs((2.0 * l1 - l2) - c0);
    let dr = abs((2.0 * r1 - r2) - c0);
    let db = abs((2.0 * b1 - b2) - c0);
    let dt = abs((2.0 * t1 - t2) - c0);
    let ce = g_view_pos(uv, c0, projInv);
    var dpdx: vec3<f32>;
    if (dl < dr) {
        dpdx = ce - g_view_pos(uv - vec2<f32>(1.0 / size.x, 0.0), l1, projInv);
    } else {
        dpdx = -ce + g_view_pos(uv + vec2<f32>(1.0 / size.x, 0.0), r1, projInv);
    }
    var dpdy: vec3<f32>;
    if (db < dt) {
        dpdy = ce - g_view_pos(uv - vec2<f32>(0.0, 1.0 / size.y), b1, projInv);
    } else {
        dpdy = -ce + g_view_pos(uv + vec2<f32>(0.0, 1.0 / size.y), t1, projInv);
    }
    return normalize(cross(dpdx, dpdy));
}

// tipo 2: normal tal cual; tipo 1: normal empaquetada en RGB (unpackRGBToNormal); resto: a partir de la profundidad
fn g_view_normal(nt: texture_2d<f32>, uv: vec2<f32>, ntype: i32, projInv: mat4x4<f32>) -> vec3<f32> {
    if (ntype == 2) {
        return normalize(nload(nt, uv).rgb);
    } else if (ntype == 1) {
        return 2.0 * nload(nt, uv).rgb - 1.0;
    }
    return g_normal_from_depth(uv, projInv);
}

fn g_scene_uv_depth(p: vec3<f32>, projM: mat4x4<f32>) -> vec3<f32> {
    let c = projM * vec4<f32>(p, 1.0);
    let suv = c.xy / c.w * 0.5 + 0.5;
    return vec3<f32>(suv, g_depth(suv));
}

// GTAOShader. u[0] = (resolution, near, far), u[1] = (radius, distanceExponent, thickness, distanceFallOff),
// u[2] = (scale, SAMPLES, NORMAL_VECTOR_TYPE, flags: 1 SCREEN_SPACE_RADIUS, 2 SCENE_CLIP_BOX), u[3].x = SCREEN_SPACE_RADIUS_SCALE,
// u[4].xyz = sceneBoxMin, u[5].xyz = sceneBoxMax, u[6..9] = cameraProjectionMatrix, u[10..13] = su inversa, u[14..17] = cameraWorldMatrix.
// t0 = tNormal, t1 = tNoise, td = tDepth
@fragment
fn fs_gtao(in: VOut) -> @location(0) vec4<f32> {
    let vUv = in.vuv;
    let resolution = u[0].xy;
    let distanceExponent = u[1].y;
    let thickness = u[1].z;
    let distanceFallOff = u[1].w;
    let scale = u[2].x;
    let samples = i32(u[2].y);
    let ntype = i32(u[2].z);
    let flags = u32(u[2].w);
    let projM = g_mat(6u);
    let projInv = g_mat(10u);
    let worldM = g_mat(14u);
    let depth = g_depth(vUv);
    if (depth >= 1.0) {
        discard;
    }
    let viewPos = g_view_pos(vUv, depth, projInv);
    let viewNormal = g_view_normal(t0, vUv, ntype, projInv);
    var radiusToUse = u[1].x;
    if ((flags & 1u) != 0u) {
        let radiusScale = g_view_pos(vec2<f32>(0.5 + u[3].x / resolution.x, 0.0), depth, projInv).x;
        radiusToUse = radiusToUse * radiusScale;
    }
    var boxDistance = 0.0;
    if ((flags & 2u) != 0u) {
        let worldPos = (worldM * vec4<f32>(viewPos, 1.0)).xyz;
        boxDistance = length(max(vec3<f32>(0.0), max(u[4].xyz - worldPos, worldPos - u[5].xyz)));
        if (boxDistance > radiusToUse) {
            discard;
        }
    }
    let noiseResolution = vec2<f32>(textureDimensions(t1));
    let noiseUv = vUv * resolution / noiseResolution;
    let noiseTexel = wload(t1, noiseUv);
    let randomVec = noiseTexel.xyz * 2.0 - 1.0;
    let tangent = normalize(vec3<f32>(randomVec.xy, 0.0));
    let bitangent = vec3<f32>(-tangent.y, tangent.x, 0.0);
    let kernelMatrix = mat3x3<f32>(tangent, bitangent, vec3<f32>(0.0, 0.0, 1.0));
    let directions = select(5, 3, samples < 30);
    let steps = (samples + directions - 1) / directions;
    var ao = 0.0;
    for (var i = 0; i < directions; i = i + 1) {
        let angle = f32(i) / f32(directions) * PI_F;
        let sd = vec4<f32>(cos(angle), sin(angle), 0.0, 0.5 + 0.5 * noiseTexel.w);
        let sampleDir = vec4<f32>(normalize(kernelMatrix * sd.xyz), sd.w);
        let viewDir = normalize(-viewPos);
        let sliceBitangent = normalize(cross(sampleDir.xyz, viewDir));
        let sliceTangent = cross(sliceBitangent, viewDir);
        let normalInSlice = normalize(viewNormal - sliceBitangent * dot(viewNormal, sliceBitangent));
        let tangentToNormalInSlice = cross(normalInSlice, sliceBitangent);
        var cosHorizons = vec2<f32>(dot(viewDir, tangentToNormalInSlice), dot(viewDir, -tangentToNormalInSlice));
        for (var j = 0; j < steps; j = j + 1) {
            let sampleViewOffset = sampleDir.xyz * radiusToUse * sampleDir.w * pow(f32(j + 1) / f32(steps), distanceExponent);
            var sud = g_scene_uv_depth(viewPos + sampleViewOffset, projM);
            var sampleSceneViewPos = g_view_pos(sud.xy, sud.z, projInv);
            var viewDelta = sampleSceneViewPos - viewPos;
            if (abs(viewDelta.z) < thickness) {
                let sampleCosHorizon = dot(viewDir, normalize(viewDelta));
                cosHorizons.x = cosHorizons.x + max(0.0, (sampleCosHorizon - cosHorizons.x) * mix(1.0, 2.0 / f32(j + 2), distanceFallOff));
            }
            sud = g_scene_uv_depth(viewPos - sampleViewOffset, projM);
            sampleSceneViewPos = g_view_pos(sud.xy, sud.z, projInv);
            viewDelta = sampleSceneViewPos - viewPos;
            if (abs(viewDelta.z) < thickness) {
                let sampleCosHorizon = dot(viewDir, normalize(viewDelta));
                cosHorizons.y = cosHorizons.y + max(0.0, (sampleCosHorizon - cosHorizons.y) * mix(1.0, 2.0 / f32(j + 2), distanceFallOff));
            }
        }
        let sinHorizons = sqrt(1.0 - cosHorizons * cosHorizons);
        let nx = dot(normalInSlice, sliceTangent);
        let ny = dot(normalInSlice, viewDir);
        let nxb = 1.0 / 2.0 * (acos(cosHorizons.y) - acos(cosHorizons.x) + sinHorizons.x * cosHorizons.x - sinHorizons.y * cosHorizons.y);
        let nyb = 1.0 / 2.0 * (2.0 - cosHorizons.x * cosHorizons.x - cosHorizons.y * cosHorizons.y);
        ao = ao + (nx * nxb + ny * nyb);
    }
    ao = clamp(ao / f32(directions), 0.0, 1.0);
    if ((flags & 2u) != 0u) {
        ao = mix(ao, 1.0, smoothstep(0.0, radiusToUse, boxDistance));
    }
    ao = pow(ao, scale);
    return vec4<f32>(vec3<f32>(ao), 1.0);
}

// PoissonDenoiseShader. u[0] = (resolution, lumaPhi, depthPhi), u[1] = (normalPhi, radius, index, SAMPLES), u[2].x = NORMAL_VECTOR_TYPE,
// u[3..6] = inversa de la proyeccion, u[7 + i].xyz = poissonDisk[i]. t0 = tDiffuse, t1 = tNormal, t2 = tNoise, td = tDepth
fn pd_luma(a: vec3<f32>) -> f32 {
    return dot(vec3<f32>(0.2125, 0.7154, 0.0721), a);
}

@fragment
fn fs_denoise(in: VOut) -> @location(0) vec4<f32> {
    let vUv = in.vuv;
    let resolution = u[0].xy;
    let lumaPhi = u[0].z;
    let depthPhi = u[0].w;
    let normalPhi = u[1].x;
    let radius = u[1].y;
    let index = i32(u[1].z);
    let samples = i32(u[1].w);
    let ntype = i32(u[2].x);
    let projInv = g_mat(3u);
    let depth = g_depth(vUv);
    let viewNormal = g_view_normal(t1, vUv, ntype, projInv);
    if (depth == 1.0 || dot(viewNormal, viewNormal) == 0.0) {
        discard;
    }
    let texel = textureSampleLevel(t0, sl, vUv, 0.0);
    let center = texel.rgb;
    let viewPos = g_view_pos(vUv, depth, projInv);
    let noiseResolution = vec2<f32>(textureDimensions(t2));
    let noiseUv = vUv * resolution / noiseResolution;
    let noiseTexel = wload(t2, noiseUv);
    let nv = noiseTexel[index % 4];
    let noiseVec = vec2<f32>(sin(nv * 2.0 * PI_F), cos(nv * 2.0 * PI_F));
    let rotationMatrix = mat2x2<f32>(vec2<f32>(noiseVec.x, -noiseVec.y), vec2<f32>(noiseVec.x, noiseVec.y));
    var totalWeight = 1.0;
    var denoised = texel.rgb;
    for (var i = 0; i < samples; i = i + 1) {
        let sampleDir = u[7 + i].xyz;
        let offset = rotationMatrix * (sampleDir.xy * (1.0 + sampleDir.z * (radius - 1.0)) / resolution);
        let sampleUv = vUv + offset;
        let sampleTexel = textureSampleLevel(t0, sl, sampleUv, 0.0);
        let sampleDepth = g_depth(sampleUv);
        let sampleNormal = g_view_normal(t1, sampleUv, ntype, projInv);
        let neighborColor = sampleTexel.rgb;
        let viewPosSample = g_view_pos(sampleUv, sampleDepth, projInv);
        let normalDiff = dot(viewNormal, sampleNormal);
        let normalSimilarity = pow(max(normalDiff, 0.0), normalPhi);
        let lumaDiff = abs(pd_luma(neighborColor) - pd_luma(center));
        let lumaSimilarity = max(1.0 - lumaDiff / lumaPhi, 0.0);
        let depthDiff = abs(dot(viewPos - viewPosSample, viewNormal));
        let depthSimilarity = max(1.0 - depthDiff / depthPhi, 0.0);
        let w = lumaSimilarity * depthSimilarity * normalSimilarity;
        denoised = denoised + w * neighborColor;
        totalWeight = totalWeight + w;
    }
    if (totalWeight > 0.0) {
        denoised = denoised / totalWeight;
    }
    return vec4<f32>(denoised, 1.0);
}

// GTAODepthShader. u[0] = (cameraNear, cameraFar, PERSPECTIVE_CAMERA, 0). td = tDepth
@fragment
fn fs_aodepth(in: VOut) -> @location(0) vec4<f32> {
    let near = u[0].x;
    let far = u[0].y;
    let z = g_depth(in.vuv);
    var depth = z;
    if (u[0].z > 0.5) {
        let viewZ = (near * far) / ((far - near) * z - far);
        depth = (viewZ + near) / (near - far);
    }
    return vec4<f32>(vec3<f32>(1.0 - depth), 1.0);
}

// GTAOBlendShader. u[0].x = intensity. t0 = tDiffuse
@fragment
fn fs_aoblend(in: VOut) -> @location(0) vec4<f32> {
    let texel = textureSample(t0, sl, in.vuv);
    return vec4<f32>(mix(vec3<f32>(1.0), texel.rgb, u[0].x), texel.a);
}
