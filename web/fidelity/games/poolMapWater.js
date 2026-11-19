// Agua de poolmap.ts (client/src/game/poolmap.ts): una malla con todas las celdas de agua, el mismo GLSL y el mismo Reflector.
export function makePoolMapWater(THREE, Reflector, { cam, t = 3.0, y = 0.05, ceil = 4.2 }) {
  const C = 1.4, W = 8, H = 6;
  // celdas de agua: una piscina en L con profundidad variable
  const water = (x, z) => x >= 0 && z >= 0 && x < W && z < H && (z < 3 || x < 3) && !(x === 5 && z === 1);
  const dep = (x, z) => 0.5 + 0.12 * x + 0.1 * z;
  const wp = [], wd = [], we = [], wi = [];
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    if (!water(cx, cy)) continue;
    const base = wp.length / 3;
    for (const [sx, sz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      wp.push((cx + sx - W / 2) * C, -(cy + sz - H / 2) * C, 0);
      let ds = 0, dn = 0;
      for (const [ox, oz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) if (water(cx + sx + ox, cy + sz + oz)) (ds += dep(cx + sx + ox, cy + sz + oz)), dn++;
      wd.push(ds / dn);
      we.push(water(cx + sx - 1, cy + sz - 1) && water(cx + sx, cy + sz - 1) && water(cx + sx - 1, cy + sz) && water(cx + sx, cy + sz) ? 1 : 0);
    }
    wi.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
  wg.setAttribute('aDepth', new THREE.Float32BufferAttribute(wd, 1));
  wg.setAttribute('aEdge', new THREE.Float32BufferAttribute(we, 1));
  wg.setIndex(wi);
  const rip = Array.from({ length: 20 }, () => new THREE.Vector4(0, 0, -99, 0));
  rip[0].set(0.6, 0.4, 1.2, 1.3);
  const shader = {
    name: 'PoolWaterMap',
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
      uTime: { value: t }, uRip: { value: rip }, uCam: { value: new THREE.Vector3().copy(cam) }, uHalf: { value: new THREE.Vector2(1, 1) }, uDeep: { value: 1 }, uCeil: { value: ceil },
    }]),
    vertexShader: `
#include <fog_pars_vertex>
varying vec3 vW;
varying vec4 vUv;
attribute float aDepth;
attribute float aEdge;
varying float vDepth;
varying float vEdge;
uniform mat4 textureMatrix;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vDepth = aDepth; vEdge = aEdge; vUv = textureMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `
#include <fog_pars_fragment>
uniform float uTime;
uniform vec4 uRip[20];
uniform vec3 uCam;
uniform vec2 uHalf;
uniform float uDeep;
uniform float uCeil;
uniform sampler2D tDiffuse;
uniform vec3 color;
varying vec3 vW;
varying vec4 vUv;
varying float vDepth;
varying float vEdge;

// gradiente de un campo de ondas: suma de senos con direcciones fijas (barato y sin textura)
vec2 waves(vec2 p, float t){
  vec2 g = vec2(0.0);
  g += vec2( 0.8, 0.6) * 0.040 * 3.1 * cos(dot(p, vec2( 0.8, 0.6)) * 3.1 + t * 1.60);
  g += vec2(-0.5, 0.86) * 0.030 * 4.7 * cos(dot(p, vec2(-0.5, 0.86)) * 4.7 - t * 1.90);
  g += vec2( 0.97,-0.24) * 0.018 * 7.3 * cos(dot(p, vec2( 0.97,-0.24)) * 7.3 + t * 2.50);
  g += vec2(-0.3,-0.95) * 0.010 * 11.0 * cos(dot(p, vec2(-0.3,-0.95)) * 11.0 - t * 3.20);
  return g;
}
// segunda capa, más fina, en sentido contrario (hace que no se vea el patrón de la primera)
vec2 ripples(vec2 p, float t){
  vec2 g = vec2(0.0);
  for (int i = 0; i < 20; i++){
    vec4 r = uRip[i];
    float age = t - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > 6.0) continue;
    vec2 d = p - r.xy;
    float dl = length(d) + 1e-4;
    float u = dl - 1.7 * age;
    float env = exp(-age * 0.75) * exp(-pow(u * 1.0, 2.0)) * r.w;
    float f = env * (18.0 * cos(18.0 * u) + sin(18.0 * u) * (-2.0 * 1.0 * u)) * 0.028;
    g += f * d / dl;
  }
  return g;
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// cáusticas: dos capas de líneas de celda desplazadas (la clásica trampa barata)
float caustic(vec2 p, float t){
  float c = 0.0;
  for (int k = 0; k < 2; k++){
    vec2 q = p * (1.7 + float(k) * 1.1) + vec2(t * 0.15, -t * 0.11) * (1.0 + float(k));
    q += 0.35 * vec2(sin(q.y * 1.7 + t), cos(q.x * 1.9 - t * 0.8));
    vec2 f = abs(fract(q) - 0.5);
    c += pow(1.0 - 2.0 * min(f.x, f.y), 14.0);
  }
  return c * 0.5;
}
// el techo reflejado: rejilla de tubos de neón
float ceiling(vec3 pos, vec3 r){
  if (r.y <= 0.02) return 0.0;
  vec2 p = pos.xz + r.xz * ((uCeil - pos.y) / r.y);
  vec2 c = abs(fract(p / vec2(4.0, 3.0)) - 0.5) * vec2(4.0, 3.0);
  return smoothstep(0.35, 0.28, c.y) * smoothstep(1.25, 1.1, c.x);
}

void main(){
  if (!gl_FrontFacing) { gl_FragColor = vec4(mix(vec3(0.10, 0.42, 0.38), vec3(0.75, 0.95, 0.85), 0.3 + 0.5 * caustic(vW.xz * 0.7, uTime)), 1.0);
  #include <fog_fragment>
  return; }
  vec3 V = normalize(uCam - vW);
  vec2 g = waves(vW.xz, uTime) + waves(vW.xz * 1.9 + 3.0 + vec2(0.35, 0.2) * uTime, -uTime * 0.8) * 0.8 + ripples(vW.xz, uTime);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  float cosv = max(dot(N, V), 0.0);
  float fres = 0.2 + 0.8 * pow(1.0 - cosv, 4.0); // el agua refleja la sala también mirando desde arriba
  // lo que hay debajo, sin refracción de verdad: el suelo se desplaza un poco con la pendiente y se tiñe con la profundidad
  vec3 dir = refract(-V, N, 0.75);
  float depth = vDepth;
  vec2 fp = vW.xz + dir.xz / max(-dir.y, 0.2) * depth;
  float cs = caustic(fp, uTime);
  vec3 tile = vec3(0.74, 0.90, 0.76) * (0.82 + 0.18 * step(0.5, hash(floor(fp * 2.0))));
  vec3 under = tile * (0.5 + 1.3 * cs);
  float k = 1.0 - exp(-depth * 0.9);
  vec3 body = mix(under, vec3(0.06, 0.42, 0.27), k * 0.75);
  // espuma / borde de la piscina y brillo del neón en el reflejo
  vec2 e = vec2(vEdge * 1.5);
  float foam = smoothstep(0.35, 0.0, min(e.x, e.y)) * (0.5 + 0.5 * sin(uTime * 1.3 + vW.x * 3.0 + vW.z * 2.0));
  // reflejo planar: la sala vista desde debajo del agua (media resolución), desplazada por la pendiente de las ondas
  vec3 refl = texture2DProj(tDiffuse, vec4(vUv.xy + N.xz * 0.09 * vUv.w, vUv.zw)).rgb;
  vec3 col = mix(body, refl, clamp(fres * 1.05, 0.0, 0.95)) + foam * 0.25;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`,
  };
  const rf = new Reflector(wg, { textureWidth: 640, textureHeight: 360, clipBias: 0.003, multisample: 0, shader });
  rf.material.fog = true;
  rf.material.side = THREE.DoubleSide;
  rf.position.set(0, y, 0);
  rf.rotation.x = -Math.PI / 2;
  rf.frustumCulled = false;
  return rf;
}
