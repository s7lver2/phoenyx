// Haz de la linterna de los jugadores remotos (client/src/game/remote.ts, beamMat): GLSL tal cual, asociado a user/remote_beam.wgsl.
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = `varying float vT; varying vec3 vN; varying vec3 vV;
      void main() { vT = -position.z / 6.0; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
export const fragmentShader = `uniform float uK; uniform float uT; uniform float uOn; varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float along = pow(1.0 - vT, 1.7) * smoothstep(0.0, 0.06, vT);
        float dust = 0.88 + 0.12 * sin(vT * 38.0 - uT * 1.7) * sin(vT * 11.0 + uT * 0.9);
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.74) * uK * edge * along * dust * uOn, 1.0);
      }`;

registerUserShader(vertexShader, fragmentShader, {
  id: 5,
  // [uK, uT, uOn, _]
  pack: (m) => [m.uniforms.uK.value, m.uniforms.uT.value, m.uniforms.uOn.value, 0],
});
