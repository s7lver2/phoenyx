// Particulas sin estado: la posicion se calcula en el vertex shader a partir del nacimiento.
struct U {
  vp: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
  time: vec4<f32>,
};
struct P {
  pos_birth: vec4<f32>,   // xyz origen, w nacimiento (s)
  vel_life: vec4<f32>,    // xyz velocidad, w vida (s)
  color: vec4<f32>,       // rgb HDR, a opacidad
  misc: vec4<f32>,        // tamano inicial, tamano final, gravedad, modo (0 mezcla, 1 aditivo)
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> parts: array<P>;

struct VO {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) col: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let p = parts[ii];
  let age = u.time.x - p.pos_birth.w;
  let life = p.vel_life.w;
  if (age < 0.0 || age >= life || life <= 0.0) {
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);   // fuera del frustum: se descarta sin coste de raster
    o.uv = vec2<f32>(0.0);
    o.col = vec4<f32>(0.0);
    return o;
  }
  let k = age / life;
  let world = p.pos_birth.xyz + p.vel_life.xyz * age + vec3<f32>(0.0, -0.5 * p.misc.z * age * age, 0.0);
  var q = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let c = q[vi];
  let size = mix(p.misc.x, p.misc.y, k) * 0.5;
  let w = world + (u.right.xyz * c.x + u.up.xyz * c.y) * size;
  o.pos = u.vp * vec4<f32>(w, 1.0);
  o.uv = c;
  let fade = smoothstep(0.0, 0.08, k) * (1.0 - k) * p.color.a;
  // Mezcla: rgb premultiplicado y alfa. Aditivo: solo suma (alfa 0).
  if (p.misc.w > 0.5) {
    o.col = vec4<f32>(p.color.rgb * fade, 0.0);
  } else {
    o.col = vec4<f32>(p.color.rgb * fade, fade);
  }
  return o;
}

@fragment
fn fs(i: VO) -> @location(0) vec4<f32> {
  let r2 = dot(i.uv, i.uv);
  if (r2 >= 1.0) { discard; }
  let soft = 1.0 - r2;
  return i.col * (soft * soft);
}
