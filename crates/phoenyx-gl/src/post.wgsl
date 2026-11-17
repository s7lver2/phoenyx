// Pases de pantalla completa (postproceso). Cada fragment portado linea a linea del GLSL de three 0.160.1
// (examples/jsm/shaders/*.js). Convencion de three/WebGL: vUv con v hacia arriba y textura con la fila 0 abajo.

// uniformes empaquetados por pass.ts (cada shader define su orden)
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 64>;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(3) var t2: texture_2d<f32>;
@group(0) @binding(4) var t3: texture_2d<f32>;
// profundidad u otra textura sin filtrado: se lee con textureLoad
@group(0) @binding(5) var td: texture_2d<f32>;
@group(0) @binding(6) var sl: sampler; // lineal, clamp
@group(0) @binding(7) var sn: sampler; // nearest, clamp

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
