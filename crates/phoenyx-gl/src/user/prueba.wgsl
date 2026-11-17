// Material de prueba de la fase 6 (escena sh-prueba): gradiente por uTime entre uColor y uMap, con niebla.
// uniformes (desde el vec4 1): [uTime, _, _, _], [uColor.rgb, _]; textura: t0 = uMap.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) fogDepth: f32,
    @location(2) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let mv = g.view * modelOf(di) * vec4<f32>(position, 1.0);
    var out: VOut;
    out.pos = clip_of(mv);
    out.uv = uv;
    out.fogDepth = -mv.z;
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let uTime = ub(in.di, 1u).x;
    let uColor = ub(in.di, 2u).xyz;
    let t = textureSample(t0, s0, in.uv).rgb;
    let s = 0.5 + 0.5 * sin(in.uv.x * 12.0 + uTime);
    var rgb = mix(uColor, t, s);
    rgb = tone_out(rgb);
    rgb = fog_out(rgb, in.fogDepth, ub(in.di, 0u).x);
    return vec4<f32>(rgb, 0.8);
}
