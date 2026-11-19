// Cabecera de los shaders de Points: cada punto es un cuadrado de `gl_PointSize` pixeles (seis vertices por punto, sin buffer de
// vertices del pipeline). Los atributos del punto se leen del buffer de vertices de la geometria (68 bytes = 17 floats por vertice:
// pos(3) nor(3) uv(2) color(3) hueso/peso(6)); packages/phoenyx/src/user-shaders/ decide que atributo de three va a cada hueco.
// En la palabra y del tercer vec4 de `draws` no hay nada: el punto es `vertex_index / 6` y la esquina `vertex_index % 6`.

@group(2) @binding(0) var<storage, read> vbuf: array<f32>;

fn vpos(i: u32) -> vec3<f32> { let b = i * 17u; return vec3<f32>(vbuf[b], vbuf[b + 1u], vbuf[b + 2u]); }
fn vnor(i: u32) -> vec3<f32> { let b = i * 17u + 3u; return vec3<f32>(vbuf[b], vbuf[b + 1u], vbuf[b + 2u]); }
fn vuv(i: u32) -> vec2<f32> { let b = i * 17u + 6u; return vec2<f32>(vbuf[b], vbuf[b + 1u]); }
fn vcol(i: u32) -> vec3<f32> { let b = i * 17u + 8u; return vec3<f32>(vbuf[b], vbuf[b + 1u], vbuf[b + 2u]); }

/// Esquina (-1..1, y hacia arriba en el clip de three) del vertice `c` (0..5) de un cuadrado.
fn corner(c: u32) -> vec2<f32> {
    var k = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
    return k[c];
}

/// gl_PointCoord de una esquina: (0, 0) arriba a la izquierda del punto.
fn point_coord(c: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
}

/// gl_Position de un punto de `size` pixeles (gl_PointSize): el cuadrado se abre en el espacio de clip de three y despues se
/// ajusta z (WebGL [-w, w] a WebGPU [0, w]) y la y de un render target, como clip_of. g.pad1.xy = tamano del destino en pixeles.
fn point_clip(mv: vec4<f32>, size: f32, c: vec2<f32>) -> vec4<f32> {
    var clip = g.proj * mv;
    clip.x += c.x * size / g.pad1.x * clip.w;
    clip.y += c.y * size / g.pad1.y * clip.w;
    clip.z = (clip.z + clip.w) * 0.5;
    if (g.pad0.z > 0.5) {
        clip.y = -clip.y;
    }
    return clip;
}
