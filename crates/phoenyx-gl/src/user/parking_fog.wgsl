// parking-atmosphere.ts: niebla volumetrica en una caja (marcha de @N@ pasos). Uniformes (desde el vec4 1):
// [uTime, uPower, _, _], [uMin.xyz, _], [uMax.xyz, _]. `@N@` se sustituye por 4 (calidad baja) o 10.

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vWorld: vec3<f32>,
    @location(1) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let w = (modelOf(di) * vec4<f32>(position, 1.0)).xyz;
    var out: VOut;
    out.pos = clip_of(g.view * vec4<f32>(w, 1.0));
    out.vWorld = w;
    out.di = di;
    return out;
}

fn density(p: vec3<f32>, uTime: f32, uMin: vec3<f32>) -> f32 {
    let q = p * 0.9 + vec3<f32>(uTime * 0.035, 0.0, uTime * 0.017);
    let n = sin(q.x + sin(q.z * 1.7)) * sin(q.z * 0.7 + sin(q.y * 2.1)) + sin(q.x * 2.3 + q.z * 1.3 + uTime * 0.06) * 0.3;
    return (0.65 + n * 0.22) * exp(-(p.y - uMin.y) * 1.35);
}

@fragment
fn fs_user(in: VOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
    let u1 = ub(in.di, 1u);
    let uTime = u1.x;
    let uPower = u1.y;
    let uMin = ub(in.di, 2u).xyz;
    let uMax = ub(in.di, 3u).xyz;
    let cameraPosition = g.cam.xyz;
    let inside = all(cameraPosition >= uMin) && all(cameraPosition <= uMax);
    if (frontFacing == inside) { discard; }
    let rd = normalize(in.vWorld - cameraPosition);
    let inv = 1.0 / rd;
    let a = (uMin - cameraPosition) * inv;
    let b = (uMax - cameraPosition) * inv;
    let mn = min(a, b);
    let mx = max(a, b);
    var near = max(max(mn.x, mn.y), mn.z);
    let far = min(min(mx.x, mx.y), mx.z);
    near = max(0.0, near);
    if (far <= near) { discard; }
    let stepSize = (far - near) / @N@.0;
    var optical = 0.0;
    for (var j = 0; j < @N@; j++) {
        let p = cameraPosition + rd * (near + (f32(j) + 0.5) * stepSize);
        let edge = smoothstep(0.0, 0.6, min(min(p.x - uMin.x, uMax.x - p.x), min(p.z - uMin.z, uMax.z - p.z)));
        optical += density(p, uTime, uMin) * edge * stepSize;
    }
    let alpha = (1.0 - exp(-optical * 0.12)) * (1.0 - smoothstep(6.0, 18.0, distance(cameraPosition, in.vWorld)));
    return vec4<f32>(vec3<f32>(0.14, 0.18, 0.15) + vec3<f32>(0.02) * uPower, min(alpha, 0.25));
}
