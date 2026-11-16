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
    lit = aces(lit * sh.texel.w);
    let fogt = clamp(v.dist / 2500.0, 0.0, 1.0);
    let hazel = pow(horizon_col(g.light.y), vec3<f32>(2.2));
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
    lit = aces(lit * sh.texel.w);
    let hazel = pow(horizon_col(g.light.y), vec3<f32>(2.2));
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
  let se = sun.y;
  let day = day_k(se);
  let haze = horizon_col(se);
  // Dispersion de Rayleigh aproximada: cenit segun la hora, horizonte calido hacia el sol.
  let el = clamp(dir.y, 0.0, 1.0);
  let zen = mix(vec3<f32>(0.004, 0.008, 0.03), vec3<f32>(0.14, 0.32, 0.72), day);
  var col = mix(haze, zen, pow(el, 0.5));
  let warm = exp(-abs(se) * 7.0) * day_k(se + 0.1);
  let suncol = mix(vec3<f32>(1.0, 0.45, 0.2), vec3<f32>(1.0, 0.88, 0.65), clamp(se * 3.0, 0.0, 1.0));
  col = mix(col, suncol, pow(sd, 6.0) * (1.0 - el) * 0.55 * day_k(se + 0.1));
  col += suncol * (pow(sd, 900.0) * 6.0 + pow(sd, 48.0) * 0.45) * smoothstep(-0.06, 0.02, se);
  // Estrellas de noche.
  if (dir.y > 0.0 && day < 0.7) {
    let cell = floor(dir * 260.0);
    let hh = fract(sin(dot(cell, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453);
    col += vec3<f32>(0.9, 0.95, 1.0) * step(0.9975, hh) * (hh - 0.9975) * 400.0 * (1.0 - day / 0.7) * smoothstep(0.0, 0.12, dir.y);
  }
  // Nubes: capa plana a 1800 m con fbm, iluminadas desde el sol.
  if (dir.y > 0.012) {
    let tcl = 1800.0 / dir.y;
    let cp = (g.cam.xz + dir.xz * tcl) * 0.00045;
    let dens = smoothstep(0.50, 0.78, fbm2(cp + vec2<f32>(3.7, 1.3)));
    let edge = smoothstep(0.50, 0.78, fbm2(cp + vec2<f32>(3.7, 1.3) + sun.xz * 0.06));
    let shade = clamp(1.0 - (edge - dens) * 2.2, 0.35, 1.0);
    var ccol = mix(vec3<f32>(0.62, 0.64, 0.70), vec3<f32>(1.0, 0.97, 0.92), shade);
    ccol = mix(ccol, suncol, warm * 0.6) * mix(0.06, 1.0, day);
    col = mix(col, ccol, dens * smoothstep(0.012, 0.12, dir.y) * 0.92);
  }
  // Montanas lejanas en dos capas con perspectiva aerea.
  let az = atan2(dir.x, dir.z);
  let h1 = 0.05 + 0.035 * sin(az * 3.0 + 1.0) + 0.02 * sin(az * 7.0 + 4.0) + 0.01 * sin(az * 17.0 + 2.0);
  let h2 = 0.028 + 0.025 * sin(az * 5.0 + 2.5) + 0.012 * sin(az * 11.0 + 0.5) + 0.006 * sin(az * 29.0);
  let m1 = smoothstep(h1, h1 - 0.004, dir.y);
  let m2 = smoothstep(h2, h2 - 0.003, dir.y);
  let mk = mix(0.12, 1.0, day);
  col = mix(col, mix(haze, vec3<f32>(0.62, 0.58, 0.54) * mk, 0.5), m1);
  col = mix(col, mix(haze, vec3<f32>(0.50, 0.45, 0.40) * mk, 0.55), m2);
  return vec4<f32>(col, 1.0);
}
