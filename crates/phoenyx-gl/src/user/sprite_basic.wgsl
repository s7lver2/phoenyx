// SpriteMaterial de three (sprite_vert / sprite_frag), como shader de usuario integrado.
// Uniformes (desde el vec4 1):
//   v1 = (rotation, sizeAttenuation, toneMapped, hay map)
//   v2 = (color.rgb, opacity)
//   v3 = (uvTransform e0, e1, e3, e4), v4 = (uvTransform e6, e7, alphaTest, opaco)
// `center` del Sprite va en el registro del objeto (`pad.xy`). Geometria: el quad interno de Sprite (position.xy, uv).

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) fogDepth: f32,
    @location(2) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let u1 = ub(di, 1u);
    let u3 = ub(di, 3u);
    let u4 = ub(di, 4u);
    let model = modelOf(di);
    let center = objects[draws[di * 3u].y].pad.xy;
    var mv = g.view * model * vec4<f32>(0.0, 0.0, 0.0, 1.0);
    var scale = vec2<f32>(length(model[0].xyz), length(model[1].xyz));
    // sin sizeAttenuation el sprite mide lo mismo en pantalla (solo con proyeccion en perspectiva)
    if (u1.y < 0.5 && g.proj[2][3] == -1.0) {
        scale *= -mv.z;
    }
    let aligned = (position.xy - (center - vec2<f32>(0.5))) * scale;
    let cs = cos(u1.x);
    let sn = sin(u1.x);
    let rotated = vec2<f32>(cs * aligned.x - sn * aligned.y, sn * aligned.x + cs * aligned.y);
    mv = vec4<f32>(mv.xy + rotated, mv.z, mv.w);
    var out: VOut;
    out.pos = clip_of(mv);
    out.uv = vec2<f32>(u3.x * uv.x + u3.z * uv.y + u4.x, u3.y * uv.x + u3.w * uv.y + u4.y);
    out.fogDepth = -mv.z;
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let u1 = ub(in.di, 1u);
    let u2 = ub(in.di, 2u);
    let u4 = ub(in.di, 4u);
    var col = vec4<f32>(u2.rgb, u2.w);
    let tx = textureSample(t0, s0, in.uv);
    if (u1.w > 0.5) {
        col = col * tx;
    }
    // alphatest_fragment
    if (u4.z > 0.0 && col.a < u4.z) { discard; }
    // opaque_fragment
    if (u4.w > 0.5) { col.a = 1.0; }
    var rgb = col.rgb;
    if (u1.z > 0.5) {
        rgb = tone_out(rgb);
    } else if (g.pad0.z < 0.5) {
        rgb = sRGBTransferOETF(rgb);
    }
    rgb = fog_out(rgb, in.fogDepth, ub(in.di, 0u).x);
    return vec4<f32>(rgb, col.a);
}
