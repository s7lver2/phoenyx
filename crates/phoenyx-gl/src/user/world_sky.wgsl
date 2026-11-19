// Cielo de la cupula (client/src/game/world.ts, `sky`): degradado, nubes planas y posterizado. Uniformes (desde el vec4 1): [uT, _, _, _].

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vD: vec3<f32>,
    @location(1) @interpolate(flat) di: u32,
};

fn hh(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn nn(p: vec2<f32>) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hh(i), hh(i + vec2<f32>(1.0, 0.0)), f.x), mix(hh(i + vec2<f32>(0.0, 1.0)), hh(i + vec2<f32>(1.0, 1.0)), f.x), f.y);
}

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    var out: VOut;
    out.vD = position;
    out.pos = clip_of(g.view * modelOf(di) * vec4<f32>(position, 1.0));
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let uT = ub(in.di, 1u).x;
    let d = normalize(in.vD);
    let el = clamp(d.y, 0.0, 1.0);
    var col = mix(vec3<f32>(0.72, 0.88, 1.0), vec3<f32>(0.16, 0.46, 0.92), pow(el, 0.6));
    let p = d.xz / (d.y + 0.25) * 1.6 + vec2<f32>(uT * 0.004, 0.0);
    let c = sstep(0.55, 0.62, nn(p * 1.3) * 0.65 + nn(p * 3.1) * 0.35);
    col = mix(col, vec3<f32>(1.0), c * 0.9 * sstep(0.05, 0.3, el));
    col = floor(col * 9.0 + 0.5) / 9.0;
    return vec4<f32>(col, 1.0);
}
