// Polvo del pasillo (client/src/game/world.ts, `dustMat`): GLSL tal cual asociado a user/dust_world.wgsl (Points, aditivo).
// @ts-nocheck
import { registerUserShader } from './index';

export const vertexShader = `
          uniform float uT; attribute float aSeed; varying float vA;
          void main() {
            vec3 p = position + vec3(sin(uT * 0.21 + aSeed * 40.0) * 0.18 + uT * 0.012, sin(uT * 0.17 + aSeed * 23.0) * 0.1 - uT * 0.006 * aSeed, cos(uT * 0.19 + aSeed * 31.0) * 0.14);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            float lamp = abs(mod(p.x - 0.75 + 1.5, 3.0) - 1.5);
            float cone = exp(-lamp * lamp * 1.6) * smoothstep(0.0, 1.2, p.y);
            float d = -mv.z;
            vA = (0.05 + 0.95 * cone) * smoothstep(1.2, 3.0, d) * (1.0 - smoothstep(8.0, 14.0, d)) * (0.4 + 0.6 * (0.5 + 0.5 * sin(uT * (0.7 + aSeed) + aSeed * 50.0)));
            gl_PointSize = (0.8 + aSeed * 1.2) * 11.0 / d;
            gl_Position = projectionMatrix * mv;
          }`;
export const fragmentShader = `
          varying float vA;
          void main() {
            float r = length(gl_PointCoord - 0.5) * 2.0;
            gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * smoothstep(1.0, 0.0, r) * vA * 0.5, 1.0);
          }`;

registerUserShader(vertexShader, fragmentShader, {
  id: 8,
  points: true,
  // aSeed cabe en el hueco uv del vertice (x = aSeed)
  attributes: { uv: ['aSeed'] },
  // [uT, _, _, _]
  pack: (m) => [m.uniforms.uT.value, 0, 0, 0],
});
