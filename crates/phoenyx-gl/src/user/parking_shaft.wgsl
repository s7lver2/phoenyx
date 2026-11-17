// parking-atmosphere.ts: haz de luz en un cono. Uniformes (desde el vec4 1): [uTime, uBase, uPower, _].

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vWorld: vec3<f32>,
    @location(1) vNormal: vec3<f32>,
    @location(2) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let m = modelOf(di);
    let w = (m * vec4<f32>(position, 1.0)).xyz;
    var out: VOut;
    out.vNormal = normalize(mat3x3<f32>(m[0].xyz, m[1].xyz, m[2].xyz) * normal);
    out.vWorld = w;
    out.pos = clip_of(g.view * vec4<f32>(w, 1.0));
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let u1 = ub(in.di, 1u);
    let uBase = u1.y;
    let uPower = u1.z;
    let cameraPosition = g.cam.xyz;
    let h = clamp((in.vWorld.y - uBase) / 3.1, 0.0, 1.0);
    let edge = smoothstep(0.0, 0.45, abs(dot(normalize(in.vNormal), normalize(cameraPosition - in.vWorld))));
    let pulse = uPower;
    let alpha = 0.012 * sin(h * 3.14159) * edge * pulse * (1.0 - smoothstep(3.0, 15.0, distance(cameraPosition, in.vWorld)));
    return vec4<f32>(0.61, 0.67, 0.48, alpha);
}
