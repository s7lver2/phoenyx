// Escena GPU-driven: varios modelos x varios LOD, error en pantalla, 3 pasadas de compute
// (count -> scan -> scatter) y draws indirectos. Un slot de `vis` por instancia como maximo.
struct Globals {
  view_proj: mat4x4<f32>,
  cam: vec4<f32>,          // xyz camara, w = factor de proyeccion (px por unidad a distancia 1)
  planes: array<vec4<f32>, 6>,
  misc: vec4<f32>,         // n instancias, n modelos, n LOD, tolerancia de error (px)
  light: vec4<f32>,
  inv_vp: mat4x4<f32>,
  grid: vec4<f32>,         // ancho, alto de pantalla, near y far del clustering de luces
  vw: vec4<f32>,           // x: vista ortografica (sombras), y: px por unidad (ortografica), z: sin fundido de LOD, w: n luces
};

@group(0) @binding(0) var<uniform> g: Globals;
// 2 vec4 por instancia: (pos, escala) y (modelo, yaw, hash, 0)
@group(0) @binding(1) var<storage, read> inst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> lodinfo: array<f32>;      // 16 floats por modelo: radio, err0..err9, 2 libres, base, alto, 1 libre
@group(0) @binding(3) var<storage, read_write> args: array<atomic<u32>>; // 5 u32 por draw
@group(0) @binding(4) var<storage, read_write> cur: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> vis: array<u32>;

// Seleccion de LOD con fundido: el nivel fino se dibuja siempre; si el siguiente nivel grueso esta
// a punto de ser aceptable (error entre 1x y FADE_W x la tolerancia) tambien se emite el grueso y
// ambos se reparten los pixeles con un dither complementario (sin saltos visibles).
const FADE_W = 1.6;
struct Pick {
  d0: i32,   // draw del nivel fino (o unico)
  d1: i32,   // draw del nivel grueso en fundido, o -1
  t: u32,    // peso del grueso, 0..127
};

fn pick(i: u32) -> Pick {
  var o = Pick(-1, -1, 0u);
  let a = inst[2u * i];
  let b = inst[2u * i + 1u];
  let r = a.w;
  for (var p = 0u; p < 6u; p++) {
    if (dot(g.planes[p].xyz, a.xyz) + g.planes[p].w < -r) { return o; }
  }
  let d = max(distance(a.xyz, g.cam.xyz), 0.001);
  let k = select(g.cam.w * r / d, g.vw.y * r, g.vw.x > 0.5);   // px por unidad de error del modelo
  if (2.0 * k < 1.0) { return o; }    // menor de 1 px: no se dibuja
  let m = u32(b.x);
  let nl = u32(g.misc.z);
  var l = 0u;
  // LOD mas grueso cuyo error proyectado cabe en la tolerancia.
  for (var kk = 0u; kk + 1u < nl; kk++) {
    let c = nl - 1u - kk;
    if (lodinfo[m * 16u + 1u + c] * k <= g.misc.w) { l = c; break; }
  }
  o.d0 = i32(m * nl + l);
  if (l + 1u < nl) {
    let ratio = lodinfo[m * 16u + 2u + l] * k / g.misc.w;   // error del nivel siguiente / tolerancia
    if (ratio < FADE_W && g.vw.z < 0.5) {
      o.t = u32(clamp((FADE_W - ratio) / (FADE_W - 1.0), 0.0, 1.0) * 127.0);
      if (o.t > 0u) { o.d1 = o.d0 + 1; }
    }
  }
  return o;
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= u32(g.misc.x)) { return; }
  let p = pick(id.x);
  if (p.d0 >= 0) { atomicAdd(&args[u32(p.d0) * 5u + 1u], 1u); }
  if (p.d1 >= 0) { atomicAdd(&args[u32(p.d1) * 5u + 1u], 1u); }
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
  let p = pick(id.x);
  // vis = instancia | peso (7 bits) << 24 | rol (bit 31: 1 = copia gruesa)
  if (p.d0 >= 0) {
    let off = atomicLoad(&args[u32(p.d0) * 5u + 4u]);
    let k = atomicAdd(&cur[u32(p.d0)], 1u);
    vis[off + k] = id.x | (p.t << 24u);
  }
  if (p.d1 >= 0) {
    let off = atomicLoad(&args[u32(p.d1) * 5u + 4u]);
    let k = atomicAdd(&cur[u32(p.d1)], 1u);
    vis[off + k] = id.x | (p.t << 24u) | 0x80000000u;
  }
}

// ---- Luces en clusters (culling en GPU) y sombras del sol ----
struct Sh {
  vp: array<mat4x4<f32>, 2>,
  split: vec4<f32>,   // profundidad de corte de cada cascada, w = sombras activas
  sun: vec4<f32>,     // rgb radiancia del sol, w = escala del ambiente
  texel: vec4<f32>,   // tamano de texel (m) de cada cascada, z = 1 / resolucion
};
@group(3) @binding(3) var shadow_t: texture_depth_2d_array;
@group(3) @binding(4) var shadow_s: sampler_comparison;
@group(3) @binding(5) var<uniform> sh: Sh;
@group(3) @binding(6) var<storage, read> lights: array<vec4<f32>>;       // 2 vec4 por luz: (pos, radio), (color*intensidad, 0)
@group(3) @binding(7) var<storage, read_write> cl: array<u32>;           // por cluster: n, indices (32 u32)

const CX = 16u;
const CY = 9u;
const CZ = 24u;
const NEAR = 0.3;
const FAR = 4000.0;
const PI = 3.14159265;

@compute @workgroup_size(64)
fn cluster_cull(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= CX * CY * CZ) { return; }
  let cx = id.x % CX;
  let cy = (id.x / CX) % CY;
  let cz = id.x / (CX * CY);
  let n0 = g.grid.z;
  let f0 = g.grid.w;
  let d0 = n0 * pow(f0 / n0, f32(cz) / f32(CZ));
  let d1 = n0 * pow(f0 / n0, f32(cz + 1u) / f32(CZ));
  let z0 = (FAR / (FAR - NEAR)) * (1.0 - NEAR / d0);
  let z1 = (FAR / (FAR - NEAR)) * (1.0 - NEAR / d1);
  let x0 = f32(cx) / f32(CX) * 2.0 - 1.0;
  let x1 = f32(cx + 1u) / f32(CX) * 2.0 - 1.0;
  let y0 = 1.0 - f32(cy + 1u) / f32(CY) * 2.0;
  let y1 = 1.0 - f32(cy) / f32(CY) * 2.0;
  var lo = vec3<f32>(1e30);
  var hi = vec3<f32>(-1e30);
  for (var i = 0u; i < 8u; i++) {
    let p = g.inv_vp * vec4<f32>(select(x0, x1, (i & 1u) != 0u), select(y0, y1, (i & 2u) != 0u),
                                  select(z0, z1, (i & 4u) != 0u), 1.0);
    let w = p.xyz / p.w;
    lo = min(lo, w);
    hi = max(hi, w);
  }
  let base = id.x * 32u;
  var cnt = 0u;
  let nl = u32(g.vw.w);
  for (var li = 0u; li < nl && cnt < 31u; li++) {
    let a = lights[li * 2u];
    let q = clamp(a.xyz, lo, hi);
    let d = q - a.xyz;
    if (dot(d, d) <= a.w * a.w) {
      cl[base + 1u + cnt] = li;
      cnt++;
    }
  }
  cl[base] = cnt;
}

fn shadow_at(w: vec3<f32>, n: vec3<f32>, depth: f32) -> f32 {
  if (sh.split.w < 0.5 || depth > sh.split.y) { return 1.0; }
  let far = depth > sh.split.x;
  let texel = select(sh.texel.x, sh.texel.y, far);
  let wp = w + n * texel * 2.5;
  let lp = sh.vp[select(0, 1, far)] * vec4<f32>(wp, 1.0);
  let uv = vec2<f32>(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0)) || lp.z > 1.0) { return 1.0; }
  let layer = select(0, 1, far);
  var s = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      s += textureSampleCompareLevel(shadow_t, shadow_s, uv + vec2<f32>(f32(dx), f32(dy)) * sh.texel.z, layer, lp.z - 0.0005);
    }
  }
  return s / 9.0;
}

// BRDF Cook-Torrance (GGX + Smith + Schlick); devuelve color * N.L. Escalado por PI para
// mantener el brillo de la iluminacion anterior (el difuso no se divide entre PI).
fn brdf(l: vec3<f32>, rad: vec3<f32>, n: vec3<f32>, v: vec3<f32>, alb: vec3<f32>,
        rough: f32, metal: f32, f0: vec3<f32>) -> vec3<f32> {
  let nl = max(dot(n, l), 0.0);
  if (nl <= 0.0) { return vec3<f32>(0.0); }
  let h = normalize(l + v);
  let nh = max(dot(n, h), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let vh = max(dot(v, h), 0.0);
  let a2 = rough * rough * rough * rough;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let d = a2 / (PI * dd * dd);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let gs = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  let f = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vh, 5.0);
  let spec = d * gs * f / (4.0 * nl * nv);
  let kd = (vec3<f32>(1.0) - f) * (1.0 - metal);
  return (kd * alb + spec * PI) * rad * nl;
}

fn lit_surface(wpos: vec3<f32>, n: vec3<f32>, view: vec3<f32>, alb: vec3<f32>, rough_in: f32,
               metal: f32, ao: f32, frag: vec2<f32>, depth: f32) -> vec3<f32> {
  let rough = clamp(rough_in, 0.06, 1.0);
  let f0 = mix(vec3<f32>(0.04), alb, metal);
  var col = brdf(g.light.xyz, sh.sun.rgb, n, view, alb, rough, metal, f0) * shadow_at(wpos, n, depth);
  let amb = mix(vec3<f32>(0.30, 0.24, 0.17), vec3<f32>(0.42, 0.52, 0.72), n.y * 0.5 + 0.5) * sh.sun.w;
  col += alb * (1.0 - metal) * amb * ao;
  // Luces puntuales: solo las del cluster del fragmento.
  let cx = min(u32(frag.x / g.grid.x * f32(CX)), CX - 1u);
  let cy = min(u32(frag.y / g.grid.y * f32(CY)), CY - 1u);
  let cz = u32(clamp(log(depth / g.grid.z) / log(g.grid.w / g.grid.z) * f32(CZ), 0.0, f32(CZ - 1u)));
  let base = ((cz * CY + cy) * CX + cx) * 32u;
  let cnt = cl[base];
  for (var i = 0u; i < cnt; i++) {
    let li = cl[base + 1u + i];
    let a = lights[li * 2u];
    let c = lights[li * 2u + 1u];
    let d = a.xyz - wpos;
    let d2 = dot(d, d);
    let r = a.w;
    if (d2 >= r * r) { continue; }
    let dist = sqrt(d2);
    let q = d2 / (r * r);
    let win = clamp(1.0 - q * q, 0.0, 1.0);
    col += brdf(d / dist, c.rgb * (win * win / (d2 + 0.5)), n, view, alb, rough, metal, f0);
  }
  return col;
}

// ---- Sombras: solo posicion ----
@vertex
fn vs_shadow(@location(0) p: vec4<f32>, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
  let i = visr[ii] & 0x00FFFFFFu;
  let a = inst[2u * i];
  let b = inst[2u * i + 1u];
  let c = cos(b.y);
  let s = sin(b.y);
  return g.view_proj * vec4<f32>(a.xyz + yaw(p.xyz, c, s) * a.w, 1.0);
}

// ---- Render ----
@group(1) @binding(0) var<storage, read> visr: array<u32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) n: vec3<f32>,
  @location(1) col: vec3<f32>,
  @location(2) dist: f32,
  @location(3) rad: f32,
  @location(4) t: vec3<f32>,
  @location(5) bs: f32,
  @location(6) uv: vec2<f32>,
  @location(7) @interpolate(flat) layer: u32,
  @location(8) wpos: vec3<f32>,
  @location(9) @interpolate(flat) fade: u32,   // peso (7 bits) y rol (bit 7) del fundido de LOD
};

@group(2) @binding(0) var tbase: texture_2d_array<f32>;
@group(2) @binding(1) var tnorm: texture_2d_array<f32>;
@group(2) @binding(2) var torm: texture_2d_array<f32>;
@group(2) @binding(3) var tsamp: sampler;

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
fn vs(@location(0) p: vec4<f32>, @location(1) e: vec2<f32>, @location(2) tg: vec2<f32>,
      @location(3) uv: vec2<f32>, @builtin(instance_index) ii: u32) -> VOut {
  let raw = visr[ii];
  let i = raw & 0x00FFFFFFu;
  let a = inst[2u * i];
  let b = inst[2u * i + 1u];
  let c = cos(b.y);
  let s = sin(b.y);
  let w = a.xyz + yaw(p.xyz, c, s) * a.w;
  var o: VOut;
  o.pos = g.view_proj * vec4<f32>(w, 1.0);
  o.n = yaw(unoct(e), c, s);
  o.t = yaw(unoct(tg), c, s);
  o.bs = select(-1.0, 1.0, p.w >= 0.0);
  o.uv = uv;
  o.layer = u32(b.x);
  o.wpos = w;
  o.fade = (raw >> 24u) & 0xFFu;
  let m = b.x;
  let tint = select(0.8 + 0.4 * b.z, 0.96 + 0.08 * b.z, g.light.w > 0.5);
  // light.w = 1: estatuas de marmol; si no, paleta por modelo.
  let stone = tint * vec3<f32>(0.86, 0.84, 0.79);
  let pal = tint * (vec3<f32>(0.55, 0.5, 0.42) + 0.35 * vec3<f32>(
      sin(m * 1.7 + 0.0), sin(m * 2.3 + 2.0), sin(m * 3.1 + 4.0)) * 0.5);
  o.col = select(pal, stone, g.light.w > 0.5);
  o.dist = distance(w, g.cam.xyz);
  o.rad = length(p.xyz);
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let ft = f32(v.fade & 0x7Fu) / 127.0;
  if (ft > 0.0) {
    // Ruido de gradiente entrelazado; la copia gruesa y la fina usan el mismo umbral (complementarias).
    let nz = fract(52.9829189 * fract(dot(v.pos.xy, vec2<f32>(0.06711056, 0.00583715))));
    let coarse = (v.fade & 0x80u) != 0u;
    if (!select(nz >= ft, nz < ft, coarse)) { discard; }
  }
  if (g.light.w > 1.5) {
    // Modo texturizado: base sRGB, mapa de normales y ORM; iluminacion en lineal y gamma al final.
    let albedo = textureSample(tbase, tsamp, v.uv, v.layer).rgb;
    let nm = textureSample(tnorm, tsamp, v.uv, v.layer).xyz * 2.0 - 1.0;
    let orm = textureSample(torm, tsamp, v.uv, v.layer).rgb;
    let n0 = normalize(v.n);
    let tt = normalize(v.t - n0 * dot(n0, v.t));
    let bb = cross(n0, tt) * v.bs;
    let nn = normalize(tt * nm.x + bb * nm.y + n0 * nm.z);
    let view = normalize(g.cam.xyz - v.wpos);
    // Contacto con el suelo: polvo y oscurecimiento en la base de rocas y estatuas.
    let gy = smoothstep(0.0, 0.8, v.wpos.y);
    let dust = vec3<f32>(0.40, 0.27, 0.15) * (1.0 - smoothstep(0.0, 0.45, v.wpos.y));
    let alb2 = mix(albedo, dust, 0.45 * (1.0 - smoothstep(0.0, 0.5, v.wpos.y)));
    var lit = lit_surface(v.wpos, nn, view, alb2, orm.g, orm.b, orm.r * mix(0.55, 1.0, gy), v.pos.xy, 1.0 / v.pos.w);
    lit = vec3<f32>(1.0) - exp(-lit * 1.15);
    let fogt = clamp(v.dist / 2500.0, 0.0, 1.0);
    let hazel = pow(vec3<f32>(0.80, 0.77, 0.71), vec3<f32>(2.2));
    let outl = mix(lit, hazel, fogt * fogt);
    return vec4<f32>(pow(outl, vec3<f32>(1.0 / 2.2)), 1.0);
  }
  let n = normalize(v.n);
  let flat_mode = g.light.w > 0.5;
  let sun = select(max(dot(n, g.light.xyz), 0.0),
                   pow(clamp(dot(n, g.light.xyz) * 0.6 + 0.4, 0.0, 1.0), 1.5), flat_mode);
  let sky = 0.5 + 0.5 * n.y;
  // Los valles (radio local bajo) quedan mas oscuros (rocas); las estatuas, apenas.
  let ao = select(mix(0.45, 1.0, smoothstep(0.45, 0.95, v.rad)),
                  mix(0.7, 1.0, clamp(v.rad * 3.0, 0.0, 1.0)), flat_mode);
  let lit = (sun * 0.9 + sky * 0.35) * ao;
  let fog = clamp(v.dist / 2500.0, 0.0, 1.0);
  let haze = select(vec3<f32>(0.55, 0.62, 0.72), vec3<f32>(0.80, 0.77, 0.71), flat_mode);
  return vec4<f32>(mix(v.col * lit, haze, fog * fog), 1.0);
}

// ---- Suelo (modo plano) ----
struct GOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) w: vec3<f32>,
};

@vertex
fn vs_ground(@builtin(vertex_index) vi: u32) -> GOut {
  var c = array<vec2<f32>, 6>(vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(1.0, -1.0),
                              vec2(-1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
  let q = c[vi] * 6000.0;
  let w = vec3<f32>(g.cam.x + q.x, 0.0, g.cam.z + q.y);
  var o: GOut;
  o.pos = g.view_proj * vec4<f32>(w, 1.0);
  o.w = w;
  return o;
}

fn h21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn vn(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2<f32>(1.0, 0.0)), u.x),
             mix(h21(i + vec2<f32>(0.0, 1.0)), h21(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

@group(3) @binding(0) var gbase: texture_2d_array<f32>;
@group(3) @binding(1) var gnorm: texture_2d_array<f32>;
@group(3) @binding(2) var gsamp: sampler;

@fragment
fn fs_ground(v: GOut) -> @location(0) vec4<f32> {
  let d = distance(v.w, g.cam.xyz);
  let fog = clamp(d / 2500.0, 0.0, 1.0);
  if (g.light.w > 1.5) {
    // Material Megascans tileable (1 m) a dos escalas para romper la repeticion.
    let p = v.w.xz;
    let uv1 = p;
    let uv2 = p / 5.3 + vec2<f32>(0.37, 0.71);
    let mixk = 0.35 + 0.4 * smoothstep(0.3, 0.7, vn(p * 0.05));
    let b1 = textureSample(gbase, gsamp, uv1, 0).rgb;
    let b2 = textureSample(gbase, gsamp, uv2, 0).rgb;
    var alb = mix(b1, b2, mixk) * (0.82 + 0.36 * vn(p * 0.011));
    let n1 = textureSample(gnorm, gsamp, uv1, 0);
    let n2 = textureSample(gnorm, gsamp, uv2, 0);
    let nm = normalize((mix(n1.xyz, n2.xyz, mixk)) * 2.0 - 1.0);
    let nn = normalize(vec3<f32>(nm.x, nm.z, -nm.y));
    let view = normalize(g.cam.xyz - v.w);
    var lit = lit_surface(v.w, nn, view, alb, 0.9, 0.0, 1.0, v.pos.xy, 1.0 / v.pos.w);
    lit = vec3<f32>(1.0) - exp(-lit * 1.15);
    let hazel = pow(vec3<f32>(0.80, 0.77, 0.71), vec3<f32>(2.2));
    return vec4<f32>(pow(mix(lit, hazel, fog * fog), vec3<f32>(1.0 / 2.2)), 1.0);
  }
  // Sin texturas: tierra procedural.
  let far = clamp(d / 250.0, 0.0, 1.0);
  let n = vn(v.w.xz * 0.05) * 0.5 + vn(v.w.xz * 0.6) * 0.3 + mix(vn(v.w.xz * 5.0), 0.5, far) * 0.2;
  let base = mix(vec3<f32>(0.48, 0.36, 0.25), vec3<f32>(0.68, 0.56, 0.42), n);
  return vec4<f32>(mix(base, vec3<f32>(0.80, 0.77, 0.71), fog * fog), 1.0);
}

// ---- Cielo con montanas lejanas ----
struct SOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) ndc: vec2<f32>,
};

@vertex
fn vs_sky(@builtin(vertex_index) vi: u32) -> SOut {
  var c = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: SOut;
  o.pos = vec4<f32>(c[vi], 1.0, 1.0);
  o.ndc = c[vi];
  return o;
}

fn fbm2(p: vec2<f32>) -> f32 {
  var a = 0.5;
  var s = 0.0;
  var q = p;
  for (var i = 0; i < 5; i++) {
    s += a * vn(q);
    q = q * 2.03 + vec2<f32>(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

@fragment
fn fs_sky(v: SOut) -> @location(0) vec4<f32> {
  let w4 = g.inv_vp * vec4<f32>(v.ndc, 1.0, 1.0);
  let dir = normalize(w4.xyz / w4.w - g.cam.xyz);
  let sun = g.light.xyz;
  let sd = max(dot(dir, sun), 0.0);
  let haze = vec3<f32>(0.80, 0.77, 0.71);
  // Dispersion de Rayleigh aproximada: azul profundo arriba, horizonte palido y calido hacia el sol.
  let el = clamp(dir.y, 0.0, 1.0);
  var col = mix(haze, vec3<f32>(0.14, 0.32, 0.72), pow(el, 0.5));
  col = mix(col, vec3<f32>(1.0, 0.82, 0.58), pow(sd, 6.0) * (1.0 - el) * 0.55);
  col += vec3<f32>(1.0, 0.88, 0.65) * (pow(sd, 900.0) * 6.0 + pow(sd, 48.0) * 0.45);
  // Nubes: capa plana a 1800 m con fbm, iluminadas desde el sol.
  if (dir.y > 0.012) {
    let tcl = 1800.0 / dir.y;
    let cp = (g.cam.xz + dir.xz * tcl) * 0.00045;
    let dens = smoothstep(0.50, 0.78, fbm2(cp + vec2<f32>(3.7, 1.3)));
    let edge = smoothstep(0.50, 0.78, fbm2(cp + vec2<f32>(3.7, 1.3) + sun.xz * 0.06));
    let shade = clamp(1.0 - (edge - dens) * 2.2, 0.35, 1.0);
    let ccol = mix(vec3<f32>(0.62, 0.64, 0.70), vec3<f32>(1.0, 0.97, 0.92), shade);
    col = mix(col, ccol, dens * smoothstep(0.012, 0.12, dir.y) * 0.92);
  }
  // Montanas lejanas en dos capas con perspectiva aerea.
  let az = atan2(dir.x, dir.z);
  let h1 = 0.05 + 0.035 * sin(az * 3.0 + 1.0) + 0.02 * sin(az * 7.0 + 4.0) + 0.01 * sin(az * 17.0 + 2.0);
  let h2 = 0.028 + 0.025 * sin(az * 5.0 + 2.5) + 0.012 * sin(az * 11.0 + 0.5) + 0.006 * sin(az * 29.0);
  let m1 = smoothstep(h1, h1 - 0.004, dir.y);
  let m2 = smoothstep(h2, h2 - 0.003, dir.y);
  col = mix(col, mix(haze, vec3<f32>(0.62, 0.58, 0.54), 0.5), m1);
  col = mix(col, mix(haze, vec3<f32>(0.50, 0.45, 0.40), 0.55), m2);
  return vec4<f32>(col, 1.0);
}
