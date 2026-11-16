// Escena GPU-driven: varios modelos x varios LOD, error en pantalla, 3 pasadas de compute
// (count -> scan -> scatter) y draws indirectos. Un slot de `vis` por instancia como maximo.
struct Globals {
  view_proj: mat4x4<f32>,
  cam: vec4<f32>,          // xyz camara, w = factor de proyeccion (px por unidad a distancia 1)
  planes: array<vec4<f32>, 6>,
  misc: vec4<f32>,         // n instancias, n modelos, n LOD, tolerancia de error (px)
  light: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
// 2 vec4 por instancia: (pos, escala) y (modelo, yaw, hash, 0)
@group(0) @binding(1) var<storage, read> inst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> lodinfo: array<f32>;      // 8 floats por modelo: radio, err0..err5, pad
@group(0) @binding(3) var<storage, read_write> args: array<atomic<u32>>; // 5 u32 por draw
@group(0) @binding(4) var<storage, read_write> cur: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> vis: array<u32>;

// Devuelve el draw (modelo * LOD + lod) de la instancia, o -1 si no se dibuja.
fn pick(i: u32) -> i32 {
  let a = inst[2u * i];
  let b = inst[2u * i + 1u];
  let r = a.w;
  for (var p = 0u; p < 6u; p++) {
    if (dot(g.planes[p].xyz, a.xyz) + g.planes[p].w < -r) { return -1; }
  }
  let d = max(distance(a.xyz, g.cam.xyz), 0.001);
  let k = g.cam.w * r / d;            // px por unidad de error del modelo
  if (2.0 * k < 1.0) { return -1; }   // menor de 1 px: no se dibuja
  let m = u32(b.x);
  let nl = u32(g.misc.z);
  var l = 0u;
  // LOD mas grueso cuyo error proyectado cabe en la tolerancia.
  for (var kk = 0u; kk + 1u < nl; kk++) {
    let c = nl - 1u - kk;
    if (lodinfo[m * 8u + 1u + c] * k <= g.misc.w) { l = c; break; }
  }
  return i32(m * nl + l);
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(g.misc.x)) { return; }
  let d = pick(id.x);
  if (d >= 0) { atomicAdd(&args[u32(d) * 5u + 1u], 1u); }
}

@compute @workgroup_size(1)
fn scan() {
  var run = 0u;
  let n = u32(g.misc.y) * u32(g.misc.z);
  for (var d = 0u; d < n; d++) {
    atomicStore(&args[d * 5u + 4u], run);          // first_instance = desplazamiento en vis
    run += atomicLoad(&args[d * 5u + 1u]);
  }
}

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(g.misc.x)) { return; }
  let d = pick(id.x);
  if (d < 0) { return; }
  let off = atomicLoad(&args[u32(d) * 5u + 4u]);
  let k = atomicAdd(&cur[u32(d)], 1u);
  vis[off + k] = id.x;
}

// ---- Render ----
@group(1) @binding(0) var<storage, read> visr: array<u32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) n: vec3<f32>,
  @location(1) col: vec3<f32>,
  @location(2) dist: f32,
  @location(3) rad: f32,
};

fn unoct(e: vec2<f32>) -> vec3<f32> {
  var v = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    let s = vec2<f32>(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
    let t = (vec2<f32>(1.0) - abs(vec2<f32>(v.y, v.x))) * s;
    v = vec3<f32>(t.x, t.y, v.z);
  }
  return normalize(v);
}

fn yaw(v: vec3<f32>, c: f32, s: f32) -> vec3<f32> {
  return vec3<f32>(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

@vertex
fn vs(@location(0) p: vec4<f32>, @location(1) e: vec2<f32>, @builtin(instance_index) ii: u32) -> VOut {
  let i = visr[ii];
  let a = inst[2u * i];
  let b = inst[2u * i + 1u];
  let c = cos(b.y);
  let s = sin(b.y);
  let w = a.xyz + yaw(p.xyz, c, s) * a.w;
  var o: VOut;
  o.pos = g.view_proj * vec4<f32>(w, 1.0);
  o.n = yaw(unoct(e), c, s);
  let m = b.x;
  let tint = 0.8 + 0.4 * b.z;
  o.col = tint * (vec3<f32>(0.55, 0.5, 0.42) + 0.35 * vec3<f32>(
      sin(m * 1.7 + 0.0), sin(m * 2.3 + 2.0), sin(m * 3.1 + 4.0)) * 0.5);
  o.dist = distance(w, g.cam.xyz);
  o.rad = length(p.xyz);
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let n = normalize(v.n);
  let sun = max(dot(n, g.light.xyz), 0.0);
  let sky = 0.5 + 0.5 * n.y;
  // Los valles (radio local bajo) quedan mas oscuros.
  let ao = mix(0.45, 1.0, smoothstep(0.45, 0.95, v.rad));
  let lit = (sun * 0.9 + sky * 0.35) * ao;
  let fog = clamp(v.dist / 2500.0, 0.0, 1.0);
  let haze = vec3<f32>(0.55, 0.62, 0.72);
  return vec4<f32>(mix(v.col * lit, haze, fog * fog), 1.0);
}
