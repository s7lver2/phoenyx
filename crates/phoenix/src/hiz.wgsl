// Piramide Hi-Z: cada nivel guarda la profundidad MAS LEJANA de 2x2 texels del nivel anterior.
// El nivel 0 es la mitad de la resolucion de pantalla. Se usa en el culling del frame siguiente.
@group(0) @binding(0) var depth_t: texture_depth_2d;
@group(0) @binding(1) var src: texture_2d<f32>;

struct FOut {
  @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> FOut {
  var c = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: FOut;
  o.pos = vec4<f32>(c[vi], 0.0, 1.0);
  return o;
}

@fragment
fn fs_hiz0(v: FOut) -> @location(0) f32 {
  let dims = vec2<i32>(textureDimensions(depth_t));
  let p = vec2<i32>(v.pos.xy) * 2;
  var m = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      m = max(m, textureLoad(depth_t, min(p + vec2<i32>(i, j), dims - vec2<i32>(1)), 0));
    }
  }
  return m;
}

@fragment
fn fs_hizn(v: FOut) -> @location(0) f32 {
  let dims = vec2<i32>(textureDimensions(src));
  let p = vec2<i32>(v.pos.xy) * 2;
  var m = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      m = max(m, textureLoad(src, min(p + vec2<i32>(i, j), dims - vec2<i32>(1)), 0).r);
    }
  }
  return m;
}
