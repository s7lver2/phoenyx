// Polvo del juego (client/src/game/game.ts, `dust`): motas de un pixel o dos en una caja de 8 m que sigue a la camara.
// Uniformes (desde el vec4 1): [uCam.xyz, uTime], [uBeam, uPx, _, _]. Atributo: position.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vA: f32,
    @location(1) pc: vec2<f32>,
};

fn gmod(x: vec3<f32>, y: f32) -> vec3<f32> { return x - y * floor(x / y); }

@vertex
fn vs_user(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let pt = vi / 6u;
    let c = corner(vi % 6u);
    let position = vpos(pt);
    let a = ub(di, 1u);
    let uCam = a.xyz;
    let uTime = a.w;
    let b = ub(di, 2u);
    let uBeam = b.x;
    let uPx = b.y;
    var p = position + vec3<f32>(sin(uTime * 0.13 + position.y) * 0.4, -uTime * 0.03, cos(uTime * 0.11 + position.x) * 0.4);
    p = gmod(p - uCam + 4.0, 8.0) - 4.0 + uCam;
    let mv = g.view * modelOf(di) * vec4<f32>(p, 1.0);
    let d = length(mv.xyz);
    let beam = sstep(0.86, 0.97, dot(normalize(mv.xyz), vec3<f32>(0.0, -0.05, -1.0))) * uBeam * (1.0 - sstep(1.0, 7.0, d));
    let h = fract(sin(dot(position, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    let tw = 0.65 + 0.35 * sin(uTime * (0.6 + h * 1.4) + h * 40.0);
    var out: VOut;
    out.vA = (0.03 + 0.5 * beam) * (0.45 + h) * tw;
    let size = max(uPx * (0.6 + h * 1.0) / max(d, 1.2), 1.0);
    out.pos = point_clip(mv, size, c);
    out.pc = point_coord(c);
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let r = length(in.pc - 0.5);
    return vec4<f32>(vec3<f32>(1.0, 0.93, 0.78) * in.vA * (1.0 - sstep(0.1, 0.5, r)), 1.0);
}
