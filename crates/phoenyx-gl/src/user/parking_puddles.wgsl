// Charcos del parking (client/src/game/parking-puddles.ts): decals de agua con borde irregular y el reflejo del Reflector.
// Uniformes (desde el vec4 1): textureMatrix (4 vec4, columnas). textura: t0 = tDiffuse.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) reflectionUv: vec4<f32>,
    @location(1) puddleUv: vec2<f32>,
    @location(2) seed: vec2<f32>,
    @location(3) fogDepth: f32,
    @location(4) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let tm = mat4x4<f32>(ub(di, 1u), ub(di, 2u), ub(di, 3u), ub(di, 4u));
    let mv = g.view * modelOf(di) * vec4<f32>(position, 1.0);
    var out: VOut;
    out.reflectionUv = tm * vec4<f32>(position, 1.0);
    out.puddleUv = uv * 2.0 - 1.0;
    out.seed = position.xy;
    out.pos = clip_of(mv);
    out.fogDepth = -mv.z;
    out.di = di;
    return out;
}

fn h21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2<f32>(1.0, 0.0)), f.x), mix(h21(i + vec2<f32>(0.0, 1.0)), h21(i + vec2<f32>(1.0, 1.0)), f.x), f.y);
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let puddleUv = in.puddleUv;
    let seed = in.seed;
    let angle = atan2(puddleUv.y, puddleUv.x + 0.00001);
    let r = length(puddleUv);
    let edge = 0.76 + 0.12 * sin(angle * 3.0) + 0.07 * cos(angle * 7.0) + (vnoise(puddleUv * 5.0 + seed * 3.1) - 0.5) * 0.14;
    let body = 1.0 - sstep(edge - 0.26, edge, r);
    let halo = (1.0 - sstep(edge - 0.05, edge + 0.2, r)) * 0.55;
    let alpha = max(body, halo);
    // (el muestreo va antes del discard: textureSample exige flujo uniforme; el RT no tiene mips, nivel 0)
    let wob = (vec2<f32>(vnoise(puddleUv * 7.0 + seed), vnoise(puddleUv * 7.0 - seed)) - 0.5) * 0.012;
    var ruv = in.reflectionUv;
    ruv = vec4<f32>(ruv.xy + wob * ruv.w, ruv.zw);
    let reflected = textureSampleLevel(t0, s0, ruv.xy / ruv.w, 0.0).rgb;
    if (alpha <= 0.01) {
        discard;
    }
    let k = sstep(0.0, 0.9, body);
    let rim = sstep(edge - 0.16, edge - 0.02, r) * body;
    let wet = vec3<f32>(0.006, 0.009, 0.009);
    var col = wet + reflected * (0.25 + 0.55 * k) + rim * vec3<f32>(0.035, 0.04, 0.04);
    let a = alpha * (0.3 + 0.6 * k) * 0.95;
    col = tone_out(col);
    col = fog_out(col, in.fogDepth, ub(in.di, 0u).x);
    return vec4<f32>(col, a);
}
