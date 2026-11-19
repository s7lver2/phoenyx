// Polvo del pasillo (client/src/game/world.ts, `dustMat`): motas aditivas que solo se ven bajo cada foco (cada 3 m).
// Uniformes (desde el vec4 1): [uT, _, _, _]. Atributos: position, aSeed = uv.x.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vA: f32,
    @location(1) pc: vec2<f32>,
};

@vertex
fn vs_user(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let pt = vi / 6u;
    let c = corner(vi % 6u);
    let position = vpos(pt);
    let aSeed = vuv(pt).x;
    let uT = ub(di, 1u).x;
    let p = position + vec3<f32>(sin(uT * 0.21 + aSeed * 40.0) * 0.18 + uT * 0.012, sin(uT * 0.17 + aSeed * 23.0) * 0.1 - uT * 0.006 * aSeed, cos(uT * 0.19 + aSeed * 31.0) * 0.14);
    let mv = g.view * modelOf(di) * vec4<f32>(p, 1.0);
    let x = p.x - 0.75 + 1.5;
    let lamp = abs(x - 3.0 * floor(x / 3.0) - 1.5);
    let cone = exp(-lamp * lamp * 1.6) * sstep(0.0, 1.2, p.y);
    let d = -mv.z;
    var out: VOut;
    out.vA = (0.05 + 0.95 * cone) * sstep(1.2, 3.0, d) * (1.0 - sstep(8.0, 14.0, d)) * (0.4 + 0.6 * (0.5 + 0.5 * sin(uT * (0.7 + aSeed) + aSeed * 50.0)));
    let size = max((0.8 + aSeed * 1.2) * 11.0 / d, 1.0);
    out.pos = point_clip(mv, size, c);
    out.pc = point_coord(c);
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let r = length(in.pc - 0.5) * 2.0;
    return vec4<f32>(vec3<f32>(1.0, 0.86, 0.6) * sstep(1.0, 0.0, r) * in.vA * 0.5, 1.0);
}
