// Personajes con huesos: las matrices de cada fotograma vienen horneadas (phoenix-bake --kind skin);
// el vertex shader mezcla dos fotogramas y 4 huesos por vertice. Sin CPU por frame.
struct Globals {
  view_proj: mat4x4<f32>,
  cam: vec4<f32>,
  planes: array<vec4<f32>, 6>,
  misc: vec4<f32>,
  light: vec4<f32>,
  inv_vp: mat4x4<f32>,
  grid: vec4<f32>,
  prev_vp: mat4x4<f32>,
  vw: vec4<f32>,
  tune: vec4<f32>,
};
@group(0) @binding(0) var<uniform> g: Globals;

@group(1) @binding(0) var<storage, read> bones: array<vec4<f32>>;   // 3 filas por hueso y fotograma
@group(1) @binding(1) var<storage, read> clips: array<vec4<f32>>;   // primer fotograma, fotogramas, fps, duracion
@group(1) @binding(2) var<storage, read> sinst: array<vec4<f32>>;   // 2 por instancia: (pos, escala), (yaw, clip, tiempo, 0)
@group(1) @binding(3) var<uniform> sk: vec4<f32>;                   // x = numero de huesos
@group(2) @binding(0) var sbase: texture_2d<f32>;
@group(2) @binding(1) var ssamp: sampler;

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) joints: vec4<u32>,
  @location(4) weights: vec4<f32>,
};
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) n: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

// Matriz de hueso mezclada entre dos fotogramas, como 3 filas.
fn pose(f0: u32, f1: u32, a: f32, j: u32, nb: u32, w: f32, acc: ptr<function, array<vec4<f32>, 3>>) {
  let b0 = (f0 * nb + j) * 3u;
  let b1 = (f1 * nb + j) * 3u;
  for (var r = 0u; r < 3u; r++) {
    (*acc)[r] += mix(bones[b0 + r], bones[b1 + r], a) * w;
  }
}

fn skin_vertex(v: VIn, ii: u32) -> VOut {
  let i0 = sinst[ii * 2u];
  let i1 = sinst[ii * 2u + 1u];
  let c = clips[u32(i1.y)];
  let nb = u32(sk.x);
  let frames = u32(c.y);
  let f = i1.z * c.z;
  let fl = floor(f);
  let a = f - fl;
  let k0 = u32(fl) % frames;
  let k1 = (k0 + 1u) % frames;
  let first = u32(c.x);
  var m = array<vec4<f32>, 3>(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0));
  for (var k = 0u; k < 4u; k++) {
    if (v.weights[k] > 0.0) {
      pose(first + k0, first + k1, a, v.joints[k], nb, v.weights[k], &m);
    }
  }
  let p4 = vec4<f32>(v.pos, 1.0);
  let lp = vec3<f32>(dot(m[0], p4), dot(m[1], p4), dot(m[2], p4));
  let ln = vec3<f32>(dot(m[0].xyz, v.nrm), dot(m[1].xyz, v.nrm), dot(m[2].xyz, v.nrm));
  // Giro en Y (mismo convenio que las instancias estaticas) y escala.
  let cy = cos(i1.x);
  let sy = sin(i1.x);
  let rot = mat3x3<f32>(vec3<f32>(cy, 0.0, -sy), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(sy, 0.0, cy));
  let w = rot * (lp * i0.w) + i0.xyz;
  var o: VOut;
  o.wpos = w;
  o.n = normalize(rot * ln);
  o.uv = v.uv;
  o.pos = g.view_proj * vec4<f32>(w, 1.0);
  return o;
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  return skin_vertex(v, ii);
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let albedo = textureSample(sbase, ssamp, v.uv).rgb;
  let n = normalize(v.n);
  let view = normalize(g.cam.xyz - v.wpos);
  let lit = lit_surface(v.wpos, n, view, albedo, 0.7, 0.0, 1.0, v.pos.xy, 1.0 / v.pos.w);
  return vec4<f32>(lit, 1.0);
}

// Solo profundidad para los mapas de sombra (misma pose que el render).
@vertex
fn vs_shadow(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  return skin_vertex(v, ii).pos;
}
