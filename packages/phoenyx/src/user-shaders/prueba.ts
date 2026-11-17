// Material de prueba de la fase 6 (escena sh-prueba). Mismo GLSL que web/fidelity/games/prueba.js.
// @ts-nocheck
import { registerUserShader, rgb } from './index';

export const vertexShader = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
export const fragmentShader = /* glsl */ `
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
`;

registerUserShader(vertexShader, fragmentShader, {
  id: 0,
  // [uTime, _, _, _], [uColor.rgb, _]
  pack: (m) => [m.uniforms.uTime.value, 0, 0, 0, ...rgb(m.uniforms.uColor.value), 0],
  textures: (m) => [m.uniforms.uMap.value],
});
