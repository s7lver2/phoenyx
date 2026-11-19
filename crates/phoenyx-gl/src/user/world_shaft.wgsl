// Haz de luz de los paneles (client/src/game/world.ts, `shaftMat`): cono aditivo de doble cara, instanciado. Sin uniformes.
// Atributos: position, normal, color.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vC: vec3<f32>,
    @location(1) vF: f32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let mm = g.view * modelOf(di) * instMat(di, ii & 0xFFFFu);
    let mv = mm * vec4<f32>(position, 1.0);
    let n = normalize(mat3x3<f32>(mm[0].xyz, mm[1].xyz, mm[2].xyz) * normal);
    var out: VOut;
    out.vF = pow(abs(dot(n, normalize(-mv.xyz))), 2.2);
    out.vC = color;
    out.pos = clip_of(mv);
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.vC * in.vF * 0.13, 1.0);
}
