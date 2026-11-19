// lux: iluminacion en GPU. PBR (GGX), sol con sombras en cascadas, luna, y luces puntuales,
// focos y tubos fluorescentes con culling por clusters en compute.
//
// Contrato con el modulo que incluye este archivo:
//  - declara `g: Globals` con los campos `cam` (xyz camara), `light` (xyz direccion al sol),
//    `inv_vp`, `grid` (ancho, alto, near y far del clustering) y `vw` (w = numero de luces);
//  - el grupo de bind 3 sigue el layout de `Lux::layout_entries` (bindings 3..=7);
//  - los bindings 0..=2 del grupo 3 son libres para el modulo anfitrion.

struct Sh {
  vp: array<mat4x4<f32>, 2>,
  split: vec4<f32>,      // profundidad de corte de cada cascada, w = sombras activas
  sun: vec4<f32>,        // rgb radiancia del sol, w = escala del ambiente
  texel: vec4<f32>,      // tamano de texel (m) por cascada, z = 1 / resolucion, w = exposicion
  moon_dir: vec4<f32>,
  moon_rad: vec4<f32>,
  ambient: vec4<f32>,    // rgb = ambiente plano (interiores); w > 0 lo activa en lugar del ambiente por hora
  spot_vp: array<mat4x4<f32>, 4>,   // vista-proyeccion de los focos con sombra (capas 2..5)
};
@group(3) @binding(3) var shadow_t: texture_depth_2d_array;
@group(3) @binding(4) var shadow_s: sampler_comparison;
@group(3) @binding(5) var<uniform> sh: Sh;
// 3 vec4 por luz: (pos, radio), (color * intensidad, tipo), (dir / eje, cos del cono / semilargo del tubo)
@group(3) @binding(6) var<storage, read> lights: array<vec4<f32>>;
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
    let a = lights[li * 3u];
    let kind = u32(lights[li * 3u + 1u].w + 0.5);
    // Los tubos se acotan con una esfera que incluye su semilargo.
    let rad = a.w + select(0.0, lights[li * 3u + 2u].w, kind == 2u);
    let q = clamp(a.xyz, lo, hi);
    let d = q - a.xyz;
    if (dot(d, d) <= rad * rad) {
      cl[base + 1u + cnt] = li;
      cnt++;
    }
  }
  cl[base] = cnt;
}

// ---- Sombras del sol: PCF con disco de Poisson rotado por pixel, bias por pendiente ----
fn sc(ci: u32, w: vec3<f32>, n: vec3<f32>, nl: f32, rot: vec2<f32>) -> f32 {
  var pois = array<vec2<f32>, 12>(
    vec2<f32>(-0.326, -0.406), vec2<f32>(-0.840, -0.074), vec2<f32>(-0.696, 0.457), vec2<f32>(-0.203, 0.621),
    vec2<f32>(0.962, -0.195), vec2<f32>(0.473, -0.480), vec2<f32>(0.519, 0.767), vec2<f32>(0.185, -0.893),
    vec2<f32>(0.507, 0.064), vec2<f32>(0.896, 0.412), vec2<f32>(-0.322, -0.933), vec2<f32>(-0.792, -0.598));
  let texel = sh.texel[ci];
  let range = 1.0 / abs(sh.vp[ci][2][2]);
  let wp = w + n * texel * (1.2 + 2.5 * (1.0 - nl));
  let lp = sh.vp[ci] * vec4<f32>(wp, 1.0);
  let uv = vec2<f32>(lp.x * 0.5 + 0.5, 0.5 - lp.y * 0.5);
  if (any(uv < vec2<f32>(0.03)) || any(uv > vec2<f32>(0.97)) || lp.z > 1.0) { return -1.0; }
  let zb = lp.z - texel * (0.5 + 2.0 * (1.0 - nl)) / range;
  var s = 0.0;
  for (var i = 0u; i < 12u; i++) {
    let o = vec2<f32>(pois[i].x * rot.x - pois[i].y * rot.y, pois[i].x * rot.y + pois[i].y * rot.x);
    s += textureSampleCompareLevel(shadow_t, shadow_s, uv + o * sh.texel.z * 2.2, i32(ci), zb);
  }
  return s / 12.0;
}

fn shadow_at(w: vec3<f32>, n: vec3<f32>, depth: f32, frag: vec2<f32>) -> f32 {
  if (sh.split.w < 0.5 || depth > sh.split.y) { return 1.0; }
  let nl = clamp(dot(n, g.light.xyz), 0.0, 1.0);
  let ang = 6.2831853 * fract(52.9829189 * fract(dot(frag, vec2<f32>(0.06711056, 0.00583715))));
  let rot = vec2<f32>(cos(ang), sin(ang));
  let b0 = sh.split.x * 0.85;
  var s = 1.0;
  if (depth < b0) {
    let a = sc(0u, w, n, nl, rot);
    if (a >= 0.0) {
      s = a;
    } else {
      let b = sc(1u, w, n, nl, rot);
      s = select(b, 1.0, b < 0.0);
    }
  } else if (depth < sh.split.x) {
    let a = sc(0u, w, n, nl, rot);
    let b = sc(1u, w, n, nl, rot);
    let bb = select(b, 1.0, b < 0.0);
    s = select(mix(a, bb, (depth - b0) / (sh.split.x - b0)), bb, a < 0.0);
  } else {
    let b = sc(1u, w, n, nl, rot);
    s = select(b, 1.0, b < 0.0);
  }
  // Fundido al final de la ultima cascada.
  return mix(s, 1.0, smoothstep(sh.split.y * 0.8, sh.split.y, depth));
}

// Sombra de un foco: mapa en perspectiva en la capa 2 + slot. Offset por la normal y bias
// proporcionales al tamano del texel en el punto.
fn spot_shadow(slot: u32, w: vec3<f32>, n: vec3<f32>, lpos: vec3<f32>) -> f32 {
  let dist = distance(w, lpos);
  let wp = w + n * (dist * 0.003);
  let lp = sh.spot_vp[slot] * vec4<f32>(wp, 1.0);
  if (lp.w <= 0.0) { return 1.0; }
  let ndc = lp.xyz / lp.w;
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0)) || ndc.z > 1.0) { return 1.0; }
  let z = ndc.z - 0.002 / (dist * dist + 0.01);
  var s = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      s += textureSampleCompareLevel(shadow_t, shadow_s, uv + vec2<f32>(f32(i), f32(j)) * sh.texel.z * 1.5, i32(2u + slot), z);
    }
  }
  return s / 9.0;
}

fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Dia/noche segun la elevacion del sol (se = sin elevacion) y color del horizonte (niebla y cielo).
fn day_k(se: f32) -> f32 { return smoothstep(-0.14, 0.22, se); }
fn horizon_col(se: f32) -> vec3<f32> {
  let base = mix(vec3<f32>(0.022, 0.028, 0.055), vec3<f32>(0.80, 0.77, 0.71), day_k(se));
  let warm = exp(-abs(se) * 7.0) * day_k(se + 0.1);
  return mix(base, vec3<f32>(1.0, 0.55, 0.28), clamp(warm * 0.7, 0.0, 0.7));
}

// BRDF Cook-Torrance (GGX + Smith + Schlick); devuelve color * N.L. Escalado por PI para
// mantener el brillo de la iluminacion anterior (el difuso no se divide entre PI).
fn brdf(l: vec3<f32>, rad: vec3<f32>, n: vec3<f32>, v: vec3<f32>, alb: vec3<f32>,
        rough: f32, metal: f32, f0: vec3<f32>) -> vec3<f32> {
  let nl = max(dot(n, l), 0.0);
  if (nl <= 0.0) { return vec3<f32>(0.0); }
  let h = normalize(l + v + vec3<f32>(1e-5));
  let nh = max(dot(n, h), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let vh = max(dot(v, h), 0.0);
  let a2 = rough * rough * rough * rough;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let d = a2 / (PI * dd * dd);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let gs = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  let f = f0 + (vec3<f32>(1.0) - f0) * pow(max(1.0 - vh, 0.0), 5.0);
  let spec = d * gs * f / (4.0 * nl * nv);
  let kd = (vec3<f32>(1.0) - f) * (1.0 - metal);
  return (kd * alb + spec * PI) * rad * nl;
}

// Iluminacion completa de una superficie: sol con sombras, luna, ambiente segun la hora y las
// luces del cluster del fragmento. `frag` = posicion en pixeles, `depth` = profundidad de vista.
fn lit_surface(wpos: vec3<f32>, n: vec3<f32>, view: vec3<f32>, alb: vec3<f32>, rough_in: f32,
               metal: f32, ao: f32, frag: vec2<f32>, depth: f32) -> vec3<f32> {
  let rough = clamp(rough_in, 0.06, 1.0);
  let f0 = mix(vec3<f32>(0.04), alb, metal);
  var col = brdf(g.light.xyz, sh.sun.rgb, n, view, alb, rough, metal, f0) * shadow_at(wpos, n, depth, frag);
  col += brdf(sh.moon_dir.xyz, sh.moon_rad.rgb, n, view, alb, rough, metal, f0);
  // Ambiente segun la hora: cielo azul de dia, tenue de noche y relleno calido del horizonte al atardecer.
  let se = g.light.y;
  let dk = day_k(se);
  let glow = horizon_col(se) * 0.5 * exp(-abs(se) * 7.0) * day_k(se + 0.1);
  let up = mix(vec3<f32>(0.02, 0.03, 0.07), vec3<f32>(0.42, 0.52, 0.72), dk) + glow;
  let dn = mix(vec3<f32>(0.01, 0.01, 0.015), vec3<f32>(0.30, 0.24, 0.17), dk) + glow * 0.6;
  var amb = mix(dn, up, n.y * 0.5 + 0.5) * sh.sun.w;
  if (sh.ambient.w > 0.0) { amb = sh.ambient.rgb * mix(0.7, 1.0, n.y * 0.5 + 0.5); }
  col += alb * (1.0 - metal) * amb * ao;
  // Luces: solo las del cluster del fragmento.
  let cx = min(u32(frag.x / g.grid.x * f32(CX)), CX - 1u);
  let cy = min(u32(frag.y / g.grid.y * f32(CY)), CY - 1u);
  let cz = u32(clamp(log(depth / g.grid.z) / log(g.grid.w / g.grid.z) * f32(CZ), 0.0, f32(CZ - 1u)));
  let base = ((cz * CY + cy) * CX + cx) * 32u;
  let cnt = cl[base];
  let refl = reflect(-view, n);
  for (var i = 0u; i < cnt; i++) {
    let li = cl[base + 1u + i];
    let a = lights[li * 3u];
    let b = lights[li * 3u + 1u];
    let c = lights[li * 3u + 2u];
    let kind = u32(b.w + 0.5);
    var lp = a.xyz;
    if (kind == 2u) {
      // Tubo: punto representativo del segmento mas cercano al rayo reflejado (Karis).
      let p0 = a.xyz - c.xyz * c.w;
      let ld = c.xyz * (2.0 * c.w);
      let l0 = p0 - wpos;
      let rl = dot(refl, ld);
      let t = clamp((dot(refl, l0) * rl - dot(l0, ld)) / max(dot(ld, ld) - rl * rl, 1e-4), 0.0, 1.0);
      lp = p0 + ld * t;
    }
    let d = lp - wpos;
    let d2 = dot(d, d);
    let r = a.w;
    if (d2 >= r * r) { continue; }
    let dist = sqrt(d2);
    let q = d2 / (r * r);
    let win = clamp(1.0 - q * q, 0.0, 1.0);
    var att = win * win / (d2 + 0.5);
    if (kind == 1u || kind >= 11u) {
      // Foco: transicion suave entre el borde del cono y su 65 % interior; con sombra si tiene slot.
      let cd = dot(-d / dist, c.xyz);
      let sp = smoothstep(c.w, mix(c.w, 1.0, 0.35), cd);
      att *= sp * sp;
      if (kind >= 11u && att > 0.0) { att *= spot_shadow(kind - 11u, wpos, n, a.xyz); }
    }
    col += brdf(d / dist, b.rgb * att, n, view, alb, rough, metal, f0);
  }
  return col;
}
