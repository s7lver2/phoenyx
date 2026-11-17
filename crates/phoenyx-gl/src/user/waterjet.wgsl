// WaterJet (client/src/game/waterjet.ts): gotas como Points. Uniformes (desde el vec4 1): [uScale, _, _, _].
// Atributos: position, aLife = uv.x, aSize = uv.y (hueco `uv` de la geometria).

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
    let a = vuv(pt);   // x = aLife, y = aSize
    let uScale = ub(di, 1u).x;
    let mv = g.view * modelOf(di) * vec4<f32>(position, 1.0);
    var out: VOut;
    out.vA = a.x;
    let size = clamp(a.y * uScale * 0.1 / max(-mv.z, 0.3) * (0.55 + 0.6 * a.x), 1.0, 40.0);
    out.pos = point_clip(mv, size, c);
    out.pc = point_coord(c);
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let p = in.pc * 2.0 - 1.0;
    let d = dot(p, p);
    if (d > 1.0) { discard; }
    let a = sstep(1.0, 0.15, d) * min(1.0, in.vA * 3.0) * 0.8;
    return vec4<f32>(mix(vec3<f32>(0.5, 0.78, 1.0), vec3<f32>(1.0), sstep(0.6, 0.0, d) * 0.8), a);
}
