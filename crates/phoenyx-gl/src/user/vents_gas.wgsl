// Gas de los conductos (client/src/game/vents.ts, gas()): bocanadas verdes como Points con la textura de nube (t0 = uMap).
// Uniformes (desde el vec4 1): [uT, _, _, _]. Atributos: position, aSeed = uv.x.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vA: f32,
    @location(1) vS: f32,
    @location(2) vR: f32,
    @location(3) pc: vec2<f32>,
};

@vertex
fn vs_user(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let pt = vi / 6u;
    let c = corner(vi % 6u);
    let position = vpos(pt);
    let s = vuv(pt).x;
    let uT = ub(di, 1u).x;
    let h = fract(position.y / 1.60 + uT * (0.025 + s * 0.04));
    var p = position;
    p.y = h * 1.60;
    p.x += sin(uT * (0.25 + s * 0.35) + s * 40.0) * 0.4;
    p.z += cos(uT * (0.2 + s * 0.3) + s * 70.0) * 0.4;
    let mv = g.view * modelOf(di) * vec4<f32>(p, 1.0);
    let d = max(-mv.z, 0.4);
    var out: VOut;
    out.vA = sin(h * 3.14159) * sstep(0.35, 1.2, d);
    out.vS = s;
    out.vR = uT * (0.15 + s * 0.2) * select(-1.0, 1.0, s > 0.5) + s * 6.0;
    let size = min((0.9 + s * 0.9) * 640.0 / d, 420.0);
    out.pos = point_clip(mv, size, c);
    out.pc = point_coord(c);
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let q = in.pc - 0.5;
    let cs = cos(in.vR);
    let sn = sin(in.vR);
    let uv = vec2<f32>(cs * q.x - sn * q.y, sn * q.x + cs * q.y) + 0.5;
    let m = textureSample(t0, s0, uv).a * sstep(0.5, 0.2, length(q));
    let col = mix(vec3<f32>(0.30, 0.62, 0.12), vec3<f32>(0.62, 0.92, 0.28), in.vS);
    return vec4<f32>(col * (0.8 + 0.5 * m), m * in.vA * 0.9);
}
