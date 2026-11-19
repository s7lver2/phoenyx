// PointsMaterial de three (points_vert / points_frag), como shader de usuario de Points integrado (sin ShaderMaterial).
// Uniformes (desde el vec4 1):
//   v1 = (size en px = size * pixelRatio, scale = alto CSS / 2, sizeAttenuation, toneMapped)
//   v2 = (color.rgb, opacity)
//   v3 = (uvTransform e0, e1, e3, e4), v4 = (uvTransform e6, e7, hay map, alphaTest)
//   v5 = (vertexColors, opaco (no transparent y mezcla normal), _, _)
// Atributos: position y color (hueco color del vertice).

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) pc: vec2<f32>,
    @location(1) vc: vec3<f32>,
    @location(2) fogDepth: f32,
    @location(3) @interpolate(flat) di: u32,
};

@vertex
fn vs_user(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
    let di = ii >> 16u;
    let pt = vi / 6u;
    let c = corner(vi % 6u);
    let u1 = ub(di, 1u);
    let mv = g.view * modelOf(di) * vec4<f32>(vpos(pt), 1.0);
    var size = u1.x;
    // sizeAttenuation: solo con proyeccion en perspectiva (isPerspectiveMatrix: projectionMatrix[2][3] == -1)
    if (u1.z > 0.5 && g.proj[2][3] == -1.0) {
        size *= u1.y / -mv.z;
    }
    var out: VOut;
    // el rasterizador de WebGL dibuja los puntos de menos de 1 px con 1 px
    out.pos = point_clip(mv, max(size, 1.0), c);
    out.pc = point_coord(c);
    out.vc = vcol(pt);
    out.fogDepth = -mv.z;
    out.di = di;
    return out;
}

@fragment
fn fs_user(in: VOut) -> @location(0) vec4<f32> {
    let u1 = ub(in.di, 1u);
    let u2 = ub(in.di, 2u);
    let u3 = ub(in.di, 3u);
    let u4 = ub(in.di, 4u);
    let u5 = ub(in.di, 5u);
    var col = vec4<f32>(u2.rgb, u2.w);
    // map_particle_fragment: uv = (uvTransform * vec3(gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1)).xy
    // (el muestreo va fuera del `if`: textureSample exige flujo uniforme)
    let p = vec2<f32>(in.pc.x, 1.0 - in.pc.y);
    let uv = vec2<f32>(u3.x * p.x + u3.z * p.y + u4.x, u3.y * p.x + u3.w * p.y + u4.y);
    let tx = textureSample(t0, s0, uv);
    if (u4.z > 0.5) {
        col = col * tx;
    }
    // color_fragment (vertexColors)
    if (u5.x > 0.5) {
        col = vec4<f32>(col.rgb * in.vc, col.a);
    }
    // alphatest_fragment
    if (u4.w > 0.0 && col.a < u4.w) { discard; }
    // opaque_fragment
    if (u5.y > 0.5) { col.a = 1.0; }
    var rgb = col.rgb;
    if (u1.w > 0.5) {
        rgb = tone_out(rgb);
    } else if (g.pad0.z < 0.5) {
        rgb = sRGBTransferOETF(rgb);
    }
    rgb = fog_out(rgb, in.fogDepth, ub(in.di, 0u).x);
    return vec4<f32>(rgb, col.a);
}
