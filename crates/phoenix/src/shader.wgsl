// Culling + LOD en GPU y dibujo indirecto. Una instancia = (xyz, escala).
struct Globals {
  view_proj: mat4x4<f32>,
  cam: vec4<f32>,          // xyz posicion de camara
  planes: array<vec4<f32>, 6>,
  lod: vec4<f32>,          // distancias de corte LOD0/LOD1, radio de la malla, n
  light: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> inst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> vis0: array<u32>;
@group(0) @binding(4) var<storage, read_write> vis1: array<u32>;
@group(0) @binding(5) var<storage, read_write> vis2: array<u32>;

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= u32(g.lod.w)) { return; }
  let it = inst[i];
  let r = it.w * g.lod.z;
  for (var p = 0u; p < 6u; p++) {
    if (dot(g.planes[p].xyz, it.xyz) + g.planes[p].w < -r) { return; }
  }
  // LOD por tamano en pantalla (px de diametro); lo sub-pixel se descarta.
  let d = max(distance(it.xyz, g.cam.xyz), 0.001);
  let px = 2.0 * r * g.cam.w / d;
  if (px < 1.5) { return; }
  // Cada LOD tiene su propio array de visibles y su propio argumento indirecto.
  if (px > g.lod.x) {
    let k = atomicAdd(&args[1], 1u); vis0[k] = i;
  } else if (px > g.lod.y) {
    let k = atomicAdd(&args[6], 1u); vis1[k] = i;
  } else {
    let k = atomicAdd(&args[11], 1u); vis2[k] = i;
  }
}

// Render: el vertice es solo la posicion; en una esfera unitaria normal = posicion.
@group(1) @binding(0) var<storage, read> vis: array<u32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) n: vec3<f32>,
  @location(1) col: vec3<f32>,
  @location(2) dist: f32,
};

@vertex
fn vs(@location(0) p: vec3<f32>, @builtin(instance_index) ii: u32) -> VOut {
  let i = vis[ii];
  let it = inst[i];
  let w = it.xyz + p * it.w;
  var o: VOut;
  o.pos = g.view_proj * vec4<f32>(w, 1.0);
  o.n = p;
  let h = f32(((i * 2654435761u) >> 8u) & 0xffffu) / 65535.0;
  o.col = mix(vec3<f32>(0.75, 0.62, 0.25), vec3<f32>(0.9, 0.85, 0.5), h);
  o.dist = distance(w, g.cam.xyz);
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let l = max(dot(normalize(v.n), g.light.xyz), 0.0) * 0.8 + 0.2;
  let fog = clamp(v.dist / 1400.0, 0.0, 1.0);
  return vec4<f32>(mix(v.col * l, vec3<f32>(0.08, 0.07, 0.03), fog * fog), 1.0);
}
