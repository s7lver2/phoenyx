// Material de prueba de la fase 6 (mismo GLSL que packages/phoenyx/src/user-shaders/prueba.ts). Solo usa la API de three.
export function makePrueba(THREE, { map, color, time }) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: time }, uColor: { value: new THREE.Color(color) }, uMap: { value: map } }]),
    fog: true,
    transparent: true,
    vertexShader: /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform sampler2D uMap;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  vec3 t = texture2D( uMap, vUv ).rgb;
  float s = 0.5 + 0.5 * sin( vUv.x * 12.0 + uTime );
  gl_FragColor = vec4( mix( uColor, t, s ), 0.8 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`,
  });
}
