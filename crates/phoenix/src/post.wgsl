// Post-proceso sobre el buffer HDR: oclusion ambiental en espacio de pantalla (AO), bloom
// por cadena de reducciones y composicion final (AO + bloom + exposicion + ACES + gamma).
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
struct PU { p: vec4<f32> };   // x exposicion, y bloom, z fuerza del AO, w radio del AO (m)

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<uniform> pu: PU;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var depth_t: texture_depth_2d;
@group(0) @binding(4) var tex_a: texture_2d<f32>;    // HDR (composicion) o fuente de la reduccion
@group(0) @binding(5) var tex_ao: texture_2d<f32>;
@group(0) @binding(6) var tb0: texture_2d<f32>;
@group(0) @binding(7) var tb1: texture_2d<f32>;
@group(0) @binding(8) var tb2: texture_2d<f32>;
@group(0) @binding(9) var tb3: texture_2d<f32>;

const NEAR = 0.3;
const FAR = 4000.0;

struct FOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> FOut {
  var c = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: FOut;
  o.pos = vec4<f32>(c[vi], 0.0, 1.0);
  o.uv = vec2<f32>(c[vi].x * 0.5 + 0.5, 0.5 - c[vi].y * 0.5);
  return o;
}

fn lin_depth(d: f32) -> f32 { return NEAR * FAR / (FAR - d * (FAR - NEAR)); }

fn world_at(px: vec2<f32>, d: f32, size: vec2<f32>) -> vec3<f32> {
  let ndc = vec2<f32>(px.x / size.x * 2.0 - 1.0, 1.0 - px.y / size.y * 2.0);
  let p = g.inv_vp * vec4<f32>(ndc, d, 1.0);
  return p.xyz / p.w;
}

// Patron 4x4 entrelazado (Bayer): el desenfoque 4x4 de la composicion lo elimina por completo.
fn bayer4(p: vec2<u32>) -> f32 {
  let m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(p.y & 3u) * 4u + (p.x & 3u)] + 0.5) / 16.0;
}

@fragment
fn fs_ao(v: FOut) -> @location(0) f32 {
  let dims = textureDimensions(depth_t);
  let size = vec2<f32>(dims);
  // El AO se calcula a media resolucion: cada texel muestrea el centro de un bloque de 2x2 pixeles.
  let px = vec2<i32>(v.pos.xy) * 2;
  let d = textureLoad(depth_t, px, 0);
  let P = world_at(floor(v.pos.xy) * 2.0 + 1.0, d, size);
  // Normal por derivadas (antes de cualquier return: control de flujo uniforme).
  var n = normalize(cross(dpdy(P), dpdx(P)));
  if (dot(n, g.cam.xyz - P) < 0.0) { n = -n; }
  let dist = distance(P, g.cam.xyz);
  if (d >= 1.0 || dist > 150.0) { return 1.0; }
  let R = pu.p.w;
  let lzp = lin_depth(d);
  let rot = bayer4(vec2<u32>(v.pos.xy)) * 6.2831853;
  var occ = 0.0;
  for (var i = 0u; i < 12u; i++) {
    // Direccion en espiral (Fibonacci) rotada por pixel, volteada al hemisferio de la normal.
    let f = (f32(i) + 0.5) / 12.0;
    let a = f * 12.566 * 1.618 + rot;
    let y = 1.0 - 2.0 * f;
    let rr = sqrt(max(1.0 - y * y, 0.0));
    var dv = vec3<f32>(cos(a) * rr, y, sin(a) * rr);
    if (dot(dv, n) < 0.0) { dv = -dv; }
    let s = P + n * 0.02 + dv * (R * (0.12 + 0.88 * f * f));
    let clip = g.view_proj * vec4<f32>(s, 1.0);
    let ndc = clip.xyz / clip.w;
    let sp = vec2<i32>(vec2<f32>((ndc.x * 0.5 + 0.5) * size.x, (0.5 - ndc.y * 0.5) * size.y));
    if (any(sp < vec2<i32>(0)) || any(sp >= vec2<i32>(dims))) { continue; }
    let ds = textureLoad(depth_t, sp, 0);
    let lzs = lin_depth(ds);
    let diff = clip.w - lzs;                       // > 0: la escena esta delante de la muestra
    let range = smoothstep(0.0, 1.0, R / max(abs(lzp - lzs), 1e-4));
    occ += select(0.0, range, diff > 0.03 * (1.0 + lzp * 0.02));
  }
  return clamp(1.0 - occ / 12.0, 0.0, 1.0);
}

fn tap(uv: vec2<f32>) -> vec3<f32> { return textureSampleLevel(tex_a, samp, uv, 0.0).rgb; }

fn down(uv: vec2<f32>) -> vec3<f32> {
  let t = 1.0 / vec2<f32>(textureDimensions(tex_a));
  var c = tap(uv) * 4.0;
  c += tap(uv + vec2<f32>(-t.x, -t.y)) + tap(uv + vec2<f32>(t.x, -t.y));
  c += tap(uv + vec2<f32>(-t.x, t.y)) + tap(uv + vec2<f32>(t.x, t.y));
  return c / 8.0;
}

// Primer nivel: solo pasa lo que supera el umbral (radiancia HDR > 1).
@fragment
fn fs_down0(v: FOut) -> @location(0) vec4<f32> {
  let c = down(v.uv);
  let br = max(max(c.r, c.g), c.b);
  return vec4<f32>(c * (max(br - 1.0, 0.0) / max(br, 1e-4)), 1.0);
}

@fragment
fn fs_down(v: FOut) -> @location(0) vec4<f32> {
  return vec4<f32>(down(v.uv), 1.0);
}

fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_comp(v: FOut) -> @location(0) vec4<f32> {
  let px = vec2<i32>(v.pos.xy);
  var c = textureLoad(tex_a, px, 0).rgb;
  let dims = vec2<i32>(textureDimensions(depth_t));
  let dc = lin_depth(textureLoad(depth_t, px, 0));
  // AO: desenfoque 4x4 que respeta los bordes de profundidad.
  var sum = 0.0;
  var wsum = 0.0;
  let hd = vec2<i32>(textureDimensions(tex_ao));
  for (var j = -2; j < 2; j++) {
    for (var i = -2; i < 2; i++) {
      let q = clamp(px / 2 + vec2<i32>(i, j), vec2<i32>(0), hd - vec2<i32>(1));
      let qf = min(q * 2 + vec2<i32>(1), dims - vec2<i32>(1));
      let w = 1.0 / (1.0 + 40.0 * abs(lin_depth(textureLoad(depth_t, qf, 0)) - dc) / max(dc, 0.3));
      sum += textureLoad(tex_ao, q, 0).r * w;
      wsum += w;
    }
  }
  let ao = sum / max(wsum, 1e-4);
  c *= mix(1.0, ao, pu.p.z * (1.0 - smoothstep(80.0, 150.0, dc)));
  // Bloom: suma de los niveles reducidos (el filtro bilineal hace de interpolacion).
  let bl = textureSampleLevel(tb0, samp, v.uv, 0.0).rgb * 0.32 + textureSampleLevel(tb1, samp, v.uv, 0.0).rgb * 0.30
         + textureSampleLevel(tb2, samp, v.uv, 0.0).rgb * 0.24 + textureSampleLevel(tb3, samp, v.uv, 0.0).rgb * 0.20;
  c += bl * pu.p.y;
  c = aces(c * pu.p.x);
  return vec4<f32>(pow(c, vec3<f32>(1.0 / 2.2)), 1.0);
}
