// LineBasicMaterial de three (Line, LineSegments, LineLoop): el sombreador `basic` (color * color de vertice, tonemap y niebla), dibujado como line-list.
// Uniformes (desde el vec4 1): v1 = (toneMapped, vertexColors, opaco, _), v2 = (color.rgb, opacity).

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) vc: vec3<f32>,
    @location(1) fogDepth: f32,
    @location(2) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let mv = g.view * modelOf(di) * vec4<f32>(position, 1.0);
    var out: VOut;
    out.pos = clip_of(mv);
    out.vc = color;
    out.fogDepth = -mv.z;
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let u1 = ub(in.di, 1u);
    let u2 = ub(in.di, 2u);
    var col = vec4<f32>(u2.rgb, u2.w);
    if (u1.y > 0.5) {
        col = vec4<f32>(col.rgb * in.vc, col.a);
    }
    if (u1.z > 0.5) { col.a = 1.0; }
    var rgb = col.rgb;
    if (u1.x > 0.5) {
        rgb = tone_out(rgb);
    } else if (g.pad0.z < 0.5) {
        rgb = sRGBTransferOETF(rgb);
    }
    rgb = fog_out(rgb, in.fogDepth, ub(in.di, 0u).x);
    return vec4<f32>(rgb, col.a);
}
