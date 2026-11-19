// Reflejo suave bajo la alfombra de la Suites (client/src/game/world.ts, shader SuitesFloor): el reflejo del Reflector al 22 %% de opacidad.
// Uniformes (desde el vec4 1): textureMatrix (4 vec4, columnas). textura: t0 = tDiffuse.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vUv: vec4<f32>,
    @location(1) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let tm = mat4x4<f32>(ub(di, 1u), ub(di, 2u), ub(di, 3u), ub(di, 4u));
    var out: VOut;
    out.vUv = tm * vec4<f32>(position, 1.0);
    out.pos = clip_of(g.view * modelOf(di) * vec4<f32>(position, 1.0));
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    // texture2DProj: la division por w va a mano; el RT no tiene mips (nivel 0)
    let b = textureSampleLevel(t0, s0, in.vUv.xy / in.vUv.w, 0.0);
    return vec4<f32>(tone_out(b.rgb), 0.22);
}
