// remote.ts (beamMat): haz de la linterna de un jugador remoto, aditivo y de doble cara. Uniformes (desde el vec4 1): [uK, uT, uOn, _].

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vT: f32,
    @location(1) vN: vec3<f32>,
    @location(2) vV: vec3<f32>,
    @location(3) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let mv = g.view * modelOf(di) * vec4<f32>(position, 1.0);
    var out: VOut;
    out.vT = -position.z / 6.0;
    out.vN = normalize(normalMatrixOf(di) * normal);
    out.vV = normalize(-mv.xyz);
    out.pos = clip_of(mv);
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let u1 = ub(in.di, 1u);
    let uK = u1.x;
    let uT = u1.y;
    let uOn = u1.z;
    let vT = in.vT;
    let edge = pow(abs(dot(normalize(in.vN), normalize(in.vV))), 1.6);
    let along = pow(1.0 - vT, 1.7) * smoothstep(0.0, 0.06, vT);
    let dust = 0.88 + 0.12 * sin(vT * 38.0 - uT * 1.7) * sin(vT * 11.0 + uT * 0.9);
    return vec4<f32>(vec3<f32>(1.0, 0.93, 0.74) * uK * edge * along * dust * uOn, 1.0);
}
